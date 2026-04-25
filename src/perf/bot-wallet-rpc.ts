import bs58 from "bs58";
import { Connection, Keypair } from "@solana/web3.js";
import type { AppConfig } from "../types/index.js";

export interface BotWalletSnapshot {
  publicKey: string;
  balanceSol: number;
}

/** Read bot wallet SOL balance via HELIUS_RPC_URL without exposing private key. */
export async function logBotWalletFromRpc(
  connection: Connection,
  config: AppConfig,
): Promise<BotWalletSnapshot | null> {
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(config.botPrivateKey));
    const pub = kp.publicKey.toBase58();
    const lamports = await connection.getBalance(kp.publicKey, "confirmed");
    const sol = lamports / 1e9;

    console.log(`[wallet] BOT_PUBLIC_KEY=${pub}`);
    console.log(`[wallet] SOL balance (RPC confirmed): ${sol.toFixed(6)} SOL`);

    if (sol < 0.03) {
      console.warn(
        "[wallet] SOL balance is very low - BUY + priority fee may fail more often",
      );
    } else if (sol < 0.1) {
      console.warn(
        "[wallet] SOL balance is low - consider topping up for more stable execution",
      );
    }

    return { publicKey: pub, balanceSol: sol };
  } catch (e) {
    console.warn(
      "[wallet] failed to fetch balance via RPC:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
