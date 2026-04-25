import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Commitment,
} from "@solana/web3.js";
import { altCache } from "../perf/alt-cache.js";
import { RpcHealthChecker } from "../perf/rpc-healthcheck.js";
import type {
  AppConfig,
  ExecutionIntent,
  ExecutionResult,
  ExecutionStageMetrics,
} from "../types/index.js";
import type { JupiterQuoteResponse, JupiterSwapBuild } from "./jupiter.js";
import { JupiterClient } from "./jupiter.js";
import { sendTransactionViaHeliusSender } from "./helius-sender.js";
import { sendTransactionViaJito } from "./jito-sender.js";
import { sendJitoBundle } from "./jito-bundle-sender.js";
import {
  appendHeliusSenderTipIx,
  DEFAULT_HELIUS_SENDER_TIP_ACCOUNTS,
  pickTipRecipient,
} from "./helius-sender-tip.js";
import { DEFAULT_JITO_SENDER_TIP_ACCOUNTS } from "./jito-sender-tip.js";

const recentBlockhashFromTx = (tx: VersionedTransaction): string => {
  const m = tx.message as Readonly<{ recentBlockhash?: string }>;
  return typeof m.recentBlockhash === "string" ? m.recentBlockhash : "";
};

type ConfirmPayload = {
  signature: string;
  blockhash: string;
  lastValidBlockHeight?: number;
  commitment: Commitment;
};

type AwaitConfirmationOptions = {
  /** ms to give WebSocket-based confirmTransaction before polling fallback. */
  subscribeTimeoutMs?: number;
  /** absolute hard deadline from start; after this we give up. */
  deadlineMs?: number;
  /** interval between getSignatureStatuses polls. */
  pollIntervalMs?: number;
};

const commitmentLevelMatches = (
  level: "processed" | "confirmed" | "finalized" | null | undefined,
  target: Commitment,
): boolean => {
  if (level == null) return false;
  if (target === "processed") {
    return (
      level === "processed" || level === "confirmed" || level === "finalized"
    );
  }
  if (target === "confirmed") {
    return level === "confirmed" || level === "finalized";
  }
  if (target === "finalized") {
    return level === "finalized";
  }
  // Defensive: any other commitment (e.g. "recent" legacy) — accept processed+.
  return (
    level === "processed" || level === "confirmed" || level === "finalized"
  );
};

export class ExecutionEngine {
  readonly connection: Connection;
  readonly jupiter: JupiterClient;
  private readonly keypair: Keypair;
  private readonly appConfig: AppConfig;
  private warnedMissingTipAccounts = false;
  /**
   * N4: per-URL Connection for send-only race targets. Constructed once so
   * keep-alive sockets warm up once and stay reused. Reads (blockhash, wallet
   * state, ALT) still go through the primary `connection` — only
   * `sendRawTransaction` is fanned out.
   */
  private readonly extraSendConnections: Connection[];
  /** Level 2: auto-excludes slow paths from the race. null = disabled. */
  readonly healthChecker: RpcHealthChecker | null;

  constructor(
    config: AppConfig,
    connection: Connection,
    jupiter: JupiterClient,
  ) {
    this.appConfig = config;
    this.connection = connection;
    this.jupiter = jupiter;
    this.keypair = Keypair.fromSecretKey(bs58.decode(config.botPrivateKey));
    this.extraSendConnections = config.execution.extraSendRpcUrls.map(
      (url) => new Connection(url, config.helius.rpcCommitment),
    );

    // Level 2: healthchecker only matters when the multi-sender race is on.
    // With race off, there's a single primary path and fallback already
    // handles failure — no gain from exclusion.
    if (
      config.execution.rpcHealthCheck.enabled &&
      config.execution.multiSenderRace
    ) {
      const hc = new RpcHealthChecker(
        config.execution.rpcHealthCheck.probeIntervalMs,
        config.execution.rpcHealthCheck.latencyThresholdMs,
        config.execution.rpcHealthCheck.probeTimeoutMs,
      );
      // Register every endpoint that sendMultiRace will fan out to so the
      // healthy filter has state for all of them from the first probe cycle.
      const heliusUrl =
        config.execution.senderEndpoint?.trim() ||
        config.helius.tipEndpoints[0] ||
        "https://sender.helius-rpc.com/fast";
      const jitoUrl =
        config.execution.jitoSenderUrl?.trim() ||
        "https://mainnet.block-engine.jito.wtf/api/v1/transactions";
      hc.register(heliusUrl, "helius-sender");
      hc.register(jitoUrl, "jito-sender");
      hc.register(config.helius.rpcUrl, "rpc-primary");
      config.execution.extraSendRpcUrls.forEach((url, idx) => {
        hc.register(url, `rpc-${idx + 1}`);
      });
      this.healthChecker = hc;
    } else {
      this.healthChecker = null;
    }
  }

  getTakerAddress(): string {
    return this.keypair.publicKey.toBase58();
  }

  getTakerPublicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  getTakerKeypair(): Keypair {
    return this.keypair;
  }

  /**
   * Build a SendContext for direct-pump executors so they share the same tip
   * + multi-sender race infrastructure as the Jupiter path. Without this,
   * direct-pump sends tip-less via a single RPC — Helius Sender rejects and
   * Jito ignores, defeating the multi-race benefit entirely.
   *
   * Tip recipient is picked based on the configured senderMode:
   *   - helius: random Helius tip account (required, >= MIN_SENDER_TIP_LAMPORTS)
   *   - jito:   random Jito tip account
   *   - rpc:    no tip (plain RPC send doesn't prioritize by tip)
   *
   * The returned `sendRaw` fans out to Helius + Jito + all configured RPCs
   * when EXECUTION_MULTI_SENDER_RACE=true, otherwise follows the legacy
   * primary+RPC-backup path.
   */
  prepareDirectExecutorContext(side: "BUY" | "SELL"): {
    tipIxs: TransactionInstruction[];
    sendRaw: (raw: Uint8Array) => Promise<string>;
  } {
    const tipIxs: TransactionInstruction[] = [];
    const tipLamports = this.chooseTipLamports(side);
    if (this.isExternalSender() && tipLamports > 0) {
      const lamports = Math.max(200_000, Math.floor(tipLamports));
      const payer = this.keypair.publicKey;
      const mode = this.senderMode();

      const tipAccounts =
        mode === "helius"
          ? this.appConfig.helius.tipAccounts.length > 0
            ? this.appConfig.helius.tipAccounts
            : [...DEFAULT_HELIUS_SENDER_TIP_ACCOUNTS]
          : this.appConfig.execution.jitoTipAccounts.length > 0
            ? this.appConfig.execution.jitoTipAccounts
            : [...DEFAULT_JITO_SENDER_TIP_ACCOUNTS];

      if (tipAccounts.length > 0) {
        tipIxs.push(
          SystemProgram.transfer({
            fromPubkey: payer,
            toPubkey: pickTipRecipient(tipAccounts),
            lamports,
          }),
        );
      }
    }
    return {
      tipIxs,
      sendRaw: (raw) => this.sendViaConfiguredSender(raw),
    };
  }

  private senderMode(): "rpc" | "helius" | "jito" {
    return this.appConfig.execution.senderMode;
  }

  private isExternalSender(): boolean {
    const mode = this.senderMode();
    return mode === "helius" || mode === "jito";
  }

  private chooseTipLamports(side: "BUY" | "SELL"): number {
    if (!this.isExternalSender() || !this.appConfig.execution.tipEnabled) {
      return 0;
    }
    return side === "SELL"
      ? this.appConfig.execution.tipLamportsSell
      : this.appConfig.execution.tipLamportsBuy;
  }

  /**
   * R17: Build a standalone tip transaction for Jito bundle submission.
   * Avoids the expensive decompile/recompile of the swap tx.
   */
  private async buildTipTransaction(
    tipLamports: number,
    tipRecipient: PublicKey,
    blockhash: string,
  ): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.feePayer = this.keypair.publicKey;
    tx.recentBlockhash = blockhash;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey: tipRecipient,
        lamports: Math.max(200_000, Math.floor(tipLamports)),
      }),
    );
    tx.sign(this.keypair);
    return tx.serialize();
  }

  private heliusSenderUrl(): string {
    return (
      this.appConfig.execution.senderEndpoint?.trim() ||
      this.appConfig.helius.tipEndpoints[0] ||
      "https://sender.helius-rpc.com/fast"
    );
  }

  private jitoSenderUrl(): string {
    return (
      this.appConfig.execution.jitoSenderUrl?.trim() ||
      "https://mainnet.block-engine.jito.wtf/api/v1/transactions"
    );
  }

  /**
   * Phase 5 / N4 multi-sender race: send via every configured path in parallel
   * and return the first FULFILLED signature (`Promise.any`). The duplicate tx
   * is harmless — validators dedupe by signature.
   *
   * Behavior:
   * - `EXECUTION_MULTI_SENDER_RACE=true`: race [Helius Sender, Jito Sender,
   *   primary RPC, ...extra RPCs]. Max landing coverage, ~3-5x outbound calls.
   * - Legacy (default false): current "primary sender + RPC backup" behavior.
   *
   * Only raises an error when ALL paths fail; in that case we surface the
   * primary-path error (most actionable) rather than AggregateError.
   */
  private async sendViaConfiguredSender(raw: Uint8Array): Promise<string> {
    const mode = this.senderMode();
    const multiRace = this.appConfig.execution.multiSenderRace;

    if (multiRace) {
      return this.sendMultiRace(raw);
    }

    const primarySend = (): Promise<string> => {
      if (mode === "helius") {
        return sendTransactionViaHeliusSender(
          this.heliusSenderUrl(),
          this.appConfig.helius.rpcUrl,
          raw,
        );
      }
      if (mode === "jito") {
        return sendTransactionViaJito(this.jitoSenderUrl(), raw);
      }
      return this.connection.sendRawTransaction(raw, {
        skipPreflight: true,
        maxRetries: 2,
      });
    };

    if (mode !== "helius" && mode !== "jito") {
      return primarySend();
    }

    // Phase 5: race primary sender vs RPC backup — first fulfilled wins.
    let primaryError: unknown;
    const primary = primarySend().catch((e) => {
      primaryError = e;
      throw e;
    });
    const backup = this.connection
      .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
      .catch((e) => {
        throw e;
      });

    try {
      return await Promise.any([primary, backup]);
    } catch (aggregate) {
      // All paths failed — surface primary error if present, else aggregate.
      if (primaryError != null) {
        throw primaryError;
      }
      throw aggregate;
    }
  }

  /**
   * N4: fan out raw tx to Helius + Jito + primary RPC + every extra RPC in
   * parallel. First fulfilled signature wins. Note: the same tip instruction
   * already embedded by `appendHeliusSenderTipIx` (for helius mode) is reused
   * across all paths — validators accept the tx regardless of whether they
   * recognize the tip recipient, so duplicate delivery is safe.
   *
   * Level 2: each endpoint is gated by `healthChecker.isHealthy()`. Endpoints
   * whose recent probe RTT exceeded the threshold are skipped until they
   * recover, keeping the race pool focused on responsive paths only. If every
   * endpoint is currently unhealthy (rare total-outage scenario), we fall
   * back to racing all of them so the pipeline degrades rather than stalls.
   */
  private async sendMultiRace(raw: Uint8Array): Promise<string> {
    let primaryError: unknown;

    const heliusUrl = this.heliusSenderUrl();
    const jitoUrl = this.jitoSenderUrl();
    const primaryRpcUrl = this.appConfig.helius.rpcUrl;

    const hc = this.healthChecker;
    const includeAll = hc == null || !hc.anyHealthy();
    const isHealthy = (url: string): boolean =>
      hc == null ? true : hc.isHealthy(url);

    const attempts: Array<Promise<string>> = [];

    if (includeAll || isHealthy(heliusUrl)) {
      attempts.push(
        sendTransactionViaHeliusSender(heliusUrl, primaryRpcUrl, raw).catch(
          (e) => {
            primaryError = e;
            throw e;
          },
        ),
      );
    }
    if (includeAll || isHealthy(jitoUrl)) {
      attempts.push(
        sendTransactionViaJito(jitoUrl, raw).catch((e) => {
          throw e;
        }),
      );
    }
    if (includeAll || isHealthy(primaryRpcUrl)) {
      attempts.push(
        this.connection
          .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
          .catch((e) => {
            throw e;
          }),
      );
    }

    const extraUrls = this.appConfig.execution.extraSendRpcUrls;
    this.extraSendConnections.forEach((conn, idx) => {
      const url = extraUrls[idx] ?? "";
      if (includeAll || isHealthy(url)) {
        attempts.push(
          conn
            .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
            .catch((e) => {
              throw e;
            }),
        );
      }
    });

    // Safety net: if filtering removed every path (e.g., registration mismatch),
    // run the full race so sends never dead-end silently.
    if (attempts.length === 0) {
      attempts.push(
        sendTransactionViaHeliusSender(heliusUrl, primaryRpcUrl, raw).catch(
          (e) => {
            primaryError = e;
            throw e;
          },
        ),
      );
    }

    try {
      return await Promise.any(attempts);
    } catch (aggregate) {
      if (primaryError != null) {
        throw primaryError;
      }
      throw aggregate;
    }
  }

  /**
   * Confirm a transaction with a bounded WebSocket subscribe attempt and a
   * HTTP getSignatureStatuses polling fallback. This prevents pipeline hangs
   * when the RPC WSS socket dies (observed ETIMEDOUT 29s outliers).
   *
   * Returns { err: on-chain error | null }. Throws only on overall deadline
   * exceeded or transient RPC errors during the final poll window.
   */
  private async awaitConfirmationWithFallback(
    payload: ConfirmPayload,
    opts?: AwaitConfirmationOptions,
  ): Promise<{ err: unknown | null }> {
    const subscribeTimeoutMs = Math.max(100, opts?.subscribeTimeoutMs ?? 800);
    const deadlineMs = Math.max(
      subscribeTimeoutMs + 500,
      opts?.deadlineMs ?? 10_000,
    );
    const pollIntervalMs = Math.max(10, opts?.pollIntervalMs ?? 30);
    const startedAtMs = Date.now();

    const subscribeAttempt = async (): Promise<{ err: unknown | null }> => {
      if (
        payload.lastValidBlockHeight != null &&
        payload.blockhash.length > 0
      ) {
        const r = await this.connection.confirmTransaction(
          {
            signature: payload.signature,
            blockhash: payload.blockhash,
            lastValidBlockHeight: payload.lastValidBlockHeight,
          },
          payload.commitment,
        );
        return { err: r.value.err ?? null };
      }
      const r = await this.connection.confirmTransaction(
        payload.signature,
        payload.commitment,
      );
      return { err: r.value.err ?? null };
    };

    const SUBSCRIBE_TIMEOUT = Symbol("subscribe-timeout");
    const SUBSCRIBE_ERROR = Symbol("subscribe-error");
    type SubscribeRaceResult =
      | { err: unknown | null }
      | typeof SUBSCRIBE_TIMEOUT
      | typeof SUBSCRIBE_ERROR;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<typeof SUBSCRIBE_TIMEOUT>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve(SUBSCRIBE_TIMEOUT),
        subscribeTimeoutMs,
      );
    });

    const raced: SubscribeRaceResult = await Promise.race<SubscribeRaceResult>([
      subscribeAttempt().catch(() => SUBSCRIBE_ERROR),
      timeoutPromise,
    ]);
    if (timeoutHandle != null) {
      clearTimeout(timeoutHandle);
    }

    if (raced !== SUBSCRIBE_TIMEOUT && raced !== SUBSCRIBE_ERROR) {
      return raced;
    }

    // Polling fallback — independent of WSS.
    while (Date.now() - startedAtMs < deadlineMs) {
      try {
        const resp = await this.connection.getSignatureStatuses(
          [payload.signature],
          { searchTransactionHistory: false },
        );
        const status = resp?.value?.[0] ?? null;
        if (status != null) {
          if (status.err != null) {
            return { err: status.err };
          }
          // confirmations === null means finalized (per web3.js).
          if (status.confirmations === null) {
            return { err: null };
          }
          if (
            commitmentLevelMatches(
              status.confirmationStatus,
              payload.commitment,
            )
          ) {
            return { err: null };
          }
        }
      } catch {
        // Swallow transient RPC errors; next tick retries.
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `confirm deadline exceeded (${Date.now() - startedAtMs}ms) sig=${payload.signature.slice(0, 12)}...`,
    );
  }

  private confirmInBackground(payload: ConfirmPayload): void {
    void this.awaitConfirmationWithFallback(payload, {
      subscribeTimeoutMs: 800,
      deadlineMs: 12_000,
      pollIntervalMs: 30,
    })
      .then((res) => {
        if (res.err != null) {
          console.warn(
            `[execution] background confirm on-chain err sig=${payload.signature.slice(0, 12)}... err=${JSON.stringify(res.err)}`,
          );
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          `[execution] background confirm failed sig=${payload.signature.slice(0, 12)}... err=${msg}`,
        );
      });
  }

  /** Satu panggilan Jupiter /order + prebuilt swap â€” hindari quote+ganda build (~200ms+) */
  async execute(
    intent: ExecutionIntent,
    quote: JupiterQuoteResponse,
    prebuiltSwap?: JupiterSwapBuild,
  ): Promise<ExecutionResult> {
    const started = Date.now();
    const stage: ExecutionStageMetrics = {};
    const commitment = this.appConfig.execution.confirmCommitment as Commitment;
    const senderMode = this.senderMode();

    try {
      if (intent.delayMs > 0) {
        const tDelay = Date.now();
        await new Promise((resolve) => setTimeout(resolve, intent.delayMs));
        stage.delayMs = Date.now() - tDelay;
      }

      let swapBuild: JupiterSwapBuild;
      if (prebuiltSwap) {
        swapBuild = prebuiltSwap;
      } else {
        const tQuote = Date.now();
        swapBuild = await this.jupiter.buildSwapTransaction(
          intent,
          this.keypair.publicKey.toBase58(),
        );
        stage.quoteBuildMs = Date.now() - tQuote;
      }

      const tDeserialize = Date.now();
      let tx = VersionedTransaction.deserialize(
        Buffer.from(swapBuild.swapTransactionBase64, "base64"),
      );
      stage.deserializeMs = Date.now() - tDeserialize;

      const tipLamports = this.chooseTipLamports(intent.side);
      stage.tipLamports = tipLamports;

      // Resolve ALTs once here and pass to tip injection below. Only needed
      // when senderMode=helius (tip injected into swap tx); jito uses a
      // separate tip tx in a bundle, so no ALT resolution required.
      const needsAltsForTip = senderMode === "helius" && tipLamports > 0;
      let preResolvedAlts: AddressLookupTableAccount[] | undefined;
      if (needsAltsForTip && tx.message.addressTableLookups.length > 0) {
        const altAddrs = tx.message.addressTableLookups.map((l) =>
          l.accountKey.toBase58(),
        );
        preResolvedAlts = await altCache.resolve(this.connection, altAddrs);
      }

      // R17: For Jito mode, skip expensive tip injection into swap tx.
      // Instead, build a separate tip tx and send both as an atomic bundle.
      let jitoBundleTipRaw: Uint8Array | undefined;

      if (this.isExternalSender() && tipLamports > 0) {
        const tipAccounts =
          senderMode === "helius"
            ? this.appConfig.helius.tipAccounts.length > 0
              ? this.appConfig.helius.tipAccounts
              : [...DEFAULT_HELIUS_SENDER_TIP_ACCOUNTS]
            : this.appConfig.execution.jitoTipAccounts.length > 0
              ? this.appConfig.execution.jitoTipAccounts
              : [...DEFAULT_JITO_SENDER_TIP_ACCOUNTS];
        const tTip = Date.now();

        if (tipAccounts.length > 0) {
          const tipTo = pickTipRecipient(tipAccounts);
          if (senderMode === "jito") {
            const blockhash = recentBlockhashFromTx(tx);
            jitoBundleTipRaw = await this.buildTipTransaction(
              tipLamports,
              tipTo,
              blockhash,
            );
          } else {
            tx = await appendHeliusSenderTipIx(
              this.connection,
              tx,
              this.keypair.publicKey,
              tipLamports,
              tipTo,
              preResolvedAlts,
            );
          }
        } else if (!this.warnedMissingTipAccounts) {
          this.warnedMissingTipAccounts = true;
          console.warn(
            "[execution] tip enabled but no TIP_ACCOUNTS set; tip injection skipped",
          );
        }
        stage.tipInjectMs = Date.now() - tTip;
      }

      const tSign = Date.now();
      tx.sign([this.keypair]);
      stage.signMs = Date.now() - tSign;

      const tSerialize = Date.now();
      const raw = tx.serialize();
      stage.serializeMs = Date.now() - tSerialize;
      let signature: string;

      const tSend = Date.now();
      if (senderMode === "jito" && jitoBundleTipRaw != null) {
        // R17: Send as Jito bundle [swapTx, tipTx] for atomic execution.
        const bundleEndpoint = (
          this.appConfig.execution.jitoSenderUrl?.trim() ||
          "https://mainnet.block-engine.jito.wtf/api/v1/transactions"
        ).replace(/\/transactions\/?$/, "/bundles");
        const bundleId = await sendJitoBundle(
          [raw, jitoBundleTipRaw],
          bundleEndpoint,
        );
        // Bundle ID is not a tx signature — extract sig from the signed swap tx.
        signature = bs58.encode(tx.signatures[0]!);
        if (this.appConfig.debug.whalePipeline) {
          console.log(
            `[whale-debug] jito bundle sent bundleId=${bundleId} sig=${signature.slice(0, 12)}...`,
          );
        }
      } else {
        signature = await this.sendViaConfiguredSender(raw);
      }
      stage.sendMs = Date.now() - tSend;

      const blockhash = recentBlockhashFromTx(tx);
      const lh = swapBuild.lastValidBlockHeight;
      const useFastAck =
        intent.forceSyncConfirm === true
          ? false
          : intent.side === "BUY"
            ? true
            : this.appConfig.execution.fastAck;
      if (useFastAck) {
        this.confirmInBackground({
          signature,
          blockhash,
          lastValidBlockHeight: lh,
          commitment,
        });
        const impact = Number(quote.priceImpactPct ?? 0);
        return {
          signature,
          status: "submitted",
          senderMode,
          whaleWallet: intent.whaleWallet,
          token: intent.token,
          side: intent.side,
          sizeSol: intent.size,
          latencyMs: Date.now() - started,
          executionStageMs: stage,
          quotePriceImpactPct: Number.isFinite(impact) ? impact : undefined,
          inAmountRaw: quote.inAmount as string | undefined,
          outAmountRaw: quote.outAmount as string | undefined,
        };
      }

      const tConfirm = Date.now();
      const confirmRes = await this.awaitConfirmationWithFallback(
        {
          signature,
          blockhash,
          lastValidBlockHeight: lh,
          commitment,
        },
        { subscribeTimeoutMs: 800, deadlineMs: 10_000, pollIntervalMs: 30 },
      );
      stage.confirmMs = Date.now() - tConfirm;

      if (confirmRes.err != null) {
        throw new Error(`on-chain err: ${JSON.stringify(confirmRes.err)}`);
      }

      const impact = Number(quote.priceImpactPct ?? 0);
      return {
        signature,
        status: "confirmed",
        senderMode,
        landedCommitment: this.appConfig.execution.confirmCommitment,
        whaleWallet: intent.whaleWallet,
        token: intent.token,
        side: intent.side,
        sizeSol: intent.size,
        latencyMs: Date.now() - started,
        executionStageMs: stage,
        quotePriceImpactPct: Number.isFinite(impact) ? impact : undefined,
        inAmountRaw: quote.inAmount as string | undefined,
        outAmountRaw: quote.outAmount as string | undefined,
      };
    } catch (error) {
      return {
        signature: "",
        status: "failed",
        senderMode,
        error: error instanceof Error ? error.message : String(error),
        whaleWallet: intent.whaleWallet,
        token: intent.token,
        side: intent.side,
        sizeSol: intent.size,
        latencyMs: Date.now() - started,
        executionStageMs: stage,
      };
    }
  }
}
