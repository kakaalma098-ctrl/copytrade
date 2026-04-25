import type { TelegramNotifier } from "../notifications/telegram.js";
import { metrics } from "./metrics-registry.js";

export type SlaWatchOptions = {
  /** Target p95 for BUY pipeline in ms. Breach logs + alerts. */
  buyP95Ms: number;
  /** Target p95 for SELL pipeline in ms. */
  sellP95Ms: number;
  /** Rolling percentile window in ms (default 5 min). */
  windowMs: number;
  /** How often to evaluate SLA in ms. */
  checkIntervalMs: number;
  /** Minimum cooldown between Telegram alerts to avoid spam. */
  alertCooldownMs: number;
  /** Minimum observed samples per side before evaluating SLA. */
  minSamples: number;
};

/**
 * Phase 6: background watcher that evaluates pipeline p95 against the SLA
 * targets and emits a Telegram alert on breach. Cooldown-limited so a
 * sustained breach fires at most once per cooldown window.
 */
export class SlaWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAlertMs = 0;

  start(notifier: TelegramNotifier, opts: SlaWatchOptions): void {
    this.stop();
    const interval = Math.max(5_000, opts.checkIntervalMs);
    this.timer = setInterval(() => {
      this.check(notifier, opts).catch((e) => {
        console.warn(
          `[sla-alert] check failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }, interval);
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(
    notifier: TelegramNotifier,
    opts: SlaWatchOptions,
  ): Promise<void> {
    const buy = metrics.getPercentiles(
      "laser_pipeline_ms",
      { side: "BUY" },
      opts.windowMs,
    );
    const sell = metrics.getPercentiles(
      "laser_pipeline_ms",
      { side: "SELL" },
      opts.windowMs,
    );

    const breaches: string[] = [];
    if (
      buy != null &&
      buy.count >= opts.minSamples &&
      buy.p95 > opts.buyP95Ms
    ) {
      breaches.push(
        `BUY p95=${Math.round(buy.p95)}ms > ${opts.buyP95Ms}ms SLA (n=${buy.count})`,
      );
    }
    if (
      sell != null &&
      sell.count >= opts.minSamples &&
      sell.p95 > opts.sellP95Ms
    ) {
      breaches.push(
        `SELL p95=${Math.round(sell.p95)}ms > ${opts.sellP95Ms}ms SLA (n=${sell.count})`,
      );
    }

    if (breaches.length === 0) return;

    const now = Date.now();
    if (now - this.lastAlertMs < opts.alertCooldownMs) return;
    this.lastAlertMs = now;

    const msg = [
      "[laser-helius] SLA BREACH",
      `window=${Math.round(opts.windowMs / 1000)}s`,
      ...breaches,
    ].join("\n");
    console.warn(`[sla-alert] ${breaches.join(" | ")}`);
    try {
      await notifier.notifyStart(msg);
    } catch (e) {
      console.warn(
        `[sla-alert] telegram send failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
