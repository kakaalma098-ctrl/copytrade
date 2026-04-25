import type { Connection } from "@solana/web3.js";
import type { AppConfig, RawWhaleTransaction } from "../types/index.js";
import { HeliusWsClient } from "./helius-ws.js";
import { PreprocessedLaserstreamClient } from "./laserstream-preprocessed.js";
import { decodeWhaleFromRpc, decodeWhaleSwap } from "./decode-whale-tx.js";

type ListenerImpl = HeliusWsClient | PreprocessedLaserstreamClient;

/** Direct callback — replaces EventEmitter for hot-path whale→processor flow. */
export type OnWhaleTx = (tx: RawWhaleTransaction) => void;

export class WhaleListenerService {
  private readonly impl: ListenerImpl;

  constructor(config: AppConfig, connection: Connection, onWhaleTx: OnWhaleTx) {
    if (config.helius.feedMode === "grpc") {
      // Preprocessed laserstream: instruction-decode pipeline. The decoder
      // handles its own onDrop logging + onWhaleTx dispatch internally so
      // we just forward callbacks.
      this.impl = new PreprocessedLaserstreamClient(
        config,
        connection,
        onWhaleTx,
      );
      return;
    }

    if (config.helius.feedMode === "wss") {
      const feedTag = "[feed:wss]";
      const decodeOptions = {
        allowMultiLegNetFollow: config.trading.allowMultiLegNetFollow,
        maxOtherSplLegRatio: config.trading.maxOtherSplLegRatio,
      };
      this.impl = new HeliusWsClient(
        config.helius.wssUrl,
        config.whaleWallets,
        config.helius.wssCommitment,
        (event) => {
          const { wallet, signature, logs, ingestedAtMs, frame } = event;
          const onDrop = config.debug.whalePipeline
            ? (reason: string) => {
                console.warn(
                  `[whale-debug] ${feedTag} decode drop ${reason} sig=${signature.slice(0, 16)}...`,
                );
              }
            : undefined;

          const decodedDirect = frame
            ? decodeWhaleSwap(frame, onDrop, decodeOptions)
            : null;
          if (decodedDirect) {
            if (config.debug.whalePipeline) {
              console.log(
                `[whale-debug] ${feedTag} whale:tx ${decodedDirect.type} sig=${signature.slice(0, 12)}...`,
              );
            }
            onWhaleTx(decodedDirect);
            return;
          }

          if (frame) {
            return;
          }

          void decodeWhaleFromRpc(
            connection,
            wallet,
            signature,
            logs,
            onDrop,
            {
              feedSource: "wss",
              ingestedAtMs,
            },
            decodeOptions,
          )
            .then((decoded) => {
              if (!decoded) {
                return;
              }
              if (config.debug.whalePipeline) {
                console.log(
                  `[whale-debug] ${feedTag} whale:tx ${decoded.type} sig=${signature.slice(0, 12)}...`,
                );
              }
              onWhaleTx(decoded);
            })
            .catch((e) => {
              if (config.debug.whalePipeline) {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn(
                  `[whale-debug] ${feedTag} decode error sig=${signature.slice(0, 16)}... err=${msg}`,
                );
              }
            });
        },
      );
      return;
    }

    throw new Error(
      `Unsupported whale feed mode: ${String((config.helius as { feedMode?: unknown }).feedMode)}`,
    );
  }

  async start(): Promise<void> {
    await this.impl.start();
  }

  async stop(): Promise<void> {
    await this.impl.stop();
  }

  /**
   * Swap the whale wallet filter list without re-creating the service.
   * Only supported for the Laserstream gRPC feed — WSS reload is a no-op
   * placeholder (it would require re-creating subscriptions per wallet).
   */
  async reloadWhales(whales: string[]): Promise<number> {
    if (this.impl instanceof PreprocessedLaserstreamClient) {
      return this.impl.reloadWhales(whales);
    }
    console.warn("[listener] reloadWhales not supported for WSS feed");
    return whales.length;
  }
}
