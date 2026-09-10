import type { Candle, Interval } from "../types/market";
import {
  MARKET_CONTRACT_VERSION, UNKNOWN_COMPLIANCE, canonicalInstrumentId, knownNumber,
  supported, unsupported, unknownNumber, type CanonicalInstrument, type PrecisionRules,
} from "./model";
import type {
  EquityCorporateAction, MarketCalendarDay,
  MarketDataProviderAdapter, ProviderDocumentationSource, TickerObservation,
} from "./provider";
import {
  expectedEquityBars, filterEquitySessionBars, replayCorporateActions, validateMarketCalendar,
} from "./usEquities";
import { config } from "../config";
import { createAlpacaHttpDependencies, loadAlpacaEquityClassifications } from "./alpacaEquitiesHttp";

export interface NormalizedAlpacaAsset {
  symbol: string;
  name: string;
  exchange: "NASDAQ" | "NYSE" | "ARCA" | "AMEX" | "BATS";
  securityType: "stock" | "etf";
  classificationSource: string;
  status: "active" | "inactive";
  tradable: boolean;
  fractionable: boolean;
  shortable?: boolean;
  /** Current official field. `easy_to_borrow` is deprecated after 2026-09-22. */
  borrowStatus?: "easy_to_borrow" | "hard_to_borrow";
  mic?: string;
}

export interface NormalizedAlpacaTicker {
  symbol: string;
  observedAt: number;
  last: number;
}

export interface AlpacaEquityDependencies {
  list(signal?: AbortSignal): Promise<NormalizedAlpacaAsset[]>;
  bars(symbol: string, interval: Interval, startMs: number, endMs: number,
    feed: string, signal?: AbortSignal): Promise<Candle[]>;
  tickers(symbols: readonly string[], feed: string, signal?: AbortSignal): Promise<NormalizedAlpacaTicker[]>;
  calendar(startDate: string, endDate: string, signal?: AbortSignal): Promise<MarketCalendarDay[]>;
  corporateActions(symbol: string, canonicalId: string, startDate: string, endDate: string,
    signal?: AbortSignal): Promise<EquityCorporateAction[]>;
}

export const ALPACA_EQUITY_VENUES = Object.freeze(["NASDAQ", "NYSE", "ARCA", "AMEX", "BATS"] as const);
export const ALPACA_EQUITY_RESOLUTIONS = Object.freeze(["1m", "5m", "15m", "1h", "1d"] as const);

const DOCUMENTATION: readonly ProviderDocumentationSource[] = Object.freeze([
  { title: "Alpaca Market Data API subscriptions", url: "https://docs.alpaca.markets/docs/about-market-data-api",
    accessedOn: "2026-09-10", covers: ["catalog", "ticker", "candles", "ticker_stream", "candle_stream"],
    access: "authentication_required", limits: [
      "Trading API Basic is real-time IEX only for equities", "Basic historical access excludes the latest 15 minutes",
      "All market-data endpoints except historical crypto require authentication",
    ] },
  { title: "Alpaca historical stock bars", url: "https://docs.alpaca.markets/reference/stockbars",
    accessedOn: "2026-09-10", covers: ["candles"], access: "authentication_required", limits: [
      "Adjustment defaults to raw; split, dividend and all are explicit modes",
      "Feed must be explicit: IEX is single-venue and SIP is consolidated/entitlement-gated",
    ] },
  { title: "Alpaca market calendar", url: "https://docs.alpaca.markets/reference/calendar-2",
    accessedOn: "2026-09-10", covers: ["calendar"], access: "authentication_required",
    limits: ["Calendar publishes exact opens and closes including early closures"] },
  { title: "Alpaca corporate actions", url: "https://docs.alpaca.markets/reference/corporateactions-1",
    accessedOn: "2026-09-10", covers: ["corporate_actions"], access: "authentication_required", limits: [
      "Complete quality omits incomplete events", "Provider warns creation and processing can be delayed",
    ] },
  { title: "Alpaca assets", url: "https://docs.alpaca.markets/reference/get-v2-assets-symbol_or_asset_id",
    accessedOn: "2026-09-10", covers: ["metadata"], access: "authentication_required", limits: [
      "shortable is asset-specific", "borrow_status replaces deprecated easy_to_borrow",
      "Asset payload does not distinguish common stock from ETF; classification provenance is separately required",
    ] },
  { title: "Alpaca paper trading", url: "https://docs.alpaca.markets/docs/paper-trading",
    accessedOn: "2026-09-10", covers: ["paper_orders"], access: "authentication_required", limits: [
      "Paper has separate credentials and paper-api endpoint", "Simulation omits market impact, queue position and dividends",
    ] },
]);

const precision = (row: NormalizedAlpacaAsset): PrecisionRules => ({
  priceTick: unknownNumber("US equity price increment is price-dependent ($0.01 at/above $1; $0.0001 below $1)"),
  quantityLot: row.fractionable ? unknownNumber("asset is fractionable but catalog does not publish a fractional quantity step")
    : knownNumber(1, "whole-share lot"),
  minimumQuantity: row.fractionable ? unknownNumber("official asset metadata does not publish minimum fractional quantity")
    : knownNumber(1, "whole-share minimum"),
  minimumNotional: unknownNumber("official asset metadata does not publish one static minimum notional"),
  priceDecimals: unknownNumber("price decimals depend on whether price is below $1"),
  quantityDecimals: row.fractionable ? unknownNumber("fractional precision is order-dependent")
    : { state: "known", value: 0 },
});

function instrument(providerId: string, row: NormalizedAlpacaAsset): CanonicalInstrument {
  const identity = { canonicalId: "", venueId: row.exchange, assetClass: "equity" as const,
    instrumentType: row.securityType, baseAsset: row.symbol.toUpperCase(), quoteAsset: "USD",
    settlementAsset: "USD", series: { kind: "cash" as const } };
  identity.canonicalId = canonicalInstrumentId(identity);
  const hasBorrowTruth = row.shortable === true && row.borrowStatus !== undefined;
  return {
    contractVersion: MARKET_CONTRACT_VERSION, identity,
    listing: { providerId, providerSymbol: row.symbol.toUpperCase(),
      status: row.status === "active" && row.tradable ? "active" : "halted" },
    currency: "USD", precision: precision(row), derivative: { kind: "none" },
    sessions: { kind: "calendar", timezone: "America/New_York", calendarId: "US_EQUITIES",
      supports24x7: false, weeklySessions: [{ days: [1, 2, 3, 4, 5], open: "09:30", close: "16:00" }] },
    prices: { last: supported(), bid: unsupported("latest-trade seam does not provide bid"),
      ask: unsupported("latest-trade seam does not provide ask"),
      mid: unsupported("bid and ask are unavailable"), mark: unsupported("cash equities have no mark price"),
      index: unsupported("cash equities have no index price") },
    events: { corporateActions: { support: "supported", eventTypes: ["split", "dividend", "symbol_change", "merger"] },
      funding: { support: "unsupported", reason: "cash equities do not fund" },
      openInterest: { support: "unsupported", reason: "cash equities have no derivative open interest" } },
    execution: { mutationBoundary: "bot_only", availability: { paper: row.tradable, testnet: false, live: false },
      directions: { long: row.tradable, short: hasBorrowTruth },
      shortSale: hasBorrowTruth
        ? { support: "supported", borrowRequired: true, availabilityCheckRequired: true }
        : { support: "unsupported", reason: row.shortable === false ? "Alpaca asset says not shortable"
          : "shortability/borrow_status is absent or unknown; never assume borrow" },
      leverage: { support: "unsupported", reason: "X4 does not enable margin/leverage" },
      marginModes: ["cash"], reduceOnly: false, positionModes: ["one_way"] },
    compliance: UNKNOWN_COMPLIANCE,
    equity: { securityType: row.securityType, classificationSource: row.classificationSource,
      primaryListing: { venueId: row.exchange, mic: row.mic ?? null },
      fractional: row.fractionable ? supported() : unsupported("Alpaca asset says not fractionable"),
      marketData: { defaultFeed: "iex", feedEntitlement: "alpaca_trading_api_basic",
        feedCoverage: "single_venue", feedDelaySeconds: 0, historicalEmbargoSeconds: 900,
        defaultAdjustment: "raw", executionPriceAdjustment: "raw", defaultSession: "regular",
        extendedHours: supported(), overnight: unsupported("BOATS is a distinct feed and is not mixed into IEX charts") },
      borrow: { shortable: row.shortable === true ? "yes" : row.shortable === false ? "no" : "unknown",
        status: row.borrowStatus ?? "unknown", availabilityCheckRequired: true,
        source: "Alpaca Assets shortable + borrow_status; recheck before every short order" } },
  };
}

export function createAlpacaUsEquityAdapter(deps: AlpacaEquityDependencies,
  options: { id?: string; access?: MarketDataProviderAdapter["access"] } = {}): MarketDataProviderAdapter {
  const id = options.id ?? "alpaca-us-equities";
  let cached: NormalizedAlpacaAsset[] | null = null;
  const list = async () => cached ??= (await deps.list()).filter((row) =>
    ALPACA_EQUITY_VENUES.includes(row.exchange) && /^[A-Z][A-Z0-9.-]{0,14}$/i.test(row.symbol));
  const instruments = async () => (await list()).map((row) => instrument(id, row));
  const actions = async (item: CanonicalInstrument, startDate: string, endDate: string, signal?: AbortSignal) =>
    deps.corporateActions(item.listing.providerSymbol, item.identity.canonicalId, startDate, endDate, signal);
  const equities: NonNullable<MarketDataProviderAdapter["equities"]> = {
    adjustmentModes: ["raw", "split", "dividend", "all"], sessionModes: ["regular", "extended", "all"],
    defaultAdjustment: "raw", defaultSession: "regular", executionPriceAdjustment: "raw",
    calendar: { timezone: "America/New_York", source: "Alpaca /v2/calendar",
      days: async (startDate, endDate) => validateMarketCalendar(await deps.calendar(startDate, endDate)) },
    corporateActions: ({ instrument: item, startDate, endDate, signal }) => actions(item, startDate, endDate, signal),
    fetchCandles: async ({ instrument: item, interval, startMs, endMs, adjustment, session, feed, signal }) => {
      if (feed !== "iex") throw new Error("only the explicitly modeled Alpaca Basic IEX entitlement is enabled");
      if (!(ALPACA_EQUITY_RESOLUTIONS as readonly Interval[]).includes(interval)) {
        throw new Error(`Alpaca equities do not support ${interval}`);
      }
      const startDate = new Date(startMs).toISOString().slice(0, 10);
      const endDate = new Date(endMs).toISOString().slice(0, 10);
      const days = validateMarketCalendar(await deps.calendar(startDate, endDate, signal));
      const raw = await deps.bars(item.listing.providerSymbol, interval, startMs, endMs, feed, signal);
      const selected = filterEquitySessionBars(raw, session, days);
      const corporateActions = adjustment === "raw" ? [] : await actions(item, startDate, endDate, signal);
      const replay = replayCorporateActions(selected, corporateActions, adjustment);
      const expectedBars = expectedEquityBars(days, interval, startMs, endMs, session);
      const presentBars = new Set(replay.bars.map((bar) => bar.openTime)).size;
      return { bars: replay.bars, adjustmentMode: adjustment, sessionMode: session,
        phasesIncluded: session === "regular" ? ["regular"] : session === "extended" ? ["pre", "after"] : ["pre", "regular", "after"],
        feed: { id: "iex", entitlement: "alpaca_trading_api_basic", coverage: "single_venue",
          delaySeconds: 0, historicalEmbargoSeconds: 900 },
        executionCompatible: adjustment === "raw",
        studies: { regularSessionOnly: session === "regular", extendedHoursIncluded: session !== "regular" },
        completeness: { complete: presentBars >= expectedBars, expectedBars, presentBars,
          missingBars: Math.max(0, expectedBars - presentBars), closedSessionGapsIgnored: true },
        corporateActionIds: replay.actionIds };
    },
  };
  const adapter: MarketDataProviderAdapter = {
    id, label: "Alpaca U.S. Equities", venueIds: ALPACA_EQUITY_VENUES,
    access: options.access ?? { mode: "authentication_required", proof: "official_contract_only",
      reason: "separate Alpaca paper/data credentials and licensed stock/ETF classification are not configured" },
    documentation: DOCUMENTATION, healthPolicy: { staleAfterMs: 60_000, unavailableAfterFailures: 3 },
    rateLimits: { buckets: [{ id: "alpaca-basic", limit: { kind: "fixed", requests: 200 }, windowMs: 60_000 }],
      retry: { maxAttempts: 3, baseDelayMs: 250, maximumDelayMs: 2_000, retryableStatuses: [429, 500, 502, 503, 504] } },
    catalog: { availability: supported(), list: instruments, metadata: async (symbols) => {
      const wanted = new Set(symbols.map((symbol) => symbol.toUpperCase()));
      // Execution callers use metadata for a per-order Assets refresh. Keep the
      // broad catalog cached for search, but never reuse that cache as current
      // listing/shortability/borrow truth.
      return (await deps.list()).filter((row) => ALPACA_EQUITY_VENUES.includes(row.exchange)
        && /^[A-Z][A-Z0-9.-]{0,14}$/i.test(row.symbol) && wanted.has(row.symbol.toUpperCase()))
        .map((row) => instrument(id, row));
    } },
    candles: { availability: supported(), resolutions: ALPACA_EQUITY_RESOLUTIONS,
      pagination: { maxPageSize: 10_000, direction: "forward" },
      stream: { support: "unsupported", reason: "authenticated IEX stream handshake is UNVERIFIED and disabled" },
      fetch: async (symbol, interval, startMs, endMs, signal) => {
        const item = (await instruments()).find((candidate) => candidate.listing.providerSymbol === symbol);
        if (!item) return [];
        return (await equities.fetchCandles({ instrument: item, interval, startMs, endMs,
          adjustment: "raw", session: "regular", feed: "iex", signal })).bars;
      } },
    ticker: { availability: supported(), prices: { last: supported(), bid: unsupported("latest-trade seam"),
      ask: unsupported("latest-trade seam"), mid: unsupported("latest-trade seam"),
      mark: unsupported("cash equity"), index: unsupported("cash equity") },
      stream: { support: "unsupported", reason: "authenticated IEX stream handshake is UNVERIFIED and disabled" },
      fetch: async (symbols): Promise<TickerObservation[]> => {
        const bySymbol = new Map((await instruments()).map((item) => [item.listing.providerSymbol, item.identity.canonicalId]));
        return (await deps.tickers(symbols, "iex")).flatMap((row) => {
          const canonicalInstrumentId = bySymbol.get(row.symbol.toUpperCase());
          return canonicalInstrumentId && Number.isFinite(row.last)
            ? [{ canonicalInstrumentId, providerSymbol: row.symbol.toUpperCase(), observedAt: row.observedAt, values: { last: row.last } }]
            : [];
        });
      } },
    trades: { support: "unsupported", reason: "X4 chart/search contract does not expose raw equity trades" },
    orderBook: { support: "unsupported", reason: "Alpaca Basic IEX order book is not modeled" },
    derivativeMetadata: { support: "unsupported", reason: "cash equities are not derivatives" },
    derivatives: { support: "unsupported", reason: "cash equities have no derivative analytics" }, equities,
    execution: { mutationBoundary: "bot_only", availability: { paper: true, testnet: false, live: false },
      directions: { long: true, short: false }, shortSale: { support: "unsupported", reason: "instrument-specific asset metadata is required" },
      leverage: { support: "unsupported", reason: "X4 does not enable leverage" }, marginModes: ["cash"],
      reduceOnly: false, positionModes: ["one_way"] },
  };
  return Object.freeze(adapter);
}

const unavailable = async (): Promise<never> => {
  throw new Error("Alpaca stock/ETF adapter is configured against official contracts but credentials/classification are unavailable (UNVERIFIED)");
};

function configuredAlpacaAdapter(): MarketDataProviderAdapter {
  const ready = Boolean(config.alpacaPaperApiKey && config.alpacaPaperApiSecret && config.alpacaEquityClassificationFile);
  if (!ready) return createAlpacaUsEquityAdapter({
    list: unavailable, bars: unavailable, tickers: unavailable, calendar: unavailable, corporateActions: unavailable,
  });
  const classifications = loadAlpacaEquityClassifications(config.alpacaEquityClassificationFile);
  return createAlpacaUsEquityAdapter(createAlpacaHttpDependencies({
    apiKey: config.alpacaPaperApiKey, apiSecret: config.alpacaPaperApiSecret, classifications,
  }), { access: { mode: "authentication_required", proof: "official_contract_only",
    reason: "official paper/data credentials are configured; external handshake is observed only on a runtime request" } });
}

/** Registered declaration; deterministic fixtures inject the same contract in CI. */
export const alpacaUsEquityAdapter = configuredAlpacaAdapter();
