/**
 * Helius Enhanced Transactions API fetcher — surface historical bot wallet
 * activity in the dashboard on cold start, and refresh periodically so
 * Recent Trades + Trading Activity counters don't reset between restarts.
 *
 * Endpoint: https://api-mainnet.helius-rpc.com/v0/addresses/{addr}/transactions
 * Docs:    https://docs.helius.dev/solana-apis/enhanced-transactions-api
 *
 * Runs entirely in background — never blocks the hot path.
 */

import { httpClient } from "../utils/http-client.js";
import { runtimeState } from "../runtime/runtime-state.js";
import type { TradeHistoryEntry } from "../runtime/runtime-state.js";

const BASE = "https://api-mainnet.helius-rpc.com/v0/addresses";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

type HeliusNativeTransfer = {
  fromUserAccount?: string | null;
  toUserAccount?: string | null;
  amount?: number | string;
};

type HeliusTokenTransfer = {
  fromUserAccount?: string | null;
  toUserAccount?: string | null;
  mint?: string;
  tokenAmount?: number | string;
};

type HeliusEnhancedTx = {
  signature: string;
  timestamp: number;
  slot?: number;
  type?: string;
  source?: string;
  fee?: number;
  transactionError?: unknown;
  nativeTransfers?: HeliusNativeTransfer[];
  tokenTransfers?: HeliusTokenTransfer[];
};

export type HistoryFetchResult = {
  fetched: number;
  added: number;
  skipped: number;
  pages: number;
  errored?: string;
};

const toNumber = (v: number | string | undefined | null): number => {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const isSwapLike = (tx: HeliusEnhancedTx): boolean => {
  const t = (tx.type ?? "").toUpperCase();
  return t === "SWAP" || t === "UNKNOWN" || t === "TRANSFER";
};

/**
 * Interpret a Helius enhanced tx as a bot BUY or SELL trade. Matching logic:
 *   - Sum SOL delta for the bot (native transfers fromUserAccount/toUserAccount)
 *   - Sum token delta per mint for the bot (token transfers)
 *   - Pick the most significant non-WSOL mint as the traded token
 *   - If bot received that mint → BUY (SOL out)
 *     If bot sent that mint     → SELL (SOL in)
 * Returns null when the tx is not a bot swap we can reason about.
 */
const mapTxToEntry = (
  tx: HeliusEnhancedTx,
  botAddress: string,
): TradeHistoryEntry | null => {
  if (!tx.signature || !tx.timestamp) return null;
  if (!isSwapLike(tx)) return null;

  let solDeltaLamports = 0;
  for (const n of tx.nativeTransfers ?? []) {
    const amt = toNumber(n.amount);
    if (amt === 0) continue;
    if (n.fromUserAccount === botAddress) solDeltaLamports -= amt;
    if (n.toUserAccount === botAddress) solDeltaLamports += amt;
  }

  const tokenDelta = new Map<string, number>();
  for (const t of tx.tokenTransfers ?? []) {
    const mint = t.mint;
    if (!mint) continue;
    const amt = toNumber(t.tokenAmount);
    if (amt === 0) continue;
    let d = tokenDelta.get(mint) ?? 0;
    if (t.fromUserAccount === botAddress) d -= amt;
    if (t.toUserAccount === botAddress) d += amt;
    tokenDelta.set(mint, d);
  }

  // Find the non-WSOL mint with the largest absolute delta.
  let topMint = "";
  let topDelta = 0;
  for (const [mint, d] of tokenDelta) {
    if (mint === WSOL_MINT) continue;
    if (Math.abs(d) > Math.abs(topDelta)) {
      topMint = mint;
      topDelta = d;
    }
  }
  if (!topMint || topDelta === 0) return null;

  const side: "BUY" | "SELL" = topDelta > 0 ? "BUY" : "SELL";
  // For BUY sizeSol = SOL spent (|negative solDelta|).
  // For SELL sizeSol = SOL received (positive solDelta).
  const sizeSol = Math.abs(solDeltaLamports) / 1_000_000_000;
  if (!Number.isFinite(sizeSol) || sizeSol <= 0) return null;

  const status: TradeHistoryEntry["status"] = tx.transactionError
    ? "failed"
    : "confirmed";

  return {
    ts: tx.timestamp * 1000,
    side,
    status,
    token: topMint,
    whale: "",
    sizeSol,
    signature: tx.signature,
    pipelineMs: undefined,
    error: tx.transactionError
      ? JSON.stringify(tx.transactionError).slice(0, 200)
      : undefined,
  };
};

/**
 * Fetch recent bot activity from Helius and merge into runtimeState.
 * Paginates via `before` cursor up to `maxPages` (default 5 × 100 = 500 tx).
 * Safe to call on startup AND on an interval — dedup by signature ensures
 * counters never double-count.
 */
export const fetchAndRestoreBotHistory = async (
  botAddress: string,
  apiKey: string,
  opts?: { limit?: number; maxPages?: number; timeoutMs?: number },
): Promise<HistoryFetchResult> => {
  const limit = Math.max(1, Math.min(100, opts?.limit ?? 100));
  const maxPages = Math.max(1, Math.min(20, opts?.maxPages ?? 5));
  const timeout = Math.max(5_000, opts?.timeoutMs ?? 10_000);

  const url = `${BASE}/${encodeURIComponent(botAddress)}/transactions`;
  const all: TradeHistoryEntry[] = [];
  let before: string | undefined;
  let pages = 0;
  let errored: string | undefined;

  try {
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string | number> = {
        "api-key": apiKey,
        limit,
      };
      if (before) params.before = before;

      const res = await httpClient.get<HeliusEnhancedTx[]>(url, {
        params,
        timeout,
      });
      pages += 1;

      const txs = Array.isArray(res.data) ? res.data : [];
      if (txs.length === 0) break;

      for (const tx of txs) {
        const entry = mapTxToEntry(tx, botAddress);
        if (entry != null) all.push(entry);
      }

      if (txs.length < limit) break;
      before = txs[txs.length - 1]!.signature;
    }
  } catch (e) {
    errored = e instanceof Error ? e.message : String(e);
  }

  const { added, skipped } = runtimeState.mergeHistoricalEntries(all);

  return {
    fetched: all.length,
    added,
    skipped,
    pages,
    errored,
  };
};
