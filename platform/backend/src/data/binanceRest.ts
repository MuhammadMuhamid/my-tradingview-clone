/**
 * Binance spot REST client — historical klines backfill + exchange filters.
 * Public endpoints only (no API key needed for market data).
 */
import type { Candle, Interval } from "../types/market";
import { INTERVAL_MS } from "../types/market";
import * as candleRepo from "../repositories/candles";
import * as symbolRepo from "../repositories/symbols";

const BASE = "https://api.binance.com";
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

export async function fetchKlines(
  symbol: string,
  interval: Interval,
  startMs: number,
  endMs: number
): Promise<Candle[]> {
  const out: Candle[] = [];
  const ticker = assertSymbol(symbol);
  let cursor = startMs;
  while (cursor <= endMs) {
    const url = `${BASE}/api/v3/klines?symbol=${encodeURIComponent(ticker)}&interval=${encodeURIComponent(interval)}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=${PAGE_LIMIT}`;
    const rows = (await getJson(url)) as RawKline[];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        symbol,
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
    const lastOpen = rows[rows.length - 1]![0];
    cursor = lastOpen + INTERVAL_MS[interval];
    if (rows.length < PAGE_LIMIT) break;
    await sleep(PAGE_DELAY_MS);
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
      const data = (await getJson(`${BASE}/api/v3/exchangeInfo?permissions=SPOT`)) as {
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

/** Sync tickSize / stepSize / minNotional from exchangeInfo into the symbols table. */
export async function syncExchangeFilters(symbols: string[]): Promise<void> {
  if (symbols.length === 0) return;
  const tickers = symbols.map(assertSymbol);
  const url = `${BASE}/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(tickers))}`;
  const data = (await getJson(url)) as {
    symbols: { symbol: string; filters: ExchangeFilter[] }[];
  };
  for (const s of data.symbols) {
    const price = s.filters.find((f) => f.filterType === "PRICE_FILTER");
    const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
    const notional = s.filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
    await symbolRepo.updateSymbolFilters(s.symbol, {
      priceTick: parseFloat(price?.tickSize ?? "0"),
      qtyStep: parseFloat(lot?.stepSize ?? "0"),
      minNotional: parseFloat(notional?.minNotional ?? "0"),
    });
  }
}
