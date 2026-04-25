import {
  AddressLookupTableAccount,
  type Connection,
  PublicKey,
} from "@solana/web3.js";

const TTL_MS = 120_000;
const MAX_ENTRIES = 64;

type Entry = { exp: number; account: AddressLookupTableAccount };

/**
 * Shared ALT cache — singleton used by both JupiterClient (metis_instructions)
 * and helius-sender-tip (tip injection). Prevents duplicate RPC fetches for
 * the same lookup tables across the execution pipeline.
 */
class AltCache {
  private readonly store = new Map<string, Entry>();
  private readonly inflight = new Map<
    string,
    Promise<AddressLookupTableAccount>
  >();

  get(key: string): AddressLookupTableAccount | null {
    const hit = this.store.get(key);
    if (hit == null || Date.now() > hit.exp) {
      if (hit != null) {
        this.store.delete(key);
      }
      return null;
    }
    return hit.account;
  }

  set(key: string, account: AddressLookupTableAccount): void {
    if (this.store.size >= MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest != null) {
        this.store.delete(oldest);
      }
    }
    this.store.set(key, { exp: Date.now() + TTL_MS, account });
  }

  /**
   * Fetch a single ALT, coalescing concurrent callers onto one RPC round-trip.
   * Without this, two parallel swap builds on the same cold ALT would each
   * fire their own getAddressLookupTable, doubling RPC load and adding tail
   * latency under burst conditions.
   */
  private fetchOne(
    connection: Connection,
    addr: string,
  ): Promise<AddressLookupTableAccount> {
    const pending = this.inflight.get(addr);
    if (pending != null) {
      return pending;
    }
    const p = (async () => {
      const key = new PublicKey(addr);
      const r = await connection.getAddressLookupTable(key);
      if (r.value == null) {
        throw new Error(`ALT not found: ${addr}`);
      }
      this.set(addr, r.value);
      return r.value;
    })().finally(() => {
      this.inflight.delete(addr);
    });
    this.inflight.set(addr, p);
    return p;
  }

  /**
   * Resolve an array of ALT addresses, returning cached accounts where possible
   * and fetching missing ones from the RPC in parallel.
   */
  async resolve(
    connection: Connection,
    addresses: string[],
  ): Promise<AddressLookupTableAccount[]> {
    if (addresses.length === 0) {
      return [];
    }

    const results: AddressLookupTableAccount[] = new Array(addresses.length);
    const missing: Array<{ idx: number; addr: string }> = [];

    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i]!;
      const cached = this.get(addr);
      if (cached != null) {
        results[i] = cached;
      } else {
        missing.push({ idx: i, addr });
      }
    }

    if (missing.length > 0) {
      const fetched = await Promise.all(
        missing.map(async ({ idx, addr }) => ({
          idx,
          account: await this.fetchOne(connection, addr),
        })),
      );
      for (const { idx, account } of fetched) {
        results[idx] = account;
      }
    }

    return results;
  }
}

/** Singleton — import and use directly. */
export const altCache = new AltCache();
