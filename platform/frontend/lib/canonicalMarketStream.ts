"use client";

import type { MarketStreamConfig } from "./api";
import { marketStreams, type StreamState } from "./marketStream";
import type { Candle } from "./types";
import { resolutionMs, type Resolution } from "./resolution";

export type CanonicalMarketEvent =
  | { kind: "ticker"; observedAt: number; last: number; bid?: number; ask?: number }
  | { kind: "candle"; candle: Candle; closed: boolean };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const number = (value: unknown): number => Number(value);
const text = (value: unknown): string => String(value ?? "");

function ticker(observedAt: number, last: unknown, bid?: unknown, ask?: unknown): CanonicalMarketEvent | null {
  const value = number(last);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(observedAt)) return null;
  return { kind: "ticker", observedAt, last: value,
    ...(Number.isFinite(number(bid)) ? { bid: number(bid) } : {}),
    ...(Number.isFinite(number(ask)) ? { ask: number(ask) } : {}) };
}

function candle(config: MarketStreamConfig, interval: Resolution, row: Record<string, unknown>,
  fields: { time: string; open: string; high: string; low: string; close: string; volume: string;
    closed?: string; seconds?: boolean }): CanonicalMarketEvent | null {
  const openTime = number(row[fields.time]) * (fields.seconds ? 1000 : 1);
  const bar: Candle = {
    symbol: config.canonicalId, interval, openTime,
    open: number(row[fields.open]), high: number(row[fields.high]), low: number(row[fields.low]),
    close: number(row[fields.close]), volume: number(row[fields.volume]),
    closeTime: openTime + resolutionMs(interval) - 1,
  };
  if (![bar.openTime, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
    bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) return null;
  const value = fields.closed ? row[fields.closed] : false;
  return { kind: "candle", candle: bar, closed: value === true || value === "true" || value === "1" };
}

/** Parse only market-data frames for the provider named by the trusted backend config. */
export function parseCanonicalMarketFrame(config: MarketStreamConfig, kind: "ticker" | "candle",
  raw: string, interval: Resolution): CanonicalMarketEvent | null {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return null; }
  const root = record(decoded);
  const id = config.providerId;
  if (id === "binance-spot") {
    const data = record(root.data ?? root);
    if (kind === "ticker") return ticker(number(data.E), data.c);
    return candle(config, interval, record(data.k),
      { time: "t", open: "o", high: "h", low: "l", close: "c", volume: "v", closed: "x" });
  }
  if (id === "coinbase-spot") {
    if (kind === "ticker") return ticker(Date.parse(text(root.time)), root.price, root.best_bid, root.best_ask);
    const values = array(root.candles); const item = array(values[values.length - 1]);
    return candle(config, interval, { t: number(item[0]) * 1000, l: item[1], h: item[2], o: item[3], c: item[4], v: item[5] },
      { time: "t", open: "o", high: "h", low: "l", close: "c", volume: "v" });
  }
  if (id === "bybit-spot") {
    const item = record(array(root.data)[0] ?? root.data);
    if (kind === "ticker") return ticker(number(root.ts), item.lastPrice, item.bid1Price, item.ask1Price);
    return candle(config, interval, item,
      { time: "start", open: "open", high: "high", low: "low", close: "close", volume: "volume", closed: "confirm" });
  }
  if (id === "okx-spot") {
    const item = array(array(root.data)[0]);
    if (kind === "ticker") { const row = record(array(root.data)[0]); return ticker(number(row.ts), row.last, row.bidPx, row.askPx); }
    return candle(config, interval, { t: item[0], o: item[1], h: item[2], l: item[3], c: item[4], v: item[5], x: item[8] },
      { time: "t", open: "o", high: "h", low: "l", close: "c", volume: "v", closed: "x" });
  }
  if (id === "kraken-spot") {
    const item = record(array(root.data)[0]);
    if (kind === "ticker") return ticker(Date.parse(text(item.timestamp)), item.last, item.bid, item.ask);
    return candle(config, interval, { ...item, t: Date.parse(text(item.interval_begin)) },
      { time: "t", open: "open", high: "high", low: "low", close: "close", volume: "volume" });
  }
  if (id === "kucoin-spot") {
    const data = record(root.data);
    if (kind === "ticker") return ticker(number(data.time), data.price, data.bestBid, data.bestAsk);
    const item = array(data.candles);
    return candle(config, interval, { t: item[0], o: item[1], c: item[2], h: item[3], l: item[4], v: item[5] },
      { time: "t", seconds: true, open: "o", high: "h", low: "l", close: "c", volume: "v" });
  }
  if (id === "gateio-spot") {
    const item = record(root.result);
    if (kind === "ticker") return ticker(number(root.time_ms || number(root.time) * 1000), item.last, item.highest_bid, item.lowest_ask);
    return candle(config, interval, item,
      { time: "t", seconds: true, open: "o", high: "h", low: "l", close: "c", volume: "v" });
  }
  if (id === "hyperliquid-spot") {
    const data = record(root.data);
    if (kind === "ticker") return ticker(Date.now(), record(data.mids)[config.providerSymbol]);
    return candle(config, interval, data,
      { time: "t", open: "o", high: "h", low: "l", close: "c", volume: "v" });
  }
  return null;
}

export function subscribeCanonicalMarket(config: MarketStreamConfig, kind: "ticker" | "candle",
  interval: Resolution, listener: { onEvent: (event: CanonicalMarketEvent) => void;
    onState?: (state: StreamState) => void }): () => void {
  const key = `canonical|${kind}|${config.providerId}|${config.providerSymbol}|${interval}`;
  return marketStreams.subscribe(key, config.request.path, {
    onState: listener.onState,
    onMessage: (raw) => { const event = parseCanonicalMarketFrame(config, kind, raw, interval); if (event) listener.onEvent(event); },
  }, { origins: config.request.origins, subscribeMessage: config.request.subscribeMessage });
}
