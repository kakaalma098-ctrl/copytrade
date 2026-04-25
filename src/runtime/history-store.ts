import { promises as fs, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import type { TradeHistoryEntry } from "./runtime-state.js";

/**
 * Persistent backup of the trade history ring buffer + P&L baseline +
 * cumulative counters. Survives bot restarts so the dashboard's Recent
 * Trades + Trading Activity + P&L appear instantly — before the Helius
 * history fetch (which runs in background and may take 10–30s).
 *
 * Save strategy identical to PositionStateStore:
 *   1. Debounced write 1s after any change (coalesces bursts).
 *   2. Periodic safety-net flush every positionStateSaveIntervalMs.
 *   3. saveNow() awaited on graceful shutdown.
 *   4. saveSync() blocking write on uncaughtException / crash.
 */

export type PersistedHistorySnapshot = {
  baseline: {
    solLamports: number | null;
    capturedAtMs: number | null;
  };
  counters: {
    totalBuyCount: number;
    totalSellCount: number;
    totalFailedCount: number;
    totalBuySolIn: number;
    totalSellSolOut: number;
  };
  history: TradeHistoryEntry[];
};

type Persisted = {
  version: 1;
  savedAtMs: number;
} & PersistedHistorySnapshot;

export class HistoryStore {
  private readonly filePath: string;
  private readonly getSnapshotFn: () => PersistedHistorySnapshot;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private writing: Promise<void> | null = null;
  private stopped = false;

  constructor(filePath: string, getSnapshot: () => PersistedHistorySnapshot) {
    this.filePath = path.resolve(filePath);
    this.getSnapshotFn = getSnapshot;
  }

  async load(): Promise<PersistedHistorySnapshot | null> {
    try {
      const data = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(data) as Partial<Persisted>;
      if (
        parsed == null ||
        typeof parsed !== "object" ||
        parsed.baseline == null ||
        parsed.counters == null ||
        !Array.isArray(parsed.history)
      ) {
        return null;
      }
      // Defensive filtering — only keep well-formed entries.
      const history = parsed.history.filter(
        (h): h is TradeHistoryEntry =>
          h != null &&
          typeof h.ts === "number" &&
          typeof h.side === "string" &&
          (h.side === "BUY" || h.side === "SELL") &&
          typeof h.status === "string",
      );
      return {
        baseline: {
          solLamports:
            typeof parsed.baseline.solLamports === "number"
              ? parsed.baseline.solLamports
              : null,
          capturedAtMs:
            typeof parsed.baseline.capturedAtMs === "number"
              ? parsed.baseline.capturedAtMs
              : null,
        },
        counters: {
          totalBuyCount: Number(parsed.counters.totalBuyCount) || 0,
          totalSellCount: Number(parsed.counters.totalSellCount) || 0,
          totalFailedCount: Number(parsed.counters.totalFailedCount) || 0,
          totalBuySolIn: Number(parsed.counters.totalBuySolIn) || 0,
          totalSellSolOut: Number(parsed.counters.totalSellSolOut) || 0,
        },
        history,
      };
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return null;
      console.warn(
        `[history-store] load failed — starting empty: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  markDirty(debounceMs = 1000): void {
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

  private buildPayload(snap: PersistedHistorySnapshot): string {
    const payload: Persisted = {
      version: 1,
      savedAtMs: Date.now(),
      ...snap,
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

  private async flushAsync(snap: PersistedHistorySnapshot): Promise<void> {
    while (this.writing != null) {
      await this.writing;
    }
    const body = this.buildPayload(snap);
    this.writing = this.writeAtomicAsync(body).catch((e) => {
      console.warn(
        `[history-store] async save failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    try {
      await this.writing;
    } finally {
      this.writing = null;
    }
  }

  startPeriodicSave(intervalMs = 15_000): void {
    if (this.saveTimer != null) {
      clearInterval(this.saveTimer);
    }
    const interval = Math.max(3_000, intervalMs);
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

  async saveNow(): Promise<void> {
    this.dirty = false;
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.flushAsync(this.getSnapshotFn());
  }

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
      console.warn(
        `[history-store] sync save failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopPeriodicSave();
  }
}
