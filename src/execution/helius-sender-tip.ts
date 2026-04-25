import {
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { altCache } from "../perf/alt-cache.js";

/**
 * Daftar pubkey tip Helius Sender (salah satu dipilih **acak** per tx — tidak perlu isi .env).
 * `HELIUS_TIP_ACCOUNTS` hanya jika Anda mau membatasi subset / urutan sendiri.
 * @see https://www.helius.dev/docs/sending-transactions/jupiter-swap-api-via-sender
 */
export const DEFAULT_HELIUS_SENDER_TIP_ACCOUNTS: readonly string[] = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];

const MIN_SENDER_TIP_LAMPORTS = 200_000;

/**
 * Sisipkan satu `SystemProgram.transfer` tip ke tx Jupiter.
 *
 * Caller should resolve ALTs upfront via `altCache.resolve()` and pass them
 * as `preResolvedAlts` to avoid a duplicate RPC resolve here.
 */
export async function appendHeliusSenderTipIx(
  connection: Connection,
  tx: VersionedTransaction,
  payer: PublicKey,
  tipLamports: number,
  tipRecipient: PublicKey,
  preResolvedAlts?: AddressLookupTableAccount[],
): Promise<VersionedTransaction> {
  const lamports = Math.max(MIN_SENDER_TIP_LAMPORTS, Math.floor(tipLamports));

  let alts: AddressLookupTableAccount[];
  if (preResolvedAlts != null && preResolvedAlts.length > 0) {
    alts = preResolvedAlts;
  } else {
    const lookupAddresses = tx.message.addressTableLookups.map((l) =>
      l.accountKey.toBase58(),
    );
    alts = await altCache.resolve(connection, lookupAddresses);
  }

  const decompiled = TransactionMessage.decompile(tx.message, {
    addressLookupTableAccounts: alts,
  });

  decompiled.instructions.push(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: tipRecipient,
      lamports,
    }),
  );

  const compiled = decompiled.compileToV0Message(alts);
  return new VersionedTransaction(compiled);
}

/** Pilih pubkey tip secara acak seragam dari daftar (Helius menerima salah satu). */
export function pickTipRecipient(tipAccounts: readonly string[]): PublicKey {
  if (tipAccounts.length === 0) {
    throw new Error("Tip account list empty (internal bug)");
  }
  const i = Math.floor(Math.random() * tipAccounts.length);
  return new PublicKey(tipAccounts[i]!);
}
