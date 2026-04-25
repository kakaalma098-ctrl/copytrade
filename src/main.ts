import { PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config/index.js";
import { bus } from "./bus/event-bus.js";
import { configureUnknownProtocolLog } from "./perf/unknown-protocol-log.js";
import {
  configureInstructionDropLog,
  flushInstructionDropsNow,
} from "./perf/instruction-drop-log.js";
import { WhaleListenerService } from "./listener/index.js";
import { SignalProcessor } from "./processor/index.js";
import { createExecutionStack } from "./engine/index.js";
import { TelegramNotifier } from "./notifications/telegram.js";
import { logLatencyLine, recordLatencyMetrics } from "./perf/latency.js";
import { logBotWalletFromRpc } from "./perf/bot-wallet-rpc.js";
import { warmupSolanaPipeline } from "./perf/warmup.js";
import { prewrapWsolOnStartup } from "./perf/startup-prewrap-wsol.js";
import { PositionStateStore } from "./perf/position-state-store.js";
import { fetchAndRestoreBotHistory } from "./perf/history-fetcher.js";
import { HistoryStore } from "./runtime/history-store.js";
import {
  startMetricsServer,
  stopMetricsServer,
} from "./runtime/metrics-server.js";
import { SlaWatcher } from "./runtime/sla-alert.js";
import { runtimeState } from "./runtime/runtime-state.js";
import {
  applyRuntimeOverridesToConfig,
  initRuntimeSettings,
  saveRuntimeSettingsSync,
} from "./runtime/settings-overrides.js";
import {
  startControlServer,
  stopControlServer,
} from "./runtime/control-server.js";
import {
  formatStartupSummaryConsole,
  formatStartupSummaryTelegram,
} from "./startup-summary.js";

const main = async (): Promise<void> => {
  const config = loadConfig();
  console.log(formatStartupSummaryConsole(config));
  configureUnknownProtocolLog({ enabled: config.debug.unknownProtocolLog });
  // Always-on diagnostic for preprocessed-mode drops — gated only by
  // feedMode=grpc since it would never fire on WSS path. Keeps logs/instruction_drop.jsonl
  // up to date so the operator can analyse unsupported protocols offline.
  configureInstructionDropLog({ enabled: config.helius.feedMode === "grpc" });
  const {
    copy: copyEngine,
    connection,
    jupiter,
    execution,
    blockhashCache,
    poolAccountStream,
    wsolTracker,
    walletStateCache,
  } = createExecutionStack(config);

  // Runtime-mutable settings — UI can override slippage / amounts etc.
  // applyRuntimeOverridesToConfig mutates the live config so every hot-path
  // reader (engine, jupiter, processor) picks up overrides immediately —
  // even on first startup (when saved overrides existed from previous run).
  await initRuntimeSettings(
    config.trading.positionStateFile.replace(
      /positions\.json$/,
      "settings.json",
    ),
  );
  applyRuntimeOverridesToConfig(config);

  const processor = new SignalProcessor(config);
  const notifier = new TelegramNotifier(config.telegram);

  // Position state persistence — restore tracked cycles from last run so
  // first-whale-wins locks + TTL clocks survive restarts.
  // Crash-safe layering:
  //   - markDirty on every change → debounced 500ms write (coalesces bursts)
  //   - periodic safety-net flush every positionStateSaveIntervalMs
  //   - SIGINT/SIGTERM: await saveNow (atomic tmp+rename)
  //   - uncaughtException / unhandledRejection: saveSync BEFORE exit
  const positionStore = new PositionStateStore(
    config.trading.positionStateFile,
    () => processor.getPositionSnapshot(),
  );
  const persisted = await positionStore.load();
  if (persisted.length > 0) {
    processor.loadPersistedPositions(persisted);
    console.log(
      `[position-state] restored ${persisted.length} position(s) from ${config.trading.positionStateFile}`,
    );
  }
  processor.onPositionChange(() => positionStore.markDirty());
  positionStore.startPeriodicSave(config.trading.positionStateSaveIntervalMs);

  // History + P&L baseline + counters persistence — cache so dashboard
  // Recent Trades / Trading Activity / P&L appear instantly on restart
  // (before Helius fetch populates). File is merged with live events + the
  // 2h Helius refresh; dedup by signature prevents duplicate counts.
  const historyStore = new HistoryStore(
    config.trading.positionStateFile.replace(
      /positions\.json$/,
      "trades-history.json",
    ),
    () => runtimeState.getFullSnapshot(),
  );
  const persistedHistory = await historyStore.load();
  if (persistedHistory != null) {
    runtimeState.loadFullSnapshot(persistedHistory);
    console.log(
      `[history-store] restored ${persistedHistory.history.length} trade(s), counters buy=${persistedHistory.counters.totalBuyCount} sell=${persistedHistory.counters.totalSellCount} failed=${persistedHistory.counters.totalFailedCount}, baseline=${
        persistedHistory.baseline.solLamports != null
          ? (persistedHistory.baseline.solLamports / 1e9).toFixed(6) + " SOL"
          : "none"
      }`,
    );
  }
  runtimeState.onChange(() => historyStore.markDirty());
  historyStore.startPeriodicSave(15_000);

  // R15: Direct function call chain (no EventEmitter on hot path).
  // Listener → processor.handleWhaleTx() → engine.handleSignal()
  // R12: Speculative BUY quote fires in parallel with processor validation.
  processor.setOnSignal((signal) => copyEngine.handleSignal(signal));
  // Position-lock: gate speculative SELL so only the whale that OPENED the
  // bot's position cycle can trigger a SELL prebuild. Matches processor's
  // SELL filter exactly — no wasted Jupiter calls for non-owner whales.
  copyEngine.setShouldAttemptSell((token, whale) =>
    processor.isSellFromPositionOwner(token, whale),
  );
  // Rebuy ladder: predict next buyCount so speculative BUY size matches what
  // processor will assign after increment (keeps prebuild cache aligned).
  copyEngine.setBuyCountLookup((token) => processor.getBuyCount(token));

  const listener = new WhaleListenerService(config, connection, (tx) => {
    // R12: Fire speculative quote immediately — overlaps with processor filter time.
    copyEngine.speculativeQuoteForBuy(tx);
    // Phase 4: Mirror speculative quote for SELL — overlaps with processor validate.
    copyEngine.speculativeQuoteForSell(tx);
    // Fix B: eagerly register pump-swap pools with the gRPC stream so subsequent
    // swaps on this pool (rebuy, SELL) skip the ~30-45ms getMultipleAccountsInfo.
    copyEngine.speculativelySubscribePool(tx);
    // R15: Direct call to processor (bypasses EventEmitter).
    processor.handleWhaleTx(tx);
  });

  // exec:result still uses bus — multiple listeners (metrics + latency log + telegram + dashboard history).
  bus.on("exec:result", (result) => {
    // Phase 6: record metrics unconditionally; sampling / log-gate only
    // affects console output downstream.
    recordLatencyMetrics(result);
    setImmediate(() => {
      logLatencyLine(config, result);
    });
    // Dashboard history + P&L counters.
    const side = result.side ?? "BUY";
    const status =
      result.status === "failed"
        ? "failed"
        : result.status === "confirmed"
          ? "confirmed"
          : "submitted";
    runtimeState.appendHistory({
      ts: Date.now(),
      side,
      status,
      token: result.token ?? "",
      whale: result.whaleWallet ?? "",
      sizeSol: result.sizeSol ?? 0,
      signature: result.signature ?? "",
      pipelineMs: result.pipelineTotalMs,
      error: result.error,
    });
    if (status === "failed") {
      runtimeState.totalFailedCount += 1;
    } else if (side === "BUY") {
      runtimeState.totalBuyCount += 1;
      runtimeState.totalBuySolIn += result.sizeSol ?? 0;
      // Optimistic latest-balance decrement so P&L UI reflects the BUY
      // without waiting for the next drift-reconcile RPC tick.
      if (
        runtimeState.latestSolLamports != null &&
        Number.isFinite(result.sizeSol)
      ) {
        const delta = Math.floor((result.sizeSol ?? 0) * 1_000_000_000);
        runtimeState.updateLatestSol(
          Math.max(0, runtimeState.latestSolLamports - delta),
        );
      }
    } else {
      runtimeState.totalSellCount += 1;
      const outRaw = result.outAmountRaw;
      const outLamports =
        typeof outRaw === "number"
          ? outRaw
          : typeof outRaw === "string"
            ? Number(outRaw) || 0
            : 0;
      runtimeState.totalSellSolOut += outLamports / 1_000_000_000;
      // Optimistic increment for SELL — Jupiter quote outAmount = SOL received.
      if (runtimeState.latestSolLamports != null && outLamports > 0) {
        runtimeState.updateLatestSol(
          runtimeState.latestSolLamports + outLamports,
        );
      }
    }
    void notifier.notifyResult(result).catch((e) => {
      console.error("[telegram] notifyResult:", e);
    });
  });
  await Promise.all([
    warmupSolanaPipeline(connection, jupiter, config),
    // Seed wallet SOL cache so the first BUY/SELL does not block on a fresh
    // getBalance RPC call. Failure is non-fatal — the cache will lazy-fill.
    walletStateCache.getSolLamports().catch((e: unknown) => {
      console.warn(
        "[warmup] wallet SOL prefetch failed (non-fatal):",
        e instanceof Error ? e.message : e,
      );
    }),
  ]);

  // Level 2: start RTT healthcheck (no-op if disabled or multi-race off).
  // Probes each send endpoint in the background and auto-excludes slow ones
  // from the send race until they recover.
  if (execution.healthChecker != null) {
    execution.healthChecker.start();
    console.log(
      `[rpc-health] started (probe=${config.execution.rpcHealthCheck.probeIntervalMs}ms threshold=${config.execution.rpcHealthCheck.latencyThresholdMs}ms)`,
    );
  }
  try {
    await prewrapWsolOnStartup(connection, config);
  } catch (e) {
    console.warn(
      "[startup-wsol] prewrap failed (non-fatal):",
      e instanceof Error ? e.message : e,
    );
  }
  // Tracker initialization must run AFTER prewrap so the initial on-chain
  // read reflects the post-wrap balance. With the tracker warm, BUY hot path
  // skips the ~30-50ms WSOL balance RPC in `resolveWrapAndUnwrapSol`.
  if (wsolTracker != null) {
    try {
      await wsolTracker.initialize();
    } catch (e) {
      console.warn(
        "[wsol-tracker] init failed (non-fatal):",
        e instanceof Error ? e.message : e,
      );
    }
  }
  const walletSnapshot = await logBotWalletFromRpc(connection, config);
  // Capture baseline SOL balance for P&L calculation surfaced by the dashboard.
  // If a baseline was restored from disk, we keep it (preserves lifetime P&L
  // across restarts) and only update the latest-SOL snapshot.
  if (walletSnapshot != null && typeof walletSnapshot.balanceSol === "number") {
    const lamports = Math.floor(walletSnapshot.balanceSol * 1_000_000_000);
    if (runtimeState.baselineSolLamports == null) {
      runtimeState.setBaseline(lamports);
      console.log(
        `[pnl] baseline captured sol=${walletSnapshot.balanceSol.toFixed(6)} (first run)`,
      );
    } else {
      runtimeState.updateLatestSol(lamports);
      const base = runtimeState.baselineSolLamports / 1e9;
      const pnl = walletSnapshot.balanceSol - base;
      const sign = pnl >= 0 ? "+" : "";
      console.log(
        `[pnl] baseline preserved sol=${base.toFixed(6)} · current=${walletSnapshot.balanceSol.toFixed(6)} · pnl=${sign}${pnl.toFixed(6)}`,
      );
    }
  }

  // Historical trade restore — populates dashboard Recent Trades + Trading
  // Activity counters from Helius Enhanced Tx API so cold-start isn't empty.
  // Fire-and-forget on startup, refresh every 2h. Dedup by signature makes
  // repeated calls idempotent.
  const HISTORY_REFRESH_MS = 2 * 60 * 60 * 1000;
  // Drift-correction only — live P&L responsiveness comes from the exec:result
  // delta tracker below (no RPC per trade). 2h cadence reconciles any drift
  // from fees / external wallet activity without filling the logs.
  const BALANCE_DRIFT_RECONCILE_MS = 2 * 60 * 60 * 1000;
  const botAddress = walletSnapshot?.publicKey;
  const botPubkeyForBalance =
    botAddress != null
      ? (() => {
          try {
            return new PublicKey(botAddress);
          } catch {
            return null;
          }
        })()
      : null;

  // Silent drift reconciliation — directly calls connection.getBalance without
  // going through logBotWalletFromRpc (which logs verbosely). No console spam.
  const balanceTimer = setInterval(() => {
    if (botPubkeyForBalance == null) return;
    void connection
      .getBalance(botPubkeyForBalance, "confirmed")
      .then((lamports) => {
        runtimeState.updateLatestSol(lamports);
      })
      .catch(() => {
        /* transient — next tick will retry */
      });
  }, BALANCE_DRIFT_RECONCILE_MS);
  balanceTimer.unref?.();
  const runHistoryFetch = async (): Promise<void> => {
    if (!botAddress || !config.helius.apiKey) return;
    try {
      const r = await fetchAndRestoreBotHistory(
        botAddress,
        config.helius.apiKey,
      );
      if (r.errored) {
        console.warn(
          `[history] fetch partial: ${r.errored} (fetched=${r.fetched} added=${r.added} skipped=${r.skipped})`,
        );
      } else {
        console.log(
          `[history] helius tx restore: pages=${r.pages} fetched=${r.fetched} added=${r.added} skipped=${r.skipped}`,
        );
      }
    } catch (e) {
      console.warn(
        `[history] fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  // Schedule initial fetch AFTER listener start so we don't add to startup
  // critical path. setImmediate to yield first.
  setImmediate(() => {
    void runHistoryFetch();
  });
  const historyTimer = setInterval(() => {
    void runHistoryFetch();
  }, HISTORY_REFRESH_MS);
  // Prevent the timer from holding the event loop open during shutdown.
  historyTimer.unref?.();
  // notifyStart BEFORE startCommands: bot.launch() polls Telegram and can block a long time
  // (or hang on bad network); sendMessage does not require polling.
  try {
    await notifier.notifyStart(
      formatStartupSummaryTelegram(config, walletSnapshot),
    );
  } catch (e) {
    console.error("[telegram] notifyStart failed:", e);
  }
  // Whale listener MUST run before startCommands(): bot.launch() can block a long time on
  // api.telegram.org — if it ran first, Laserstream would never start (no signals, no WHALE_DEBUG).
  console.log("[laser-helius] starting whale listener (Laserstream / WSS)…");
  await listener.start();
  console.log("[laser-helius] whale listener connected");

  // Start the pool account gRPC stream. Independent of whale listener — stream
  // failure here does not prevent whale detection; it only disables the
  // push-cache fast path (pumpStateCache falls back to RPC automatically).
  try {
    await poolAccountStream.start();
    console.log("[laser-helius] pool account stream connected");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[laser-helius] pool account stream failed to start: ${msg} (non-fatal, RPC fallback active)`,
    );
  }

  // Phase 4: start background SELL prebuild refresh for active positions so
  // the cache is warm when the next whale SELL arrives.
  copyEngine.startPositionPrewarm(() => processor.getTrackedTokens());

  // Auto-sell TTL: close positions whose owner whale hasn't signalled SELL
  // within the configured hold window. Per-token overrides (from
  // configuration.json -> tokenOverrides) take precedence over the global
  // default. 0 globally AND no overrides → watcher runs but finds nothing
  // to sell (cheap no-op).
  const overrideCount = Object.keys(config.trading.tokenOverrides).length;
  const globalTtlMs = config.trading.autoSellTtlMs;
  if (globalTtlMs > 0 || overrideCount > 0) {
    const effectiveTtl = (token: string): number => {
      const override = config.trading.tokenOverrides[token]?.autoSellTtlMs;
      if (override != null) return override;
      return globalTtlMs;
    };
    copyEngine.startAutoSellWatcher(
      () => processor.getAllPositions(),
      (token) => processor.releasePosition(token),
      effectiveTtl,
      config.trading.autoSellCheckIntervalMs,
    );
    console.log(
      `[auto-sell] watcher enabled globalTtl=${Math.round(globalTtlMs / 60_000)}min overrides=${overrideCount} check=${Math.round(config.trading.autoSellCheckIntervalMs / 1000)}s`,
    );
  }

  // Dashboard control API (port 9092 localhost by default). Lightweight
  // async-only server — does not share CPU time with the hot path.
  if (config.observability.controlApiPort > 0) {
    startControlServer(
      config.observability.controlApiPort,
      config.observability.controlApiBind,
      config.observability.controlApiToken || null,
      {
        getConfig: () => config,
        getPositions: () => processor.getPositionSnapshot(),
        releasePosition: (token) => processor.releasePosition(token),
        forceSellPosition: async (token: string) => {
          const positions = processor.getPositionSnapshot();
          const match = positions.find((p) => p.token === token);
          const owner = match?.owner ?? "manual";
          processor.releasePosition(token);
          await copyEngine.forceSellByToken(token, owner);
        },
        reloadWhales: async () => {
          // Re-read configuration.json for fresh whale list and push to listener.
          try {
            const { readFileSync } = await import("node:fs");
            const cfgPath = (await import("node:path")).resolve(
              process.cwd(),
              "configuration.json",
            );
            const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as {
              whaleWallets?: string[];
            };
            const whales = Array.isArray(raw.whaleWallets)
              ? raw.whaleWallets.filter(
                  (w: unknown) => typeof w === "string" && w.length > 0,
                )
              : [];
            const n = await listener.reloadWhales(whales);
            return { count: n };
          } catch (e) {
            throw new Error(
              `reloadWhales failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        },
        refreshSolBalance: async () => {
          const fresh = await logBotWalletFromRpc(connection, config);
          if (fresh != null && typeof fresh.balanceSol === "number") {
            const lamports = Math.floor(fresh.balanceSol * 1_000_000_000);
            runtimeState.updateLatestSol(lamports);
            return lamports;
          }
          throw new Error("balance fetch failed");
        },
        refreshHistory: async () => {
          if (!botAddress || !config.helius.apiKey) {
            throw new Error("bot address / helius API key not available");
          }
          const r = await fetchAndRestoreBotHistory(
            botAddress,
            config.helius.apiKey,
          );
          return {
            added: r.added,
            skipped: r.skipped,
            fetched: r.fetched,
          };
        },
      },
    );
  }

  // Phase 6: observability — Prometheus metrics + SLA-breach Telegram alert.
  startMetricsServer(config.observability.metricsPort);
  const slaWatcher = new SlaWatcher();
  if (config.observability.slaAlert.enabled && config.telegram.enabled) {
    slaWatcher.start(notifier, config.observability.slaAlert);
    console.log(
      `[sla-alert] enabled buyP95=${config.observability.slaAlert.buyP95Ms}ms sellP95=${config.observability.slaAlert.sellP95Ms}ms window=${Math.round(config.observability.slaAlert.windowMs / 1000)}s`,
    );
  }
  try {
    await notifier.startCommands();
  } catch (e) {
    console.error(
      "[telegram] startCommands failed — whale + engine tetap jalan:",
      e,
    );
  }

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${reason} — flushing state`);
    clearInterval(historyTimer);
    clearInterval(balanceTimer);
    slaWatcher.stop();
    stopMetricsServer();
    stopControlServer();
    copyEngine.stopAutoSellWatcher();
    copyEngine.stopPositionPrewarm();
    execution.healthChecker?.stop();
    positionStore.stop();
    historyStore.stop();
    try {
      await Promise.all([positionStore.saveNow(), historyStore.saveNow()]);
      console.log("[persistence] final async save OK");
    } catch (e) {
      console.warn(
        "[persistence] async final save failed — trying sync:",
        e instanceof Error ? e.message : e,
      );
      positionStore.saveSync();
      historyStore.saveSync();
    }
    blockhashCache.stop();
    await listener.stop();
    await notifier.stop();
    try {
      await flushInstructionDropsNow();
    } catch {
      // never block shutdown on a diagnostic flush
    }
    process.exit(0);
  };

  // Graceful shutdown signals
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // PM2 sends SIGHUP on reload in some configs.
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  // Crash-safe: write state BEFORE the process dies from a fatal error.
  // Async I/O won't complete in time; positionStore.saveSync is blocking
  // and guarantees the atomic tmp+rename lands.
  const crashSave = (reason: string, err?: unknown): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(
      `[crash] ${reason}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    try {
      positionStore.stop();
      positionStore.saveSync();
      historyStore.stop();
      historyStore.saveSync();
      saveRuntimeSettingsSync();
      console.error("[persistence] crash sync save OK");
    } catch {
      /* already logged inside saveSync */
    }
    process.exit(1);
  };
  process.on("uncaughtException", (err) => crashSave("uncaughtException", err));
  process.on("unhandledRejection", (reason) =>
    crashSave("unhandledRejection", reason),
  );
};

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
