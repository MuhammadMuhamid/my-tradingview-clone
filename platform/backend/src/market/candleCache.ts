/**
 * Provider candle history, held in process between chart requests.
 *
 * B-08: every 10,000-bar chart load went to the provider in full — cold or
 * warm, the same ten pages — so a symbol or interval switch sat ~3.4 s before
 * its first byte and the legend and studies said "Loading…" for ~4.3 s. Closed
 * bars do not change, so asking for them again on every switch bought nothing.
 *
 * ── What one entry knows ────────────────────────────────────────────────────
 *
 * One entry per (venue, provider, provider symbol, provider interval). It holds
 * `rows`: EVERY bar with an open time in [fromMs, toMs] that had closed by
 * `probedAt`, oldest first, unique. Only closed bars are ever stored — a bar is
 * closed once `openTime + step <= t` — so the still-forming bar can never be
 * frozen into the cache, whatever an adapter returns.
 *
 * Window size (`limit`) and end (`to`) are not part of the key; they are ranges
 * over it. A request is answered from the entry only where the entry provably
 * covers it, and only the parts it does not cover go to the provider:
 *
 *   head  [startMs, fromMs)         — older than anything held;
 *   tail  (last held bar, endMs]    — what may have closed since `probedAt`.
 *
 * The tail is skipped only when NOTHING can have closed since `probedAt`: the
 * adapter declares it never returns a forming bar (`closedBarsOnly`), and no
 * bar boundary — a multiple of the step on the UTC epoch grid — lies in
 * (probedAt, now]. Every other case fetches the tail, which is one small page,
 * so an adapter that does return the forming bar still has it fresh on every
 * request. The served window is therefore exactly what a full fetch at the same
 * moment would return: no gap, no duplicate, no foreign bar.
 *
 * ── Bounds ───────────────────────────────────────────────────────────────────
 *
 * An entry is discarded `maxAgeMs` after it was first filled, so nothing lives
 * long enough to drift from the venue; at most `maxSeries` entries and
 * `maxBars` bars are held, least recently used out first; and a single request
 * wider than `maxBarsPerRequest` (a deep backtest range) bypasses the cache
 * entirely rather than evicting every chart's history to make room for itself.
 * Requests for one key are serialised, so a burst of switches — or two panes on
 * the same symbol — costs one provider fetch, not one each.
 */
import type { Candle, Interval } from "../types/market";

export type CandleCacheOutcome = "hit" | "partial" | "miss" | "bypass";

export interface CandleCacheRequest {
  venueId: string;
  providerId: string;
  providerSymbol: string;
  interval: Interval;
  stepMs: number;
  startMs: number;
  endMs: number;
  /** The adapter never returns a bar that has not closed. */
  closedBarsOnly: boolean;
  /** Fetch every bar the provider has in [startMs, endMs]. */
  fetch(startMs: number, endMs: number): Promise<Candle[]>;
}

export interface CandleCacheResult {
  rows: Candle[];
  outcome: CandleCacheOutcome;
  /** Provider fetches this request made, as [startMs, endMs] ranges. */
  fetched: Array<[number, number]>;
}

export interface CandleCacheOptions {
  now?: () => number;
  maxAgeMs?: number;
  maxSeries?: number;
  maxBars?: number;
  maxBarsPerRequest?: number;
}

interface Entry {
  rows: Candle[];
  fromMs: number;
  toMs: number;
  probedAt: number;
  createdAt: number;
}

export function candleCacheKey(request: Pick<CandleCacheRequest,
  "venueId" | "providerId" | "providerSymbol" | "interval">): string {
  return [request.venueId.toUpperCase(), request.providerId.toLowerCase(),
    request.providerSymbol, request.interval].join("|");
}

/** Bars of `rows` inside [startMs, endMs], keeping order. */
function within(rows: readonly Candle[], startMs: number, endMs: number): Candle[] {
  return rows.filter((row) => row.openTime >= startMs && row.openTime <= endMs);
}

/** Sorted, unique by open time; a later list wins a collision. */
function merge(...lists: ReadonlyArray<readonly Candle[]>): Candle[] {
  const byOpen = new Map<number, Candle>();
  for (const list of lists) for (const row of list) byOpen.set(row.openTime, row);
  return [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
}

export class ProviderCandleCache {
  private readonly entries = new Map<string, Entry>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly maxSeries: number;
  private readonly maxBars: number;
  private readonly maxBarsPerRequest: number;

  constructor(options: CandleCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
    this.maxSeries = options.maxSeries ?? 48;
    this.maxBars = options.maxBars ?? 400_000;
    this.maxBarsPerRequest = options.maxBarsPerRequest ?? 50_000;
  }

  /** Number of series held — exposed for tests and diagnostics. */
  get size(): number { return this.entries.size; }

  get totalBars(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.rows.length;
    return total;
  }

  clear(): void { this.entries.clear(); }

  async read(request: CandleCacheRequest): Promise<CandleCacheResult> {
    const key = candleCacheKey(request);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.readLocked(key, request));
    this.locks.set(key, run);
    try { return await run; }
    finally { if (this.locks.get(key) === run) this.locks.delete(key); }
  }

  private closedBy(rows: readonly Candle[], at: number, stepMs: number): Candle[] {
    return rows.filter((row) => row.openTime + stepMs <= at);
  }

  private async readLocked(key: string, request: CandleCacheRequest): Promise<CandleCacheResult> {
    const { startMs, endMs, stepMs } = request;
    if (!(stepMs > 0) || !(startMs <= endMs)) {
      return { rows: await request.fetch(startMs, endMs), outcome: "bypass", fetched: [[startMs, endMs]] };
    }
    if ((endMs - startMs) / stepMs + 1 > this.maxBarsPerRequest) {
      return { rows: await request.fetch(startMs, endMs), outcome: "bypass", fetched: [[startMs, endMs]] };
    }
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry && now - entry.createdAt >= this.maxAgeMs) {
      this.entries.delete(key);
      entry = undefined;
    }
    const disjoint = entry !== undefined && (startMs > entry.toMs || endMs < entry.fromMs);
    if (!entry || entry.rows.length === 0 || disjoint) {
      const probedAt = now;
      const rows = await request.fetch(startMs, endMs);
      // A disjoint OLDER window (a past backtest range) must not evict the
      // chart's live history; a disjoint newer one supersedes it.
      if (!disjoint || endMs >= entry!.toMs) {
        this.store(key, { rows: this.closedBy(within(rows, startMs, endMs), probedAt, stepMs),
          fromMs: startMs, toMs: endMs, probedAt, createdAt: probedAt });
      }
      return { rows, outcome: "miss", fetched: [[startMs, endMs]] };
    }

    const fetched: Array<[number, number]> = [];
    const last = entry.rows[entry.rows.length - 1]!;
    const unknownFrom = last.openTime + 1;
    const crossed = Math.floor(now / stepMs) > Math.floor(entry.probedAt / stepMs);
    // Bars past `toMs` that had already closed when the entry was probed —
    // only possible when the entry was filled for an explicit past `to`.
    const pastBeyondCoverage = endMs > entry.toMs && entry.toMs < entry.probedAt - stepMs;
    const needTail = endMs >= unknownFrom &&
      (!request.closedBarsOnly || crossed || pastBeyondCoverage);
    const needHead = startMs < entry.fromMs;

    const probedAt = now;
    const [head, tail] = await Promise.all([
      needHead ? request.fetch(startMs, entry.fromMs - 1) : Promise.resolve<Candle[]>([]),
      needTail ? request.fetch(unknownFrom, endMs) : Promise.resolve<Candle[]>([]),
    ]);
    if (needHead) fetched.push([startMs, entry.fromMs - 1]);
    if (needTail) fetched.push([unknownFrom, endMs]);

    // The served window: what is held, plus everything fetched — the fresh
    // tail wins any collision, and may include a forming bar the cache never
    // stores.
    const headRows = needHead ? within(head, startMs, entry.fromMs - 1) : [];
    const tailRows = needTail ? within(tail, unknownFrom, endMs) : [];
    const rows = within(merge(headRows, entry.rows, tailRows), startMs, endMs);

    // Reads of one key are serialised, so nothing replaced `entry` while the
    // fetches ran and it is safe to extend in place of a re-read.
    const next: Entry = {
      rows: merge(this.closedBy(headRows, probedAt, stepMs), entry.rows, this.closedBy(tailRows, probedAt, stepMs)),
      fromMs: Math.min(entry.fromMs, startMs),
      toMs: Math.max(entry.toMs, endMs),
      // Advancing `probedAt` is only sound when the tail was re-read from the
      // first bar that could have closed since; otherwise the old one stands.
      probedAt: needTail ? probedAt : entry.probedAt,
      createdAt: entry.createdAt,
    };
    this.store(key, next);
    return { rows, outcome: needHead || needTail ? "partial" : "hit", fetched };
  }

  private store(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    let total = this.totalBars;
    for (const [oldest, value] of this.entries) {
      if (this.entries.size <= this.maxSeries && total <= this.maxBars) break;
      if (oldest === key && this.entries.size === 1) break;
      this.entries.delete(oldest);
      total -= value.rows.length;
    }
  }
}
