import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Buffered JSONL logger for whale trades whose decoded `protocolHint` is
 * `UNKNOWN`. Used for offline analysis to identify new DEX program IDs worth
 * adding to the protocol detector.
 *
 * Design constraints:
 *   - Hot-path cost: sync push to in-memory Map (<10μs) — no file I/O.
 *   - Flush runs off the hot path via a rescheduled timer.
 *   - Errors (disk full, permission) are swallowed — never crash the pipeline.
 *   - Dedup by whale-tx signature so one whale tx = one entry regardless of
 *     how many times the decoder is invoked for the same frame.
 *   - Bounded buffer (MAX_BUFFER) to cap memory if flush fails persistently.
 */

export type UnknownProtocolEntry = {
  signature: string;
  token: string;
  wallet: string;
  side: "BUY" | "SELL";
  feedSource: "grpc" | "grpc-pp" | "wss";
  detectedAtMs: number;
  /** All program account keys seen on the whale tx — the signal we're after. */
  programIds: string[];
  /** First few log lines (often carry the DEX name). */
  logsSample: string[];
};

const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER = 500;
const MAX_LOG_LINES_SAMPLED = 12;
const FILE_PATH = path.resolve(process.cwd(), "logs/protocol_unknown.jsonl");

let enabled = true;
let flushTimer: NodeJS.Timeout | null = null;
let dirEnsured = false;
const buffer = new Map<string, UnknownProtocolEntry>();

export function configureUnknownProtocolLog(opts: { enabled: boolean }): void {
  enabled = opts.enabled;
}

export function queueUnknownProtocol(entry: UnknownProtocolEntry): void {
  if (!enabled) return;
  if (buffer.has(entry.signature)) return;
  if (buffer.size >= MAX_BUFFER) return;
  buffer.set(entry.signature, entry);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

async function flush(): Promise<void> {
  if (buffer.size === 0) return;
  const entries = Array.from(buffer.values());
  buffer.clear();
  const payload = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  try {
    if (!dirEnsured) {
      await mkdir(path.dirname(FILE_PATH), { recursive: true });
      dirEnsured = true;
    }
    await appendFile(FILE_PATH, payload, "utf8");
  } catch {
    // Swallow — never crash the pipeline on log I/O failure. Drop this batch
    // to avoid repeatedly retrying a persistent disk error.
  }
}

/** Trim log lines sample to the cap so we don't bloat the JSONL. */
export function sampleLogs(logs: string[]): string[] {
  if (logs.length <= MAX_LOG_LINES_SAMPLED) return logs;
  return logs.slice(0, MAX_LOG_LINES_SAMPLED);
}
