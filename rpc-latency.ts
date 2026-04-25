import { performance } from "node:perf_hooks";

const RPC_URL = process.env.RPC_URL?.trim() ?? "";

const RUNS = 5;
const TIMEOUT_MS = 10000;

const PARAMS = [
  "So11111111111111111111111111111111111111112",
  { encoding: "base64" },
  { commitment: "processed" },
];

async function rpcCall(): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const start = performance.now();

  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: PARAMS,
      }),
      signal: controller.signal,
    });

    await res.text();
    const end = performance.now();

    return end - start;
  } catch (err: any) {
    const end = performance.now();
    console.log("❌ Error:", err.message);
    return end - start;
  } finally {
    clearTimeout(timeout);
  }
}

(async () => {
  if (!RPC_URL) {
    console.error("Missing RPC_URL environment variable.");
    process.exitCode = 1;
    return;
  }

  console.log("🚀 RPC Latency Check");
  console.log("URL:", RPC_URL);
  console.log("");

  const results: number[] = [];

  for (let i = 0; i < RUNS; i++) {
    const latency = await rpcCall();
    results.push(latency);

    console.log(`[${i + 1}] ${latency.toFixed(2)} ms`);
  }

  const avg = results.reduce((a, b) => a + b, 0) / results.length;

  const min = Math.min(...results);
  const max = Math.max(...results);

  console.log("\n📊 RESULT");
  console.log("AVG :", avg.toFixed(2), "ms");
  console.log("MIN :", min.toFixed(2), "ms");
  console.log("MAX :", max.toFixed(2), "ms");
})();
