import { promises as fs, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";

export type PersistedPosition = {
  token: string;
  owner: string;
  buyCount: number;
  openedAtMs: number;
};

type Serialized = {
  version: 1;
  savedAtMs: number;
  positions: PersistedPosition[];
};

/**
 * Persist active position cycles to disk so bot restarts preserve the
 * first-whale-wins lock + TTL clock. Writes atomically via .tmp rename.
 *
 * Save strategy (layered, crash-safe):
 *   1. Debounced immediate save: after any change, queue a flush 500ms later.
 *      Coalesces bursts (whale burst → single write), so max data loss on a
 *      SIGKILL / crash is ~500ms of updates — not 30s.
 *   2. Periodic safety net: independent interval (default 10s) catches any
 *      case where debounce failed to fire or a write was dropped.
 *   3. Synchronous saveSync on process exit/uncaughtException: writes without
 *      async/await so it runs inside the crash handler before Node dies.
 */
export class PositionStateStore {
  private readonly filePath: string;
  private readonly getSnapshotFn: () => PersistedPosition[];
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private writing: Promise<void> | null = null;
  private stopped = false;

  constructor(filePath: string, getSnapshot: () => PersistedPosition[]) {
    this.filePath = path.resolve(filePath);
    this.getSnapshotFn = getSnapshot;
  }

  async load(): Promise<PersistedPosition[]> {
    try {
      const data = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(data) as Partial<Serialized>;
      if (
        parsed == null ||
        typeof parsed !== "object" ||
        !Array.isArray(parsed.positions)
      ) {
        return [];
      }
      return parsed.positions.filter(
        (p): p is PersistedPosition =>
          p != null &&
          typeof p.token === "string" &&
          p.token.length > 0 &&
          typeof p.owner === "string" &&
          p.owner.length > 0 &&
          typeof p.openedAtMs === "number" &&
          Number.isFinite(p.openedAtMs) &&
          typeof p.buyCount === "number" &&
          Number.isFinite(p.buyCount),
      );
    } catch (e) {
      if (
        e != null &&
        typeof e === "object" &&
        (e as { code?: string }).code === "ENOENT"
      ) {
        return [];
      }
      console.warn(
        `[position-state] load failed — starting empty: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }
  }

  /**
   * Mark state dirty AND queue a debounced flush (default 500ms after last
   * change). Bursts of changes coalesce into a single write.
   */
  markDirty(debounceMs = 500): void {
    this.dirty = true;
    if (this.stopped) return;
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(
      () => {
        this.debounceTimer = null;
        if (!this.dirty) return;
        this.dirty = false;
        void this.flushAsync(this.getSnapshotFn());
      },
      Math.max(0, debounceMs),
    );
  }

  private buildPayload(positions: PersistedPosition[]): string {
    const payload: Serialized = {
      version: 1,
      savedAtMs: Date.now(),
      positions,
    };
    return JSON.stringify(payload, null, 2);
  }

  private async writeAtomicAsync(body: string): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, this.filePath);
  }

  private writeAtomicSync(body: string): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, this.filePath);
  }

  private async flushAsync(positions: PersistedPosition[]): Promise<void> {
    while (this.writing != null) {
      await this.writing;
    }
    const body = this.buildPayload(positions);
    this.writing = this.writeAtomicAsync(body).catch((e) => {
      console.warn(
        `[position-state] async save failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    try {
      await this.writing;
    } finally {
      this.writing = null;
    }
  }

  /**
   * Periodic safety-net save — flushes even if debounced markDirty missed
   * a change. Default interval is shorter than the debounce window alone
   * so a stuck debounce still gets caught quickly.
   */
  startPeriodicSave(intervalMs = 10_000): void {
    if (this.saveTimer != null) {
      clearInterval(this.saveTimer);
    }
    const interval = Math.max(2_000, intervalMs);
    this.saveTimer = setInterval(() => {
      if (!this.dirty) return;
      this.dirty = false;
      void this.flushAsync(this.getSnapshotFn());
    }, interval);
  }

  stopPeriodicSave(): void {
    if (this.saveTimer != null) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Force async flush. Use on graceful shutdown (awaitable). */
  async saveNow(): Promise<void> {
    this.dirty = false;
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.flushAsync(this.getSnapshotFn());
  }

  /**
   * Synchronous flush — ONLY for use inside crash/exit handlers where async
   * I/O cannot complete. Blocks the event loop briefly but guarantees the
   * write lands before the process dies. Uses the same atomic tmp+rename
   * pattern as the async path.
   */
  saveSync(): void {
    try {
      this.dirty = false;
      if (this.debounceTimer != null) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      const body = this.buildPayload(this.getSnapshotFn());
      this.writeAtomicSync(body);
    } catch (e) {
      // Best-effort — don't re-throw inside a crash handler.
      console.warn(
        `[position-state] sync save failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Stop all timers, called from shutdown before the final saveNow/saveSync. */
  stop(): void {
    this.stopped = true;
    this.stopPeriodicSave();
  }
}
