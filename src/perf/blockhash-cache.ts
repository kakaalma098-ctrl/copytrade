import type { Commitment, Connection } from "@solana/web3.js";

type BlockhashEntry = {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAtMs: number;
};

const DEFAULT_REFRESH_MS = 2_000;
const MAX_AGE_MS = 10_000;

/**
 * Background blockhash pre-fetcher. Keeps a fresh blockhash ready so swap
 * transaction builders never block on a `getLatestBlockhash` RPC call.
 *
 * Solana blockhashes are valid for ~60-90 seconds, so refreshing every 2s
 * gives a fresh value with zero read latency.
 */
export class BlockhashCache {
  private current: BlockhashEntry | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly commitment: Commitment,
    refreshMs: number = DEFAULT_REFRESH_MS,
  ) {
    // Initial fetch (non-blocking, caller can await getBlockhash for first value).
    this.refresh();
    this.interval = setInterval(() => this.refresh(), refreshMs);
  }

  private refresh(): void {
    if (this.refreshing != null) {
      return;
    }
    this.refreshing = this.connection
      .getLatestBlockhash(this.commitment)
      .then((result) => {
        this.current = {
          blockhash: result.blockhash,
          lastValidBlockHeight: result.lastValidBlockHeight,
          fetchedAtMs: Date.now(),
        };
      })
      .catch(() => {
        /* non-fatal — keep using previous value */
      })
      .finally(() => {
        this.refreshing = null;
      });
  }

  /**
   * Get a cached blockhash. If the cache is empty (first call before initial
   * fetch completes), blocks until the first value is available.
   * If the cached value is stale (> MAX_AGE_MS), triggers an immediate refresh.
   */
  async getBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    if (this.current == null) {
      // Wait for initial fetch.
      if (this.refreshing != null) {
        await this.refreshing;
      }
      if (this.current == null) {
        // Initial fetch failed — do a synchronous one.
        const result = await this.connection.getLatestBlockhash(
          this.commitment,
        );
        this.current = {
          blockhash: result.blockhash,
          lastValidBlockHeight: result.lastValidBlockHeight,
          fetchedAtMs: Date.now(),
        };
      }
    }

    if (Date.now() - this.current.fetchedAtMs > MAX_AGE_MS) {
      this.refresh();
    }

    return {
      blockhash: this.current.blockhash,
      lastValidBlockHeight: this.current.lastValidBlockHeight,
    };
  }

  stop(): void {
    if (this.interval != null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
