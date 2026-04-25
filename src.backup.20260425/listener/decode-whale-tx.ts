import type {
  Connection,
  Finality,
  ParsedTransactionWithMeta,
} from "@solana/web3.js";
import type {
  ProtocolHint,
  RawWhaleTransaction,
  WhaleFeedSource,
} from "../types/index.js";
import {
  queueUnknownProtocol,
  sampleLogs,
} from "../perf/unknown-protocol-log.js";

export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Hanya SOL/WSOL ↔ SPL; bukan USDC/USDT → token atau sebaliknya. */
const STABLE_MINTS = new Set<string>([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT (SPL)
]);

export type WhaleTokenRow = {
  mint: string;
  owner: string;
  amount: string;
  decimals: number;
};

/** Frame seragam: Laserstream (gRPC) atau hasil normalisasi RPC. */
export type WhaleMetaFrame = {
  whale: string;
  signature: string;
  logs: string[];
  feedSource: WhaleFeedSource;
  ingestedAtMs: number;
  accountKeys: string[];
  preBalances: string[] | number[];
  postBalances: string[] | number[];
  preTokenBalances: WhaleTokenRow[];
  postTokenBalances: WhaleTokenRow[];
};

export type DecodeWhaleOptions = {
  allowMultiLegNetFollow?: boolean;
  maxOtherSplLegRatio?: number;
};

const METEORA_PROGRAM_IDS = new Set<string>([
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // DLMM
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Dynamic AMM v1
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // Dynamic AMM v2 (damm-v2)
]);

const PUMPFUN_PROGRAM_IDS = new Set<string>([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // Pump.fun bonding curve
]);

const PUMPSWAP_PROGRAM_IDS = new Set<string>([
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap AMM (post-migration)
]);

const RAYDIUM_PROGRAM_IDS = new Set<string>([
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
]);

const LAUNCHLAB_PROGRAM_IDS = new Set<string>([
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", // Raydium Launchpad / LaunchLab
]);

const detectProtocolHint = (frame: WhaleMetaFrame): ProtocolHint => {
  // Priority-based detection. A whale tx may touch multiple DEX programs
  // (e.g., Jupiter route with intermediate vaults). We want the MOST SPECIFIC
  // / FRESHEST pool protocol, which is the one actually hosting the token —
  // not a transit program that happened to appear earlier in accountKeys.
  //
  // Priority (high → low):
  //   PUMPFUN   — bonding curve (pre-migration, freshest)
  //   PUMPSWAP  — migrated Pump AMM
  //   LAUNCHLAB — Raydium Launchpad
  //   METEORA   — DLMM / DAMM
  //   RAYDIUM   — standard Raydium pools
  const keys = frame.accountKeys;
  const hasAny = (programs: Set<string>): boolean => {
    for (const key of keys) {
      if (programs.has(key)) return true;
    }
    return false;
  };

  if (hasAny(PUMPFUN_PROGRAM_IDS)) return "PUMPFUN";
  if (hasAny(PUMPSWAP_PROGRAM_IDS)) return "PUMPSWAP";
  if (hasAny(LAUNCHLAB_PROGRAM_IDS)) return "LAUNCHLAB";
  if (hasAny(METEORA_PROGRAM_IDS)) return "METEORA";
  if (hasAny(RAYDIUM_PROGRAM_IDS)) return "RAYDIUM";

  // Fallback: log string heuristics for protocols that emit identifiable logs
  // but whose program ID wasn't captured in accountKeys (edge cases).
  const logsBlob = frame.logs.join(" ").toLowerCase();
  if (logsBlob.includes("pump") && logsBlob.includes("swap")) {
    return "PUMPSWAP";
  }
  if (logsBlob.includes("pump") || logsBlob.includes("bondingcurve")) {
    return "PUMPFUN";
  }
  if (
    logsBlob.includes("meteora") ||
    logsBlob.includes("dlmm") ||
    logsBlob.includes("damm")
  ) {
    return "METEORA";
  }
  if (logsBlob.includes("raydium")) {
    return "RAYDIUM";
  }

  return "UNKNOWN";
};

const MIN_SOL_UI = 5e-5;
const MIN_TOKEN_UI = 1e-8;
const RPC_FETCH_PLAN: ReadonlyArray<{ commitment: Finality; waitMs: number }> =
  [
    { commitment: "confirmed", waitMs: 0 },
    { commitment: "confirmed", waitMs: 90 },
    { commitment: "confirmed", waitMs: 220 },
    { commitment: "finalized", waitMs: 420 },
  ];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const fetchParsedTxWithRetry = async (
  connection: Connection,
  signature: string,
): Promise<{ tx: ParsedTransactionWithMeta | null; hadRpcError: boolean }> => {
  let hadRpcError = false;
  for (const step of RPC_FETCH_PLAN) {
    if (step.waitMs > 0) {
      await sleep(step.waitMs);
    }
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: step.commitment,
      });
      if (tx?.meta) {
        return { tx, hadRpcError };
      }
    } catch {
      hadRpcError = true;
    }
  }
  return { tx: null, hadRpcError };
};

const lamportsAt = (balances: string[] | number[], idx: number): number => {
  if (idx < 0 || idx >= balances.length) {
    return 0;
  }
  const v = balances[idx];
  return typeof v === "number" ? v : Number(v);
};

const sumMintForWhale = (
  rows: WhaleTokenRow[],
  whale: string,
): Map<string, bigint> => {
  const m = new Map<string, bigint>();
  for (const r of rows) {
    if (!r.owner || r.owner !== whale) {
      continue;
    }
    const raw = BigInt(r.amount || "0");
    m.set(r.mint, (m.get(r.mint) ?? 0n) + raw);
  }
  return m;
};

const decimalsForMint = (
  frame: WhaleMetaFrame,
  whale: string,
  mint: string,
): number => {
  const row =
    frame.postTokenBalances.find((r) => r.mint === mint && r.owner === whale) ??
    frame.preTokenBalances.find((r) => r.mint === mint && r.owner === whale);
  return row?.decimals ?? 9;
};

/** Leg SPL lain milik whale selain mint utama — untuk ukur kompleksitas route. */
const getOtherSplLegRatio = (
  delta: Map<string, bigint>,
  primaryMint: string,
  primaryAbs: bigint,
  frame: WhaleMetaFrame,
  whale: string,
): number => {
  if (primaryAbs === 0n) {
    return 0;
  }

  const primaryUi =
    Number(primaryAbs) / 10 ** decimalsForMint(frame, whale, primaryMint);
  if (!Number.isFinite(primaryUi) || primaryUi <= 0) {
    return 0;
  }

  let otherUiTotal = 0;
  for (const [mint, d] of delta) {
    if (mint === NATIVE_SOL_MINT || mint === primaryMint) {
      continue;
    }
    const ad = d < 0n ? -d : d;
    if (ad === 0n) {
      continue;
    }
    const dec = decimalsForMint(frame, whale, mint);
    const ui = Math.abs(Number(d) / 10 ** dec);
    if (Number.isFinite(ui) && ui > 1e-8) {
      otherUiTotal += ui;
    }
  }

  return otherUiTotal / primaryUi;
};

/**
 * Infer BUY/SELL + mint + ukuran leg SOL dari meta tx.
 * Hanya **SOL/WSOL ↔ token** (bukan stable → token atau multi-leg SPL signifikan).
 */
export const decodeWhaleSwap = (
  frame: WhaleMetaFrame,
  onDrop?: (reason: string) => void,
  options?: DecodeWhaleOptions,
): RawWhaleTransaction | null => {
  const { whale, signature, accountKeys } = frame;
  const whaleIdx = accountKeys.findIndex((k) => k === whale);
  if (whaleIdx < 0) {
    onDrop?.("whale_not_in_account_keys");
    return null;
  }

  const nativeDeltaUi =
    (lamportsAt(frame.postBalances, whaleIdx) -
      lamportsAt(frame.preBalances, whaleIdx)) /
    1e9;

  const preT = sumMintForWhale(frame.preTokenBalances, whale);
  const postT = sumMintForWhale(frame.postTokenBalances, whale);
  const mints = new Set([...preT.keys(), ...postT.keys()]);
  const delta = new Map<string, bigint>();
  for (const mint of mints) {
    delta.set(mint, (postT.get(mint) ?? 0n) - (preT.get(mint) ?? 0n));
  }

  const wsolD = delta.get(NATIVE_SOL_MINT) ?? 0n;
  const wsolRow =
    frame.postTokenBalances.find(
      (r) => r.mint === NATIVE_SOL_MINT && r.owner === whale,
    ) ??
    frame.preTokenBalances.find(
      (r) => r.mint === NATIVE_SOL_MINT && r.owner === whale,
    );
  const wsolDec = wsolRow?.decimals ?? 9;
  const wsolUi = Number(wsolD) / 10 ** wsolDec;
  const solNetUi = nativeDeltaUi + wsolUi;

  let primaryMint: string | null = null;
  let primaryD = 0n;
  let primaryDec = 9;

  for (const [mint, d] of delta) {
    if (mint === NATIVE_SOL_MINT) {
      continue;
    }
    const abs = d < 0n ? -d : d;
    const curAbs = primaryD < 0n ? -primaryD : primaryD;
    if (primaryMint === null || abs > curAbs) {
      primaryMint = mint;
      primaryD = d;
      const row =
        frame.postTokenBalances.find(
          (r) => r.mint === mint && r.owner === whale,
        ) ??
        frame.preTokenBalances.find(
          (r) => r.mint === mint && r.owner === whale,
        );
      primaryDec = row?.decimals ?? 9;
    }
  }

  if (!primaryMint) {
    onDrop?.("no_primary_token_mint_delta");
    return null;
  }

  if (STABLE_MINTS.has(primaryMint)) {
    onDrop?.("stable_or_quote_mint_only");
    return null;
  }

  const tokenUi = Number(primaryD) / 10 ** primaryDec;
  if (!Number.isFinite(tokenUi) || Math.abs(tokenUi) < MIN_TOKEN_UI) {
    onDrop?.("token_leg_too_small_or_nan");
    return null;
  }

  const primaryAbs = primaryD < 0n ? -primaryD : primaryD;
  const allowMultiLegNetFollow = options?.allowMultiLegNetFollow === true;
  const maxOtherSplLegRatio = Math.min(
    1,
    Math.max(0, options?.maxOtherSplLegRatio ?? 0.25),
  );
  const otherSplLegRatio = getOtherSplLegRatio(
    delta,
    primaryMint,
    primaryAbs,
    frame,
    whale,
  );
  const hasComplexOtherSplLeg =
    Number.isFinite(otherSplLegRatio) && otherSplLegRatio > maxOtherSplLegRatio;

  if (hasComplexOtherSplLeg && !allowMultiLegNetFollow) {
    onDrop?.("multi_leg_spl_not_simple_swap");
    return null;
  }

  const now = Date.now();
  const ingestedAtMs = Number.isFinite(frame.ingestedAtMs)
    ? frame.ingestedAtMs
    : now;
  const feedSource = frame.feedSource;
  const protocolHint = detectProtocolHint(frame);

  const logUnknownIfNeeded = (side: "BUY" | "SELL", token: string): void => {
    if (protocolHint !== "UNKNOWN") return;
    queueUnknownProtocol({
      signature,
      token,
      wallet: whale,
      side,
      feedSource,
      detectedAtMs: now,
      programIds: frame.accountKeys,
      logsSample: sampleLogs(frame.logs),
    });
  };

  if (primaryD > 0n) {
    if (solNetUi >= -MIN_SOL_UI) {
      onDrop?.("buy_expected_sol_spent_but_sol_net_not_negative");
      return null;
    }
    const amount = -solNetUi;
    logUnknownIfNeeded("BUY", primaryMint);
    return {
      wallet: whale,
      type: "BUY",
      protocolHint,
      tokenIn: NATIVE_SOL_MINT,
      tokenOut: primaryMint,
      amount,
      feedSource,
      ingestedAtMs,
      signature,
      timestamp: now,
      detectedAtMs: now,
    };
  }

  if (primaryD < 0n) {
    if (solNetUi <= MIN_SOL_UI) {
      onDrop?.("sell_expected_sol_received_but_sol_net_not_positive");
      return null;
    }
    const whalePreRaw = preT.get(primaryMint) ?? 0n;
    const whaleSoldRaw = -primaryD;
    const whaleSellFraction =
      whalePreRaw > 0n
        ? Math.min(1, Math.max(0, Number(whaleSoldRaw) / Number(whalePreRaw)))
        : 1;
    const amount = solNetUi;
    logUnknownIfNeeded("SELL", primaryMint);
    return {
      wallet: whale,
      type: "SELL",
      protocolHint,
      tokenIn: primaryMint,
      tokenOut: NATIVE_SOL_MINT,
      amount,
      whaleSellFraction,
      feedSource,
      ingestedAtMs,
      signature,
      timestamp: now,
      detectedAtMs: now,
    };
  }

  onDrop?.("primary_token_delta_zero");
  return null;
};

export const decodeWhaleFromRpc = async (
  connection: Connection,
  whale: string,
  signature: string,
  logs: string[],
  onDrop?: (reason: string) => void,
  ctx?: { feedSource?: WhaleFeedSource; ingestedAtMs?: number },
  options?: DecodeWhaleOptions,
): Promise<RawWhaleTransaction | null> => {
  const { tx: res, hadRpcError } = await fetchParsedTxWithRetry(
    connection,
    signature,
  );
  if (!res?.meta) {
    onDrop?.(
      hadRpcError
        ? "rpc_tx_missing_after_retry_or_rpc_error"
        : "rpc_tx_missing_after_retry",
    );
    return null;
  }
  if (res.meta.err) {
    onDrop?.("rpc_tx_failed");
    return null;
  }

  const msg = res.transaction.message;
  const accountKeys = msg.accountKeys.map((a) => a.pubkey.toBase58());

  const rows = (balances: typeof res.meta.preTokenBalances): WhaleTokenRow[] =>
    (balances ?? []).map((t) => ({
      mint: t.mint,
      owner: t.owner ?? "",
      amount: t.uiTokenAmount.amount,
      decimals: t.uiTokenAmount.decimals,
    }));

  return decodeWhaleSwap(
    {
      whale,
      signature,
      logs,
      feedSource: ctx?.feedSource ?? "wss",
      ingestedAtMs: ctx?.ingestedAtMs ?? Date.now(),
      accountKeys,
      preBalances: res.meta.preBalances,
      postBalances: res.meta.postBalances,
      preTokenBalances: rows(res.meta.preTokenBalances),
      postTokenBalances: rows(res.meta.postTokenBalances),
    },
    onDrop,
    options,
  );
};
