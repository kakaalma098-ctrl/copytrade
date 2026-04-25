import { Connection } from "@solana/web3.js";

type RpcResult = {
  url: string;
  success: boolean;
  latency: number;
  blockhash?: string;
  lastValidBlockHeight?: number;
  error?: any;
};

async function checkRpc(url: string): Promise<RpcResult> {
  const start = Date.now();

  try {
    const connection = new Connection(url, {
      commitment: "processed",
    });

    const res = await connection.getLatestBlockhash();

    const latency = Date.now() - start;

    return {
      url,
      success: true,
      latency,
      blockhash: res.blockhash,
      lastValidBlockHeight: res.lastValidBlockHeight,
    };
  } catch (err: any) {
    return {
      url,
      success: false,
      latency: Date.now() - start,
      error: err.message || err,
    };
  }
}

function getRpcListFromEnv(): string[] {
  const value = process.env.RPC_URLS;
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const RPC_LIST = getRpcListFromEnv();

async function main() {
  if (RPC_LIST.length === 0) {
    console.error("No RPC URLs configured.");
    console.error("Set env RPC_URLS as comma-separated URLs before running.");
    process.exitCode = 1;
    return;
  }

  console.log("🚀 Checking RPC via getLatestBlockhash...\n");

  const results = await Promise.all(RPC_LIST.map(checkRpc));

  for (const r of results) {
    console.log("=================================");
    console.log("URL     :", r.url);
    console.log("STATUS  :", r.success ? "✅ OK" : "❌ ERROR");
    console.log("LATENCY :", r.latency + " ms");

    if (r.blockhash) {
      console.log("BLOCKHASH :", r.blockhash.slice(0, 20) + "...");
      console.log("VALID BH  :", r.lastValidBlockHeight);
    }

    if (r.error) {
      console.log("ERROR     :", r.error);
    }
  }

  console.log("\n🏁 Done");
}

main();
