/**
 * Phase 6: lightweight in-memory metrics registry (counters + summary
 * histograms) with Prometheus text-format rendering. No external dep.
 *
 * Histograms are implemented as rolling-window summaries — percentiles
 * (p50/p90/p95/p99) are computed over samples observed within the last
 * `HISTOGRAM_WINDOW_MS`. Older samples are pruned lazily on each observe.
 */

type LabelMap = Record<string, string>;

type HistogramSample = { value: number; ts: number };

type HistogramBucket = {
  sum: number;
  count: number;
  samples: HistogramSample[];
};

const HISTOGRAM_WINDOW_MS = 5 * 60 * 1000;
const HISTOGRAM_MAX_SAMPLES = 2000;

const labelKey = (labels: LabelMap): string => {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join("|");
};

const parseLabelKey = (key: string): LabelMap => {
  const labels: LabelMap = {};
  if (key === "") return labels;
  for (const pair of key.split("|")) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      labels[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return labels;
};

const escapeLabelValue = (v: string): string =>
  v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const renderLabels = (labels: LabelMap): string => {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return (
    "{" +
    keys.map((k) => `${k}="${escapeLabelValue(labels[k]!)}"`).join(",") +
    "}"
  );
};

const pruneSamples = (bucket: HistogramBucket): void => {
  const cutoff = Date.now() - HISTOGRAM_WINDOW_MS;
  while (bucket.samples.length > 0 && bucket.samples[0]!.ts < cutoff) {
    bucket.samples.shift();
  }
  if (bucket.samples.length > HISTOGRAM_MAX_SAMPLES) {
    bucket.samples.splice(0, bucket.samples.length - HISTOGRAM_MAX_SAMPLES);
  }
};

export type Percentiles = {
  count: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
};

export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, HistogramBucket>>();
  private readonly counterHelp = new Map<string, string>();
  private readonly histogramHelp = new Map<string, string>();

  registerCounter(name: string, help: string): void {
    this.counterHelp.set(name, help);
    if (!this.counters.has(name)) {
      this.counters.set(name, new Map());
    }
  }

  registerHistogram(name: string, help: string): void {
    this.histogramHelp.set(name, help);
    if (!this.histograms.has(name)) {
      this.histograms.set(name, new Map());
    }
  }

  inc(name: string, labels: LabelMap = {}, value = 1): void {
    const bucket = this.counters.get(name);
    if (bucket == null) return;
    const key = labelKey(labels);
    bucket.set(key, (bucket.get(key) ?? 0) + value);
  }

  observe(name: string, value: number, labels: LabelMap = {}): void {
    if (!Number.isFinite(value)) return;
    const buckets = this.histograms.get(name);
    if (buckets == null) return;
    const key = labelKey(labels);
    let h = buckets.get(key);
    if (h == null) {
      h = { sum: 0, count: 0, samples: [] };
      buckets.set(key, h);
    }
    h.sum += value;
    h.count += 1;
    h.samples.push({ value, ts: Date.now() });
    pruneSamples(h);
  }

  getPercentiles(
    name: string,
    labels: LabelMap = {},
    windowMs = HISTOGRAM_WINDOW_MS,
  ): Percentiles | null {
    const buckets = this.histograms.get(name);
    if (buckets == null) return null;
    const key = labelKey(labels);
    const h = buckets.get(key);
    if (h == null) return null;
    const cutoff = Date.now() - windowMs;
    const values = h.samples.filter((s) => s.ts >= cutoff).map((s) => s.value);
    if (values.length === 0) return null;
    values.sort((a, b) => a - b);
    const q = (pct: number): number => {
      const idx = Math.min(values.length - 1, Math.floor(values.length * pct));
      return values[idx]!;
    };
    return {
      count: values.length,
      p50: q(0.5),
      p90: q(0.9),
      p95: q(0.95),
      p99: q(0.99),
    };
  }

  render(): string {
    const lines: string[] = [];

    for (const [name, bucket] of this.counters) {
      const help = this.counterHelp.get(name);
      if (help != null) {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} counter`);
      }
      if (bucket.size === 0) {
        lines.push(`${name} 0`);
        continue;
      }
      for (const [key, value] of bucket) {
        lines.push(`${name}${renderLabels(parseLabelKey(key))} ${value}`);
      }
    }

    for (const [name, bucket] of this.histograms) {
      const help = this.histogramHelp.get(name);
      if (help != null) {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} summary`);
      }
      for (const [key, h] of bucket) {
        pruneSamples(h);
        const labels = parseLabelKey(key);
        const values = h.samples.map((s) => s.value);
        if (values.length > 0) {
          values.sort((a, b) => a - b);
          const q = (pct: number): number =>
            values[
              Math.min(values.length - 1, Math.floor(values.length * pct))
            ]!;
          for (const [pct, label] of [
            [0.5, "0.5"],
            [0.9, "0.9"],
            [0.95, "0.95"],
            [0.99, "0.99"],
          ] as const) {
            lines.push(
              `${name}${renderLabels({ ...labels, quantile: label })} ${q(pct)}`,
            );
          }
        }
        lines.push(`${name}_sum${renderLabels(labels)} ${h.sum}`);
        lines.push(`${name}_count${renderLabels(labels)} ${h.count}`);
      }
    }

    return lines.join("\n") + "\n";
  }
}

export const metrics = new MetricsRegistry();

// Central registration — single source of truth for metric names & help text.
metrics.registerHistogram(
  "laser_pipeline_ms",
  "End-to-end pipeline latency in milliseconds",
);
metrics.registerHistogram(
  "laser_exec_ms",
  "Execution-stage latency (quote build + send + confirm) in milliseconds",
);
metrics.registerHistogram(
  "laser_stage_ms",
  "Per-stage latency (quoteBuild/send/confirm/etc) in milliseconds",
);
metrics.registerCounter(
  "laser_exec_total",
  "Total executions by side and status",
);
metrics.registerCounter(
  "laser_prebuild_cache_total",
  "Prebuild cache lookups by side and outcome (hit/miss/bypass)",
);
metrics.registerCounter(
  "laser_direct_pump_outcome_total",
  "Direct-pump tx outcomes by protocol and result (ok/revert)",
);
metrics.registerCounter(
  "laser_direct_pump_circuit_break_total",
  "Direct-pump circuit-break events by protocol",
);
metrics.registerCounter(
  "laser_signal_drop_total",
  "Whale signals dropped by reason",
);
