import http from "node:http";
import https from "node:https";
import axios from "axios";

/**
 * Phase 3: aggressive keep-alive tuning for Jupiter hot path.
 * - `keepAliveMsecs: 60_000` — keep sockets alive between bursty whale events
 *   (Node default is 1_000ms, which drops the socket during quiet periods and
 *   forces a new TLS handshake on the next swap — adds 30-80ms).
 * - `scheduling: "lifo"` — reuse the most recently active socket first. Hot
 *   sockets have warm TCP congestion window + TLS session resumption state;
 *   FIFO (Node default) recycles oldest sockets and wastes that warm state.
 * - `maxSockets: 50` — plenty for 4 Jupiter keys × ~3 concurrent swaps.
 */
const AGENT_KEEP_ALIVE_MSECS = 60_000;

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: AGENT_KEEP_ALIVE_MSECS,
  maxSockets: 50,
  scheduling: "lifo",
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: AGENT_KEEP_ALIVE_MSECS,
  maxSockets: 50,
  scheduling: "lifo",
});

export const httpClient = axios.create({
  httpAgent,
  httpsAgent,
  // Hard-disable proxy path for all axios calls in this bot.
  proxy: false,
  // Phase 3: tightened from 8000ms — Jupiter p99 observed ~500ms, 5s is
  // still 10x p99 headroom while failing stuck connections 3s sooner.
  timeout: 5000,
  validateStatus: (status) => status >= 200 && status < 300,
});
