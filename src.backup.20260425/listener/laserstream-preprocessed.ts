import bs58 from "bs58";
import { type Connection, PublicKey } from "@solana/web3.js";
import type { AppConfig, RawWhaleTransaction } from "../types/index.js";
import { altCache } from "../perf/alt-cache.js";
import {
  decodeWhaleInstruction,
  type WhaleInstructionFrame,
} from "./decode-instruction.js";

type OnWhaleTx = (tx: RawWhaleTransaction) => void;

/**
 * Loose typings for the dynamic helius-laserstream import. The package ships
 * a NAPI native binary that is unavailable on Windows; importing it eagerly
 * would crash `tsx watch` / `node dist` on the Windows dev machine even when
 * the actual run target is Linux. Deferring to start() lets the TS compiler
 * resolve types at build time without requiring the native binary at import.
 */
type LaserstreamHandle = {
  id: string;
  cancel: () => void;
};

type SubscribePreprocessedFn = (
  config: { apiKey: string; endpoint: string },
  request: {
    transactions: Record<
      string,
      {
        vote?: boolean;
        accountInclude?: string[];
        accountExclude?: string[];
        accountRequired?: string[];
      }
    >;
  },
  onData: (update: PreprocessedUpdate) => void,
  onError?: (err: Error) => void,
) => Promise<LaserstreamHandle>;

type PreprocessedUpdate = {
  filters?: string[];
  transaction?: {
    transaction?: {
      signature?: Uint8Array;
      isVote?: boolean;
      transaction?: {
        signatures?: Uint8Array[];
        message?: {
          header?: { numRequiredSignatures?: number };
          accountKeys?: Uint8Array[];
          recentBlockhash?: Uint8Array;
          instructions?: Array<{
            programIdIndex?: number;
            accounts?: Uint8Array;
            data?: Uint8Array;
          }>;
          versioned?: boolean;
          addressTableLookups?: Array<{
            accountKey?: Uint8Array;
            writableIndexes?: Uint8Array;
            readonlyIndexes?: Uint8Array;
          }>;
        };
      };
    };
    slot?: number | { toString(): string };
  };
};

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

const keyToB58 = (k: Uint8Array | undefined): string => {
  if (k == null) return "";
  try {
    return bs58.encode(k);
  } catch {
    return "";
  }
};

/** Decode an indices Uint8Array into number[] — protobuf encodes per-byte. */
const indexBytesToArray = (buf: Uint8Array | undefined): number[] => {
  if (buf == null || buf.length === 0) return [];
  const out: number[] = new Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i]!;
  return out;
};

/**
 * Helius Laserstream PREPROCESSED whale tx stream. Replaces the prior
 * yellowstone-grpc transactionSubscribe path. Trades execution metadata
 * (token balance deltas, logs, error status) for ~50–150 ms earlier signal,
 * forcing the decoder to work entirely from instruction data.
 *
 * SDK-side reconnection is enabled by default; this wrapper only owns the
 * lifecycle (start/stop/reload) and the whale filter.
 */
export class PreprocessedLaserstreamClient {
  private handle?: LaserstreamHandle;
  private stopped = false;
  private connecting = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private readonly whaleSet: Set<string>;
  private subscribeFn?: SubscribePreprocessedFn;

  constructor(
    private readonly config: AppConfig,
    private readonly connection: Connection,
    private readonly onWhaleTx: OnWhaleTx,
  ) {
    this.whaleSet = new Set(config.whaleWallets);
  }

  private reconnectDelayMs(attempt: number): number {
    const pow = Math.max(0, attempt - 1);
    return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** pow);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    if (this.reconnectTimer != null || this.connecting) return;

    const nextAttempt = this.reconnectAttempts + 1;
    this.reconnectAttempts = nextAttempt;
    const delay = this.reconnectDelayMs(nextAttempt);
    console.warn(
      `[laserstream-pp] reconnect scheduled in ${delay}ms (attempt ${nextAttempt}) reason=${reason}`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectAndSubscribe().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[laserstream-pp] reconnect failed: ${msg}`);
        this.scheduleReconnect("connect_failed");
      });
    }, delay);
  }

  private async loadSdk(): Promise<SubscribePreprocessedFn> {
    if (this.subscribeFn != null) return this.subscribeFn;
    // Dynamic import keeps the native binary out of the cold-start path on
    // platforms where it isn't published (Windows). Production runs on Linux
    // where the NAPI binary is available.
    try {
      const mod = (await import("helius-laserstream")) as {
        subscribePreprocessed: SubscribePreprocessedFn;
      };
      if (typeof mod.subscribePreprocessed !== "function") {
        throw new Error(
          "helius-laserstream module loaded but `subscribePreprocessed` is not a function (SDK version mismatch?)",
        );
      }
      this.subscribeFn = mod.subscribePreprocessed;
      return this.subscribeFn;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[laserstream-pp] FATAL: failed to load helius-laserstream SDK: ${msg}`,
      );
      console.error(
        "[laserstream-pp] hint: native NAPI binary required (Linux/macOS only). Check `node_modules/helius-laserstream/laserstream-napi.*.node` exists.",
      );
      throw e;
    }
  }

  private async connectAndSubscribe(): Promise<void> {
    if (this.config.whaleWallets.length === 0) {
      throw new Error(
        "Whale wallet list is empty (set `whaleWallets` in configuration.json)",
      );
    }
    if (this.connecting) return;
    this.connecting = true;

    try {
      // Cancel any prior handle before opening a new one. SDK does not auto-
      // reset state across reload calls.
      try {
        this.handle?.cancel();
      } catch {
        // ignore — best-effort
      }
      this.handle = undefined;

      const subscribe = await this.loadSdk();
      const endpoint = this.config.helius.laserstreamEndpoint.trim();
      const apiKey = this.config.helius.apiKey.trim();

      const handle = await subscribe(
        { apiKey, endpoint },
        {
          transactions: {
            whale_wallets: {
              vote: false,
              accountInclude: this.config.whaleWallets,
              accountExclude: [],
              accountRequired: [],
            },
          },
        },
        (update) => {
          if (this.stopped) return;
          this.handleUpdate(update);
        },
        (err) => {
          if (this.stopped) return;
          console.error("[laserstream-pp] stream error:", err);
          this.handle = undefined;
          this.scheduleReconnect("stream_error");
        },
      );

      this.handle = handle;
      this.reconnectAttempts = 0;
      console.log(
        `[laserstream-pp] subscribed PREPROCESSED · ${this.config.whaleWallets.length} whale(s) · endpoint ${endpoint.replace(/^https?:\/\//, "")}`,
      );
      if (this.config.debug.whalePipeline) {
        console.log(
          "[whale-debug] preprocessed instruction-decode pipeline (no meta — sellFraction = full balance)",
        );
      }
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Resolve `addressTableLookups` for a versioned message. Returns the
   * concatenated [writable…, readonly…] pubkeys in the canonical Solana
   * order, matching how meta.loadedWritableAddresses + loadedReadonlyAddresses
   * would have appeared in a full-meta tx.
   *
   * Errors here are logged and the tx is dropped — the alt-cache path handles
   * concurrent cold lookups gracefully so this is rare.
   */
  private async resolveAltKeys(
    lookups: Array<{
      accountKey?: Uint8Array;
      writableIndexes?: Uint8Array;
      readonlyIndexes?: Uint8Array;
    }>,
  ): Promise<{ writable: string[]; readonly: string[] } | null> {
    if (lookups.length === 0) {
      return { writable: [], readonly: [] };
    }
    const altAddrs: string[] = [];
    for (const lk of lookups) {
      if (lk.accountKey == null) return null;
      altAddrs.push(keyToB58(lk.accountKey));
    }
    let resolved;
    try {
      resolved = await altCache.resolve(this.connection, altAddrs);
    } catch (e) {
      if (this.config.debug.whalePipeline) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[whale-debug] alt resolve failed: ${msg}`);
      }
      return null;
    }
    const writable: string[] = [];
    const readonly: string[] = [];
    for (let i = 0; i < lookups.length; i++) {
      const lk = lookups[i]!;
      const alt = resolved[i];
      if (alt == null) return null;
      const wIdxs = lk.writableIndexes ?? new Uint8Array();
      const rIdxs = lk.readonlyIndexes ?? new Uint8Array();
      for (let j = 0; j < wIdxs.length; j++) {
        const idx = wIdxs[j]!;
        const addr = alt.state.addresses[idx];
        if (addr == null) return null;
        writable.push(addr.toBase58());
      }
      for (let j = 0; j < rIdxs.length; j++) {
        const idx = rIdxs[j]!;
        const addr = alt.state.addresses[idx];
        if (addr == null) return null;
        readonly.push(addr.toBase58());
      }
    }
    return { writable, readonly };
  }

  private handleUpdate(update: PreprocessedUpdate): void {
    const ingestedAtMs = Date.now();
    const wrap = update.transaction?.transaction;
    if (wrap == null) {
      // Ping/pong updates also flow through this callback — they have no
      // .transaction field. Only warn for shape we don't recognise.
      if (update.transaction != null && this.config.debug.whalePipeline) {
        console.warn(
          "[whale-debug] laserstream-pp update.transaction.transaction missing (shape unexpected)",
        );
      }
      return;
    }
    if (wrap.isVote === true) return;

    const message = wrap.transaction?.message;
    if (message == null) {
      if (this.config.debug.whalePipeline) {
        console.warn(
          "[whale-debug] laserstream-pp message missing on tx wrapper",
        );
      }
      return;
    }

    const sigBytes = wrap.signature;
    if (sigBytes == null) {
      if (this.config.debug.whalePipeline) {
        console.warn(
          "[whale-debug] laserstream-pp signature missing on tx (cannot dedup or trace)",
        );
      }
      return;
    }
    const signature = bs58.encode(sigBytes);

    const staticKeys: string[] = (message.accountKeys ?? []).map((b) =>
      keyToB58(b),
    );

    // Quick whale-presence check on static keys ONLY first. The whale signs
    // the tx, so it must be in the signer block — never in the lookup-table
    // section. If absent here, drop without paying ALT resolution cost.
    let whale: string | undefined;
    for (const k of staticKeys) {
      if (this.whaleSet.has(k)) {
        whale = k;
        break;
      }
    }
    if (whale == null) {
      if (this.config.debug.whalePipeline) {
        console.warn(
          `[whale-debug] laserstream-pp skip: whale not in static keys sig=${signature.slice(0, 12)}...`,
        );
      }
      return;
    }

    const lookups = message.addressTableLookups ?? [];
    const isVersioned = message.versioned === true || lookups.length > 0;

    const finalize = (writable: string[], readonly: string[]): void => {
      const accountKeys = [...staticKeys, ...writable, ...readonly];
      const instructions = (message.instructions ?? []).map((ix) => ({
        programIdIndex: ix.programIdIndex ?? 0,
        accountIndices: indexBytesToArray(ix.accounts),
        data: ix.data ?? new Uint8Array(),
      }));

      const frame: WhaleInstructionFrame = {
        whale: whale!,
        signature,
        accountKeys,
        instructions,
        feedSource: "grpc-pp",
        ingestedAtMs,
        versioned: isVersioned,
        altCount: lookups.length,
      };
      const onDrop = this.config.debug.whalePipeline
        ? (reason: string): void => {
            console.warn(
              `[whale-debug] [feed:laserstream-pp] decode drop ${reason} sig=${signature.slice(0, 16)}... whale=${frame.whale.slice(0, 8)}...`,
            );
          }
        : undefined;
      const decoded = decodeWhaleInstruction(frame, onDrop);
      if (decoded == null) return;
      if (this.config.debug.whalePipeline) {
        const tok = decoded.type === "BUY" ? decoded.tokenOut : decoded.tokenIn;
        const amt = Number.isFinite(decoded.amount)
          ? decoded.amount.toFixed(6)
          : "∞";
        console.log(
          `[whale-debug] [feed:laserstream-pp] whale:tx ${decoded.type} amount=${amt} SOL token=${tok.slice(0, 8)}... protocol=${decoded.protocolHint}`,
        );
      }
      this.onWhaleTx(decoded);
    };

    if (!isVersioned) {
      finalize([], []);
      return;
    }

    void this.resolveAltKeys(lookups).then(
      (resolved) => {
        if (resolved == null) {
          if (this.config.debug.whalePipeline) {
            console.warn(
              `[whale-debug] laserstream-pp skip: alt resolve failed sig=${signature.slice(0, 12)}...`,
            );
          }
          return;
        }
        finalize(resolved.writable, resolved.readonly);
      },
      (e) => {
        if (this.config.debug.whalePipeline) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            `[whale-debug] laserstream-pp skip: alt resolve threw sig=${signature.slice(0, 12)}... err=${msg}`,
          );
        }
      },
    );
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    await this.connectAndSubscribe();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    try {
      this.handle?.cancel();
    } catch {
      // ignore
    }
    this.handle = undefined;
  }

  /**
   * Hot-reload whale list. SDK does not support changing filters on a live
   * stream, so we cancel + resubscribe with the new accountInclude.
   */
  async reloadWhales(whales: string[]): Promise<number> {
    const clean = Array.from(
      new Set(
        (whales ?? [])
          .map((w) => (typeof w === "string" ? w.trim() : ""))
          .filter(Boolean),
      ),
    );
    this.config.whaleWallets.length = 0;
    this.config.whaleWallets.push(...clean);
    this.whaleSet.clear();
    for (const w of clean) this.whaleSet.add(w);
    if (this.stopped) return clean.length;
    await this.connectAndSubscribe();
    return clean.length;
  }
}

// Sanity-check anchor against PublicKey to keep tree-shake honest — not used.
void PublicKey;
