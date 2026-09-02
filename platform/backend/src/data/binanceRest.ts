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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, attempt = 0): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(Math.min(8_000, 500 * 2 ** attempt));
    return getJson(url, attempt + 1);
  }
  if (res.status === 429 || res.status === 418) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "5");
    if (attempt >= 4) throw new Error(`Binance rate limit persisted: ${res.status}`);
    await sleep((retryAfter + 1) * 1000);
    return getJson(url, attempt + 1);
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
  pageLimit: number
): AsyncGenerator<Candle[]> {
  let cursor = startMs;
  while (cursor <= endMs) {
    const url = `${base()}/api/v3/klines?symbol=${encodeURIComponent(ticker)}&interval=${encodeURIComponent(interval)}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=${pageLimit}`;
    const rows = (await getJson(url)) as RawKline[];
    if (rows.length === 0) return;
    const page: Candle[] = [];
    for (const r of rows) {
      if (r[0] < startMs || r[0] > endMs) continue;
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
    if (rows.length < pageLimit) return;
    await sleep(PAGE_DELAY_MS);
  }
}

export async function fetchKlines(
  symbol: string,
  interval: Interval,
  startMs: number,
  endMs: number
): Promise<Candle[]> {
  const out: Candle[] = [];
  const ticker = assertSymbol(symbol);
  for await (const page of klinePages(ticker, interval, startMs, endMs, PAGE_LIMIT)) {
    for (const candle of page) out.push(candle);
  }
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
