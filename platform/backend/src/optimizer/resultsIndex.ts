/**
 * Bounded, off-the-request-path access to optimizer result streams.
 *
 * Finding `BE-24`: the leaderboard handler counted every line of every
 * `results/*.jsonl` synchronously and then wrote `index/raw_counts.json` — a
 * multi-gigabyte synchronous read and a state-changing write inside a GET, on
 * the same event loop that dispatches live trading signals.
 *
 * Two rules here:
 *   1. Request handlers never scan and never write. They read whatever the
 *      background refresher has already computed and say so honestly when it
 *      has not finished yet.
 *   2. Every scan is asynchronous and chunked, so the event loop stays free,
 *      and every scan is bounded in bytes and in memory.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { OptimizerTree } from "./registry";
import { treeResults } from "./registry";

const CHUNK = 4 * 1024 * 1024;
/** Newest-first bytes a single ranked scan will read before giving up. */
const DEFAULT_MAX_SCAN_BYTES = 2 * 1024 * 1024 * 1024;
/** How long a computed count set is served before a refresh is scheduled. */
const COUNT_TTL_MS = Number(process.env.OPTIMIZER_COUNT_TTL_MS ?? 60_000);

export type CountState = "ready" | "pending" | "unavailable";

export interface CountSnapshot {
  state: CountState;
  /** symbol → number of recorded evaluations. Empty while `pending`. */
  counts: Record<string, number>;
  total: number;
  computedAt: string | null;
}

interface CacheEntry { size: number; count: number }

const snapshots = new Map<string, CountSnapshot>();
const inFlight = new Map<string, Promise<void>>();

function cacheFile(tree: OptimizerTree): string {
  return path.join(tree.dir, "index", "raw_counts.json");
}

function readCache(file: string): Record<string, CacheEntry> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

/** Count newlines added since the cached size. Async and chunked throughout. */
async function countFile(full: string, prior: CacheEntry): Promise<CacheEntry> {
  const stat = await fsp.stat(full);
  const size = stat.size;
  // A shrunken file was rotated or rewritten; the cached count no longer
  // describes it, so start again rather than reporting a stale total.
  let offset = size < prior.size ? 0 : prior.size;
  let count = size < prior.size ? 0 : prior.count;
  if (size <= offset) return { size, count };
  const fh = await fsp.open(full, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    while (offset < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - offset), offset);
      if (!bytesRead) break;
      for (let i = 0; i < bytesRead; i += 1) if (buf[i] === 10) count += 1;
      offset += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return { size, count };
}

/**
 * Recompute one tree's counts and persist the incremental cache. This is the
 * only writer, and it never runs inside a request handler.
 */
export async function refreshCounts(tree: OptimizerTree): Promise<CountSnapshot> {
  const { resultFiles } = treeResults(tree);
  const file = cacheFile(tree);
  const cache = readCache(file);
  const next: Record<string, CacheEntry> = {};
  for (const name of resultFiles) {
    next[name] = await countFile(path.join(tree.dir, "results", name), cache[name] ?? { size: 0, count: 0 });
  }
  const counts = Object.fromEntries(
    Object.entries(next).map(([name, entry]) => [name.slice(0, -6), entry.count])
  );
  const snapshot: CountSnapshot = {
    state: "ready",
    counts,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    computedAt: new Date().toISOString(),
  };
  snapshots.set(tree.id, snapshot);
  if (resultFiles.length > 0) {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(next));
      await fsp.rename(tmp, file);
    } catch {
      // A read-only mount is not a reason to fail the request that triggered
      // this; the in-memory snapshot is still correct for this process.
    }
  }
  return snapshot;
}

function scheduleRefresh(tree: OptimizerTree): void {
  if (inFlight.has(tree.id)) return;
  const task: Promise<void> = refreshCounts(tree)
    .then(() => undefined)
    .catch(() => {
      snapshots.set(tree.id, { state: "unavailable", counts: {}, total: 0, computedAt: null });
    })
    .finally(() => { inFlight.delete(tree.id); });
  inFlight.set(tree.id, task);
}

/**
 * The counts a handler may serve right now. Never scans inline: a cold or
 * stale tree gets a background refresh and the caller is told the number is
 * still being computed.
 */
export function countsFor(tree: OptimizerTree): CountSnapshot {
  const have = snapshots.get(tree.id);
  const stale = !have
    || have.state !== "ready"
    || Date.now() - Date.parse(have.computedAt ?? "0") > COUNT_TTL_MS;
  if (stale) scheduleRefresh(tree);
  return have ?? { state: "pending", counts: {}, total: 0, computedAt: null };
}

/** Test seam: wait for any refresh this process has scheduled. */
export async function settleCounts(): Promise<void> {
  await Promise.all([...inFlight.values()]);
}

export interface RankedRecord {
  ts?: string;
  symbol?: string;
  genome?: number[];
  params?: Record<string, unknown>;
  metrics?: Record<string, number | null>;
  score: number | null;
}

export interface RankedScan {
  records: RankedRecord[];
  /** Distinct genomes seen, capped at `topK` retained records. */
  scanned: number;
  /** True when the byte budget stopped the scan before the end of the file. */
  truncated: boolean;
  bytes: number;
}

/**
 * Read a coin's result stream and return the best `topK` distinct genomes.
 *
 * Chunked and asynchronous so a multi-gigabyte stream never blocks the event
 * loop, and bounded in memory: only `topK` records and their genome keys are
 * retained, however long the file is.
 */
export async function scanRanked(
  file: string,
  opts: { topK?: number; maxBytes?: number } = {}
): Promise<RankedScan> {
  const topK = Math.max(1, opts.topK ?? 1000);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_SCAN_BYTES;
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(file, "r");
  } catch {
    return { records: [], scanned: 0, truncated: false, bytes: 0 };
  }
  const kept = new Map<string, RankedRecord>();
  let scanned = 0;
  let bytes = 0;
  let truncated = false;
  let carry = "";

  const take = (line: string): void => {
    if (!line.trim()) return;
    let rec: RankedRecord;
    try {
      rec = JSON.parse(line) as RankedRecord;
    } catch {
      return;
    }
    if (rec.score === null || rec.score === undefined) return;
    const key = (rec.genome ?? []).join(",");
    if (kept.has(key)) return;
    scanned += 1;
    kept.set(key, rec);
    // Bounded memory: once past the retention limit, evict the weakest record
    // so the map never grows with the file.
    if (kept.size > topK) {
      let worstKey: string | null = null;
      let worstScore = Infinity;
      for (const [k, v] of kept) {
        const s = v.score ?? -Infinity;
        if (s < worstScore) { worstScore = s; worstKey = k; }
      }
      if (worstKey !== null) kept.delete(worstKey);
    }
  };

  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
      const text = carry + buf.toString("utf8", 0, bytesRead);
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) take(line);
      if (bytes >= maxBytes) { truncated = true; break; }
    }
    if (!truncated && carry) take(carry);
  } finally {
    await fh.close();
  }
  const records = [...kept.values()].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  return { records, scanned, truncated, bytes };
}
