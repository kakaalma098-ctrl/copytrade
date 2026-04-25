export type RuntimeSnapshot = {
  ok: true;
  uptimeSec: number;
  activeSwaps: number;
  maxConcurrentSwaps: number;
  dedupWhaleTxMs: number;
  dedupSkippedTotal: number;
};

class RuntimeMetrics {
  readonly startedAt = Date.now();
  activeSwaps = 0;
  dedupSkippedTotal = 0;

  getSnapshot(
    maxConcurrentSwaps: number,
    dedupWhaleTxMs: number,
  ): RuntimeSnapshot {
    return {
      ok: true,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      activeSwaps: this.activeSwaps,
      maxConcurrentSwaps,
      dedupWhaleTxMs,
      dedupSkippedTotal: this.dedupSkippedTotal,
    };
  }
}

export const runtimeMetrics = new RuntimeMetrics();
