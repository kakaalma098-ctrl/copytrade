import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config/index.js";
import {
  executeViaPumpFunSdk,
  executeViaPumpSwapSdk,
} from "../execution/direct-pump.js";
import type { ExecutionIntent, ProtocolHint } from "../types/index.js";
import { getTokenBalanceRawForMint } from "../utils/token-balance.js";

type SupportedProtocol = "PUMPFUN" | "PUMPSWAP";

type CliOptions = {
  pumpfunMint?: string;
  pumpswapMint?: string;
  buySol: number;
  waitAfterBuyMs: number;
  waitAfterSellMs: number;
  yesReal: boolean;
};

type ProtocolRunResult = {
  protocol: ProtocolHint;
  mint: string;
  status: "ok" | "failed";
  buySignature?: string;
  sellSignature?: string;
  boughtRaw?: string;
  leftoverRawAfterSell?: string;
  error?: string;
};

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BUY_SOL_DEFAULT = 0.001;
const WAIT_AFTER_BUY_DEFAULT_MS = 2000;
const WAIT_AFTER_SELL_DEFAULT_MS = 2000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const nowIso = (): string => new Date().toISOString();

const readArgValue = (name: string): string | undefined => {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) {
    return eq.slice(name.length + 1).trim();
  }
  const idx = argv.findIndex((a) => a === name);
  if (idx >= 0 && idx + 1 < argv.length) {
    return argv[idx + 1]?.trim();
  }
  return undefined;
};

const hasFlag = (name: string): boolean => process.argv.slice(2).includes(name);

const parsePositiveNumber = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid positive number: ${raw}`);
  }
  return n;
};

const mustBePubkey = (raw: string, label: string): string => {
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    throw new Error(`${label} is not a valid Solana mint: ${raw}`);
  }
};

const readOptions = (): CliOptions => {
  const pumpfunMintRaw =
    readArgValue("--pumpfun-mint") ?? process.env.TEST_PUMPFUN_TOKEN_MINT;
  const pumpswapMintRaw =
    readArgValue("--pumpswap-mint") ?? process.env.TEST_PUMPSWAP_TOKEN_MINT;
  const buySol = parsePositiveNumber(
    readArgValue("--buy-sol") ?? process.env.TEST_BUY_SOL,
    BUY_SOL_DEFAULT,
  );
  const waitAfterBuyMs = parsePositiveNumber(
    readArgValue("--wait-after-buy-ms") ?? process.env.TEST_WAIT_AFTER_BUY_MS,
    WAIT_AFTER_BUY_DEFAULT_MS,
  );
  const waitAfterSellMs = parsePositiveNumber(
    readArgValue("--wait-after-sell-ms") ?? process.env.TEST_WAIT_AFTER_SELL_MS,
    WAIT_AFTER_SELL_DEFAULT_MS,
  );
  const yesReal =
    hasFlag("--yes-real") ||
    (process.env.YES_REAL_TRADES ?? "").trim().toLowerCase() === "true";

  return {
    pumpfunMint: pumpfunMintRaw
      ? mustBePubkey(pumpfunMintRaw, "pumpfun mint")
      : undefined,
    pumpswapMint: pumpswapMintRaw
      ? mustBePubkey(pumpswapMintRaw, "pumpswap mint")
      : undefined,
    buySol,
    waitAfterBuyMs,
    waitAfterSellMs,
    yesReal,
  };
};

const executorFor = (protocol: SupportedProtocol) => {
  switch (protocol) {
    case "PUMPFUN":
      return executeViaPumpFunSdk;
    case "PUMPSWAP":
      return executeViaPumpSwapSdk;
  }
};

const readRawBalance = async (
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<bigint> => {
  const raw = await getTokenBalanceRawForMint(connection, owner, mint);
  return raw ? BigInt(raw) : 0n;
};

const waitForBalanceIncrease = async (
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  baseline: bigint,
  waitMs: number,
): Promise<bigint> => {
  const maxChecks = 10;
  for (let i = 0; i < maxChecks; i++) {
    const current = await readRawBalance(connection, owner, mint);
    if (current > baseline) {
      return current;
    }
    await sleep(waitMs);
  }
  return readRawBalance(connection, owner, mint);
};

const makeIntent = (
  protocol: ProtocolHint,
  side: "BUY" | "SELL",
  mint: string,
  buySol: number,
  whaleWallet: string,
  sellTokenAmountRaw?: string,
): ExecutionIntent => {
  const now = Date.now();
  return {
    token: mint,
    side,
    protocolHint: protocol,
    size: buySol,
    delayMs: 0,
    whaleWallet,
    signalTimestamp: now,
    detectedAtMs: now,
    signalEmittedAtMs: now,
    handlerStartedAtMs: now,
    ...(sellTokenAmountRaw ? { sellTokenAmountRaw } : {}),
  };
};

const runProtocolTest = async (
  connection: Connection,
  taker: Keypair,
  protocol: SupportedProtocol,
  mint: string,
  buySol: number,
  slippageBps: number,
  commitment: "processed" | "confirmed" | "finalized",
  waitAfterBuyMs: number,
  waitAfterSellMs: number,
): Promise<ProtocolRunResult> => {
  const mintPk = new PublicKey(mint);
  const owner = taker.publicKey;
  const whaleWallet = owner.toBase58();
  const execute = executorFor(protocol);

  try {
    const beforeRaw = await readRawBalance(connection, owner, mintPk);
    const buyIntent = makeIntent(protocol, "BUY", mint, buySol, whaleWallet);
    const buyRes = await execute(
      connection,
      taker,
      buyIntent,
      slippageBps,
      commitment,
    );
    console.log(
      `[${nowIso()}] ${protocol} BUY submitted sig=${buyRes.signature}`,
    );

    await sleep(waitAfterBuyMs);
    const afterBuyRaw = await waitForBalanceIncrease(
      connection,
      owner,
      mintPk,
      beforeRaw,
      Math.max(500, Math.floor(waitAfterBuyMs / 2)),
    );
    const boughtRaw = afterBuyRaw - beforeRaw;

    if (boughtRaw <= 0n) {
      throw new Error(
        `BUY confirmed but token delta <= 0 (sig=${buyRes.signature} before=${beforeRaw.toString()} after=${afterBuyRaw.toString()})`,
      );
    }

    const sellIntent = makeIntent(
      protocol,
      "SELL",
      mint,
      buySol,
      whaleWallet,
      boughtRaw.toString(),
    );
    const sellRes = await execute(
      connection,
      taker,
      sellIntent,
      slippageBps,
      commitment,
    );
    console.log(
      `[${nowIso()}] ${protocol} SELL submitted sig=${sellRes.signature}`,
    );

    await sleep(waitAfterSellMs);
    const afterSellRaw = await readRawBalance(connection, owner, mintPk);
    const leftover = afterSellRaw > beforeRaw ? afterSellRaw - beforeRaw : 0n;

    return {
      protocol,
      mint,
      status: "ok",
      buySignature: buyRes.signature,
      sellSignature: sellRes.signature,
      boughtRaw: boughtRaw.toString(),
      leftoverRawAfterSell: leftover.toString(),
    };
  } catch (e) {
    return {
      protocol,
      mint,
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
};

const main = async (): Promise<void> => {
  const opts = readOptions();
  if (!opts.yesReal) {
    throw new Error(
      "Refusing to send real trades. Add --yes-real (or YES_REAL_TRADES=true) to confirm.",
    );
  }

  const tasks: Array<{ protocol: SupportedProtocol; mint: string }> = [];
  if (opts.pumpfunMint) {
    tasks.push({ protocol: "PUMPFUN", mint: opts.pumpfunMint });
  }
  if (opts.pumpswapMint) {
    tasks.push({ protocol: "PUMPSWAP", mint: opts.pumpswapMint });
  }
  if (tasks.length === 0) {
    throw new Error(
      "No token mint provided. Use --pumpfun-mint or --pumpswap-mint (env: TEST_PUMPFUN_TOKEN_MINT / TEST_PUMPSWAP_TOKEN_MINT).",
    );
  }

  const config = loadConfig();
  const connection = new Connection(
    config.helius.rpcUrl,
    config.helius.rpcCommitment,
  );
  const taker = Keypair.fromSecretKey(bs58.decode(config.botPrivateKey));

  console.log(`[${nowIso()}] direct path test start`);
  console.log(`wallet=${taker.publicKey.toBase58()}`);
  console.log(`rpc=${config.helius.rpcUrl}`);
  console.log(`commitment=${config.execution.confirmCommitment}`);
  console.log(`slippageBps=${config.trading.slippageBps}`);
  console.log(`buySol=${opts.buySol}`);
  console.log(`solMint=${SOL_MINT}`);
  console.log(
    `targets=${tasks.map((t) => `${t.protocol}:${t.mint}`).join(", ")}`,
  );

  const results: ProtocolRunResult[] = [];
  for (const t of tasks) {
    console.log(`[${nowIso()}] testing ${t.protocol} BUY->SELL mint=${t.mint}`);
    const result = await runProtocolTest(
      connection,
      taker,
      t.protocol,
      t.mint,
      opts.buySol,
      config.trading.slippageBps,
      config.execution.confirmCommitment,
      opts.waitAfterBuyMs,
      opts.waitAfterSellMs,
    );
    results.push(result);
    if (result.status === "ok") {
      console.log(
        `[${nowIso()}] ${t.protocol} ok buySig=${result.buySignature} sellSig=${result.sellSignature} boughtRaw=${result.boughtRaw} leftoverRaw=${result.leftoverRawAfterSell}`,
      );
    } else {
      console.error(`[${nowIso()}] ${t.protocol} failed: ${result.error}`);
    }
  }

  const failed = results.filter((r) => r.status === "failed");
  console.log(`[${nowIso()}] summary: ${JSON.stringify(results, null, 2)}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error(
    `[${nowIso()}] fatal:`,
    e instanceof Error ? e.message : String(e),
  );
  process.exit(1);
});
