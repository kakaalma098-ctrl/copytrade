import { formatAxiosHttpError } from "../utils/axios-http-error.js";
import { senderHttpClient } from "../utils/sender-http-client.js";
import { extractHeliusApiKey } from "../utils/helius.js";

type JsonRpcSendResponse = {
  result?: string;
  error?: { message?: string; code?: number };
};

/**
 * Kirim raw tx via Helius Sender (JSON-RPC), bukan RPC umum.
 * @see https://www.helius.dev/docs/sending-transactions/sender
 */
export const sendTransactionViaHeliusSender = async (
  senderEndpointBase: string,
  rpcUrlForApiKey: string,
  serializedTx: Uint8Array,
): Promise<string> => {
  const key = extractHeliusApiKey(rpcUrlForApiKey);
  const url = key
    ? `${senderEndpointBase.replace(/\/$/, "")}?api-key=${encodeURIComponent(key)}`
    : senderEndpointBase;

  const base64Tx = Buffer.from(serializedTx).toString("base64");
  let data: JsonRpcSendResponse;
  try {
    const res = await senderHttpClient.post<JsonRpcSendResponse>(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [
        base64Tx,
        { encoding: "base64", skipPreflight: true, maxRetries: 0 },
      ],
    });
    data = res.data;
  } catch (e) {
    throw formatAxiosHttpError("Helius Sender (POST sendTransaction)", e);
  }

  if (data.error) {
    throw new Error(
      data.error.message ?? `sender error ${data.error.code ?? ""}`,
    );
  }
  if (!data.result) {
    throw new Error("sender: empty result");
  }
  return data.result;
};
