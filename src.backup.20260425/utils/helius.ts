/** Ambil api-key dari query URL Helius (HELIUS_RPC_URL). */
export const extractHeliusApiKey = (rpcUrl: string): string | undefined => {
  try {
    const u = new URL(rpcUrl);
    const key = u.searchParams.get("api-key");
    return key?.trim() || undefined;
  } catch {
    return undefined;
  }
};
