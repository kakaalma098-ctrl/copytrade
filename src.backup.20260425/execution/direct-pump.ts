import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import { PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import BN from "bn.js";
import type { ExecutionIntent, ExecutionResult } from "../types/index.js";
import type { BlockhashCache } from "../perf/blockhash-cache.js";
import {
  PumpStateCache,
  getSharedPumpStateCache,
} from "../perf/pump-state-cache.js";
import { metrics } from "../runtime/metrics-registry.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_MINT_PK = new PublicKey(SOL_MINT);
const SPL_TOKEN_CLOSE_ACCOUNT_DISCRIMINATOR = 9;

// Persistent WSOL flag — when true, PumpSwap executor strips the SDK's
// cleanup closeAccount(userWsolAta) ix so the ATA survives across swaps.
let keepPersistentWsol = false;

/**
 * Optional predicate: return true when the SELL output should STAY in WSOL
 * (strip the SDK close ix), false when it should be unwrapped back to native
 * SOL (let the SDK close ix run, closing the ATA and refunding rent). When
 * null, the legacy behaviour applies (always strip close when persistent
 * WSOL is enabled). Used to cap WSOL accumulation at the configured target.
 */
let shouldKeepWsolPredicate: (() => boolean) | null = null;

export function setDirectPumpPersistentWsol(
  enabled: boolean,
  shouldKeepWsol?: () => boolean,
): void {
  keepPersistentWsol = enabled;
  shouldKeepWsolPredicate = shouldKeepWsol ?? null;
}

/**
 * Phase 5: rolling outcome tracker for direct-pump executors (PUMPFUN /
 * PUMPSWAP). Populated from the confirmation path (sync throw OR fast-ack
 * bg confirm). The engine consults `getDirectPumpRevertRate` to skip the
 * direct path when the recent revert rate is too high — cached Jupiter
 * prebuild or fresh Jupiter quote is more reliable in that regime.
 */
type DirectPumpOutcome = { ok: boolean; ts: number };
const DIRECT_PUMP_WINDOW = 30;
const directPumpOutcomes = new Map<string, DirectPumpOutcome[]>();

const recordDirectPumpOutcome = (label: string, ok: boolean): void => {
  const arr = directPumpOutcomes.get(label) ?? [];
  arr.push({ ok, ts: Date.now() });
  if (arr.length > DIRECT_PUMP_WINDOW) {
    arr.splice(0, arr.length - DIRECT_PUMP_WINDOW);
  }
  directPumpOutcomes.set(label, arr);
  metrics.inc("laser_direct_pump_outcome_total", {
    protocol: label,
    result: ok ? "ok" : "revert",
  });
};

export const getDirectPumpRevertRate = (
  label: string,
): { rate: number; samples: number } => {
  const arr = directPumpOutcomes.get(label) ?? [];
  if (arr.length === 0) {
    return { rate: 0, samples: 0 };
  }
  const reverts = arr.filter((o) => !o.ok).length;
  return { rate: reverts / arr.length, samples: arr.length };
};

const toCommitment = (
  value: "processed" | "confirmed" | "finalized",
): Commitment => value;

const toBuyLamports = (sizeSol: number): bigint => {
  if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
    return 0n;
  }
  return BigInt(Math.floor(sizeSol * 1_000_000_000));
};

const validateRaw = (raw: string): string => {
  const v = raw.trim();
  if (!/^\d+$/.test(v) || v === "0") {
    throw new Error(`invalid raw amount: ${raw}`);
  }
  return v;
};

let sharedBlockhashCache: BlockhashCache | undefined;

export function setDirectPumpBlockhashCache(cache: BlockhashCache): void {
  sharedBlockhashCache = cache;
}

const getBlockhash = async (
  connection: Connection,
  commitment: Commitment,
): Promise<{ blockhash: string; lastValidBlockHeight: number }> =>
  sharedBlockhashCache
    ? sharedBlockhashCache.getBlockhash()
    : connection.getLatestBlockhash(commitment);

/**
 * Context passed from the engine to wire direct-pump into the shared tip +
 * multi-sender race infrastructure. Without this, direct-pump would bypass
 * both (sending tip-less via a single RPC), causing Helius Sender to drop the
 * tx and Jito to ignore it entirely.
 */
export type PumpSendContext = {
  /** Tip ixs appended to the instruction list before compile+sign. Single tip
   *  to the configured senderMode (Helius or Jito). */
  tipIxs?: TransactionInstruction[];
  /** Send function override. When set, replaces `connection.sendRawTransaction`
   *  so direct-pump benefits from Helius/Jito/RPC multi-sender race + the
   *  healthcheck gating. */
  sendRaw?: (raw: Uint8Array) => Promise<string>;
};

const finalizeAndSend = async (
  connection: Connection,
  taker: Keypair,
  ixs: TransactionInstruction[],
  commitment: "processed" | "confirmed" | "finalized",
  opts: {
    fastAck: boolean;
    protocolLabel?: string;
    sendContext?: PumpSendContext;
  } = { fastAck: false },
): Promise<string> => {
  const latest = await getBlockhash(connection, toCommitment(commitment));
  const tipIxs = opts.sendContext?.tipIxs ?? [];
  const finalIxs = tipIxs.length > 0 ? [...ixs, ...tipIxs] : ixs;
  const msg = new TransactionMessage({
    payerKey: taker.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: finalIxs,
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([taker]);
  const raw = vtx.serialize();
  const sig = opts.sendContext?.sendRaw
    ? await opts.sendContext.sendRaw(raw)
    : await connection.sendRawTransaction(raw, {
        skipPreflight: true,
        maxRetries: 2,
      });

  if (opts.fastAck) {
    // Fire-and-forget confirm in background — match main engine BUY behaviour
    // (status=submitted). Logs any on-chain revert for observability and
    // records the outcome for the direct-pump revert-rate circuit breaker.
    void connection
      .confirmTransaction(
        {
          signature: sig,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        toCommitment(commitment),
      )
      .then((res) => {
        const ok = res.value?.err == null;
        if (opts.protocolLabel != null) {
          recordDirectPumpOutcome(opts.protocolLabel, ok);
        }
        if (!ok) {
          console.warn(
            `[direct-pump] fast-ack tx reverted sig=${sig} err=${JSON.stringify(res.value?.err)}`,
          );
        }
      })
      .catch(() => {
        /* confirm errors are non-fatal for fast-ack path */
      });
    return sig;
  }

  const confirmRes = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    toCommitment(commitment),
  );
  // confirmTransaction resolves on slot landing — a reverted tx lands too. Must
  // check `value.err` to distinguish on-chain failure from success.
  if (confirmRes.value?.err != null) {
    if (opts.protocolLabel != null) {
      recordDirectPumpOutcome(opts.protocolLabel, false);
    }
    const errJson = JSON.stringify(confirmRes.value.err);
    throw new Error(`tx reverted on-chain sig=${sig} err=${errJson}`);
  }
  if (opts.protocolLabel != null) {
    recordDirectPumpOutcome(opts.protocolLabel, true);
  }
  return sig;
};

/**
 * Optional Helius-backed priority-fee cache. When set, `computeBudgetIxs`
 * reads the current recommended micro-lamports value instead of the hardcoded
 * fallback. Always sync (0ms hot-path cost) — the cache refreshes in the
 * background. See `PriorityFeeCache` in `perf/priority-fee-cache.ts`.
 */
let priorityFeeCache: { getMicroLamports(): number } | null = null;

export function setDirectPumpPriorityFeeCache(
  cache: { getMicroLamports(): number } | null,
): void {
  priorityFeeCache = cache;
}

const computeBudgetIxs = (
  unitLimit = 220_000,
  microLamportsOverride?: number,
): TransactionInstruction[] => {
  const microLamports =
    microLamportsOverride ?? priorityFeeCache?.getMicroLamports() ?? 100_000;
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
};

const slippagePctFromBps = (bps: number): number =>
  Math.max(0, Math.min(99.99, bps / 100));

// Reuse SDK package-level singletons. Anchor program init + IDL parsing
// happen once per process, not per swap.
const ensureCache = (
  connection: Connection,
  commitment: Commitment,
): PumpStateCache => {
  const shared = getSharedPumpStateCache();
  if (shared != null) {
    return shared;
  }
  // Fallback: script / test paths that don't wire the shared cache. One-off
  // allocation, no warmup — fine for non-hot-path usage.
  return new PumpStateCache(connection, commitment);
};

/**
 * Pump.fun bonding-curve direct executor (pre-migration tokens).
 */
export const executeViaPumpFunSdk = async (
  connection: Connection,
  taker: Keypair,
  intent: ExecutionIntent,
  slippageBps: number,
  commitment: "processed" | "confirmed" | "finalized",
  sendContext?: PumpSendContext,
): Promise<ExecutionResult> => {
  const started = Date.now();
  const tokenMint = new PublicKey(intent.token);
  const slippage = slippagePctFromBps(slippageBps);
  const cache = ensureCache(connection, toCommitment(commitment));
  const user = taker.publicKey;

  // Token program lookup first: allows the dynamic-state fetch to bundle the
  // mint in its single getMultipleAccountsInfo call when not yet cached.
  const tokenProgram = await cache.getTokenProgram(tokenMint);

  const preIxs: TransactionInstruction[] = [...computeBudgetIxs()];
  const postIxs: TransactionInstruction[] = [];
  let swapIxs: TransactionInstruction[] = [];

  if (intent.side === "BUY") {
    const solLamports = toBuyLamports(intent.size);
    if (solLamports <= 0n) throw new Error("pump-bonding: invalid buy size");

    const [{ global, feeConfig }, dynamic] = await Promise.all([
      cache.getPumpStatic(),
      cache.fetchPumpFunBuyDynamic(tokenMint, user, tokenProgram),
    ]);

    const solAmountBN = new BN(solLamports.toString());
    const tokenAmountBN = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: dynamic.mintSupply,
      bondingCurve: dynamic.bondingCurve,
      amount: solAmountBN,
    });
    if (tokenAmountBN.lten(0)) {
      throw new Error("pump-bonding: buy would yield zero tokens");
    }

    swapIxs = await PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo: dynamic.bondingCurveAccountInfo,
      bondingCurve: dynamic.bondingCurve,
      associatedUserAccountInfo: dynamic.associatedUserAccountInfo,
      mint: tokenMint,
      user,
      amount: tokenAmountBN,
      solAmount: solAmountBN,
      slippage,
      tokenProgram,
    });
  } else {
    const rawAmount = validateRaw(intent.sellTokenAmountRaw ?? "0");
    const tokenAmountBN = new BN(rawAmount);

    const [{ global, feeConfig }, dynamic] = await Promise.all([
      cache.getPumpStatic(),
      cache.fetchPumpFunSellDynamic(tokenMint, user, tokenProgram),
    ]);

    const solAmountBN = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: dynamic.mintSupply,
      bondingCurve: dynamic.bondingCurve,
      amount: tokenAmountBN,
    });
    if (solAmountBN.lten(0)) {
      throw new Error("pump-bonding: sell would yield zero SOL");
    }

    swapIxs = await PUMP_SDK.sellInstructions({
      global,
      bondingCurveAccountInfo: dynamic.bondingCurveAccountInfo,
      bondingCurve: dynamic.bondingCurve,
      mint: tokenMint,
      user,
      amount: tokenAmountBN,
      solAmount: solAmountBN,
      slippage,
      tokenProgram,
      mayhemMode: false,
    });
  }

  // Phase 2+5: fast-ack for BOTH BUY and SELL (respecting explicit
  // forceSyncConfirm=true escape hatch). BG drain covers SELL on-chain
  // reverts via balance polling, so sync confirm is no longer required.
  const useFastAck = intent.forceSyncConfirm !== true;
  const sig = await finalizeAndSend(
    connection,
    taker,
    [...preIxs, ...swapIxs, ...postIxs],
    commitment,
    { fastAck: useFastAck, protocolLabel: "PUMPFUN", sendContext },
  );

  return {
    signature: sig,
    status: useFastAck ? "submitted" : "confirmed",
    whaleWallet: intent.whaleWallet,
    token: intent.token,
    side: intent.side,
    sizeSol: intent.size,
    executionStageMs: { quoteBuildMs: Date.now() - started },
  };
};

/**
 * Detect SDK's cleanup `closeAccount(userWsolAta, ...)` ix. SPL Token
 * closeAccount uses single-byte discriminator 0x09 and the account being
 * closed is always `keys[0]`. Matching both the programId and the target
 * account avoids accidentally stripping unrelated close-account ixs.
 */
const isCloseOfAccount = (
  ix: TransactionInstruction,
  target: PublicKey,
): boolean => {
  if (!ix.programId.equals(TOKEN_PROGRAM_ID)) return false;
  if (ix.data.length < 1) return false;
  if (ix.data[0] !== SPL_TOKEN_CLOSE_ACCOUNT_DISCRIMINATOR) return false;
  if (ix.keys.length < 1) return false;
  return ix.keys[0].pubkey.equals(target);
};

/**
 * Remove SDK's post-swap `closeAccount(userWsolAta)` so the persistent
 * WSOL ATA survives across swaps. Matches both BUY (outer wrapper close)
 * and SELL (inner-block close) call sites in `withWsolAccount`.
 */
const stripPersistentWsolCloses = (
  ixs: TransactionInstruction[],
  userWsolAta: PublicKey,
): TransactionInstruction[] =>
  ixs.filter((ix) => !isCloseOfAccount(ix, userWsolAta));

/**
 * PumpSwap AMM direct executor (post-migration Pump tokens).
 */
export const executeViaPumpSwapSdk = async (
  connection: Connection,
  taker: Keypair,
  intent: ExecutionIntent,
  slippageBps: number,
  commitment: "processed" | "confirmed" | "finalized",
  sendContext?: PumpSendContext,
): Promise<ExecutionResult> => {
  const started = Date.now();
  const tokenMint = new PublicKey(intent.token);
  const slippage = slippagePctFromBps(slippageBps);
  const cache = ensureCache(connection, toCommitment(commitment));
  const user = taker.publicKey;

  // When tokenProgram is cached, fetchPumpSwapState collapses the SDK's 3
  // sequential RPCs into a single getMultipleAccountsInfo (pool + mint +
  // 4 token accounts). First swap on a mint still pays the SDK path to seed
  // the cache.
  const swapState = await cache.fetchPumpSwapState(tokenMint, user);

  const preIxs: TransactionInstruction[] = [...computeBudgetIxs()];
  const postIxs: TransactionInstruction[] = [];
  let swapIxs: TransactionInstruction[];

  if (intent.side === "BUY") {
    const solLamports = toBuyLamports(intent.size);
    if (solLamports <= 0n) throw new Error("pump-swap: invalid buy size");
    const quoteBN = new BN(solLamports.toString());
    swapIxs = await PUMP_AMM_SDK.buyQuoteInput(swapState, quoteBN, slippage);
  } else {
    const rawAmount = validateRaw(intent.sellTokenAmountRaw ?? "0");
    const baseBN = new BN(rawAmount);
    swapIxs = await PUMP_AMM_SDK.sellBaseInput(swapState, baseBN, slippage);
  }

  // Phase 3: preserve persistent WSOL. SDK's `withWsolAccount` always appends
  // `closeAccount(userQuoteWsolAta)` which unwraps the ATA after every swap.
  // With persistent WSOL, that destroys the ATA and the next swap either
  // fails (`SyncNative IncorrectProgramId`, tx 5hyVDJ...) or re-pays
  // createATA rent. Filter the cleanup ix so the ATA survives.
  //
  // WSOL cap: when `shouldKeepWsolPredicate` returns false (current WSOL
  // already at/above target), we LET the SDK close run so the SELL output
  // unwraps back to native SOL and the WSOL ATA does not grow unbounded.
  // Rent is refunded on close and repaid on the next create — net neutral.
  const shouldKeep =
    keepPersistentWsol &&
    (shouldKeepWsolPredicate == null || shouldKeepWsolPredicate());
  if (shouldKeep) {
    const userWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      user,
      false,
      TOKEN_PROGRAM_ID,
    );
    // Race protection: SDK skips createATA whenever its prebuild snapshot
    // saw the ATA as existing. If another tx closed the ATA between snapshot
    // and land, `System.transfer → SyncNative` reverts with IncorrectProgramId.
    // Prepend an idempotent create only when SDK wouldn't have added one
    // (ata was observed existing), to avoid duplicate ixs in the common path.
    const ataWasObservedExisting =
      swapState.userQuoteAccountInfo != null &&
      swapState.userQuoteAccountInfo.owner.equals(TOKEN_PROGRAM_ID);
    if (ataWasObservedExisting) {
      preIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          user,
          userWsolAta,
          user,
          NATIVE_MINT,
        ),
      );
    }
    swapIxs = stripPersistentWsolCloses(swapIxs, userWsolAta);
  }

  // Phase 2+5: same fast-ack policy as pump-bonding path above.
  const useFastAck = intent.forceSyncConfirm !== true;
  const sig = await finalizeAndSend(
    connection,
    taker,
    [...preIxs, ...swapIxs, ...postIxs],
    commitment,
    { fastAck: useFastAck, protocolLabel: "PUMPSWAP", sendContext },
  );

  return {
    signature: sig,
    status: useFastAck ? "submitted" : "confirmed",
    whaleWallet: intent.whaleWallet,
    token: intent.token,
    side: intent.side,
    sizeSol: intent.size,
    executionStageMs: { quoteBuildMs: Date.now() - started },
  };
};

// Re-export marker to indicate SOL as quote mint (PumpSwap requires it).
export const PUMP_QUOTE_MINT = SOL_MINT_PK;
