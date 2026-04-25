/**
 * Dynamic priority-fee micro-lamports via Helius `getPriorityFeeEstimate`.
 *
 * Refreshes in the background so the hot swap path reads a cached value
 * synchronously (0ms). Typical recommended refresh cadence is 1-2 slots
 * (400-800ms) — long enough to stay cheap but short enough to react to
 * network congestion. Failures are non-fatal: on error the cache falls
 * back to the caller-supplied `fallbackMicroLamports`.
 */
export class PriorityFeeCache {
  private cached: number | null = null;
  private lastFetchAtMs = 0;
  private inflight: Promise<void> | null = null;
  private interval?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(
    private readonly rpcUrl: string,
    /** Program ids / writable accounts hint for the fee estimator. */
    private readonly accountKeys: string[],
    private readonly fallbackMicroLamports: number,
    private readonly refreshMs: number = 2_000,
    private readonly minMicroLamports: number = 1_000,
    private readonly maxMicroLamports: number = 500_000,
    private readonly debug: boolean = false,
  ) {
    // Fire initial fetch immediately so the first swap gets a non-default value.
    void this.refresh();
    this.interval = setInterval(() => {
      void this.refresh();
    }, refreshMs);
  }

  /** Sync getter — always returns a usable value (cached or fallback). */
  getMicroLamports(): number {
    return this.cached ?? this.fallbackMicroLamports;
  }

  /** Observability: ms since last successful refresh. */
  get stalenessMs(): number {
    if (this.lastFetchAtMs === 0) return Infinity;
    return Date.now() - this.lastFetchAtMs;
  }

  stop(): void {
    this.stopped = true;
    if (this.interval != null) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.inflight != null) return;
    this.inflight = this.fetchEstimate()
      .then((value) => {
        if (this.stopped) return;
        const clamped = Math.max(
          this.minMicroLamports,
          Math.min(this.maxMicroLamports, Math.ceil(value)),
        );
        this.cached = clamped;
        this.lastFetchAtMs = Date.now();
        if (this.debug) {
          console.log(
            `[priority-fee] refreshed ${clamped} µlamports (raw=${value})`,
          );
        }
      })
      .catch((e) => {
        if (this.debug) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[priority-fee] refresh failed: ${msg}`);
        }
      })
      .finally(() => {
        this.inflight = null;
      });
  }

  private async fetchEstimate(): Promise<number> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "priority-fee-estimate",
        method: "getPriorityFeeEstimate",
        params: [
          {
            accountKeys: this.accountKeys,
            options: { recommended: true },
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      result?: { priorityFeeEstimate?: number };
      error?: { message?: string };
    };
    if (data.error != null) {
      throw new Error(data.error.message ?? "unknown RPC error");
    }
    const estimate = data.result?.priorityFeeEstimate;
    if (typeof estimate !== "number" || !Number.isFinite(estimate)) {
      throw new Error("estimator returned non-numeric value");
    }
    return estimate;
  }
}
