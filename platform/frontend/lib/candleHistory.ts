"use client";
/**
 * One history load per distinct window, however many panes want it.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 *
 * The chart page and the old split pane each ran their own `api.candles(...)`
 * loader. Two panes on the same symbol and resolution therefore pulled the
 * same ten thousand bars twice, and sixteen would have pulled them sixteen
 * times — several megabytes of identical JSON, on every symbol change.
 *
 * Requests are keyed by exactly what makes two loads equivalent: symbol,
 * interval and bar count. An equivalent request that arrives while one is in
 * flight joins it. An equivalent request that arrives shortly after one
 * completes gets the cached array.
 *
 * ── The rules this cache holds itself to ───────────────────────────────────
 *
 *   bounded            an LRU cap, so a session that visits forty symbols does
 *                      not hold forty candle arrays;
 *   no contamination   the key contains the symbol, so a result can never be
 *                      served under another instrument;
 *   no stale liveness  a live bar is merged only into the entry whose symbol
 *                      AND interval it belongs to;
 *   display only       this is the chart's data path. Nothing here feeds the
 *                      backtester, the optimizer or any Research code, and it
 *                      must never become their source of truth.
 */
import { isAbortError } from "./requestGuard";
import type { Candle, Interval } from "./types";

export interface HistoryRequest {
  symbol: string;
  interval: Interval;
  /** History depth. Part of the identity: 2K and 50K are different loads. */
  bars: number;
}

export type HistoryLoader = (
  request: HistoryRequest, signal: AbortSignal
) => Promise<Candle[]>;

export function historyKey(request: HistoryRequest): string {
  return `${request.symbol.toUpperCase()}|${request.interval}|${request.bars}`;
}

interface CacheEntry {
  key: string;
  symbol: string;
  interval: Interval;
  candles: Candle[];
  storedAt: number;
}

interface FlightEntry {
  key: string;
  controller: AbortController;
  promise: Promise<Candle[]>;
  /** Consumers still waiting. At zero the shared request is abandoned. */
  waiters: number;
}

export interface CandleHistoryOptions {
  /** How many distinct windows to retain. Defaults to the pane maximum. */
  maxEntries?: number;
  /** How long a completed load may be reused. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 16;

export class CandleHistoryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly flights = new Map<string, FlightEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private loads = 0;
  private hits = 0;

  constructor(options: CandleHistoryOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Loader invocations that actually reached the network. */
  get loadCount(): number { return this.loads; }
  /** Requests served from a cached or in-flight equivalent. */
  get hitCount(): number { return this.hits; }
  get inFlight(): number { return this.flights.size; }
  get size(): number { return this.entries.size; }

  /**
   * The cached bars for this window, or null.
   *
   * Synchronous, so a pane can paint a symbol it has already seen without a
   * loading placeholder flashing between two charts of the same instrument.
   */
  peek(request: HistoryRequest): Candle[] | null {
    const entry = this.entries.get(historyKey(request));
    if (!entry) return null;
    if (this.now() - entry.storedAt > this.ttlMs) return null;
    return entry.candles;
  }

  /**
   * Load a window, joining any equivalent load already running.
   *
   * `signal` belongs to the *caller*, not to the shared request: aborting it
   * detaches this consumer. The upstream request is only cancelled when the
   * last consumer has detached, so a pane closing mid-load cannot pull the
   * data out from under a pane that is still waiting for it.
   */
  async load(
    request: HistoryRequest, loader: HistoryLoader, signal?: AbortSignal
  ): Promise<Candle[]> {
    const key = historyKey(request);
    const cached = this.peek(request);
    if (cached) { this.hits += 1; return cached; }

    let flight = this.flights.get(key);
    if (flight) {
      this.hits += 1;
    } else {
      const controller = new AbortController();
      this.loads += 1;
      const created: FlightEntry = {
        key, controller, waiters: 0,
        promise: loader(request, controller.signal).then((candles) => {
          this.store(request, candles);
          return candles;
        }).finally(() => {
          if (this.flights.get(key) === created) this.flights.delete(key);
        }),
      };
      this.flights.set(key, created);
      flight = created;
    }

    const joined = flight;
    joined.waiters += 1;
    const detach = (): void => {
      joined.waiters -= 1;
      if (joined.waiters <= 0 && this.flights.get(key) === joined) {
        // Nobody is left waiting for this window. Cancel it rather than
        // finishing a multi-megabyte download into a cache nothing asked for.
        this.flights.delete(key);
        joined.controller.abort();
      }
    };

    if (!signal) {
      try { return await joined.promise; } finally { detach(); }
    }
    try {
      return await new Promise<Candle[]>((resolve, reject) => {
        const onAbort = (): void => reject(abortError());
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
        joined.promise.then(resolve, reject).finally(
          () => signal.removeEventListener("abort", onAbort));
      });
    } finally {
      detach();
    }
  }

  /**
   * Replace a window's bars — used after a backfill has widened the history
   * the loader could return, so the next pane does not repeat the repair.
   */
  store(request: HistoryRequest, candles: Candle[]): void {
    const key = historyKey(request);
    this.entries.delete(key);
    this.entries.set(key, {
      key, symbol: request.symbol.toUpperCase(), interval: request.interval,
      candles, storedAt: this.now(),
    });
    // Insertion order is recency order; the oldest entry is the first key.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Fold a live bar into every cached window for that instrument.
   *
   * Scoped by symbol AND interval: a 1m bar is not news about the 1h window,
   * and writing it there would corrupt a chart that never asked for it.
   */
  applyLiveBar(symbol: string, interval: Interval, bar: Candle): void {
    const upper = symbol.toUpperCase();
    for (const entry of this.entries.values()) {
      if (entry.symbol !== upper || entry.interval !== interval) continue;
      const next = entry.candles.slice();
      const index = next.findIndex((c) => c.openTime === bar.openTime);
      if (index >= 0) next[index] = bar;
      else if (next.length === 0 || bar.openTime > next[next.length - 1]!.openTime) next.push(bar);
      else continue;
      entry.candles = next;
      entry.storedAt = this.now();
    }
  }

  /** Drop one window, or everything. */
  invalidate(request?: HistoryRequest): void {
    if (!request) { this.entries.clear(); return; }
    this.entries.delete(historyKey(request));
  }

  /** Release everything, including any request still running. */
  reset(): void {
    this.entries.clear();
    for (const flight of this.flights.values()) flight.controller.abort();
    this.flights.clear();
    this.loads = 0;
    this.hits = 0;
  }
}

function abortError(): Error {
  const error = new Error("The candle history request was aborted");
  error.name = "AbortError";
  return error;
}

export { isAbortError };

/** The cache the chart workspace uses. One per tab, like the feed registry. */
export const candleHistory = new CandleHistoryCache();
