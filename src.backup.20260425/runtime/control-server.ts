import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../types/index.js";
import { runtimeState } from "./runtime-state.js";
import { metrics } from "./metrics-registry.js";
import {
  applyRuntimeOverridesToConfig,
  getRuntimeSettings,
  updateRuntimeSettings,
} from "./settings-overrides.js";

export type ControlHooks = {
  getConfig: () => AppConfig;
  getPositions: () => Array<{
    token: string;
    owner: string;
    buyCount: number;
    openedAtMs: number;
  }>;
  releasePosition: (token: string) => boolean;
  forceSellPosition: (token: string) => Promise<void>;
  reloadWhales: () => Promise<{ count: number }>;
  refreshSolBalance: () => Promise<number>;
  refreshHistory: () => Promise<{
    added: number;
    skipped: number;
    fetched: number;
  }>;
};

const CONFIG_JSON_PATH = path.resolve(process.cwd(), "configuration.json");

let server: http.Server | null = null;

/**
 * Start the bot's control API. Binds to 127.0.0.1 by default so arbitrary
 * network clients can't pause trading — the dashboard proxies via its own
 * process on the same host.
 */
export function startControlServer(
  port: number,
  bindHost: string,
  authToken: string | null,
  hooks: ControlHooks,
): void {
  if (server != null) return;
  if (!Number.isFinite(port) || port <= 0) return;

  server = http.createServer((req, res) => {
    // All control routes are non-blocking — promise chain dispatched below.
    void handle(req, res, hooks, authToken).catch((e) => {
      console.warn(
        `[control] handler error: ${e instanceof Error ? e.message : String(e)}`,
      );
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    });
  });

  server.on("error", (e) => {
    console.warn(
      `[control] server error: ${e instanceof Error ? e.message : String(e)}`,
    );
  });

  server.listen(port, bindHost, () => {
    console.log(`[control] API listening on ${bindHost}:${port}`);
  });
}

export function stopControlServer(): void {
  if (server == null) return;
  const s = server;
  server = null;
  s.close();
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Auth-Token",
    "Content-Length": Buffer.byteLength(data).toString(),
  });
  res.end(data);
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 64 * 1024;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  hooks: ControlHooks,
  authToken: string | null,
): Promise<void> {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, null);
    return;
  }

  // Auth gate (skip for trivially-readable health check).
  if (authToken != null && authToken !== "" && req.url !== "/api/health") {
    const header = req.headers["x-auth-token"] ?? req.headers["authorization"];
    const provided = Array.isArray(header) ? header[0] : header;
    const clean = (provided ?? "").replace(/^Bearer\s+/i, "").trim();
    if (clean !== authToken) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
  }

  const urlStr = req.url ?? "/";
  const url = new URL(urlStr, "http://localhost");
  const key = `${req.method} ${url.pathname}`;

  switch (key) {
    case "GET /api/health":
      sendJson(res, 200, { ok: true, uptime: process.uptime() });
      return;

    case "GET /api/status":
      await handleStatus(res, hooks);
      return;

    case "POST /api/pause":
      runtimeState.tradingPaused = true;
      sendJson(res, 200, { paused: true });
      return;

    case "POST /api/resume":
      runtimeState.tradingPaused = false;
      sendJson(res, 200, { paused: false });
      return;

    case "GET /api/whales":
      sendJson(res, 200, { wallets: readWhales() });
      return;

    case "POST /api/whales": {
      const body = (await readBody(req)) as {
        add?: string[];
        remove?: string[];
      };
      const result = applyWhaleChanges(body?.add ?? [], body?.remove ?? []);
      // Reconnect listener with the new wallet set.
      const { count } = await hooks.reloadWhales();
      sendJson(res, 200, { ...result, subscribed: count });
      return;
    }

    case "GET /api/positions":
      sendJson(res, 200, {
        positions: hooks.getPositions().map((p) => ({
          ...p,
          ageMs: Date.now() - p.openedAtMs,
        })),
      });
      return;

    case "GET /api/history":
      sendJson(res, 200, {
        history: runtimeState.getHistory(
          Number(url.searchParams.get("limit") ?? 50),
        ),
      });
      return;

    case "GET /api/settings":
      sendJson(res, 200, getRuntimeSettings());
      return;

    case "POST /api/settings": {
      const body = (await readBody(req)) as Record<string, unknown>;
      const updated = await updateRuntimeSettings(body);
      // Push new values into the live AppConfig so hot path sees them on
      // the NEXT whale event — no restart needed.
      applyRuntimeOverridesToConfig(hooks.getConfig());
      sendJson(res, 200, updated);
      return;
    }

    case "GET /api/metrics":
      sendJson(res, 200, readMetricsJson());
      return;

    case "POST /api/refresh-balance": {
      try {
        const lamports = await hooks.refreshSolBalance();
        sendJson(res, 200, {
          lamports,
          sol: lamports / 1_000_000_000,
          baselineLamports: runtimeState.baselineSolLamports,
        });
      } catch (e) {
        sendJson(res, 500, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    case "POST /api/refresh-history": {
      try {
        const r = await hooks.refreshHistory();
        sendJson(res, 200, r);
      } catch (e) {
        sendJson(res, 500, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    case "POST /api/recapture-baseline": {
      try {
        const lamports = await hooks.refreshSolBalance();
        runtimeState.setBaseline(lamports);
        sendJson(res, 200, {
          baselineSol: lamports / 1_000_000_000,
          capturedAtMs: runtimeState.baselineCapturedAtMs,
        });
      } catch (e) {
        sendJson(res, 500, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }
  }

  // Dynamic position routes.
  const sellMatch = url.pathname.match(
    /^\/api\/positions\/([1-9A-HJ-NP-Za-km-z]{32,44})\/force-sell$/,
  );
  if (req.method === "POST" && sellMatch != null) {
    const token = sellMatch[1]!;
    try {
      await hooks.forceSellPosition(token);
      sendJson(res, 200, { ok: true, token });
    } catch (e) {
      sendJson(res, 500, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return;
  }

  sendJson(res, 404, { error: "not found", path: url.pathname });
}

async function handleStatus(
  res: ServerResponse,
  hooks: ControlHooks,
): Promise<void> {
  const cfg = hooks.getConfig();
  const overrides = getRuntimeSettings();
  const positions = hooks.getPositions();
  const baseline = runtimeState.baselineSolLamports;
  const latest = runtimeState.latestSolLamports;
  const pnlLamports =
    baseline != null && latest != null ? latest - baseline : null;
  // Trade-flow P&L from history counters (Helius restore + live). Independent
  // of the balance-delta pnlSol so the dashboard can surface meaningful
  // "lifetime trade performance" even right after a fresh baseline capture.
  const netFlowSol = runtimeState.totalSellSolOut - runtimeState.totalBuySolIn;

  sendJson(res, 200, {
    paused: runtimeState.tradingPaused,
    uptimeSec: Math.floor(process.uptime()),
    whaleCount: cfg.whaleWallets.length,
    positionCount: positions.length,
    tradeCounts: {
      buy: runtimeState.totalBuyCount,
      sell: runtimeState.totalSellCount,
      failed: runtimeState.totalFailedCount,
    },
    volumeSol: {
      bought: runtimeState.totalBuySolIn,
      sold: runtimeState.totalSellSolOut,
      netFlow: netFlowSol,
    },
    balance: {
      baselineSol: baseline != null ? baseline / 1_000_000_000 : null,
      baselineCapturedAtMs: runtimeState.baselineCapturedAtMs,
      latestSol: latest != null ? latest / 1_000_000_000 : null,
      latestRefreshedAtMs: runtimeState.latestSolRefreshedAtMs,
      pnlSol: pnlLamports != null ? pnlLamports / 1_000_000_000 : null,
      netFlowSol,
    },
    trading: {
      slippageBps: overrides.slippageBps ?? cfg.trading.slippageBps,
      fixedBuyAmountSol:
        overrides.fixedBuyAmountSol ?? cfg.trading.fixedBuyAmountSol,
      minWhaleBuyAmountSol:
        overrides.minWhaleBuyAmountSol ?? cfg.trading.minWhaleBuyAmountSol,
      rebuyEnabled: overrides.rebuyEnabled ?? cfg.trading.rebuyEnabled,
      rebuyMaxCount: overrides.rebuyMaxCount ?? cfg.trading.rebuyMaxCount,
      rebuyAmountSize: overrides.rebuyAmountSize ?? cfg.trading.rebuyAmountSize,
      followWhaleSell: overrides.followWhaleSell ?? cfg.trading.followWhaleSell,
      autoSellTtlMs: overrides.autoSellTtlMs ?? cfg.trading.autoSellTtlMs,
    },
  });
}

const readWhales = (): string[] => {
  if (!existsSync(CONFIG_JSON_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(CONFIG_JSON_PATH, "utf8")) as {
      whaleWallets?: unknown;
    };
    return Array.isArray(raw.whaleWallets)
      ? (raw.whaleWallets.filter(
          (w) => typeof w === "string" && w.length > 0,
        ) as string[])
      : [];
  } catch {
    return [];
  }
};

const applyWhaleChanges = (
  add: string[],
  remove: string[],
): { added: string[]; removed: string[]; total: number } => {
  let raw: Record<string, unknown> = {};
  if (existsSync(CONFIG_JSON_PATH)) {
    try {
      raw = JSON.parse(readFileSync(CONFIG_JSON_PATH, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      raw = {};
    }
  }
  const current = new Set<string>(
    Array.isArray(raw.whaleWallets)
      ? (raw.whaleWallets.filter(
          (w) => typeof w === "string" && w.length > 0,
        ) as string[])
      : [],
  );
  const clean = (arr: string[]): string[] =>
    Array.from(
      new Set(
        arr.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean),
      ),
    );
  const addList = clean(add);
  const removeList = clean(remove);
  const added: string[] = [];
  const removed: string[] = [];
  for (const w of addList) {
    if (!current.has(w)) {
      current.add(w);
      added.push(w);
    }
  }
  for (const w of removeList) {
    if (current.delete(w)) {
      removed.push(w);
    }
  }
  raw.whaleWallets = Array.from(current);
  // Atomic write.
  const tmp = `${CONFIG_JSON_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
  // fs.renameSync for atomic replace.
  try {
    // Using require-free rename via sync fs.
    // Cross-platform safe on Node 18+.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").renameSync(tmp, CONFIG_JSON_PATH);
  } catch {
    // If rename fails (Windows file-lock edge), fallback to overwrite.
    writeFileSync(CONFIG_JSON_PATH, JSON.stringify(raw, null, 2), "utf8");
  }
  return { added, removed, total: current.size };
};

const readMetricsJson = (): Record<string, unknown> => {
  // Convenience JSON view of key metrics for the dashboard.
  const pipelineBuy = metrics.getPercentiles("laser_pipeline_ms", {
    side: "BUY",
  });
  const pipelineSell = metrics.getPercentiles("laser_pipeline_ms", {
    side: "SELL",
  });
  return {
    pipelineBuy,
    pipelineSell,
  };
};
