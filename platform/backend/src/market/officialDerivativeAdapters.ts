import { INTERVAL_MS, type Candle, type Interval } from "../types/market";
import {
  MARKET_CONTRACT_VERSION, UNKNOWN_COMPLIANCE, canonicalInstrumentId, knownNumber,
  supported, unsupported, unknownNumber, type CanonicalInstrument, type PrecisionRules,
} from "./model";
import type {
  DerivativeObservation, FundingObservation, MarketDataProviderAdapter, ProviderAccess,
  ProviderDocumentationSource, QuantityUnit, StreamContract, TickerObservation,
} from "./provider";
import { normalizeCandles, pageByTime } from "./officialSpotAdapters";

export interface NormalizedDerivativeListing {
  symbol: string;
  base: string;
  quote: string;
  settlement: string;
  kind: "perpetual" | "future";
  settlementMode: "linear" | "inverse";
  contractSize: number;
  contractSizeUnit: "base" | "quote";
  multiplier: number;
  quantityUnit: "contracts" | "base" | "quote";
  expiry?: string;
  expiryAt?: string;
  delivery?: "cash" | "physical" | "provider_defined";
  status: "active" | "halted" | "delisted" | "unknown";
  priceTick?: number;
  quantityLot?: number;
  minimumQuantity?: number;
  maxLeverage?: number;
  marginModes?: readonly ("cross" | "isolated")[];
  positionModes?: readonly ("one_way" | "hedge")[];
  reduceOnly?: boolean;
  fundingIntervalMs?: number;
}

export interface NormalizedDerivativeSnapshot {
  symbol: string;
  observedAt: number;
  last?: number;
  mark?: number;
  index?: number;
  fundingRate?: number;
  fundingIntervalMs?: number;
  nextFundingAt?: number | null;
  openInterest?: { value: number; unit: QuantityUnit; converted?: { value: number; unit: QuantityUnit } };
  volume24h?: { value: number; unit: QuantityUnit; converted?: { value: number; unit: QuantityUnit } };
  maintenanceMarginRate?: number;
  riskLimit?: { value: number; unit: QuantityUnit };
}

export interface OfficialDerivativeDependencies {
  list(signal?: AbortSignal): Promise<NormalizedDerivativeListing[]>;
  candles(symbol: string, interval: Interval, startMs: number, endMs: number,
    signal?: AbortSignal): Promise<Candle[]>;
  snapshots(symbols: readonly string[], signal?: AbortSignal): Promise<NormalizedDerivativeSnapshot[]>;
  fundingHistory(symbol: string, startMs: number, endMs: number,
    signal?: AbortSignal): Promise<Array<{ rate: number; intervalMs: number; fundingAt: number }>>;
}

export interface OfficialDerivativeDefinition {
  id: string;
  label: string;
  venueId: string;
  access: ProviderAccess;
  documentation: readonly ProviderDocumentationSource[];
  resolutions: readonly Interval[];
  pagination: MarketDataProviderAdapter["candles"]["pagination"];
  tickerStream: StreamContract;
  candleStream: StreamContract;
  derivativeStream: StreamContract;
  fundingHistory: { support: "supported" } | { support: "unsupported"; reason: string };
  priceRoles?: {
    last?: ReturnType<typeof supported> | ReturnType<typeof unsupported>;
    mark?: ReturnType<typeof supported> | ReturnType<typeof unsupported>;
    index?: ReturnType<typeof supported> | ReturnType<typeof unsupported>;
  };
  rateLimit: MarketDataProviderAdapter["rateLimits"];
  unavailableReason?: string;
}

const D = "2026-09-10";
const retry = (source: string): MarketDataProviderAdapter["rateLimits"] => ({
  buckets: [{ id: "public-market-data", limit: { kind: "provider_reported", source }, windowMs: 60_000 }],
  retry: { maxAttempts: 4, baseDelayMs: 350, maximumDelayMs: 5_000,
    retryableStatuses: [418, 429, 500, 502, 503, 504] },
});
const doc = (title: string, url: string, limits: readonly string[] = []): ProviderDocumentationSource => ({
  title, url, accessedOn: D,
  covers: ["catalog", "metadata", "ticker", "candles", "funding", "open_interest", "contract_terms"],
  access: "public", limits,
});
const ws = (origins: readonly string[], topic: string): StreamContract => ({
  support: "supported", origins, protocol: "json_subscription", topic,
});
const noStream = (reason: string): StreamContract => ({ support: "unsupported", reason });

export const OFFICIAL_DERIVATIVE_DEFINITIONS: readonly OfficialDerivativeDefinition[] = Object.freeze([
  { id: "binance-derivatives", label: "Binance Futures", venueId: "BINANCE",
    access: { mode: "public", proof: "official_contract" },
    documentation: [doc("Binance USD-M and COIN-M Futures market data",
      "https://developers.binance.com/docs/derivatives", ["USD-M and COIN-M have distinct units and hosts", "1000 klines per page"])],
    resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"],
    pagination: { maxPageSize: 1000, direction: "forward" },
    tickerStream: ws(["wss://fstream.binance.com", "wss://dstream.binance.com"], "{symbol}@ticker"),
    candleStream: ws(["wss://fstream.binance.com", "wss://dstream.binance.com"], "{symbol}@kline_{interval}"),
    derivativeStream: ws(["wss://fstream.binance.com", "wss://dstream.binance.com"], "{symbol}@markPrice@1s"),
    fundingHistory: { support: "supported" },
    rateLimit: retry("exchangeInfo rateLimits") },
  { id: "bybit-derivatives", label: "Bybit Derivatives", venueId: "BYBIT",
    access: { mode: "public", proof: "official_contract" },
    documentation: [doc("Bybit V5 Market", "https://bybit-exchange.github.io/docs/v5/market/instrument",
      ["linear and inverse categories are queried separately", "catalog uses cursor pagination"])],
    resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"],
    pagination: { maxPageSize: 1000, direction: "forward" },
    tickerStream: ws(["wss://stream.bybit.com"], "tickers.{symbol}"),
    candleStream: ws(["wss://stream.bybit.com"], "kline.{interval}.{symbol}"),
    derivativeStream: ws(["wss://stream.bybit.com"], "tickers.{symbol}"),
    fundingHistory: { support: "supported" }, rateLimit: retry("V5 IP limits") },
  { id: "okx-derivatives", label: "OKX Derivatives", venueId: "OKX",
    access: { mode: "public", proof: "live_public" },
    documentation: [doc("OKX public derivatives data", "https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments",
      ["SWAP and FUTURES are separate instType queries", "open interest units are returned explicitly"])],
    resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"],
    pagination: { maxPageSize: 300, direction: "backward" },
    tickerStream: ws(["wss://ws.okx.com:8443"], "tickers:{symbol}"),
    candleStream: ws(["wss://ws.okx.com:8443"], "candle{interval}:{symbol}"),
    derivativeStream: ws(["wss://ws.okx.com:8443"], "mark-price:{symbol}"),
    fundingHistory: { support: "supported" }, rateLimit: retry("REST endpoint limits") },
  { id: "kucoin-derivatives", label: "KuCoin Futures", venueId: "KUCOIN",
    access: { mode: "public", proof: "official_contract" },
    documentation: [doc("KuCoin Futures market data", "https://www.kucoin.com/docs-new/rest/futures-trading/market-data/get-all-symbols",
      ["service is jurisdiction restricted", "contract multiplier is provider metadata"])],
    resolutions: ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d"],
    pagination: { maxPageSize: 500, direction: "forward" },
    tickerStream: ws(["wss://ws-api-futures.kucoin.com"], "/contractMarket/tickerV2:{symbol}"),
    candleStream: noStream("KuCoin Futures has no candle WebSocket channel in this adapter; REST tail polling is explicit"),
    derivativeStream: ws(["wss://ws-api-futures.kucoin.com"], "/contract/instrument:{symbol}"),
    fundingHistory: { support: "supported" }, rateLimit: retry("public futures limits") },
  { id: "gateio-derivatives", label: "Gate.io Futures", venueId: "GATEIO",
    access: { mode: "public", proof: "live_public" },
    documentation: [doc("Gate API v4 futures and delivery", "https://www.gate.com/docs/developers/apiv4/en/#futures",
      ["settle currency selects the unit convention", "documentation host may reject automated access"])],
    resolutions: ["1m", "5m", "15m", "30m", "1h", "4h", "8h", "1d"],
    pagination: { maxPageSize: 2000, direction: "forward" },
    tickerStream: ws(["wss://fx-ws.gateio.ws"], "futures.tickers:{symbol}"),
    candleStream: ws(["wss://fx-ws.gateio.ws"], "futures.candlesticks:{interval}:{symbol}"),
    derivativeStream: ws(["wss://fx-ws.gateio.ws"], "futures.tickers:{symbol}"),
    fundingHistory: { support: "supported" }, rateLimit: retry("API v4 response headers") },
  { id: "kraken-derivatives", label: "Kraken Derivatives", venueId: "KRAKEN",
    access: { mode: "public", proof: "live_public" },
    documentation: [doc("Kraken Futures instruments and tickers", "https://docs.kraken.com/api/docs/futures-api/trading/get-instruments",
      ["PI/PF symbols are perpetual; FI/FF symbols are dated", "inverse contract size is USD-denominated",
        "margin schedules and maximum leverage may vary by account classification and jurisdiction"])],
    resolutions: ["1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d"],
    pagination: { maxPageSize: 1000, direction: "backward", maximumBars: 10_000,
      limitation: "Kraken charts history is a provider-bounded recent window" },
    tickerStream: ws(["wss://futures.kraken.com"], "ticker:{symbol}"),
    candleStream: noStream("Kraken Futures chart candles use bounded REST backfill in this adapter"),
    derivativeStream: ws(["wss://futures.kraken.com"], "ticker:{symbol}"),
    fundingHistory: { support: "supported" }, rateLimit: retry("Futures public API limits") },
  { id: "hyperliquid-perps", label: "Hyperliquid Perpetuals", venueId: "HYPERLIQUID",
    access: { mode: "public", proof: "live_public" },
    documentation: [doc("Hyperliquid perpetuals info endpoint",
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals",
      ["perpetuals only; no dated futures", "candle snapshots contain at most 5000 bars"])],
    resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d"],
    pagination: { maxPageSize: 5000, direction: "latest_window_only", maximumBars: 5000,
      limitation: "Hyperliquid candleSnapshot returns the latest 5000 bars" },
    tickerStream: noStream("Hyperliquid allMids publishes midpoint estimates, not canonical last trades"),
    candleStream: ws(["wss://api.hyperliquid.xyz"], "candle:{symbol}:{interval}"),
    derivativeStream: ws(["wss://api.hyperliquid.xyz"], "activeAssetCtx:{symbol}"),
    fundingHistory: { support: "supported" },
    priceRoles: {
      last: unsupported("metaAndAssetCtxs does not publish a canonical last-trade price"),
      index: unsupported("oraclePx is an oracle price and is not normalized as a canonical index"),
    },
    rateLimit: retry("info endpoint limits") },
  { id: "coinbase-derivatives", label: "Coinbase Derivatives", venueId: "COINBASE",
    access: { mode: "authentication_required", proof: "official_contract_only",
      reason: "futures product visibility depends on eligible jurisdiction, account approval and authenticated Advanced Trade access" },
    documentation: [{ ...doc("Coinbase Advanced Trade US futures",
      "https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/futures",
      ["eligible US accounts only", "no production credentials were supplied or used"]), access: "authentication_required" }],
    resolutions: [], pagination: { maxPageSize: 0, direction: "forward" },
    tickerStream: noStream("authenticated eligible-account product discovery is unverified"),
    candleStream: noStream("authenticated eligible-account product discovery is unverified"),
    derivativeStream: noStream("authenticated eligible-account product discovery is unverified"),
    fundingHistory: { support: "unsupported", reason: "authenticated eligible-account product discovery is unverified" },
    rateLimit: retry("Advanced Trade account limits"),
    unavailableReason: "Coinbase futures require an eligible, approved, authenticated account; fixture-only capability declaration" },
]);

const decimals = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const text = value.toFixed(16).replace(/0+$/, "");
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
};
const precision = (row: NormalizedDerivativeListing): PrecisionRules => {
  const tick = knownNumber(row.priceTick ?? 0, "provider contract catalog did not publish a price tick");
  const lot = knownNumber(row.quantityLot ?? 0, "provider contract catalog did not publish a contract lot");
  return { priceTick: tick, quantityLot: lot,
    minimumQuantity: knownNumber(row.minimumQuantity ?? 0, "provider did not publish minimum contracts"),
    minimumNotional: unknownNumber("derivative minimum notional is not interchangeable with contract quantity"),
    priceDecimals: tick.state === "known" ? { state: "known", value: decimals(tick.value) } : unknownNumber("price tick unknown"),
    quantityDecimals: lot.state === "known" ? { state: "known", value: decimals(lot.value) } : unknownNumber("contract lot unknown") };
};

function canonical(definition: OfficialDerivativeDefinition, row: NormalizedDerivativeListing): CanonicalInstrument {
  if (row.kind === "future" && !row.expiry) throw new Error(`${row.symbol}: dated future has no expiry`);
  if (row.kind === "future" && (!row.expiryAt || !Number.isFinite(Date.parse(row.expiryAt)))) {
    throw new Error(`${row.symbol}: dated future has no exact delivery instant`);
  }
  const series = row.kind === "perpetual" ? { kind: "perpetual" as const }
    : { kind: "dated" as const, expiry: row.expiry!, delivery: row.delivery ?? "provider_defined" as const };
  const maturity = row.kind === "perpetual" ? { kind: "perpetual" as const }
    : { kind: "dated" as const, expiry: row.expiry!, expiresAt: row.expiryAt!,
        delivery: row.delivery ?? "provider_defined" as const };
  const identity = { canonicalId: "", venueId: definition.venueId, assetClass: "crypto" as const,
    instrumentType: row.kind, baseAsset: row.base.toUpperCase(), quoteAsset: row.quote.toUpperCase(),
    settlementAsset: row.settlement.toUpperCase(), series };
  identity.canonicalId = canonicalInstrumentId(identity);
  const maxLeverage = row.maxLeverage;
  return { contractVersion: MARKET_CONTRACT_VERSION, identity,
    listing: { providerId: definition.id, providerSymbol: row.symbol, status: row.status },
    currency: identity.quoteAsset, precision: precision(row),
    derivative: { kind: "contract", contractSize: { value: row.contractSize, unit: row.contractSizeUnit }, multiplier: row.multiplier,
      quantityUnit: row.quantityUnit, settlement: row.settlementMode, maturity },
    sessions: { kind: "continuous", timezone: "UTC", calendarId: "24x7", supports24x7: true },
    prices: { last: definition.priceRoles?.last ?? supported(), bid: unsupported("derivative snapshot does not normalize book quotes"),
      ask: unsupported("derivative snapshot does not normalize book quotes"),
      mid: unsupported("bid/ask midpoint is not a mark price"), mark: definition.priceRoles?.mark ?? supported(),
      index: definition.priceRoles?.index ?? supported() },
    events: { corporateActions: { support: "unsupported", reason: "crypto contracts have no corporate actions" },
      funding: row.kind === "perpetual" ? { support: "supported",
        historical: definition.fundingHistory.support === "supported", stream: definition.derivativeStream.support === "supported" }
        : { support: "unsupported", reason: "dated futures do not exchange periodic perpetual funding" },
      openInterest: { support: "supported", historical: false, stream: definition.derivativeStream.support === "supported" } },
    execution: { mutationBoundary: "bot_only", availability: { paper: false, testnet: false, live: false },
      directions: { long: true, short: true },
      shortSale: { support: "supported", borrowRequired: false, availabilityCheckRequired: false },
      leverage: maxLeverage && maxLeverage >= 1 ? { support: "supported", minimum: 1, maximum: maxLeverage }
        : { support: "unsupported", reason: "provider catalog did not publish a truthful leverage ceiling" },
      marginModes: row.marginModes ?? [], reduceOnly: row.reduceOnly ?? false,
      positionModes: row.positionModes ?? [] }, compliance: UNKNOWN_COMPLIANCE };
}

function observation(item: CanonicalInstrument, row: NormalizedDerivativeSnapshot): DerivativeObservation {
  const price = (value: unknown): number | undefined => {
    const parsed = finite(value); return parsed !== undefined && parsed > 0 ? parsed : undefined;
  };
  const mark = price(row.mark), index = price(row.index), last = price(row.last);
  const basis = mark !== undefined && index !== undefined && index !== 0
    ? { absolute: mark - index, rate: (mark - index) / index, mark, index } : null;
  const unit = (value: NormalizedDerivativeSnapshot["openInterest"] | NormalizedDerivativeSnapshot["volume24h"]) =>
    value && Number.isFinite(value.value) && value.value >= 0 ? { value: value.value, unit: value.unit,
      ...(value.converted && Number.isFinite(value.converted.value)
        ? { converted: { ...value.converted, role: "provider_reported" as const } } : {}) } : null;
  return { canonicalInstrumentId: item.identity.canonicalId, providerSymbol: row.symbol,
    observedAt: row.observedAt, prices: { ...(last !== undefined ? { last } : {}),
      ...(mark !== undefined ? { mark } : {}), ...(index !== undefined ? { index } : {}) },
    funding: item.identity.instrumentType === "perpetual" && finite(row.fundingRate) !== undefined &&
      finite(row.fundingIntervalMs) !== undefined && row.fundingIntervalMs! > 0
      ? { rate: row.fundingRate!, intervalMs: row.fundingIntervalMs!, nextFundingAt: row.nextFundingAt ?? null } : null,
    openInterest: unit(row.openInterest), volume24h: unit(row.volume24h), basis,
    liquidation: (finite(row.maintenanceMarginRate) ?? -1) >= 0 || (row.riskLimit?.value ?? 0) > 0
      ? { ...((finite(row.maintenanceMarginRate) ?? -1) >= 0 ? { maintenanceMarginRate: row.maintenanceMarginRate } : {}),
        ...((row.riskLimit?.value ?? 0) > 0 ? { riskLimit: row.riskLimit } : {}), source: "provider_contract_metadata" } : null };
}
const finite = (value: unknown): number | undefined => Number.isFinite(Number(value)) ? Number(value) : undefined;
const positive = (value: unknown): number | undefined => {
  const parsed = finite(value); return parsed !== undefined && parsed > 0 ? parsed : undefined;
};

export function createOfficialDerivativeAdapter(definition: OfficialDerivativeDefinition,
  deps?: OfficialDerivativeDependencies): MarketDataProviderAdapter {
  const unavailable = definition.unavailableReason;
  const catalogAvailability = unavailable ? unsupported(unavailable) : supported();
  const no = async (): Promise<never> => { throw new Error(unavailable ?? `${definition.label} dependencies unavailable`); };
  const list = deps?.list ?? no;
  let cache: CanonicalInstrument[] = [];
  let cacheAt = 0;
  let catalogInFlight: Promise<CanonicalInstrument[]> | null = null;
  const catalog = async (): Promise<CanonicalInstrument[]> => {
    if (cache.length > 0 && Date.now() - cacheAt < 300_000) return cache;
    if (catalogInFlight) return catalogInFlight;
    catalogInFlight = list().then((rows) => {
      cache = rows.map((row) => canonical(definition, row)); cacheAt = Date.now(); return cache;
    }).finally(() => { catalogInFlight = null; });
    return catalogInFlight;
  };
  const metadata = async (symbols: readonly string[]): Promise<CanonicalInstrument[]> => {
    const all = cache.length ? cache : await catalog(); const wanted = new Set(symbols);
    return all.filter((item) => wanted.has(item.listing.providerSymbol));
  };
  const adapter: MarketDataProviderAdapter = {
    id: definition.id, label: definition.label, venueIds: [definition.venueId],
    healthPolicy: { staleAfterMs: 45_000, unavailableAfterFailures: 3 }, rateLimits: definition.rateLimit,
    access: definition.access, documentation: definition.documentation,
    catalog: { availability: catalogAvailability, list: catalog, metadata },
    candles: { availability: unavailable ? unsupported(unavailable) : supported(), resolutions: definition.resolutions,
      pagination: definition.pagination, stream: definition.candleStream,
      fetch: deps?.candles ?? (async () => no()) },
    ticker: { availability: unavailable ? unsupported(unavailable) : supported(),
      prices: { last: definition.priceRoles?.last ?? supported(), bid: unsupported("not normalized"),
        ask: unsupported("not normalized"), mid: unsupported("not normalized"),
        mark: definition.priceRoles?.mark ?? supported(), index: definition.priceRoles?.index ?? supported() },
      stream: definition.tickerStream,
      fetch: async (symbols): Promise<TickerObservation[]> => {
        if (!deps) return no(); const [items, rows] = await Promise.all([metadata(symbols), deps.snapshots(symbols)]);
        const bySymbol = new Map(items.map((item) => [item.listing.providerSymbol, item]));
        return rows.flatMap((row) => { const item = bySymbol.get(row.symbol); return item ? [{
          canonicalInstrumentId: item.identity.canonicalId, providerSymbol: row.symbol, observedAt: row.observedAt,
          values: { ...(positive(row.last) !== undefined ? { last: positive(row.last) } : {}),
            ...(positive(row.mark) !== undefined ? { mark: positive(row.mark) } : {}),
            ...(positive(row.index) !== undefined ? { index: positive(row.index) } : {}) },
        }] : []; });
      } },
    trades: { support: "unsupported", reason: "trade tape is outside the X2 analytics seam" },
    orderBook: { support: "unsupported", reason: "order book is outside the X2 analytics seam" },
    derivativeMetadata: unavailable ? { support: "unsupported", reason: unavailable }
      : { support: "supported", fetch: metadata },
    derivatives: unavailable ? { support: "unsupported", reason: unavailable } : { support: "supported",
      snapshot: async (symbols) => { if (!deps) return no();
        const [items, rows] = await Promise.all([metadata(symbols), deps.snapshots(symbols)]);
        const bySymbol = new Map(items.map((item) => [item.listing.providerSymbol, item]));
        return rows.flatMap((row) => { const item = bySymbol.get(row.symbol); return item ? [observation(item, row)] : []; }); },
      fundingHistory: definition.fundingHistory.support === "unsupported" ? definition.fundingHistory : {
        support: "supported", fetch: async (symbol, startMs, endMs): Promise<FundingObservation[]> => {
          if (!deps) return no(); const item = (await metadata([symbol]))[0]; if (!item) return [];
          const unique = new Map<number, { rate: number; intervalMs: number; fundingAt: number }>();
          for (const row of await deps.fundingHistory(symbol, startMs, endMs)) {
            if (Number.isFinite(row.rate) && Number.isFinite(row.fundingAt) && row.intervalMs > 0 &&
              row.fundingAt >= startMs && row.fundingAt <= endMs) unique.set(row.fundingAt, row);
          }
          return [...unique.values()].sort((a, b) => a.fundingAt - b.fundingAt).map((row) => ({
            ...row, observedAt: row.fundingAt, canonicalInstrumentId: item.identity.canonicalId, providerSymbol: symbol,
          }));
        } }, stream: definition.derivativeStream },
    execution: { mutationBoundary: "bot_only", availability: { paper: false, testnet: false, live: false },
      directions: { long: false, short: false }, shortSale: { support: "unsupported", reason: "read-only derivative adapter" },
      leverage: { support: "unsupported", reason: "adapter-level execution is disabled; inspect instrument capability" },
      marginModes: [], reduceOnly: false, positionModes: [] },
  };
  return Object.freeze(adapter);
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const objects = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
const arrays = (value: unknown): unknown[][] => Array.isArray(value) ? value.filter(Array.isArray) as unknown[][] : [];
const num = (value: unknown): number => Number(value);
const instant = (value: unknown): string | undefined => {
  const numeric = num(value);
  const ms = Number.isFinite(numeric) && numeric > 0 ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : Date.parse(String(value ?? ""));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
};
const date = (value: unknown): string | undefined => instant(value)?.slice(0, 10);
async function json(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { ...init, signal, headers: { accept: "application/json", ...init.headers } });
  if (!response.ok) throw new Error(`official derivative API returned HTTP ${response.status}`);
  return response.json();
}
const candle = (symbol: string, interval: Interval, t: unknown, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown): Candle => ({
  symbol, interval, openTime: num(t), open: num(o), high: num(h), low: num(l), close: num(c), volume: num(v),
  closeTime: num(t) + INTERVAL_MS[interval] - 1,
});
const intervalCode = (provider: string, interval: Interval): string => {
  const minutes = INTERVAL_MS[interval] / 60_000;
  if (provider === "bybit") return interval === "1d" ? "D" : String(minutes);
  if (provider === "okx") return interval === "1d" ? "1D" : minutes >= 60 ? `${minutes / 60}H` : `${minutes}m`;
  if (provider === "kucoin") return String(minutes);
  if (provider === "gate") return interval;
  if (provider === "kraken") return interval === "1d" ? "1d" : minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
  return interval;
};

export function normalizeOkxDerivativeListing(x: Record<string, unknown>, type: "SWAP" | "FUTURES"):
NormalizedDerivativeListing {
  const underlying = String(x.uly).split("-");
  const base = String(underlying[0] ?? "");
  const quote = String(underlying[1] ?? "");
  const valueCurrency = String(x.ctValCcy).toUpperCase();
  return { symbol: String(x.instId), base, quote, settlement: String(x.settleCcy),
    kind: type === "SWAP" ? "perpetual" : "future",
    settlementMode: x.ctType === "inverse" ? "inverse" : "linear", contractSize: num(x.ctVal),
    contractSizeUnit: valueCurrency === quote.toUpperCase() ? "quote" : "base",
    multiplier: num(x.ctMult) || 1, quantityUnit: "contracts",
    expiry: date(x.expTime), expiryAt: instant(x.expTime), delivery: "cash",
    status: x.state === "live" ? "active" : x.state === "suspend" ? "halted" : "delisted",
    priceTick: num(x.tickSz), quantityLot: num(x.lotSz), minimumQuantity: num(x.minSz),
    marginModes: ["cross", "isolated"], positionModes: ["one_way", "hedge"], reduceOnly: true,
    maxLeverage: num(x.lever) };
}

export function normalizeKrakenDerivativeListing(x: Record<string, unknown>): NormalizedDerivativeListing {
  const symbol = String(x.symbol);
  const derived = String(x.underlying).replace(/^rr_/, "").split("usd")[0]!.toUpperCase();
  const base = String(x.base || (derived === "XBT" ? "BTC" : derived)).toUpperCase();
  const quote = String(x.quote || "USD").toUpperCase();
  const inverse = String(x.type).includes("inverse");
  const firstTier = objects(x.marginLevels)[0];
  const initialMargin = firstTier ? positive(firstTier.initialMargin) : undefined;
  return { symbol, base, quote, settlement: inverse ? base : quote,
    kind: symbol.startsWith("PI_") || symbol.startsWith("PF_") ? "perpetual" : "future",
    settlementMode: inverse ? "inverse" : "linear", contractSize: num(x.contractSize),
    contractSizeUnit: inverse ? "quote" : "base", multiplier: num(x.contractSize),
    quantityUnit: inverse ? "contracts" : "base",
    expiry: date(x.lastTradingTime), expiryAt: instant(x.lastTradingTime), delivery: "cash",
    status: x.tradeable ? "active" : x.isExpired ? "delisted" : "halted", priceTick: num(x.tickSize),
    quantityLot: 1, minimumQuantity: 1, maxLeverage: initialMargin ? 1 / initialMargin : undefined,
    marginModes: ["cross"], positionModes: ["one_way"], reduceOnly: true };
}

function fundingRows(rows: Array<{ rate: number; fundingAt: number }>, fallbackMs?: number):
Array<{ rate: number; intervalMs: number; fundingAt: number }> {
  const ordered = rows.filter((row) => Number.isFinite(row.rate) && Number.isFinite(row.fundingAt))
    .sort((a, b) => a.fundingAt - b.fundingAt);
  return ordered.flatMap((row, index) => {
    const adjacent = index > 0 ? row.fundingAt - ordered[index - 1]!.fundingAt
      : ordered[1] ? ordered[1].fundingAt - row.fundingAt : fallbackMs;
    return adjacent && adjacent > 0 ? [{ ...row, intervalMs: adjacent }] : [];
  });
}

function genericProductionDependencies(definition: OfficialDerivativeDefinition): OfficialDerivativeDependencies {
  const id = definition.id;
  if (id === "hyperliquid-perps") {
    const post = (body: Record<string, unknown>, signal?: AbortSignal) => json("https://api.hyperliquid.xyz/info",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal);
    let contexts = new Map<string, Record<string, unknown>>();
    const list = async (signal?: AbortSignal) => {
      const payload = await post({ type: "metaAndAssetCtxs" }, signal) as unknown[];
      const meta = record(payload[0]), rows = objects(payload[1]);
      const universe = objects(meta.universe); contexts = new Map(universe.map((row, i) => [String(row.name), rows[i] ?? {}]));
      return universe.map((row) => ({ symbol: String(row.name), base: String(row.name), quote: "USD", settlement: "USDC",
        kind: "perpetual" as const, settlementMode: "linear" as const, contractSize: 1,
        contractSizeUnit: "base" as const, multiplier: 1, quantityUnit: "base" as const,
        status: row.isDelisted ? "delisted" as const : "active" as const,
        quantityLot: 10 ** -num(row.szDecimals), maxLeverage: num(row.maxLeverage), marginModes: ["cross", "isolated"] as const,
        positionModes: ["one_way"] as const, reduceOnly: true }));
    };
    return { list,
      candles: async (symbol, interval, startMs, endMs, signal) => normalizeCandles(objects(await post({ type: "candleSnapshot",
        req: { coin: symbol, interval, startTime: startMs, endTime: endMs } }, signal)).map((x) =>
        candle(symbol, interval, x.t, x.o, x.h, x.l, x.c, x.v)), symbol, interval, startMs, endMs),
      snapshots: async (symbols, signal) => { await list(signal); const observedAt = Date.now(); return symbols.flatMap((symbol) => {
        const x = contexts.get(symbol); if (!x) return []; return [{ symbol, observedAt, mark: num(x.markPx),
          fundingRate: num(x.funding), fundingIntervalMs: 3_600_000,
          nextFundingAt: Math.floor(Date.now() / 3_600_000 + 1) * 3_600_000,
          openInterest: { value: num(x.openInterest), unit: "base" as const },
          volume24h: { value: num(x.dayNtlVlm), unit: "usd" as const } }]; }); },
      fundingHistory: async (symbol, startMs, endMs, signal) => objects(await post({ type: "fundingHistory", coin: symbol,
        startTime: startMs, endTime: endMs }, signal)).map((x) => ({ rate: num(x.fundingRate), intervalMs: 3_600_000, fundingAt: num(x.time) })) };
  }
  if (id === "okx-derivatives") return okxDependencies();
  if (id === "bybit-derivatives") return bybitDependencies();
  if (id === "gateio-derivatives") return gateDependencies();
  if (id === "kraken-derivatives") return krakenDependencies();
  if (id === "kucoin-derivatives") return kucoinDependencies();
  if (id === "binance-derivatives") return binanceDependencies();
  throw new Error(`no public production derivative client for ${id}`);
}

function binanceDependencies(): OfficialDerivativeDependencies {
  const family = new Map<string, "fapi" | "dapi">();
  const fundingIntervals = new Map<string, number>();
  const listFamily = async (host: "fapi" | "dapi", signal?: AbortSignal) => {
    const [exchangeInfo, fundingInfo] = await Promise.all([
      json(`https://${host}.binance.com/${host}/v1/exchangeInfo`, {}, signal),
      json(`https://${host}.binance.com/${host}/v1/fundingInfo`, {}, signal).catch(() => []),
    ]);
    for (const row of objects(fundingInfo)) fundingIntervals.set(String(row.symbol), num(row.fundingIntervalHours) * 3_600_000);
    const root = record(exchangeInfo);
    return objects(root.symbols).map((x) => { family.set(String(x.symbol), host); const inverse = host === "dapi";
      const filters = objects(x.filters), price = filters.find((f) => f.filterType === "PRICE_FILTER") ?? {},
        lot = filters.find((f) => f.filterType === "LOT_SIZE") ?? {};
      return { symbol: String(x.symbol), base: String(x.baseAsset), quote: String(x.quoteAsset), settlement: String(x.marginAsset),
        kind: x.contractType === "PERPETUAL" ? "perpetual" as const : "future" as const,
        settlementMode: inverse ? "inverse" as const : "linear" as const,
        contractSize: inverse ? num(x.contractSize) : 1, contractSizeUnit: inverse ? "quote" as const : "base" as const,
        multiplier: inverse ? num(x.contractSize) : 1, quantityUnit: inverse ? "contracts" as const : "base" as const,
        expiry: date(x.deliveryDate), expiryAt: instant(x.deliveryDate), delivery: "cash" as const,
        status: x.status === "TRADING" ? "active" as const : x.status === "PENDING_TRADING" ? "halted" as const : "delisted" as const,
        priceTick: num(price.tickSize), quantityLot: num(lot.stepSize), minimumQuantity: num(lot.minQty),
        fundingIntervalMs: fundingIntervals.get(String(x.symbol)) ?? 28_800_000,
        marginModes: ["cross", "isolated"] as const, positionModes: ["one_way", "hedge"] as const, reduceOnly: true };
    });
  };
  const hostFor = (symbol: string) => family.get(symbol) ?? (symbol.includes("_") ? "dapi" : "fapi");
  return { list: async (signal) => (await Promise.all([listFamily("fapi", signal), listFamily("dapi", signal)])).flat(),
    candles: (symbol, interval, startMs, endMs, signal) => pageByTime({ symbol, interval, startMs, endMs, pageSize: 1000, signal,
      fetchPage: async (from, to) => arrays(await json(`https://${hostFor(symbol)}.binance.com/${hostFor(symbol)}/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${from}&endTime=${to}&limit=1000`, {}, signal))
        .map((x) => candle(symbol, interval, x[0], x[1], x[2], x[3], x[4], x[5])) }),
    snapshots: async (symbols, signal) => Promise.all(symbols.map(async (symbol) => { const host = hostFor(symbol);
      const [premium, ticker, oi] = await Promise.all([
        json(`https://${host}.binance.com/${host}/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`, {}, signal),
        json(`https://${host}.binance.com/${host}/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {}, signal),
        json(`https://${host}.binance.com/${host}/v1/openInterest?symbol=${encodeURIComponent(symbol)}`, {}, signal)]);
      const p = record(premium), t = record(ticker), o = record(oi); return { symbol, observedAt: num(p.time) || Date.now(),
        last: num(t.lastPrice), mark: num(p.markPrice), index: num(p.indexPrice), fundingRate: num(p.lastFundingRate),
        fundingIntervalMs: fundingIntervals.get(symbol) ?? 28_800_000, nextFundingAt: num(p.nextFundingTime),
        openInterest: { value: num(o.openInterest), unit: "contracts" as const },
        volume24h: { value: num(t.volume), unit: host === "dapi" ? "contracts" as const : "base" as const } }; })),
    fundingHistory: async (symbol, startMs, endMs, signal) => fundingRows(objects(await json(`https://${hostFor(symbol)}.binance.com/${hostFor(symbol)}/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&startTime=${startMs}&endTime=${endMs}&limit=1000`, {}, signal))
      .map((x) => ({ rate: num(x.fundingRate), fundingAt: num(x.fundingTime) })), fundingIntervals.get(symbol) ?? 28_800_000) };
}

function bybitDependencies(): OfficialDerivativeDependencies {
  const category = new Map<string, "linear" | "inverse">();
  const fundingIntervals = new Map<string, number>();
  const listCategory = async (kind: "linear" | "inverse", signal?: AbortSignal) => {
    const out: NormalizedDerivativeListing[] = []; let cursor = "";
    do { const root = record(await json(`https://api.bybit.com/v5/market/instruments-info?category=${kind}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {}, signal));
      const result = record(root.result); for (const x of objects(result.list)) { category.set(String(x.symbol), kind);
        fundingIntervals.set(String(x.symbol), num(x.fundingInterval) * 60_000);
        const lot = record(x.lotSizeFilter), price = record(x.priceFilter), leverage = record(x.leverageFilter);
        out.push({ symbol: String(x.symbol), base: String(x.baseCoin), quote: String(x.quoteCoin), settlement: String(x.settleCoin),
          kind: x.contractType === "LinearPerpetual" || x.contractType === "InversePerpetual" ? "perpetual" : "future",
          settlementMode: kind, contractSize: 1, contractSizeUnit: kind === "inverse" ? "quote" : "base",
          multiplier: 1, quantityUnit: kind === "inverse" ? "quote" : "base",
          fundingIntervalMs: num(x.fundingInterval) * 60_000, expiry: date(x.deliveryTime), expiryAt: instant(x.deliveryTime), delivery: "cash",
          status: x.status === "Trading" ? "active" : x.status === "Settled" ? "delisted" : "halted",
          priceTick: num(price.tickSize), quantityLot: num(lot.qtyStep), minimumQuantity: num(lot.minOrderQty),
          maxLeverage: num(leverage.maxLeverage), marginModes: ["cross", "isolated"], positionModes: ["one_way", "hedge"], reduceOnly: true }); }
      cursor = String(result.nextPageCursor ?? "");
    } while (cursor); return out;
  };
  const cat = (symbol: string) => category.get(symbol) ?? "linear";
  return { list: async (signal) => (await Promise.all([listCategory("linear", signal), listCategory("inverse", signal)])).flat(),
    candles: (symbol, interval, startMs, endMs, signal) => pageByTime({ symbol, interval, startMs, endMs, pageSize: 1000, signal,
      fetchPage: async (from, to) => arrays(record(record(await json(`https://api.bybit.com/v5/market/kline?category=${cat(symbol)}&symbol=${encodeURIComponent(symbol)}&interval=${intervalCode("bybit", interval)}&start=${from}&end=${to}&limit=1000`, {}, signal)).result).list)
        .map((x) => candle(symbol, interval, x[0], x[1], x[2], x[3], x[4], x[5])) }),
    snapshots: async (symbols, signal) => Promise.all(symbols.map(async (symbol) => { const root = record(await json(`https://api.bybit.com/v5/market/tickers?category=${cat(symbol)}&symbol=${encodeURIComponent(symbol)}`, {}, signal));
      const x = objects(record(root.result).list)[0] ?? {}; return { symbol, observedAt: num(root.time) || Date.now(), last: num(x.lastPrice),
        mark: num(x.markPrice), index: num(x.indexPrice), fundingRate: num(x.fundingRate),
        fundingIntervalMs: fundingIntervals.get(symbol), nextFundingAt: num(x.nextFundingTime),
        openInterest: { value: num(x.openInterest), unit: cat(symbol) === "inverse" ? "usd" as const : "base" as const },
        volume24h: { value: num(x.volume24h), unit: cat(symbol) === "inverse" ? "quote" as const : "base" as const } }; })),
    fundingHistory: async (symbol, startMs, endMs, signal) => { const root = record(await json(`https://api.bybit.com/v5/market/funding/history?category=${cat(symbol)}&symbol=${encodeURIComponent(symbol)}&startTime=${startMs}&endTime=${endMs}&limit=200`, {}, signal));
      return fundingRows(objects(record(root.result).list).map((x) => ({ rate: num(x.fundingRate),
        fundingAt: num(x.fundingRateTimestamp) })), fundingIntervals.get(symbol)); } };
}

function okxDependencies(): OfficialDerivativeDependencies {
  const details = new Map<string, NormalizedDerivativeListing>();
  const underlyings = new Map<string, string>();
  const list = async (signal?: AbortSignal) => (await Promise.all(["SWAP", "FUTURES"].map(async (type) => {
    const root = record(await json(`https://www.okx.com/api/v5/public/instruments?instType=${type}`, {}, signal));
    return objects(root.data).map((x) => { const row = normalizeOkxDerivativeListing(x, type as "SWAP" | "FUTURES");
      details.set(row.symbol, row); underlyings.set(row.symbol, String(x.uly)); return row; }); }))).flat();
  return { list,
    candles: (symbol, interval, startMs, endMs, signal) => pageByTime({ symbol, interval, startMs, endMs, pageSize: 300, signal,
      fetchPage: async (from, to) => arrays(record(await json(`https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(symbol)}&bar=${intervalCode("okx", interval)}&after=${to + 1}&before=${Math.max(0, from - 1)}&limit=300`, {}, signal)).data)
        .map((x) => candle(symbol, interval, x[0], x[1], x[2], x[3], x[4], x[5])) }),
    snapshots: async (symbols, signal) => Promise.all(symbols.map(async (symbol) => {
      const underlying = underlyings.get(symbol);
      const [ticker, mark, indexTicker, oi, funding] = await Promise.all([
      json(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(symbol)}`, {}, signal),
      json(`https://www.okx.com/api/v5/public/mark-price?instType=${details.get(symbol)?.kind === "future" ? "FUTURES" : "SWAP"}&instId=${encodeURIComponent(symbol)}`, {}, signal),
      underlying ? json(`https://www.okx.com/api/v5/market/index-tickers?instId=${encodeURIComponent(underlying)}`, {}, signal)
        : Promise.resolve({ data: [] }),
      json(`https://www.okx.com/api/v5/public/open-interest?instType=${details.get(symbol)?.kind === "future" ? "FUTURES" : "SWAP"}&instId=${encodeURIComponent(symbol)}`, {}, signal),
      details.get(symbol)?.kind === "perpetual" ? json(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(symbol)}`, {}, signal) : Promise.resolve({ data: [] })]);
      const t = objects(record(ticker).data)[0] ?? {}, m = objects(record(mark).data)[0] ?? {},
        i = objects(record(indexTicker).data)[0] ?? {}, o = objects(record(oi).data)[0] ?? {},
        f = objects(record(funding).data)[0] ?? {};
      return { symbol, observedAt: num(t.ts) || Date.now(), last: num(t.last), mark: num(m.markPx), index: num(i.idxPx),
        fundingRate: num(f.fundingRate), fundingIntervalMs: num(f.nextFundingTime) - num(f.fundingTime), nextFundingAt: num(f.nextFundingTime),
        openInterest: { value: num(o.oi), unit: "contracts" as const, converted: { value: num(o.oiCcy), unit: "base" as const } },
        volume24h: { value: num(t.vol24h), unit: "contracts" as const, converted: { value: num(t.volCcy24h), unit: "base" as const } } }; })),
    fundingHistory: async (symbol, startMs, endMs, signal) => fundingRows(objects(record(await json(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${encodeURIComponent(symbol)}&before=${startMs - 1}&after=${endMs + 1}&limit=100`, {}, signal)).data)
      .map((x) => ({ rate: num(x.fundingRate), fundingAt: num(x.fundingTime) }))) };
}

function kucoinDependencies(): OfficialDerivativeDependencies {
  const details = new Map<string, Record<string, unknown>>();
  const list = async (signal?: AbortSignal) => objects(record(await json("https://api-futures.kucoin.com/api/v1/contracts/active", {}, signal)).data)
    .map((x) => { details.set(String(x.symbol), x); return ({ symbol: String(x.symbol), base: String(x.baseCurrency), quote: String(x.quoteCurrency), settlement: String(x.settleCurrency),
      kind: x.type === "FFWCSX" ? "perpetual" as const : "future" as const, settlementMode: x.isInverse ? "inverse" as const : "linear" as const,
      contractSize: num(x.multiplier), contractSizeUnit: x.isInverse ? "quote" as const : "base" as const,
      multiplier: num(x.multiplier), quantityUnit: "contracts" as const,
      fundingIntervalMs: num(x.fundingRateGranularity), expiry: date(x.expireDate), expiryAt: instant(x.expireDate), delivery: "cash" as const,
      status: x.status === "Open" ? "active" as const : "halted" as const, priceTick: num(x.tickSize), quantityLot: num(x.lotSize),
      minimumQuantity: num(x.lotSize), maxLeverage: num(x.maxLeverage), marginModes: ["cross", "isolated"] as const,
      positionModes: ["one_way"] as const, reduceOnly: true }); });
  return { list,
    candles: async (symbol, interval, startMs, endMs, signal) => normalizeCandles(arrays(record(await json(`https://api-futures.kucoin.com/api/v1/kline/query?symbol=${encodeURIComponent(symbol)}&granularity=${intervalCode("kucoin", interval)}&from=${startMs}&to=${endMs}`, {}, signal)).data)
      .map((x) => candle(symbol, interval, x[0], x[1], x[2], x[3], x[4], x[5])), symbol, interval, startMs, endMs),
    snapshots: async (symbols, signal) => Promise.all(symbols.map(async (symbol) => {
      const [tickerPayload, contractPayload] = await Promise.all([
        json(`https://api-futures.kucoin.com/api/v1/ticker?symbol=${encodeURIComponent(symbol)}`, {}, signal),
        json(`https://api-futures.kucoin.com/api/v1/contracts/${encodeURIComponent(symbol)}`, {}, signal),
      ]);
      const ticker = record(record(tickerPayload).data), x = record(record(contractPayload).data);
      details.set(symbol, x); return { symbol, observedAt: num(ticker.ts) / 1e6 || Date.now(), last: num(ticker.price),
        mark: num(x.markPrice), index: num(x.indexPrice), fundingRate: num(x.fundingFeeRate),
        fundingIntervalMs: num(x.fundingRateGranularity), nextFundingAt: num(x.nextFundingRateTime),
        openInterest: { value: num(x.openInterest), unit: "contracts" as const },
        volume24h: { value: num(x.volumeOf24h), unit: "contracts" as const } }; })),
    fundingHistory: async (symbol, startMs, endMs, signal) => fundingRows(objects(record(await json(
      `https://api-futures.kucoin.com/api/v1/contract/funding-rates?symbol=${encodeURIComponent(symbol)}&from=${startMs}&to=${endMs}`,
      {}, signal)).data).map((x) => ({ rate: num(x.fundingRate), fundingAt: num(x.timePoint ?? x.time) })),
      num(details.get(symbol)?.fundingRateGranularity) || undefined) };
}

function gateDependencies(): OfficialDerivativeDependencies {
  const settle = new Map<string, "usdt" | "btc">();
  const market = new Map<string, "futures" | "delivery">();
  const fundingIntervals = new Map<string, number>();
  const list = async (signal?: AbortSignal): Promise<NormalizedDerivativeListing[]> => {
    const groups = await Promise.all((["usdt", "btc"] as const).map(async (currency) => {
      const payload = await json(`https://api.gateio.ws/api/v4/futures/${currency}/contracts`, {}, signal);
      return objects(payload).map((x): NormalizedDerivativeListing => {
        settle.set(String(x.name), currency); market.set(String(x.name), "futures");
        fundingIntervals.set(String(x.name), num(x.funding_interval) * 1000);
        const pair = String(x.name).split("_");
        return { symbol: String(x.name), base: pair[0]!,
          quote: pair[1]!, settlement: currency.toUpperCase(), kind: "perpetual",
          settlementMode: x.type === "inverse" || currency === "btc" ? "inverse" : "linear",
          contractSize: num(x.quanto_multiplier) || 1,
          contractSizeUnit: x.type === "inverse" || currency === "btc" ? "quote" : "base",
          multiplier: num(x.quanto_multiplier) || 1, quantityUnit: "contracts",
          fundingIntervalMs: num(x.funding_interval) * 1000,
          status: x.in_delisting ? "delisted" : "active", priceTick: num(x.order_price_round), quantityLot: 1,
          minimumQuantity: num(x.order_size_min), maxLeverage: num(x.leverage_max),
          marginModes: ["cross", "isolated"], positionModes: ["one_way", "hedge"], reduceOnly: true };
      });
    }));
    const delivery = objects(await json("https://api.gateio.ws/api/v4/delivery/usdt/contracts", {}, signal))
      .map((x): NormalizedDerivativeListing => {
        const symbol = String(x.name), underlying = String(x.underlying || symbol).split("_");
        settle.set(symbol, "usdt"); market.set(symbol, "delivery");
        const inverse = x.type === "inverse";
        return { symbol, base: String(underlying[0]), quote: "USDT", settlement: "USDT", kind: "future",
          settlementMode: inverse ? "inverse" : "linear", contractSize: num(x.quanto_multiplier) || 1,
          contractSizeUnit: inverse ? "quote" : "base", multiplier: num(x.quanto_multiplier) || 1,
          quantityUnit: "contracts", expiry: date(x.expire_time), expiryAt: instant(x.expire_time), delivery: "cash",
          status: x.in_delisting ? "delisted" : "active", priceTick: num(x.order_price_round), quantityLot: 1,
          minimumQuantity: num(x.order_size_min), maxLeverage: num(x.leverage_max),
          marginModes: ["cross", "isolated"], positionModes: ["one_way"], reduceOnly: true };
      });
    return [...groups.flat(), ...delivery];
  };
  const currency = (symbol: string) => settle.get(symbol) ?? "usdt";
  const product = (symbol: string) => market.get(symbol) ?? "futures";
  return { list,
    candles: async (symbol, interval, startMs, endMs, signal) => normalizeCandles(objects(await json(`https://api.gateio.ws/api/v4/${product(symbol)}/${currency(symbol)}/candlesticks?contract=${encodeURIComponent(symbol)}&interval=${intervalCode("gate", interval)}&from=${Math.floor(startMs / 1000)}&to=${Math.floor(endMs / 1000)}`, {}, signal))
      .map((x) => candle(symbol, interval, num(x.t) * 1000, x.o, x.h, x.l, x.c, x.v)), symbol, interval, startMs, endMs),
    snapshots: async (symbols, signal) => Promise.all(symbols.map(async (symbol) => {
      const prefix = `${product(symbol)}/${currency(symbol)}`;
      const [contract, tickers] = await Promise.all([
        json(`https://api.gateio.ws/api/v4/${prefix}/contracts/${encodeURIComponent(symbol)}`, {}, signal),
        product(symbol) === "delivery" ? json(`https://api.gateio.ws/api/v4/${prefix}/tickers?contract=${encodeURIComponent(symbol)}`, {}, signal) : Promise.resolve([]),
      ]);
      const x = record(contract), ticker = objects(tickers).find((row) => row.contract === symbol) ?? {};
      const perpetual = product(symbol) === "futures";
      return { symbol, observedAt: Date.now(), last: num(x.last_price ?? ticker.last), mark: num(x.mark_price ?? ticker.mark_price),
        index: num(x.index_price ?? ticker.index_price),
        ...(perpetual ? { fundingRate: num(x.funding_rate), fundingIntervalMs: num(x.funding_interval) * 1000,
          nextFundingAt: num(x.funding_next_apply) * 1000 } : {}),
        openInterest: { value: num(x.position_size ?? ticker.total_size), unit: "contracts" as const },
        volume24h: { value: num(x.volume_24h ?? ticker.volume_24h), unit: "contracts" as const },
        maintenanceMarginRate: num(x.maintenance_rate), riskLimit: { value: num(x.risk_limit_base), unit: "quote" as const } }; })),
    fundingHistory: async (symbol, startMs, endMs, signal) => fundingRows(objects(await json(`https://api.gateio.ws/api/v4/futures/${currency(symbol)}/funding_rate?contract=${encodeURIComponent(symbol)}&limit=1000`, {}, signal))
      .map((x) => ({ rate: num(x.r), fundingAt: num(x.t) * 1000 })), fundingIntervals.get(symbol))
      .filter((x) => x.fundingAt >= startMs && x.fundingAt <= endMs) };
}

function krakenDependencies(): OfficialDerivativeDependencies {
  const instruments = new Map<string, NormalizedDerivativeListing>();
  const liquidation = new Map<string, { maintenanceMarginRate?: number; riskLimit?: { value: number; unit: "contracts" } }>();
  const list = async (signal?: AbortSignal) => { const rows = objects(record(await json("https://futures.kraken.com/derivatives/api/v3/instruments", {}, signal)).instruments)
      .filter((x) => x.tradfi !== true);
    return rows.map((x) => { const row = normalizeKrakenDerivativeListing(x), symbol = row.symbol;
      const firstTier = objects(x.marginLevels)[0]; liquidation.set(symbol, {
        ...(firstTier && Number.isFinite(num(firstTier.maintenanceMargin))
          ? { maintenanceMarginRate: num(firstTier.maintenanceMargin) } : {}),
        ...(Number.isFinite(num(x.maxPositionSize)) && num(x.maxPositionSize) > 0
          ? { riskLimit: { value: num(x.maxPositionSize), unit: "contracts" as const } } : {}),
      }); instruments.set(symbol, row); return row; }); };
  return { list,
    candles: async (symbol, interval, startMs, endMs, signal) => normalizeCandles(objects(record(await json(`https://futures.kraken.com/api/charts/v1/trade/${encodeURIComponent(symbol)}/${intervalCode("kraken", interval)}?from=${Math.floor(startMs / 1000)}&to=${Math.floor(endMs / 1000)}`, {}, signal)).candles)
      .map((x) => candle(symbol, interval, num(x.time) * 1000, x.open, x.high, x.low, x.close, x.volume)), symbol, interval, startMs, endMs),
    snapshots: async (symbols, signal) => { const rows = objects(record(await json("https://futures.kraken.com/derivatives/api/v3/tickers", {}, signal)).tickers);
      const wanted = new Set(symbols); return rows.filter((x) => wanted.has(String(x.symbol))).map((x) => {
        const inverse = instruments.get(String(x.symbol))?.settlementMode === "inverse";
        return ({ symbol: String(x.symbol), observedAt: Date.now(),
        last: num(x.last), mark: num(x.markPrice), index: num(x.indexPrice),
        openInterest: { value: num(x.openInterest), unit: inverse ? "contracts" as const : "base" as const },
        volume24h: { value: num(x.vol24h), unit: inverse ? "contracts" as const : "base" as const }, ...liquidation.get(String(x.symbol)) }); }); },
    fundingHistory: async (symbol, startMs, endMs, signal) => fundingRows(objects(record(await json(
      `https://futures.kraken.com/derivatives/api/v4/historicalfundingrates?symbol=${encodeURIComponent(symbol)}`,
      {}, signal)).rates).map((x) => ({ rate: num(x.relativeFundingRate), fundingAt: Date.parse(String(x.timestamp)) }))
      .filter((x) => x.fundingAt >= startMs && x.fundingAt <= endMs), 3_600_000) };
}

export const officialDerivativeAdapters: readonly MarketDataProviderAdapter[] = Object.freeze(
  OFFICIAL_DERIVATIVE_DEFINITIONS.map((definition) => createOfficialDerivativeAdapter(definition,
    definition.unavailableReason ? undefined : genericProductionDependencies(definition))),
);
