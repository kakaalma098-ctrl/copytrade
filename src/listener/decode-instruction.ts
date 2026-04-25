import bs58 from "bs58";
import type {
  ProtocolHint,
  RawWhaleTransaction,
  WhaleFeedSource,
} from "../types/index.js";
import { queueInstructionDrop } from "../perf/instruction-drop-log.js";

/**
 * Frame for instruction-level whale tx decoding (preprocessed laserstream).
 * Unlike WhaleMetaFrame, there is NO meta — decoder must derive BUY/SELL,
 * mints, and SOL exposure entirely from the transaction message itself.
 */
export type WhaleInstructionFrame = {
  whale: string;
  signature: string;
  /** All resolved account keys (static + ALT-resolved writable + readonly). */
  accountKeys: string[];
  /** Top-level compiled instructions. CPIs are NOT visible in preprocessed. */
  instructions: Array<{
    programIdIndex: number;
    accountIndices: number[];
    data: Uint8Array;
  }>;
  feedSource: WhaleFeedSource;
  ingestedAtMs: number;
  /** Diagnostic only — true when the source tx had a versioned message with ALT lookups. */
  versioned?: boolean;
  /** Diagnostic only — number of ALT entries the message referenced. */
  altCount?: number;
};

const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Anchor-style 8-byte discriminators (from each program's IDL). */
const DISC_BUY = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);
const DISC_SELL = new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]);
/** Pump.fun bonding curve `buy_exact_sol_in`: args spendable_sol_in (u64), min_tokens_out (u64). */
const DISC_PUMP_BUY_EXACT_SOL = new Uint8Array([
  56, 252, 116, 8, 158, 223, 205, 95,
]);
/** PumpSwap `buy_exact_quote_in`: args spendable_quote_in (u64), min_base_amount_out (u64). */
const DISC_PUMPSWAP_BUY_EXACT_QUOTE = new Uint8Array([
  198, 46, 21, 82, 180, 217, 232, 112,
]);
// Legacy V1 Jupiter v6 instructions (sha256("global:<snake_name>")[0..8]).
const DISC_JUP_ROUTE = new Uint8Array([229, 23, 203, 151, 122, 227, 173, 42]); // route → e517cb977ae3ad2a
const DISC_JUP_SHARED_ROUTE = new Uint8Array([
  193, 32, 155, 51, 65, 214, 156, 129,
]); // shared_accounts_route → c1209b3341d69c81
const DISC_JUP_EXACT_OUT = new Uint8Array([
  208, 51, 239, 151, 123, 43, 237, 92,
]); // exact_out_route → d033ef977b2bed5c
const DISC_JUP_SHARED_EXACT_OUT = new Uint8Array([
  176, 209, 105, 168, 154, 125, 69, 62,
]); // shared_accounts_exact_out_route → b0d169a89a7d453e
// V2 Jupiter v6 instructions (added 2025; introduced positive_slippage_bps + RoutePlanStepV2).
const DISC_JUP_ROUTE_V2 = new Uint8Array([
  187, 100, 250, 204, 49, 196, 175, 20,
]); // route_v2 → bb64facc31c4af14
const DISC_JUP_SHARED_ROUTE_V2 = new Uint8Array([
  209, 152, 83, 147, 124, 254, 216, 233,
]); // shared_accounts_route_v2 → d19853937cfed8e9
const DISC_JUP_EXACT_OUT_V2 = new Uint8Array([
  157, 138, 184, 82, 21, 244, 243, 36,
]); // exact_out_route_v2 → 9d8ab85215f4f324
const DISC_JUP_SHARED_EXACT_OUT_V2 = new Uint8Array([
  53, 96, 229, 202, 216, 187, 250, 24,
]); // shared_accounts_exact_out_route_v2 → 3560e5cad8bbfa18

const eqDisc = (data: Uint8Array, disc: Uint8Array): boolean => {
  if (data.length < disc.length) return false;
  for (let i = 0; i < disc.length; i++) {
    if (data[i] !== disc[i]) return false;
  }
  return true;
};

const readU64LE = (data: Uint8Array, offset: number): bigint => {
  if (offset + 8 > data.length) {
    return 0n;
  }
  const buf = data.subarray(offset, offset + 8);
  return (
    BigInt(buf[0]!) |
    (BigInt(buf[1]!) << 8n) |
    (BigInt(buf[2]!) << 16n) |
    (BigInt(buf[3]!) << 24n) |
    (BigInt(buf[4]!) << 32n) |
    (BigInt(buf[5]!) << 40n) |
    (BigInt(buf[6]!) << 48n) |
    (BigInt(buf[7]!) << 56n)
  );
};

const lamportsToSol = (lamports: bigint): number => {
  if (lamports <= 0n) return 0;
  return Number(lamports) / 1_000_000_000;
};

type DecodedSwap = {
  side: "BUY" | "SELL";
  protocol: ProtocolHint;
  tokenMint: string;
  /** SOL exposure: max_sol_cost (BUY) or min_sol_output (SELL), in SOL units. */
  amountSol: number;
};

/**
 * Pump.fun bonding curve buy/sell.
 * - BUY accounts: [global, fee_recipient, mint(2), bonding_curve, ...associated_user, user(5)...]
 * - SELL accounts: same layout for first 6
 *   args BUY:  amount(u64) tokens, max_sol_cost(u64), track_volume(OptionBool)
 *   args SELL: amount(u64) tokens, min_sol_output(u64)
 */
const decodePumpFun = (
  ix: { accountIndices: number[]; data: Uint8Array },
  accountKeys: string[],
): DecodedSwap | null => {
  const data = ix.data;
  const isBuy = eqDisc(data, DISC_BUY);
  const isSell = !isBuy && eqDisc(data, DISC_SELL);
  // buy_exact_sol_in: alternative entry where the FIRST u64 IS the SOL spend
  // (spendable_sol_in). Common in newer Pump.fun trading UIs.
  const isBuyExactSol =
    !isBuy && !isSell && eqDisc(data, DISC_PUMP_BUY_EXACT_SOL);
  if (!isBuy && !isSell && !isBuyExactSol) return null;
  if (ix.accountIndices.length < 6) return null;

  const mintIdx = ix.accountIndices[2];
  if (mintIdx == null) return null;
  const mint = accountKeys[mintIdx];
  if (mint == null || mint === NATIVE_SOL_MINT) return null;

  // BUY (legacy): args[1] = max_sol_cost (SOL upper bound)
  // SELL:        args[1] = min_sol_output (SOL lower bound)
  // BUY exact-sol: args[0] = spendable_sol_in (SOL exact spend) ← preferred
  const solBound = isBuyExactSol ? readU64LE(data, 8) : readU64LE(data, 8 + 8);
  return {
    side: isSell ? "SELL" : "BUY",
    protocol: "PUMPFUN",
    tokenMint: mint,
    amountSol: lamportsToSol(solBound),
  };
};

/**
 * PumpSwap AMM (pAMMBay…). Same Anchor discriminators as bonding curve, BUT:
 *   accounts: [pool, user(1), global_config, base_mint(3), quote_mint(4), ...]
 *   args BUY:  base_amount_out(u64) tokens, max_quote_amount_in(u64) SOL upper, track_volume
 *   args SELL: base_amount_in(u64) tokens, min_quote_amount_out(u64) SOL lower
 */
const decodePumpSwap = (
  ix: { accountIndices: number[]; data: Uint8Array },
  accountKeys: string[],
): DecodedSwap | null => {
  const data = ix.data;
  const isBuy = eqDisc(data, DISC_BUY);
  const isSell = !isBuy && eqDisc(data, DISC_SELL);
  // buy_exact_quote_in: SOL spend is the FIRST u64 (spendable_quote_in).
  const isBuyExactQuote =
    !isBuy && !isSell && eqDisc(data, DISC_PUMPSWAP_BUY_EXACT_QUOTE);
  if (!isBuy && !isSell && !isBuyExactQuote) return null;
  if (ix.accountIndices.length < 5) return null;

  const baseIdx = ix.accountIndices[3];
  const quoteIdx = ix.accountIndices[4];
  if (baseIdx == null || quoteIdx == null) return null;
  const baseMint = accountKeys[baseIdx];
  const quoteMint = accountKeys[quoteIdx];
  if (baseMint == null || quoteMint == null) return null;

  // PumpSwap pools we care about pair against WSOL on the quote side. If that
  // is not the case, we cannot translate the SOL exposure cleanly — drop.
  const tokenMint = quoteMint === NATIVE_SOL_MINT ? baseMint : null;
  if (tokenMint == null || tokenMint === NATIVE_SOL_MINT) return null;

  // buy/sell legacy: args[1] is the SOL bound (max_quote_amount_in or
  // min_quote_amount_out). buy_exact_quote_in: args[0] is the exact SOL spend.
  const solBound = isBuyExactQuote
    ? readU64LE(data, 8)
    : readU64LE(data, 8 + 8);
  return {
    side: isSell ? "SELL" : "BUY",
    protocol: "PUMPSWAP",
    tokenMint,
    amountSol: lamportsToSol(solBound),
  };
};

/**
 * Jupiter v6 decoder covering V1 (`route`, `shared_accounts_route`,
 * `exact_out_route`, `shared_accounts_exact_out_route`) and V2 variants
 * introduced 2025 (`route_v2`, `shared_accounts_route_v2`,
 * `exact_out_route_v2`, `shared_accounts_exact_out_route_v2`).
 *
 * Without inner instructions we infer BUY/SELL by checking which side of the
 * mint pair is WSOL. Routes that never touch WSOL are skipped (the bot only
 * trades SOL pairs).
 *
 * Account layouts (fixed prefix; route_plan vector follows in args):
 *
 *   route                        [tokenProg, signer, srcTA, dstTA, dstTAopt, srcMint(5), dstMint(6), ...]
 *   route_v2                     [signer(0), srcTA, dstTA, srcMint(3), dstMint(4), ...]
 *   shared_accounts_route        [tokenProg, progAuth, signer(2), srcTA, pSrcTA, pDstTA, dstTA,
 *                                 srcMint(7), dstMint(8), ...]
 *   shared_accounts_route_v2     [progAuth, signer(1), srcTA, pSrcTA, pDstTA, dstTA, srcMint(6), dstMint(7), ...]
 *
 * The exact_out_* variants share the same account layout as their
 * non-exact-out counterparts, only the args differ.
 */
const decodeJupiterV6 = (
  ix: { accountIndices: number[]; data: Uint8Array },
  accountKeys: string[],
): DecodedSwap | null => {
  const data = ix.data;
  let mintOffsetSource: number | null = null;
  let mintOffsetDest: number | null = null;
  // Offset into ix.data where in_amount (or out_amount for exact-out) starts.
  // V1 args: route_plan first (vec), so the u64 amount sits AFTER the vector
  //   → unknown without parsing route_plan ⇒ amountOffset = null (fallback).
  // V2 args: amounts come BEFORE route_plan, so we can read them directly:
  //   route_v2:                     in_amount@8
  //   shared_accounts_route_v2:     id(1) + in_amount@9
  //   exact_out_route_v2:           out_amount@8 (we don't use)
  //   shared_accounts_exact_out_v2: id(1) + out_amount@9 (we don't use)
  let amountOffset: number | null = null;
  let isExactOut = false;

  if (eqDisc(data, DISC_JUP_ROUTE)) {
    mintOffsetSource = 5;
    mintOffsetDest = 6;
  } else if (eqDisc(data, DISC_JUP_SHARED_ROUTE)) {
    mintOffsetSource = 7;
    mintOffsetDest = 8;
  } else if (eqDisc(data, DISC_JUP_EXACT_OUT)) {
    mintOffsetSource = 5;
    mintOffsetDest = 6;
    isExactOut = true;
  } else if (eqDisc(data, DISC_JUP_SHARED_EXACT_OUT)) {
    mintOffsetSource = 7;
    mintOffsetDest = 8;
    isExactOut = true;
  } else if (eqDisc(data, DISC_JUP_ROUTE_V2)) {
    mintOffsetSource = 3;
    mintOffsetDest = 4;
    amountOffset = 8; // in_amount immediately after disc
  } else if (eqDisc(data, DISC_JUP_SHARED_ROUTE_V2)) {
    mintOffsetSource = 6;
    mintOffsetDest = 7;
    amountOffset = 9; // disc(8) + id(1) + in_amount
  } else if (eqDisc(data, DISC_JUP_EXACT_OUT_V2)) {
    mintOffsetSource = 3;
    mintOffsetDest = 4;
    isExactOut = true;
  } else if (eqDisc(data, DISC_JUP_SHARED_EXACT_OUT_V2)) {
    mintOffsetSource = 6;
    mintOffsetDest = 7;
    isExactOut = true;
  } else {
    return null;
  }

  if (ix.accountIndices.length <= mintOffsetDest || mintOffsetSource == null) {
    return null;
  }
  const sourceIdx = ix.accountIndices[mintOffsetSource];
  const destIdx = ix.accountIndices[mintOffsetDest];
  if (sourceIdx == null || destIdx == null) return null;
  const sourceMint = accountKeys[sourceIdx];
  const destMint = accountKeys[destIdx];
  if (sourceMint == null || destMint == null) return null;

  const sourceIsSol = sourceMint === NATIVE_SOL_MINT;
  const destIsSol = destMint === NATIVE_SOL_MINT;
  // Bot only follows SOL <-> token. Skip token/token routes.
  if (sourceIsSol === destIsSol) return null;

  const tokenMint = sourceIsSol ? destMint : sourceMint;
  const side: "BUY" | "SELL" = sourceIsSol ? "BUY" : "SELL";

  // Resolve SOL exposure:
  //   BUY (source=WSOL): amount IS the lamports the whale pays (in_amount).
  //   SELL: token-units in, SOL out. The bot uses its own balance for SELL,
  //         so we always emit 0 there.
  //   exact-out routes: the user-supplied number is OUT, not IN, so we cannot
  //         recover SOL spend without parsing the quote → fallback to Infinity.
  //   V1 routes: route_plan is the FIRST arg, so the u64 amount sits after a
  //         variable-length vector → also Infinity fallback.
  let amountSol: number;
  if (side === "SELL") {
    amountSol = 0;
  } else if (isExactOut || amountOffset == null) {
    amountSol = Number.POSITIVE_INFINITY;
  } else {
    amountSol = lamportsToSol(readU64LE(data, amountOffset));
    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      amountSol = Number.POSITIVE_INFINITY;
    }
  }

  return {
    side,
    protocol: "UNKNOWN",
    tokenMint,
    amountSol,
  };
};

/**
 * Walk the top-level instructions, return the FIRST recognized whale-driven
 * swap. Instruction order matters: pump.fun txs that wrap SOL first will have
 * a System or Token program ix before the actual swap, so we skip until match.
 */
const decodeFirstSwap = (frame: WhaleInstructionFrame): DecodedSwap | null => {
  for (const ix of frame.instructions) {
    const programIdx = ix.programIdIndex;
    const programId = frame.accountKeys[programIdx];
    if (programId == null) continue;

    if (programId === PUMP_FUN_PROGRAM) {
      const r = decodePumpFun(ix, frame.accountKeys);
      if (r != null) return r;
    } else if (programId === PUMP_SWAP_PROGRAM) {
      const r = decodePumpSwap(ix, frame.accountKeys);
      if (r != null) return r;
    } else if (programId === JUPITER_V6_PROGRAM) {
      const r = decodeJupiterV6(ix, frame.accountKeys);
      if (r != null) return r;
    }
  }
  return null;
};

/**
 * Convert a raw preprocessed transaction frame into the bot-internal
 * RawWhaleTransaction shape. Returns null when no recognizable swap was found
 * or the swap touches accounts that do not belong to the whale.
 *
 * Without meta we cannot compute whaleSellFraction; SELL signals leave it
 * undefined which the engine treats as "sell 100%". The user accepts this
 * tradeoff in instruction-decode mode.
 */
export const decodeWhaleInstruction = (
  frame: WhaleInstructionFrame,
  onDrop?: (reason: string) => void,
): RawWhaleTransaction | null => {
  if (!frame.accountKeys.includes(frame.whale)) {
    onDrop?.("whale_not_in_account_keys");
    return null;
  }

  const now = Date.now();
  const swap = decodeFirstSwap(frame);
  if (swap == null) {
    // Build a complete diagnostic record: every top-level instruction with
    // its program id, first 16 bytes of data (the discriminator), and account
    // count. Console gets a one-line summary; JSONL captures the full payload
    // so the operator can analyse offline without reproducing the tx.
    const ixDetail = frame.instructions.map((ix) => {
      const programId = frame.accountKeys[ix.programIdIndex] ?? "<oob>";
      const head = ix.data.subarray(0, Math.min(16, ix.data.length));
      const discriminatorHex = Array.from(head)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return {
        programId,
        discriminatorHex,
        accountIndices: ix.accountIndices,
        dataLen: ix.data.length,
      };
    });

    if (onDrop != null) {
      // Console summary: program 8-char prefix + first 16 hex chars (= 8 byte
      // discriminator) per ix, so the operator can recognise patterns at a glance.
      const summary = ixDetail
        .map(
          (d) =>
            `${d.programId.slice(0, 8)}:${d.discriminatorHex.slice(0, 16)}`,
        )
        .join(" | ");
      onDrop(`no_recognized_swap_ix ix=[${summary}]`);
    }

    queueInstructionDrop({
      signature: frame.signature,
      whale: frame.whale,
      reason: "no_recognized_swap_ix",
      detectedAtMs: now,
      versioned: frame.versioned ?? false,
      altCount: frame.altCount ?? 0,
      accountKeys: frame.accountKeys,
      instructions: ixDetail,
    });
    return null;
  }

  const ingestedAtMs = Number.isFinite(frame.ingestedAtMs)
    ? frame.ingestedAtMs
    : now;

  if (swap.side === "BUY") {
    return {
      wallet: frame.whale,
      type: "BUY",
      protocolHint: swap.protocol,
      tokenIn: NATIVE_SOL_MINT,
      tokenOut: swap.tokenMint,
      amount: swap.amountSol,
      feedSource: frame.feedSource,
      ingestedAtMs,
      signature: frame.signature,
      timestamp: now,
      detectedAtMs: now,
    };
  }

  return {
    wallet: frame.whale,
    type: "SELL",
    protocolHint: swap.protocol,
    tokenIn: swap.tokenMint,
    tokenOut: NATIVE_SOL_MINT,
    amount: swap.amountSol,
    // sellFraction unavailable in instruction mode — engine uses full balance.
    whaleSellFraction: undefined,
    feedSource: frame.feedSource,
    ingestedAtMs,
    signature: frame.signature,
    timestamp: now,
    detectedAtMs: now,
  };
};

/** Exposed so the laserstream client can match whales by base58 pubkey. */
export const accountKeyToBase58 = (k: Uint8Array | string): string => {
  if (typeof k === "string") return k;
  try {
    return bs58.encode(k);
  } catch {
    return "";
  }
};
