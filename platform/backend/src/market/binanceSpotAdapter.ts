import {
  fetch24hTickers, fetchKlines, fetchSymbolMetadata, listExchangeSymbols,
  type ExchangeSymbol, type SymbolMetadata, type Ticker24h,
} from "../data/binanceRest";
import { BINANCE_SPOT_PROFILE } from "../data/providerProfile";
import { INTERVALS, type Candle, type Interval } from "../types/market";
import {
  MARKET_CONTRACT_VERSION, UNKNOWN_COMPLIANCE, canonicalInstrumentId, knownNumber,
  supported, unsupported, unknownNumber, type CanonicalInstrument, type PrecisionRules,
} from "./model";
import type { MarketDataProviderAdapter, TickerObservation } from "./provider";

export interface BinanceSpotAdapterDependencies {
  listSymbols(): Promise<ExchangeSymbol[]>;
  metadata(symbols: string[]): Promise<SymbolMetadata[]>;
  candles(symbol: string, interval: Interval, startMs: number, endMs: number): Promise<Candle[]>;
  tickers(symbols: readonly string[]): Promise<Ticker24h[]>;
}

const unknownPrecision = (): PrecisionRules => ({
  priceTick: unknownNumber("catalog listing does not include PRICE_FILTER"),
  quantityLot: unknownNumber("catalog listing does not include LOT_SIZE"),
  minimumQuantity: unknownNumber("provider mapping has not supplied minQty"),
  minimumNotional: unknownNumber("catalog listing does not include NOTIONAL"),
  priceDecimals: unknownNumber("price tick is not loaded"),
  quantityDecimals: unknownNumber("quantity lot is not loaded"),
});

function decimals(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const text = value.toFixed(16).replace(/0+$/, "");
  return Math.max(0, text.length - text.indexOf(".") - 1);
}

const execution = Object.freeze({
  mutationBoundary: "bot_only" as const,
  availability: { paper: true, testnet: true, live: true },
  directions: { long: true, short: false },
  shortSale: { support: "unsupported" as const, reason: "Binance Spot adapter declares no borrow/short-sale facility" },
  leverage: { support: "unsupported" as const, reason: "cash Spot execution does not use leverage" },
  marginModes: Object.freeze(["cash"] as const),
  reduceOnly: false,
  positionModes: Object.freeze(["one_way"] as const),
});

function canonical(row: ExchangeSymbol | SymbolMetadata, precision = unknownPrecision()): CanonicalInstrument {
  const identity = {
    canonicalId: "",
    venueId: "BINANCE",
    assetClass: "crypto" as const,
    instrumentType: "spot" as const,
    baseAsset: row.baseAsset.toUpperCase(),
    quoteAsset: row.quoteAsset.toUpperCase(),
    settlementAsset: row.quoteAsset.toUpperCase(),
    series: { kind: "spot" as const },
  };
  identity.canonicalId = canonicalInstrumentId(identity);
  const status = "active" in row
    ? (row.active ? "active" : "halted")
    : (row.status === "TRADING" ? "active" : "halted");
  return {
    contractVersion: MARKET_CONTRACT_VERSION,
    identity,
    listing: { providerId: BINANCE_SPOT_PROFILE.id, providerSymbol: row.symbol, status },
    currency: identity.quoteAsset,
    precision,
    derivative: { kind: "none" },
    sessions: { kind: "continuous", timezone: "UTC", calendarId: "24x7", supports24x7: true },
    prices: {
      last: supported(),
      bid: unsupported("the current 24h ticker seam does not request book ticker"),
      ask: unsupported("the current 24h ticker seam does not request book ticker"),
      mid: unsupported("bid/ask are unavailable through the current ticker seam"),
      mark: unsupported("spot instruments have no mark price role"),
      index: unsupported("spot instruments have no index price role"),
    },
    events: {
      corporateActions: { support: "unsupported", reason: "crypto spot listing metadata has no corporate-action feed" },
      funding: { support: "unsupported", reason: "spot instruments do not fund" },
      openInterest: { support: "unsupported", reason: "spot instruments have no derivative open interest" },
    },
    execution,
    compliance: UNKNOWN_COMPLIANCE,
  };
}

export function createBinanceSpotAdapter(deps: BinanceSpotAdapterDependencies): MarketDataProviderAdapter {
  const adapter: MarketDataProviderAdapter = {
    id: BINANCE_SPOT_PROFILE.id,
    label: "Binance Spot",
    venueIds: Object.freeze(["BINANCE"]),
    access: { mode: "public", proof: "official_contract" },
    documentation: Object.freeze([
      {
        title: "Binance Spot REST API", url: "https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md",
        accessedOn: "2026-09-09", covers: ["catalog", "metadata", "ticker", "candles"] as const,
        access: "public" as const,
        limits: ["Klines return at most 1000 bars per request", "429/418 responses require Retry-After backoff"],
      },
      {
        title: "Binance Spot WebSocket Streams", url: "https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md",
        accessedOn: "2026-09-09", covers: ["ticker_stream", "candle_stream"] as const,
        access: "public" as const, limits: ["Connections are recycled after 24 hours"],
      },
    ]),
    healthPolicy: { staleAfterMs: 60_000, unavailableAfterFailures: 3 },
    rateLimits: {
      buckets: Object.freeze([{
        id: "rest-request-weight",
        limit: { kind: "provider_reported" as const, source: "/api/v3/exchangeInfo rateLimits" },
        windowMs: 60_000,
      }]),
      retry: {
        maxAttempts: 5, baseDelayMs: 500, maximumDelayMs: 8_000,
        retryableStatuses: Object.freeze([418, 429, 500, 502, 503, 504]),
      },
    },
    catalog: {
      availability: supported(),
      list: async () => (await deps.listSymbols()).map((row) => canonical(row)),
      metadata: async (symbols) => (await deps.metadata([...symbols])).map((row) => canonical(row, {
        priceTick: knownNumber(row.priceTick, "PRICE_FILTER missing"),
        quantityLot: knownNumber(row.qtyStep, "LOT_SIZE missing"),
        minimumQuantity: unknownNumber("legacy Binance metadata seam does not expose minQty yet"),
        minimumNotional: knownNumber(row.minNotional, "NOTIONAL missing"),
        priceDecimals: row.priceTick > 0
          ? { state: "known", value: decimals(row.priceTick) }
          : unknownNumber("PRICE_FILTER missing"),
        quantityDecimals: row.qtyStep > 0
          ? { state: "known", value: decimals(row.qtyStep) }
          : unknownNumber("LOT_SIZE missing"),
      })),
    },
    candles: {
      availability: supported(),
      resolutions: Object.freeze([...INTERVALS]),
      pagination: { maxPageSize: 1000, direction: "forward" },
      stream: { support: "supported", origins: BINANCE_SPOT_PROFILE.streamOrigins,
        protocol: "url_subscription", topic: "{symbol}@kline_{interval}" },
      fetch: (symbol, interval, startMs, endMs) => deps.candles(symbol, interval, startMs, endMs),
    },
    ticker: {
      availability: supported(),
      prices: canonical({ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING" }).prices,
      fetch: async (symbols): Promise<TickerObservation[]> => {
        const [rows, metadata] = await Promise.all([deps.tickers(symbols), deps.metadata([...symbols])]);
        const canonicalBySymbol = new Map(metadata.map((row) => [row.symbol, canonical(row).identity.canonicalId]));
        return rows.flatMap((row) => {
          const id = canonicalBySymbol.get(row.symbol);
          return id ? [{ canonicalInstrumentId: id, providerSymbol: row.symbol,
            observedAt: row.at, values: { last: row.last } }] : [];
        });
      },
      stream: { support: "supported", origins: BINANCE_SPOT_PROFILE.streamOrigins,
        protocol: "url_subscription", topic: "{symbol}@miniTicker" },
    },
    trades: { support: "unsupported", reason: "trade history is outside the current Binance Spot seam" },
    orderBook: { support: "unsupported", reason: "order book is outside the current Binance Spot seam" },
    derivativeMetadata: {
      support: "unsupported",
      reason: "Binance Spot does not expose derivative contracts",
    },
    execution,
  };
  return Object.freeze(adapter);
}

export const binanceSpotAdapter = createBinanceSpotAdapter({
  listSymbols: listExchangeSymbols,
  metadata: fetchSymbolMetadata,
  candles: fetchKlines,
  tickers: fetch24hTickers,
});
