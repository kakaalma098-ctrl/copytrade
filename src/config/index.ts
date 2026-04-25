import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "../types/index.js";

const csvToArray = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const sanitizeArray = (values: string[]): string[] =>
  Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));

/**
 * N5: resolve Helius Sender URL with optional regional pinning. Explicit
 * HELIUS_SENDER_URL wins. Otherwise, if a region is set, pin to
 * `${region}-sender.helius-rpc.com/fast` so the bot bypasses Helius's
 * auto-routing DNS (saves 10-30ms per send when VPS region is known).
 * Empty region = leave null and use the existing fallback chain at send time.
 */
const resolveHeliusSenderEndpoint = (
  override: string | undefined,
  region: "" | "sgp" | "fra" | "ams" | "slc" | "ewr" | "tyo",
): string | null => {
  const trimmed = override?.trim();
  if (trimmed) {
    return trimmed;
  }
  if (region !== "") {
    return `https://${region}-sender.helius-rpc.com/fast`;
  }
  return null;
};

const tokenOverrideSchema = z.object({
  /** Per-token auto-sell TTL (ms). 0 disables TTL for this token. */
  autoSellTtlMs: z.number().int().nonnegative().optional(),
});

const externalConfigSchema = z.object({
  whaleWallets: z.array(z.string()).optional(),
  jupiterApiKeys: z.array(z.string()).optional(),
  jupiter: z
    .object({
      apiKeys: z.array(z.string()).optional(),
    })
    .optional(),
  /** N4: extra RPC URLs raced in parallel with Helius/Jito senders for
   *  minimum-latency tx landing. Each URL becomes an independent Connection
   *  used for send-only operations — reads still use HELIUS_RPC_URL. */
  rpcUrls: z.array(z.string()).optional(),
  /** Per-whale slippage bps overrides. Key = whale pubkey, value = bps.
   *  Whales not listed use global SLIPPAGE_BPS. Useful for volatile whales
   *  (PUMPSWAP scalpers) that need looser slippage vs steady aggregator whales. */
  whaleSlippageBps: z
    .record(z.string(), z.number().int().nonnegative())
    .optional(),
  tokenOverrides: z.record(z.string(), tokenOverrideSchema).optional(),
});

export type TokenOverrides = Record<string, { autoSellTtlMs?: number }>;

type ExternalConfig = {
  whaleWallets: string[];
  jupiterApiKeys: string[];
  rpcUrls: string[];
  whaleSlippageBps: Record<string, number>;
  tokenOverrides: TokenOverrides;
};

const readExternalConfig = (): ExternalConfig => {
  const filePath = path.resolve(process.cwd(), "configuration.json");
  if (!existsSync(filePath)) {
    return {
      whaleWallets: [],
      jupiterApiKeys: [],
      rpcUrls: [],
      whaleSlippageBps: {},
      tokenOverrides: {},
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse configuration.json: ${msg}`);
  }

  const result = externalConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Invalid configuration.json: ${detail}`);
  }

  const data = result.data;
  const tokenOverrides: TokenOverrides = {};
  for (const [token, override] of Object.entries(data.tokenOverrides ?? {})) {
    const clean = token.trim();
    if (clean === "" || override == null) continue;
    tokenOverrides[clean] = {
      autoSellTtlMs:
        typeof override.autoSellTtlMs === "number"
          ? Math.max(0, Math.floor(override.autoSellTtlMs))
          : undefined,
    };
  }
  const whaleSlippageBps: Record<string, number> = {};
  for (const [whale, bps] of Object.entries(data.whaleSlippageBps ?? {})) {
    const clean = whale.trim();
    if (clean === "" || typeof bps !== "number" || bps < 0) {
      continue;
    }
    whaleSlippageBps[clean] = Math.floor(bps);
  }

  return {
    whaleWallets: sanitizeArray(data.whaleWallets ?? []),
    jupiterApiKeys: sanitizeArray([
      ...(data.jupiterApiKeys ?? []),
      ...(data.jupiter?.apiKeys ?? []),
    ]),
    rpcUrls: sanitizeArray(data.rpcUrls ?? []),
    whaleSlippageBps,
    tokenOverrides,
  };
};

const envTrue = (value: string | undefined): boolean =>
  value?.trim().toLowerCase() === "true";

const normalizeJupiterSwapApiBase = (value: string): string => {
  const trimmed = value.trim().replace(/\/$/, "");
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(
      /(\/swap\/v[12])\/(order|quote|swap|build|execute|swap-instructions)$/i,
      "$1",
    );
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
};

const rawSchema = z.object({
  BOT_PRIVATE_KEY: z.string().min(1),
  WHALE_WALLETS: z.string().optional(),
  HELIUS_LASER_GRPC: z.string().default("false"),
  HELIUS_WSS: z.string().default("false"),
  HELIUS_API_KEY: z.string().optional(),
  HELIUS_WSS_URL: z.string().optional(),
  HELIUS_LASERSTREAM_ENDPOINT: z.string().optional(),
  /** Optional — prefer populating `rpcUrls` in configuration.json instead.
   *  When both are set, `rpcUrls[0]` from configuration.json wins. Kept for
   *  backward compat with single-RPC setups. */
  HELIUS_RPC_URL: z.string().url().optional(),
  HELIUS_TIP_ENDPOINTS: z
    .string()
    .default("https://sender.helius-rpc.com/fast"),
  HELIUS_TIP_ACCOUNTS: z.string().optional(),
  JITO_TIP_ACCOUNTS: z.string().optional(),
  /** processed = sinyal whale paling cepat; confirmed = lebih aman */
  HELIUS_LASERSTREAM_COMMITMENT: z
    .enum(["processed", "confirmed", "finalized"])
    .default("processed"),
  HELIUS_WSS_COMMITMENT: z
    .enum(["processed", "confirmed", "finalized"])
    .default("confirmed"),
  /** Connection() + RPC reads — processed untuk latency */
  HELIUS_RPC_COMMITMENT: z
    .enum(["processed", "confirmed", "finalized"])
    .default("processed"),
  JUPITER_SWAP_API_BASE: z
    .string()
    .url()
    .default("https://lite-api.jup.ag/swap/v1"),
  JUPITER_INTEGRATION_MODE: z
    .enum(["auto", "metis_instructions", "order_v2"])
    .default("auto"),
  /** Q1.1: enable Jupiter RTSE (dynamicSlippage). Floor = SLIPPAGE_BPS, cap
   *  defined by JUPITER_DYNAMIC_SLIPPAGE_MAX_BPS. Set false to rollback to
   *  fixed-slippage behaviour without a rebuild. */
  JUPITER_DYNAMIC_SLIPPAGE: z.string().default("true"),
  JUPITER_DYNAMIC_SLIPPAGE_MAX_BPS: z.string().default("300"),
  /** Send `dynamicComputeUnitLimit: true` ke Jupiter swap body. true = Jupiter
   *  simulate tx untuk ukur CU (menambah ~150-250ms response). false = pakai
   *  CU default Jupiter (lebih cepat, kadang butuh buffer CU lokal). */
  JUPITER_DYNAMIC_CU_LIMIT: z.string().default("false"),
  /** Q1.2: cap route complexity to prevent oversized-tx reject. Set 0 to
   *  disable (let Jupiter pick unlimited-account routes). Recommended: 32-40. */
  JUPITER_MAX_ACCOUNTS: z.string().default("32"),
  /** N1: restrict intermediate hops to high-liquidity tokens. Saves 20-50ms
   *  on quote computation + produces smaller transactions (faster landing).
   *  Default on — set "false" to allow exotic routes (rarely profitable for
   *  copytrading entries). */
  JUPITER_RESTRICT_INTERMEDIATE_TOKENS: z.string().default("true"),
  /** Phase B / Option A: maximum wait (ms) for the Jupiter prebuild cache on
   *  PUMPFUN/PUMPSWAP protocols before falling through to the direct-pump
   *  executor. Jupiter API round-trip from SGP is ~200-500ms; direct-pump SDK
   *  typically builds in <50ms. Lower value = more direct-pump usage (faster
   *  but slightly higher revert risk — the existing circuit breaker at 30%
   *  revert rate still protects). 0 = disable timeout (always wait Jupiter). */
  PUMP_PREBUILD_TIMEOUT_MS: z.string().default("100"),
  JUPITER_API_KEY: z.string().optional(),
  TELEGRAM_ENABLED: z.string().default("false"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_TIMEOUT_MS: z.string().default("2000"),
  TELEGRAM_QUEUE_MAX: z.string().default("200"),
  SLIPPAGE_BPS: z.string().default("50"),
  FIXED_BUY_AMOUNT_SOL: z.string().default("0.35"),
  MIN_WHALE_BUY_AMOUNT_SOL: z.string().default("0"),
  REBUY_ENABLED: z.string().default("true"),
  REBUY_MAX_COUNT: z.string().default("9999"),
  /** Additive increment in SOL per rebuy. 0 = disabled (flat size each BUY).
   *  Example: FIXED=0.15 + SIZE=0.05 → 0.15 / 0.20 / 0.25 / 0.30 ... */
  REBUY_AMOUNT_SIZE: z.string().default("0"),
  FOLLOW_WHALE_SELL: z.string().default("true"),
  ALLOW_MULTI_LEG_NET_FOLLOW: z.string().default("true"),
  MAX_OTHER_SPL_LEG_RATIO: z.string().default("0.25"),
  TRADING_PERSISTENT_WSOL: z.string().default("false"),
  /** Auto-sell when a position has been held longer than this (ms).
   *  0 or negative = disabled. Default 2h covers offline-whale scenarios. */
  AUTO_SELL_TTL_MS: z.string().default("7200000"),
  AUTO_SELL_CHECK_INTERVAL_MS: z.string().default("60000"),
  /** If true, rebuy from the owner whale resets the TTL clock. */
  AUTO_SELL_TTL_RESET_ON_REBUY: z.string().default("true"),
  /** File path for persisted position state. */
  POSITION_STATE_FILE: z.string().default("state/positions.json"),
  /** Safety-net periodic save interval. Debounced immediate save (500ms
   *  after any change) is the primary mechanism; this catches edge cases. */
  POSITION_STATE_SAVE_INTERVAL_MS: z.string().default("10000"),
  STARTUP_PREWRAP_WSOL: z.enum(["auto", "true", "false"]).default("auto"),
  STARTUP_PREWRAP_WSOL_TARGET_SOL: z.string().optional(),
  STARTUP_PREWRAP_SOL_RESERVE_SOL: z.string().default("0.05"),
  DELAY_MS: z.string().default("0"),
  QUOTE_CACHE_TTL_MS: z.string().default("2500"),
  /** TTL saldo SOL + posisi token per mint di hot path (copy SELL), ms */
  WALLET_STATE_CACHE_TTL_MS: z.string().default("280"),
  LATENCY_LOG: z.string().default("false"),
  /** 0.0–1.0. Probability a successful pipeline is logged. Failed results are always logged. */
  LATENCY_LOG_SAMPLE_RATE: z.string().default("1"),
  JUPITER_WARMUP: z.string().default("false"),
  /** N8: comma-separated ALT addresses to pre-resolve at startup. Populate
   *  with Jupiter's most-used routing ALTs so the first swap skips the
   *  getAddressLookupTable RPC round-trip (saves ~20-40ms per cold ALT). */
  JUPITER_PREWARM_ALTS: z.string().default(""),
  TX_CONFIRM_COMMITMENT: z
    .enum(["processed", "confirmed", "finalized"])
    .default("processed"),
  EXEC_USE_HELIUS_SENDER: z.string().default("false"),
  EXEC_SENDER_MODE: z.enum(["auto", "rpc", "helius", "jito"]).default("auto"),
  HELIUS_SENDER_URL: z.string().optional(),
  /** N5: regional Helius Sender pinning. When set, resolves to
   *  ${region}-sender.helius-rpc.com/fast. Skipped if HELIUS_SENDER_URL is set.
   *  Supported regions: sgp, fra, ams, slc, ewr, tyo. Empty = auto-route. */
  HELIUS_SENDER_REGION: z
    .enum(["", "sgp", "fra", "ams", "slc", "ewr", "tyo"])
    .default(""),
  JITO_SENDER_URL: z
    .string()
    .default("https://mainnet.block-engine.jito.wtf/api/v1/transactions"),
  /** N4: race Helius Sender + Jito Sender + all configured RPC endpoints in
   *  parallel. First fulfilled wins. Increases outbound RPC traffic ~3x but
   *  cuts tail latency + raises landing rate. Extra RPC URLs come from
   *  configuration.json -> rpcUrls. */
  EXECUTION_MULTI_SENDER_RACE: z.string().default("false"),
  /** Level 2: enable background RTT healthcheck. When on, any send endpoint
   *  exceeding the latency threshold is auto-excluded from the race until it
   *  recovers. Ignored when EXECUTION_MULTI_SENDER_RACE=false. */
  RPC_HEALTH_CHECK_ENABLED: z.string().default("true"),
  RPC_HEALTH_PROBE_INTERVAL_MS: z.string().default("10000"),
  RPC_HEALTH_LATENCY_THRESHOLD_MS: z.string().default("150"),
  RPC_HEALTH_PROBE_TIMEOUT_MS: z.string().default("3000"),
  EXEC_FAST_ACK: z.string().default("false"),
  EXEC_TIP_ENABLED: z.string().default("true"),
  /** When true, BUY errors abort immediately without falling back. Fallback
   *  paths (Jupiter v1 NO_ROUTES -> v2, direct-pump fail -> Jupiter, dex-pref
   *  fail -> no-dex retry) each add 200-500ms — during which price moves,
   *  causing the bot to enter at a much worse mcap than the whale. Missing
   *  an entry is cheaper than buying too late. SELL keeps all fallbacks so
   *  positions always get closed. */
  EXEC_BUY_NO_FALLBACK: z.string().default("false"),
  /** Tip ke salah satu HELIUS_TIP_ACCOUNTS (min 200000) — wajib untuk Helius Sender */
  EXEC_TIP_LAMPORTS_BUY: z.string().default("500000"),
  EXEC_TIP_LAMPORTS_SELL: z.string().default("800000"),
  MAX_CONCURRENT_SWAPS: z.string().default("2"),
  DEDUP_WHALE_TX_MS: z.string().default("0"),
  /** Log alur Laserstream → decode → signal (noise tinggi) */
  WHALE_DEBUG: z.string().default("false"),
  /** Dump whale trades with protocolHint=UNKNOWN to logs/protocol_unknown.jsonl for offline DEX discovery. */
  UNKNOWN_PROTOCOL_LOG: z.string().default("true"),
  /** Phase 6: Prometheus metrics server port. 0 = disabled. */
  METRICS_PORT: z.string().default("0"),
  /** Dashboard control API port. 0 = disabled. Bind to 127.0.0.1 by default. */
  CONTROL_API_PORT: z.string().default("9092"),
  CONTROL_API_BIND: z.string().default("127.0.0.1"),
  /** Optional shared-secret token. Clients send via x-auth-token header. */
  CONTROL_API_TOKEN: z.string().default(""),
  /** Phase 6: SLA-breach Telegram alert toggle. */
  SLA_ALERT_ENABLED: z.string().default("false"),
  SLA_BUY_P95_MS: z.string().default("80"),
  SLA_SELL_P95_MS: z.string().default("150"),
  SLA_WINDOW_MS: z.string().default("300000"),
  SLA_CHECK_INTERVAL_MS: z.string().default("60000"),
  SLA_ALERT_COOLDOWN_MS: z.string().default("600000"),
  SLA_MIN_SAMPLES: z.string().default("20"),
});

export const loadConfig = (): AppConfig => {
  const external = readExternalConfig();

  const env = rawSchema
    .superRefine((data, ctx) => {
      const whaleWallets =
        external.whaleWallets.length > 0
          ? external.whaleWallets
          : csvToArray(data.WHALE_WALLETS);
      if (whaleWallets.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Whale wallets empty. Set `whaleWallets` in configuration.json (recommended) or WHALE_WALLETS in .env",
          path: ["WHALE_WALLETS"],
        });
      }

      const grpcEnabled = envTrue(data.HELIUS_LASER_GRPC);
      const wssEnabled = envTrue(data.HELIUS_WSS);
      const ls = data.HELIUS_LASERSTREAM_ENDPOINT?.trim();
      const wss = data.HELIUS_WSS_URL?.trim();
      if (grpcEnabled === wssEnabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Set exactly one mode to true: HELIUS_LASER_GRPC=true XOR HELIUS_WSS=true (cannot both true/false)",
          path: ["HELIUS_LASER_GRPC"],
        });
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Set exactly one mode to true: HELIUS_LASER_GRPC=true XOR HELIUS_WSS=true (cannot both true/false)",
          path: ["HELIUS_WSS"],
        });
      }
      if (grpcEnabled) {
        if (!ls) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "HELIUS_LASERSTREAM_ENDPOINT is required when HELIUS_LASER_GRPC=true",
            path: ["HELIUS_LASERSTREAM_ENDPOINT"],
          });
        }
        try {
          if (ls) {
            new URL(ls);
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Invalid HELIUS_LASERSTREAM_ENDPOINT",
            path: ["HELIUS_LASERSTREAM_ENDPOINT"],
          });
        }
        if (!data.HELIUS_API_KEY?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "HELIUS_API_KEY is required for Laserstream gRPC (x-token)",
            path: ["HELIUS_API_KEY"],
          });
        }
      }
      if (wssEnabled) {
        if (!wss) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "HELIUS_WSS_URL is required when HELIUS_WSS=true",
            path: ["HELIUS_WSS_URL"],
          });
        }
        try {
          if (wss) {
            new URL(wss);
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Invalid HELIUS_WSS_URL",
            path: ["HELIUS_WSS_URL"],
          });
        }
      }

      // At least one RPC source must exist: either rpcUrls in configuration.json
      // or HELIUS_RPC_URL env fallback.
      if (external.rpcUrls.length === 0 && !data.HELIUS_RPC_URL?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "No RPC configured. Set `rpcUrls` in configuration.json (recommended, supports multi-RPC send race) or HELIUS_RPC_URL in .env",
          path: ["HELIUS_RPC_URL"],
        });
      }
      const jupBase = normalizeJupiterSwapApiBase(
        data.JUPITER_SWAP_API_BASE ?? "",
      );
      const jupiterApiKeys =
        external.jupiterApiKeys.length > 0
          ? external.jupiterApiKeys
          : sanitizeArray(csvToArray(data.JUPITER_API_KEY));
      try {
        const jupHost = new URL(jupBase).hostname;
        if (jupHost === "api.jup.ag" && jupiterApiKeys.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "At least one Jupiter API key is required for api.jup.ag. Set `jupiterApiKeys` in configuration.json (recommended) or JUPITER_API_KEY in .env",
            path: ["JUPITER_API_KEY"],
          });
        }
      } catch {
        /* z.string().url() already validated */
      }
    })
    .parse(process.env);

  const useGrpc = envTrue(env.HELIUS_LASER_GRPC);
  const useHeliusSenderLegacy = envTrue(env.EXEC_USE_HELIUS_SENDER);
  const senderMode =
    env.EXEC_SENDER_MODE === "auto"
      ? useHeliusSenderLegacy
        ? "helius"
        : "rpc"
      : env.EXEC_SENDER_MODE;
  const tipBuy = Math.max(
    200_000,
    Math.floor(Number(env.EXEC_TIP_LAMPORTS_BUY) || 500_000),
  );
  const tipSell = Math.max(
    200_000,
    Math.floor(Number(env.EXEC_TIP_LAMPORTS_SELL) || 800_000),
  );
  const persistentWsol = envTrue(env.TRADING_PERSISTENT_WSOL);
  const startupPrewrapEnabled =
    env.STARTUP_PREWRAP_WSOL === "auto"
      ? persistentWsol
      : env.STARTUP_PREWRAP_WSOL === "true";
  const startupPrewrapTargetRaw = Number(env.STARTUP_PREWRAP_WSOL_TARGET_SOL);
  const startupPrewrapTargetSol =
    Number.isFinite(startupPrewrapTargetRaw) && startupPrewrapTargetRaw > 0
      ? startupPrewrapTargetRaw
      : Math.max(0, Number(env.FIXED_BUY_AMOUNT_SOL) || 0);
  const startupPrewrapReserveSol = Math.max(
    0.01,
    Number(env.STARTUP_PREWRAP_SOL_RESERVE_SOL) || 0.05,
  );
  const whaleWallets =
    external.whaleWallets.length > 0
      ? external.whaleWallets
      : csvToArray(env.WHALE_WALLETS);
  const jupiterApiKeys =
    external.jupiterApiKeys.length > 0
      ? external.jupiterApiKeys
      : sanitizeArray(csvToArray(env.JUPITER_API_KEY));

  // Resolve the primary RPC: prefer configuration.json -> rpcUrls[0]; fall
  // back to HELIUS_RPC_URL env for backward compat. `execution.extraSendRpcUrls`
  // is everything AFTER the primary (used by N4 multi-sender race).
  const primaryRpc = external.rpcUrls[0] ?? env.HELIUS_RPC_URL ?? "";
  const extraSendRpcUrls =
    external.rpcUrls.length > 0 ? external.rpcUrls.slice(1) : [];

  return {
    botPrivateKey: env.BOT_PRIVATE_KEY,
    whaleWallets,
    helius: {
      feedMode: useGrpc ? "grpc" : "wss",
      apiKey: env.HELIUS_API_KEY ?? "",
      wssUrl: env.HELIUS_WSS_URL?.trim() ?? "",
      wssCommitment: env.HELIUS_WSS_COMMITMENT,
      laserstreamEndpoint: env.HELIUS_LASERSTREAM_ENDPOINT?.trim() ?? "",
      rpcUrl: primaryRpc,
      rpcCommitment: env.HELIUS_RPC_COMMITMENT,
      tipEndpoints: csvToArray(env.HELIUS_TIP_ENDPOINTS),
      tipAccounts: csvToArray(env.HELIUS_TIP_ACCOUNTS),
      laserstreamCommitment: env.HELIUS_LASERSTREAM_COMMITMENT,
    },
    jupiter: {
      swapApiBase: normalizeJupiterSwapApiBase(env.JUPITER_SWAP_API_BASE),
      integrationMode: env.JUPITER_INTEGRATION_MODE,
      apiKeys: jupiterApiKeys,
      dynamicSlippage: envTrue(env.JUPITER_DYNAMIC_SLIPPAGE),
      dynamicSlippageMaxBps: Math.max(
        50,
        Math.floor(Number(env.JUPITER_DYNAMIC_SLIPPAGE_MAX_BPS) || 300),
      ),
      dynamicCuLimit: envTrue(env.JUPITER_DYNAMIC_CU_LIMIT),
      maxAccounts: Math.max(
        0,
        Math.floor(Number(env.JUPITER_MAX_ACCOUNTS) || 0),
      ),
      restrictIntermediateTokens: envTrue(
        env.JUPITER_RESTRICT_INTERMEDIATE_TOKENS,
      ),
    },
    telegram: {
      enabled: envTrue(env.TELEGRAM_ENABLED),
      botToken: env.TELEGRAM_BOT_TOKEN ?? "",
      chatId: env.TELEGRAM_CHAT_ID ?? "",
      timeoutMs: Number(env.TELEGRAM_TIMEOUT_MS),
      queueMax: Number(env.TELEGRAM_QUEUE_MAX),
    },
    trading: {
      slippageBps: Number(env.SLIPPAGE_BPS),
      whaleSlippageBps: external.whaleSlippageBps,
      fixedBuyAmountSol: Number(env.FIXED_BUY_AMOUNT_SOL),
      minWhaleBuyAmountSol: Math.max(
        0,
        Number(env.MIN_WHALE_BUY_AMOUNT_SOL) || 0,
      ),
      rebuyEnabled: envTrue(env.REBUY_ENABLED),
      rebuyMaxCount: Math.max(1, Math.floor(Number(env.REBUY_MAX_COUNT) || 1)),
      rebuyAmountSize: Math.max(0, Number(env.REBUY_AMOUNT_SIZE) || 0),
      followWhaleSell: envTrue(env.FOLLOW_WHALE_SELL),
      allowMultiLegNetFollow: envTrue(env.ALLOW_MULTI_LEG_NET_FOLLOW),
      maxOtherSplLegRatio: Math.min(
        1,
        Math.max(0, Number(env.MAX_OTHER_SPL_LEG_RATIO) || 0.25),
      ),
      persistentWsol,
      startupPrewrapWsol: {
        enabled: startupPrewrapEnabled,
        targetSol: startupPrewrapTargetSol,
        solReserveSol: startupPrewrapReserveSol,
      },
      autoSellTtlMs: Math.max(0, Math.floor(Number(env.AUTO_SELL_TTL_MS) || 0)),
      autoSellCheckIntervalMs: Math.max(
        10_000,
        Math.floor(Number(env.AUTO_SELL_CHECK_INTERVAL_MS) || 60_000),
      ),
      autoSellResetOnRebuy: envTrue(env.AUTO_SELL_TTL_RESET_ON_REBUY),
      tokenOverrides: external.tokenOverrides,
      positionStateFile: env.POSITION_STATE_FILE.trim(),
      positionStateSaveIntervalMs: Math.max(
        2_000,
        Math.floor(Number(env.POSITION_STATE_SAVE_INTERVAL_MS) || 10_000),
      ),
      delayMs: Number(env.DELAY_MS),
    },
    perf: {
      quoteCacheTtlMs: Number(env.QUOTE_CACHE_TTL_MS),
      logLatency: envTrue(env.LATENCY_LOG),
      logLatencySampleRate: Math.min(
        1,
        Math.max(0, Number(env.LATENCY_LOG_SAMPLE_RATE) || 1),
      ),
      jupiterWarm: envTrue(env.JUPITER_WARMUP),
      prewarmAltAddresses: csvToArray(env.JUPITER_PREWARM_ALTS),
      walletStateCacheTtlMs: Math.max(
        50,
        Number(env.WALLET_STATE_CACHE_TTL_MS) || 280,
      ),
      pumpPrebuildTimeoutMs: Math.max(
        0,
        Number(env.PUMP_PREBUILD_TIMEOUT_MS) || 100,
      ),
    },
    execution: {
      confirmCommitment: env.TX_CONFIRM_COMMITMENT,
      useHeliusSender: senderMode === "helius",
      senderMode,
      senderEndpoint: resolveHeliusSenderEndpoint(
        env.HELIUS_SENDER_URL,
        env.HELIUS_SENDER_REGION,
      ),
      jitoSenderUrl: env.JITO_SENDER_URL?.trim() || null,
      jitoTipAccounts: csvToArray(env.JITO_TIP_ACCOUNTS),
      multiSenderRace: envTrue(env.EXECUTION_MULTI_SENDER_RACE),
      extraSendRpcUrls,
      rpcHealthCheck: {
        enabled: envTrue(env.RPC_HEALTH_CHECK_ENABLED),
        probeIntervalMs: Math.max(
          1000,
          Number(env.RPC_HEALTH_PROBE_INTERVAL_MS) || 10000,
        ),
        latencyThresholdMs: Math.max(
          10,
          Number(env.RPC_HEALTH_LATENCY_THRESHOLD_MS) || 150,
        ),
        probeTimeoutMs: Math.max(
          500,
          Number(env.RPC_HEALTH_PROBE_TIMEOUT_MS) || 3000,
        ),
      },
      fastAck: envTrue(env.EXEC_FAST_ACK),
      tipEnabled: envTrue(env.EXEC_TIP_ENABLED),
      buyNoFallback: envTrue(env.EXEC_BUY_NO_FALLBACK),
      tipLamportsBuy: tipBuy,
      tipLamportsSell: tipSell,
    },
    runtime: {
      maxConcurrentSwaps: Math.max(1, Number(env.MAX_CONCURRENT_SWAPS) || 1),
      dedupWhaleTxMs: Math.max(0, Number(env.DEDUP_WHALE_TX_MS) || 0),
    },
    debug: {
      whalePipeline: envTrue(env.WHALE_DEBUG),
      unknownProtocolLog: envTrue(env.UNKNOWN_PROTOCOL_LOG),
    },
    observability: {
      metricsPort: Math.max(0, Math.floor(Number(env.METRICS_PORT) || 0)),
      controlApiPort: Math.max(
        0,
        Math.floor(Number(env.CONTROL_API_PORT) || 0),
      ),
      controlApiBind: env.CONTROL_API_BIND.trim() || "127.0.0.1",
      controlApiToken: env.CONTROL_API_TOKEN.trim(),
      slaAlert: {
        enabled: envTrue(env.SLA_ALERT_ENABLED),
        buyP95Ms: Math.max(1, Number(env.SLA_BUY_P95_MS) || 80),
        sellP95Ms: Math.max(1, Number(env.SLA_SELL_P95_MS) || 150),
        windowMs: Math.max(10_000, Number(env.SLA_WINDOW_MS) || 300_000),
        checkIntervalMs: Math.max(
          5_000,
          Number(env.SLA_CHECK_INTERVAL_MS) || 60_000,
        ),
        alertCooldownMs: Math.max(
          30_000,
          Number(env.SLA_ALERT_COOLDOWN_MS) || 600_000,
        ),
        minSamples: Math.max(5, Number(env.SLA_MIN_SAMPLES) || 20),
      },
    },
  };
};
