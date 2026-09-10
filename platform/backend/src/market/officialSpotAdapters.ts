import { INTERVAL_MS, type Candle, type Interval } from "../types/market";
import {
  MARKET_CONTRACT_VERSION, UNKNOWN_COMPLIANCE, canonicalInstrumentId, knownNumber,
  supported, unsupported, unknownNumber, type CanonicalInstrument, type PrecisionRules,
} from "./model";
import type {
  MarketDataProviderAdapter, ProviderAccess, ProviderDocumentationSource, StreamContract,
  TickerObservation,
} from "./provider";
import { ProviderHttpError, withProviderRetry } from "./retry";

export interface NormalizedSpotListing {
  symbol: string;
  base: string;
  quote: string;
  active: boolean;
  priceTick?: number;
  quantityLot?: number;
  minimumQuantity?: number;
  minimumNotional?: number;
}

export interface NormalizedSpotTicker {
  symbol: string;
  observedAt: number;
  last: number;
  bid?: number;
  ask?: number;
}

export interface OfficialSpotDependencies {
  list(signal?: AbortSignal): Promise<NormalizedSpotListing[]>;
  candles(symbol: string, interval: Interval, startMs: number, endMs: number,
    signal?: AbortSignal): Promise<Candle[]>;
  tickers(symbols: readonly string[], signal?: AbortSignal): Promise<NormalizedSpotTicker[]>;
}

export interface OfficialSpotDefinition {
  id: string;
  label: string;
  venueId: string;
  access: ProviderAccess;
  documentation: readonly ProviderDocumentationSource[];
  resolutions: readonly Interval[];
  pagination: MarketDataProviderAdapter["candles"]["pagination"];
  tickerStream: StreamContract;
  candleStream: StreamContract;
  rateLimit: MarketDataProviderAdapter["rateLimits"];
}

const priceCapabilities = {
  last: supported(), bid: supported(), ask: supported(), mid: supported(),
  mark: unsupported("spot instruments have no mark price role"),
  index: unsupported("spot instruments have no index price role"),
};

const readOnlyExecution = Object.freeze({
  mutationBoundary: "bot_only" as const,
  availability: { paper: false, testnet: false, live: false },
  directions: { long: false, short: false },
  shortSale: { support: "unsupported" as const, reason: "read-only spot market-data adapter" },
  leverage: { support: "unsupported" as const, reason: "cash spot market data has no leverage" },
  marginModes: Object.freeze([]), reduceOnly: false, positionModes: Object.freeze([]),
});

const decimalPlaces = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const text = value.toFixed(16).replace(/0+$/, "");
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
};

function precision(row: NormalizedSpotListing): PrecisionRules {
  const priceTick = knownNumber(row.priceTick ?? 0, "official catalog did not publish a price tick");
  const quantityLot = knownNumber(row.quantityLot ?? 0, "official catalog did not publish a quantity lot");
  return {
    priceTick,
    quantityLot,
    minimumQuantity: knownNumber(row.minimumQuantity ?? 0, "official catalog did not publish a minimum quantity"),
    minimumNotional: knownNumber(row.minimumNotional ?? 0, "official catalog did not publish a minimum notional"),
    priceDecimals: priceTick.state === "known"
      ? { state: "known", value: decimalPlaces(priceTick.value) }
      : unknownNumber("price tick is unknown"),
    quantityDecimals: quantityLot.state === "known"
      ? { state: "known", value: decimalPlaces(quantityLot.value) }
      : unknownNumber("quantity lot is unknown"),
  };
}

function canonical(definition: OfficialSpotDefinition, row: NormalizedSpotListing): CanonicalInstrument {
  const identity = {
    canonicalId: "", venueId: definition.venueId, assetClass: "crypto" as const,
    instrumentType: "spot" as const, baseAsset: row.base.toUpperCase(), quoteAsset: row.quote.toUpperCase(),
    settlementAsset: row.quote.toUpperCase(), series: { kind: "spot" as const },
  };
  identity.canonicalId = canonicalInstrumentId(identity);
  return {
    contractVersion: MARKET_CONTRACT_VERSION, identity,
    listing: { providerId: definition.id, providerSymbol: row.symbol, status: row.active ? "active" : "halted" },
    currency: identity.quoteAsset, precision: precision(row), derivative: { kind: "none" },
    sessions: { kind: "continuous", timezone: "UTC", calendarId: "24x7", supports24x7: true },
    prices: priceCapabilities,
    events: {
      corporateActions: { support: "unsupported", reason: "official spot market-data API has no corporate-action feed" },
      funding: { support: "unsupported", reason: "spot instruments do not fund" },
      openInterest: { support: "unsupported", reason: "spot instruments have no derivative open interest" },
    },
    execution: readOnlyExecution, compliance: UNKNOWN_COMPLIANCE,
  };
}

export function normalizeCandles(rows: readonly Candle[], symbol: string, interval: Interval,
  startMs: number, endMs: number): Candle[] {
  const unique = new Map<number, Candle>();
  const step = INTERVAL_MS[interval];
  for (const row of rows) {
    if (row.openTime < startMs || row.openTime > endMs) continue;
    if (!Number.isInteger(row.openTime) || row.openTime % step !== 0) continue;
    if (![row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)) continue;
    if (row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) continue;
    unique.set(row.openTime, { ...row, symbol, interval, closeTime: row.openTime + step - 1 });
  }
  return [...unique.values()].sort((a, b) => a.openTime - b.openTime);
}

export function createOfficialSpotAdapter(definition: OfficialSpotDefinition,
  deps: OfficialSpotDependencies): MarketDataProviderAdapter {
  let catalogCache: { at: number; rows: NormalizedSpotListing[] } | null = null;
  const listings = async (): Promise<NormalizedSpotListing[]> => {
    if (catalogCache && Date.now() - catalogCache.at < 300_000) return catalogCache.rows;
    const rows = (await deps.list()).filter((row) =>
      /^[A-Z0-9][A-Z0-9._-]{0,31}$/i.test(row.base) && /^[A-Z0-9][A-Z0-9._-]{0,31}$/i.test(row.quote));
    catalogCache = { at: Date.now(), rows };
    return rows;
  };
  const canRead = definition.access.mode === "public";
  const unavailable = unsupported(definition.access.mode === "authentication_required"
    ? definition.access.reason : definition.access.mode === "unavailable" ? definition.access.reason : "unavailable");
  const canonicalRows = async (): Promise<CanonicalInstrument[]> => {
    const unique = new Map<string, CanonicalInstrument>();
    for (const row of await listings()) {
      const item = canonical(definition, row);
      if (!unique.has(item.identity.canonicalId)) unique.set(item.identity.canonicalId, item);
    }
    return [...unique.values()];
  };
  const adapter: MarketDataProviderAdapter = {
    id: definition.id, label: definition.label, venueIds: Object.freeze([definition.venueId]),
    access: definition.access, documentation: definition.documentation,
    healthPolicy: { staleAfterMs: 60_000, unavailableAfterFailures: 3 },
    rateLimits: definition.rateLimit,
    catalog: {
      availability: canRead ? supported() : unavailable,
      list: canonicalRows,
      metadata: async (symbols) => {
        const wanted = new Set(symbols.map((item) => item.toUpperCase()));
        return (await listings()).filter((row) => wanted.has(row.symbol.toUpperCase()))
          .map((row) => canonical(definition, row));
      },
    },
    candles: {
      availability: canRead ? supported() : unavailable,
      resolutions: definition.resolutions,
      pagination: definition.pagination,
      stream: definition.candleStream,
      fetch: async (symbol, interval, startMs, endMs, signal) => {
        if (!definition.resolutions.includes(interval)) throw new Error(`${definition.id} does not support ${interval}`);
        if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        const rows = await deps.candles(symbol, interval, startMs, endMs, signal);
        if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        return normalizeCandles(rows, symbol, interval, startMs, endMs);
      },
    },
    ticker: {
      availability: canRead ? supported() : unavailable,
      prices: priceCapabilities,
      stream: definition.tickerStream,
      fetch: async (symbols): Promise<TickerObservation[]> => {
        const rows = await deps.tickers(symbols);
        const bySymbol = new Map((await listings()).map((row) =>
          [row.symbol.toUpperCase(), canonical(definition, row).identity.canonicalId]));
        return rows.flatMap((row) => {
          const id = bySymbol.get(row.symbol.toUpperCase());
          if (!id || !Number.isFinite(row.last)) return [];
          const values: TickerObservation["values"] = { last: row.last };
          if (Number.isFinite(row.bid)) values.bid = row.bid;
          if (Number.isFinite(row.ask)) values.ask = row.ask;
          if (values.bid !== undefined && values.ask !== undefined) values.mid = (values.bid + values.ask) / 2;
          return [{ canonicalInstrumentId: id, providerSymbol: row.symbol,
            observedAt: row.observedAt, values }];
        });
      },
    },
    trades: { support: "unsupported", reason: "no current Trading Scene surface consumes spot trades" },
    orderBook: { support: "unsupported", reason: "no current Trading Scene surface consumes spot order books" },
    derivativeMetadata: { support: "unsupported", reason: "spot adapter does not expose derivative contracts" },
    execution: readOnlyExecution,
  };
  return Object.freeze(adapter);
}

const retry = {
  maxAttempts: 4, baseDelayMs: 300, maximumDelayMs: 5_000,
  retryableStatuses: Object.freeze([429, 500, 502, 503, 504]),
};

function source(title: string, url: string,
  covers: ProviderDocumentationSource["covers"], limits: readonly string[],
  access: ProviderDocumentationSource["access"] = "public"): ProviderDocumentationSource {
  return { title, url, accessedOn: "2026-09-09", covers, limits, access };
}

const stream = (origin: string, protocol: StreamContract["protocol"], topic: string): StreamContract => ({
  support: "supported", origins: Object.freeze([origin]), protocol, topic,
});

const definition = (value: Omit<OfficialSpotDefinition, "rateLimit"> & {
  requestLimit: string; windowMs?: number;
}): OfficialSpotDefinition => ({
  ...value,
  rateLimit: {
    buckets: Object.freeze([{ id: "public-market-data", limit: {
      kind: "provider_reported", source: value.requestLimit,
    }, windowMs: value.windowMs ?? 1_000 }]),
    retry,
  },
});

export const OFFICIAL_SPOT_DEFINITIONS: readonly OfficialSpotDefinition[] = Object.freeze([
  definition({
    id: "coinbase-spot", label: "Coinbase Exchange Spot", venueId: "COINBASE",
    access: { mode: "public", proof: "official_contract" },
    documentation: [
      source("Coinbase Exchange REST market data", "https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproducts",
        ["catalog", "metadata", "ticker", "candles"], ["Historic rates return at most 300 candles and may be incomplete"]),
      source("Coinbase Exchange WebSocket channels", "https://docs.cdp.coinbase.com/exchange/websocket-feed/channels",
        ["ticker_stream", "candle_stream"], ["Candles channel groups updates into five-minute buckets"]),
    ],
    resolutions: ["1m", "5m", "15m", "1h", "6h", "1d"],
    pagination: { maxPageSize: 300, direction: "forward" },
    tickerStream: stream("wss://ws-feed.exchange.coinbase.com", "json_subscription", "ticker:{symbol}"),
    candleStream: { ...stream("wss://ws-feed.exchange.coinbase.com", "json_subscription", "candles:{symbol}"), resolutions: ["5m"] },
    requestLimit: "Coinbase Exchange REST rate limits documentation",
  }),
  definition({
    id: "bybit-spot", label: "Bybit Spot", venueId: "BYBIT",
    access: { mode: "public", proof: "official_contract" },
    documentation: [
      source("Bybit V5 market endpoints", "https://bybit-exchange.github.io/docs/v5/market/instrument",
        ["catalog", "metadata", "ticker", "candles"], ["Spot instrument pages require cursor pagination; klines return newest first"]),
      source("Bybit public WebSocket", "https://bybit-exchange.github.io/docs/v5/ws/connect", ["ticker_stream", "candle_stream"],
        ["Public spot topics use the V5 spot endpoint"]),
    ],
    resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"],
    pagination: { maxPageSize: 1000, direction: "forward" },
    tickerStream: stream("wss://stream.bybit.com/v5/public/spot", "json_subscription", "tickers.{symbol}"),
    candleStream: { ...stream("wss://stream.bybit.com/v5/public/spot", "json_subscription", "kline.{interval}.{symbol}"), resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"] },
    requestLimit: "Bybit V5 rate limit headers",
  }),
  definition({
    id: "okx-spot", label: "OKX Spot", venueId: "OKX",
    access: { mode: "public", proof: "official_contract" },
    documentation: [
      source("OKX public data REST API", "https://www.okx.com/docs-v5/en/#rest-api-public-data-get-instruments",
        ["catalog", "metadata", "ticker", "candles"], ["Candles are returned newest first; maximum page size is 300"]),
      source("OKX public WebSocket", "https://www.okx.com/docs-v5/en/#websocket-api-public-channel", ["ticker_stream", "candle_stream"],
        ["Subscription uses public channel arguments"]),
    ],
    resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"],
    pagination: { maxPageSize: 300, direction: "backward" },
    tickerStream: stream("wss://ws.okx.com:8443/ws/v5/public", "json_subscription", "tickers:{symbol}"),
    candleStream: { ...stream("wss://ws.okx.com:8443/ws/v5/business", "json_subscription", "candle{interval}:{symbol}"), resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"] },
    requestLimit: "OKX endpoint-specific public rate limits",
  }),
  definition({
    id: "kraken-spot", label: "Kraken Spot", venueId: "KRAKEN",
    access: { mode: "public", proof: "official_contract" },
    documentation: [
      source("Kraken Spot REST market data", "https://docs.kraken.com/api/docs/rest-api/get-tradable-asset-pairs/",
        ["catalog", "metadata", "ticker", "candles"], ["OHLC returns at most the 720 most recent entries regardless of since"]),
      source("Kraken WebSocket v2 market data", "https://docs.kraken.com/api/docs/websocket-v2/ticker/",
        ["ticker_stream", "candle_stream"], ["Symbols use wsname notation such as BTC/USD"]),
    ],
    resolutions: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"],
    pagination: { maxPageSize: 720, direction: "latest_window_only", maximumBars: 720,
      limitation: "REST OHLC exposes only the 720 most recent entries" },
    tickerStream: stream("wss://ws.kraken.com/v2", "json_subscription", "ticker:{symbol}"),
    candleStream: { ...stream("wss://ws.kraken.com/v2", "json_subscription", "ohlc:{interval}:{symbol}"), resolutions: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] },
    requestLimit: "Kraken public REST call counter",
  }),
  definition({
    id: "kucoin-spot", label: "KuCoin Spot", venueId: "KUCOIN",
    access: { mode: "public", proof: "official_contract" },
    documentation: [
      source("KuCoin symbols list", "https://www.kucoin.com/docs-new/rest/spot-trading/market-data/get-all-symbols",
        ["catalog", "metadata"], ["Public market-data endpoint"]),
      source("KuCoin klines", "https://www.kucoin.com/docs-new/rest/spot-trading/market-data/get-klines",
        ["ticker", "candles"], ["Klines return at most 1500 bars per request"]),
      source("KuCoin public WebSocket", "https://www.kucoin.com/docs-new/websocket-api/base-info/get-public-token-spot-margin",
        ["ticker_stream", "candle_stream"], ["A public bullet token is required before subscribing"]),
    ],
    resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"],
    pagination: { maxPageSize: 1500, direction: "forward" },
    tickerStream: stream("wss://ws-api-spot.kucoin.com", "tokenized_json_subscription", "/market/ticker:{symbol}"),
    candleStream: { ...stream("wss://ws-api-spot.kucoin.com", "tokenized_json_subscription", "/market/candles:{symbol}_{interval}"), resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"] },
    requestLimit: "KuCoin public endpoint resource-pool headers",
  }),
  definition({
    id: "gateio-spot", label: "Gate.io Spot", venueId: "GATEIO",
    access: { mode: "public", proof: "official_contract" },
    documentation: [
      source("Gate API v4 Spot", "https://www.gate.com/docs/developers/apiv4/en/#spot", ["catalog", "metadata", "ticker", "candles"],
        ["Candlestick pages contain at most 1000 points"]),
      source("Gate WebSocket v4 Spot", "https://www.gate.com/docs/developers/apiv4/ws/en/#spot-websocket", ["ticker_stream", "candle_stream"],
        ["Subscriptions use spot.tickers and spot.candlesticks channels"]),
    ],
    resolutions: ["1m", "5m", "15m", "30m", "1h", "4h", "8h", "1d"],
    pagination: { maxPageSize: 1000, direction: "forward" },
    tickerStream: stream("wss://api.gateio.ws/ws/v4/", "json_subscription", "spot.tickers:{symbol}"),
    candleStream: { ...stream("wss://api.gateio.ws/ws/v4/", "json_subscription", "spot.candlesticks:{interval}:{symbol}"), resolutions: ["1m", "5m", "15m", "30m", "1h", "4h", "8h", "1d"] },
    requestLimit: "Gate API v4 response headers",
  }),
  definition({
    id: "robinhood-crypto", label: "Robinhood Crypto", venueId: "ROBINHOOD",
    access: { mode: "authentication_required", proof: "official_contract_only",
      reason: "Robinhood Crypto Trading API market-data endpoints require an API key and signature; no credential was supplied" },
    documentation: [source("Robinhood Crypto Trading API", "https://docs.robinhood.com/crypto/trading/",
      ["catalog", "metadata", "ticker"], ["Every request requires API-key authentication; official API does not document historical candles or market-data streams"],
      "authentication_required")],
    resolutions: [], pagination: { maxPageSize: 1, direction: "latest_window_only", maximumBars: 0,
      limitation: "Historical candles are not documented by the official Crypto Trading API" },
    tickerStream: { support: "unsupported", reason: "official Crypto Trading API does not document a public ticker stream" },
    candleStream: { support: "unsupported", reason: "official Crypto Trading API does not document historical or streaming candles" },
    requestLimit: "Authentication required; not live-verified",
  }),
  definition({
    id: "hyperliquid-spot", label: "Hyperliquid Spot", venueId: "HYPERLIQUID",
    access: { mode: "public", proof: "official_contract" },
    documentation: [
      source("Hyperliquid Info endpoint", "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot",
        ["catalog", "metadata", "ticker", "candles"], ["Spot universe symbols can be @index aliases; retain the provider symbol"]),
      source("Hyperliquid WebSocket subscriptions", "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions",
        ["ticker_stream", "candle_stream"], ["Candle and allMids subscriptions are public"]),
    ],
    resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d"],
    pagination: { maxPageSize: 5000, direction: "forward", maximumBars: 5000,
      limitation: "Candle snapshot is limited to the 5000 most recent candles" },
    tickerStream: stream("wss://api.hyperliquid.xyz/ws", "json_subscription", "allMids"),
    candleStream: { ...stream("wss://api.hyperliquid.xyz/ws", "json_subscription", "candle:{symbol}:{interval}"), resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d"] },
    requestLimit: "Hyperliquid IP-based REST weight limits",
  }),
]);

type Json = Record<string, unknown> | unknown[];

async function json(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Json> {
  return withProviderRetry(async () => {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const timeout = AbortSignal.timeout(10_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, { ...init, signal: requestSignal,
      headers: { "content-type": "application/json", ...init.headers } });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new ProviderHttpError(`official provider returned HTTP ${response.status}`, response.status,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : null);
    }
    return await response.json() as Json;
  }, retry);
}

const number = (value: unknown): number => Number(value);
const rows = (value: unknown): unknown[][] => Array.isArray(value) ? value.filter(Array.isArray) as unknown[][] : [];
const objectRows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

async function mapBounded<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, async () => {
    for (;;) {
      const index = cursor; cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index]!);
    }
  }));
  return output;
}

export async function pageByTime(input: {
  symbol: string; interval: Interval; startMs: number; endMs: number; pageSize: number; signal?: AbortSignal;
  fetchPage(from: number, to: number, signal?: AbortSignal): Promise<Candle[]>;
}): Promise<Candle[]> {
  const step = INTERVAL_MS[input.interval];
  if (!Number.isInteger(input.pageSize) || input.pageSize <= 0) throw new Error("pageSize must be a positive integer");
  const pageSpan = step * input.pageSize;
  const requiredPages = Math.ceil((input.endMs - input.startMs + step) / pageSpan);
  if (requiredPages > 512) {
    throw new Error(`requested candle range needs ${requiredPages} pages; maximum is 512`);
  }
  const out: Candle[] = [];
  let cursor = input.startMs;
  while (cursor <= input.endMs) {
    if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const to = Math.min(input.endMs, cursor + step * (input.pageSize - 1));
    const page = await input.fetchPage(cursor, to, input.signal);
    if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    out.push(...page);
    cursor = to + step;
  }
  return normalizeCandles(out, input.symbol, input.interval, input.startMs, input.endMs);
}

const intervalMaps: Record<string, Partial<Record<Interval, string | number>>> = {
  coinbase: { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 },
  bybit: { "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720", "1d": "D" },
  okx: { "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6Hutc", "12h": "12Hutc", "1d": "1Dutc" },
  kraken: { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440 },
  kucoin: { "1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1hour", "2h": "2hour", "4h": "4hour", "6h": "6hour", "8h": "8hour", "12h": "12hour", "1d": "1day" },
  gateio: { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "8h": "8h", "1d": "1d" },
};

function intervalCode(provider: keyof typeof intervalMaps, interval: Interval): string | number {
  const value = intervalMaps[provider]?.[interval];
  if (value === undefined) throw new Error(`${provider} does not support ${interval}`);
  return value;
}

function candle(symbol: string, interval: Interval, openTime: unknown, open: unknown, high: unknown,
  low: unknown, close: unknown, volume: unknown): Candle {
  const t = number(openTime);
  return { symbol, interval, openTime: t, open: number(open), high: number(high), low: number(low),
    close: number(close), volume: number(volume), closeTime: t + INTERVAL_MS[interval] - 1 };
}

function unavailableDeps(reason: string): OfficialSpotDependencies {
  const fail = async (): Promise<never> => { throw new Error(reason); };
  return { list: fail, candles: fail, tickers: fail };
}

export function officialSpotProductionDependencies(id: string): OfficialSpotDependencies {
  if (id === "robinhood-crypto") return unavailableDeps("Robinhood Crypto market data requires unavailable authentication");
  if (id === "coinbase-spot") {
    const list = async (signal?: AbortSignal): Promise<NormalizedSpotListing[]> => objectRows(await json("https://api.exchange.coinbase.com/products", {}, signal))
      .map((r) => ({ symbol: String(r.id), base: String(r.base_currency), quote: String(r.quote_currency),
        active: r.status === "online", priceTick: number(r.quote_increment), quantityLot: number(r.base_increment),
        minimumQuantity: number(r.base_min_size) }));
    return { list,
      candles: (symbol, interval, startMs, endMs, signal) => pageByTime({ symbol, interval, startMs, endMs, pageSize: 300, signal,
        fetchPage: async (from, to) => rows(await json(`https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/candles?granularity=${intervalCode("coinbase", interval)}&start=${new Date(from).toISOString()}&end=${new Date(to + INTERVAL_MS[interval]).toISOString()}`, {}, signal))
          .map((r) => candle(symbol, interval, number(r[0]) * 1000, r[3], r[2], r[1], r[4], r[5])) }),
      tickers: async (symbols, signal) => mapBounded(symbols, async (symbol) => {
        const r = await json(`https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/ticker`, {}, signal) as Record<string, unknown>;
        return { symbol, observedAt: Date.parse(String(r.time)), last: number(r.price), bid: number(r.bid), ask: number(r.ask) };
      }),
    };
  }
  if (id === "bybit-spot") {
    const list = async (signal?: AbortSignal): Promise<NormalizedSpotListing[]> => {
      const out: NormalizedSpotListing[] = []; let cursor = "";
      do {
        const r = await json(`https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {}, signal) as Record<string, unknown>;
        const result = record(r.result);
        out.push(...objectRows(result.list).map((x) => ({ symbol: String(x.symbol), base: String(x.baseCoin), quote: String(x.quoteCoin), active: x.status === "Trading",
          priceTick: number((x.priceFilter as Record<string, unknown> | undefined)?.tickSize),
          quantityLot: number((x.lotSizeFilter as Record<string, unknown> | undefined)?.basePrecision),
          minimumQuantity: number((x.lotSizeFilter as Record<string, unknown> | undefined)?.minOrderQty),
          minimumNotional: number((x.lotSizeFilter as Record<string, unknown> | undefined)?.minOrderAmt) })));
        cursor = String(result.nextPageCursor ?? "");
      } while (cursor);
      return out;
    };
    return { list,
      candles: (symbol, interval, startMs, endMs, signal) => pageByTime({ symbol, interval, startMs, endMs, pageSize: 1000, signal,
        fetchPage: async (from, to) => {
          const r = await json(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(symbol)}&interval=${intervalCode("bybit", interval)}&start=${from}&end=${to}&limit=1000`, {}, signal) as Record<string, unknown>;
          return rows(record(r.result).list).map((x) => candle(symbol, interval, x[0], x[1], x[2], x[3], x[4], x[5]));
        } }),
      tickers: async (symbols, signal) => mapBounded(symbols, async (symbol) => {
        const r = await json(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(symbol)}`, {}, signal) as Record<string, unknown>;
        const x = objectRows(record(r.result).list)[0] ?? {};
        return { symbol, observedAt: Date.now(), last: number(x.lastPrice), bid: number(x.bid1Price), ask: number(x.ask1Price) };
      }),
    };
  }
  if (id === "okx-spot") {
    const list = async (signal?: AbortSignal) => {
      const r = await json("https://www.okx.com/api/v5/public/instruments?instType=SPOT", {}, signal) as Record<string, unknown>;
      return objectRows(r.data).map((x) => ({ symbol: String(x.instId), base: String(x.baseCcy), quote: String(x.quoteCcy), active: x.state === "live",
        priceTick: number(x.tickSz), quantityLot: number(x.lotSz), minimumQuantity: number(x.minSz) }));
    };
    return { list,
      candles: (symbol, interval, startMs, endMs, signal) => pageByTime({ symbol, interval, startMs, endMs, pageSize: 300, signal,
        fetchPage: async (from, to) => {
          const r = await json(`https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(symbol)}&bar=${intervalCode("okx", interval)}&after=${to + 1}&before=${Math.max(0, from - 1)}&limit=300`, {}, signal) as Record<string, unknown>;
          return rows(r.data).map((x) => candle(symbol, interval, x[0], x[1], x[2], x[3], x[4], x[5]));
        } }),
      tickers: async (symbols, signal) => mapBounded(symbols, async (symbol) => {
        const r = await json(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(symbol)}`, {}, signal) as Record<string, unknown>;
        const x = objectRows(r.data)[0] ?? {};
        return { symbol, observedAt: number(x.ts), last: number(x.last), bid: number(x.bidPx), ask: number(x.askPx) };
      }),
    };
  }
  if (id === "kraken-spot") {
    const pairCache = new Map<string, string>();
    const list = async (signal?: AbortSignal) => {
      const r = await json("https://api.kraken.com/0/public/AssetPairs", {}, signal) as Record<string, unknown>;
      return Object.entries(record(r.result)).map(([key, raw]) => {
        const x = raw as Record<string, unknown>; const ws = String(x.wsname ?? key); const [base, quote] = ws.split("/");
        pairCache.set(ws, key);
        return { symbol: ws, base: base ?? ws, quote: quote ?? "UNKNOWN", active: x.status === "online",
          priceTick: 10 ** -number(x.pair_decimals), quantityLot: 10 ** -number(x.lot_decimals), minimumQuantity: number(x.ordermin) };
      });
    };
    return { list,
      candles: async (symbol, interval, startMs, endMs, signal) => {
        if (!pairCache.has(symbol)) await list(signal);
        const pair = pairCache.get(symbol) ?? symbol;
        const r = await json(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${intervalCode("kraken", interval)}&since=${Math.floor(startMs / 1000)}`, {}, signal) as Record<string, unknown>;
        const result = record(r.result); const key = Object.keys(result).find((item) => item !== "last");
        return normalizeCandles(rows(key ? result[key] : []).map((x) => candle(symbol, interval, number(x[0]) * 1000, x[1], x[2], x[3], x[4], x[6])), symbol, interval, startMs, endMs);
      },
      tickers: async (symbols, signal) => {
        if (pairCache.size === 0) await list(signal);
        return mapBounded(symbols, async (symbol) => {
          const r = await json(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pairCache.get(symbol) ?? symbol)}`, {}, signal) as Record<string, unknown>;
          const x = record(Object.values(record(r.result))[0]);
          return { symbol, observedAt: Date.now(), last: number(array(x.c)[0]), bid: number(array(x.b)[0]), ask: number(array(x.a)[0]) };
        });
      },
    };
  }
  if (id === "kucoin-spot") {
    const list = async (signal?: AbortSignal) => {
      const r = await json("https://api.kucoin.com/api/v2/symbols", {}, signal) as Record<string, unknown>;
      return objectRows(r.data).map((x) => ({ symbol: String(x.symbol), base: String(x.baseCurrency), quote: String(x.quoteCurrency), active: x.enableTrading === true,
        priceTick: number(x.priceIncrement), quantityLot: number(x.baseIncrement), minimumQuantity: number(x.baseMinSize), minimumNotional: number(x.quoteMinSize) }));
    };
    return { list,
      candles: (symbol, interval, startMs, endMs, signal) => pageByTime({ symbol, interval, startMs, endMs, pageSize: 1500, signal,
        fetchPage: async (from, to) => {
          const r = await json(`https://api.kucoin.com/api/v1/market/candles?type=${intervalCode("kucoin", interval)}&symbol=${encodeURIComponent(symbol)}&startAt=${Math.floor(from / 1000)}&endAt=${Math.floor((to + INTERVAL_MS[interval]) / 1000)}`, {}, signal) as Record<string, unknown>;
          return rows(r.data).map((x) => candle(symbol, interval, number(x[0]) * 1000, x[1], x[3], x[4], x[2], x[5]));
        } }),
      tickers: async (symbols, signal) => mapBounded(symbols, async (symbol) => {
        const r = await json(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${encodeURIComponent(symbol)}`, {}, signal) as Record<string, unknown>;
        const x = record(r.data); return { symbol, observedAt: number(x.time), last: number(x.price), bid: number(x.bestBid), ask: number(x.bestAsk) };
      }),
    };
  }
  if (id === "gateio-spot") {
    const list = async (signal?: AbortSignal) => objectRows(await json("https://api.gateio.ws/api/v4/spot/currency_pairs", {}, signal))
      .map((x) => ({ symbol: String(x.id), base: String(x.base), quote: String(x.quote), active: x.trade_status === "tradable",
        priceTick: number(x.precision) >= 0 ? 10 ** -number(x.precision) : undefined,
        quantityLot: number(x.amount_precision) >= 0 ? 10 ** -number(x.amount_precision) : undefined,
        minimumQuantity: number(x.min_base_amount), minimumNotional: number(x.min_quote_amount) }));
    return { list,
      candles: (symbol, interval, startMs, endMs, signal) => pageByTime({ symbol, interval, startMs, endMs, pageSize: 1000, signal,
        fetchPage: async (from, to) => rows(await json(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${encodeURIComponent(symbol)}&interval=${intervalCode("gateio", interval)}&from=${Math.floor(from / 1000)}&to=${Math.floor((to + INTERVAL_MS[interval]) / 1000)}&limit=1000`, {}, signal))
          .map((x) => candle(symbol, interval, number(x[0]) * 1000, x[5], x[3], x[4], x[2], x[1])) }),
      tickers: async (symbols, signal) => mapBounded(symbols, async (symbol) => {
        const x = objectRows(await json(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${encodeURIComponent(symbol)}`, {}, signal))[0] ?? {};
        return { symbol, observedAt: Date.now(), last: number(x.last), bid: number(x.highest_bid), ask: number(x.lowest_ask) };
      }),
    };
  }
  if (id === "hyperliquid-spot") {
    const post = (body: Record<string, unknown>, signal?: AbortSignal) => json("https://api.hyperliquid.xyz/info", { method: "POST", body: JSON.stringify(body) }, signal);
    const list = async (signal?: AbortSignal) => {
      const r = await post({ type: "spotMeta" }, signal) as Record<string, unknown>;
      const tokens = objectRows(r.tokens);
      const tokenByIndex = new Map(tokens.map((token) => [number(token.index), token]));
      return objectRows(r.universe).map((x) => {
        const indices = Array.isArray(x.tokens) ? x.tokens.map(number) : [];
        const base = tokenByIndex.get(indices[0] ?? -1); const quote = tokenByIndex.get(indices[1] ?? -1);
        return { symbol: String(x.name), base: String(base?.name ?? x.name), quote: String(quote?.name ?? "USDC"), active: !x.isDelisted,
          quantityLot: number(base?.szDecimals) >= 0 ? 10 ** -number(base?.szDecimals) : undefined };
      });
    };
    return { list,
      candles: async (symbol, interval, startMs, endMs, signal) => objectRows(await post({ type: "candleSnapshot", req: { coin: symbol, interval, startTime: startMs, endTime: endMs } }, signal))
        .map((x) => candle(symbol, interval, x.t, x.o, x.h, x.l, x.c, x.v)),
      tickers: async (symbols, signal) => {
        const mids = await post({ type: "allMids" }, signal) as Record<string, unknown>;
        return symbols.flatMap((symbol) => mids[symbol] === undefined ? [] : [{ symbol, observedAt: Date.now(), last: number(mids[symbol]) }]);
      },
    };
  }
  throw new Error(`no official spot client for ${id}`);
}

export const officialSpotAdapters: readonly MarketDataProviderAdapter[] = Object.freeze(
  OFFICIAL_SPOT_DEFINITIONS.map((item) => createOfficialSpotAdapter(item, officialSpotProductionDependencies(item.id))),
);
