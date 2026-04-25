import type {
  WhaleMetaFrame,
  WhaleTokenRow,
} from "../../src/listener/decode-whale-tx.js";

export const NATIVE_SOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const WHALE = "DeBoTWhaLeFixturePubkey00000000000000000000";
export const TOKEN_X = "TokeNXFixturePubkey0000000000000000000000000";
export const TOKEN_Y = "TokeNYFixturePubkey0000000000000000000000000";

const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const METEORA_DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

export const lamports = (sol: number): string => String(Math.round(sol * 1e9));

export const tokenRow = (
  mint: string,
  owner: string,
  uiAmount: number,
  decimals = 6,
): WhaleTokenRow => ({
  mint,
  owner,
  amount: String(Math.round(uiAmount * 10 ** decimals)),
  decimals,
});

type BuildOpts = {
  whale?: string;
  signature?: string;
  programIds?: string[];
  logs?: string[];
  preNativeSol?: number;
  postNativeSol?: number;
  preToken?: WhaleTokenRow[];
  postToken?: WhaleTokenRow[];
  extraAccountKeys?: string[];
};

export const buildFrame = (opts: BuildOpts = {}): WhaleMetaFrame => {
  const whale = opts.whale ?? WHALE;
  const programIds = opts.programIds ?? [];
  const accountKeys = [whale, ...programIds, ...(opts.extraAccountKeys ?? [])];
  return {
    whale,
    signature:
      opts.signature ??
      "fixture-signature-" + Math.random().toString(36).slice(2, 10),
    logs: opts.logs ?? [],
    feedSource: "grpc",
    ingestedAtMs: 1_700_000_000_000,
    accountKeys,
    preBalances: [
      lamports(opts.preNativeSol ?? 10),
      ...programIds.map(() => "0"),
    ],
    postBalances: [
      lamports(opts.postNativeSol ?? 10),
      ...programIds.map(() => "0"),
    ],
    preTokenBalances: opts.preToken ?? [],
    postTokenBalances: opts.postToken ?? [],
  };
};

export const PROGRAMS = {
  PUMPFUN: PUMPFUN_PROGRAM,
  RAYDIUM: RAYDIUM_AMM,
  METEORA: METEORA_DLMM,
  PUMPSWAP,
} as const;
