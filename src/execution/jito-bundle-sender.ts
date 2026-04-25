import bs58 from "bs58";
import { formatAxiosHttpError } from "../utils/axios-http-error.js";
import { senderHttpClient } from "../utils/sender-http-client.js";

type JsonRpcBundleResponse = {
  result?: string;
  error?: { message?: string; code?: number };
};

const JITO_BUNDLE_ENDPOINT =
  "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

/**
 * R17: Submit a Jito bundle — array of signed transactions executed atomically.
 * Bundles provide MEV protection: either all txs land in the same slot or none do.
 *
 * Typical usage: [swapTx, tipTx] where tipTx transfers SOL to a Jito tip account.
 * The tip can be a separate, smaller transaction instead of injecting into the swap tx
 * (avoids decompile/recompile overhead from Phase 2 R1).
 */
export async function sendJitoBundle(
  serializedTxs: Uint8Array[],
  endpoint?: string,
): Promise<string> {
  const url = (endpoint ?? JITO_BUNDLE_ENDPOINT).replace(/\/$/, "");
  const b58Txs = serializedTxs.map((raw) => bs58.encode(raw));

  let data: JsonRpcBundleResponse;
  try {
    const res = await senderHttpClient.post<JsonRpcBundleResponse>(
      url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [b58Txs],
      },
      { timeout: 5_000 },
    );
    data = res.data;
  } catch (e) {
    throw formatAxiosHttpError("Jito Bundle (POST sendBundle)", e);
  }

  if (data.error) {
    throw new Error(
      data.error.message ?? `jito bundle error ${data.error.code ?? ""}`,
    );
  }
  if (!data.result) {
    throw new Error("jito bundle: empty bundle_id");
  }
  return data.result;
}
