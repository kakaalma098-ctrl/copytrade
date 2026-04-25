import { Connection } from "@solana/web3.js";
import type { AppConfig } from "../types/index.js";
import type { JupiterClient } from "../execution/jupiter.js";
import { httpClient } from "../utils/http-client.js";
import { senderHttpClient } from "../utils/sender-http-client.js";
import { getSharedPumpStateCache } from "./pump-state-cache.js";
import { altCache } from "./alt-cache.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * R16: Probe endpoint latency and warm TLS/TCP connections.
 * Any HTTP response (including 4xx/5xx) means TCP+TLS handshake completed,
 * which is the actual goal — we want the keep-alive socket warm for the
 * first real sendTransaction. Network-level failure (ECONNREFUSED/timeout)
 * is the only true "fail" here.
 */
async function probeEndpoint(
  label: string,
  url: string,
): Promise<{ label: string; rttMs: number; ok: boolean }> {
  const start = Date.now();
  try {
    await senderHttpClient.post(
      url,
      { jsonrpc: "2.0", id: 0, method: "getHealth", params: [] },
      { timeout: 3000, validateStatus: () => true },
    );
    return { label, rttMs: Date.now() - start, ok: true };
  } catch {
    return { label, rttMs: Date.now() - start, ok: false };
  }
}

async function warmupSenders(config: AppConfig): Promise<void> {
  const probes: Array<{ label: string; url: string }> = [];
  const mode = config.execution.senderMode;

  if (mode === "helius") {
    const heliusUrl =
      config.execution.senderEndpoint?.trim() ||
      config.helius.tipEndpoints[0] ||
      "https://sender.helius-rpc.com/fast";
    probes.push({ label: "helius-sender", url: heliusUrl });
  }
  if (mode === "jito") {
    const jitoUrl =
      config.execution.jitoSenderUrl?.trim() ||
      "https://mainnet.block-engine.jito.wtf/api/v1/transactions";
    probes.push({ label: "jito-sender", url: jitoUrl });
  }

  // Always probe RPC for R16 baseline (used by R14 multi-blast backup).
  probes.push({ label: "rpc", url: config.helius.rpcUrl });

  const results = await Promise.all(
    probes.map(({ label, url }) => probeEndpoint(label, url)),
  );

  const summary = results
    .map((r) => `${r.label}=${r.rttMs}ms${r.ok ? "" : "(fail)"}`)
    .join(" ");
  console.log(`[warmup] endpoint latency: ${summary}`);

  const highLatency = results.filter((r) => r.ok && r.rttMs > 100);
  if (highLatency.length > 0) {
    console.warn(
      `[warmup] WARNING: high RTT detected — consider co-locating VPS with endpoints (SGP for Helius SGP).`,
    );
  }
}

/** TLS/TCP + RPC path warm — dipanggil sekali sebelum listener. */
export async function warmupSolanaPipeline(
  connection: Connection,
  jupiter: JupiterClient | undefined,
  config: AppConfig,
): Promise<void> {
  try {
    await Promise.all([
      // Phase 3: warm with the SAME commitment the hot path uses so the RPC
      // connection pool entry we're warming is the same one swap builders
      // will reuse. "confirmed" here meant a colder pool slot than the
      // "processed" path used by blockhash-cache + confirm fallbacks.
      connection.getLatestBlockhash(config.helius.rpcCommitment),
      connection.getVersion(),
    ]);
  } catch (e) {
    console.warn(
      "[warmup] RPC warm failed (non-fatal):",
      e instanceof Error ? e.message : e,
    );
  }

  const jupiterWarm =
    config.perf.jupiterWarm && jupiter
      ? jupiter
          .getQuote(
            SOL_MINT,
            USDC_MINT,
            String(Math.floor(0.001 * 1_000_000_000)),
          )
          .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
              console.warn(
                "[warmup] Jupiter: DNS tidak bisa resolve host (ENOTFOUND). Perbaiki DNS VPS atau set JUPITER_WARMUP=false sementara. Detail:",
                msg,
              );
            } else {
              console.warn("[warmup] Jupiter warm failed (non-fatal):", msg);
            }
          })
      : Promise.resolve();

  const senderWarm = warmupSenders(config).catch((e) => {
    console.warn(
      "[warmup] sender warm failed (non-fatal):",
      e instanceof Error ? e.message : e,
    );
  });

  // Prefetch pump-fun / pump-swap static state so the first whale swap on
  // either path skips the 2x global+feeConfig RPCs.
  const pumpStateCache = getSharedPumpStateCache();
  const pumpWarm = pumpStateCache
    ? pumpStateCache.warmup().catch((e) => {
        console.warn(
          "[warmup] pump state warm failed (non-fatal):",
          e instanceof Error ? e.message : e,
        );
      })
    : Promise.resolve();

  // N8: pre-resolve user-configured ALTs so the first swap avoids a cold
  // getAddressLookupTable round-trip (~20-40ms per ALT). Populate
  // JUPITER_PREWARM_ALTS with Jupiter's most-used routing ALTs.
  const altWarm =
    config.perf.prewarmAltAddresses.length > 0
      ? altCache
          .resolve(connection, config.perf.prewarmAltAddresses)
          .then((resolved) => {
            console.log(
              `[warmup] prewarmed ${resolved.length}/${config.perf.prewarmAltAddresses.length} ALT(s)`,
            );
          })
          .catch((e) => {
            console.warn(
              "[warmup] ALT prewarm failed (non-fatal):",
              e instanceof Error ? e.message : e,
            );
          })
      : Promise.resolve();

  await Promise.all([jupiterWarm, senderWarm, pumpWarm, altWarm]);
}
