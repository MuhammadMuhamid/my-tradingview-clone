import { INTERVAL_MS, type Candle, type Interval } from "../types/market";
import type { NormalizedSpotTicker } from "./officialSpotAdapters";
import { ProviderHttpError, withProviderRetry } from "./retry";

export type SpotStreamKind = "ticker" | "candle";

export interface SpotStreamRequest {
  origins: readonly string[];
  path: string;
  subscribeMessage: string | null;
  requiresBootstrapToken: boolean;
}

export type SpotStreamEvent =
  | { kind: "ticker"; ticker: NormalizedSpotTicker }
  | { kind: "candle"; candle: Candle; closed: boolean };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const number = (value: unknown): number => Number(value);
const text = (value: unknown): string => String(value ?? "");

const intervalCode: Partial<Record<Interval, number>> = {
  "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
  "1h": 60, "2h": 120, "4h": 240, "6h": 360, "8h": 480, "12h": 720, "1d": 1440,
};
const okxInterval: Partial<Record<Interval, string>> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H", "1d": "1D",
};
const kucoinInterval: Partial<Record<Interval, string>> = {
  "1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min", "30m": "30min",
  "1h": "1hour", "2h": "2hour", "4h": "4hour", "6h": "6hour", "8h": "8hour",
  "12h": "12hour", "1d": "1day",
};

export function spotStreamRequest(providerId: string, kind: SpotStreamKind,
  symbol: string, interval: Interval = "1m"): SpotStreamRequest {
  switch (providerId) {
    case "binance-spot": {
      const stream = kind === "ticker" ? `${symbol.toLowerCase()}@miniTicker`
        : `${symbol.toLowerCase()}@kline_${interval}`;
      return { origins: ["wss://data-stream.binance.vision", "wss://stream.binance.com:9443"], path: `/ws/${stream}`,
        subscribeMessage: null, requiresBootstrapToken: false };
    }
    case "coinbase-spot":
      return { origins: ["wss://ws-feed.exchange.coinbase.com"], path: "",
        subscribeMessage: JSON.stringify({ type: "subscribe", product_ids: [symbol],
          channels: [kind === "ticker" ? "ticker" : "candles"] }), requiresBootstrapToken: false };
    case "bybit-spot":
      return { origins: ["wss://stream.bybit.com"], path: "/v5/public/spot",
        subscribeMessage: JSON.stringify({ op: "subscribe", args: [kind === "ticker"
          ? `tickers.${symbol}` : `kline.${intervalCode[interval]}.${symbol}`] }), requiresBootstrapToken: false };
    case "okx-spot":
      return { origins: ["wss://ws.okx.com:8443"], path: kind === "ticker" ? "/ws/v5/public" : "/ws/v5/business",
        subscribeMessage: JSON.stringify({ op: "subscribe", args: [{ channel: kind === "ticker"
          ? "tickers" : `candle${okxInterval[interval] ?? interval}`, instId: symbol }] }), requiresBootstrapToken: false };
    case "kraken-spot":
      return { origins: ["wss://ws.kraken.com"], path: "/v2",
        subscribeMessage: JSON.stringify({ method: "subscribe", params: {
          channel: kind === "ticker" ? "ticker" : "ohlc", symbol: [symbol],
          ...(kind === "candle" ? { interval: intervalCode[interval] } : {}),
        } }), requiresBootstrapToken: false };
    case "kucoin-spot":
      return { origins: ["wss://ws-api-spot.kucoin.com"], path: "",
        subscribeMessage: JSON.stringify({ id: "market-v1", type: "subscribe",
          topic: kind === "ticker" ? `/market/ticker:${symbol}` : `/market/candles:${symbol}_${kucoinInterval[interval] ?? interval}`,
          privateChannel: false, response: true }), requiresBootstrapToken: true };
    case "gateio-spot":
      return { origins: ["wss://api.gateio.ws"], path: "/ws/v4/",
        subscribeMessage: JSON.stringify({ time: 0, channel: kind === "ticker" ? "spot.tickers" : "spot.candlesticks",
          event: "subscribe", payload: kind === "ticker" ? [symbol] : [interval, symbol] }), requiresBootstrapToken: false };
    case "hyperliquid-spot":
      return { origins: ["wss://api.hyperliquid.xyz"], path: "/ws",
        subscribeMessage: JSON.stringify({ method: "subscribe", subscription: kind === "ticker"
          ? { type: "allMids" } : { type: "candle", coin: symbol, interval } }), requiresBootstrapToken: false };
    default:
      throw new Error(`streaming is not configured for ${providerId}`);
  }
}

const streamRetry = {
  maxAttempts: 3, baseDelayMs: 250, maximumDelayMs: 2_000,
  retryableStatuses: [429, 500, 502, 503, 504],
};

/** Resolve KuCoin's short-lived public bullet token without exposing credentials. */
export async function resolveSpotStreamRequest(providerId: string, kind: SpotStreamKind,
  symbol: string, interval: Interval = "1m", fetcher: typeof fetch = fetch): Promise<SpotStreamRequest> {
  const request = spotStreamRequest(providerId, kind, symbol, interval);
  if (!request.requiresBootstrapToken) return request;
  const response = await withProviderRetry(async () => {
    const result = await fetcher("https://api.kucoin.com/api/v1/bullet-public", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    if (!result.ok) {
      const retryAfter = Number(result.headers.get("retry-after"));
      throw new ProviderHttpError(`KuCoin stream bootstrap returned HTTP ${result.status}`, result.status,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : null);
    }
    return result;
  }, streamRetry);
  const root = record(await response.json());
  const data = record(root.data);
  const token = text(data.token);
  const server = record(array(data.instanceServers)[0]);
  const endpoint = text(server.endpoint);
  if (!token || !/^wss:\/\//.test(endpoint)) throw new Error("KuCoin public stream bootstrap was malformed");
  const url = new URL(endpoint);
  url.searchParams.set("token", token);
  url.searchParams.set("connectId", `market-v1-${Date.now()}`);
  return { ...request, origins: [`${url.protocol}//${url.host}`], path: `${url.pathname}${url.search}`,
    requiresBootstrapToken: false };
}

function validTicker(row: NormalizedSpotTicker): SpotStreamEvent | null {
  return Number.isFinite(row.last) && row.symbol.length > 0 ? { kind: "ticker", ticker: row } : null;
}

function validCandle(symbol: string, interval: Interval, row: Record<string, unknown>,
  fields: { time: string; open: string; high: string; low: string; close: string; volume: string;
    closed?: string; timeSeconds?: boolean }): SpotStreamEvent | null {
  const openTime = number(row[fields.time]) * (fields.timeSeconds ? 1000 : 1);
  const candle: Candle = { symbol, interval, openTime, open: number(row[fields.open]), high: number(row[fields.high]),
    low: number(row[fields.low]), close: number(row[fields.close]), volume: number(row[fields.volume]),
    closeTime: openTime + INTERVAL_MS[interval] - 1 };
  if (![candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) return null;
  return { kind: "candle", candle, closed: fields.closed ? row[fields.closed] === true || row[fields.closed] === "true" : false };
}

/** Normalize an official provider frame. Control/ack/error frames return null. */
export function parseSpotStreamFrame(providerId: string, kind: SpotStreamKind, raw: string,
  symbol: string, interval: Interval = "1m"): SpotStreamEvent | null {
  let message: unknown;
  try { message = JSON.parse(raw); } catch { return null; }
  const root = record(message);
  if (providerId === "binance-spot") {
    const data = record(root.data ?? root);
    if (kind === "ticker") return validTicker({ symbol: text(data.s), observedAt: number(data.E),
      last: number(data.c) });
    const kline = record(data.k);
    return validCandle(symbol, interval, kline,
      { time: "t", open: "o", high: "h", low: "l", close: "c", volume: "v", closed: "x" });
  }
  if (providerId === "coinbase-spot") {
    if (kind === "ticker") return validTicker({ symbol: text(root.product_id || symbol),
      observedAt: Date.parse(text(root.time)), last: number(root.price), bid: number(root.best_bid), ask: number(root.best_ask) });
    const values = array(root.candles); const item = array(values[values.length - 1]);
    const openTime = number(item[0]) * 1000;
    return validCandle(symbol, interval, { t: openTime, l: item[1], h: item[2], o: item[3], c: item[4], v: item[5] },
      { time: "t", open: "o", high: "h", low: "l", close: "c", volume: "v" });
  }
  if (providerId === "bybit-spot") {
    const item = record(array(root.data)[0] ?? root.data);
    if (kind === "ticker") return validTicker({ symbol: text(item.symbol || symbol), observedAt: number(root.ts),
      last: number(item.lastPrice), bid: number(item.bid1Price), ask: number(item.ask1Price) });
    return validCandle(symbol, interval, item,
      { time: "start", open: "open", high: "high", low: "low", close: "close", volume: "volume", closed: "confirm" });
  }
  if (providerId === "okx-spot") {
    const item = array(array(root.data)[0]);
    if (kind === "ticker") {
      const row = record(array(root.data)[0]);
      return validTicker({ symbol: text(record(root.arg).instId || symbol), observedAt: number(row.ts),
        last: number(row.last), bid: number(row.bidPx), ask: number(row.askPx) });
    }
    return validCandle(symbol, interval, { t: item[0], o: item[1], h: item[2], l: item[3], c: item[4], v: item[5], x: item[8] === "1" },
      { time: "t", open: "o", high: "h", low: "l", close: "c", volume: "v", closed: "x" });
  }
  if (providerId === "kraken-spot") {
    const item = record(array(root.data)[0]);
    if (kind === "ticker") return validTicker({ symbol: text(item.symbol || symbol),
      observedAt: Date.parse(text(item.timestamp)), last: number(item.last), bid: number(item.bid), ask: number(item.ask) });
    return validCandle(symbol, interval, { ...item, t: Date.parse(text(item.interval_begin)) },
      { time: "t", open: "open", high: "high", low: "low", close: "close", volume: "volume" });
  }
  if (providerId === "kucoin-spot") {
    const data = record(root.data);
    if (kind === "ticker") return validTicker({ symbol, observedAt: number(data.time), last: number(data.price),
      bid: number(data.bestBid), ask: number(data.bestAsk) });
    const item = array(data.candles);
    return validCandle(symbol, interval, { t: item[0], o: item[1], c: item[2], h: item[3], l: item[4], v: item[5] },
      { time: "t", timeSeconds: true, open: "o", high: "h", low: "l", close: "c", volume: "v" });
  }
  if (providerId === "gateio-spot") {
    const item = record(root.result);
    if (kind === "ticker") return validTicker({ symbol: text(item.currency_pair || symbol),
      observedAt: number(root.time_ms || number(root.time) * 1000), last: number(item.last),
      bid: number(item.highest_bid), ask: number(item.lowest_ask) });
    return validCandle(symbol, interval, item,
      { time: "t", timeSeconds: true, open: "o", high: "h", low: "l", close: "c", volume: "v", closed: "w" });
  }
  if (providerId === "hyperliquid-spot") {
    const data = record(root.data);
    if (kind === "ticker") {
      const mid = record(data.mids)[symbol];
      return validTicker({ symbol, observedAt: Date.now(), last: number(mid) });
    }
    return validCandle(symbol, interval, data,
      { time: "t", open: "o", high: "h", low: "l", close: "c", volume: "v" });
  }
  return null;
}
