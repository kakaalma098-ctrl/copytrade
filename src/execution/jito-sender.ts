import { formatAxiosHttpError } from "../utils/axios-http-error.js";
import { senderHttpClient } from "../utils/sender-http-client.js";

type JsonRpcSendResponse = {
  result?: string;
  error?: { message?: string; code?: number };
};

/**
 * Kirim raw tx via Jito block-engine JSON-RPC endpoint (tanpa auth header).
 * Endpoint default: https://mainnet.block-engine.jito.wtf/api/v1/transactions
 */
export const sendTransactionViaJito = async (
  endpoint: string,
  serializedTx: Uint8Array,
): Promise<string> => {
  const url = endpoint.replace(/\/$/, "");
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
    throw formatAxiosHttpError("Jito Sender (POST sendTransaction)", e);
  }

  if (data.error) {
    throw new Error(
      data.error.message ?? `jito sender error ${data.error.code ?? ""}`,
    );
  }
  if (!data.result) {
    throw new Error("jito sender: empty result");
  }
  return data.result;
};
