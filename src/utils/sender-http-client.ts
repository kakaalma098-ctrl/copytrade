import https from "node:https";
import axios from "axios";

/**
 * Dedicated HTTP client for transaction submission (Helius Sender / Jito).
 * Isolated from the general httpClient used for Jupiter quotes to prevent
 * head-of-line blocking when Jupiter rate-limit retries are in progress.
 *
 * Phase 3: LIFO scheduling + extended keep-alive. Sender calls are bursty
 * (one per swap) so reusing the hottest socket matters most — FIFO recycles
 * old sockets that may need TLS session re-establishment.
 */
const senderAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  keepAliveMsecs: 60_000,
  scheduling: "lifo",
});

export const senderHttpClient = axios.create({
  httpsAgent: senderAgent,
  proxy: false,
  timeout: 5_000,
  validateStatus: (status) => status >= 200 && status < 300,
});
