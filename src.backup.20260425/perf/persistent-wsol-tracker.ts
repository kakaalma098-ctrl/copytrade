import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { getTokenBalanceRawForMint } from "../utils/token-balance.js";
import type { WsolTopUpManager } from "./startup-prewrap-wsol.js";

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_LOW_WATERMARK_SOL = 0.3;
const LAMPORTS_PER_SOL = 1_000_000_000n;

type TrackerOptions = {
  refreshIntervalMs?: number;
  lowWatermarkSol?: number;
  topUp?: WsolTopUpManager;
  debug?: boolean;
};

/**
 * In-memory accounting of the persistent WSOL ATA balance. Replaces the
 * per-swap RPC balance check on the BUY hot path with an O(1) lookup.
 *
 * Correctness model:
 *  - Initial balance read from chain at startup.
 *  - BUY consumes WSOL → `recordBuySpend`.
 *  - Jupiter SELL with `wrapAndUnwrapSol=false` (persistent WSOL path)
 *    produces WSOL → `recordSellReceive`.
 *  - Pump direct executors that bypass Jupiter skip tracker updates; the
 *    periodic background refresh corrects drift on the next swap.
 *  - When stale (> refreshIntervalMs), `hasEnough` kicks off a background
 *    refresh but returns the stale value immediately — no hot-path RPC.
 */
export class PersistentWsolTracker {
  private balanceLamports = 0n;
  private lastRefreshMs = 0;
  private inflightRefresh: Promise<void> | null = null;
  private initialized = false;
  private readonly refreshIntervalMs: number;
  private readonly lowWatermarkLamports: bigint;
  private readonly topUp?: WsolTopUpManager;
  private readonly debug: boolean;

  constructor(
    private readonly connection: Connection,
    private readonly owner: PublicKey,
    private readonly commitment: Commitment,
    opts: TrackerOptions = {},
  ) {
    this.refreshIntervalMs =
      opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.lowWatermarkLamports = BigInt(
      Math.floor(
        (opts.lowWatermarkSol ?? DEFAULT_LOW_WATERMARK_SOL) *
          Number(LAMPORTS_PER_SOL),
      ),
    );
    this.topUp = opts.topUp;
    this.debug = opts.debug === true;
  }

  async initialize(): Promise<void> {
    await this.refresh();
    this.initialized = true;
    if (this.debug) {
      console.log(
        `[wsol-tracker] init balance=${this.formatSol(this.balanceLamports)} SOL`,
      );
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getBalanceLamports(): bigint {
    return this.balanceLamports;
  }

  /**
   * Returns true if the tracked balance covers `requiredLamports`. Kicks
   * off a background refresh when the tracker has gone stale; never blocks
   * the caller on RPC.
   */
  hasEnough(requiredLamports: bigint): boolean {
    const now = Date.now();
    if (now - this.lastRefreshMs > this.refreshIntervalMs) {
      this.refreshAsync();
    }
    return this.balanceLamports >= requiredLamports;
  }

  recordBuySpend(lamports: bigint): void {
    if (lamports <= 0n) return;
    this.balanceLamports =
      this.balanceLamports > lamports ? this.balanceLamports - lamports : 0n;
    if (this.balanceLamports < this.lowWatermarkLamports) {
      // Proactive wrap before the next BUY hits "insufficient" fallback.
      this.topUp?.triggerTopUp();
      if (this.debug) {
        console.warn(
          `[wsol-tracker] low watermark hit balance=${this.formatSol(this.balanceLamports)} SOL -> topup triggered`,
        );
      }
    }
  }

  recordSellReceive(lamports: bigint): void {
    if (lamports <= 0n) return;
    this.balanceLamports += lamports;
  }

  /**
   * Invalidate cache — call after topup lands or whenever an external
   * source mutates the WSOL ATA. Forces the next `hasEnough` to refresh.
   */
  invalidate(): void {
    this.lastRefreshMs = 0;
  }

  /**
   * Force-refresh from chain. Use sparingly (cold paths only).
   */
  async refreshNow(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const raw = await getTokenBalanceRawForMint(
        this.connection,
        this.owner,
        NATIVE_MINT,
      );
      this.balanceLamports = raw != null ? BigInt(raw) : 0n;
      this.lastRefreshMs = Date.now();
    } catch (e) {
      if (this.debug) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[wsol-tracker] refresh failed (non-fatal): ${msg}`);
      }
    }
  }

  private refreshAsync(): void {
    if (this.inflightRefresh != null) return;
    this.inflightRefresh = this.refresh().finally(() => {
      this.inflightRefresh = null;
    });
  }

  private formatSol(lamports: bigint): string {
    return (Number(lamports) / Number(LAMPORTS_PER_SOL)).toFixed(6);
  }
}
