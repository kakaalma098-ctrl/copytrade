/**
 * Shared runtime flags + P&L bookkeeping surfaced via the control API.
 * All fields are plain primitives / small structs to keep the read path O(1);
 * the HTTP handler never touches listener internals or holds locks.
 */

export type TradeHistoryEntry = {
  ts: number;
  side: "BUY" | "SELL";
  status: "submitted" | "confirmed" | "failed";
  token: string;
  whale: string;
  sizeSol: number;
  signature: string;
  pipelineMs?: number;
  error?: string;
};

class RuntimeState {
  /** When true, processor early-exits — listener + metrics still tick. */
  tradingPaused = false;

  /** Balance snapshot at startup (lamports). Used for cumulative P&L. */
  baselineSolLamports: number | null = null;
  baselineCapturedAtMs: number | null = null;

  /** Latest known on-chain SOL balance (lamports). Refreshed by UI pulls. */
  latestSolLamports: number | null = null;
  latestSolRefreshedAtMs: number | null = null;

  /** Running totals from exec:result bus + historical restore. */
  totalBuyCount = 0;
  totalSellCount = 0;
  totalFailedCount = 0;
  totalBuySolIn = 0; // sum of sizeSol for BUYs — rough volume
  totalSellSolOut = 0; // sum of outAmount (SOL) for SELLs — rough revenue

  /** Last N trades for UI display (ring buffer). */
  private readonly history: TradeHistoryEntry[] = [];
  private readonly historyMax = 100;

  /**
   * Persistence hook — main.ts wires this to HistoryStore.markDirty so every
   * mutation (live trade append / Helius fetch merge / baseline capture)
   * triggers a debounced disk save.
   */
  private onChangeCallback: () => void = () => {};
  onChange(cb: () => void): void {
    this.onChangeCallback = cb;
  }

  appendHistory(entry: TradeHistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > this.historyMax) {
      this.history.splice(0, this.history.length - this.historyMax);
    }
    this.onChangeCallback();
  }

  getHistory(limit = 50): TradeHistoryEntry[] {
    const n = Math.max(1, Math.min(this.historyMax, Math.floor(limit)));
    return this.history.slice(-n).reverse();
  }

  /**
   * Bulk-merge entries fetched from Helius Enhanced Transactions API.
   * Dedup by signature — safe to call repeatedly on interval. Updates
   * the cumulative counters so the dashboard shows full lifetime trading
   * activity, not just the current process session.
   */
  mergeHistoricalEntries(entries: TradeHistoryEntry[]): {
    added: number;
    skipped: number;
  } {
    const seen = new Set<string>();
    for (const h of this.history) {
      if (h.signature) seen.add(h.signature);
    }
    let added = 0;
    let skipped = 0;
    for (const e of entries) {
      if (!e.signature || seen.has(e.signature)) {
        skipped += 1;
        continue;
      }
      this.history.push(e);
      seen.add(e.signature);
      added += 1;

      if (e.status === "failed") {
        this.totalFailedCount += 1;
        continue;
      }
      if (e.side === "BUY") {
        this.totalBuyCount += 1;
        this.totalBuySolIn += e.sizeSol ?? 0;
      } else if (e.side === "SELL") {
        this.totalSellCount += 1;
        // For historical SELL entries, sizeSol = SOL received (proxy for
        // outAmountRaw from the live path).
        this.totalSellSolOut += e.sizeSol ?? 0;
      }
    }
    // Keep internal storage chronological (oldest→newest); getHistory
    // reverses for UI display.
    this.history.sort((a, b) => a.ts - b.ts);
    if (this.history.length > this.historyMax) {
      this.history.splice(0, this.history.length - this.historyMax);
    }
    if (added > 0) this.onChangeCallback();
    return { added, skipped };
  }

  setBaseline(lamports: number): void {
    this.baselineSolLamports = lamports;
    this.baselineCapturedAtMs = Date.now();
    this.latestSolLamports = lamports;
    this.latestSolRefreshedAtMs = Date.now();
    this.onChangeCallback();
  }

  updateLatestSol(lamports: number): void {
    this.latestSolLamports = lamports;
    this.latestSolRefreshedAtMs = Date.now();
    // Latest SOL refresh is frequent (UI poll / startup); don't flood disk.
  }

  /**
   * Bulk snapshot for HistoryStore persistence (baseline + counters + history).
   */
  getFullSnapshot(): {
    baseline: {
      solLamports: number | null;
      capturedAtMs: number | null;
    };
    counters: {
      totalBuyCount: number;
      totalSellCount: number;
      totalFailedCount: number;
      totalBuySolIn: number;
      totalSellSolOut: number;
    };
    history: TradeHistoryEntry[];
  } {
    return {
      baseline: {
        solLamports: this.baselineSolLamports,
        capturedAtMs: this.baselineCapturedAtMs,
      },
      counters: {
        totalBuyCount: this.totalBuyCount,
        totalSellCount: this.totalSellCount,
        totalFailedCount: this.totalFailedCount,
        totalBuySolIn: this.totalBuySolIn,
        totalSellSolOut: this.totalSellSolOut,
      },
      history: [...this.history],
    };
  }

  /**
   * Restore from persisted snapshot (HistoryStore). Called once at startup
   * BEFORE Helius fetch / baseline capture so the dashboard has instant
   * data on boot. Does NOT re-fire onChangeCallback (would cause immediate
   * re-save loop).
   */
  loadFullSnapshot(snap: {
    baseline: { solLamports: number | null; capturedAtMs: number | null };
    counters: {
      totalBuyCount: number;
      totalSellCount: number;
      totalFailedCount: number;
      totalBuySolIn: number;
      totalSellSolOut: number;
    };
    history: TradeHistoryEntry[];
  }): void {
    this.baselineSolLamports = snap.baseline.solLamports;
    this.baselineCapturedAtMs = snap.baseline.capturedAtMs;
    this.latestSolLamports = snap.baseline.solLamports;
    this.latestSolRefreshedAtMs = snap.baseline.capturedAtMs;
    this.totalBuyCount = snap.counters.totalBuyCount;
    this.totalSellCount = snap.counters.totalSellCount;
    this.totalFailedCount = snap.counters.totalFailedCount;
    this.totalBuySolIn = snap.counters.totalBuySolIn;
    this.totalSellSolOut = snap.counters.totalSellSolOut;
    this.history.length = 0;
    for (const h of snap.history) this.history.push(h);
    if (this.history.length > this.historyMax) {
      this.history.splice(0, this.history.length - this.historyMax);
    }
  }
}

export const runtimeState = new RuntimeState();
