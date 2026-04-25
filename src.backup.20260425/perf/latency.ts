import type {
  AppConfig,
  ExecutionResult,
  TradeSignal,
} from "../types/index.js";
import { metrics } from "../runtime/metrics-registry.js";

/** Footer metrik pipeline untuk jalur gagal sebelum swap. */
export const pipelineMetricsFooter = (
  signal: TradeSignal,
  handlerStartedAtMs: number,
): Pick<
  ExecutionResult,
  | "pipelineTotalMs"
  | "signalQueueMs"
  | "ingestToDetectMs"
  | "ingestToSignalMs"
  | "ingestTotalMs"
  | "feedSource"
> => {
  const now = Date.now();
  return {
    feedSource: signal.feedSource,
    ingestToDetectMs:
      signal.detectedAtMs != null && signal.ingestedAtMs != null
        ? Math.max(0, signal.detectedAtMs - signal.ingestedAtMs)
        : undefined,
    ingestToSignalMs:
      signal.signalEmittedAtMs != null && signal.ingestedAtMs != null
        ? Math.max(0, signal.signalEmittedAtMs - signal.ingestedAtMs)
        : undefined,
    ingestTotalMs:
      signal.ingestedAtMs != null
        ? Math.max(0, now - signal.ingestedAtMs)
        : undefined,
    pipelineTotalMs:
      signal.detectedAtMs != null ? now - signal.detectedAtMs : undefined,
    signalQueueMs:
      signal.signalEmittedAtMs != null
        ? handlerStartedAtMs - signal.signalEmittedAtMs
        : undefined,
  };
};

/** Gabungkan hasil eksekusi dengan metrik pipeline total. */
export const attachPipelineMetrics = (
  result: ExecutionResult,
  signal: TradeSignal,
  handlerStartedAtMs: number,
): ExecutionResult => {
  const now = Date.now();
  return {
    ...result,
    feedSource: signal.feedSource,
    ingestToDetectMs:
      signal.detectedAtMs != null && signal.ingestedAtMs != null
        ? Math.max(0, signal.detectedAtMs - signal.ingestedAtMs)
        : undefined,
    ingestToSignalMs:
      signal.signalEmittedAtMs != null && signal.ingestedAtMs != null
        ? Math.max(0, signal.signalEmittedAtMs - signal.ingestedAtMs)
        : undefined,
    ingestTotalMs:
      signal.ingestedAtMs != null
        ? Math.max(0, now - signal.ingestedAtMs)
        : undefined,
    signalQueueMs:
      signal.signalEmittedAtMs != null
        ? handlerStartedAtMs - signal.signalEmittedAtMs
        : undefined,
    pipelineTotalMs:
      signal.detectedAtMs != null ? now - signal.detectedAtMs : undefined,
  };
};

const pushMs = (parts: string[], key: string, value?: number): void => {
  if (typeof value === "number" && Number.isFinite(value)) {
    parts.push(`${key}=${Math.max(0, Math.round(value))}ms`);
  }
};

const pushNum = (parts: string[], key: string, value?: number): void => {
  if (typeof value === "number" && Number.isFinite(value)) {
    parts.push(`${key}=${Math.max(0, Math.round(value))}`);
  }
};

/**
 * Phase 6: record pipeline + stage observations into the metrics registry.
 * Called unconditionally per exec:result so Prometheus scrapes get every
 * sample, independent of log verbosity or sample rate.
 */
export const recordLatencyMetrics = (result: ExecutionResult): void => {
  const side = result.side ?? "UNKNOWN";
  const status = result.status ?? "unknown";
  metrics.inc("laser_exec_total", { side, status });

  if (typeof result.pipelineTotalMs === "number") {
    metrics.observe("laser_pipeline_ms", result.pipelineTotalMs, { side });
  }
  if (typeof result.latencyMs === "number") {
    metrics.observe("laser_exec_ms", result.latencyMs, { side });
  }

  const s = result.executionStageMs;
  if (s == null) return;

  const obs = (stage: string, v?: number): void => {
    if (typeof v === "number" && Number.isFinite(v)) {
      metrics.observe("laser_stage_ms", v, { side, stage });
    }
  };
  obs("quoteBuild", s.quoteBuildMs);
  obs("delay", s.delayMs);
  obs("deserialize", s.deserializeMs);
  obs("tipInject", s.tipInjectMs);
  obs("sign", s.signMs);
  obs("serialize", s.serializeMs);
  obs("send", s.sendMs);
  obs("confirm", s.confirmMs);
};

export const logLatencyLine = (
  config: AppConfig,
  result: ExecutionResult,
): void => {
  if (!config.perf.logLatency) {
    return;
  }
  // Sampling: always log failures (signal), sample successes by rate.
  if (result.status !== "failed") {
    const rate = config.perf.logLatencySampleRate;
    if (rate < 1 && Math.random() >= rate) {
      return;
    }
  }

  const parts: string[] = ["[latency]"];

  pushMs(parts, "pipeline", result.pipelineTotalMs);
  pushMs(parts, "ingestDetect", result.ingestToDetectMs);
  pushMs(parts, "ingestSignal", result.ingestToSignalMs);
  pushMs(parts, "ingestTotal", result.ingestTotalMs);
  pushMs(parts, "signalQueue", result.signalQueueMs);
  pushMs(parts, "execTotal", result.latencyMs);

  const s = result.executionStageMs;
  if (s) {
    pushMs(parts, "quoteBuild", s.quoteBuildMs);
    pushMs(parts, "delay", s.delayMs);
    pushMs(parts, "deserialize", s.deserializeMs);
    pushMs(parts, "tipInject", s.tipInjectMs);
    pushNum(parts, "tipLamports", s.tipLamports);
    pushMs(parts, "sign", s.signMs);
    pushMs(parts, "serialize", s.serializeMs);
    pushMs(parts, "send", s.sendMs);
    pushMs(parts, "confirm", s.confirmMs);
  }

  if (result.sellRetry) {
    const attempted = result.sellRetry.attempted ?? 0;
    const maxAttempts = result.sellRetry.maxAttempts ?? 0;
    parts.push(
      `sellRetry=${result.sellRetry.mode ?? "sequential"}:${attempted}/${maxAttempts}`,
    );
    if (result.sellRetry.winnerAttempt != null) {
      parts.push(`sellWinner=#${result.sellRetry.winnerAttempt}`);
    }
  }

  const statusLabel =
    result.status === "confirmed"
      ? "processed"
      : result.status === "submitted"
        ? "submitted"
        : "failed";
  parts.push(`status=${statusLabel}`);
  if (result.status === "failed" && result.error) {
    parts.push(`err=${result.error}`);
  }
  if (result.feedSource) {
    parts.push(`feed=${result.feedSource}`);
  }
  if (result.senderMode) {
    parts.push(`sender=${result.senderMode}`);
  }
  if (result.whaleWallet) {
    parts.push(`whale=${result.whaleWallet.slice(0, 4)}...`);
  }

  console.log(parts.join(" "));
};
