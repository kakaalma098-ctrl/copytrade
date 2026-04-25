import { Telegraf } from "telegraf";
import type { AppConfig, ExecutionResult } from "../types/index.js";

const shortAddr = (value?: string): string => {
  if (!value) {
    return "-";
  }
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
};

const fmtSol = (value?: number): string =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(6)} SOL`
    : "-";

const fmtPct = (value?: number): string =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(2)}%`
    : "-";

const fmtMs = (value?: number): string =>
  typeof value === "number" && Number.isFinite(value)
    ? `${Math.max(0, Math.round(value))} ms`
    : "-";

const sideLabel = (side?: "BUY" | "SELL"): string => side ?? "TRADE";

const safeSig = (sig?: string): string => {
  if (!sig) {
    return "-";
  }
  const s = sig.trim();
  return s.length > 0 ? s : "-";
};

const formatExecutionStages = (result: ExecutionResult): string => {
  const s = result.executionStageMs;
  if (!s) {
    return "-";
  }
  const parts: string[] = [];
  if (s.quoteBuildMs != null) {
    parts.push(`quote ${fmtMs(s.quoteBuildMs)}`);
  }
  if (s.delayMs != null) {
    parts.push(`delay ${fmtMs(s.delayMs)}`);
  }
  if (s.deserializeMs != null) {
    parts.push(`deserialize ${fmtMs(s.deserializeMs)}`);
  }
  if (s.tipInjectMs != null) {
    parts.push(`tip ${fmtMs(s.tipInjectMs)}`);
  }
  if (s.tipLamports != null) {
    parts.push(`tipLamports ${Math.max(0, Math.round(s.tipLamports))}`);
  }
  if (s.signMs != null) {
    parts.push(`sign ${fmtMs(s.signMs)}`);
  }
  if (s.serializeMs != null) {
    parts.push(`serialize ${fmtMs(s.serializeMs)}`);
  }
  if (s.sendMs != null) {
    parts.push(`send ${fmtMs(s.sendMs)}`);
  }
  if (s.confirmMs != null) {
    parts.push(`confirm ${fmtMs(s.confirmMs)}`);
  }
  return parts.length > 0 ? parts.join(" | ") : "-";
};

function formatResultMessage(result: ExecutionResult): string {
  const side = sideLabel(result.side);
  const sig = safeSig(result.signature);
  const statusLine =
    result.status === "confirmed"
      ? `CONFIRMED${result.landedCommitment ? ` (${result.landedCommitment})` : ""}`
      : result.status === "submitted"
        ? "SUBMITTED (fast-ack)"
        : "FAILED";

  const lines = [
    `copytrading ${side} ${statusLine}`,
    "",
    `Status : ${statusLine}`,
    `Whale  : ${shortAddr(result.whaleWallet)}`,
    `Feed   : ${result.feedSource ?? "-"}`,
    `Sender : ${result.senderMode ?? "-"}`,
    `Token  : ${result.token ?? "-"}`,
    `Amount : ${fmtSol(result.sizeSol)}`,
    `Impact : ${fmtPct(result.quotePriceImpactPct)}`,
    `Latency: queue ${fmtMs(result.signalQueueMs)} | exec ${fmtMs(result.latencyMs)} | total ${fmtMs(result.pipelineTotalMs)}`,
    `Stages : ${formatExecutionStages(result)}`,
    `Signature : ${sig}`,
  ];

  if (result.sellRetry) {
    lines.push(
      `SELL Retry: ${result.sellRetry.mode ?? "sequential"} ${result.sellRetry.attempted ?? 0}/${result.sellRetry.maxAttempts ?? 0}${
        result.sellRetry.winnerAttempt != null
          ? ` | winner #${result.sellRetry.winnerAttempt}`
          : ""
      }`,
    );
  }

  if (sig !== "-") {
    lines.push(`Explorer  : https://solscan.io/tx/${sig}`);
  }
  if (result.status === "failed") {
    lines.push(`Reason    : ${result.error ?? "unknown error"}`);
  }

  return lines.join("\n");
}

export class TelegramNotifier {
  private readonly bot?: Telegraf;
  private static missingTelegramConfigWarned = false;

  constructor(private readonly config: AppConfig["telegram"]) {
    if (config.enabled && config.botToken) {
      this.bot = new Telegraf(config.botToken);
    }
  }

  async startCommands(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }

  async notifyStart(text = "bot copytrading V3 started"): Promise<void> {
    const sent = await this.send(text);
    if (sent) {
      console.log("[laser-helius] Telegram: startup summary delivered");
    }
  }

  async notifyResult(result: ExecutionResult): Promise<void> {
    await this.send(formatResultMessage(result));
  }

  private async send(text: string): Promise<boolean> {
    if (!this.bot || !this.config.chatId?.trim()) {
      if (
        this.config.enabled &&
        !TelegramNotifier.missingTelegramConfigWarned
      ) {
        TelegramNotifier.missingTelegramConfigWarned = true;
        const reason = !this.bot
          ? "TELEGRAM_BOT_TOKEN missing or invalid"
          : "TELEGRAM_CHAT_ID missing";
        console.warn(`[telegram] ${reason} - notifications are skipped`);
      }
      return false;
    }

    try {
      await this.bot.telegram.sendMessage(this.config.chatId, text);
      return true;
    } catch (e) {
      console.error("[telegram] sendMessage failed:", e);
      throw e;
    }
  }
}
