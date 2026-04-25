import type { AppConfig, ExecutionIntent } from "../types/index.js";
import {
  formatAxiosHttpError,
  isTerminalJupiterQuoteError,
} from "../utils/axios-http-error.js";
import { httpClient } from "../utils/http-client.js";
import { getTokenBalanceRawForMint } from "../utils/token-balance.js";
import { altCache } from "../perf/alt-cache.js";
import type { BlockhashCache } from "../perf/blockhash-cache.js";
import type { WsolTopUpManager } from "../perf/startup-prewrap-wsol.js";
import type { PersistentWsolTracker } from "../perf/persistent-wsol-tracker.js";
import { isAxiosError } from "axios";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_RATE_LIMIT_RETRY_ATTEMPTS = 3;
const JUPITER_RATE_LIMIT_BACKOFF_MS = 150;

export type JupiterQuoteResponse = Record<string, unknown> & {
  priceImpactPct?: string;
  routePlan?: unknown[];
  inAmount?: string;
  outAmount?: string;
};

export type JupiterSwapBuild = {
  swapTransactionBase64: string;
  lastValidBlockHeight?: number;
};

type RoutePreference = {
  dexes?: string[];
};

type MetisInstructionAccountMeta = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

type MetisInstructionLike = {
  programId: string;
  accounts: MetisInstructionAccountMeta[];
  data: string;
};

type MetisSwapInstructionsResponse = {
  tokenLedgerInstruction?: MetisInstructionLike | null;
  computeBudgetInstructions?: MetisInstructionLike[];
  setupInstructions?: MetisInstructionLike[];
  swapInstruction?: MetisInstructionLike | null;
  cleanupInstruction?: MetisInstructionLike | null;
  otherInstructions?: MetisInstructionLike[];
  addressLookupTableAddresses?: string[];
};

/** Respons GET `/order` (Jupiter Swap API — lite atau api host). */
type JupiterOrderResponse = {
  transaction?: string | null;
  lastValidBlockHeight?: string;
  inAmount?: string;
  outAmount?: string;
  priceImpactPct?: string;
  priceImpact?: number;
  routePlan?: unknown[];
  errorCode?: number;
  errorMessage?: string;
  error?: string;
};

export class JupiterClient {
  private readonly cache = new Map<
    string,
    { exp: number; quote: JupiterQuoteResponse }
  >();
  private apiKeyCursor = 0;
  private blockhashCache?: BlockhashCache;
  private wsolTopUp?: WsolTopUpManager;
  private wsolTracker?: PersistentWsolTracker;

  constructor(
    private readonly config: AppConfig,
    private readonly connection?: Connection,
  ) {}

  /** Attach a shared blockhash cache to avoid per-swap getLatestBlockhash RPC calls. */
  setBlockhashCache(cache: BlockhashCache): void {
    this.blockhashCache = cache;
  }

  /**
   * Attach a persistent WSOL top-up manager. When the BUY hot-path detects an
   * insufficient WSOL balance, it will trigger an async SOL->WSOL wrap so
   * subsequent swaps return to the fast persistent-WSOL path.
   */
  setWsolTopUpManager(mgr: WsolTopUpManager): void {
    this.wsolTopUp = mgr;
  }

  /**
   * Attach an in-memory WSOL balance tracker. When wired, the BUY hot path
   * uses the tracker's sync `hasEnough()` instead of `getTokenBalanceRawForMint`,
   * removing a ~30-50ms RPC round trip from `quoteBuild`.
   */
  setWsolTracker(tracker: PersistentWsolTracker): void {
    this.wsolTracker = tracker;
  }

  /**
   * `v2-order`: Swap API v2 `/order` returns a signed-ready tx.
   * `v1-metis-instructions`: v1 `/quote` + `/swap-instructions`, tx assembled locally (full ix control).
   * `auto` defaults to `v2-order`; v1 remains reachable only via `metis_instructions`.
   */
  private swapApiKind(): "v2-order" | "v1-metis-instructions" {
    if (this.config.jupiter.integrationMode === "metis_instructions") {
      return "v1-metis-instructions";
    }
    return "v2-order";
  }

  private baseUrl(): string {
    const base = this.config.jupiter.swapApiBase.replace(/\/$/, "");
    if (this.config.jupiter.integrationMode === "metis_instructions") {
      return base.replace(/\/swap\/v2$/i, "/swap/v1");
    }
    return base.replace(/\/swap\/v1$/i, "/swap/v2");
  }

  private swapInstructionsUrl(): string {
    return `${this.baseUrl()}/swap-instructions`;
  }

  private nextJupiterApiKey(): string | null {
    const keys = this.config.jupiter.apiKeys;
    if (keys.length === 0) {
      return null;
    }
    const idx = this.apiKeyCursor % keys.length;
    const key = keys[idx]?.trim() ?? "";
    this.apiKeyCursor = (this.apiKeyCursor + 1) % keys.length;
    return key === "" ? null : key;
  }

  private jupiterRequestHeaders(): Record<string, string> | undefined {
    const key = this.nextJupiterApiKey();
    return key ? { "x-api-key": key } : undefined;
  }

  private isJupiterRateLimitError(err: unknown): boolean {
    return isAxiosError(err) && err.response?.status === 429;
  }

  private async withJupiterRetry<T>(
    action: () => Promise<T>,
    context: string,
  ): Promise<T> {
    const numKeys = Math.max(1, this.config.jupiter.apiKeys.length);
    const maxAttempts = Math.max(JUPITER_RATE_LIMIT_RETRY_ATTEMPTS, numKeys);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await action();
      } catch (e) {
        lastError = e;
        if (!this.isJupiterRateLimitError(e) || attempt >= maxAttempts) {
          break;
        }
        if (this.config.debug.whalePipeline) {
          console.warn(
            `[whale-debug] ${context} HTTP 429 -> retry ${attempt + 1}/${maxAttempts} with next Jupiter API key`,
          );
        }
        // N3: skip sleep while fresh keys remain in rotation. nextJupiterApiKey()
        // advances the cursor per call, so attempts 1..numKeys each use a
        // different key's quota. Only back off once we've cycled through all
        // keys and would be re-hitting the same quota slot.
        if (attempt >= numKeys) {
          const backoffStep = attempt - numKeys + 1;
          await new Promise((resolve) =>
            setTimeout(resolve, JUPITER_RATE_LIMIT_BACKOFF_MS * backoffStep),
          );
        }
      }
    }

    throw formatAxiosHttpError(context, lastError);
  }

  private cacheKey(
    inputMint: string,
    outputMint: string,
    amountKey: string,
    route: RoutePreference | undefined,
    slippageBps: number,
  ): string {
    const dexKey = (route?.dexes ?? []).join(",");
    return `${inputMint}|${outputMint}|${amountKey}|${slippageBps}|${dexKey}`;
  }

  private applyRoutePreference(
    params: Record<string, string | number>,
    route?: RoutePreference,
  ): Record<string, string | number> {
    if (route?.dexes && route.dexes.length > 0) {
      params.dexes = route.dexes.join(",");
    }
    return params;
  }

  private buyLamportsFromSize(sizeSol: number): bigint {
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
      return 0n;
    }
    return BigInt(Math.floor(sizeSol * 1_000_000_000));
  }

  private async resolveWrapAndUnwrapSol(
    intent: ExecutionIntent,
    userPublicKey: string,
  ): Promise<boolean> {
    if (!this.config.trading.persistentWsol) {
      return true;
    }
    if (!this.connection) {
      return true;
    }

    // SELL persistent-WSOL path: route the output SOL into the existing
    // WSOL ATA instead of unwrapping to native SOL, SO LONG AS current WSOL
    // is below the configured target. Once WSOL >= target, unwrap the SELL
    // output to native SOL (wrapAndUnwrapSol=true) so the WSOL ATA does not
    // accumulate beyond target — excess stays as spendable native SOL for
    // fees/tips/rent. Prereq: startupPrewrapWsol creates the WSOL ATA
    // idempotently at boot.
    if (intent.side === "SELL") {
      const targetLamports = BigInt(
        Math.floor(
          (this.config.trading.startupPrewrapWsol.targetSol || 0) *
            1_000_000_000,
        ),
      );
      if (targetLamports <= 0n) {
        return false;
      }
      let currentWsolLamports = 0n;
      if (this.wsolTracker != null && this.wsolTracker.isInitialized()) {
        currentWsolLamports = this.wsolTracker.getBalanceLamports();
      } else {
        try {
          const raw = await getTokenBalanceRawForMint(
            this.connection,
            new PublicKey(userPublicKey),
            new PublicKey(SOL_MINT),
          );
          currentWsolLamports = raw != null ? BigInt(raw) : 0n;
        } catch {
          currentWsolLamports = 0n;
        }
      }
      const shouldUnwrap = currentWsolLamports >= targetLamports;
      if (shouldUnwrap && this.config.debug.whalePipeline) {
        console.warn(
          `[whale-debug] WSOL at/above target (${currentWsolLamports.toString()} >= ${targetLamports.toString()}) -> unwrap SELL output to native SOL`,
        );
      }
      return shouldUnwrap;
    }

    const requiredLamports = this.buyLamportsFromSize(intent.size);
    if (requiredLamports <= 0n) {
      return true;
    }

    // In-memory tracker path — no RPC on the hot path. The tracker seeds
    // from chain at startup and self-refreshes in the background; stale
    // reads fall through to the auto-wrap + topup safety net on next swap.
    if (this.wsolTracker != null && this.wsolTracker.isInitialized()) {
      const hasEnoughPersistentWsol =
        this.wsolTracker.hasEnough(requiredLamports);
      if (!hasEnoughPersistentWsol) {
        if (this.config.debug.whalePipeline) {
          console.warn(
            `[whale-debug] persistent WSOL insufficient (tracker) -> fallback auto-wrap (need=${requiredLamports.toString()} have=${this.wsolTracker.getBalanceLamports().toString()})`,
          );
        }
        this.wsolTopUp?.triggerTopUp();
      }
      return !hasEnoughPersistentWsol;
    }

    // Fallback path: tracker not wired or still initializing. Keeps the
    // original RPC-backed safety net so a partially-initialized process
    // never submits a wrapAndUnwrapSol=false swap against an empty ATA.
    const owner = new PublicKey(userPublicKey);
    try {
      const raw = await getTokenBalanceRawForMint(
        this.connection,
        owner,
        new PublicKey(SOL_MINT),
      );
      const wsolLamports = raw != null ? BigInt(raw) : 0n;
      const hasEnoughPersistentWsol = wsolLamports >= requiredLamports;

      if (!hasEnoughPersistentWsol) {
        if (this.config.debug.whalePipeline) {
          console.warn(
            `[whale-debug] persistent WSOL insufficient -> fallback auto-wrap (need=${requiredLamports.toString()} have=${wsolLamports.toString()})`,
          );
        }
        this.wsolTopUp?.triggerTopUp();
      }

      return !hasEnoughPersistentWsol;
    } catch (e) {
      if (this.config.debug.whalePipeline) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          `[whale-debug] WSOL balance check failed -> fallback auto-wrap: ${msg}`,
        );
      }
      this.wsolTopUp?.triggerTopUp();
      return true;
    }
  }

  private getCached(key: string): JupiterQuoteResponse | null {
    const row = this.cache.get(key);
    if (!row) {
      return null;
    }
    if (Date.now() > row.exp) {
      this.cache.delete(key);
      return null;
    }
    return row.quote;
  }

  private setCached(key: string, quote: JupiterQuoteResponse): void {
    this.cache.set(key, {
      exp: Date.now() + this.config.perf.quoteCacheTtlMs,
      quote,
    });
  }

  private toWeb3Ix(ix: MetisInstructionLike): TransactionInstruction {
    return new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: !!k.isSigner,
        isWritable: !!k.isWritable,
      })),
      data: Buffer.from(ix.data, "base64"),
    });
  }

  private async buildTxFromMetisInstructions(
    payload: MetisSwapInstructionsResponse,
    userPublicKey: string,
  ): Promise<{ txB64: string; lastValidBlockHeight?: number }> {
    if (!this.connection) {
      throw new Error("metis_instructions mode requires a Solana connection");
    }
    const payer = new PublicKey(userPublicKey);
    const ixs: TransactionInstruction[] = [];
    const pushIx = (ix?: MetisInstructionLike | null): void => {
      if (ix != null) {
        ixs.push(this.toWeb3Ix(ix));
      }
    };

    for (const ix of payload.computeBudgetInstructions ?? []) {
      pushIx(ix);
    }
    pushIx(payload.tokenLedgerInstruction ?? null);
    for (const ix of payload.setupInstructions ?? []) {
      pushIx(ix);
    }
    pushIx(payload.swapInstruction ?? null);
    pushIx(payload.cleanupInstruction ?? null);
    for (const ix of payload.otherInstructions ?? []) {
      pushIx(ix);
    }

    if (ixs.length === 0) {
      throw new Error("Jupiter /swap-instructions returned no instructions");
    }

    const lookupAddresses = payload.addressLookupTableAddresses ?? [];
    const [alts, latest] = await Promise.all([
      altCache.resolve(this.connection, lookupAddresses),
      this.blockhashCache
        ? this.blockhashCache.getBlockhash()
        : this.connection.getLatestBlockhash(this.config.helius.rpcCommitment),
    ]);
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: latest.blockhash,
      instructions: ixs,
    }).compileToV0Message(alts);
    const tx = new VersionedTransaction(msg);

    return {
      txB64: Buffer.from(tx.serialize()).toString("base64"),
      lastValidBlockHeight: latest.lastValidBlockHeight,
    };
  }

  /**
   * Lite/Metis `/quote` dan v2 `/order` kadang mengembalikan `inAmount`/`outAmount` sebagai number (JSON).
   * Tanpa normalisasi ke string, parsing amount bisa gagal di downstream.
   */
  private normalizeAmountField(
    data: Record<string, unknown>,
    kind: "in" | "out",
  ): string | undefined {
    const keys =
      kind === "in"
        ? (["inAmount", "inputAmount", "in_amount"] as const)
        : (["outAmount", "outputAmount", "out_amount"] as const);
    for (const k of keys) {
      const v = data[k];
      if (v === undefined || v === null) {
        continue;
      }
      if (typeof v === "number" && Number.isFinite(v)) {
        return String(Math.trunc(v));
      }
      const s = String(v).trim();
      if (s !== "") {
        return s;
      }
    }
    return undefined;
  }

  /** Samakan skala price impact dengan gate validasi internal (persen, bukan desimal). */
  private mapOrderToQuote(data: JupiterOrderResponse): JupiterQuoteResponse {
    const raw = data as unknown as Record<string, unknown>;
    let priceImpactPct: string | undefined;
    if (data.priceImpactPct != null && data.priceImpactPct !== "") {
      priceImpactPct = String(data.priceImpactPct);
    } else if (
      typeof data.priceImpact === "number" &&
      Number.isFinite(data.priceImpact)
    ) {
      priceImpactPct = String(Math.abs(data.priceImpact) * 100);
    }
    const inAmount = this.normalizeAmountField(raw, "in");
    const outAmount = this.normalizeAmountField(raw, "out");
    return {
      ...data,
      priceImpactPct,
      inAmount,
      outAmount,
      routePlan: data.routePlan,
    };
  }

  /**
   * BUY: `amount` = SOL in lamports.
   * SELL: `amount` = input mint in smallest token units (from `sellTokenAmountRaw`).
   */
  private intentRoute(intent: ExecutionIntent): {
    inputMint: string;
    outputMint: string;
    amountString: string;
  } {
    if (intent.side === "BUY") {
      return {
        inputMint: SOL_MINT,
        outputMint: intent.token,
        amountString: this.buyLamportsFromSize(intent.size).toString(),
      };
    }
    const raw = intent.sellTokenAmountRaw?.trim();
    if (raw == null || raw === "" || raw === "0" || !/^\d+$/.test(raw)) {
      throw new Error(
        "SELL intent requires positive integer sellTokenAmountRaw (token smallest units)",
      );
    }
    return {
      inputMint: intent.token,
      outputMint: SOL_MINT,
      amountString: raw,
    };
  }

  /**
   * `amountString` = lamports for SOL→token routes, or raw token amount for token→SOL (same as Jupiter `amount`).
   * `bypassCache`: true untuk paksa quote fresh (skip cache).
   */
  /** Resolve effective slippage: override wins, else config default. */
  private resolveSlippageBps(override?: number): number {
    if (
      typeof override === "number" &&
      Number.isFinite(override) &&
      override >= 0
    ) {
      return override;
    }
    return this.config.trading.slippageBps;
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amountString: string,
    opts?: {
      bypassCache?: boolean;
      route?: RoutePreference;
      slippageBpsOverride?: number;
    },
  ): Promise<JupiterQuoteResponse> {
    const bypass = opts?.bypassCache === true;
    const slippageBps = this.resolveSlippageBps(opts?.slippageBpsOverride);
    const key = this.cacheKey(
      inputMint,
      outputMint,
      amountString,
      opts?.route,
      slippageBps,
    );
    if (!bypass) {
      const hit = this.getCached(key);
      if (hit) {
        return hit;
      }
    }

    let data: JupiterOrderResponse;
    try {
      // Q1/N1 params — togglable via env so rollback doesn't require rebuild.
      const dynamicSlippageOn = this.config.jupiter.dynamicSlippage;
      const maxAccountsGuard = this.config.jupiter.maxAccounts;
      const restrictIntermediateTokens =
        this.config.jupiter.restrictIntermediateTokens;
      if (this.swapApiKind() === "v2-order") {
        const res = await this.withJupiterRetry(
          () =>
            httpClient.get<JupiterOrderResponse>(this.v2OrderUrl(), {
              params: {
                inputMint,
                outputMint,
                amount: amountString,
                slippageBps,
                ...(dynamicSlippageOn ? { dynamicSlippage: true } : {}),
                ...(maxAccountsGuard > 0
                  ? { maxAccounts: maxAccountsGuard }
                  : {}),
                ...(restrictIntermediateTokens
                  ? { restrictIntermediateTokens: true }
                  : {}),
                ...this.applyRoutePreference({}, opts?.route),
              },
              headers: this.jupiterRequestHeaders(),
            }),
          "Jupiter /order (quote)",
        );
        data = res.data;
      } else {
        const res = await this.withJupiterRetry(
          () =>
            httpClient.get<JupiterOrderResponse>(`${this.baseUrl()}/quote`, {
              params: {
                inputMint,
                outputMint,
                amount: amountString,
                slippageBps,
                ...(dynamicSlippageOn ? { dynamicSlippage: true } : {}),
                ...(maxAccountsGuard > 0
                  ? { maxAccounts: maxAccountsGuard }
                  : {}),
                ...(restrictIntermediateTokens
                  ? { restrictIntermediateTokens: true }
                  : {}),
                ...this.applyRoutePreference({}, opts?.route),
              },
              headers: this.jupiterRequestHeaders(),
            }),
          "Jupiter /quote (quote)",
        );
        data = res.data;
      }
    } catch (e) {
      const path = this.swapApiKind() === "v2-order" ? "/order" : "/quote";
      throw formatAxiosHttpError(`Jupiter ${path} (quote)`, e);
    }

    const quote = this.mapOrderToQuote(data);
    if (!bypass) {
      this.setCached(key, quote);
    }
    return quote;
  }

  async getQuoteForIntent(
    intent: ExecutionIntent,
    route?: RoutePreference,
  ): Promise<JupiterQuoteResponse> {
    const r = this.intentRoute(intent);
    return this.getQuote(r.inputMint, r.outputMint, r.amountString, {
      route,
      slippageBpsOverride: intent.slippageBpsOverride,
    });
  }

  /**
   * Satu GET `/order` dengan taker — dipakai execute (tanpa panggilan Jupiter kedua).
   */
  async buildSwapTransactionWithQuote(
    intent: ExecutionIntent,
    userPublicKey: string,
    prioritizationFeeLamports?: string | number,
    opts?: { bypassQuoteCache?: boolean; dexes?: string[] },
  ): Promise<{ build: JupiterSwapBuild; quote: JupiterQuoteResponse }> {
    const build = await this.fetchOrderWithTaker(
      intent,
      userPublicKey,
      prioritizationFeeLamports,
      opts,
    );
    const quote = this.mapOrderToQuote(build.data);
    return {
      build: {
        swapTransactionBase64: build.txB64,
        lastValidBlockHeight: build.lastValidBlockHeight,
      },
      quote,
    };
  }

  private async fetchOrderWithTaker(
    intent: ExecutionIntent,
    userPublicKey: string,
    prioritizationFeeLamports?: string | number,
    opts?: { bypassQuoteCache?: boolean; dexes?: string[] },
  ): Promise<{
    data: JupiterOrderResponse;
    txB64: string;
    lastValidBlockHeight?: number;
  }> {
    const bypassQuoteCache = opts?.bypassQuoteCache === true;
    const route: RoutePreference = { dexes: opts?.dexes };

    if (this.swapApiKind() === "v1-metis-instructions") {
      try {
        return await this.fetchMetisInstructionsPath(
          intent,
          userPublicKey,
          prioritizationFeeLamports,
          route,
          bypassQuoteCache,
        );
      } catch (e) {
        if (!isTerminalJupiterQuoteError(e)) {
          throw e;
        }
        // BUY no-fallback: bail out on terminal error instead of waiting 200-
        // 500ms for v2 /order. Missed entry < buy-too-late. SELL still
        // falls through to v2 so position always gets closed.
        if (this.config.execution.buyNoFallback && intent.side === "BUY") {
          if (this.config.debug.whalePipeline) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(
              `[jupiter] v1 metis-instructions terminal error (BUY no-fallback) -> abort: ${msg}`,
            );
          }
          throw e;
        }
        if (this.config.debug.whalePipeline) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            `[jupiter] v1 metis-instructions terminal error -> fallback to v2 /order: ${msg}`,
          );
        }
        return this.fetchV2OrderWithTaker(
          intent,
          userPublicKey,
          prioritizationFeeLamports,
          route,
        );
      }
    }

    return this.fetchV2OrderWithTaker(
      intent,
      userPublicKey,
      prioritizationFeeLamports,
      route,
    );
  }

  private async fetchMetisInstructionsPath(
    intent: ExecutionIntent,
    userPublicKey: string,
    prioritizationFeeLamports: string | number | undefined,
    route: RoutePreference,
    bypassQuoteCache: boolean,
  ): Promise<{
    data: JupiterOrderResponse;
    txB64: string;
    lastValidBlockHeight?: number;
  }> {
    const { inputMint, outputMint, amountString } = this.intentRoute(intent);
    const wrapAndUnwrapSol = await this.resolveWrapAndUnwrapSol(
      intent,
      userPublicKey,
    );
    let quoteData = (await this.getQuote(inputMint, outputMint, amountString, {
      bypassCache: bypassQuoteCache,
      route,
    })) as unknown as Record<string, unknown>;

    const buildWithQuote = async (): Promise<{
      txB64: string;
      lastValidBlockHeight?: number;
    }> => {
      const body: Record<string, unknown> = {
        userPublicKey,
        quoteResponse: quoteData,
        wrapAndUnwrapSol,
        ...(this.config.jupiter.dynamicCuLimit
          ? { dynamicComputeUnitLimit: true }
          : {}),
        ...(this.config.jupiter.dynamicSlippage
          ? {
              dynamicSlippage: {
                maxBps: this.config.jupiter.dynamicSlippageMaxBps,
              },
            }
          : {}),
      };
      if (
        prioritizationFeeLamports !== undefined &&
        prioritizationFeeLamports !== "auto"
      ) {
        const n =
          typeof prioritizationFeeLamports === "number"
            ? prioritizationFeeLamports
            : Number(prioritizationFeeLamports);
        if (Number.isFinite(n) && n >= 0) {
          body.prioritizationFeeLamports = n;
        }
      }

      let data: MetisSwapInstructionsResponse;
      try {
        const res = await this.withJupiterRetry(
          () =>
            httpClient.post<MetisSwapInstructionsResponse>(
              this.swapInstructionsUrl(),
              body,
              {
                headers: {
                  ...this.jupiterRequestHeaders(),
                  "Content-Type": "application/json",
                },
              },
            ),
          "Jupiter /swap-instructions (build)",
        );
        data = res.data;
      } catch (e) {
        throw formatAxiosHttpError("Jupiter /swap-instructions (build)", e);
      }

      return this.buildTxFromMetisInstructions(data, userPublicKey);
    };

    let built = await buildWithQuote().catch(async () => {
      quoteData = (await this.getQuote(inputMint, outputMint, amountString, {
        bypassCache: true,
        route,
      })) as unknown as Record<string, unknown>;
      return buildWithQuote();
    });

    if (built.txB64 === "") {
      quoteData = (await this.getQuote(inputMint, outputMint, amountString, {
        bypassCache: true,
        route,
      })) as unknown as Record<string, unknown>;
      built = await buildWithQuote();
    }

    if (built.txB64 === "") {
      throw new Error("Jupiter /swap-instructions: no built transaction");
    }

    return {
      data: quoteData as unknown as JupiterOrderResponse,
      txB64: built.txB64,
      lastValidBlockHeight: built.lastValidBlockHeight,
    };
  }

  /**
   * Phase 2 fallback: GET `/swap/v2/order?taker=...` directly, bypassing the
   * `integrationMode` URL rewrite. Called both by the v2-order default branch
   * and as a recovery path when v1 `/quote` reports a terminal tradability
   * error (TOKEN_NOT_TRADABLE et al). v2 Ultra has broader token coverage,
   * including fresh Pump.fun / LaunchLab tokens that v1 Metis rejects.
   */
  private v2OrderUrl(): string {
    const raw = this.config.jupiter.swapApiBase.replace(/\/$/, "");
    const v2 = raw.replace(/\/swap\/v1$/i, "/swap/v2");
    return `${v2}/order`;
  }

  private async fetchV2OrderWithTaker(
    intent: ExecutionIntent,
    userPublicKey: string,
    prioritizationFeeLamports: string | number | undefined,
    route: RoutePreference,
  ): Promise<{
    data: JupiterOrderResponse;
    txB64: string;
    lastValidBlockHeight?: number;
  }> {
    const { inputMint, outputMint, amountString } = this.intentRoute(intent);
    const params: Record<string, string | number> = {
      inputMint,
      outputMint,
      amount: amountString,
      slippageBps: this.resolveSlippageBps(intent.slippageBpsOverride),
      taker: userPublicKey,
    };
    if (this.config.jupiter.dynamicSlippage) {
      params.dynamicSlippage = "true";
    }
    if (this.config.jupiter.maxAccounts > 0) {
      params.maxAccounts = this.config.jupiter.maxAccounts;
    }
    if (this.config.jupiter.restrictIntermediateTokens) {
      params.restrictIntermediateTokens = "true";
    }

    this.applyRoutePreference(params, route);

    if (
      prioritizationFeeLamports !== undefined &&
      prioritizationFeeLamports !== "auto"
    ) {
      const n =
        typeof prioritizationFeeLamports === "number"
          ? prioritizationFeeLamports
          : Number(prioritizationFeeLamports);
      if (Number.isFinite(n) && n >= 0) {
        params.priorityFeeLamports = n;
      }
    }

    let data: JupiterOrderResponse;
    try {
      const res = await this.withJupiterRetry(
        () =>
          httpClient.get<JupiterOrderResponse>(this.v2OrderUrl(), {
            params,
            headers: this.jupiterRequestHeaders(),
          }),
        "Jupiter /order (swap build)",
      );
      data = res.data;
    } catch (e) {
      throw formatAxiosHttpError("Jupiter /order (swap build)", e);
    }

    const tx = data.transaction;
    if (tx == null || tx === "") {
      const err =
        data.errorMessage ?? data.error ?? `errorCode=${data.errorCode ?? "?"}`;
      throw new Error(`Jupiter /order: no transaction (${err})`);
    }

    const rawLh = data.lastValidBlockHeight;
    const lh =
      rawLh === undefined || rawLh === null
        ? undefined
        : typeof rawLh === "string"
          ? Number(rawLh)
          : rawLh;
    const lastValidBlockHeight =
      lh !== undefined && Number.isFinite(lh) && lh > 0
        ? Math.floor(lh)
        : undefined;

    return { data, txB64: tx, lastValidBlockHeight };
  }

  /**
   * Ambil transaksi unsigned dari `/order` dengan `taker` (Swap API v2).
   * Untuk jalur hot path pakai `buildSwapTransactionWithQuote` agar satu round-trip.
   */
  async buildSwapTransaction(
    intent: ExecutionIntent,
    userPublicKey: string,
    prioritizationFeeLamports?: string | number,
  ): Promise<JupiterSwapBuild> {
    const { txB64, lastValidBlockHeight } = await this.fetchOrderWithTaker(
      intent,
      userPublicKey,
      prioritizationFeeLamports,
    );
    return {
      swapTransactionBase64: txB64,
      lastValidBlockHeight,
    };
  }
}
