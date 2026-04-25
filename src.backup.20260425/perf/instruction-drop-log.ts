import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Buffered JSONL logger for whale tx that the instruction decoder failed to
 * recognise. Mirrors `unknown-protocol-log.ts` design but stores the full
 * instruction breakdown (program ids + first 16 bytes of data per ix) so the
 * operator can inspect offline and decide which discriminators to add.
 *
 * Hot-path safe: sync push to in-memory Map, flush via timer off the path.
 * Errors swallowed. Bounded buffer caps memory if disk write fails.
 */

export type InstructionDropEntry = {
  signature: string;
  whale: string;
  reason: string;
  detectedAtMs: number;
  versioned: boolean;
  altCount: number;
  /** Full account key list (resolved staticKeys + ALT writable + readonly). */
  accountKeys: string[];
  /** Top-level instructions: program id + first 16 bytes of data hex + ix.accountIndices. */
  instructions: Array<{
    programId: string;
    discriminatorHex: string;
    accountIndices: number[];
    dataLen: number;
  }>;
};

const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER = 500;
const FILE_PATH = path.resolve(process.cwd(), "logs/instruction_drop.jsonl");

let enabled = true;
let flushTimer: NodeJS.Timeout | null = null;
let dirEnsured = false;
const buffer = new Map<string, InstructionDropEntry>();

export const configureInstructionDropLog = (opts: {
  enabled: boolean;
}): void => {
  enabled = opts.enabled;
};

export const queueInstructionDrop = (entry: InstructionDropEntry): void => {
  if (!enabled) return;
  if (buffer.has(entry.signature)) return;
  if (buffer.size >= MAX_BUFFER) return;
  buffer.set(entry.signature, entry);
  if (flushTimer == null) {
    flushTimer = setTimeout(() => void flushBuffer(), FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
};

const flushBuffer = async (): Promise<void> => {
  flushTimer = null;
  if (buffer.size === 0) return;
  const entries = Array.from(buffer.values());
  buffer.clear();

  if (!dirEnsured) {
    try {
      await mkdir(path.dirname(FILE_PATH), { recursive: true });
      dirEnsured = true;
    } catch {
      // ignore
    }
  }

  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  try {
    await appendFile(FILE_PATH, lines, "utf8");
  } catch {
    // disk full / permission — drop the batch, never crash the pipeline
  }
};

/** For tests / shutdown. */
export const flushInstructionDropsNow = async (): Promise<void> => {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushBuffer();
};
