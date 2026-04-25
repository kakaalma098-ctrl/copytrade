import {
  Connection,
  PublicKey,
  type AccountInfo,
  type Commitment,
} from "@solana/web3.js";
import type { PoolAccountStream } from "./pool-account-stream.js";
import {
  MintLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  GLOBAL_PDA,
  OnlinePumpSdk,
  PUMP_FEE_CONFIG_PDA,
  PUMP_SDK,
  PumpSdk,
  bondingCurvePda,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from "@pump-fun/pump-sdk";
import {
  GLOBAL_CONFIG_PDA,
  OnlinePumpAmmSdk,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_SDK,
  PumpAmmSdk,
  canonicalPumpPoolPda,
  type Pool,
  type GlobalConfig,
  type FeeConfig as AmmFeeConfig,
  type SwapSolanaState,
} from "@pump-fun/pump-swap-sdk";
import BN from "bn.js";

const STATIC_TTL_MS = 60_000;
const TOKEN_PROGRAM_STR = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022_PROGRAM_STR = TOKEN_2022_PROGRAM_ID.toBase58();

type CacheEntry<T> = { exp: number; value: T };

export type PumpFunBuyDynamic = {
  bondingCurveAccountInfo: AccountInfo<Buffer>;
  bondingCurve: BondingCurve;
  associatedUserAccountInfo: AccountInfo<Buffer> | null;
  mintSupply: BN;
};

export type PumpFunSellDynamic = {
  bondingCurveAccountInfo: AccountInfo<Buffer>;
  bondingCurve: BondingCurve;
  mintSupply: BN;
};

/**
 * Caches pump-fun / pump-swap static state (global, feeConfig) and per-mint
 * tokenProgram. Also provides bundled dynamic fetchers that collapse the
 * SDK's multi-round-trip state loads into a single getMultipleAccountsInfo
 * call — ~2x fewer RPC hops per swap on the direct pump path.
 */
export class PumpStateCache {
  // Pump.fun bonding curve
  private pumpGlobal: CacheEntry<Global> | null = null;
  private pumpFeeConfig: CacheEntry<FeeConfig> | null = null;
  private pumpStaticInflight: Promise<void> | null = null;

  // PumpSwap AMM — ammFeeConfig may be null on-chain (optional PDA).
  private ammGlobalConfig: CacheEntry<GlobalConfig> | null = null;
  private ammFeeConfig: CacheEntry<AmmFeeConfig | null> | null = null;
  private ammStaticInflight: Promise<void> | null = null;

  // Immutable: mint owner (token program) never changes after mint creation.
  private readonly tokenProgram = new Map<string, PublicKey>();

  // Base mint account info is fetched rarely (only for the initial RPC path)
  // and decoded to a MintLayout — supply updates on mint/burn but for pump
  // tokens post-graduation supply is effectively fixed. Cached long-lived so
  // the stream-cache fast path does not need to re-fetch it per swap.
  private readonly baseMintDecoded = new Map<
    string,
    ReturnType<typeof MintLayout.decode>
  >();

  private poolStream: PoolAccountStream | null = null;

  readonly pumpSdk: PumpSdk;
  readonly pumpAmmSdk: PumpAmmSdk;
  readonly onlinePumpSdk: OnlinePumpSdk;
  readonly onlinePumpAmmSdk: OnlinePumpAmmSdk;

  constructor(
    private readonly connection: Connection,
    private readonly commitment: Commitment = "confirmed",
  ) {
    this.pumpSdk = PUMP_SDK;
    this.pumpAmmSdk = PUMP_AMM_SDK;
    this.onlinePumpSdk = new OnlinePumpSdk(connection);
    this.onlinePumpAmmSdk = new OnlinePumpAmmSdk(connection);
  }

  /** Wire the gRPC pool account stream after construction (circular-init safe). */
  setPoolStream(stream: PoolAccountStream): void {
    this.poolStream = stream;
  }

  async warmup(): Promise<void> {
    await Promise.all([
      this.getPumpStatic().catch(() => undefined),
      this.getAmmStatic().catch(() => undefined),
    ]);
  }

  async getPumpStatic(): Promise<{ global: Global; feeConfig: FeeConfig }> {
    const now = Date.now();
    if (
      this.pumpGlobal != null &&
      now < this.pumpGlobal.exp &&
      this.pumpFeeConfig != null &&
      now < this.pumpFeeConfig.exp
    ) {
      return {
        global: this.pumpGlobal.value,
        feeConfig: this.pumpFeeConfig.value,
      };
    }
    if (this.pumpStaticInflight == null) {
      this.pumpStaticInflight = this.refreshPumpStatic().finally(() => {
        this.pumpStaticInflight = null;
      });
    }
    await this.pumpStaticInflight;
    if (this.pumpGlobal == null || this.pumpFeeConfig == null) {
      throw new Error(
        "pump-static: refresh completed without populating cache",
      );
    }
    return {
      global: this.pumpGlobal.value,
      feeConfig: this.pumpFeeConfig.value,
    };
  }

  async getAmmStatic(): Promise<{
    globalConfig: GlobalConfig;
    feeConfig: AmmFeeConfig | null;
  }> {
    const now = Date.now();
    if (
      this.ammGlobalConfig != null &&
      now < this.ammGlobalConfig.exp &&
      this.ammFeeConfig != null &&
      now < this.ammFeeConfig.exp
    ) {
      return {
        globalConfig: this.ammGlobalConfig.value,
        feeConfig: this.ammFeeConfig.value,
      };
    }
    if (this.ammStaticInflight == null) {
      this.ammStaticInflight = this.refreshAmmStatic().finally(() => {
        this.ammStaticInflight = null;
      });
    }
    await this.ammStaticInflight;
    if (this.ammGlobalConfig == null || this.ammFeeConfig == null) {
      throw new Error(
        "pump-amm-static: refresh completed without populating cache",
      );
    }
    return {
      globalConfig: this.ammGlobalConfig.value,
      feeConfig: this.ammFeeConfig.value,
    };
  }

  /**
   * Resolve token program for a mint. Accepts optional pre-fetched mint
   * account info (from a bundled getMultipleAccountsInfo) to avoid an extra
   * RPC on cache miss. Result is memoized permanently since mint owner is
   * immutable after creation.
   */
  getTokenProgramSync(mint: PublicKey): PublicKey | null {
    return this.tokenProgram.get(mint.toBase58()) ?? null;
  }

  setTokenProgram(mint: PublicKey, owner: PublicKey): PublicKey {
    const key = mint.toBase58();
    const ownerStr = owner.toBase58();
    let program: PublicKey;
    if (ownerStr === TOKEN_2022_PROGRAM_STR) {
      program = TOKEN_2022_PROGRAM_ID;
    } else if (ownerStr === TOKEN_PROGRAM_STR) {
      program = TOKEN_PROGRAM_ID;
    } else {
      throw new Error(`mint ${key} owner ${ownerStr} is not a token program`);
    }
    this.tokenProgram.set(key, program);
    return program;
  }

  async getTokenProgram(mint: PublicKey): Promise<PublicKey> {
    const cached = this.getTokenProgramSync(mint);
    if (cached != null) {
      return cached;
    }
    const info = await this.connection.getAccountInfo(mint, this.commitment);
    if (info == null) {
      throw new Error(`mint ${mint.toBase58()} not found on-chain`);
    }
    return this.setTokenProgram(mint, info.owner);
  }

  /**
   * Bundled pump-fun BUY dynamic fetch: bondingCurve + userATA + mint in a
   * single getMultipleAccountsInfo. Mint is always included to read live
   * supply (bonding curve buys/sells mutate it). tokenProgram is seeded in
   * the same hop.
   */
  async fetchPumpFunBuyDynamic(
    mint: PublicKey,
    user: PublicKey,
    tokenProgram: PublicKey,
  ): Promise<PumpFunBuyDynamic> {
    const bondingCurve = bondingCurvePda(mint);
    const userAta = getAssociatedTokenAddressSync(
      mint,
      user,
      true,
      tokenProgram,
    );
    const infos = await this.connection.getMultipleAccountsInfo(
      [bondingCurve, userAta, mint],
      this.commitment,
    );
    const bondingCurveInfo = infos[0];
    const userAtaInfo = infos[1] ?? null;
    const mintInfo = infos[2] ?? null;

    if (bondingCurveInfo == null) {
      throw new Error(
        `pump-fun: bonding curve not found for mint ${mint.toBase58()}`,
      );
    }
    if (mintInfo == null) {
      throw new Error(`pump-fun: mint ${mint.toBase58()} not found`);
    }
    if (this.getTokenProgramSync(mint) == null) {
      this.setTokenProgram(mint, mintInfo.owner);
    }

    const supply = MintLayout.decode(mintInfo.data).supply;
    return {
      bondingCurveAccountInfo: bondingCurveInfo,
      bondingCurve: this.pumpSdk.decodeBondingCurve(bondingCurveInfo),
      associatedUserAccountInfo: userAtaInfo,
      mintSupply: new BN(supply.toString()),
    };
  }

  async fetchPumpFunSellDynamic(
    mint: PublicKey,
    user: PublicKey,
    tokenProgram: PublicKey,
  ): Promise<PumpFunSellDynamic> {
    // SELL path requires the user ATA to EXIST (validated by SDK). Reuse the
    // buy dynamic bundle and assert presence here.
    const buy = await this.fetchPumpFunBuyDynamic(mint, user, tokenProgram);
    if (buy.associatedUserAccountInfo == null) {
      throw new Error(
        `pump-fun: associated token account missing for mint=${mint.toBase58()} user=${user.toBase58()}`,
      );
    }
    return {
      bondingCurveAccountInfo: buy.bondingCurveAccountInfo,
      bondingCurve: buy.bondingCurve,
      mintSupply: buy.mintSupply,
    };
  }

  /**
   * Bundled PumpSwap dynamic fetch: pool + baseMint + pool/user token ATAs
   * in a single getMultipleAccountsInfo. Replaces the SDK's 3 sequential
   * round-trips. Relies on cached globalConfig + feeConfig + baseTokenProgram
   * (cache miss on baseTokenProgram falls back to the SDK path).
   */
  async fetchPumpSwapState(
    mint: PublicKey,
    user: PublicKey,
  ): Promise<SwapSolanaState> {
    const { globalConfig, feeConfig } = await this.getAmmStatic();
    const baseTokenProgram = this.getTokenProgramSync(mint);
    if (baseTokenProgram == null) {
      // Unknown token program — fall back to SDK to resolve it first, then
      // cache the result so subsequent swaps take the fast path.
      const state = await this.onlinePumpAmmSdk.swapSolanaState(
        canonicalPumpPoolPda(mint),
        user,
      );
      this.setTokenProgram(mint, state.baseTokenProgram);
      return state;
    }

    const quoteMint = NATIVE_MINT;
    const quoteTokenProgram = TOKEN_PROGRAM_ID;
    const poolKey = canonicalPumpPoolPda(mint);
    const poolBaseTokenAccount = getAssociatedTokenAddressSync(
      mint,
      poolKey,
      true,
      baseTokenProgram,
    );
    const poolQuoteTokenAccount = getAssociatedTokenAddressSync(
      quoteMint,
      poolKey,
      true,
      quoteTokenProgram,
    );
    const userBaseTokenAccount = getAssociatedTokenAddressSync(
      mint,
      user,
      true,
      baseTokenProgram,
    );
    const userQuoteTokenAccount = getAssociatedTokenAddressSync(
      quoteMint,
      user,
      true,
      quoteTokenProgram,
    );

    // Fast path: gRPC pool stream push-cached pool + pool ATAs. When hit AND
    // baseMint already decoded (cached indefinitely — mint supply drift is
    // irrelevant to swap pricing on post-graduation pools), skip RPC entirely.
    // User ATA info is intentionally passed as null: SDK's buyQuoteInput /
    // sellBaseInput use explicit amount args, so user ATA balance is not
    // consulted for pricing math; missing-ATA cases are handled by the SDK's
    // withWsolAccount create path at ix build time.
    const streamCached = this.poolStream?.getCachedState(mint) ?? null;
    const cachedBaseMintDecoded = this.baseMintDecoded.get(mint.toBase58());
    if (streamCached != null && cachedBaseMintDecoded != null) {
      const poolCached: Pool = this.pumpAmmSdk.decodePool(
        streamCached.poolAccountInfo,
      );
      const poolBaseCached = decodeTokenAccountAmount(
        streamCached.poolBaseAccountInfo.data,
      );
      const poolQuoteCached = decodeTokenAccountAmount(
        streamCached.poolQuoteAccountInfo.data,
      );
      return {
        globalConfig,
        feeConfig,
        poolKey,
        poolAccountInfo: streamCached.poolAccountInfo,
        pool: poolCached,
        poolBaseAmount: new BN(poolBaseCached.toString()),
        poolQuoteAmount: new BN(poolQuoteCached.toString()),
        baseTokenProgram,
        quoteTokenProgram,
        baseMint: mint,
        baseMintAccount: cachedBaseMintDecoded,
        user,
        userBaseTokenAccount,
        userQuoteTokenAccount,
        userBaseAccountInfo: null,
        userQuoteAccountInfo: null,
      };
    }

    const infos = await this.connection.getMultipleAccountsInfo(
      [
        poolKey,
        mint,
        poolBaseTokenAccount,
        poolQuoteTokenAccount,
        userBaseTokenAccount,
        userQuoteTokenAccount,
      ],
      this.commitment,
    );
    const [
      poolAccountInfo,
      baseMintAccountInfo,
      poolBaseAccountInfo,
      poolQuoteAccountInfo,
      userBaseAccountInfo,
      userQuoteAccountInfo,
    ] = infos;

    if (poolAccountInfo == null) {
      throw new Error(`pump-swap: pool ${poolKey.toBase58()} not found`);
    }
    if (baseMintAccountInfo == null) {
      throw new Error(`pump-swap: base mint ${mint.toBase58()} not found`);
    }
    if (poolBaseAccountInfo == null) {
      throw new Error(
        `pump-swap: pool base ATA ${poolBaseTokenAccount.toBase58()} not found`,
      );
    }
    if (poolQuoteAccountInfo == null) {
      throw new Error(
        `pump-swap: pool quote ATA ${poolQuoteTokenAccount.toBase58()} not found`,
      );
    }

    const pool: Pool = this.pumpAmmSdk.decodePool(poolAccountInfo);
    const decodedPoolBaseTokenAccount = decodeTokenAccountAmount(
      poolBaseAccountInfo.data,
    );
    const decodedPoolQuoteTokenAccount = decodeTokenAccountAmount(
      poolQuoteAccountInfo.data,
    );
    const decodedBaseMintAccount = MintLayout.decode(baseMintAccountInfo.data);
    // Seed the long-lived baseMint decoded cache so the next call on this
    // mint can take the gRPC-cache fast path without re-fetching the mint.
    this.baseMintDecoded.set(mint.toBase58(), decodedBaseMintAccount);
    // Speculatively register this pool with the gRPC stream so subsequent
    // swaps (rebuy, SELL) get a cache hit instead of another 6-account RPC.
    if (this.poolStream != null) {
      this.poolStream.registerPool(mint, baseTokenProgram, poolKey);
    }

    return {
      globalConfig,
      feeConfig,
      poolKey,
      poolAccountInfo,
      pool,
      poolBaseAmount: new BN(decodedPoolBaseTokenAccount.toString()),
      poolQuoteAmount: new BN(decodedPoolQuoteTokenAccount.toString()),
      baseTokenProgram,
      quoteTokenProgram,
      baseMint: mint,
      baseMintAccount: decodedBaseMintAccount,
      user,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      userBaseAccountInfo: userBaseAccountInfo ?? null,
      userQuoteAccountInfo: userQuoteAccountInfo ?? null,
    };
  }

  private async refreshPumpStatic(): Promise<void> {
    const infos = await this.connection.getMultipleAccountsInfo(
      [GLOBAL_PDA, PUMP_FEE_CONFIG_PDA],
      this.commitment,
    );
    if (infos[0] == null) {
      throw new Error("pump-static: global PDA not found");
    }
    if (infos[1] == null) {
      throw new Error("pump-static: fee config PDA not found");
    }
    const exp = Date.now() + STATIC_TTL_MS;
    this.pumpGlobal = { exp, value: this.pumpSdk.decodeGlobal(infos[0]) };
    this.pumpFeeConfig = { exp, value: this.pumpSdk.decodeFeeConfig(infos[1]) };
  }

  private async refreshAmmStatic(): Promise<void> {
    const infos = await this.connection.getMultipleAccountsInfo(
      [GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA],
      this.commitment,
    );
    if (infos[0] == null) {
      throw new Error("pump-amm-static: global config PDA not found");
    }
    const exp = Date.now() + STATIC_TTL_MS;
    this.ammGlobalConfig = {
      exp,
      value: this.pumpAmmSdk.decodeGlobalConfig(infos[0]),
    };
    this.ammFeeConfig = {
      exp,
      value: infos[1] ? this.pumpAmmSdk.decodeFeeConfig(infos[1]) : null,
    };
  }
}

/**
 * Decode a SPL token account's `amount` field (offset 64, u64 LE) without
 * fully unpacking the account. Matches the layout consumed by PumpSwap SDK.
 */
function decodeTokenAccountAmount(data: Buffer): bigint {
  if (data.length < 72) {
    throw new Error("pump-amm: token account data shorter than expected");
  }
  return data.readBigUInt64LE(64);
}

let sharedPumpStateCache: PumpStateCache | undefined;

export function setSharedPumpStateCache(cache: PumpStateCache): void {
  sharedPumpStateCache = cache;
}

export function getSharedPumpStateCache(): PumpStateCache | undefined {
  return sharedPumpStateCache;
}
