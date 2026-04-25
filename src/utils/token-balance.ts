import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

/**
 * Total raw token amount (string integer) the owner holds for `mint`, across
 * SPL + Token-2022 ATAs. Returns null if no accounts or sum is zero.
 *
 * Uses `{ programId }` filter (tolerant of Helius beta's stricter
 * `{ mint }` handling that rejects Token-2022 mints) and sums across both
 * token programs.
 */
export async function getTokenBalanceRawForMint(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<string | null> {
  const [splRes, t22Res] = await Promise.all([
    connection
      .getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })
      .catch(() => ({ value: [] as unknown[] })),
    connection
      .getParsedTokenAccountsByOwner(owner, {
        programId: TOKEN_2022_PROGRAM_ID,
      })
      .catch(() => ({ value: [] as unknown[] })),
  ]);

  let total = 0n;
  const mintStr = mint.toBase58();
  const accumulate = (rows: unknown[]): void => {
    for (const row of rows) {
      const account = (row as { account?: { data?: unknown } }).account;
      const parsed = account?.data as
        | {
            parsed?: {
              type?: string;
              info?: {
                mint?: string;
                tokenAmount?: { amount?: string };
              };
            };
          }
        | undefined;
      const info =
        parsed?.parsed?.type === "account" ? parsed.parsed.info : undefined;
      if (info?.mint !== mintStr) {
        continue;
      }
      const amt = info.tokenAmount?.amount;
      if (typeof amt === "string" && /^\d+$/.test(amt)) {
        total += BigInt(amt);
      }
    }
  };
  accumulate(splRes.value as unknown[]);
  accumulate(t22Res.value as unknown[]);

  if (total <= 0n) {
    return null;
  }
  return total.toString();
}
