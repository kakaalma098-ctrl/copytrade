import { senderHttpClient } from "../utils/sender-http-client.js";

type EndpointState = {
  url: string;
  label: string;
  healthy: boolean;
  lastProbeMs: number;
  lastProbeAt: number;
};

/**
 * Level 2 RPC healthchecker. Background-probes every registered send endpoint
 * (Helius Sender, Jito Sender, RPC URLs) at a fixed interval and marks any
 * endpoint that exceeds the latency threshold as unhealthy. The sender race
 * consults `isHealthy()` to skip unhealthy paths, so a degraded endpoint
 * cannot drag overall landing time down.
 *
 * Probe uses JSON-RPC `getHealth`. Helius Sender and Jito Sender may reject
 * the method but still respond — any HTTP response counts as "reachable",
 * and the RTT is what we actually measure.
 *
 * State machine per endpoint:
 *   - Probe fails (network error / timeout) → unhealthy (RTT = timeout budget)
 *   - Probe RTT > threshold → unhealthy
 *   - Probe RTT <= threshold → healthy
 *
 * No sliding window — a single stale probe flips state. This trades a small
 * amount of flap for fast response to degradation (<10s detection).
 */
export class RpcHealthChecker {
  private readonly endpoints = new Map<string, EndpointState>();
  private probeTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly probeIntervalMs: number,
    private readonly latencyThresholdMs: number,
    private readonly probeTimeoutMs: number = 3000,
  ) {}

  register(url: string, label: string): void {
    const cleaned = url.trim();
    if (cleaned === "" || this.endpoints.has(cleaned)) {
      return;
    }
    this.endpoints.set(cleaned, {
      url: cleaned,
      label,
      healthy: true,
      lastProbeMs: 0,
      lastProbeAt: 0,
    });
  }

  start(): void {
    if (this.probeTimer != null || this.endpoints.size === 0) {
      return;
    }
    void this.probeAll();
    this.probeTimer = setInterval(() => {
      if (!this.stopped) {
        void this.probeAll();
      }
    }, this.probeIntervalMs);
    if (typeof this.probeTimer.unref === "function") {
      this.probeTimer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.probeTimer != null) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  isHealthy(url: string): boolean {
    const state = this.endpoints.get(url.trim());
    if (state == null) {
      return true;
    }
    return state.healthy;
  }

  getLatency(url: string): number | null {
    const state = this.endpoints.get(url.trim());
    return state?.lastProbeMs ?? null;
  }

  /** Comma-joined one-liner safe for console logs. */
  healthReport(): string {
    const parts: string[] = [];
    for (const s of this.endpoints.values()) {
      if (s.lastProbeAt === 0) {
        parts.push(`${s.label}=—`);
        continue;
      }
      const tag = s.healthy ? "ok" : "SLOW";
      parts.push(`${s.label}=${s.lastProbeMs}ms(${tag})`);
    }
    return parts.join(" ");
  }

  /** True when at least one registered endpoint is healthy. */
  anyHealthy(): boolean {
    for (const s of this.endpoints.values()) {
      if (s.healthy) {
        return true;
      }
    }
    return false;
  }

  private async probeAll(): Promise<void> {
    const targets = Array.from(this.endpoints.values());
    await Promise.allSettled(targets.map((state) => this.probeOne(state)));
  }

  private async probeOne(state: EndpointState): Promise<void> {
    const wasHealthy = state.healthy;
    const start = Date.now();
    try {
      await senderHttpClient.post(
        state.url,
        { jsonrpc: "2.0", id: 0, method: "getHealth", params: [] },
        { timeout: this.probeTimeoutMs, validateStatus: () => true },
      );
      const rtt = Date.now() - start;
      state.lastProbeMs = rtt;
      state.lastProbeAt = Date.now();
      state.healthy = rtt <= this.latencyThresholdMs;
    } catch {
      state.lastProbeMs = this.probeTimeoutMs;
      state.lastProbeAt = Date.now();
      state.healthy = false;
    }
    if (wasHealthy !== state.healthy) {
      const verb = state.healthy ? "recovered" : "degraded";
      console.warn(
        `[rpc-health] ${state.label} ${verb} (rtt=${state.lastProbeMs}ms threshold=${this.latencyThresholdMs}ms)`,
      );
    }
  }
}
