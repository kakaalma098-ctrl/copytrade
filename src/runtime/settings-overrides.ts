import { promises as fs, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../types/index.js";

/**
 * Runtime-mutable trading knobs, override-on-top-of-.env.
 * UI changes write here (atomic tmp+rename); the helper below then mutates
 * the live `AppConfig` reference in place so every hot-path read sees the
 * new value immediately. Restarts reload the saved file and re-apply.
 */
export type RuntimeSettings = {
  slippageBps?: number;
  fixedBuyAmountSol?: number;
  minWhaleBuyAmountSol?: number;
  rebuyEnabled?: boolean;
  rebuyMaxCount?: number;
  rebuyAmountSize?: number;
  followWhaleSell?: boolean;
  autoSellTtlMs?: number;
  updatedAtMs?: number;
};

type Persisted = {
  version: 1;
  settings: RuntimeSettings;
};

let current: RuntimeSettings = {};
let filePath: string | null = null;

export const initRuntimeSettings = async (
  file: string,
): Promise<RuntimeSettings> => {
  filePath = path.resolve(file);
  try {
    const data = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(data) as Partial<Persisted>;
    if (parsed?.settings && typeof parsed.settings === "object") {
      current = { ...parsed.settings };
    }
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      console.warn(
        `[settings] load failed — starting empty: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { ...current };
};

export const getRuntimeSettings = (): RuntimeSettings => ({ ...current });

export const updateRuntimeSettings = async (
  patch: RuntimeSettings,
): Promise<RuntimeSettings> => {
  current = { ...current, ...sanitize(patch), updatedAtMs: Date.now() };
  if (filePath != null) {
    await saveAtomic(filePath, current);
  }
  return { ...current };
};

/**
 * Mutate the live AppConfig so every hot-path read (engine, jupiter,
 * processor, listener) picks up override values immediately — no restart.
 * Called at startup AFTER initRuntimeSettings, and from the control server
 * after every successful /api/settings write.
 */
export const applyRuntimeOverridesToConfig = (config: AppConfig): void => {
  const s = current;
  if (typeof s.slippageBps === "number") {
    config.trading.slippageBps = s.slippageBps;
  }
  if (typeof s.fixedBuyAmountSol === "number") {
    config.trading.fixedBuyAmountSol = s.fixedBuyAmountSol;
  }
  if (typeof s.minWhaleBuyAmountSol === "number") {
    config.trading.minWhaleBuyAmountSol = s.minWhaleBuyAmountSol;
  }
  if (typeof s.rebuyEnabled === "boolean") {
    config.trading.rebuyEnabled = s.rebuyEnabled;
  }
  if (typeof s.rebuyMaxCount === "number") {
    config.trading.rebuyMaxCount = s.rebuyMaxCount;
  }
  if (typeof s.rebuyAmountSize === "number") {
    config.trading.rebuyAmountSize = s.rebuyAmountSize;
  }
  if (typeof s.followWhaleSell === "boolean") {
    config.trading.followWhaleSell = s.followWhaleSell;
  }
  if (typeof s.autoSellTtlMs === "number") {
    config.trading.autoSellTtlMs = s.autoSellTtlMs;
  }
};

/**
 * Sync save for crash handlers. Use sparingly — normal path is async.
 */
export const saveRuntimeSettingsSync = (): void => {
  if (filePath == null) return;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    const body = JSON.stringify(
      { version: 1, settings: current } satisfies Persisted,
      null,
      2,
    );
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, filePath);
  } catch {
    /* best-effort */
  }
};

const sanitize = (patch: RuntimeSettings): RuntimeSettings => {
  const out: RuntimeSettings = {};
  if (typeof patch.slippageBps === "number" && patch.slippageBps >= 0) {
    out.slippageBps = Math.floor(patch.slippageBps);
  }
  if (
    typeof patch.fixedBuyAmountSol === "number" &&
    patch.fixedBuyAmountSol > 0
  ) {
    out.fixedBuyAmountSol = patch.fixedBuyAmountSol;
  }
  if (
    typeof patch.minWhaleBuyAmountSol === "number" &&
    patch.minWhaleBuyAmountSol >= 0
  ) {
    out.minWhaleBuyAmountSol = patch.minWhaleBuyAmountSol;
  }
  if (typeof patch.rebuyEnabled === "boolean") {
    out.rebuyEnabled = patch.rebuyEnabled;
  }
  if (
    typeof patch.rebuyMaxCount === "number" &&
    patch.rebuyMaxCount >= 1 &&
    Number.isFinite(patch.rebuyMaxCount)
  ) {
    out.rebuyMaxCount = Math.floor(patch.rebuyMaxCount);
  }
  if (
    typeof patch.rebuyAmountSize === "number" &&
    patch.rebuyAmountSize >= 0 &&
    Number.isFinite(patch.rebuyAmountSize)
  ) {
    out.rebuyAmountSize = patch.rebuyAmountSize;
  }
  if (typeof patch.followWhaleSell === "boolean") {
    out.followWhaleSell = patch.followWhaleSell;
  }
  if (typeof patch.autoSellTtlMs === "number" && patch.autoSellTtlMs >= 0) {
    out.autoSellTtlMs = Math.floor(patch.autoSellTtlMs);
  }
  return out;
};

const saveAtomic = async (
  file: string,
  settings: RuntimeSettings,
): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const body = JSON.stringify(
    { version: 1, settings } satisfies Persisted,
    null,
    2,
  );
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, file);
};
