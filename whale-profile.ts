// whale-profile.ts
// Run:
//   npx tsx whale-profile.ts

import { writeFile } from "node:fs/promises";
import path from "node:path";

type EnhancedInstruction = {
  programId?: string;
  accounts?: string[];
  data?: string;
  innerInstructions?: Array<{
    programId?: string;
    accounts?: string[];
    data?: string;
  }>;
};

type ProgramInfo = {
  source?: string;
  account?: string;
  programName?: string;
  instructionName?: string;
};

type SwapTokenTransfer = {
  fromUserAccount?: string;
  toUserAccount?: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  tokenAmount?: number;
  mint?: string;
};

type SwapNativeTransfer = {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number;
};

type SwapBalance = {
  account?: string;
  userAccount?: string;
  tokenAccount?: string;
  mint?: string;
  rawTokenAmount?: {
    tokenAmount?: string;
    decimals?: number;
  };
  amount?: string;
};

type InnerSwap = {
  tokenInputs?: SwapTokenTransfer[];
  tokenOutputs?: SwapTokenTransfer[];
  tokenFees?: SwapTokenTransfer[];
  nativeFees?: SwapNativeTransfer[];
  programInfo?: ProgramInfo;
};

type SwapEvent = {
  nativeInput?: SwapBalance;
  nativeOutput?: SwapBalance;
  tokenInputs?: SwapBalance[];
  tokenOutputs?: SwapBalance[];
  tokenFees?: SwapBalance[];
  nativeFees?: SwapBalance[];
  innerSwaps?: InnerSwap[];
};

type EnhancedTx = {
  signature?: string;
  timestamp?: number;
  slot?: number;
  fee?: number;
  feePayer?: string;
  source?: string;
  type?: string;
  description?: string;
  instructions?: EnhancedInstruction[];
  tokenTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    fromTokenAccount?: string;
    toTokenAccount?: string;
    tokenAmount?: number;
    mint?: string;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number;
  }>;
  accountData?: Array<{
    account?: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: Array<{
      userAccount?: string;
      tokenAccount?: string;
      mint?: string;
      rawTokenAmount?: {
        tokenAmount?: string;
        decimals?: number;
      };
    }>;
  }>;
  events?: {
    swap?: SwapEvent;
    [key: string]: unknown;
  };
  transactionError?: {
    error?: string;
  };
};

type ClassifiedTx = {
  signature: string;
  time: string;
  slot?: number;
  fee?: number;
  feePayer?: string;
  type: string;
  heliusSource: string;
  entrySource: string;
  finalExecutor: string;
  activityType:
    | "SWAP"
    | "TRANSFER"
    | "ATA_CREATE"
    | "ACCOUNT_CREATE"
    | "UNKNOWN";
  activityDetail: string;
  actionGuess: "BUY" | "SELL" | "SWAP" | "UNKNOWN";
  resolvedAction: "BUY" | "SELL" | "SWAP" | "UNKNOWN";
  isMultiLeg: boolean;
  netTokenDelta: Array<{ mint: string; delta: number }>;
  shouldCopyTrade: boolean;
  skipReason: string | null;
  protocolPrimary: string;
  protocolTags: string[];
  confidence: number;
  signals: string[];
  isSwapLike: boolean;
  accountCount: number;
  tokenMints: string[];
  solChange: number;
  rawSolChangeLamports: number;
  description: string;
  programs: string[];
  programLabels: string[];
  hasError: boolean;
  transactionError?: string;
};

type WhaleProfileSummary = {
  totalTransactions: number;
  totalSwapLikeTransactions: number;
  totalTokenMintsObserved: number;
  uniqueTokenMints: number;
  netSolChange: number;
  averageSolChange: number;
  averageFee: number;
  averageConfidence: number;
  buySellRatio: number | null;
  resolvedBuySellRatio: number | null;
  actionableCopyTrades: number;
  multiLegTransactions: number;
  protocolFamilies: Record<string, number>;
  entrySource: Record<string, number>;
  finalExecutor: Record<string, number>;
  actionGuess: Record<string, number>;
  resolvedAction: Record<string, number>;
  skipReasons: Record<string, number>;
  activityType: Record<string, number>;
  confidenceBuckets: Record<string, number>;
  topTokenMints: Array<{ mint: string; count: number }>;
  topProgramLabels: Array<{ label: string; count: number }>;
  topActivitySignals: Array<{ signal: string; count: number }>;
  protocolMix: Array<{ source: string; count: number }>;
  topProtocolFamilies: Array<{ protocol: string; count: number }>;
  humanSummary: string[];
};

type WhaleProfileOutput = {
  whaleAddress: string;
  txLimit: number;
  showOnlySwapLike: boolean;
  summary: WhaleProfileSummary;
  transactions: ClassifiedTx[];
  metadata: {
    generatedAt: string;
    totalTransactions: number;
    filteredTransactions: number;
    reparsedTransactionCount: number;
    walletActivityWindow: {
      firstTime: string;
      lastTime: string;
    };
  };
  reparsedTransactions: Array<
    Pick<
      ClassifiedTx,
      | "signature"
      | "entrySource"
      | "finalExecutor"
      | "actionGuess"
      | "resolvedAction"
      | "shouldCopyTrade"
      | "skipReason"
      | "heliusSource"
      | "description"
    >
  >;
};

const HELIUS_API_KEY =
  process.env.HELIUS_API_KEY ?? "f7302b97-f988-455a-99f0-4b77b7f110f1";
const WHALE_ADDRESS =
  process.env.WHALE_OVERRIDE?.trim() ||
  "EqfCCCcgYAqntbaNuE3Rz8UiJ5LGtfge5gPX4ng4Fg61";
const TX_LIMIT = Number(process.env.TX_LIMIT) || 20;

// Optional filters
const SHOW_ONLY_SWAP_LIKE = false;

// Program ID hints (bisa Anda tambah sendiri)
const PROGRAM_ID_LABELS: Record<string, string> = {
  // Jupiter v6
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5Nt3KQnyX: "JUPITER",
  // Token Program
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL_TOKEN",
  // Associated Token
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "ATA",
  // System
  "11111111111111111111111111111111": "SYSTEM",
  // Compute budget
  ComputeBudget111111111111111111111111111111: "COMPUTE_BUDGET",
};

function buildUrl(
  path: string,
  query?: Record<string, string | number | undefined>,
) {
  const url = new URL(`https://api-mainnet.helius-rpc.com${path}`);
  url.searchParams.set("api-key", HELIUS_API_KEY);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url.toString();
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

async function fetchHistory(
  address: string,
  limit: number,
): Promise<EnhancedTx[]> {
  const url = buildUrl(`/v0/addresses/${address}/transactions`, {
    limit,
  });

  return fetchJson<EnhancedTx[]>(url, { method: "GET" });
}

async function parseTransactions(signatures: string[]): Promise<EnhancedTx[]> {
  const url = buildUrl(`/v0/transactions`);

  return fetchJson<EnhancedTx[]>(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transactions: signatures,
    }),
  });
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function lower(v?: string): string {
  return (v || "").toLowerCase();
}

function formatTime(ts?: number): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toISOString();
}

function lamportsToSol(lamports: number): number {
  return lamports / 1_000_000_000;
}

function collectPrograms(tx: EnhancedTx): string[] {
  const programs: string[] = [];

  for (const ix of tx.instructions || []) {
    if (ix.programId) programs.push(ix.programId);

    for (const inner of ix.innerInstructions || []) {
      if (inner.programId) programs.push(inner.programId);
    }
  }

  const innerSwaps = tx.events?.swap?.innerSwaps || [];
  for (const s of innerSwaps) {
    if (s.programInfo?.account) programs.push(s.programInfo.account);
  }

  return uniq(programs);
}

function getProgramLabels(programs: string[]): string[] {
  return uniq(
    programs
      .map((p) => PROGRAM_ID_LABELS[p])
      .filter((v): v is string => Boolean(v)),
  );
}

function hasProgramLabel(tx: EnhancedTx, label: string): boolean {
  return getProgramLabels(collectPrograms(tx)).includes(label);
}

function getInstructionTypeHints(tx: EnhancedTx): string[] {
  const hints: string[] = [];
  const type = upperClean(tx.type);
  const source = upperClean(tx.source);
  const description = upperClean(tx.description);

  if (type) hints.push(`TYPE:${type}`);
  if (source) hints.push(`SOURCE:${source}`);
  if (description) hints.push(`DESCRIPTION:${description.slice(0, 80)}`);

  return hints;
}

function detectProtocolTags(tx: EnhancedTx): string[] {
  const tags: string[] = [];
  const source = upperClean(tx.source);
  const description = upperClean(tx.description);
  const labels = getProgramLabels(collectPrograms(tx));
  const blob = `${source} ${description} ${labels.join(" ")}`;

  if (blob.includes("JUPITER")) tags.push("JUPITER");
  if (blob.includes("RAYDIUM")) tags.push("RAYDIUM");
  if (blob.includes("ORCA")) tags.push("ORCA");
  if (blob.includes("METEORA")) tags.push("METEORA");
  if (blob.includes("PUMP")) tags.push("PUMP_FUN");
  if (blob.includes("OKX")) tags.push("OKX_DEX_ROUTER");
  if (blob.includes("BUBBLEGUM")) tags.push("BUBBLEGUM");

  if (labels.includes("ATA")) tags.push("ASSOCIATED_TOKEN_PROGRAM");
  if (labels.includes("SPL_TOKEN")) tags.push("SPL_TOKEN");
  if (labels.includes("SYSTEM")) tags.push("SYSTEM_PROGRAM");
  if (labels.includes("COMPUTE_BUDGET")) tags.push("COMPUTE_BUDGET");

  return uniq(tags);
}

function getPrimaryProtocolTag(tx: EnhancedTx): string {
  const tags = detectProtocolTags(tx);

  const priority = [
    "JUPITER",
    "METEORA",
    "RAYDIUM",
    "ORCA",
    "PUMP_FUN",
    "OKX_DEX_ROUTER",
    "BUBBLEGUM",
    "ASSOCIATED_TOKEN_PROGRAM",
    "SPL_TOKEN",
    "SYSTEM_PROGRAM",
    "COMPUTE_BUDGET",
  ];

  for (const tag of priority) {
    if (tags.includes(tag)) return tag;
  }

  return tags[0] || "UNKNOWN";
}

function guessEntrySource(tx: EnhancedTx): string {
  const src = lower(tx.source);
  const desc = lower(tx.description);

  if (src.includes("jupiter") || desc.includes("jupiter")) return "JUPITER";
  if (src.includes("raydium") || desc.includes("raydium"))
    return "RAYDIUM_DIRECT";
  if (src.includes("orca") || desc.includes("orca")) return "ORCA_DIRECT";
  if (src.includes("meteora") || desc.includes("meteora"))
    return "METEORA_DIRECT";
  if (src.includes("pump") || desc.includes("pump")) return "PUMP_FUN_DIRECT";

  const programs = collectPrograms(tx);
  const labels = getProgramLabels(programs);

  if (labels.includes("JUPITER")) return "JUPITER";
  if (labels.includes("ATA")) return "ASSOCIATED_TOKEN_PROGRAM";
  if (labels.includes("SPL_TOKEN")) return "SPL_TOKEN";
  if (labels.includes("SYSTEM")) return "SYSTEM_PROGRAM";

  return "UNKNOWN";
}

function guessFinalExecutor(tx: EnhancedTx): string {
  const innerSwaps = tx.events?.swap?.innerSwaps || [];

  for (const s of innerSwaps) {
    const source = upperClean(s.programInfo?.source);
    const pname = upperClean(s.programInfo?.programName);
    const iname = upperClean(s.programInfo?.instructionName);

    const blob = `${source} ${pname} ${iname}`;

    if (blob.includes("RAYDIUM")) return "RAYDIUM";
    if (blob.includes("ORCA")) return "ORCA";
    if (blob.includes("METEORA")) return "METEORA";
    if (blob.includes("PUMP")) return "PUMP_FUN";
  }

  const src = upperClean(tx.source);
  const desc = upperClean(tx.description);

  if (src.includes("RAYDIUM") || desc.includes("RAYDIUM")) return "RAYDIUM";
  if (src.includes("ORCA") || desc.includes("ORCA")) return "ORCA";
  if (src.includes("METEORA") || desc.includes("METEORA")) return "METEORA";
  if (src.includes("PUMP") || desc.includes("PUMP")) return "PUMP_FUN";

  const programs = collectPrograms(tx);
  const labels = getProgramLabels(programs);

  if (labels.length > 0) return labels.join(",");

  return "UNKNOWN";
}

function upperClean(v?: string): string {
  return (v || "").trim().toUpperCase();
}

function extractTokenMints(tx: EnhancedTx): string[] {
  const mints1 = (tx.tokenTransfers || [])
    .map((x) => x.mint)
    .filter(Boolean) as string[];

  const mints2 = (tx.accountData || [])
    .flatMap((a) => a.tokenBalanceChanges || [])
    .map((x) => x.mint)
    .filter(Boolean) as string[];

  const swap = tx.events?.swap;
  const mints3 = [
    ...(swap?.tokenInputs || []).map((x) => x.mint).filter(Boolean),
    ...(swap?.tokenOutputs || []).map((x) => x.mint).filter(Boolean),
  ] as string[];

  return uniq([...mints1, ...mints2, ...mints3]);
}

function getAccountCount(tx: EnhancedTx): number {
  return (tx.instructions || []).reduce((count, ix) => {
    const innerCount = ix.innerInstructions?.length || 0;
    return count + (ix.accounts?.length || 0) + innerCount;
  }, 0);
}

function getSolChangeForWhale(tx: EnhancedTx, whale: string): number {
  let lamports = 0;

  for (const a of tx.accountData || []) {
    if (a.account === whale && typeof a.nativeBalanceChange === "number") {
      lamports += a.nativeBalanceChange;
    }
  }

  if (lamports !== 0) return lamportsToSol(lamports);

  for (const n of tx.nativeTransfers || []) {
    if (n.toUserAccount === whale) lamports += n.amount || 0;
    if (n.fromUserAccount === whale) lamports -= n.amount || 0;
  }

  return lamportsToSol(lamports);
}

function getSolChangeLamportsForWhale(tx: EnhancedTx, whale: string): number {
  let lamports = 0;

  for (const a of tx.accountData || []) {
    if (a.account === whale && typeof a.nativeBalanceChange === "number") {
      lamports += a.nativeBalanceChange;
    }
  }

  if (lamports !== 0) return lamports;

  for (const n of tx.nativeTransfers || []) {
    if (n.toUserAccount === whale) lamports += n.amount || 0;
    if (n.fromUserAccount === whale) lamports -= n.amount || 0;
  }

  return lamports;
}

function detectActivityType(tx: EnhancedTx): {
  activityType: ClassifiedTx["activityType"];
  activityDetail: string;
  signals: string[];
} {
  const signals: string[] = [];
  const type = upperClean(tx.type);
  const source = upperClean(tx.source);
  const programs = getProgramLabels(collectPrograms(tx));

  if (
    tx.events?.swap ||
    type.includes("SWAP") ||
    type.includes("BUY") ||
    type.includes("SELL")
  ) {
    signals.push("swap_event_or_type");
    return {
      activityType: "SWAP",
      activityDetail: source || type || "SWAP",
      signals,
    };
  }

  if (type.includes("TRANSFER")) {
    signals.push("transfer_type");
    return {
      activityType: "TRANSFER",
      activityDetail: source || type || "TRANSFER",
      signals,
    };
  }

  if (source.includes("ASSOCIATED_TOKEN") || programs.includes("ATA")) {
    signals.push("ata_program");
    return {
      activityType: "ATA_CREATE",
      activityDetail: source || "ASSOCIATED_TOKEN_PROGRAM",
      signals,
    };
  }

  if (type.includes("INITIALIZE_ACCOUNT") || type.includes("CREATE_ACCOUNT")) {
    signals.push("account_init_type");
    return {
      activityType: "ACCOUNT_CREATE",
      activityDetail: source || type || "ACCOUNT_CREATE",
      signals,
    };
  }

  return {
    activityType: "UNKNOWN",
    activityDetail: source || type || "UNKNOWN",
    signals,
  };
}

function detectConfidence(
  tx: EnhancedTx,
  activityType: ClassifiedTx["activityType"],
  actionGuess: ClassifiedTx["actionGuess"],
): { confidence: number; signals: string[] } {
  let score = 0.2;
  const signals: string[] = [];

  if (tx.signature) {
    score += 0.05;
    signals.push("has_signature");
  }

  if (tx.description) {
    score += 0.05;
    signals.push("has_description");
  }

  if (tx.source) {
    score += 0.05;
    signals.push("has_source");
  }

  if (tx.events?.swap) {
    score += 0.25;
    signals.push("has_swap_event");
  }

  if (activityType === "SWAP") {
    score += 0.15;
    signals.push("swap_activity");
  } else if (activityType === "TRANSFER") {
    score += 0.1;
    signals.push("transfer_activity");
  } else if (activityType === "ATA_CREATE") {
    score += 0.12;
    signals.push("ata_activity");
  }

  if (actionGuess === "BUY" || actionGuess === "SELL") {
    score += 0.15;
    signals.push("direction_resolved");
  }

  if (extractTokenMints(tx).length > 0) {
    score += 0.05;
    signals.push("token_mints_found");
  }

  if ((tx.instructions || []).length > 0) {
    score += 0.05;
    signals.push("instructions_present");
  }

  if (tx.transactionError?.error) {
    score -= 0.2;
    signals.push("transaction_error");
  }

  return {
    confidence: Number(Math.min(0.99, Math.max(0.01, score)).toFixed(2)),
    signals,
  };
}

function guessAction(
  tx: EnhancedTx,
  whale: string,
): "BUY" | "SELL" | "SWAP" | "UNKNOWN" {
  const swap = tx.events?.swap;
  if (!swap) {
    const type = upperClean(tx.type);
    if (type.includes("BUY")) return "BUY";
    if (type.includes("SELL")) return "SELL";
    if (type.includes("SWAP")) return "SWAP";
    return "UNKNOWN";
  }

  const tokenInFromWhale =
    (swap.tokenInputs || []).some((x) => x.userAccount === whale) ||
    (tx.tokenTransfers || []).some((x) => x.fromUserAccount === whale);

  const tokenOutToWhale =
    (swap.tokenOutputs || []).some((x) => x.userAccount === whale) ||
    (tx.tokenTransfers || []).some((x) => x.toUserAccount === whale);

  const nativeInputFromWhale = swap.nativeInput?.account === whale;
  const nativeOutputToWhale = swap.nativeOutput?.account === whale;

  // Whale spends SOL/native and receives token => BUY
  if (nativeInputFromWhale && tokenOutToWhale) return "BUY";

  // Whale sends token and receives SOL/native => SELL
  if (tokenInFromWhale && nativeOutputToWhale) return "SELL";

  if (
    tokenInFromWhale ||
    tokenOutToWhale ||
    nativeInputFromWhale ||
    nativeOutputToWhale
  ) {
    return "SWAP";
  }

  return "UNKNOWN";
}

function toUiAmount(tokenAmount?: string, decimals?: number): number {
  const raw = Number(tokenAmount || "0");
  if (!Number.isFinite(raw)) return 0;
  const denom = Math.pow(10, decimals || 0);
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return raw / denom;
}

function getNetTokenDelta(
  tx: EnhancedTx,
  whale: string,
): Array<{ mint: string; delta: number }> {
  const net = new Map<string, number>();

  for (const transfer of tx.tokenTransfers || []) {
    const mint = transfer.mint;
    if (!mint) continue;
    const amount = Number(transfer.tokenAmount || 0);
    if (!Number.isFinite(amount) || amount === 0) continue;

    let delta = 0;
    if (transfer.fromUserAccount === whale) delta -= amount;
    if (transfer.toUserAccount === whale) delta += amount;
    if (delta !== 0) {
      net.set(mint, (net.get(mint) || 0) + delta);
    }
  }

  const swap = tx.events?.swap;
  if (net.size === 0 && swap) {
    for (const input of swap.tokenInputs || []) {
      if (input.userAccount !== whale || !input.mint) continue;
      const amount = toUiAmount(
        input.rawTokenAmount?.tokenAmount,
        input.rawTokenAmount?.decimals,
      );
      if (amount !== 0) {
        net.set(input.mint, (net.get(input.mint) || 0) - amount);
      }
    }

    for (const output of swap.tokenOutputs || []) {
      if (output.userAccount !== whale || !output.mint) continue;
      const amount = toUiAmount(
        output.rawTokenAmount?.tokenAmount,
        output.rawTokenAmount?.decimals,
      );
      if (amount !== 0) {
        net.set(output.mint, (net.get(output.mint) || 0) + amount);
      }
    }
  }

  return [...net.entries()]
    .filter(([, delta]) => Math.abs(delta) > 1e-12)
    .map(([mint, delta]) => ({ mint, delta: Number(delta.toFixed(9)) }));
}

function isMultiLegTx(
  tx: EnhancedTx,
  netTokenDelta: Array<{ mint: string; delta: number }>,
): boolean {
  const innerSwapCount = tx.events?.swap?.innerSwaps?.length || 0;
  const directions = new Set(
    netTokenDelta.map((x) => (x.delta > 0 ? "IN" : "OUT")),
  );
  return innerSwapCount > 1 || netTokenDelta.length > 1 || directions.size > 1;
}

function resolveAction(
  tx: EnhancedTx,
  guessed: ClassifiedTx["actionGuess"],
  netTokenDelta: Array<{ mint: string; delta: number }>,
  whale: string,
): ClassifiedTx["resolvedAction"] {
  if (guessed === "BUY" || guessed === "SELL") return guessed;
  if (!isSwapLike(tx)) return guessed;

  const lamports = getSolChangeLamportsForWhale(tx, whale);
  const hasNetIn = netTokenDelta.some((x) => x.delta > 0);
  const hasNetOut = netTokenDelta.some((x) => x.delta < 0);

  if (lamports < 0 && hasNetIn && !hasNetOut) return "BUY";
  if (lamports > 0 && hasNetOut && !hasNetIn) return "SELL";

  if (hasNetIn || hasNetOut) return "SWAP";
  if (guessed === "SWAP") return "SWAP";

  return "UNKNOWN";
}

function getSkipReason(
  tx: EnhancedTx,
  resolvedAction: ClassifiedTx["resolvedAction"],
  confidence: number,
  isMultiLeg: boolean,
): string | null {
  if (tx.transactionError?.error) return "transaction_error";
  if (!isSwapLike(tx)) return "not_swap_like";
  if (resolvedAction === "UNKNOWN") return "unable_to_resolve_action";
  if (resolvedAction === "SWAP" && isMultiLeg) return "multi_leg_roundtrip";
  if (resolvedAction === "SWAP") return "swap_without_clear_side";
  if (confidence < 0.45) return "low_confidence";
  return null;
}

function getDirection(
  tx: EnhancedTx,
  whale: string,
): "IN" | "OUT" | "BOTH" | "NONE" {
  const lamports = getSolChangeLamportsForWhale(tx, whale);
  const tokenMints = extractTokenMints(tx);

  const hasIn =
    lamports > 0 ||
    (tx.nativeTransfers || []).some((n) => n.toUserAccount === whale) ||
    tokenMints.length > 0;
  const hasOut =
    lamports < 0 ||
    (tx.nativeTransfers || []).some((n) => n.fromUserAccount === whale) ||
    tokenMints.length > 1;

  if (hasIn && hasOut) return "BOTH";
  if (hasIn) return "IN";
  if (hasOut) return "OUT";
  return "NONE";
}

function isSwapLike(tx: EnhancedTx): boolean {
  if (tx.events?.swap) return true;

  const t = upperClean(tx.type);
  const d = upperClean(tx.description);
  const s = upperClean(tx.source);

  return (
    t.includes("SWAP") ||
    t.includes("BUY") ||
    t.includes("SELL") ||
    d.includes("SWAP") ||
    d.includes("BUY") ||
    d.includes("SELL") ||
    s.includes("JUPITER") ||
    s.includes("RAYDIUM") ||
    s.includes("ORCA") ||
    s.includes("PUMP") ||
    s.includes("METEORA")
  );
}

function classifyTx(tx: EnhancedTx, whale: string): ClassifiedTx {
  const programs = collectPrograms(tx);
  const programLabels = getProgramLabels(programs);
  const protocolTags = detectProtocolTags(tx);
  const activity = detectActivityType(tx);
  const actionGuess = guessAction(tx, whale);
  const confidence = detectConfidence(tx, activity.activityType, actionGuess);
  const netTokenDelta = getNetTokenDelta(tx, whale);
  const resolvedAction = resolveAction(tx, actionGuess, netTokenDelta, whale);
  const isMultiLeg = isMultiLegTx(tx, netTokenDelta);
  const skipReason = getSkipReason(
    tx,
    resolvedAction,
    confidence.confidence,
    isMultiLeg,
  );
  const shouldCopyTrade = skipReason === null;
  const lamports = getSolChangeLamportsForWhale(tx, whale);
  const hasError = Boolean(tx.transactionError?.error);
  const direction = getDirection(tx, whale);
  const signals = uniq([
    ...activity.signals,
    ...confidence.signals,
    `direction:${direction}`,
    ...programLabels.map((label) => `label:${label}`),
    ...(hasError ? ["tx_error"] : []),
  ]);

  return {
    signature: tx.signature || "",
    time: formatTime(tx.timestamp),
    slot: tx.slot,
    fee: tx.fee,
    feePayer: tx.feePayer,
    type: tx.type || "UNKNOWN",
    heliusSource: tx.source || "UNKNOWN",
    entrySource: guessEntrySource(tx),
    finalExecutor: guessFinalExecutor(tx),
    activityType: activity.activityType,
    activityDetail: activity.activityDetail,
    actionGuess,
    resolvedAction,
    isMultiLeg,
    netTokenDelta,
    shouldCopyTrade,
    skipReason,
    protocolPrimary: getPrimaryProtocolTag(tx),
    protocolTags,
    confidence: confidence.confidence,
    signals,
    isSwapLike: isSwapLike(tx),
    accountCount: getAccountCount(tx),
    tokenMints: extractTokenMints(tx),
    solChange: Number(getSolChangeForWhale(tx, whale).toFixed(9)),
    rawSolChangeLamports: lamports,
    description: tx.description || "",
    programs,
    programLabels,
    hasError,
    transactionError: tx.transactionError?.error,
  };
}

function buildSummary(items: ClassifiedTx[]): WhaleProfileSummary {
  const entryCounts: Record<string, number> = {};
  const executorCounts: Record<string, number> = {};
  const actionCounts: Record<string, number> = {};
  const resolvedActionCounts: Record<string, number> = {};
  const skipReasonCounts: Record<string, number> = {};
  const activityCounts: Record<string, number> = {};
  const confidenceBuckets: Record<string, number> = {};
  const protocolFamilyCounts: Record<string, number> = {};
  const tokenMintCounts: Record<string, number> = {};
  const programLabelCounts: Record<string, number> = {};
  const signalCounts: Record<string, number> = {};
  const protocolCounts: Record<string, number> = {};

  let totalSolChange = 0;
  let totalFee = 0;
  let totalConfidence = 0;
  let swapLikeCount = 0;
  let actionableCopyTrades = 0;
  let multiLegTransactions = 0;

  for (const item of items) {
    entryCounts[item.entrySource] = (entryCounts[item.entrySource] || 0) + 1;
    executorCounts[item.finalExecutor] =
      (executorCounts[item.finalExecutor] || 0) + 1;
    actionCounts[item.actionGuess] = (actionCounts[item.actionGuess] || 0) + 1;
    resolvedActionCounts[item.resolvedAction] =
      (resolvedActionCounts[item.resolvedAction] || 0) + 1;
    activityCounts[item.activityType] =
      (activityCounts[item.activityType] || 0) + 1;
    protocolCounts[item.heliusSource] =
      (protocolCounts[item.heliusSource] || 0) + 1;

    if (item.skipReason) {
      skipReasonCounts[item.skipReason] =
        (skipReasonCounts[item.skipReason] || 0) + 1;
    }

    for (const protocol of item.protocolTags) {
      protocolFamilyCounts[protocol] =
        (protocolFamilyCounts[protocol] || 0) + 1;
    }

    const bucket =
      item.confidence >= 0.8
        ? "high"
        : item.confidence >= 0.5
          ? "medium"
          : "low";
    confidenceBuckets[bucket] = (confidenceBuckets[bucket] || 0) + 1;

    totalSolChange += item.solChange;
    totalFee += item.fee || 0;
    totalConfidence += item.confidence;

    if (item.isSwapLike) swapLikeCount += 1;
    if (item.shouldCopyTrade) actionableCopyTrades += 1;
    if (item.isMultiLeg) multiLegTransactions += 1;

    for (const mint of item.tokenMints) {
      tokenMintCounts[mint] = (tokenMintCounts[mint] || 0) + 1;
    }

    for (const label of item.programLabels) {
      programLabelCounts[label] = (programLabelCounts[label] || 0) + 1;
    }

    for (const signal of item.signals) {
      signalCounts[signal] = (signalCounts[signal] || 0) + 1;
    }
  }

  const topTokenMints = Object.entries(tokenMintCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([mint, count]) => ({ mint, count }));

  const topProgramLabels = Object.entries(programLabelCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([label, count]) => ({ label, count }));

  const topActivitySignals = Object.entries(signalCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([signal, count]) => ({ signal, count }));

  const topProtocolFamilies = Object.entries(protocolFamilyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([protocol, count]) => ({ protocol, count }));

  const buySellRatio =
    actionCounts.SELL > 0
      ? Number((actionCounts.BUY / actionCounts.SELL).toFixed(2))
      : null;
  const resolvedBuySellRatio =
    resolvedActionCounts.SELL > 0
      ? Number(
          (resolvedActionCounts.BUY / resolvedActionCounts.SELL).toFixed(2),
        )
      : null;
  const averageSolChange =
    items.length > 0 ? Number((totalSolChange / items.length).toFixed(9)) : 0;
  const averageFee =
    items.length > 0 ? Number((totalFee / items.length).toFixed(0)) : 0;
  const averageConfidence =
    items.length > 0 ? Number((totalConfidence / items.length).toFixed(2)) : 0;

  const dominantEntry = Object.entries(entryCounts).sort(
    (a, b) => b[1] - a[1],
  )[0];
  const dominantActivity = Object.entries(activityCounts).sort(
    (a, b) => b[1] - a[1],
  )[0];
  const dominantToken = topTokenMints[0];
  const dominantProtocol = Object.entries(protocolCounts).sort(
    (a, b) => b[1] - a[1],
  )[0];

  return {
    totalTransactions: items.length,
    totalSwapLikeTransactions: swapLikeCount,
    totalTokenMintsObserved: items.reduce(
      (acc, item) => acc + item.tokenMints.length,
      0,
    ),
    uniqueTokenMints: Object.keys(tokenMintCounts).length,
    netSolChange: Number(totalSolChange.toFixed(9)),
    averageSolChange,
    averageFee,
    averageConfidence,
    buySellRatio,
    resolvedBuySellRatio,
    actionableCopyTrades,
    multiLegTransactions,
    protocolFamilies: protocolFamilyCounts,
    entrySource: entryCounts,
    finalExecutor: executorCounts,
    actionGuess: actionCounts,
    resolvedAction: resolvedActionCounts,
    skipReasons: skipReasonCounts,
    activityType: activityCounts,
    confidenceBuckets,
    topTokenMints,
    topProgramLabels,
    topActivitySignals,
    protocolMix: Object.entries(protocolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({ source, count })),
    topProtocolFamilies,
    humanSummary: [
      `Wallet activity is dominated by ${dominantEntry ? dominantEntry[0] : "unknown"} entry paths.`,
      `Most common activity type: ${dominantActivity ? dominantActivity[0] : "unknown"}.`,
      protocolFamilyCounts.JUPITER
        ? `Primary protocol family: JUPITER (${protocolFamilyCounts.JUPITER} tx mentions).`
        : "Primary protocol family not detected.",
      topProtocolFamilies.length > 0
        ? `Top protocol families include ${topProtocolFamilies
            .slice(0, 3)
            .map(
              (x: { protocol: string; count: number }) =>
                `${x.protocol} (${x.count})`,
            )
            .join(", ")}.`
        : "No protocol family counts available.",
      dominantToken
        ? `Top observed token mint: ${dominantToken.mint} (${dominantToken.count} appearances).`
        : "No token mints observed.",
      dominantProtocol
        ? `Primary protocol source: ${dominantProtocol[0]} (${dominantProtocol[1]} tx).`
        : "No protocol source observed.",
      `Net SOL change across window: ${Number(totalSolChange.toFixed(9))}.`,
      `Average fee: ${averageFee} lamports; average confidence: ${averageConfidence}.`,
      `Actionable copytrade signals: ${actionableCopyTrades}/${items.length}.`,
      `Multi-leg signatures detected: ${multiLegTransactions}.`,
      buySellRatio !== null
        ? `BUY/SELL ratio: ${buySellRatio}.`
        : "BUY/SELL ratio not available.",
      resolvedBuySellRatio !== null
        ? `Resolved BUY/SELL ratio: ${resolvedBuySellRatio}.`
        : "Resolved BUY/SELL ratio not available.",
    ],
  };
}

async function main() {
  const history = await fetchHistory(WHALE_ADDRESS, TX_LIMIT);
  const filtered = SHOW_ONLY_SWAP_LIKE ? history.filter(isSwapLike) : history;
  const classified = filtered.map((tx) => classifyTx(tx, WHALE_ADDRESS));

  const reparsedTransactions: WhaleProfileOutput["reparsedTransactions"] = [];

  const sigs = classified
    .map((x) => x.signature)
    .filter(Boolean)
    .slice(0, 5);

  if (sigs.length > 0) {
    const reparsed = await parseTransactions(sigs);
    const reparsedClassified = reparsed.map((tx) =>
      classifyTx(tx, WHALE_ADDRESS),
    );

    for (const tx of reparsedClassified) {
      reparsedTransactions.push({
        signature: tx.signature,
        entrySource: tx.entrySource,
        finalExecutor: tx.finalExecutor,
        actionGuess: tx.actionGuess,
        resolvedAction: tx.resolvedAction,
        shouldCopyTrade: tx.shouldCopyTrade,
        skipReason: tx.skipReason,
        heliusSource: tx.heliusSource,
        description: tx.description,
      });
    }
  }

  const output: WhaleProfileOutput = {
    whaleAddress: WHALE_ADDRESS,
    txLimit: TX_LIMIT,
    showOnlySwapLike: SHOW_ONLY_SWAP_LIKE,
    summary: buildSummary(classified),
    transactions: classified,
    metadata: {
      generatedAt: new Date().toISOString(),
      totalTransactions: history.length,
      filteredTransactions: classified.length,
      reparsedTransactionCount: reparsedTransactions.length,
      walletActivityWindow: {
        firstTime: classified.at(-1)?.time || "-",
        lastTime: classified[0]?.time || "-",
      },
    },
    reparsedTransactions,
  };

  const fileName = process.env.WHALE_OVERRIDE
    ? `whale-profile-${WHALE_ADDRESS.slice(0, 8)}.json`
    : "whale-profile.json";
  const outputPath = path.resolve(process.cwd(), fileName);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`Saved JSON to ${outputPath}`);
  console.log(JSON.stringify(output.summary, null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
