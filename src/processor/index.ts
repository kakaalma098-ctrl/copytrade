import type {
  AppConfig,
  RawWhaleTransaction,
  TradeSignal,
} from "../types/index.js";
import { runtimeMetrics } from "../runtime/metrics.js";
import { metrics } from "../runtime/metrics-registry.js";
import { runtimeState } from "../runtime/runtime-state.js";
import { getRuntimeSettings } from "../runtime/settings-overrides.js";

export type OnSignalAccepted = (signal: TradeSignal) => void;

/**
 * Position lock per token: the first whale to trigger a bot BUY owns the
 * position cycle for that token. Subsequent BUY signals from OTHER whales
 * for the same token are skipped until the owner whale signals SELL (which
 * closes the cycle and releases the lock).
 *
 * Rebuy from the SAME whale is still allowed up to `rebuyMaxCount`.
 */
type TokenPosition = {
  owner: string;
  buyCount: number;
  /** Wall-clock ms when the FIRST BUY of this cycle was recorded.
   *  Rebuy from the same owner does NOT reset this — TTL covers the whole cycle. */
  openedAtMs: number;
};

export type ExpiredPositionEntry = {
  token: string;
  owner: string;
  openedAtMs: number;
};

const normalizeSignal = (
  tx: RawWhaleTransaction,
  config: AppConfig,
): TradeSignal | null => {
  const signalEmittedAtMs = Date.now();
  return {
    action: tx.type,
    protocolHint: tx.protocolHint,
    token: tx.type === "BUY" ? tx.tokenOut : tx.tokenIn,
    amount: tx.amount,
    whaleSellFraction: tx.whaleSellFraction,
    confidence: tx.amount >= 1 ? 0.9 : 0.7,
    legSizeSol: config.trading.fixedBuyAmountSol,
    feedSource: tx.feedSource,
    ingestedAtMs: tx.ingestedAtMs,
    whaleWallet: tx.wallet,
    whaleTxSignature: tx.signature,
    timestamp: tx.timestamp,
    detectedAtMs: tx.detectedAtMs,
    signalEmittedAtMs,
  };
};

const passesMinWhaleBuyAmount = (
  signal: TradeSignal,
  config: AppConfig,
): boolean => {
  const override = getRuntimeSettings().minWhaleBuyAmountSol;
  const minWhaleBuy =
    override != null ? override : config.trading.minWhaleBuyAmountSol;
  if (signal.action !== "BUY" || minWhaleBuy <= 0) {
    return true;
  }
  return signal.amount >= minWhaleBuy;
};

export class SignalProcessor {
  private readonly recentWhaleSig = new Map<string, number>();
  private readonly tokenPositions = new Map<string, TokenPosition>();
  private onSignal: OnSignalAccepted = () => {};
  private onChangeCallback: () => void = () => {};

  constructor(private readonly config: AppConfig) {}

  /** Wire the downstream handler — called instead of bus.emit('signal:trade'). */
  setOnSignal(handler: OnSignalAccepted): void {
    this.onSignal = handler;
  }

  /**
   * Fires after any mutation to tokenPositions (BUY open / rebuy / SELL close /
   * explicit release). Wired from main.ts to the PositionStateStore so the
   * periodic save only writes when state actually changed.
   */
  onPositionChange(cb: () => void): void {
    this.onChangeCallback = cb;
  }

  /**
   * Full snapshot of tokenPositions for persistence. Use `getAllPositions`
   * when only the TTL-relevant fields are needed (skips buyCount).
   */
  getPositionSnapshot(): Array<{
    token: string;
    owner: string;
    buyCount: number;
    openedAtMs: number;
  }> {
    const out: Array<{
      token: string;
      owner: string;
      buyCount: number;
      openedAtMs: number;
    }> = [];
    for (const [token, p] of this.tokenPositions) {
      out.push({
        token,
        owner: p.owner,
        buyCount: p.buyCount,
        openedAtMs: p.openedAtMs,
      });
    }
    return out;
  }

  /**
   * Restore positions from persisted snapshot (bot restart). Called once at
   * startup. Overwrites any current entries for the same token.
   */
  loadPersistedPositions(
    positions: Array<{
      token: string;
      owner: string;
      buyCount: number;
      openedAtMs: number;
    }>,
  ): void {
    for (const p of positions) {
      this.tokenPositions.set(p.token, {
        owner: p.owner,
        buyCount: p.buyCount,
        openedAtMs: p.openedAtMs,
      });
    }
  }

  private effectiveRebuyMaxCount(): number {
    return this.config.trading.rebuyEnabled
      ? this.config.trading.rebuyMaxCount
      : 1;
  }

  hasTrackedBuyCycle(token: string): boolean {
    return this.tokenPositions.has(token);
  }

  /**
   * Position-lock predicate: returns true ONLY when the caller whale is the
   * registered owner of the token's cycle. Used by the engine to gate
   * speculative SELL quotes AND mirrored by the processor's SELL signal
   * filter below.
   */
  isSellFromPositionOwner(token: string, whale: string): boolean {
    const p = this.tokenPositions.get(token);
    return p != null && p.owner === whale;
  }

  /**
   * Returns current buyCount for a token (0 if no position). Used by the
   * engine's speculative quote to PREDICT the next rebuy size so prebuild
   * cache key + handler size stay aligned (→ cache hit rate preserved).
   */
  getBuyCount(token: string): number {
    return this.tokenPositions.get(token)?.buyCount ?? 0;
  }

  /**
   * Additive rebuy sizing: BUY #N = fixedBuyAmountSol + (N-1) × rebuyAmountSize.
   * N=1 (first BUY) → fixedBuyAmountSol. N=2 (first rebuy) → +1 step, etc.
   * `rebuyAmountSize=0` yields flat size (legacy behavior).
   */
  private computeBuySize(buyCount: number): number {
    const base = this.config.trading.fixedBuyAmountSol;
    const step = this.config.trading.rebuyAmountSize;
    const n = Math.max(1, buyCount);
    const size = base + (n - 1) * step;
    return Number.isFinite(size) && size > 0 ? size : base;
  }

  /**
   * Phase 4: enumerate tokens the bot has an open BUY cycle on. Consumed by
   * the engine's background prewarm timer so speculative SELL builds stay
   * fresh even between whale events.
   */
  getTrackedTokens(): string[] {
    return Array.from(this.tokenPositions.keys());
  }

  /**
   * Snapshot all active positions with their open timestamps. Used by the
   * auto-sell TTL watcher to identify cycles that have exceeded the hold
   * limit (e.g. owner whale went offline without signalling SELL).
   */
  getAllPositions(): ExpiredPositionEntry[] {
    const out: ExpiredPositionEntry[] = [];
    for (const [token, p] of this.tokenPositions) {
      out.push({ token, owner: p.owner, openedAtMs: p.openedAtMs });
    }
    return out;
  }

  /**
   * Explicit release of a position cycle — used by the auto-sell watcher
   * BEFORE it fires the SELL, so a second TTL tick or concurrent whale SELL
   * cannot re-trigger the same cycle.
   */
  releasePosition(token: string): boolean {
    const removed = this.tokenPositions.delete(token);
    if (removed) {
      this.onChangeCallback();
    }
    return removed;
  }

  /**
   * Returns null if the BUY signal is acceptable; otherwise a short reason
   * string for observability. Checked BEFORE normalizing state so the caller
   * can log + drop without mutating position ownership.
   */
  private buyGateReason(signal: TradeSignal): string | null {
    const existing = this.tokenPositions.get(signal.token);
    if (existing == null) {
      return null;
    }
    if (existing.owner !== signal.whaleWallet) {
      return `position locked by whale=${existing.owner.slice(0, 8)}...`;
    }
    if (existing.buyCount >= this.effectiveRebuyMaxCount()) {
      return `rebuy limit used=${existing.buyCount}/${this.effectiveRebuyMaxCount()}`;
    }
    return null;
  }

  private onSignalAcceptedInternal(signal: TradeSignal): void {
    if (signal.action === "BUY") {
      const existing = this.tokenPositions.get(signal.token);
      let newCount = 1;
      if (existing == null) {
        this.tokenPositions.set(signal.token, {
          owner: signal.whaleWallet,
          buyCount: 1,
          openedAtMs: Date.now(),
        });
      } else if (existing.owner === signal.whaleWallet) {
        existing.buyCount += 1;
        newCount = existing.buyCount;
        // Rebuy from the owner extends the cycle by resetting the TTL clock
        // when configured. Disable via AUTO_SELL_TTL_RESET_ON_REBUY=false to
        // enforce a cumulative hold window from first BUY.
        if (this.config.trading.autoSellResetOnRebuy) {
          existing.openedAtMs = Date.now();
        }
      }
      // Rebuy ladder: override signal.legSizeSol so downstream (engine) uses
      // the correct step. Flat (rebuyAmountSize=0) yields fixedBuyAmountSol.
      signal.legSizeSol = this.computeBuySize(newCount);
      // Non-owner BUY should have been filtered by buyGateReason — defensive no-op here.
      this.onChangeCallback();
      return;
    }
    if (signal.action === "SELL") {
      const existing = this.tokenPositions.get(signal.token);
      if (existing != null && existing.owner === signal.whaleWallet) {
        this.tokenPositions.delete(signal.token);
        this.onChangeCallback();
      }
    }
  }

  private isDuplicateWhaleTx(signature: string, windowMs: number): boolean {
    if (windowMs <= 0) {
      return false;
    }
    const now = Date.now();
    const cutoff = now - windowMs;
    if (this.recentWhaleSig.size > 2000) {
      for (const [sig, t] of this.recentWhaleSig) {
        if (t < cutoff) {
          this.recentWhaleSig.delete(sig);
        }
      }
    }
    const last = this.recentWhaleSig.get(signature);
    if (last != null && now - last < windowMs) {
      runtimeMetrics.dedupSkippedTotal++;
      return true;
    }
    this.recentWhaleSig.set(signature, now);
    return false;
  }

  /** Direct hot-path entry — called by listener, avoids EventEmitter overhead. */
  handleWhaleTx(tx: RawWhaleTransaction): void {
    // Pause gate: listener keeps decoding (metrics still flow) but no trade
    // signals reach the engine. Resume via control API /api/resume.
    if (runtimeState.tradingPaused) {
      metrics.inc("laser_signal_drop_total", { reason: "paused" });
      return;
    }
    const signal = normalizeSignal(tx, this.config);
    if (!signal) {
      return;
    }
    if (!passesMinWhaleBuyAmount(signal, this.config)) {
      if (this.config.debug.whalePipeline) {
        console.warn(
          `[whale-debug] signal skip BUY amount=${signal.amount.toFixed(6)} SOL < min=${this.config.trading.minWhaleBuyAmountSol.toFixed(6)} SOL whale=${signal.whaleWallet.slice(0, 8)}... token=${signal.token.slice(0, 8)}...`,
        );
      }
      metrics.inc("laser_signal_drop_total", { reason: "min_whale_buy" });
      return;
    }
    const windowMs = this.config.runtime.dedupWhaleTxMs;
    if (this.isDuplicateWhaleTx(signal.whaleTxSignature, windowMs)) {
      if (this.config.debug.whalePipeline) {
        console.warn(
          `[whale-debug] signal dedup skip sig=${signal.whaleTxSignature.slice(0, 16)}... window=${windowMs}ms`,
        );
      }
      metrics.inc("laser_signal_drop_total", { reason: "dedup" });
      return;
    }
    if (signal.action === "BUY") {
      const reason = this.buyGateReason(signal);
      if (reason != null) {
        if (this.config.debug.whalePipeline) {
          console.warn(
            `[whale-debug] signal skip BUY ${reason} whale=${signal.whaleWallet.slice(0, 8)}... token=${signal.token.slice(0, 8)}...`,
          );
        }
        metrics.inc("laser_signal_drop_total", {
          reason: reason.startsWith("position locked")
            ? "position_locked"
            : "rebuy_limit",
        });
        return;
      }
    }
    if (signal.action === "SELL") {
      const existing = this.tokenPositions.get(signal.token);
      if (existing == null) {
        if (this.config.debug.whalePipeline) {
          console.warn(
            `[whale-debug] signal skip SELL no tracked BUY cycle whale=${signal.whaleWallet.slice(0, 8)}... token=${signal.token.slice(0, 8)}...`,
          );
        }
        metrics.inc("laser_signal_drop_total", { reason: "no_tracked_cycle" });
        return;
      }
      if (existing.owner !== signal.whaleWallet) {
        if (this.config.debug.whalePipeline) {
          console.warn(
            `[whale-debug] signal skip SELL owned by whale=${existing.owner.slice(0, 8)}... != signal whale=${signal.whaleWallet.slice(0, 8)}... token=${signal.token.slice(0, 8)}...`,
          );
        }
        metrics.inc("laser_signal_drop_total", { reason: "sell_non_owner" });
        return;
      }
    }

    this.onSignalAcceptedInternal(signal);
    if (this.config.debug.whalePipeline) {
      console.log(
        `[whale-debug] emit signal:trade ${signal.action} protocol=${signal.protocolHint} feed=${signal.feedSource} whale=${signal.whaleWallet.slice(0, 8)}... token=${signal.token.slice(0, 8)}...`,
      );
    }
    this.onSignal(signal);
  }
}
