import { isAxiosError } from "axios";

/**
 * Ubah error Axios (4xx/5xx) jadi pesan dengan konteks + status + body singkat.
 * Tanpa ini yang terlihat hanya "Request failed with status code 500".
 */
export function formatAxiosHttpError(context: string, err: unknown): Error {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data;
    const detail =
      data == null
        ? ""
        : typeof data === "string"
          ? data.slice(0, 600)
          : JSON.stringify(data).slice(0, 600);
    if (status != null) {
      return new Error(
        `${context}: HTTP ${status}${detail ? ` — ${detail}` : ""}`,
      );
    }
    return new Error(`${context}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Deterministic Jupiter errors that are NOT worth retrying: the quote endpoint
 * has decided the token/route is unroutable, and retrying will just return the
 * same response. Returning `true` tells the caller to abort further attempts.
 *
 * Covers `/quote` (v1 Metis) and `/order` (v2 Ultra) error payloads that arrive
 * as `message: "...: HTTP 4xx — {...errorCode...}"`.
 */
const TERMINAL_JUPITER_ERROR_CODES = [
  "TOKEN_NOT_TRADABLE",
  "NOT_TRADABLE",
  "COULD_NOT_FIND_ANY_ROUTE",
  "NO_ROUTES_FOUND",
  "CIRCULAR_ARBITRAGE_IS_DISABLED",
] as const;

export function isTerminalJupiterQuoteError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!msg) {
    return false;
  }
  return TERMINAL_JUPITER_ERROR_CODES.some((code) => msg.includes(code));
}
