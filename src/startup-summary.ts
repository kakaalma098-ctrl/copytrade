import type { BotWalletSnapshot } from "./perf/bot-wallet-rpc.js";
import type { AppConfig } from "./types/index.js";

function hostOnly(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.length > 48 ? `${url.slice(0, 45)}...` : url;
  }
}

function whaleFeedLine(config: AppConfig): string {
  const n = config.whaleWallets.length;
  if (config.helius.feedMode === "grpc") {
    return `Whale feed: Helius Laserstream PREPROCESSED (instruction-decode) -> ${hostOnly(config.helius.laserstreamEndpoint)} | ${n} wallet monitored`;
  }
  if (config.helius.feedMode === "wss") {
    return `Whale feed: Helius WSS (transactionSubscribe) -> ${hostOnly(config.helius.wssUrl)} | ${n} wallet monitored`;
  }
  return `Whale feed: (invalid mode) | ${n} wallet`;
}

function activeFeedCommitmentLine(config: AppConfig): string {
  if (config.helius.feedMode === "grpc") {
    // Preprocessed has no commitment level — data is delivered at shred-decode
    // time, before validator commitment is reached. The configured value is
    // ignored on this path; the decoder relies on instruction parsing instead.
    return "Laserstream tx commitment: PREPROCESSED (no meta — decoder reads instruction data only, ~50–150ms earlier than confirmed)";
  }
  return `WSS tx commitment: ${config.helius.wssCommitment} (processed = earlier signal)`;
}

export function formatStartupSummaryConsole(config: AppConfig): string {
  const jupKey =
    config.jupiter.apiKeys.length > 0
      ? `yes (${config.jupiter.apiKeys.length}, rotating)`
      : "no";
  const tgPoll =
    config.telegram.enabled &&
    Boolean(config.telegram.botToken?.trim()) &&
    Boolean(config.telegram.chatId?.trim())
      ? "yes"
      : "no (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)";

  const lines = [
    "",
    "======== laser-helius | active summary ========",
    whaleFeedLine(config),
    `Solana RPC: ${hostOnly(config.helius.rpcUrl)} | commitment ${config.helius.rpcCommitment}`,
    activeFeedCommitmentLine(config),
    `Jupiter: ${config.jupiter.swapApiBase} | mode ${config.jupiter.integrationMode} | x-api-key: ${jupKey} | warmup quote: ${config.perf.jupiterWarm ? "on" : "off"}`,
    `Copy: buy ${config.trading.fixedBuyAmountSol} SOL | min whale buy ${config.trading.minWhaleBuyAmountSol} SOL | rebuy ${config.trading.rebuyEnabled ? `on max ${config.trading.rebuyMaxCount}x` : "off max 1x"} | follow whale SELL ${config.trading.followWhaleSell ? "on (proportional)" : "off (sell 100%)"} | multi-leg net-follow ${config.trading.allowMultiLegNetFollow ? `on ratio<=${config.trading.maxOtherSplLegRatio}` : "off"} | slippage ${config.trading.slippageBps} bps | persistent WSOL ${config.trading.persistentWsol ? "on" : "off"} | startup prewrap ${
      config.trading.startupPrewrapWsol.enabled
        ? `on target ${config.trading.startupPrewrapWsol.targetSol} SOL reserve ${config.trading.startupPrewrapWsol.solReserveSol} SOL`
        : "off"
    }`,
    `Execution: ${config.execution.confirmCommitment} | sender ${config.execution.senderMode} | tip ${
      config.execution.tipEnabled
        ? `buy:${config.execution.tipLamportsBuy} sell:${config.execution.tipLamportsSell}`
        : "off"
    } | fast-ack ${config.execution.fastAck ? "on" : "off"} | max ${config.runtime.maxConcurrentSwaps} parallel swap | dedup whale tx ${config.runtime.dedupWhaleTxMs} ms`,
    `Telegram: ${config.telegram.enabled ? "on" : "off"} | command polling: ${tgPoll}`,
    `Debug: WHALE_DEBUG pipeline ${config.debug.whalePipeline ? "on (verbose)" : "off"}`,
    `Latency log: ${config.perf.logLatency ? "on" : "off"}`,
    `Perf cache: wallet SOL/token TTL ${config.perf.walletStateCacheTtlMs}ms`,
    "==============================================",
    "",
  ];
  return lines.join("\n");
}

export function formatStartupSummaryTelegram(
  config: AppConfig,
  wallet: BotWalletSnapshot | null,
): string {
  const activeFeed =
    config.helius.feedMode === "grpc"
      ? "Laserstream PREPROCESSED (instruction-decode)"
      : `WSS transactionSubscribe (${config.helius.wssCommitment})`;
  const lines = [
    "bot copytrading V3 started",
    "",
    `Wallet : ${wallet?.publicKey ?? "-"}`,
    `Saldo : ${wallet ? `${wallet.balanceSol.toFixed(6)} SOL` : "N/A"}`,
    `Total Whale monitoring : ${config.whaleWallets.length}`,
    `Active : ${activeFeed} + RPC ${hostOnly(config.helius.rpcUrl)}`,
  ];
  return lines.join("\n");
}
