import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { AppConfig } from "../types/index.js";
import { getTokenBalanceRawForMint } from "../utils/token-balance.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;

const solToLamports = (sol: number): bigint => {
  if (!Number.isFinite(sol) || sol <= 0) {
    return 0n;
  }
  return BigInt(Math.floor(sol * Number(LAMPORTS_PER_SOL)));
};

const lamportsToSol = (lamports: bigint): number =>
  Number(lamports) / Number(LAMPORTS_PER_SOL);

type WrapConfig = {
  targetSol: number;
  solReserveSol: number;
};

type WrapResult =
  | { ok: true; wrappedLamports: bigint; afterLamports: bigint; sig: string }
  | { ok: false; reason: string };

async function wrapSolToWsolCore(
  connection: Connection,
  keypair: Keypair,
  wrap: WrapConfig,
  logPrefix: string,
): Promise<WrapResult> {
  const owner = keypair.publicKey;
  const targetLamports = solToLamports(wrap.targetSol);
  const reserveLamports = solToLamports(wrap.solReserveSol);
  if (targetLamports <= 0n) {
    return { ok: false, reason: "target is 0" };
  }

  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);

  const currentWsolRaw = await getTokenBalanceRawForMint(
    connection,
    owner,
    NATIVE_MINT,
  );
  const currentWsolLamports = currentWsolRaw ? BigInt(currentWsolRaw) : 0n;
  if (currentWsolLamports >= targetLamports) {
    return {
      ok: false,
      reason: `already funded (${lamportsToSol(currentWsolLamports).toFixed(6)} WSOL >= target ${wrap.targetSol.toFixed(6)})`,
    };
  }

  const solLamports = BigInt(await connection.getBalance(owner, "confirmed"));
  const needed = targetLamports - currentWsolLamports;
  const availableForWrap =
    solLamports > reserveLamports ? solLamports - reserveLamports : 0n;
  const wrapLamports = needed < availableForWrap ? needed : availableForWrap;

  if (wrapLamports <= 0n) {
    return {
      ok: false,
      reason: `insufficient SOL to wrap (sol=${lamportsToSol(solLamports).toFixed(6)} reserve=${wrap.solReserveSol.toFixed(6)})`,
    };
  }
  if (wrapLamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${logPrefix} wrap lamports exceeds JS safe integer`);
  }

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ata,
      owner,
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: ata,
      lamports: Number(wrapLamports),
    }),
    createSyncNativeInstruction(ata),
  );

  const sig = await connection.sendTransaction(tx, [keypair], {
    skipPreflight: true,
    maxRetries: 2,
  });
  await connection.confirmTransaction(sig, "confirmed");

  const afterRaw = await getTokenBalanceRawForMint(
    connection,
    owner,
    NATIVE_MINT,
  );
  const afterLamports = afterRaw ? BigInt(afterRaw) : 0n;
  return { ok: true, wrappedLamports: wrapLamports, afterLamports, sig };
}

/**
 * Ensure the owner's canonical WSOL ATA exists on-chain. Idempotent create
 * costs ~4000 CU when the account already exists (no allocation). Required
 * so that later persistent-WSOL paths (Jupiter SELL wrapAndUnwrapSol=false,
 * PumpSwap direct) cannot hit `SyncNative IncorrectProgramId` when the ATA
 * got closed previously. Returns null when no tx was needed.
 */
async function ensureWsolAtaExists(
  connection: Connection,
  keypair: Keypair,
): Promise<{ sig: string } | null> {
  const owner = keypair.publicKey;
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (info != null) {
    return null;
  }
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ata,
      owner,
      NATIVE_MINT,
    ),
  );
  const sig = await connection.sendTransaction(tx, [keypair], {
    skipPreflight: true,
    maxRetries: 2,
  });
  await connection.confirmTransaction(sig, "confirmed");
  return { sig };
}

export async function prewrapWsolOnStartup(
  connection: Connection,
  config: AppConfig,
): Promise<void> {
  if (!config.trading.persistentWsol) {
    return;
  }

  const keypair = Keypair.fromSecretKey(bs58.decode(config.botPrivateKey));

  // Phase 4: guarantee WSOL ATA exists regardless of whether we can wrap.
  // Prewrap may skip when already funded or SOL is insufficient — neither
  // path creates the ATA, so a previously-closed ATA stays missing. Any
  // downstream swap that relies on the persistent ATA would then fail with
  // `SyncNative IncorrectProgramId` (see failed tx 5hyVDJ...).
  try {
    const ensured = await ensureWsolAtaExists(connection, keypair);
    if (ensured != null) {
      console.log(
        `[startup-wsol] created missing WSOL ATA sig=${ensured.sig.slice(0, 12)}...`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[startup-wsol] ATA ensure failed (non-fatal): ${msg}`);
  }

  const prewrap = config.trading.startupPrewrapWsol;
  if (!prewrap.enabled) {
    return;
  }

  const result = await wrapSolToWsolCore(
    connection,
    keypair,
    { targetSol: prewrap.targetSol, solReserveSol: prewrap.solReserveSol },
    "[startup-wsol]",
  );

  if (!result.ok) {
    if (result.reason.startsWith("already funded")) {
      console.log(`[startup-wsol] ${result.reason}; skip`);
    } else {
      console.warn(`[startup-wsol] ${result.reason}; skip`);
    }
    return;
  }

  console.log(
    `[startup-wsol] wrapped ${lamportsToSol(result.wrappedLamports).toFixed(6)} SOL -> WSOL (after=${lamportsToSol(result.afterLamports).toFixed(6)} WSOL) sig=${result.sig.slice(0, 12)}...`,
  );
}

/**
 * On-demand SOL -> WSOL top-up when the persistent WSOL balance runs out
 * mid-session. Fire-and-forget: callers trigger it, the current swap still
 * falls back to Jupiter auto-wrap, but subsequent swaps get the refilled
 * persistent WSOL (fast path).
 */
export class WsolTopUpManager {
  private readonly keypair: Keypair;
  private readonly ownerKey: PublicKey;
  private inFlight: Promise<void> | null = null;
  private lastAttemptAt = 0;

  constructor(
    private readonly connection: Connection,
    private readonly config: AppConfig,
    private readonly cooldownMs: number = 3_000,
  ) {
    this.keypair = Keypair.fromSecretKey(bs58.decode(config.botPrivateKey));
    this.ownerKey = this.keypair.publicKey;
  }

  get owner(): PublicKey {
    return this.ownerKey;
  }

  /**
   * Fire-and-forget refill. No-op when already wrapping or within cooldown.
   * Returns the in-flight promise so callers may optionally await it.
   */
  triggerTopUp(): Promise<void> | null {
    if (!this.config.trading.persistentWsol) {
      return null;
    }
    const prewrap = this.config.trading.startupPrewrapWsol;
    if (!prewrap.enabled) {
      return null;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    const since = Date.now() - this.lastAttemptAt;
    if (since < this.cooldownMs) {
      return null;
    }

    this.lastAttemptAt = Date.now();
    this.inFlight = this.runTopUp().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runTopUp(): Promise<void> {
    const prewrap = this.config.trading.startupPrewrapWsol;
    try {
      const result = await wrapSolToWsolCore(
        this.connection,
        this.keypair,
        { targetSol: prewrap.targetSol, solReserveSol: prewrap.solReserveSol },
        "[wsol-topup]",
      );
      if (!result.ok) {
        console.warn(`[wsol-topup] skip: ${result.reason}`);
        return;
      }
      console.log(
        `[wsol-topup] refilled ${lamportsToSol(result.wrappedLamports).toFixed(6)} SOL -> WSOL (after=${lamportsToSol(result.afterLamports).toFixed(6)} WSOL) sig=${result.sig.slice(0, 12)}...`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[wsol-topup] failed: ${msg}`);
    }
  }
}
