import WebSocket from "ws";
import type { WhaleMetaFrame, WhaleTokenRow } from "./decode-whale-tx.js";

type SubAck = {
  jsonrpc?: string;
  id?: number;
  result?: number;
  error?: { message?: string; code?: number };
};

type SubscribeMethod = "transaction" | "logs";

type PendingSub = {
  wallet: string;
  method: SubscribeMethod;
};

type ActiveSub = {
  wallet: string;
  method: SubscribeMethod;
};

type WsMessage = {
  method?: string;
  params?: {
    subscription?: number;
    result?: unknown;
  };
};

export type HeliusWsEvent = {
  wallet: string;
  signature: string;
  logs: string[];
  ingestedAtMs: number;
  frame?: WhaleMetaFrame;
};

const pickResult = (raw: unknown): Record<string, unknown> | null => {
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const val = rec.value;
  if (val != null && typeof val === "object") {
    return val as Record<string, unknown>;
  }
  return rec;
};

const asString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const asNumberArray = (v: unknown): number[] => {
  if (!Array.isArray(v)) {
    return [];
  }
  const out: number[] = [];
  for (const item of v) {
    const n = typeof item === "number" ? item : Number(item);
    if (Number.isFinite(n)) {
      out.push(n);
    }
  }
  return out;
};

const asLogArray = (v: unknown): string[] => {
  if (!Array.isArray(v)) {
    return [];
  }
  return v.filter((x): x is string => typeof x === "string");
};

const asTokenRows = (v: unknown): WhaleTokenRow[] => {
  if (!Array.isArray(v)) {
    return [];
  }
  const rows: WhaleTokenRow[] = [];
  for (const raw of v) {
    if (raw == null || typeof raw !== "object") {
      continue;
    }
    const r = raw as Record<string, unknown>;
    const mint = asString(r.mint);
    if (!mint) {
      continue;
    }
    const owner = asString(r.owner) ?? "";
    const ui = r.uiTokenAmount as Record<string, unknown> | undefined;
    const amount = asString(ui?.amount) ?? "0";
    const decRaw = ui?.decimals;
    const decimals =
      typeof decRaw === "number" && Number.isFinite(decRaw)
        ? decRaw
        : Number(decRaw ?? 0) || 0;

    rows.push({ mint, owner, amount, decimals });
  }
  return rows;
};

const asAccountKeys = (v: unknown): string[] => {
  if (!Array.isArray(v)) {
    return [];
  }
  const keys: string[] = [];
  for (const raw of v) {
    if (typeof raw === "string") {
      keys.push(raw);
      continue;
    }
    if (raw != null && typeof raw === "object") {
      const rec = raw as Record<string, unknown>;
      const pubkey = asString(rec.pubkey);
      if (pubkey) {
        keys.push(pubkey);
      }
    }
  }
  return keys;
};

export class HeliusWsClient {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private requestId = 1;
  private stopped = false;
  private readonly pendingSubByReq = new Map<number, PendingSub>();
  private readonly subById = new Map<number, ActiveSub>();

  constructor(
    private readonly url: string,
    private readonly wallets: string[],
    private readonly commitment: "processed" | "confirmed" | "finalized",
    private readonly onEvent: (event: HeliusWsEvent) => void,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
    this.ws?.close();
    this.pendingSubByReq.clear();
    this.subById.clear();
    await Promise.resolve();
  }

  private connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      this.pendingSubByReq.clear();
      this.subById.clear();
      for (const wallet of this.wallets) {
        this.subscribeWalletTx(wallet);
      }
      this.startPing();
    });

    this.ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as SubAck & WsMessage;

        if (parsed.id != null && parsed.error) {
          const pending = this.pendingSubByReq.get(parsed.id);
          if (pending?.method === "transaction") {
            const msg =
              parsed.error.message ?? `rpc error ${parsed.error.code ?? "?"}`;
            console.warn(
              `[wss] transactionSubscribe unavailable for ${pending.wallet.slice(0, 8)}..., fallback to logsSubscribe (${msg})`,
            );
            this.pendingSubByReq.delete(parsed.id);
            this.subscribeWalletLogs(pending.wallet);
          }
          return;
        }

        if (parsed.id != null && typeof parsed.result === "number") {
          const pending = this.pendingSubByReq.get(parsed.id);
          if (pending) {
            this.pendingSubByReq.delete(parsed.id);
            this.subById.set(parsed.result, {
              wallet: pending.wallet,
              method: pending.method,
            });
          }
          return;
        }

        const subId = parsed.params?.subscription;
        if (subId == null) {
          return;
        }
        const sub = this.subById.get(subId);
        if (!sub) {
          return;
        }

        const ingestedAtMs = Date.now();

        if (
          parsed.method === "transactionNotification" &&
          sub.method === "transaction"
        ) {
          const frame = this.buildFrameFromTransactionNotification(
            sub.wallet,
            parsed.params?.result,
            ingestedAtMs,
          );
          if (frame) {
            this.onEvent({
              wallet: frame.whale,
              signature: frame.signature,
              logs: frame.logs,
              ingestedAtMs,
              frame,
            });
            return;
          }

          const fallback = this.buildFallbackEventFromTransactionNotification(
            sub.wallet,
            parsed.params?.result,
            ingestedAtMs,
          );
          if (fallback) {
            this.onEvent(fallback);
          }
          return;
        }

        if (parsed.method === "logsNotification" && sub.method === "logs") {
          const val = pickResult(parsed.params?.result);
          const signature = asString(val?.signature);
          const logs = asLogArray(val?.logs);
          if (!signature || logs.length === 0) {
            return;
          }
          this.onEvent({
            wallet: sub.wallet,
            signature,
            logs,
            ingestedAtMs,
          });
        }
      } catch {
        // Ignore malformed frames from upstream.
      }
    });

    this.ws.on("close", () => this.scheduleReconnect());
    this.ws.on("error", () => this.scheduleReconnect());
  }

  private startPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30_000);
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
    this.reconnectTimer = setTimeout(() => this.connect(), 2000);
  }

  private subscribeWalletTx(wallet: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const id = this.requestId++;
    this.pendingSubByReq.set(id, { wallet, method: "transaction" });

    const payload = {
      jsonrpc: "2.0",
      id,
      method: "transactionSubscribe",
      params: [
        {
          vote: false,
          failed: false,
          accountInclude: [wallet],
        },
        {
          commitment: this.commitment,
          encoding: "jsonParsed",
          transactionDetails: "full",
          showRewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
    };

    this.ws.send(JSON.stringify(payload));
  }

  private subscribeWalletLogs(wallet: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const id = this.requestId++;
    this.pendingSubByReq.set(id, { wallet, method: "logs" });

    const payload = {
      jsonrpc: "2.0",
      id,
      method: "logsSubscribe",
      params: [{ mentions: [wallet] }, { commitment: this.commitment }],
    };
    this.ws.send(JSON.stringify(payload));
  }

  private buildFrameFromTransactionNotification(
    wallet: string,
    rawResult: unknown,
    ingestedAtMs: number,
  ): WhaleMetaFrame | null {
    const result = pickResult(rawResult);
    if (!result) {
      return null;
    }

    const txWrap = result.transaction as Record<string, unknown> | undefined;
    const tx = txWrap?.transaction as Record<string, unknown> | undefined;
    const msg = tx?.message as Record<string, unknown> | undefined;
    const meta = txWrap?.meta as Record<string, unknown> | undefined;

    if (!txWrap || !tx || !msg || !meta || meta.err != null) {
      return null;
    }

    const signature =
      asString(result.signature) ??
      (Array.isArray(tx.signatures)
        ? asString((tx.signatures as unknown[])[0])
        : null);

    if (!signature) {
      return null;
    }

    const logs = asLogArray(meta.logMessages);
    const accountKeys = asAccountKeys(msg.accountKeys);
    if (logs.length === 0 || accountKeys.length === 0) {
      return null;
    }

    return {
      whale: wallet,
      signature,
      logs,
      feedSource: "wss",
      ingestedAtMs,
      accountKeys,
      preBalances: asNumberArray(meta.preBalances),
      postBalances: asNumberArray(meta.postBalances),
      preTokenBalances: asTokenRows(meta.preTokenBalances),
      postTokenBalances: asTokenRows(meta.postTokenBalances),
    };
  }

  private buildFallbackEventFromTransactionNotification(
    wallet: string,
    rawResult: unknown,
    ingestedAtMs: number,
  ): HeliusWsEvent | null {
    const result = pickResult(rawResult);
    if (!result) {
      return null;
    }

    const txWrap = result.transaction as Record<string, unknown> | undefined;
    const tx = txWrap?.transaction as Record<string, unknown> | undefined;
    const meta = txWrap?.meta as Record<string, unknown> | undefined;
    if (!meta || meta.err != null) {
      return null;
    }

    const signature =
      asString(result.signature) ??
      (Array.isArray(tx?.signatures)
        ? asString((tx?.signatures as unknown[])[0])
        : null);
    const logs = asLogArray(meta.logMessages);
    if (!signature || logs.length === 0) {
      return null;
    }

    return {
      wallet,
      signature,
      logs,
      ingestedAtMs,
    };
  }
}
