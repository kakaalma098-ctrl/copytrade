import type {
  JupiterQuoteResponse,
  JupiterSwapBuild,
} from "../execution/jupiter.js";

type PrebuildResult = { build: JupiterSwapBuild; quote: JupiterQuoteResponse };
type PrebuildEntry = PrebuildResult & { createdAtMs: number };

const TTL_MS = 3_000;
const MAX_ENTRIES = 16;

/**
 * R19 (fixed): Inflight-aware prebuild cache.
 *
 * When a whale BUY is decoded, the engine calls `startBuild()` which stores
 * the in-flight Promise. When the engine's handler runs 1-5ms later and calls
 * `take()`, it finds the inflight Promise and AWAITS the SAME Jupiter call
 * instead of starting a duplicate.
 *
 * Result: one Jupiter round-trip shared between speculative + real path.
 * On cache HIT (rebuy within 3s TTL): quoteBuild = 0ms.
 * On inflight HIT (first BUY): quoteBuild = remaining wait time of the
 *   already-running Jupiter call (e.g., signal at t=5ms, Jupiter finishes
 *   at t=300ms → engine waits 295ms instead of 300ms — saves ~5ms + avoids
 *   a wasted parallel call).
 */
class PrebuildCache {
  private readonly store = new Map<string, PrebuildEntry>();
  private readonly inflight = new Map<string, Promise<PrebuildResult | null>>();

  /**
   * Fire a speculative build. Stores the Promise so `take()` can await it.
   */
  startBuild(token: string, buildFn: () => Promise<PrebuildResult>): void {
    // Don't start a duplicate if one is already inflight.
    if (this.inflight.has(token)) {
      return;
    }

    const p = buildFn()
      .then((result) => {
        if (this.store.size >= MAX_ENTRIES) {
          const oldest = this.store.keys().next().value;
          if (oldest != null) {
            this.store.delete(oldest);
          }
        }
        this.store.set(token, { ...result, createdAtMs: Date.now() });
        return result;
      })
      .catch(() => null)
      .finally(() => {
        this.inflight.delete(token);
      });

    this.inflight.set(token, p);
  }

  /**
   * Get a pre-built tx. Checks completed cache first, then awaits inflight
   * build if one is running. Returns null if nothing available.
   */
  async take(token: string): Promise<PrebuildResult | null> {
    // 1. Check completed cache (instant).
    const entry = this.store.get(token);
    if (entry != null) {
      this.store.delete(token);
      if (Date.now() - entry.createdAtMs > TTL_MS) {
        return null;
      }
      return { build: entry.build, quote: entry.quote };
    }

    // 2. Await inflight build if speculative call is still running.
    const pending = this.inflight.get(token);
    if (pending != null) {
      return pending;
    }

    return null;
  }

  /**
   * Option A: like `take()` but gives up waiting on an inflight build after
   * `timeoutMs`. The inflight Jupiter call keeps running in the background
   * (its eventual result still populates the cache for later callers); the
   * current handler simply stops waiting and returns null so it can fall
   * through to a faster direct-pump path.
   *
   * Returns:
   *   - Completed cache hit: instant (same as `take`)
   *   - Inflight and completes <= timeoutMs: the resolved result
   *   - Inflight and exceeds timeoutMs: null (caller skips Jupiter for now)
   *   - No inflight and no cache: null
   */
  async takeWithTimeout(
    token: string,
    timeoutMs: number,
  ): Promise<PrebuildResult | null> {
    const entry = this.store.get(token);
    if (entry != null) {
      this.store.delete(token);
      if (Date.now() - entry.createdAtMs > TTL_MS) {
        return null;
      }
      return { build: entry.build, quote: entry.quote };
    }

    const pending = this.inflight.get(token);
    if (pending == null) {
      return null;
    }

    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      if (timer != null) {
        clearTimeout(timer);
      }
    }
  }
}

export const prebuildCache = new PrebuildCache();
