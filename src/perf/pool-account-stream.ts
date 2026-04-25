import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { ClientDuplexStream } from "@triton-one/yellowstone-grpc";

type GeyserClientInstance = {
  connect(): Promise<void>;
  subscribe(): Promise<ClientDuplexStream>;
};

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
/** Pool cache entry max age. Pool state on pump.fun AMM v2 typically changes
 *  every swap; a 2s TTL ensures we never serve stale reserves under active
 *  whale trading while still giving most back-to-back swaps a cache hit. */
const POOL_CACHE_TTL_MS = 2_000;
/** LRU eviction threshold. Prevents unbounded growth when many whales scalp
 *  many tokens; cold pools older than this get unsubscribed. */
const POOL_MAX_ENTRIES = 64;

const resolveGeyserClientCtor = (
  moduleValue: unknown,
): new (
  endpoint: string,
  token: string | undefined,
  options: undefined,
) => GeyserClientInstance => {
  const direct = (moduleValue as { default?: unknown })?.default;
  const nested =
    direct && typeof direct === "object"
      ? (direct as { default?: unknown }).default
      : undefined;
  const ctor = (typeof direct === "function" ? direct : nested) as unknown;
  if (typeof ctor !== "function") {
    throw new Error("yellowstone init failed: client constructor not found");
  }
  return ctor as new (
    endpoint: string,
    token: string | undefined,
    options: undefined,
  ) => GeyserClientInstance;
};

const toAccountInfo = (
  owner: string | Uint8Array,
  data: Uint8Array,
  executable: boolean,
  lamports: string | number,
  rentEpoch: string | number,
): AccountInfo<Buffer> => {
  const ownerPk =
    typeof owner === "string" ? new PublicKey(owner) : new PublicKey(owner);
  const lam = typeof lamports === "string" ? Number(lamports) : lamports;
  const re = typeof rentEpoch === "string" ? Number(rentEpoch) : rentEpoch;
  return {
    executable,
    owner: ownerPk,
    lamports: lam,
    data: Buffer.from(data),
    rentEpoch: re,
  };
};

type PoolAccountEntry = {
  poolPubkey: PublicKey;
  poolBaseAta: PublicKey;
  poolQuoteAta: PublicKey;
  baseMint: PublicKey;
  baseTokenProgram: PublicKey;
  poolAccountInfo: AccountInfo<Buffer> | null;
  poolBaseAccountInfo: AccountInfo<Buffer> | null;
  poolQuoteAccountInfo: AccountInfo<Buffer> | null;
  lastUpdateAtMs: number;
  lastAccessedAtMs: number;
};

export type PoolStreamCacheHit = {
  poolAccountInfo: AccountInfo<Buffer>;
  poolBaseAccountInfo: AccountInfo<Buffer>;
  poolQuoteAccountInfo: AccountInfo<Buffer>;
  freshnessMs: number;
};

type EndpointConfig = {
  endpoint: string;
  apiKey: string;
  commitment: "processed" | "confirmed" | "finalized";
  debug: boolean;
};

/**
 * Dedicated gRPC subscription for Pump AMM v2 pool accounts. Push-updates the
 * in-memory cache so the hot swap path can skip the ~30-45ms RPC round trip
 * for `getMultipleAccountsInfo([pool, poolBaseAta, poolQuoteAta])`.
 *
 * - Per-pool entries track the pool data account + its base/quote ATAs.
 * - Subscription set is applied via `stream.write(new SubscribeRequest)` so
 *   newly discovered pools (whale decodes) can be added without tearing down
 *   the stream.
 * - Reconnects with exponential backoff on stream error; re-subscribes the
 *   full tracked set on reconnect so cache recovery is seamless.
 * - LRU eviction caps subscription size; cold pools (oldest `lastAccessedAtMs`)
 *   are dropped once POOL_MAX_ENTRIES is exceeded.
 */
export class PoolAccountStream {
  private client?: GeyserClientInstance;
  private stream?: ClientDuplexStream;
  private stopped = false;
  private connecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  /** keyed by base mint.toBase58() */
  private readonly entries = new Map<string, PoolAccountEntry>();
  /** derived -> pubkey -> mint key reverse map for account update routing */
  private readonly reverseIndex = new Map<string, string>();

  constructor(private readonly cfg: EndpointConfig) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    await this.connectAndSubscribe();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.cleanupStream();
  }

  /**
   * Register a pool for streaming. Derives the pool PDA + base/quote ATAs
   * and pushes them onto the subscription set. Idempotent; repeat calls for
   * the same mint just refresh `lastAccessedAtMs` and re-emit the filter.
   *
   * @param mint base token mint
   * @param baseTokenProgram TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID for the
   *   base side. Caller must resolve this (pumpStateCache already has it).
   * @param poolPubkey canonical pump-swap pool PDA for this mint
   */
  registerPool(
    mint: PublicKey,
    baseTokenProgram: PublicKey,
    poolPubkey: PublicKey,
  ): void {
    const key = mint.toBase58();
    const existing = this.entries.get(key);
    if (existing != null) {
      existing.lastAccessedAtMs = Date.now();
      return;
    }

    const poolBaseAta = getAssociatedTokenAddressSync(
      mint,
      poolPubkey,
      true,
      baseTokenProgram,
    );
    const poolQuoteAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      poolPubkey,
      true,
      TOKEN_PROGRAM_ID,
    );

    const now = Date.now();
    const entry: PoolAccountEntry = {
      poolPubkey,
      poolBaseAta,
      poolQuoteAta,
      baseMint: mint,
      baseTokenProgram,
      poolAccountInfo: null,
      poolBaseAccountInfo: null,
      poolQuoteAccountInfo: null,
      lastUpdateAtMs: 0,
      lastAccessedAtMs: now,
    };
    this.entries.set(key, entry);
    this.reverseIndex.set(poolPubkey.toBase58(), key);
    this.reverseIndex.set(poolBaseAta.toBase58(), key);
    this.reverseIndex.set(poolQuoteAta.toBase58(), key);

    this.evictIfNeeded();
    this.pushSubscribeFilter();
  }

  /**
   * Return cached pool + ATA account infos if ALL three are present and the
   * most recent update landed within `POOL_CACHE_TTL_MS`. Updates
   * `lastAccessedAtMs` on hit so LRU eviction keeps hot pools subscribed.
   */
  getCachedState(mint: PublicKey): PoolStreamCacheHit | null {
    const key = mint.toBase58();
    const entry = this.entries.get(key);
    if (entry == null) {
      return null;
    }
    if (
      entry.poolAccountInfo == null ||
      entry.poolBaseAccountInfo == null ||
      entry.poolQuoteAccountInfo == null
    ) {
      return null;
    }
    const age = Date.now() - entry.lastUpdateAtMs;
    if (age > POOL_CACHE_TTL_MS) {
      return null;
    }
    entry.lastAccessedAtMs = Date.now();
    return {
      poolAccountInfo: entry.poolAccountInfo,
      poolBaseAccountInfo: entry.poolBaseAccountInfo,
      poolQuoteAccountInfo: entry.poolQuoteAccountInfo,
      freshnessMs: age,
    };
  }

  /** Number of pools currently subscribed — observability + metrics. */
  get trackedPoolCount(): number {
    return this.entries.size;
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= POOL_MAX_ENTRIES) {
      return;
    }
    // Drop the oldest lastAccessedAtMs entries until within cap.
    const sorted = [...this.entries.entries()].sort(
      (a, b) => a[1].lastAccessedAtMs - b[1].lastAccessedAtMs,
    );
    const toDrop = sorted.slice(0, this.entries.size - POOL_MAX_ENTRIES);
    for (const [key, entry] of toDrop) {
      this.entries.delete(key);
      this.reverseIndex.delete(entry.poolPubkey.toBase58());
      this.reverseIndex.delete(entry.poolBaseAta.toBase58());
      this.reverseIndex.delete(entry.poolQuoteAta.toBase58());
    }
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

  private cleanupStream(): void {
    const s = this.stream as unknown as
      | { removeAllListeners?: () => void; destroy?: () => void }
      | undefined;
    try {
      s?.removeAllListeners?.();
    } catch {
      /* ignore */
    }
    try {
      s?.destroy?.();
    } catch {
      /* ignore */
    }
    this.stream = undefined;
    this.client = undefined;
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer != null || this.connecting) {
      return;
    }
    const nextAttempt = this.reconnectAttempts + 1;
    this.reconnectAttempts = nextAttempt;
    const delay = this.reconnectDelayMs(nextAttempt);
    if (this.cfg.debug) {
      console.warn(
        `[pool-stream] reconnect scheduled in ${delay}ms (attempt ${nextAttempt}) reason=${reason}`,
      );
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnectOnce();
    }, delay);
  }

  private async reconnectOnce(): Promise<void> {
    if (this.stopped || this.connecting) {
      return;
    }
    try {
      await this.connectAndSubscribe();
      this.reconnectAttempts = 0;
      if (this.cfg.debug) {
        console.log("[pool-stream] reconnected");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[pool-stream] reconnect failed: ${msg}`);
      this.scheduleReconnect("connect_failed");
    }
  }

  private async connectAndSubscribe(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try {
      this.cleanupStream();

      const yb = await import("@triton-one/yellowstone-grpc");
      const GeyserClient = resolveGeyserClientCtor(yb);
      const { CommitmentLevel } = yb;
      const streamCommitment =
        this.cfg.commitment === "processed"
          ? CommitmentLevel.PROCESSED
          : this.cfg.commitment === "finalized"
            ? CommitmentLevel.FINALIZED
            : CommitmentLevel.CONFIRMED;

      const client = new GeyserClient(
        this.cfg.endpoint,
        this.cfg.apiKey,
        undefined,
      );
      await client.connect();
      const stream = await client.subscribe();

      this.client = client;
      this.stream = stream;
      this.attachStreamHandlers(stream);

      // Send initial filter (may be empty if no pools registered yet).
      this.pushSubscribeFilter();

      if (this.cfg.debug) {
        console.log(
          `[pool-stream] subscribed ${this.cfg.commitment.toUpperCase()} pools=${this.entries.size}`,
        );
      }
    } finally {
      this.connecting = false;
    }
  }

  /** Rebuild + send the SubscribeRequest from the current entries set. */
  private pushSubscribeFilter(): void {
    if (this.stream == null) {
      // Will be applied on next connect.
      return;
    }
    const allPubkeys: string[] = [];
    for (const entry of this.entries.values()) {
      allPubkeys.push(entry.poolPubkey.toBase58());
      allPubkeys.push(entry.poolBaseAta.toBase58());
      allPubkeys.push(entry.poolQuoteAta.toBase58());
    }

    const request = {
      accounts: {
        pool_state:
          allPubkeys.length > 0
            ? {
                account: allPubkeys,
                filters: [],
                owner: [],
                nonemptyTxnSignature: [],
              }
            : undefined,
      } as Record<string, unknown>,
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment:
        this.cfg.commitment === "processed"
          ? 0
          : this.cfg.commitment === "finalized"
            ? 2
            : 1,
      accountsDataSlice: [],
    };

    // Strip undefined to avoid the proto library rejecting the empty key.
    if (allPubkeys.length === 0) {
      delete (request.accounts as Record<string, unknown>).pool_state;
    }

    try {
      (this.stream as unknown as { write: (req: unknown) => void }).write(
        request,
      );
    } catch (e) {
      if (this.cfg.debug) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[pool-stream] subscribe write failed: ${msg}`);
      }
    }
  }

  private attachStreamHandlers(stream: ClientDuplexStream): void {
    stream.on("data", (update: unknown) => {
      if (this.stopped) return;
      try {
        this.handleUpdate(update);
      } catch (e) {
        if (this.cfg.debug) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[pool-stream] update handler error: ${msg}`);
        }
      }
    });

    stream.on("error", (err: Error) => {
      if (this.stopped) return;
      if (this.cfg.debug) {
        console.error("[pool-stream] stream error:", err.message);
      }
      this.cleanupStream();
      this.scheduleReconnect("stream_error");
    });

    stream.on("end", () => {
      if (this.stopped) return;
      if (this.cfg.debug) {
        console.warn("[pool-stream] stream ended");
      }
      this.cleanupStream();
      this.scheduleReconnect("stream_end");
    });
  }

  private handleUpdate(update: unknown): void {
    const u = update as {
      account?: {
        account?: {
          pubkey?: string | Uint8Array;
          owner?: string | Uint8Array;
          data?: Uint8Array;
          executable?: boolean;
          lamports?: string | number;
          rentEpoch?: string | number;
        };
      };
    };

    const acc = u.account?.account;
    if (acc == null || acc.pubkey == null || acc.data == null) {
      return;
    }

    const pubkey58 =
      typeof acc.pubkey === "string"
        ? acc.pubkey
        : new PublicKey(acc.pubkey).toBase58();

    const mintKey = this.reverseIndex.get(pubkey58);
    if (mintKey == null) {
      return;
    }
    const entry = this.entries.get(mintKey);
    if (entry == null) {
      return;
    }

    const accountInfo = toAccountInfo(
      acc.owner ?? new Uint8Array(32),
      acc.data,
      acc.executable === true,
      acc.lamports ?? 0,
      acc.rentEpoch ?? 0,
    );

    if (pubkey58 === entry.poolPubkey.toBase58()) {
      entry.poolAccountInfo = accountInfo;
    } else if (pubkey58 === entry.poolBaseAta.toBase58()) {
      entry.poolBaseAccountInfo = accountInfo;
    } else if (pubkey58 === entry.poolQuoteAta.toBase58()) {
      entry.poolQuoteAccountInfo = accountInfo;
    }
    entry.lastUpdateAtMs = Date.now();
  }
}
