export type TradeAction = "BUY" | "SELL";
/**
 * `grpc-pp` = Helius Laserstream preprocessed (decoded from shreds, no meta).
 * `grpc`    = Yellowstone-compatible standard tx stream (kept for legacy WSS path that hydrates via RPC).
 * `wss`     = Helius WebSocket transactionSubscribe / logsSubscribe.
 */
export type WhaleFeedSource = "grpc" | "grpc-pp" | "wss";
export type ExecutionStatus = "confirmed" | "submitted" | "failed";
export type ProtocolHint =
  | "METEORA"
  | "PUMPFUN"
  | "PUMPSWAP"
  | "RAYDIUM"
  | "LAUNCHLAB"
  | "UNKNOWN";

export interface RawWhaleTransaction {
  wallet: string;
  type: TradeAction;
  protocolHint: ProtocolHint;
  tokenIn: string;
  tokenOut: string;
  amount: number;
  /** SELL only: porsi token whale yang dijual pada tx ini (0..1). */
  whaleSellFraction?: number;
  feedSource: WhaleFeedSource;
  ingestedAtMs: number;
  signature: string;
  timestamp: number;
  /** Waktu masuk pipeline (setelah decode) — ms since epoch */
  detectedAtMs: number;
}

export interface TradeSignal {
  action: TradeAction;
  protocolHint: ProtocolHint;
  token: string;
  amount: number;
  /** SELL only: porsi token whale yang dijual pada tx ini (0..1). */
  whaleSellFraction?: number;
  confidence: number;
  feedSource: WhaleFeedSource;
  ingestedAtMs: number;
  /** Ukuran per leg (SOL) untuk downstream — biasanya = FIXED_BUY_AMOUNT_SOL */
  legSizeSol: number;
  whaleWallet: string;
  /** Signature tx whale di chain (dedup / audit trail). */
  whaleTxSignature: string;
  timestamp: number;
  detectedAtMs: number;
  signalEmittedAtMs: number;
}

export interface ExecutionIntent {
  token: string;
  side: TradeAction;
  protocolHint?: ProtocolHint;
  size: number;
  /** SELL only: porsi token bot yang akan dijual (mengikuti whale). */
  sellFraction?: number;
  /** true = paksa tunggu confirm (abaikan fast-ack global). */
  forceSyncConfirm?: boolean;
  /** true = paksa ambil quote fresh (skip cache) untuk attempt sensitif slippage. */
  bypassQuoteCache?: boolean;
  delayMs: number;
  whaleWallet: string;
  signalTimestamp: number;
  detectedAtMs?: number;
  signalEmittedAtMs?: number;
  handlerStartedAtMs?: number;
  /**
   * SELL only: Jupiter `amount` = smallest units of the input mint (the SPL token), not lamports.
   * Set from the bot wallet's on-chain balance for that mint.
   */
  sellTokenAmountRaw?: string;
  /**
   * Per-whale slippage override (bps). When set, direct-pump executor and
   * Jupiter quote/order use this instead of `config.trading.slippageBps`.
   * Resolved by the engine from `trading.whaleSlippageBps[whaleWallet]`.
   */
  slippageBpsOverride?: number;
}

export interface ExecutionStageMetrics {
  quoteBuildMs?: number;
  delayMs?: number;
  deserializeMs?: number;
  tipInjectMs?: number;
  tipLamports?: number;
  signMs?: number;
  serializeMs?: number;
  sendMs?: number;
  confirmMs?: number;
}

export interface SellRetryMetrics {
  mode?: "parallel" | "sequential";
  maxAttempts?: number;
  attempted?: number;
  winnerAttempt?: number;
}

export interface ExecutionResult {
  signature: string;
  status: ExecutionStatus;
  /** Commitment yang dipakai untuk `confirmTransaction` */
  landedCommitment?: "processed" | "confirmed" | "finalized";
  error?: string;
  whaleWallet?: string;
  token?: string;
  side?: TradeAction;
  feedSource?: WhaleFeedSource;
  sizeSol?: number;
  /** Build swap + sign + send + confirm (ms) */
  latencyMs?: number;
  executionStageMs?: ExecutionStageMetrics;
  sellRetry?: SellRetryMetrics;
  /** signal:trade → handler copy engine (ms) */
  signalQueueMs?: number;
  /** detectedAtMs → sekarang (ms) */
  pipelineTotalMs?: number;
  ingestToDetectMs?: number;
  ingestToSignalMs?: number;
  ingestTotalMs?: number;
  quotePriceImpactPct?: number;
  senderMode?: "rpc" | "helius" | "jito";
  /** Lamports (atau unit terkecil mint input) — dari Jupiter; bisa number dari JSON. */
  inAmountRaw?: string | number;
  outAmountRaw?: string | number;
}

export interface AppConfig {
  botPrivateKey: string;
  whaleWallets: string[];
  helius: {
    /** Transport listener whale feed (strict, no fallback). */
    feedMode: "grpc" | "wss";
    apiKey: string;
    /** WebSocket RPC URL (transactionSubscribe/logsSubscribe fallback). Required when `feedMode` = `wss`. */
    wssUrl: string;
    /** WSS logsSubscribe commitment (processed lebih cepat, confirmed/finalized lebih stabil). */
    wssCommitment: "processed" | "confirmed" | "finalized";
    /** Helius Laserstream gRPC base URL. Required when `feedMode` = `grpc`. */
    laserstreamEndpoint: string;
    rpcUrl: string;
    /** Default commitment untuk `Connection` (processed = latency baca lebih rendah) */
    rpcCommitment: "processed" | "confirmed" | "finalized";
    tipEndpoints: string[];
    tipAccounts: string[];
    /** Laserstream subscribe tx commitment (processed = sinyal lebih awal dari confirmed) */
    laserstreamCommitment: "processed" | "confirmed" | "finalized";
  };
  jupiter: {
    /** v2: `.../swap/v2` + `GET .../order`. v1/lite: `.../swap/v1` + `GET /quote` + `POST /swap`. */
    swapApiBase: string;
    integrationMode: "auto" | "metis_instructions" | "order_v2";
    /** Daftar `x-api-key` Jupiter. Diround-robin per request untuk bantu mitigasi rate limit. */
    apiKeys: string[];
    /** Q1.1: enable RTSE — Jupiter picks slippage per-route based on volatility. */
    dynamicSlippage: boolean;
    /** Cap for RTSE when enabled. Ignored if dynamicSlippage=false. */
    dynamicSlippageMaxBps: number;
    /** When true, sends `dynamicComputeUnitLimit: true` ke Jupiter /swap body.
     *  Jupiter akan simulate tx untuk ukur CU — menambah ~150-250ms response
     *  time. false = pakai default Jupiter (lebih cepat). */
    dynamicCuLimit: boolean;
    /** Q1.2: route complexity cap. 0 = disabled (Jupiter picks any). */
    maxAccounts: number;
    /** N1: restrict intermediate hops to high-liquidity tokens. */
    restrictIntermediateTokens: boolean;
  };
  telegram: {
    enabled: boolean;
    botToken: string;
    chatId: string;
    timeoutMs: number;
    queueMax: number;
  };
  trading: {
    slippageBps: number;
    /** Per-whale slippage overrides (bps). Key = whale pubkey, value = bps.
     *  Empty object = all whales use default `slippageBps`. */
    whaleSlippageBps: Record<string, number>;
    fixedBuyAmountSol: number;
    /** 0 = off; only follow whale BUY if tx amount (SOL) >= this value */
    minWhaleBuyAmountSol: number;
    /** true = allow multiple re-buy entries up to `rebuyMaxCount` per token cycle. */
    rebuyEnabled: boolean;
    /** Max BUY entries for the same token in one cycle (reset when SELL signal for that token arrives). */
    rebuyMaxCount: number;
    /** Additive SOL step per rebuy. 0 = flat (use fixedBuyAmountSol every time). */
    rebuyAmountSize: number;
    /** true = SELL mengikuti proporsi whale (`whaleSellFraction`); false = SELL full 100%. */
    followWhaleSell: boolean;
    /** true = BUY pakai WSOL persist (tanpa wrap/unwrap per swap). */
    persistentWsol: boolean;
    /** true = tetap follow tx multi-leg jika net SOL↔token direction jelas. */
    allowMultiLegNetFollow: boolean;
    /** Maks rasio total leg SPL lain vs leg token utama agar masih dianggap aman di-follow. */
    maxOtherSplLegRatio: number;
    /** Auto pre-wrap SOL->WSOL di startup untuk mode persistent WSOL. */
    startupPrewrapWsol: {
      enabled: boolean;
      /** Target minimum saldo WSOL (SOL units). */
      targetSol: number;
      /** Simpan minimal SOL unwrapped untuk fee/tip/rent. */
      solReserveSol: number;
    };
    /** Auto-sell a position after this many ms since first BUY. 0 = disabled. */
    autoSellTtlMs: number;
    /** How often the auto-sell watcher scans positions for expiry. */
    autoSellCheckIntervalMs: number;
    /** true = rebuy from owner resets TTL clock; false = cumulative from first BUY. */
    autoSellResetOnRebuy: boolean;
    /** Per-token overrides (from configuration.json -> tokenOverrides). */
    tokenOverrides: Record<string, { autoSellTtlMs?: number }>;
    /** File path for persisted position state (auto-restored on restart). */
    positionStateFile: string;
    /** How often to flush pending position state to disk. */
    positionStateSaveIntervalMs: number;
    delayMs: number;
  };
  perf: {
    quoteCacheTtlMs: number;
    /** Log satu baris metrik latency ke console */
    logLatency: boolean;
    /** 0.0–1.0. Probabilitas sukses di-log. Failed selalu di-log. */
    logLatencySampleRate: number;
    /** Satu quote Jupiter kecil saat startup (TLS + route cache) */
    jupiterWarm: boolean;
    /** N8: ALT addresses to pre-resolve at startup (empty = skip). */
    prewarmAltAddresses: string[];
    /** TTL cache saldo SOL + token bot untuk hot path (ms) */
    walletStateCacheTtlMs: number;
    /** Option A: max wait for Jupiter prebuild on PUMP protocols before
     *  falling through to direct-pump. 0 = disabled. */
    pumpPrebuildTimeoutMs: number;
  };
  /** Eksekusi on-chain (Fase 3) */
  execution: {
    /** commitment untuk `confirmTransaction` — `processed` lebih cepat, `confirmed` lebih aman */
    confirmCommitment: "processed" | "confirmed" | "finalized";
    /** Kirim via Helius Sender (JSON-RPC) alih-alih `Connection.sendRawTransaction` */
    useHeliusSender: boolean;
    senderMode: "rpc" | "helius" | "jito";
    /** Override URL Sender; kosong = pakai entry pertama `HELIUS_TIP_ENDPOINTS` */
    senderEndpoint: string | null;
    jitoSenderUrl: string | null;
    /** Override daftar tip account khusus mode Jito (comma-separated env). */
    jitoTipAccounts: string[];
    /** N4: when true, race Helius + Jito + all RPCs in parallel on every send. */
    multiSenderRace: boolean;
    /** N4: extra RPC URLs (from configuration.json->rpcUrls) for send race. */
    extraSendRpcUrls: string[];
    /** Level 2: background healthcheck auto-excludes slow paths from race. */
    rpcHealthCheck: {
      enabled: boolean;
      probeIntervalMs: number;
      latencyThresholdMs: number;
      probeTimeoutMs: number;
    };
    /** Jupiter /order query: `auto` | lamports (angka). Kosong = biarkan Jupiter set fee. */
    /** Transfer SOL ke wallet tip Helius (wajib ≥200k lamports) sebelum kirim ke Sender */
    tipEnabled: boolean;
    /** True = BUY errors throw immediately; no fallback. Preserves SELL fallback. */
    buyNoFallback: boolean;
    /** Fixed tip per side (lamports). Floor 200000 enforced (Helius Sender min). */
    tipLamportsBuy: number;
    tipLamportsSell: number;
    fastAck: boolean;
  };
  /** Operasional: konkurensi & dedup (Fase 4) */
  runtime: {
    maxConcurrentSwaps: number;
    /** 0 = mati; window dedup berdasarkan signature tx whale */
    dedupWhaleTxMs: number;
  };
  /** Logging pipeline whale → signal (set WHALE_DEBUG=true) */
  debug: {
    whalePipeline: boolean;
    /** Dump whale trades with protocolHint=UNKNOWN to logs/protocol_unknown.jsonl */
    unknownProtocolLog: boolean;
  };
  /** Phase 6: metrics endpoint + SLA alert configuration */
  observability: {
    /** Prometheus /metrics HTTP port. 0 = disabled. */
    metricsPort: number;
    /** Dashboard control API port. 0 = disabled. */
    controlApiPort: number;
    controlApiBind: string;
    controlApiToken: string;
    slaAlert: {
      enabled: boolean;
      buyP95Ms: number;
      sellP95Ms: number;
      windowMs: number;
      checkIntervalMs: number;
      alertCooldownMs: number;
      minSamples: number;
    };
  };
}
