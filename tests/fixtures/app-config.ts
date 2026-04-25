import type { AppConfig, RawWhaleTransaction } from "../../src/types/index.js";

type TradingOverrides = Partial<AppConfig["trading"]>;
type RuntimeOverrides = Partial<AppConfig["runtime"]>;
type DebugOverrides = Partial<AppConfig["debug"]>;

export const buildAppConfig = (
  overrides: {
    trading?: TradingOverrides;
    runtime?: RuntimeOverrides;
    debug?: DebugOverrides;
  } = {},
): AppConfig =>
  ({
    botPrivateKey: "fixture-private-key",
    whaleWallets: [],
    helius: {
      feedMode: "grpc",
      apiKey: "fixture",
      wssUrl: "",
      wssCommitment: "processed",
      laserstreamEndpoint: "",
      rpcUrl: "",
      rpcCommitment: "processed",
      tipEndpoints: [],
      tipAccounts: [],
      laserstreamCommitment: "processed",
    },
    jupiter: {
      swapApiBase: "",
      integrationMode: "metis_instructions",
      apiKeys: [],
      dynamicSlippage: false,
      dynamicSlippageMaxBps: 300,
      dynamicCuLimit: false,
      maxAccounts: 32,
    },
    telegram: {
      enabled: false,
      botToken: "",
      chatId: "",
      timeoutMs: 2000,
      queueMax: 200,
    },
    trading: {
      slippageBps: 80,
      fixedBuyAmountSol: 0.08,
      minWhaleBuyAmountSol: 0.6,
      rebuyEnabled: true,
      rebuyMaxCount: 6,
      rebuyAmountSize: 0.05,
      followWhaleSell: false,
      persistentWsol: true,
      allowMultiLegNetFollow: false,
      maxOtherSplLegRatio: 0.25,
      startupPrewrapWsol: {
        enabled: true,
        targetSol: 1,
        solReserveSol: 0.08,
      },
      autoSellTtlMs: 7_200_000,
      autoSellCheckIntervalMs: 60_000,
      autoSellResetOnRebuy: true,
      tokenOverrides: {},
      positionStateFile: "",
      positionStateSaveIntervalMs: 0,
      delayMs: 0,
      ...overrides.trading,
    },
    perf: {
      quoteCacheTtlMs: 1500,
      logLatency: false,
      logLatencySampleRate: 0,
      jupiterWarm: false,
      walletStateCacheTtlMs: 200,
    },
    execution: {
      confirmCommitment: "processed",
      useHeliusSender: true,
      senderMode: "helius",
      senderEndpoint: null,
      jitoSenderUrl: null,
      jitoTipAccounts: [],
      tipEnabled: true,
      tipStrategy: "adaptive",
      tipLamportsLow: 300_000,
      tipLamportsNormal: 300_000,
      tipLamportsHigh: 800_000,
      tipAdaptiveWindow: 30,
      fastAck: true,
    },
    runtime: {
      maxConcurrentSwaps: 3,
      dedupWhaleTxMs: 0,
      ...overrides.runtime,
    },
    debug: {
      whalePipeline: false,
      unknownProtocolLog: false,
      ...overrides.debug,
    },
    observability: {
      metricsPort: 0,
      controlApiPort: 0,
      controlApiBind: "127.0.0.1",
      controlApiToken: "",
      slaAlert: {
        enabled: false,
        buyP95Ms: 0,
        sellP95Ms: 0,
        windowMs: 0,
        checkIntervalMs: 0,
        alertCooldownMs: 0,
        minSamples: 0,
      },
    },
  }) as AppConfig;

export const buildRawBuy = (
  overrides: Partial<RawWhaleTransaction> = {},
): RawWhaleTransaction => ({
  wallet: "WhaleA",
  type: "BUY",
  protocolHint: "RAYDIUM",
  tokenIn: "So11111111111111111111111111111111111111112",
  tokenOut: "TokenX",
  amount: 1,
  feedSource: "grpc",
  ingestedAtMs: 1_700_000_000_000,
  signature: "sigBuyA",
  timestamp: 1_700_000_000_000,
  detectedAtMs: 1_700_000_000_000,
  ...overrides,
});

export const buildRawSell = (
  overrides: Partial<RawWhaleTransaction> = {},
): RawWhaleTransaction => ({
  wallet: "WhaleA",
  type: "SELL",
  protocolHint: "RAYDIUM",
  tokenIn: "TokenX",
  tokenOut: "So11111111111111111111111111111111111111112",
  amount: 1,
  whaleSellFraction: 1,
  feedSource: "grpc",
  ingestedAtMs: 1_700_000_000_000,
  signature: "sigSellA",
  timestamp: 1_700_000_000_000,
  detectedAtMs: 1_700_000_000_000,
  ...overrides,
});
