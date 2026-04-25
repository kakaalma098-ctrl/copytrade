import { type Commitment, Connection, PublicKey } from "@solana/web3.js";
import { BlockhashCache } from "../perf/blockhash-cache.js";
import { WsolTopUpManager } from "../perf/startup-prewrap-wsol.js";
import { PersistentWsolTracker } from "../perf/persistent-wsol-tracker.js";
import { bus } from "../bus/event-bus.js";
import type {
  AppConfig,
  ExecutionIntent,
  ExecutionResult,
  ExecutionStageMetrics,
  ProtocolHint,
  RawWhaleTransaction,
  TradeSignal,
} from "../types/index.js";
import { ExecutionEngine } from "../execution/index.js";
// Meteora direct executor removed from live dispatch — see
// `resolveDirectExecutor` comment. File left intact for potential future
// reactivation but not referenced at runtime.
import {
  executeViaPumpFunSdk,
  executeViaPumpSwapSdk,
  getDirectPumpRevertRate,
  setDirectPumpBlockhashCache,
  setDirectPumpPersistentWsol,
  setDirectPumpPriorityFeeCache,
} from "../execution/direct-pump.js";
import { JupiterClient } from "../execution/jupiter.js";
import {
  PumpStateCache,
  setSharedPumpStateCache,
} from "../perf/pump-state-cache.js";
import { PoolAccountStream } from "../perf/pool-account-stream.js";
import { PriorityFeeCache } from "../perf/priority-fee-cache.js";
import { canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import {
  attachPipelineMetrics,
  pipelineMetricsFooter,
} from "../perf/latency.js";
import { WalletStateCache } from "../perf/wallet-state-cache.js";
import { prebuildCache } from "../perf/prebuild-cache.js";
import { runtimeMetrics } from "../runtime/metrics.js";
import { metrics } from "../runtime/metrics-registry.js";
import { AsyncSemaphore } from "../runtime/semaphore.js";
import { getTokenBalanceRawForMint } from "../utils/token-balance.js";
import { isTerminalJupiterQuoteError } from "../utils/axios-http-error.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

const SELL_RETRY_MAX_ATTEMPTS = 3;
const SELL_DRAIN_EXTRA_MAX_ATTEMPTS = 6;
const SELL_TOTAL_MAX_ATTEMPTS =
  SELL_RETRY_MAX_ATTEMPTS + SELL_DRAIN_EXTRA_MAX_ATTEMPTS;
/** Phase 2: wait this long before each background drain balance poll. Gives
 *  the previous submitted SELL tx time to land at `processed` commitment. */
const SELL_DRAIN_POLL_DELAY_MS = 800;
/** Slippage-escalating drain: drain attempt N (1-indexed) multiplies base
 *  slippage by this factor. Accepts paying more slippage to close a stuck
 *  position vs burning fee on repeated tight-slippage reverts. Index (N-1)
 *  is clamped to array length for attempts beyond the last multiplier. */
const SELL_DRAIN_SLIPPAGE_MULTIPLIERS = [1.5, 2, 3, 4, 5, 6] as const;
/** Per-mint drain circuit breaker: if a mint has this many drain reverts
 *  within the lookback window, abort further drain for that mint (pool is
 *  probably dumping and each retry just burns fee). */
const DRAIN_CIRCUIT_MAX_REVERTS = 2;
const DRAIN_CIRCUIT_WINDOW_MS = 5 * 60 * 1000;
const SELL_FRACTION_SCALE = 1_000_000n;

/** Phase 5: direct-pump circuit breaker thresholds. When the rolling revert
 *  rate for a protocol exceeds this, the engine bypasses the direct-pump
 *  executor and goes straight to Jupiter (more reliable, slightly slower). */
const DIRECT_PUMP_MIN_SAMPLES = 10;
const DIRECT_PUMP_REVERT_THRESHOLD = 0.3;
// Jupiter route-preference labels. When a whale's protocol is identified, we
// hint Jupiter's router to try those DEXes first. For fresh Pump.fun bonding
// curves / PumpSwap / LaunchLab, this dramatically increases the chance of a
// successful route when generic aggregation misses the pool. METEORA removed
// — Jupiter v2 Ultra handles Meteora DLMM/DAMM routing natively and DEX
// hint causes failed routing when a whale tx merely transits Meteora.
const DIRECT_DEX_BY_PROTOCOL: Partial<Record<ProtocolHint, string[]>> = {
  PUMPFUN: ["Pump.fun"],
  PUMPSWAP: ["Pump.fun Amm", "Pump.fun"],
  RAYDIUM: ["Raydium CPMM", "Raydium", "Raydium CLMM"],
  LAUNCHLAB: ["Raydium Launchpad", "Raydium"],
};

const buyCacheKey = (token: string): string => `buy:${token}`;
const sellCacheKey = (token: string, amountString: string): string =>
  `sell:${token}:${amountString}`;

const baseIntent = (
  signal: TradeSignal,
  sizeSol: number,
  handlerStartedAtMs: number,
  followWhaleSell: boolean,
  slippageBpsOverride?: number,
): ExecutionIntent => ({
  token: signal.token,
  side: signal.action,
  protocolHint: signal.protocolHint,
  size: sizeSol,
  slippageBpsOverride,
  sellFraction:
    signal.action === "SELL" && followWhaleSell
      ? signal.whaleSellFraction
      : undefined,
  delayMs: 0,
  whaleWallet: signal.whaleWallet,
  signalTimestamp: signal.timestamp,
  detectedAtMs: signal.detectedAtMs,
  signalEmittedAtMs: signal.signalEmittedAtMs,
  handlerStartedAtMs,
});

const applySellFraction = (raw: string, fraction?: number): string => {
  if (
    fraction == null ||
    !Number.isFinite(fraction) ||
    fraction <= 0 ||
    fraction >= 1
  ) {
    return raw;
  }

  const total = BigInt(raw);
  if (total <= 0n) {
    return "0";
  }

  const scaled = BigInt(
    Math.max(1, Math.floor(fraction * Number(SELL_FRACTION_SCALE))),
  );
  let out = (total * scaled) / SELL_FRACTION_SCALE;
  // Keep at least 1 raw unit when we do partial sell on non-zero balance.
  if (out <= 0n) {
    out = 1n;
  }
  if (out > total) {
    out = total;
  }
  return out.toString();
};

const mergeStageMetrics = (
  current: ExecutionStageMetrics | undefined,
  patch: ExecutionStageMetrics,
): ExecutionStageMetrics => ({
  ...(current ?? {}),
  ...patch,
});

export class CopyTradingEngine {
  /**
   * Phase 2 + position-lock: predicate consulted before firing speculative
   * SELL quotes. Wired from main.ts to processor.isSellFromPositionOwner —
   * only the whale that OPENED the position cycle can trigger the bot SELL.
   * SELLs from other whales (or unknown tokens) are skipped BEFORE a wasted
   * Jupiter call. Default permissive — overridden via setShouldAttemptSell.
   */
  private shouldAttemptSell: (token: string, whale: string) => boolean = () =>
    true;

  /** Phase 4: background prewarm timer + tracked-tokens source. */
  private prewarmTimer: ReturnType<typeof setInterval> | null = null;
  private getTrackedTokensFn: () => string[] = () => [];

  /** Rebuy ladder: predict next buyCount so speculative quote size matches
   *  handler size → prebuild cache stays aligned. */
  private getBuyCountFn: (token: string) => number = () => 0;

  /**
   * Auto-sell TTL watcher: periodically scans all active position cycles
   * and auto-closes any that have been held longer than `autoSellTtlMs`.
   * Covers the edge case where the owner whale goes offline without ever
   * signalling SELL — otherwise the bot's position would be locked forever.
   */
  private autoSellTimer: ReturnType<typeof setInterval> | null = null;
  private getAllPositionsFn: () => Array<{
    token: string;
    owner: string;
    openedAtMs: number;
  }> = () => [];
  private releasePositionFn: (token: string) => boolean = () => false;
  /**
   * Per-token effective TTL resolver. Returns 0 to disable auto-sell for a
   * given token. Defaults to the global `trading.autoSellTtlMs` — but main.ts
   * wires a closure that consults `trading.tokenOverrides` first.
   */
  private getEffectiveTtlFn: (token: string) => number = () => 0;
  /** Prevents overlapping auto-sell attempts for the same token mid-flight. */
  private readonly autoSellInflight = new Set<string>();
  /** Per-mint timestamps of recent drain reverts. Used by the drain circuit
   *  breaker to skip drain attempts on mints whose pool is clearly dumping
   *  (every attempt reverts and burns fee for nothing). */
  private readonly drainRevertHistory = new Map<string, number[]>();
  /** Speculative pool subscription deps — wired at startup. See
   *  `speculativelySubscribePool` for the warmup flow. */
  private poolAccountStream: PoolAccountStream | null = null;
  private pumpStateCache: PumpStateCache | null = null;
  /** Dedup: don't re-kick tokenProgram lookup + subscribe for the same mint
   *  more than once per session. registerPool is itself idempotent, but the
   *  tokenProgram RPC is not — this prevents duplicate RPCs on repeat whale
   *  decodes of the same token. */
  private readonly speculativeSubscribeSeen = new Set<string>();
  /**
   * N11: cache PublicKey per mint string. `new PublicKey(str)` base58-decodes
   * 32 bytes on every call — cheap but compounds over tight retry loops and
   * prewarm cycles. Bounded LRU-style to avoid unbounded growth across many
   * whale-traded tokens.
   */
  private readonly pubkeyCache = new Map<string, PublicKey>();
  private static readonly PUBKEY_CACHE_MAX = 512;

  /**
   * Per-whale slippage resolver. Returns the whale-specific override from
   * `config.trading.whaleSlippageBps` when present; otherwise the global
   * default `config.trading.slippageBps`. Used to populate
   * `intent.slippageBpsOverride` which direct-pump + Jupiter read downstream.
   */
  private effectiveSlippageBps(whaleWallet: string): number {
    const override = this.config.trading.whaleSlippageBps[whaleWallet];
    if (
      typeof override === "number" &&
      Number.isFinite(override) &&
      override >= 0
    ) {
      return override;
    }
    return this.config.trading.slippageBps;
  }

  private pubkeyForMint(mint: string): PublicKey {
    const hit = this.pubkeyCache.get(mint);
    if (hit != null) {
      return hit;
    }
    const pk = new PublicKey(mint);
    if (this.pubkeyCache.size >= CopyTradingEngine.PUBKEY_CACHE_MAX) {
      const oldest = this.pubkeyCache.keys().next().value;
      if (oldest != null) {
        this.pubkeyCache.delete(oldest);
      }
    }
    this.pubkeyCache.set(mint, pk);
    return pk;
  }

  constructor(
    private readonly config: AppConfig,
    private readonly executionEngine: ExecutionEngine,
    private readonly buySemaphore: AsyncSemaphore,
    private readonly sellSemaphore: AsyncSemaphore,
    private readonly walletStateCache: WalletStateCache,
    private readonly wsolTracker?: PersistentWsolTracker,
  ) {}

  /** Phase 2 + position-lock: wire SELL gate (token owner check). */
  setShouldAttemptSell(
    predicate: (token: string, whale: string) => boolean,
  ): void {
    this.shouldAttemptSell = predicate;
  }

  /** Wire the buyCount lookup (from processor) for rebuy ladder sizing. */
  setBuyCountLookup(fn: (token: string) => number): void {
    this.getBuyCountFn = fn;
  }

  /** Wire the gRPC pool stream + pump state cache so speculative subscribes
   *  can warm the push-cache on whale decode (before signal validates). */
  setPoolAccountStream(
    stream: PoolAccountStream,
    pumpStateCache: PumpStateCache,
  ): void {
    this.poolAccountStream = stream;
    this.pumpStateCache = pumpStateCache;
  }

  /** Compute BUY size for the N-th BUY (1-indexed). Mirrors processor logic. */
  private computeBuySize(buyCount: number): number {
    const base = this.config.trading.fixedBuyAmountSol;
    const step = this.config.trading.rebuyAmountSize;
    const n = Math.max(1, buyCount);
    const size = base + (n - 1) * step;
    return Number.isFinite(size) && size > 0 ? size : base;
  }

  /**
   * Phase 4: start background timer that refreshes speculative SELL prebuild
   * for every currently-held position. Ensures the prebuild cache has a warm
   * entry the moment a whale SELL arrives — lifting hit rate from ~23% to
   * ~80%+ in observed whale activity patterns.
   *
   * Only tokens with fresh (TTL-hot) positive balance in `walletStateCache`
   * are prewarmed; cold-cache tokens are skipped this cycle to avoid
   * speculative RPC bursts.
   */
  startPositionPrewarm(
    getTrackedTokens: () => string[],
    intervalMs = 2500,
  ): void {
    this.getTrackedTokensFn = getTrackedTokens;
    if (this.prewarmTimer != null) {
      clearInterval(this.prewarmTimer);
    }
    this.prewarmTimer = setInterval(() => this.runPrewarmCycle(), intervalMs);
  }

  stopPositionPrewarm(): void {
    if (this.prewarmTimer != null) {
      clearInterval(this.prewarmTimer);
      this.prewarmTimer = null;
    }
  }

  /**
   * Start the auto-sell TTL watcher. `getEffectiveTtl(token)` returns the
   * per-token TTL — 0 means no TTL for that token (bot holds until owner
   * whale signals SELL). Closure in main.ts consults `tokenOverrides` first
   * and falls back to the global `autoSellTtlMs`.
   */
  startAutoSellWatcher(
    getAllPositions: () => Array<{
      token: string;
      owner: string;
      openedAtMs: number;
    }>,
    releasePosition: (token: string) => boolean,
    getEffectiveTtl: (token: string) => number,
    checkIntervalMs = 60_000,
  ): void {
    this.getAllPositionsFn = getAllPositions;
    this.releasePositionFn = releasePosition;
    this.getEffectiveTtlFn = getEffectiveTtl;

    if (this.autoSellTimer != null) {
      clearInterval(this.autoSellTimer);
    }
    const interval = Math.max(10_000, checkIntervalMs);
    this.autoSellTimer = setInterval(() => this.runAutoSellCycle(), interval);
  }

  stopAutoSellWatcher(): void {
    if (this.autoSellTimer != null) {
      clearInterval(this.autoSellTimer);
      this.autoSellTimer = null;
    }
  }

  /**
   * Dashboard control API entrypoint — force-sell a specific position via
   * the same fast-ack + drain path used by TTL auto-sell. Caller is
   * expected to release the position from processor state first so the
   * sell doesn't get re-triggered by any subsequent watcher tick.
   */
  async forceSellByToken(token: string, owner: string): Promise<void> {
    if (this.autoSellInflight.has(token)) {
      throw new Error("auto-sell already in flight for this token");
    }
    this.autoSellInflight.add(token);
    try {
      await this.triggerAutoSell(token, owner, Date.now());
    } finally {
      this.autoSellInflight.delete(token);
    }
  }

  private runAutoSellCycle(): void {
    const positions = this.getAllPositionsFn();
    if (positions.length === 0) return;
    const now = Date.now();
    for (const { token, owner, openedAtMs } of positions) {
      const ttl = this.getEffectiveTtlFn(token);
      if (ttl <= 0) continue; // TTL disabled for this token
      if (now - openedAtMs < ttl) continue; // not yet expired
      if (this.autoSellInflight.has(token)) continue;
      this.autoSellInflight.add(token);
      // Release the cycle slot immediately so a concurrent whale SELL
      // or next TTL tick cannot re-queue the same token.
      this.releasePositionFn(token);
      void this.triggerAutoSell(token, owner, openedAtMs).finally(() => {
        this.autoSellInflight.delete(token);
      });
    }
  }

  private async triggerAutoSell(
    token: string,
    owner: string,
    openedAtMs: number,
  ): Promise<void> {
    let pubkey: PublicKey;
    try {
      pubkey = this.pubkeyForMint(token);
    } catch {
      return;
    }

    const ageMs = Date.now() - openedAtMs;
    const ageMin = Math.round(ageMs / 60_000);
    const tokenShort = token.slice(0, 8);
    const ownerShort = owner.slice(0, 8);

    let balanceRaw: string | null;
    try {
      balanceRaw = await this.getFreshTokenRawForMint(pubkey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[auto-sell] balance read failed token=${tokenShort}... owner=${ownerShort}... age=${ageMin}min err=${msg}`,
      );
      return;
    }

    if (balanceRaw == null || balanceRaw === "0") {
      console.log(
        `[auto-sell] cycle expired but on-chain balance=0 token=${tokenShort}... owner=${ownerShort}... age=${ageMin}min — position already drained`,
      );
      return;
    }

    console.log(
      `[auto-sell] TTL exceeded — selling token=${tokenShort}... owner=${ownerShort}... age=${ageMin}min balance=${balanceRaw}`,
    );

    await this.sellSemaphore.acquire();
    runtimeMetrics.activeSwaps++;
    const handlerStartedAtMs = Date.now();
    try {
      const intent: ExecutionIntent = {
        token,
        side: "SELL",
        // No protocol hint — let Jupiter aggregator find the best route.
        // Bot doesn't know the current pool state for a stale position.
        protocolHint: undefined,
        size: 0,
        // Full balance — TTL expiry means we want out completely.
        sellFraction: undefined,
        delayMs: 0,
        whaleWallet: owner,
        signalTimestamp: Date.now(),
        handlerStartedAtMs,
        sellTokenAmountRaw: balanceRaw,
      };

      const raw = await this.runSellWithRetrySequential(intent);
      this.updateWsolTracker(intent, raw);
      // Emit to bus for Telegram + metrics observability. No pipeline
      // timestamps since this is a synthetic signal — pipelineTotalMs stays
      // undefined, which the latency log renders without the pipeline= field.
      bus.emitAsync("exec:result", {
        ...raw,
        whaleWallet: `auto-sell:${ownerShort}`,
      });

      if (raw.status !== "failed") {
        this.scheduleSellDrainInBackground(
          intent,
          raw.sellRetry?.attempted ?? 1,
        );
      } else {
        console.warn(
          `[auto-sell] sell failed token=${tokenShort}... err=${raw.error ?? "unknown"}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[auto-sell] unexpected failure token=${tokenShort}... err=${msg}`,
      );
    } finally {
      runtimeMetrics.activeSwaps--;
      this.sellSemaphore.release();
    }
  }

  private runPrewarmCycle(): void {
    const tokens = this.getTrackedTokensFn();
    if (tokens.length === 0) {
      return;
    }
    for (const token of tokens) {
      let pubkey: PublicKey;
      try {
        pubkey = this.pubkeyForMint(token);
      } catch {
        continue;
      }
      const syncBalance = this.walletStateCache.getTokenRawForMintSync(pubkey);
      if (syncBalance === undefined) {
        // Cache cold — skip. Whale-event speculative path will seed it.
        continue;
      }
      if (syncBalance == null || syncBalance === "0") {
        continue;
      }
      // followWhaleSell=false → handler sells full balance → amount match.
      // followWhaleSell=true path will miss the prewarm (fraction-scaled
      // handler amount); whale-event speculative still covers that case.
      this.fireSpeculativeSellPrebuild({
        tokenMint: token,
        sellTokenAmountRaw: syncBalance,
        sellFraction: undefined,
        protocolHint: undefined,
        whaleWallet: "prewarm",
        signalTimestamp: Date.now(),
      });
    }
  }

  /**
   * After a swap submits/confirms, update the in-memory WSOL balance so
   * the next BUY hot-path check skips the RPC. BUY spends WSOL; Jupiter
   * SELL (wrapAndUnwrapSol=false) and PumpSwap SELL (Phase 3 strip-close)
   * deposit the SOL output back into the ATA as WSOL.
   */
  private updateWsolTracker(
    intent: ExecutionIntent,
    result: ExecutionResult,
  ): void {
    if (this.wsolTracker == null) return;
    if (result.status === "failed") return;
    if (!this.config.trading.persistentWsol) return;

    if (intent.side === "BUY") {
      const spent = BigInt(Math.floor(intent.size * 1_000_000_000));
      this.wsolTracker.recordBuySpend(spent);
      return;
    }
    // SELL — credit expected output. Jupiter quote carries `outAmount` in
    // WSOL lamports on the SELL path. Pump direct executors don't populate
    // outAmountRaw; invalidate so the next hasEnough triggers a refresh.
    const raw = result.outAmountRaw;
    const asString =
      typeof raw === "number" && Number.isFinite(raw)
        ? String(Math.trunc(raw))
        : typeof raw === "string"
          ? raw.trim()
          : "";
    if (asString !== "" && /^\d+$/.test(asString)) {
      this.wsolTracker.recordSellReceive(BigInt(asString));
    } else {
      this.wsolTracker.invalidate();
    }
  }

  private withSellRetryMeta(
    result: ExecutionResult,
    attempted: number,
    winnerAttempt?: number,
    maxAttempts = SELL_RETRY_MAX_ATTEMPTS,
  ): ExecutionResult {
    return {
      ...result,
      sellRetry: {
        mode: "sequential",
        maxAttempts,
        attempted,
        ...(winnerAttempt != null ? { winnerAttempt } : {}),
      },
    };
  }

  private async getFreshTokenRawForMint(
    token: PublicKey,
  ): Promise<string | null> {
    return getTokenBalanceRawForMint(
      this.executionEngine.connection,
      this.executionEngine.getTakerPublicKey(),
      token,
    );
  }

  private resolveDirectExecutor(protocol: ProtocolHint | undefined): {
    label: string;
    run: (
      connection: Connection,
      taker: import("@solana/web3.js").Keypair,
      intent: ExecutionIntent,
      slippageBps: number,
      commitment: "processed" | "confirmed" | "finalized",
      sendContext?: import("../execution/direct-pump.js").PumpSendContext,
    ) => Promise<ExecutionResult>;
  } | null {
    // METEORA direct path intentionally removed: 95% of whale tx labelled
    // METEORA are Jupiter-aggregator routings that merely TOUCH a Meteora
    // program (transit, vault). The direct executor's searchPoolsByToken
    // scan wastes ~500-700ms on these misclassifications before falling
    // back to Jupiter. Jupiter v2 Ultra already routes Meteora pools well.
    switch (protocol) {
      case "PUMPFUN":
        return { label: "PUMPFUN", run: executeViaPumpFunSdk };
      case "PUMPSWAP":
        return { label: "PUMPSWAP", run: executeViaPumpSwapSdk };
      default:
        return null;
    }
  }

  private async buildAndExecute(
    intent: ExecutionIntent,
  ): Promise<ExecutionResult> {
    let directExecutor = this.resolveDirectExecutor(intent.protocolHint);

    // Phase 5: circuit breaker — disable direct-pump when its recent revert
    // rate is too high. Jupiter path (cached or fresh) is more reliable even
    // when slightly slower for fresh pump tokens.
    if (directExecutor != null) {
      const { rate, samples } = getDirectPumpRevertRate(directExecutor.label);
      if (
        samples >= DIRECT_PUMP_MIN_SAMPLES &&
        rate >= DIRECT_PUMP_REVERT_THRESHOLD
      ) {
        if (this.config.debug.whalePipeline) {
          console.warn(
            `[whale-debug] direct-pump circuit-break ${directExecutor.label} revert=${Math.round(rate * 100)}% samples=${samples} -> Jupiter`,
          );
        }
        metrics.inc("laser_direct_pump_circuit_break_total", {
          protocol: directExecutor.label,
        });
        directExecutor = null;
      }
    }

    // Phase 4 + Option A: Check prebuild cache before the direct-pump executor.
    // For PUMP protocols, the Jupiter prebuild is capped at `pumpPrebuildTimeoutMs`
    // so we don't wait a full 200-500ms SGP round trip when direct-pump can
    // build the same tx in <50ms. Non-PUMP protocols keep the original wait-
    // forever semantics since they have no direct executor to fall through to.
    if (intent.bypassQuoteCache !== true) {
      const cacheKey =
        intent.side === "BUY"
          ? buyCacheKey(intent.token)
          : intent.sellTokenAmountRaw != null
            ? sellCacheKey(intent.token, intent.sellTokenAmountRaw)
            : null;

      if (cacheKey != null) {
        const tPrebuild = Date.now();
        const pumpTimeout = this.config.perf.pumpPrebuildTimeoutMs;
        // Apply timeout to any side (BUY or SELL) when a direct-pump executor
        // is available. For pump protocols, direct SDK beats Jupiter round-trip
        // on both directions; the earlier BUY-only scope was too conservative.
        const shouldTimeout = directExecutor != null && pumpTimeout > 0;
        const cached = shouldTimeout
          ? await prebuildCache.takeWithTimeout(cacheKey, pumpTimeout)
          : await prebuildCache.take(cacheKey);
        if (cached != null) {
          const prebuildWaitMs = Date.now() - tPrebuild;
          metrics.inc("laser_prebuild_cache_total", {
            side: intent.side,
            outcome: "hit",
          });
          if (this.config.debug.whalePipeline) {
            console.log(
              `[whale-debug] prebuild cache HIT side=${intent.side} token=${intent.token.slice(0, 8)}... waitMs=${prebuildWaitMs} -> skip duplicate Jupiter call`,
            );
          }
          const raw = await this.executionEngine.execute(
            intent,
            cached.quote,
            cached.build,
          );
          return {
            ...raw,
            executionStageMs: mergeStageMetrics(raw.executionStageMs, {
              quoteBuildMs: prebuildWaitMs,
            }),
          };
        }
        const outcome = shouldTimeout ? "timeout" : "miss";
        metrics.inc("laser_prebuild_cache_total", {
          side: intent.side,
          outcome,
        });
        if (shouldTimeout && this.config.debug.whalePipeline) {
          console.log(
            `[whale-debug] prebuild timeout side=${intent.side} token=${intent.token.slice(0, 8)}... waitMs=${Date.now() - tPrebuild} -> direct-pump ${directExecutor?.label ?? "N/A"}`,
          );
        }
      }
    } else {
      metrics.inc("laser_prebuild_cache_total", {
        side: intent.side,
        outcome: "bypass",
      });
    }

    // Cache miss — try direct executor (fast for pump protocols when it works).
    if (directExecutor != null) {
      try {
        const effectiveSlip =
          intent.slippageBpsOverride ?? this.config.trading.slippageBps;
        const sendContext = this.executionEngine.prepareDirectExecutorContext(
          intent.side,
        );
        const direct = await directExecutor.run(
          this.executionEngine.connection,
          this.executionEngine.getTakerKeypair(),
          intent,
          effectiveSlip,
          this.config.execution.confirmCommitment,
          sendContext,
        );

        if (this.config.debug.whalePipeline) {
          console.warn(
            `[whale-debug] direct executor hit protocol=${directExecutor.label} side=${intent.side} token=${intent.token.slice(0, 8)}...`,
          );
        }
        return direct;
      } catch (e) {
        // BUY no-fallback: abort instead of falling through to Jupiter. The
        // fallback adds 200-500ms of Jupiter round trip — during which the
        // pump pool price moves significantly. Missed entry is cheaper than
        // a late entry at a worse price. SELL keeps the fallback so the
        // position always closes.
        if (this.config.execution.buyNoFallback && intent.side === "BUY") {
          if (this.config.debug.whalePipeline) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(
              `[whale-debug] direct executor fail protocol=${directExecutor.label} (BUY no-fallback) -> abort (${msg})`,
            );
          }
          throw e;
        }
        if (this.config.debug.whalePipeline) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            `[whale-debug] direct executor fail protocol=${directExecutor.label} -> fallback Jupiter (${msg})`,
          );
        }
      }
    }

    const quoteStarted = Date.now();
    const preferredDexes = intent.protocolHint
      ? DIRECT_DEX_BY_PROTOCOL[intent.protocolHint]
      : undefined;
    let built;

    try {
      built = await this.executionEngine.jupiter.buildSwapTransactionWithQuote(
        intent,
        this.executionEngine.getTakerAddress(),
        undefined,
        {
          bypassQuoteCache: intent.bypassQuoteCache === true,
          dexes: preferredDexes,
        },
      );
    } catch (e) {
      if (!preferredDexes || preferredDexes.length === 0) {
        throw e;
      }
      // BUY no-fallback: abort instead of retrying without dex preference.
      // The retry is another full Jupiter round trip. Same rationale as direct
      // executor fallback above — late entry worse than missed entry.
      if (this.config.execution.buyNoFallback && intent.side === "BUY") {
        if (this.config.debug.whalePipeline) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            `[whale-debug] direct-dex route failed protocol=${intent.protocolHint} dexes=${preferredDexes.join(",")} (BUY no-fallback) -> abort (${msg})`,
          );
        }
        throw e;
      }
      if (this.config.debug.whalePipeline) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          `[whale-debug] direct-dex route failed protocol=${intent.protocolHint} dexes=${preferredDexes.join(",")} -> fallback aggregator (${msg})`,
        );
      }

      built = await this.executionEngine.jupiter.buildSwapTransactionWithQuote(
        intent,
        this.executionEngine.getTakerAddress(),
        undefined,
        { bypassQuoteCache: true },
      );
    }

    const quoteBuildMs = Date.now() - quoteStarted;

    const raw = await this.executionEngine.execute(
      intent,
      built.quote,
      built.build,
    );
    return {
      ...raw,
      executionStageMs: mergeStageMetrics(raw.executionStageMs, {
        quoteBuildMs,
      }),
    };
  }

  /**
   * Phase 2: SELL base attempts with fast-ack. Attempt #1 uses fast-ack so
   * the pipeline returns in ~50-80ms. Attempts #2/#3 only run if #1 failed
   * synchronously (build/quote error, terminal Jupiter error, zero balance).
   * On-chain landing + recovery is handled by `scheduleSellDrainInBackground`.
   */
  private async runSellWithRetrySequential(
    intent: ExecutionIntent,
  ): Promise<ExecutionResult> {
    const token = this.pubkeyForMint(intent.token);

    if (this.config.debug.whalePipeline) {
      console.warn(
        `[whale-debug] sell base start attempts=${SELL_RETRY_MAX_ATTEMPTS} whale=${intent.whaleWallet.slice(0, 8)}... token=${intent.token.slice(0, 8)}...`,
      );
    }

    const failed: Array<{ attempt: number; result: ExecutionResult }> = [];
    let terminalAbort = false;

    for (let attempt = 1; attempt <= SELL_RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        const tokenAmountRaw =
          attempt === 1 && intent.sellTokenAmountRaw
            ? intent.sellTokenAmountRaw
            : await this.walletStateCache.getTokenRawForMint(token);

        if (tokenAmountRaw == null || tokenAmountRaw === "0") {
          const result: ExecutionResult = {
            signature: "",
            status: "failed",
            error: `sell attempt #${attempt}: no token balance to sell`,
            whaleWallet: intent.whaleWallet,
            token: intent.token,
            side: intent.side,
            sizeSol: intent.size,
          };
          failed.push({ attempt, result });
          break;
        }

        const proportionalSellRaw = applySellFraction(
          tokenAmountRaw,
          intent.sellFraction,
        );
        if (proportionalSellRaw === "0") {
          const result: ExecutionResult = {
            signature: "",
            status: "failed",
            error: `sell attempt #${attempt}: proportional sell amount resolved to zero`,
            whaleWallet: intent.whaleWallet,
            token: intent.token,
            side: intent.side,
            sizeSol: intent.size,
          };
          failed.push({ attempt, result });
          break;
        }

        const attemptIntent: ExecutionIntent = {
          ...intent,
          // Phase 2: fast-ack for SELL — remove 200-400ms sync confirm wait.
          // Drain loop (scheduleSellDrainInBackground) recovers on-chain reverts.
          forceSyncConfirm: false,
          // Phase 4: attempt 1 allows prebuild cache reuse; retries bypass.
          bypassQuoteCache: attempt > 1,
          sellTokenAmountRaw: proportionalSellRaw,
        };
        const result = await this.buildAndExecute(attemptIntent);

        if (this.config.debug.whalePipeline) {
          console.warn(
            `[whale-debug] sell attempt #${attempt}/${SELL_RETRY_MAX_ATTEMPTS} status=${result.status} whale=${intent.whaleWallet.slice(0, 8)}... token=${intent.token.slice(0, 8)}...`,
          );
        }

        if (result.status !== "failed") {
          return this.withSellRetryMeta(result, attempt, attempt);
        }

        failed.push({ attempt, result });

        if (isTerminalJupiterQuoteError(result.error)) {
          terminalAbort = true;
          if (this.config.debug.whalePipeline) {
            console.warn(
              `[whale-debug] sell terminal Jupiter error -> abort retries token=${intent.token.slice(0, 8)}... err=${result.error}`,
            );
          }
          break;
        }
      } catch (e) {
        const result: ExecutionResult = {
          signature: "",
          status: "failed",
          error: `sell attempt #${attempt}: ${e instanceof Error ? e.message : String(e)}`,
          whaleWallet: intent.whaleWallet,
          token: intent.token,
          side: intent.side,
          sizeSol: intent.size,
        };
        failed.push({ attempt, result });

        if (isTerminalJupiterQuoteError(e)) {
          terminalAbort = true;
          if (this.config.debug.whalePipeline) {
            console.warn(
              `[whale-debug] sell terminal Jupiter error -> abort retries token=${intent.token.slice(0, 8)}... err=${result.error}`,
            );
          }
          break;
        }
      }
    }

    const firstFailure = failed.find((x) => x.result.error)?.result ??
      failed[0]?.result ?? {
        signature: "",
        status: "failed" as const,
        error: "sell retry sequential failed",
        whaleWallet: intent.whaleWallet,
        token: intent.token,
        side: intent.side,
        sizeSol: intent.size,
      };

    const detail = failed
      .map((x) => `#${x.attempt}:${x.result.error ?? x.result.status}`)
      .join(" | ");

    const outcome = terminalAbort
      ? `sell aborted (terminal Jupiter error) after ${failed.length} attempt(s)`
      : `sell base exhausted ${failed.length}/${SELL_RETRY_MAX_ATTEMPTS}`;

    // Note: remainingNote omitted here — fresh RPC read would block the pipeline.
    // Background drain (if scheduled later) emits its own drain-level observability.
    return this.withSellRetryMeta(
      {
        ...firstFailure,
        error: `${outcome}: ${detail}`,
      },
      failed.length,
      undefined,
      SELL_RETRY_MAX_ATTEMPTS,
    );
  }

  /**
   * Record a drain revert for the given mint. Prunes entries outside the
   * lookback window so the history stays bounded.
   */
  private recordDrainRevert(mint: string): void {
    const now = Date.now();
    const cutoff = now - DRAIN_CIRCUIT_WINDOW_MS;
    const arr = this.drainRevertHistory.get(mint) ?? [];
    const pruned = arr.filter((t) => t >= cutoff);
    pruned.push(now);
    this.drainRevertHistory.set(mint, pruned);
  }

  /**
   * Returns true if the mint has exceeded the drain revert threshold within
   * the lookback window. Used to short-circuit further drain attempts when
   * the pool is clearly dumping.
   */
  private isDrainCircuitBroken(mint: string): boolean {
    const arr = this.drainRevertHistory.get(mint);
    if (arr == null || arr.length === 0) return false;
    const cutoff = Date.now() - DRAIN_CIRCUIT_WINDOW_MS;
    const recent = arr.filter((t) => t >= cutoff).length;
    return recent >= DRAIN_CIRCUIT_MAX_REVERTS;
  }

  /**
   * Compute the slippage bps for drain attempt N (1-indexed). Base is the
   * whale-specific or global slippage from the intent; each attempt widens
   * by the multiplier at index (N-1), clamped to the last multiplier.
   */
  private drainSlippageBpsForAttempt(
    baseSlippageBps: number,
    attemptOneIndexed: number,
  ): number {
    const idx = Math.max(
      0,
      Math.min(
        SELL_DRAIN_SLIPPAGE_MULTIPLIERS.length - 1,
        attemptOneIndexed - 1,
      ),
    );
    const multiplier = SELL_DRAIN_SLIPPAGE_MULTIPLIERS[idx]!;
    return Math.max(1, Math.round(baseSlippageBps * multiplier));
  }

  /**
   * Phase 2: Drain retry executes asynchronously after a successful submitted
   * attempt. Polls on-chain balance at `SELL_DRAIN_POLL_DELAY_MS` intervals.
   * If balance remains >0 (previous tx reverted on-chain OR partial fill), it
   * fires additional fast-ack attempts up to SELL_TOTAL_MAX_ATTEMPTS. Never
   * blocks the pipeline — logs outcome via console, does NOT emit `exec:result`.
   *
   * Slippage escalation: each drain attempt widens the slippage tolerance so
   * a stuck position is more likely to close at the cost of a larger haircut.
   * Circuit breaker: if the mint has reverted DRAIN_CIRCUIT_MAX_REVERTS times
   * within DRAIN_CIRCUIT_WINDOW_MS, abort further attempts (pool is dumping;
   * each revert just burns fee).
   */
  private scheduleSellDrainInBackground(
    baseIntent: ExecutionIntent,
    attemptsAlreadyUsed: number,
  ): void {
    if (attemptsAlreadyUsed >= SELL_TOTAL_MAX_ATTEMPTS) {
      return;
    }
    const token = this.pubkeyForMint(baseIntent.token);
    const tokenShort = baseIntent.token.slice(0, 8);
    const baseSlippageBps =
      baseIntent.slippageBpsOverride ?? this.config.trading.slippageBps;

    const run = async (): Promise<void> => {
      let attempt = attemptsAlreadyUsed;
      while (attempt < SELL_TOTAL_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, SELL_DRAIN_POLL_DELAY_MS),
        );

        if (this.isDrainCircuitBroken(baseIntent.token)) {
          if (this.config.debug.whalePipeline) {
            console.warn(
              `[whale-debug] sell drain circuit-break token=${tokenShort}... reverts>=${DRAIN_CIRCUIT_MAX_REVERTS} in ${DRAIN_CIRCUIT_WINDOW_MS}ms -> abort`,
            );
          }
          return;
        }

        let balanceRaw: string | null;
        try {
          balanceRaw = await this.getFreshTokenRawForMint(token);
        } catch (e) {
          if (this.config.debug.whalePipeline) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(
              `[whale-debug] sell drain balance read failed token=${tokenShort}... err=${msg}`,
            );
          }
          continue;
        }

        if (balanceRaw == null || balanceRaw === "0") {
          if (this.config.debug.whalePipeline) {
            console.warn(
              `[whale-debug] sell drain complete balance=0 attemptsUsed=${attempt} token=${tokenShort}...`,
            );
          }
          return;
        }

        attempt += 1;
        const drainAttemptNumber = attempt - attemptsAlreadyUsed;
        const escalatedSlippageBps = this.drainSlippageBpsForAttempt(
          baseSlippageBps,
          drainAttemptNumber,
        );

        try {
          const attemptIntent: ExecutionIntent = {
            ...baseIntent,
            forceSyncConfirm: false,
            bypassQuoteCache: true,
            // Drain: sell all remaining raw to avoid stranded position.
            sellFraction: undefined,
            sellTokenAmountRaw: balanceRaw,
            slippageBpsOverride: escalatedSlippageBps,
          };
          const res = await this.buildAndExecute(attemptIntent);

          if (this.config.debug.whalePipeline) {
            console.warn(
              `[whale-debug] sell drain attempt #${attempt}/${SELL_TOTAL_MAX_ATTEMPTS} status=${res.status} slip=${escalatedSlippageBps}bps token=${tokenShort}...`,
            );
          }

          if (res.status === "failed") {
            this.recordDrainRevert(baseIntent.token);
            if (isTerminalJupiterQuoteError(res.error)) {
              if (this.config.debug.whalePipeline) {
                console.warn(
                  `[whale-debug] sell drain aborted terminal Jupiter error token=${tokenShort}... err=${res.error}`,
                );
              }
              return;
            }
          }
        } catch (e) {
          this.recordDrainRevert(baseIntent.token);
          if (isTerminalJupiterQuoteError(e)) {
            if (this.config.debug.whalePipeline) {
              const msg = e instanceof Error ? e.message : String(e);
              console.warn(
                `[whale-debug] sell drain aborted terminal Jupiter error token=${tokenShort}... err=${msg}`,
              );
            }
            return;
          }
          if (this.config.debug.whalePipeline) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(
              `[whale-debug] sell drain attempt threw token=${tokenShort}... err=${msg}`,
            );
          }
        }
      }

      if (this.config.debug.whalePipeline) {
        console.warn(
          `[whale-debug] sell drain exhausted ${SELL_TOTAL_MAX_ATTEMPTS}/${SELL_TOTAL_MAX_ATTEMPTS} token=${tokenShort}...`,
        );
      }
    };

    void run().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[whale-debug] sell drain runner error token=${tokenShort}... err=${msg}`,
      );
    });
  }

  /**
   * Speculatively register the pump-swap pool for this whale's token with
   * the gRPC stream. No-op for non-PUMPSWAP protocols. Called at decode time
   * (before signal validation) so by the time the engine handler reaches
   * `fetchPumpSwapState` the subscription has been issued and any pool
   * update pushed in the interim is already cached.
   *
   * Even when a fresh subscription cannot back-fill the first state read
   * (gRPC streams do not replay past updates), this primes the cache for
   * subsequent swaps on the same pool — rebuy ladders, auto-sell TTL,
   * whale-initiated SELL later — each of which now bypasses the ~30-45ms
   * `getMultipleAccountsInfo` round trip.
   *
   * Bounded by `speculativeSubscribeSeen` so the tokenProgram RPC fires at
   * most once per mint per session; `PoolAccountStream.registerPool` is
   * itself idempotent and costs only a filter-push on duplicate calls.
   */
  speculativelySubscribePool(tx: RawWhaleTransaction): void {
    if (this.poolAccountStream == null || this.pumpStateCache == null) return;
    if (tx.protocolHint !== "PUMPSWAP") return;
    const mintStr =
      tx.type === "BUY" ? tx.tokenOut : tx.type === "SELL" ? tx.tokenIn : null;
    if (mintStr == null || mintStr === SOL_MINT) return;
    if (this.speculativeSubscribeSeen.has(mintStr)) return;
    this.speculativeSubscribeSeen.add(mintStr);

    const mint = this.pubkeyForMint(mintStr);
    const poolPubkey = canonicalPumpPoolPda(mint);
    const stream = this.poolAccountStream;
    const cache = this.pumpStateCache;

    const cachedProgram = cache.getTokenProgramSync(mint);
    if (cachedProgram != null) {
      stream.registerPool(mint, cachedProgram, poolPubkey);
      return;
    }

    // Token program unknown — resolve async via `getAccountInfo(mint)` then
    // subscribe. Cached result benefits every future decode + swap for this
    // mint. Errors are non-fatal: on RPC miss we simply skip the speculative
    // warmup and the normal swap path will resolve tokenProgram itself.
    void cache
      .getTokenProgram(mint)
      .then((program) => {
        stream.registerPool(mint, program, poolPubkey);
      })
      .catch(() => {
        this.speculativeSubscribeSeen.delete(mintStr);
      });
  }

  /**
   * R12+R19: Speculative pre-build — called when a whale BUY is decoded
   * (before signal processor validates). Starts a Jupiter build and stores
   * the inflight Promise. When the engine handler runs ~5ms later, it awaits
   * the SAME Promise instead of starting a duplicate Jupiter call.
   */
  speculativeQuoteForBuy(tx: RawWhaleTransaction): void {
    if (tx.type !== "BUY") {
      return;
    }
    const outputMint = tx.tokenOut;
    if (this.buyLamportsString() === "0") {
      return;
    }

    // Phase B: skip Jupiter prebuild for pump protocols entirely. Direct-pump
    // executor handles PUMPFUN/PUMPSWAP in <100ms via the pump SDK; firing
    // Jupiter here wastes an API call that often returns NO_ROUTES_FOUND for
    // fresh pump tokens and makes the handler wait for a round-trip that will
    // be timed out anyway. The engine's buildAndExecute routes direct-pump as
    // long as the circuit breaker hasn't disabled it (30% revert threshold).
    if (tx.protocolHint === "PUMPFUN" || tx.protocolHint === "PUMPSWAP") {
      return;
    }

    // Rebuy ladder: predict N = current buyCount + 1 so the speculative
    // build uses the SAME size the processor will set post-increment.
    // Cache key is amount-agnostic (buy:<token>) — but the prebuilt tx
    // itself is fixed to the size we send here. Mismatch = effective
    // cache miss + wasted Jupiter call. getBuyCountFn returns 0 when
    // wired source (processor) has no prior position for this token.
    const predictedBuyCount = this.getBuyCountFn(outputMint) + 1;
    const predictedSize = this.computeBuySize(predictedBuyCount);

    const intent: ExecutionIntent = {
      token: outputMint,
      side: "BUY",
      protocolHint: tx.protocolHint,
      size: predictedSize,
      delayMs: 0,
      whaleWallet: tx.wallet,
      signalTimestamp: tx.timestamp,
    };

    prebuildCache.startBuild(buyCacheKey(outputMint), () =>
      this.executionEngine.jupiter.buildSwapTransactionWithQuote(
        intent,
        this.executionEngine.getTakerAddress(),
      ),
    );
  }

  /**
   * Phase 4: Speculative pre-build for SELL. Called when a whale SELL is decoded
   * (before signal processor validates). Reads bot token balance, computes the
   * proportional sell amount, and fires a Jupiter build so the engine's retry
   * loop attempt #1 gets the prebuilt tx from cache instead of round-tripping.
   */
  speculativeQuoteForSell(tx: RawWhaleTransaction): void {
    if (tx.type !== "SELL") {
      return;
    }

    const tokenMint = tx.tokenIn;
    if (!tokenMint || tokenMint === SOL_MINT) {
      return;
    }

    // Phase 2 + position-lock: skip speculative Jupiter call when the SELL
    // whale is NOT the owner of this token's cycle. Processor would filter
    // the signal anyway; avoid the wasted quote.
    if (!this.shouldAttemptSell(tokenMint, tx.wallet)) {
      return;
    }

    // Phase B: skip Jupiter prebuild for pump protocols — direct-pump executor
    // handles PUMPFUN/PUMPSWAP SELL faster than a Jupiter round trip, and
    // Jupiter v1 often returns NO_ROUTES_FOUND on fresh pump tokens.
    if (tx.protocolHint === "PUMPFUN" || tx.protocolHint === "PUMPSWAP") {
      return;
    }

    const sellFraction = this.config.trading.followWhaleSell
      ? tx.whaleSellFraction
      : undefined;

    // Phase 4: try sync balance read first so startBuild fires BEFORE the
    // handler reaches take() — makes inflight coalescing reliable. If the
    // wallet cache is cold, fall through to async path below.
    const pubkey = this.pubkeyForMint(tokenMint);
    const syncBalance = this.walletStateCache.getTokenRawForMintSync(pubkey);
    if (syncBalance !== undefined) {
      if (syncBalance == null || syncBalance === "0") {
        return;
      }
      const sellTokenAmountRaw = applySellFraction(syncBalance, sellFraction);
      if (sellTokenAmountRaw === "0") {
        return;
      }
      this.fireSpeculativeSellPrebuild({
        tokenMint,
        sellTokenAmountRaw,
        sellFraction,
        protocolHint: tx.protocolHint,
        whaleWallet: tx.wallet,
        signalTimestamp: tx.timestamp,
      });
      return;
    }

    void (async () => {
      let balanceRaw: string | null;
      try {
        balanceRaw = await this.walletStateCache.getTokenRawForMint(pubkey);
      } catch {
        return;
      }
      if (balanceRaw == null || balanceRaw === "0") {
        return;
      }

      const sellTokenAmountRaw = applySellFraction(balanceRaw, sellFraction);
      if (sellTokenAmountRaw === "0") {
        return;
      }

      this.fireSpeculativeSellPrebuild({
        tokenMint,
        sellTokenAmountRaw,
        sellFraction,
        protocolHint: tx.protocolHint,
        whaleWallet: tx.wallet,
        signalTimestamp: tx.timestamp,
      });
    })();
  }

  /**
   * Phase 4: shared prebuild launcher — used by speculativeQuoteForSell
   * (sync + async paths) and by prewarmSellCacheForToken. Centralizes the
   * intent construction and startBuild call.
   */
  private fireSpeculativeSellPrebuild(args: {
    tokenMint: string;
    sellTokenAmountRaw: string;
    sellFraction?: number;
    protocolHint?: ProtocolHint;
    whaleWallet: string;
    signalTimestamp: number;
  }): void {
    const intent: ExecutionIntent = {
      token: args.tokenMint,
      side: "SELL",
      protocolHint: args.protocolHint,
      size: 0,
      sellFraction: args.sellFraction,
      delayMs: 0,
      whaleWallet: args.whaleWallet,
      signalTimestamp: args.signalTimestamp,
      sellTokenAmountRaw: args.sellTokenAmountRaw,
    };

    prebuildCache.startBuild(
      sellCacheKey(args.tokenMint, args.sellTokenAmountRaw),
      () =>
        this.executionEngine.jupiter.buildSwapTransactionWithQuote(
          intent,
          this.executionEngine.getTakerAddress(),
        ),
    );
  }

  private buyLamportsString(): string {
    const sol = this.config.trading.fixedBuyAmountSol;
    if (!Number.isFinite(sol) || sol <= 0) {
      return "0";
    }
    return String(Math.floor(sol * 1_000_000_000));
  }

  /** Direct hot-path entry — called by processor, avoids EventEmitter overhead. */
  handleSignal(signal: TradeSignal): void {
    const sem =
      signal.action === "BUY" ? this.buySemaphore : this.sellSemaphore;
    void this.executeSignal(signal, sem);
  }

  private async executeSignal(
    signal: TradeSignal,
    sem: AsyncSemaphore,
  ): Promise<void> {
    await sem.acquire();
    runtimeMetrics.activeSwaps++;
    const handlerStartedAtMs = Date.now();
    const { trading: t } = this.config;
    // Use the rebuy-ladder-aware size computed by processor.onSignalAcceptedInternal.
    // Fallback to fixedBuyAmountSol for SELL (legSizeSol set equally but not
    // relevant there — size ends up from sellTokenAmountRaw on-chain balance).
    const sizeSol = signal.legSizeSol ?? t.fixedBuyAmountSol;

    try {
      if (signal.action === "BUY") {
        const intent: ExecutionIntent = {
          ...baseIntent(
            signal,
            sizeSol,
            handlerStartedAtMs,
            t.followWhaleSell,
            this.effectiveSlippageBps(signal.whaleWallet),
          ),
          delayMs: t.delayMs,
        };

        const raw = await this.buildAndExecute(intent);
        this.updateWsolTracker(intent, raw);
        if (raw.status !== "failed") {
          // SOL spent + new token balance — cached values are stale.
          this.walletStateCache.invalidateSol();
          this.walletStateCache.invalidateToken(
            this.pubkeyForMint(signal.token),
          );
        }
        const result = attachPipelineMetrics(raw, signal, handlerStartedAtMs);
        bus.emitAsync("exec:result", result);
        return;
      }

      // SELL path: fetch balance only. Jupiter quote is seeded earlier by
      // speculativeQuoteForSell on the prebuild cache, so a parallel quote here
      // is wasted RPC + Jupiter quota.
      const tokenMint = this.pubkeyForMint(signal.token);
      const sellTokenAmountRaw =
        await this.walletStateCache.getTokenRawForMint(tokenMint);

      if (sellTokenAmountRaw == null) {
        bus.emitAsync("exec:result", {
          signature: "",
          status: "failed",
          error: "no token balance to sell",
          whaleWallet: signal.whaleWallet,
          token: signal.token,
          side: signal.action,
          sizeSol: 0,
          ...pipelineMetricsFooter(signal, handlerStartedAtMs),
        });
        return;
      }

      const intent: ExecutionIntent = {
        ...baseIntent(
          signal,
          sizeSol,
          handlerStartedAtMs,
          t.followWhaleSell,
          this.effectiveSlippageBps(signal.whaleWallet),
        ),
        delayMs: t.delayMs,
        sellTokenAmountRaw,
      };

      const raw = await this.runSellWithRetrySequential(intent);
      this.updateWsolTracker(intent, raw);
      if (raw.status !== "failed") {
        // SOL gained + token balance reduced — cached values are stale.
        this.walletStateCache.invalidateSol();
        this.walletStateCache.invalidateToken(tokenMint);
      }
      const result = attachPipelineMetrics(raw, signal, handlerStartedAtMs);
      bus.emitAsync("exec:result", result);

      // Phase 2: if a base attempt was submitted, schedule background drain
      // so the pipeline returns immediately while recovery retries continue
      // asynchronously when a previous tx reverts on-chain or only partially
      // drains the position.
      if (raw.status !== "failed") {
        const attemptsUsed = raw.sellRetry?.attempted ?? 1;
        this.scheduleSellDrainInBackground(intent, attemptsUsed);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const failed = attachPipelineMetrics(
        {
          signature: "",
          status: "failed" as const,
          error: message,
          whaleWallet: signal.whaleWallet,
          token: signal.token,
          side: signal.action,
          sizeSol: signal.action === "BUY" ? sizeSol : 0,
        },
        signal,
        handlerStartedAtMs,
      );
      bus.emitAsync("exec:result", failed);
      console.error("[engine] execution failed:", message);
    } finally {
      runtimeMetrics.activeSwaps--;
      sem.release();
    }
  }
}

export const createExecutionStack = (
  config: AppConfig,
): {
  connection: Connection;
  jupiter: JupiterClient;
  execution: ExecutionEngine;
  copy: CopyTradingEngine;
  blockhashCache: BlockhashCache;
  pumpStateCache: PumpStateCache;
  poolAccountStream: PoolAccountStream;
  wsolTracker?: PersistentWsolTracker;
  walletStateCache: WalletStateCache;
} => {
  const connection = new Connection(
    config.helius.rpcUrl,
    config.helius.rpcCommitment,
  );
  const blockhashCache = new BlockhashCache(
    connection,
    config.helius.rpcCommitment as Commitment,
  );
  const jupiter = new JupiterClient(config, connection);
  jupiter.setBlockhashCache(blockhashCache);
  let wsolTopUp: WsolTopUpManager | undefined;
  if (
    config.trading.persistentWsol &&
    config.trading.startupPrewrapWsol.enabled
  ) {
    wsolTopUp = new WsolTopUpManager(connection, config);
    jupiter.setWsolTopUpManager(wsolTopUp);
  }
  setDirectPumpBlockhashCache(blockhashCache);
  const pumpStateCache = new PumpStateCache(
    connection,
    config.helius.rpcCommitment as Commitment,
  );
  setSharedPumpStateCache(pumpStateCache);

  // gRPC pool account stream: push-caches pump-swap pool + its two ATAs so the
  // hot swap path can skip the ~30-45ms `getMultipleAccountsInfo` round trip.
  // Dynamic subscription set — pools are registered when first RPC-fetched
  // (see PumpStateCache.fetchPumpSwapState). `.start()` is called after wire()
  // completes; existing reconnect logic handles stream failures independently
  // from the whale tx stream.
  const poolAccountStream = new PoolAccountStream({
    endpoint: config.helius.laserstreamEndpoint,
    apiKey: config.helius.apiKey,
    commitment: config.helius.laserstreamCommitment,
    debug: config.debug.whalePipeline,
  });
  pumpStateCache.setPoolStream(poolAccountStream);

  // Dynamic priority fee via Helius `getPriorityFeeEstimate`. Refreshes every
  // 2s in the background; hot swap path reads the cached value with 0ms cost.
  // The two pump program ids are the hint accounts — the estimator looks at
  // recent priority-fee percentiles for txs touching these programs. Fallback
  // 100_000 µLamports matches the previous hardcoded value so we never lose
  // the priority cushion on cache miss or RPC failure.
  const priorityFeeCache = new PriorityFeeCache(
    config.helius.rpcUrl,
    [
      "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // Pump.fun bonding curve
      "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // Pump AMM v2 (pump-swap)
    ],
    100_000,
    2_000,
    1_000,
    500_000,
    config.debug.whalePipeline,
  );
  setDirectPumpPriorityFeeCache(priorityFeeCache);

  const execution = new ExecutionEngine(config, connection, jupiter);

  // Tracker wired after execution so the taker pubkey is available without
  // constructing the Keypair twice. Tracker initialization (on-chain read)
  // is deferred to main.ts — called after prewrap lands so balance reflects
  // the wrapped state, not the pre-wrap state.
  let wsolTracker: PersistentWsolTracker | undefined;
  if (config.trading.persistentWsol) {
    wsolTracker = new PersistentWsolTracker(
      connection,
      execution.getTakerPublicKey(),
      config.helius.rpcCommitment as Commitment,
      {
        topUp: wsolTopUp,
        debug: config.debug.whalePipeline,
      },
    );
    jupiter.setWsolTracker(wsolTracker);
  }

  // Wire direct-pump persistent-WSOL handling with a target-aware predicate.
  // Returns true (= keep WSOL) only while current balance is below the
  // configured target; once at/above target, we fall through to the SDK's
  // closeAccount path so SELL output unwraps back to native SOL and WSOL
  // balance does not accumulate past target.
  const targetLamports = BigInt(
    Math.floor(
      (config.trading.startupPrewrapWsol.targetSol || 0) * 1_000_000_000,
    ),
  );
  setDirectPumpPersistentWsol(config.trading.persistentWsol, () => {
    if (targetLamports <= 0n) return true;
    const current = wsolTracker?.getBalanceLamports() ?? 0n;
    return current < targetLamports;
  });

  // Separate semaphores: BUY gets more slots so it never queues behind slow SELL retries.
  const maxSwaps = config.runtime.maxConcurrentSwaps;
  const buySemaphore = new AsyncSemaphore(Math.max(1, maxSwaps));
  const sellSemaphore = new AsyncSemaphore(
    Math.max(1, Math.ceil(maxSwaps / 2)),
  );

  const walletStateCache = new WalletStateCache(
    connection,
    execution.getTakerPublicKey(),
    config.helius.rpcCommitment,
    config.perf.walletStateCacheTtlMs,
  );
  const copy = new CopyTradingEngine(
    config,
    execution,
    buySemaphore,
    sellSemaphore,
    walletStateCache,
    wsolTracker,
  );
  copy.setPoolAccountStream(poolAccountStream, pumpStateCache);
  return {
    connection,
    jupiter,
    execution,
    copy,
    blockhashCache,
    pumpStateCache,
    poolAccountStream,
    wsolTracker,
    walletStateCache,
  };
};
