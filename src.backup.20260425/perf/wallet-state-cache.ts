import type { AccountInfo } from "@solana/web3.js";
import { Commitment, Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
} from "@solana/spl-token";
import { getTokenBalanceRawForMint } from "../utils/token-balance.js";

type SolEntry = { exp: number; lamports: number };
type TokenEntry = { exp: number; value: string | null };

/**
 * Hot-path cache: saldo SOL + raw token per mint, TTL pendek + coalesce request paralel.
 * Fetch token memakai **satu** `getMultipleAccountsInfo` (ATA SPL + ATA Token-2022), fallback ke
 * `getParsedTokenAccountsByOwner` jika layout tidak terbaca.
 */
export class WalletStateCache {
  private sol: SolEntry | null = null;
  private readonly token = new Map<string, TokenEntry>();
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly connection: Connection,
    private readonly owner: PublicKey,
    private readonly commitment: Commitment,
    private readonly ttlMs: number,
  ) {}

  async getSolLamports(): Promise<number> {
    const now = Date.now();
    if (this.sol != null && now < this.sol.exp) {
      return this.sol.lamports;
    }
    const lamports = await this.connection.getBalance(
      this.owner,
      this.commitment,
    );
    this.sol = { exp: now + this.ttlMs, lamports };
    return lamports;
  }

  async getTokenRawForMint(mint: PublicKey): Promise<string | null> {
    const key = mint.toBase58();
    const now = Date.now();
    const hit = this.token.get(key);
    if (hit != null && now < hit.exp) {
      return hit.value;
    }
    const pending = this.inflight.get(key);
    if (pending != null) {
      return pending;
    }
    const p = this.fetchAndCacheToken(key, mint).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  /**
   * Phase 4: sync read — returns cached value only. Used by speculative SELL
   * path to start prebuild IMMEDIATELY (no await) when balance is fresh,
   * ensuring inflight entry is registered before the handler calls take().
   *
   * Returns:
   *   - string: cached balance (including "0" which means "confirmed empty")
   *   - null:   cached "no balance"
   *   - undefined: cache miss / stale — caller should fall back to async path
   */
  getTokenRawForMintSync(mint: PublicKey): string | null | undefined {
    const now = Date.now();
    const hit = this.token.get(mint.toBase58());
    if (hit != null && now < hit.exp) {
      return hit.value;
    }
    return undefined;
  }

  /**
   * Invalidate cached SOL balance after a tx that changed it. Next call to
   * `getSolLamports` will re-fetch from RPC. Cheap and synchronous — call after
   * BUY/SELL completes to prevent stale sizing on immediate rebuy.
   */
  invalidateSol(): void {
    this.sol = null;
  }

  /**
   * Invalidate cached token balance for a specific mint. Call after SELL so the
   * next speculative prebuild for the same token does not reuse the pre-SELL
   * balance as its `sellTokenAmountRaw`.
   */
  invalidateToken(mint: PublicKey): void {
    this.token.delete(mint.toBase58());
  }

  private async fetchAndCacheToken(
    key: string,
    mint: PublicKey,
  ): Promise<string | null> {
    const ataSpl = getAssociatedTokenAddressSync(
      mint,
      this.owner,
      false,
      TOKEN_PROGRAM_ID,
    );
    const ata2022 = getAssociatedTokenAddressSync(
      mint,
      this.owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    const infos = await this.connection.getMultipleAccountsInfo(
      [ataSpl, ata2022],
      this.commitment,
    );

    let total = 0n;
    const add = (
      addr: PublicKey,
      info: AccountInfo<Buffer> | null,
      programId: PublicKey,
    ): void => {
      try {
        if (info == null) {
          return;
        }
        const acc = unpackAccount(addr, info, programId);
        if (acc.mint.equals(mint)) {
          total += acc.amount;
        }
      } catch {
        /* uninitialized / wrong program */
      }
    };

    add(ataSpl, infos[0] ?? null, TOKEN_PROGRAM_ID);
    add(ata2022, infos[1] ?? null, TOKEN_2022_PROGRAM_ID);

    let value: string | null = total > 0n ? total.toString() : null;
    if (value == null) {
      value = await getTokenBalanceRawForMint(
        this.connection,
        this.owner,
        mint,
      );
    }

    this.token.set(key, { exp: Date.now() + this.ttlMs, value });
    return value;
  }
}
