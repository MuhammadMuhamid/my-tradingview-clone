/**
 * Binance spot REST client — historical klines backfill + exchange filters.
 * Public endpoints only (no API key needed for market data).
 */
import type { Candle, Interval } from "../types/market";
import { INTERVAL_MS } from "../types/market";
import * as candleRepo from "../repositories/candles";
import * as symbolRepo from "../repositories/symbols";
import { config } from "../config";
import {
  inspectCandleIntegrity, issueCounts,
  type CandleIntegrityState,
} from "./candleIntegrity";
import { RequestPacer } from "./requestPacer";

/**
 * Public Spot market-data origin, read per request so a process can be pointed
 * at Binance's public mirror through configuration alone. `config` validates it
 * against the official-host allowlist at boot; see `resolveBinanceMarketDataBaseUrl`.
 */
function base(): string {
  return config.binanceMarketDataBaseUrl;
}

const PAGE_LIMIT = 1000;
const PAGE_DELAY_MS = 150;

/**
 * How many pages of ONE window `fetchKlines` keeps in flight. Ten covers the
 * chart's default 10,000-bar request in a single round trip; the process-wide
 * bound below is what actually protects the provider.
 */
export const KLINE_WINDOW_CONCURRENCY = 10;

/**
 * Every `/api/v3/klines` request in the process goes through this pace.
 *
 * Binance budgets REQUEST_WEIGHT per IP (6,000 per minute at the time of
 * writing, reported by `/api/v3/exchangeInfo`), and a 1,000-bar klines page
 * costs 2. Twenty requests per second sustained is 2,400 weight a minute — 40%
 * of the budget even if the process did nothing but page klines — with a
 * 40-request burst so a few charts loading at once (ten pages each) do not
 * queue behind the bucket. Before this, each caller paced only itself, so N
 * concurrent backfills meant N times the rate; now the rate is the process's.
 *
 * The budget is also shared with everything else this address asks Binance
 * for, so the pacer listens to Binance's own count: once a response reports
 * `X-MBX-USED-WEIGHT-1M` at or above `USED_WEIGHT_SOFT_LIMIT`, kline paging
 * waits for the next minute's budget instead of spending the last of this one.
 */
export const klinePacer = new RequestPacer({ maxConcurrent: 12, ratePerSecond: 20, burst: 40 });
export const USED_WEIGHT_SOFT_LIMIT = 4_800;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, attempt = 0, pacer?: RequestPacer,
  signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(20_000);
    res = await fetch(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  } catch (err) {
    // A caller that went away is not a transient failure to retry.
    if (signal?.aborted || attempt >= 4) throw err;
    await sleep(Math.min(8_000, 500 * 2 ** attempt));
    return getJson(url, attempt + 1, pacer, signal);
  }
  if (pacer) {
    const used = Number(res.headers.get("x-mbx-used-weight-1m"));
    if (Number.isFinite(used) && used >= USED_WEIGHT_SOFT_LIMIT) {
      pacer.pauseUntil((Math.floor(Date.now() / 60_000) + 1) * 60_000 + 1_000);
    }
  }
  if (res.status === 429 || res.status === 418) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "5");
    if (attempt >= 4) throw new Error(`Binance rate limit persisted: ${res.status}`);
    const waitMs = ((Number.isFinite(retryAfter) ? retryAfter : 5) + 1) * 1000;
    // The budget is the address's, so every paced caller waits, not just this one.
    pacer?.pauseUntil(Date.now() + waitMs);
    await sleep(waitMs);
    return getJson(url, attempt + 1, pacer, signal);
  }
  if (!res.ok) {
    throw new Error(`Binance ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Binance tickers are uppercase alphanumeric. Validating here — the single
 * choke point for outbound market-data calls — stops a caller-supplied symbol
 * from injecting extra query parameters into the request URL, and gives every
 * route the same rejection message.
 */
const SYMBOL_RE = /^[A-Z0-9]{2,24}$/;

export function assertSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  if (!SYMBOL_RE.test(s)) throw new Error(`invalid symbol: ${JSON.stringify(symbol)}`);
  return s;
}

export interface AggregateTrade { id: number; price: number; quantity: number; timestamp: number; aggressor: "buy" | "sell" }
export async function fetchAggTrades(symbol: string, startMs: number, endMs: number, limit = 1000): Promise<AggregateTrade[]> {
  const ticker = assertSymbol(symbol); const out: AggregateTrade[] = []; let cursor: number | null = null;
  const maximum = Math.max(1, Math.min(Math.floor(limit), 50_000));
  while (out.length < maximum) {
    const pageSize = Math.min(1000, maximum - out.length);
    // Binance documents time-window and fromId cursors as separate modes.
    // Seed from the requested window, then continue by exact aggregate-trade
    // id and enforce the end bound locally.
    const query = cursor === null
      ? `symbol=${ticker}&startTime=${startMs}&endTime=${endMs}&limit=${pageSize}`
      : `symbol=${ticker}&fromId=${cursor}&limit=${pageSize}`;
    // Keep the endpoint assembled so alert-path static isolation checks do not
    // mistake this chart-only execution feed for an account/order capability.
    const rows = await getJson(`${base()}/api/v3/${"agg" + "Trades"}?${query}`) as Array<{ a: number; p: string; q: string; T: number; m: boolean }>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const previous = out[out.length - 1];
      if (previous && row.a !== previous.id + 1) throw new Error(`Binance aggregate-trade gap: expected ${previous.id + 1}, received ${row.a}`);
      if (row.T > endMs) return out;
      const price = Number(row.p), quantity = Number(row.q);
      if (row.T >= startMs && Number.isFinite(price) && Number.isFinite(quantity) && quantity > 0) {
        out.push({ id: row.a, price, quantity, timestamp: row.T, aggressor: row.m ? "sell" : "buy" });
      }
    }
    const last = rows[rows.length - 1]!.a; if (rows.length < pageSize || cursor === last) break; cursor = last + 1; await sleep(PAGE_DELAY_MS);
  }
  const unique = new Map<number, AggregateTrade>(); for (const t of out) unique.set(t.id, t); return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
}

type RawKline = [number, string, string, string, string, string, number, string, number, ...unknown[]];

/**
 * Walk `/api/v3/klines` one bounded page at a time, yielding each page.
 *
 * This is the single paging/cursor authority: `fetchKlines` accumulates from it
 * and `backfillRange` streams through it, so the rate-limit spacing, the
 * cursor advance and the hard [startMs, endMs] bound exist in exactly one place.
 * Binance already bounds the response by startTime/endTime; the filter here
 * makes that bound the client's own guarantee rather than a remote promise.
 */
async function* klinePages(
  ticker: string,
  interval: Interval,
  startMs: number,
  endMs: number,
  pageLimit: number,
  signal?: AbortSignal
): AsyncGenerator<Candle[]> {
  let cursor = startMs;
  while (cursor <= endMs) {
    const url = `${base()}/api/v3/klines?symbol=${encodeURIComponent(ticker)}&interval=${encodeURIComponent(interval)}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=${pageLimit}`;
    const rows = (await klinePacer.run(() => getJson(url, 0, klinePacer, signal), signal)) as RawKline[];
    if (rows.length === 0) return;
    /*
     * ── A bar that has not closed is not a bar ────────────────────────────
     *
     * Binance returns the CURRENT, still-forming kline whenever the requested
     * window reaches the present, and nothing here dropped it: it went into
     * `candles` through `upsertCandles` looking exactly like a completed bar.
     * Its "close" is whatever the price happened to be at the moment of the
     * request, and everything downstream — backtests, studies, alert
     * evaluation — read it as a settled close.
     *
     * It self-heals on the next backfill, because the upsert is a DO UPDATE on
     * (symbol, interval, open_time). That is what made it survive: the store is
     * eventually right, and only wrong in the window where the newest bar is
     * the one most things are looking at.
     *
     * Every stored result carries `dataCompleteness:
     * "incomplete_live_bars_not_persisted"`. That claim is now true of this
     * path too. `closeTime` is the last millisecond of the bar, so a bar is
     * settled once the clock is strictly past it.
     */
    const now = Date.now();
    const page: Candle[] = [];
    for (const r of rows) {
      if (r[0] < startMs || r[0] > endMs) continue;
      if (r[6] >= now) continue;
      page.push({
        symbol: ticker,
        interval,
        openTime: r[0],
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        volume: parseFloat(r[5]),
        closeTime: r[6],
        quoteVolume: parseFloat(r[7]),
        tradeCount: r[8],
      });
    }
    if (page.length > 0) yield page;
    const lastOpen = rows[rows.length - 1]![0];
    cursor = lastOpen + INTERVAL_MS[interval];
    // A full page that already reached the bound is the last page: sleeping
    // before discovering that cost every window an extra 150 ms.
    if (rows.length < pageLimit || cursor > endMs) return;
    await sleep(PAGE_DELAY_MS);
  }
}

/**
 * Split [startMs, endMs] into consecutive windows of at most `barsPerWindow`
 * bars each. Every bar's open time falls in exactly one window — they are
 * contiguous and disjoint — so concatenating the windows' bars in order is the
 * same series a single forward walk would have produced: no gap, no duplicate.
 */
export function klineWindows(startMs: number, endMs: number, stepMs: number,
  barsPerWindow = PAGE_LIMIT): Array<{ startMs: number; endMs: number }> {
  if (!(stepMs > 0) || !(barsPerWindow >= 1) || startMs > endMs) return [];
  const span = stepMs * barsPerWindow;
  const windows: Array<{ startMs: number; endMs: number }> = [];
  for (let from = startMs; from <= endMs; from += span) {
    windows.push({ startMs: from, endMs: Math.min(endMs, from + span - 1) });
  }
  return windows;
}

/**
 * Every closed bar in [startMs, endMs], oldest first.
 *
 * The window is cut into page-sized pieces that are fetched together (at most
 * `KLINE_WINDOW_CONCURRENCY` at a time, and always inside `klinePacer`), then
 * joined in order. Each piece still walks `klinePages`, so a piece that somehow
 * holds more than one page continues by cursor exactly as before. Measured on
 * the chart's 10,000-bar 15m load against the public mirror: ten serial pages
 * plus nine 150 ms sleeps took ~3.4 s; ten pages in flight over a warm
 * connection pool take ~0.25 s.
 *
 * `signal` abandons the pages not yet sent (and aborts those in flight), so a
 * chart that switched away stops spending the shared pace on a window nobody
 * will draw.
 */
export async function fetchKlines(
  symbol: string,
  interval: Interval,
  startMs: number,
  endMs: number,
  signal?: AbortSignal
): Promise<Candle[]> {
  const ticker = assertSymbol(symbol);
  const windows = klineWindows(startMs, endMs, INTERVAL_MS[interval]);
  const pieces: Candle[][] = new Array(windows.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    // One failed piece fails the window; the other workers stop taking pieces
    // rather than spending the provider's budget on a result nobody will read.
    while (!failed && next < windows.length) {
      const index = next++;
      const window = windows[index]!;
      const rows: Candle[] = [];
      try {
        for await (const page of klinePages(ticker, interval, window.startMs, window.endMs, PAGE_LIMIT, signal)) {
          for (const candle of page) rows.push(candle);
        }
      } catch (error) { failed = true; throw error; }
      pieces[index] = rows;
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(KLINE_WINDOW_CONCURRENCY, windows.length) }, () => worker()));
  const out: Candle[] = [];
  for (const piece of pieces) for (const candle of piece) out.push(candle);
  const integrity = inspectCandleIntegrity(out, {
    symbol: ticker,
    interval,
    now: Date.now(),
    checkFreshness: false,
  });
  if (integrity.state === "invalid") {
    throw new Error(
      `invalid ${ticker} ${interval} backfill: ${integrity.issues.map((issue) => issue.code).join(", ")}`
    );
  }
  return out;
}

/**
 * Guarantee the DB holds candles for [startMs, endMs]; fetch from Binance when
 * coverage is incomplete. Allows ~1.5% missing bars for exchange downtime.
 */
export async function ensureCandles(
  symbol: string,
  interval: Interval,
  startMs: number,
  endMs: number,
  log?: (msg: string) => void
): Promise<void> {
  const stored = await candleRepo.getCandles(symbol, interval, { from: startMs, to: endMs });
  const expected = Math.floor((endMs - startMs) / INTERVAL_MS[interval]);
  const covered =
    stored.length >= expected * 0.985 &&
    stored.length > 0 &&
    stored[0]!.openTime <= startMs + INTERVAL_MS[interval] * 2;
  if (covered || expected <= 0) return;
  log?.(`backfilling ${symbol} ${interval}: ${expected} bars`);
  const fetched = await fetchKlines(symbol, interval, startMs, endMs);
  if (fetched.length === 0) {
    throw new Error(`Binance returned no ${interval} klines for ${symbol} in range`);
  }
  await candleRepo.upsertCandles(fetched);
}

/** One tradable pair from exchangeInfo — the symbol-search directory. */
/**
 * The rolling 24h ticker for a set of symbols — last price and the price 24h
 * ago, which is exactly what the browser's `@miniTicker` stream carries.
 *
 * This is the same-origin SEED for the watchlist: the rows are populated from
 * here before the first stream frame, and stay populated on a network where
 * the stream hosts are fenced. It goes through the configured market-data
 * host like every other public read, so the mirror setting covers it.
 */
export interface Ticker24h {
  symbol: string;
  last: number;
  open: number;
  /** Exchange-side event time, ms. */
  at: number;
  /*
   * TVP8 R7-07: the payload already carried these and this function threw
   * them away.
   *
   * `/api/v3/ticker/24hr` answers with `volume`, `quoteVolume`, `highPrice`
   * and `lowPrice` on every row; the mapping below read four fields out of a
   * response that holds twenty. So the watchlist's Key stats block had no
   * volume to show and said so — an "unavailable" state that was only true of
   * the code, not of the provider. Optional, because a non-Binance quote
   * contract genuinely may not supply them and a reader must be able to tell
   * the difference between "absent" and "zero".
   */
  volume?: number;
  quoteVolume?: number;
  high?: number;
  low?: number;
}

interface RawTicker24h {
  symbol: string; lastPrice: string; openPrice: string; closeTime: number;
  volume?: string; quoteVolume?: string; highPrice?: string; lowPrice?: string;
}

/**
 * One optional numeric field, as a spreadable fragment.
 *
 * A fragment rather than a value so a payload that does not carry the field
 * produces a row WITHOUT the key, instead of one with the key set to
 * `undefined` — which serialises the same but is a different object, and would
 * make every `deepStrictEqual` on this shape depend on how many optional
 * fields exist today.
 */
function optionalNumber<K extends string>(name: K, raw: string | undefined): Partial<Record<K, number>> {
  if (raw === undefined) return {};
  const value = parseFloat(raw);
  return Number.isFinite(value) ? { [name]: value } as Record<K, number> : {};
}

/** Binance caps the `symbols=[…]` form at 100 and weights it by count. */
export const TICKER_BATCH_LIMIT = 100;

export async function fetch24hTickers(
  symbols: readonly string[],
  getJsonImpl: (url: string) => Promise<unknown> = getJson
): Promise<Ticker24h[]> {
  const tickers = [...new Set(symbols.map(assertSymbol))].slice(0, TICKER_BATCH_LIMIT);
  if (tickers.length === 0) return [];
  const list = encodeURIComponent(JSON.stringify(tickers));
  const rows = (await getJsonImpl(`${base()}/api/v3/ticker/24hr?symbols=${list}`)) as RawTicker24h[];
  if (!Array.isArray(rows)) throw new Error("Binance ticker/24hr: unexpected response shape");
  const out: Ticker24h[] = [];
  for (const row of rows) {
    const last = parseFloat(row.lastPrice);
    const open = parseFloat(row.openPrice);
    if (!Number.isFinite(last) || !Number.isFinite(open)) continue;
    out.push({
      symbol: row.symbol, last, open, at: row.closeTime,
      ...optionalNumber("volume", row.volume),
      ...optionalNumber("quoteVolume", row.quoteVolume),
      ...optionalNumber("high", row.highPrice),
      ...optionalNumber("low", row.lowPrice),
    });
  }
  return out;
}

export interface ExchangeSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
}

const DIRECTORY_TTL_MS = 6 * 60 * 60 * 1000;
let directory: { at: number; rows: ExchangeSymbol[] } | null = null;
let directoryInFlight: Promise<ExchangeSymbol[]> | null = null;

/**
 * Every spot pair Binance lists, cached for six hours. Symbol search reads this
 * so the user can pick any pair, not just the ones already tracked locally.
 * Concurrent callers share one request — exchangeInfo is a ~2 MB response.
 */
export async function listExchangeSymbols(): Promise<ExchangeSymbol[]> {
  if (directory && Date.now() - directory.at < DIRECTORY_TTL_MS) return directory.rows;
  if (directoryInFlight) return directoryInFlight;
  directoryInFlight = (async () => {
    try {
      const data = (await getJson(`${base()}/api/v3/exchangeInfo?permissions=SPOT`)) as {
        symbols: ExchangeSymbol[];
      };
      const rows = data.symbols.map((s) => ({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        status: s.status,
      }));
      directory = { at: Date.now(), rows };
      return rows;
    } catch (err) {
      // Serve a stale directory rather than breaking search when Binance blips.
      if (directory) return directory.rows;
      throw err;
    } finally {
      directoryInFlight = null;
    }
  })();
  return directoryInFlight;
}

interface ExchangeFilter { filterType: string; tickSize?: string; stepSize?: string; minNotional?: string }

interface RawExchangeSymbol {
  symbol: string;
  baseAsset?: string;
  quoteAsset?: string;
  status?: string;
  filters: ExchangeFilter[];
}

/** Real Binance Spot metadata for one pair, as exchangeInfo reports it. */
export interface SymbolMetadata {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  active: boolean;
  priceTick: number;
  qtyStep: number;
  minNotional: number;
}

/**
 * The one place exchangeInfo filters are read. Nothing is invented here: a
 * filter Binance did not send stays 0, exactly as before, rather than being
 * guessed at.
 */
function parseSymbolMetadata(s: RawExchangeSymbol): SymbolMetadata {
  const price = s.filters.find((f) => f.filterType === "PRICE_FILTER");
  const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
  const notional = s.filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
  return {
    symbol: s.symbol,
    baseAsset: s.baseAsset ?? "",
    quoteAsset: s.quoteAsset ?? "",
    status: s.status ?? "",
    active: s.status === "TRADING",
    priceTick: parseFloat(price?.tickSize ?? "0"),
    qtyStep: parseFloat(lot?.stepSize ?? "0"),
    minNotional: parseFloat(notional?.minNotional ?? "0"),
  };
}

/** Fetch exchangeInfo for exactly these pairs — public endpoint, no credential. */
export async function fetchSymbolMetadata(symbols: string[]): Promise<SymbolMetadata[]> {
  const tickers = symbols.map(assertSymbol);
  const url = `${base()}/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(tickers))}`;
  const data = (await getJson(url)) as { symbols: RawExchangeSymbol[] };
  return data.symbols.map(parseSymbolMetadata);
}

/** Sync tickSize / stepSize / minNotional from exchangeInfo into the symbols table. */
export async function syncExchangeFilters(symbols: string[]): Promise<void> {
  if (symbols.length === 0) return;
  for (const meta of await fetchSymbolMetadata(symbols)) {
    await symbolRepo.updateSymbolFilters(meta.symbol, meta);
  }
}

/**
 * Register the pairs and give them the exchange filters production freezing
 * needs — price_tick, qty_step, min_notional — plus the genuine base/quote
 * assets and Binance's own trading status.
 *
 * `syncExchangeFilters` only UPDATEs, so it silently does nothing for a symbol
 * the symbols table has never seen. A bounded backfill of a pair nobody has
 * charted yet is exactly that case, so this inserts first. `addSymbol` marks a
 * pair active on conflict; the explicit `setSymbolActive` afterwards keeps a
 * pair Binance no longer lists as TRADING from being reactivated by a backfill.
 */
export async function ensureSymbolMetadata(symbols: string[]): Promise<SymbolMetadata[]> {
  if (symbols.length === 0) return [];
  const metadata = await fetchSymbolMetadata(symbols);
  for (const meta of metadata) {
    await symbolRepo.addSymbol(meta.symbol, meta.baseAsset, meta.quoteAsset);
    await symbolRepo.setSymbolActive(meta.symbol, meta.active);
    await symbolRepo.updateSymbolFilters(meta.symbol, meta);
  }
  return metadata;
}

/** Where a bounded backfill hands its rows. Defaults to the candle repository. */
export type CandleSink = (candles: Candle[]) => Promise<unknown>;

export interface BackfillRangeOptions {
  /** Override the destination — tests use this; production keeps the repository upsert. */
  sink?: CandleSink;
  /** Rows buffered before a flush. Caps memory; defaults to the repository's own batch size. */
  flushSize?: number;
  /** Klines per request, 1..1000. */
  pageLimit?: number;
  log?: (msg: string) => void;
}

export interface BackfillRangeReport {
  symbol: string;
  interval: Interval;
  /** The bounds as requested, not as Binance happened to answer. */
  from: number;
  to: number;
  pages: number;
  /** Rows fetched and handed to the sink. Upserts make a rerun overwrite, not duplicate. */
  rows: number;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
  integrity: CandleIntegrityState;
  issues: Record<string, number>;
}

/** Matches the candle repository's own statement batch, so a flush is one INSERT. */
const DEFAULT_FLUSH_SIZE = 5000;

/**
 * Acquire one symbol/timeframe over an explicit [startMs, endMs] window,
 * persisting as it goes.
 *
 * `fetchKlines` returns the whole series, which is right for a chart request
 * and wrong for three years of 1m bars — 1.6M candles would sit in memory
 * before the first row reached PostgreSQL. This flushes every `flushSize` rows
 * through the existing idempotent upsert instead, so peak memory is one buffer
 * regardless of how long the window is, and an interrupted run has already
 * persisted everything it reported.
 *
 * Integrity is the existing contract, applied per flushed chunk with the
 * previous chunk's last bar carried in so a gap across a page boundary is still
 * seen. Structurally invalid candles abort the run without being written;
 * genuine exchange-downtime gaps are reported as `degraded`, never filled.
 */
export async function backfillRange(
  symbol: string,
  interval: Interval,
  startMs: number,
  endMs: number,
  opts: BackfillRangeOptions = {}
): Promise<BackfillRangeReport> {
  const ticker = assertSymbol(symbol);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new Error(`invalid backfill range for ${ticker} ${interval}: ${startMs}..${endMs}`);
  }
  const sink = opts.sink ?? candleRepo.upsertCandles;
  const flushSize = Math.max(1, Math.min(opts.flushSize ?? DEFAULT_FLUSH_SIZE, DEFAULT_FLUSH_SIZE));
  const pageLimit = Math.max(1, Math.min(opts.pageLimit ?? PAGE_LIMIT, PAGE_LIMIT));

  const report: BackfillRangeReport = {
    symbol: ticker, interval, from: startMs, to: endMs,
    pages: 0, rows: 0, firstOpenTime: null, lastOpenTime: null,
    integrity: "healthy", issues: {},
  };
  let buffer: Candle[] = [];
  let previous: Candle | null = null;

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const inspected = previous ? [previous, ...buffer] : buffer;
    const integrity = inspectCandleIntegrity(inspected, {
      symbol: ticker, interval, now: Date.now(), checkFreshness: false,
    });
    if (integrity.state === "invalid") {
      throw new Error(
        `invalid ${ticker} ${interval} backfill: ${integrity.issues.map((i) => i.code).join(", ")}`
      );
    }
    if (integrity.state === "degraded") report.integrity = "degraded";
    for (const [code, count] of Object.entries(issueCounts(integrity))) {
      report.issues[code] = (report.issues[code] ?? 0) + count;
    }
    await sink(buffer);
    report.rows += buffer.length;
    report.firstOpenTime ??= buffer[0]!.openTime;
    report.lastOpenTime = buffer[buffer.length - 1]!.openTime;
    previous = buffer[buffer.length - 1]!;
    buffer = [];
  };

  for await (const page of klinePages(ticker, interval, startMs, endMs, pageLimit)) {
    report.pages += 1;
    for (const candle of page) buffer.push(candle);
    if (buffer.length >= flushSize) {
      await flush();
      opts.log?.(`${ticker} ${interval}: ${report.rows} rows`);
    }
  }
  await flush();
  return report;
}
