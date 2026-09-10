import type { Candle, Interval } from "../types/market";
import {
  MARKET_CONTRACT_VERSION, UNKNOWN_COMPLIANCE, canonicalInstrumentId, knownNumber, supported,
  unknownNumber, type CanonicalInstrument, type ExecutionCapabilities,
} from "./model";
import type { MarketDataProviderAdapter, ProviderDocumentationSource } from "./provider";

const ACCESSED = "2026-09-10";
const unavailable = async (): Promise<never> => {
  throw new Error("credentialed provider handshake is UNVERIFIED_DISABLED; no fixture is served as current market data");
};
const no = (reason: string) => ({ support: "unsupported" as const, reason });
const events = (openInterest = false) => ({
  corporateActions: no("not applicable to this instrument type"),
  funding: no("funding is not a canonical market-data event for this instrument"),
  openInterest: openInterest ? { support: "supported" as const, historical: false, stream: true }
    : no("provider adapter does not expose open interest"),
});
const paperDirections = (enabled: boolean): ExecutionCapabilities => ({
  mutationBoundary: "bot_only", availability: { paper: enabled, testnet: false, live: false },
  directions: { long: enabled, short: enabled },
  shortSale: enabled ? { support: "supported", borrowRequired: false, availabilityCheckRequired: false }
    : no("read-only instrument"),
  leverage: no("account margin is provider/account-specific and is never inferred"),
  marginModes: enabled ? ["cross"] : [], reduceOnly: false, positionModes: ["one_way"],
});
const price = (tick: number, qty = 1) => ({ priceTick: knownNumber(tick, "missing tick"),
  quantityLot: knownNumber(qty, "missing lot"), minimumQuantity: knownNumber(qty, "missing minimum"),
  minimumNotional: unknownNumber("provider/account-specific"),
  priceDecimals: unknownNumber("derived presentation only; tick is authoritative"),
  quantityDecimals: { state: "known" as const, value: 0 } });

const OANDA_DOCS: readonly ProviderDocumentationSource[] = Object.freeze([
  { title: "OANDA v20 Instrument", url: "https://developer.oanda.com/rest-live-v20/instrument-df/",
    accessedOn: ACCESSED, covers: ["catalog", "metadata", "candles"], access: "authentication_required",
    limits: ["Candles select midpoint, bid, ask, or combinations; default is midpoint", "Pricing is account-specific OTC dealer data"] },
  { title: "OANDA v20 Pricing", url: "https://developer.oanda.com/rest-live-v20/pricing-ep/",
    accessedOn: ACCESSED, covers: ["ticker", "ticker_stream"], access: "authentication_required",
    limits: ["Prices expose closeout bid/ask and tradeable status; this is not a consolidated FX tape"] },
  { title: "OANDA v20 Order", url: "https://developer.oanda.com/rest-live-v20/order-ep/",
    accessedOn: ACCESSED, covers: ["paper_orders"], access: "authentication_required",
    limits: ["Practice and live REST environments are distinct", "X5 compiles only the practice host"] },
  { title: "OANDA trading hours", url: "https://www.oanda.com/us-en/trading/hours-of-operation/",
    accessedOn: ACCESSED, covers: ["calendar"], access: "public",
    limits: ["Forex trades Sunday-Friday 17:05-16:59 New York time with a daily six-minute break", "Holiday hours can differ"] },
  { title: "OANDA financing fees", url: "https://www.oanda.com/us-en/trading/financing-fees/",
    accessedOn: ACCESSED, covers: ["metadata"], access: "public",
    limits: ["Financing is provider/account/instrument dependent and may include multi-day weekend treatment"] },
]);

function fx(providerId: string, symbol: string, base: string, quote: string, pipSize: number): CanonicalInstrument {
  const identity = { canonicalId: "", venueId: "OANDA", assetClass: "fx" as const,
    instrumentType: "fx_pair" as const, baseAsset: base, quoteAsset: quote, settlementAsset: quote,
    series: { kind: "cash" as const } };
  identity.canonicalId = canonicalInstrumentId(identity);
  return { contractVersion: MARKET_CONTRACT_VERSION, identity,
    listing: { providerId, providerSymbol: symbol, status: "active" }, currency: quote,
    precision: { ...price(pipSize), quantityLot: knownNumber(1, "one unit"), minimumQuantity: knownNumber(1, "one unit") },
    derivative: { kind: "none" }, sessions: { kind: "calendar", timezone: "America/New_York",
      calendarId: "OANDA_FX_WEEK", supports24x7: false,
      weeklySessions: [{ days: [0], open: "17:05", close: "24:00" },
        { days: [1, 2, 3, 4], open: "00:00", close: "16:59" },
        { days: [1, 2, 3, 4], open: "17:05", close: "24:00" },
        { days: [5], open: "00:00", close: "16:59" }] },
    prices: { last: no("OTC FX has no centralized consolidated last trade"), bid: supported(), ask: supported(),
      mid: supported(), mark: no("no canonical mark"), index: no("no canonical index") },
    events: events(), execution: paperDirections(true), compliance: UNKNOWN_COMPLIANCE,
    fx: { baseCurrency: base, quoteCurrency: quote, marketStructure: "otc_provider_quote",
      defaultPriceBasis: "mid", supportedPriceBases: ["bid", "ask", "mid"], pipSize,
      rollover: { capability: "provider_dependent", boundaryTime: "17:00", timezone: "America/New_York" },
      feed: { status: "demo_practice", label: "OANDA v20 practice (authentication required)", delaySeconds: null } } };
}

const OANDA_ID = "oanda-v20-fx-practice";
const OANDA_FX = Object.freeze([
  fx(OANDA_ID, "EUR_USD", "EUR", "USD", 0.0001), fx(OANDA_ID, "GBP_USD", "GBP", "USD", 0.0001),
  fx(OANDA_ID, "USD_JPY", "USD", "JPY", 0.01),
]);

export const oandaFxPracticeAdapter: MarketDataProviderAdapter = {
  id: OANDA_ID, label: "OANDA FX · practice", venueIds: ["OANDA"],
  healthPolicy: { staleAfterMs: 15_000, unavailableAfterFailures: 3 },
  rateLimits: { buckets: [{ id: "oanda-account", limit: { kind: "provider_reported", source: "response headers/account" }, windowMs: 1_000 }],
    retry: { maxAttempts: 3, baseDelayMs: 250, maximumDelayMs: 2_000, retryableStatuses: [429, 500, 502, 503, 504] } },
  access: { mode: "authentication_required", proof: "official_contract_only", reason: "practice token/account not configured; external handshake UNVERIFIED_DISABLED" },
  documentation: OANDA_DOCS,
  catalog: { availability: supported(), list: async () => [...OANDA_FX], metadata: async (symbols) => OANDA_FX.filter((row) => symbols.includes(row.listing.providerSymbol)) },
  candles: { availability: no("practice authentication required"), resolutions: ["1m", "5m", "15m", "1h", "1d"],
    pagination: { maxPageSize: 5000, direction: "backward" }, stream: { support: "unsupported", reason: "OANDA candle stream is not modeled" },
    fetch: unavailable as (symbol: string, interval: Interval, start: number, end: number, signal?: AbortSignal) => Promise<Candle[]> },
  ticker: { availability: no("practice authentication required"), prices: OANDA_FX[0]!.prices,
    fetch: unavailable, stream: { support: "unsupported", reason: "practice token/account required" } },
  trades: no("OTC quote feed is not represented as centralized trades"), orderBook: no("OANDA liquidity ladder is not modeled as a consolidated order book"),
  derivativeMetadata: no("spot FX has no futures terms"), derivatives: no("spot FX has no funding/OI analytics"),
  execution: paperDirections(true),
};

interface FutureSpec { venue: "NYMEX" | "COMEX" | "CME"; root: string; code: string; month: string; expiry: string;
  firstTrade: string | null; firstNotice: string | null; lastDelivery: string | null; multiplier: number; tick: number;
  assetClass: "commodity" | "index"; chain: "front" | "next" | "other"; delivery: "cash" | "physical" }

const IBKR_ID = "ibkr-tws-futures-paper";
const FUTURES: readonly FutureSpec[] = Object.freeze([
  { venue: "NYMEX", root: "CL", code: "CLV26", month: "2026-10", expiry: "2026-09-22", firstTrade: null, firstNotice: "2026-09-24", lastDelivery: "2026-10-31", multiplier: 1000, tick: 0.01, assetClass: "commodity", chain: "front", delivery: "physical" },
  { venue: "NYMEX", root: "CL", code: "CLX26", month: "2026-11", expiry: "2026-10-20", firstTrade: null, firstNotice: "2026-10-22", lastDelivery: "2026-11-30", multiplier: 1000, tick: 0.01, assetClass: "commodity", chain: "next", delivery: "physical" },
  { venue: "NYMEX", root: "CL", code: "CLZ26", month: "2026-12", expiry: "2026-11-20", firstTrade: null, firstNotice: "2026-11-23", lastDelivery: "2026-12-31", multiplier: 1000, tick: 0.01, assetClass: "commodity", chain: "other", delivery: "physical" },
  { venue: "COMEX", root: "GC", code: "GCZ26", month: "2026-12", expiry: "2026-12-29", firstTrade: null, firstNotice: "2026-11-30", lastDelivery: "2026-12-31", multiplier: 100, tick: 0.10, assetClass: "commodity", chain: "front", delivery: "physical" },
  { venue: "NYMEX", root: "NG", code: "NGV26", month: "2026-10", expiry: "2026-09-28", firstTrade: null, firstNotice: null, lastDelivery: "2026-10-31", multiplier: 10000, tick: 0.001, assetClass: "commodity", chain: "front", delivery: "physical" },
  { venue: "CME", root: "ES", code: "ESZ26", month: "2026-12", expiry: "2026-12-18", firstTrade: null, firstNotice: null, lastDelivery: null, multiplier: 50, tick: 0.25, assetClass: "index", chain: "front", delivery: "cash" },
  { venue: "CME", root: "NQ", code: "NQZ26", month: "2026-12", expiry: "2026-12-18", firstTrade: null, firstNotice: null, lastDelivery: null, multiplier: 20, tick: 0.25, assetClass: "index", chain: "front", delivery: "cash" },
]);

function future(spec: FutureSpec): CanonicalInstrument {
  const identity = { canonicalId: "", venueId: spec.venue, assetClass: spec.assetClass,
    instrumentType: "future" as const, baseAsset: spec.root, quoteAsset: "USD", settlementAsset: "USD",
    series: { kind: "dated" as const, expiry: spec.expiry, delivery: spec.delivery } };
  identity.canonicalId = canonicalInstrumentId(identity);
  return { contractVersion: MARKET_CONTRACT_VERSION, identity,
    listing: { providerId: IBKR_ID, providerSymbol: `${spec.root}|FUT|${spec.venue}|${spec.month.replace("-", "")}`,
      status: "active" }, currency: "USD", precision: price(spec.tick),
    derivative: { kind: "contract", contractSize: { value: spec.multiplier, unit: "base" }, multiplier: spec.multiplier,
      quantityUnit: "contracts", settlement: "linear", maturity: { kind: "dated", expiry: spec.expiry,
        expiresAt: `${spec.expiry}T23:59:59.999Z`, delivery: spec.delivery } },
    sessions: { kind: "calendar", timezone: "America/Chicago", calendarId: "CME_GLOBEX",
      supports24x7: false, weeklySessions: [{ days: [0], open: "17:00", close: "24:00" },
        { days: [1, 2, 3, 4], open: "00:00", close: "16:00" },
        { days: [1, 2, 3, 4], open: "17:00", close: "24:00" },
        { days: [5], open: "00:00", close: "16:00" }] },
    prices: { last: supported(), bid: supported(), ask: supported(), mid: supported(), mark: no("exchange futures have no canonical mark"), index: no("underlying index is distinct") },
    events: events(true), execution: paperDirections(true), compliance: UNKNOWN_COMPLIANCE,
    futures: { exchange: spec.venue, root: spec.root, contractCode: spec.code, monthCode: spec.code.slice(-3, -2),
      contractMonth: spec.month, expiry: spec.expiry, firstTradeDate: spec.firstTrade, lastTradeDate: spec.expiry,
      firstNoticeDate: spec.firstNotice, lastDeliveryDate: spec.lastDelivery, multiplier: spec.multiplier,
      tickSize: spec.tick, tickValue: spec.tick * spec.multiplier, settlementCurrency: "USD", overnightSession: true,
      openInterest: supported(), chainPosition: spec.chain,
      feed: { status: "auth_subscription_gated", label: "IBKR market data · exchange entitlement required", delaySeconds: null } } };
}

function continuous(root: "CL" | "ES", venue: "NYMEX" | "CME"): CanonicalInstrument {
  const methodologyId = `${root.toLowerCase()}-front-calendar-unadjusted`;
  const identity = { canonicalId: "", venueId: venue, assetClass: root === "CL" ? "commodity" as const : "index" as const,
    instrumentType: "continuous_future" as const, baseAsset: root, quoteAsset: "USD", settlementAsset: "USD",
    series: { kind: "continuous" as const, methodologyId } };
  identity.canonicalId = canonicalInstrumentId(identity);
  return { ...future(FUTURES.find((row) => row.root === root)!), identity,
    listing: { providerId: IBKR_ID, providerSymbol: `${root}|CONTINUOUS|RESEARCH`, status: "active" },
    derivative: { kind: "continuous_series", root, methodologyId, selection: "front", rollTrigger: "calendar",
      adjustment: "none", rollScheduleSource: "explicit registered schedule; never provider SMART routing", directlyTradable: false },
    execution: paperDirections(false), futures: { ...future(FUTURES.find((row) => row.root === root)!).futures!,
      contractCode: null, monthCode: null, contractMonth: null, expiry: null, firstTradeDate: null,
      lastTradeDate: null, firstNoticeDate: null, lastDeliveryDate: null, chainPosition: "continuous",
      feed: { status: "fixture_only", label: "derived research series; source contracts require entitlement", delaySeconds: null } } };
}

function cashIndex(symbol: "SPX" | "NDX" | "DJI", venue: "CBOE_INDEX" | "NASDAQ_INDEX" | "DJ_INDEX"): CanonicalInstrument {
  const identity = { canonicalId: "", venueId: venue, assetClass: "index" as const, instrumentType: "index" as const,
    baseAsset: symbol, quoteAsset: "USD", settlementAsset: "USD", series: { kind: "cash" as const } };
  identity.canonicalId = canonicalInstrumentId(identity);
  return { contractVersion: MARKET_CONTRACT_VERSION, identity,
    listing: { providerId: IBKR_ID, providerSymbol: `${symbol}|IND|${venue}|USD`, status: "active" },
    currency: "USD", precision: price(0.01), derivative: { kind: "none" },
    sessions: { kind: "calendar", timezone: "America/New_York", calendarId: "REFERENCE_INDEX",
      supports24x7: false, weeklySessions: [{ days: [1, 2, 3, 4, 5], open: "09:30", close: "16:00" }] },
    prices: { last: supported(), bid: no("reference value has no executable bid"), ask: no("reference value has no executable ask"),
      mid: no("reference value has no executable spread"), mark: no("not a derivative mark"), index: supported() },
    events: events(), execution: paperDirections(false), compliance: UNKNOWN_COMPLIANCE,
    referenceIndex: { methodologyOwner: symbol === "SPX" ? "S&P DJI" : symbol === "NDX" ? "Nasdaq" : "S&P DJI",
      directlyTradable: false, feed: { status: "auth_subscription_gated",
        label: "IBKR index market data · entitlement required", delaySeconds: null } } };
}

const IBKR_CATALOG = Object.freeze([...FUTURES.map(future), continuous("CL", "NYMEX"), continuous("ES", "CME"),
  cashIndex("SPX", "CBOE_INDEX"), cashIndex("NDX", "NASDAQ_INDEX"), cashIndex("DJI", "DJ_INDEX")]);
const IBKR_DOCS: readonly ProviderDocumentationSource[] = Object.freeze([
  { title: "IBKR current TWS API documentation", url: "https://www.interactivebrokers.com/campus/ibkr-api-page/twsapi-doc/", accessedOn: ACCESSED,
    covers: ["paper_orders"], access: "authentication_required", limits: ["TWS/Gateway session required", "Paper execution inherits account permissions"] },
  { title: "IBKR current TWS API market data documentation", url: "https://www.interactivebrokers.com/campus/ibkr-api-page/twsapi-doc/", accessedOn: ACCESSED,
    covers: ["ticker", "candles"], access: "authentication_required", limits: ["Live, frozen, delayed and delayed-frozen types are distinct", "Exchange subscriptions may be required"] },
  { title: "IBKR paper trading accounts", url: "https://www.ibkrguides.com/clientportal/aboutpapertradingaccounts.htm", accessedOn: ACCESSED,
    covers: ["paper_orders"], access: "authentication_required", limits: ["Paper inherits live account permissions and subscriptions", "Fills are simulated"] },
  { title: "CME contract specifications", url: "https://www.cmegroup.com/markets/energy/crude-oil/light-sweet-crude.contractSpecs.html", accessedOn: ACCESSED,
    covers: ["contract_terms", "calendar", "open_interest"], access: "public", limits: ["Display data licensing/entitlements are separate from contract specifications", "Actual expiry calendar remains authoritative"] },
  { title: "CME market data licensing", url: "https://www.cmegroup.com/market-data/licensing-policy.html", accessedOn: ACCESSED,
    covers: ["ticker", "candles"], access: "public", limits: ["No free real-time CME entitlement is claimed"] },
]);

export const ibkrFuturesPaperAdapter: MarketDataProviderAdapter = {
  id: IBKR_ID, label: "IBKR futures/index · paper", venueIds: ["NYMEX", "COMEX", "CME", "CBOE_INDEX", "NASDAQ_INDEX", "DJ_INDEX"],
  healthPolicy: { staleAfterMs: 15_000, unavailableAfterFailures: 3 },
  rateLimits: { buckets: [{ id: "tws-session", limit: { kind: "provider_reported", source: "TWS pacing rules" }, windowMs: 600_000 }],
    retry: { maxAttempts: 2, baseDelayMs: 500, maximumDelayMs: 2_000, retryableStatuses: [429, 500, 502, 503, 504] } },
  access: { mode: "authentication_required", proof: "official_contract_only", reason: "TWS/Gateway paper session and exchange subscriptions absent; external handshake UNVERIFIED_DISABLED" },
  documentation: IBKR_DOCS,
  catalog: { availability: supported(), list: async () => [...IBKR_CATALOG],
    metadata: async (symbols) => IBKR_CATALOG.filter((row) => symbols.includes(row.listing.providerSymbol) || symbols.includes(row.futures?.contractCode ?? "")) },
  candles: { availability: no("IBKR session and exchange entitlement required"), resolutions: ["1m", "5m", "15m", "1h", "1d"],
    pagination: { maxPageSize: 1000, direction: "backward", limitation: "IBKR historical pacing and duration limits apply" },
    stream: { support: "unsupported", reason: "TWS socket session is not configured" }, fetch: unavailable },
  ticker: { availability: no("IBKR session and exchange entitlement required"), prices: IBKR_CATALOG[0]!.prices,
    fetch: unavailable, stream: { support: "unsupported", reason: "TWS socket session is not configured" } },
  trades: no("time-and-sales requires entitlement and is not modeled"), orderBook: no("market depth requires separate entitlement"),
  derivativeMetadata: { support: "supported", fetch: async (symbols) => IBKR_CATALOG.filter((row) =>
    row.derivative.kind === "contract" && symbols.includes(row.listing.providerSymbol)) },
  derivatives: no("runtime TWS market-data session is absent"), execution: paperDirections(true),
};

export const officialTraditionalAdapters = Object.freeze([oandaFxPracticeAdapter, ibkrFuturesPaperAdapter]);
