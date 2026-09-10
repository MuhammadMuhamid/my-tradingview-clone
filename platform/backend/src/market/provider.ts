import type { Candle, Interval } from "../types/market";
import type { CanonicalInstrument, ExecutionCapabilities, PriceRoleCapabilities, Support } from "./model";

export interface ProviderHealthPolicy {
  staleAfterMs: number;
  unavailableAfterFailures: number;
}

export interface ProviderRateLimitPolicy {
  buckets: readonly {
    id: string;
    limit: { kind: "fixed"; requests: number } | { kind: "provider_reported"; source: string };
    windowMs: number;
  }[];
  retry: { maxAttempts: number; baseDelayMs: number; maximumDelayMs: number; retryableStatuses: readonly number[] };
}

export interface ProviderDocumentationSource {
  title: string;
  url: string;
  accessedOn: string;
  covers: readonly ("catalog" | "metadata" | "ticker" | "candles" | "ticker_stream" | "candle_stream" |
    "funding" | "open_interest" | "contract_terms" | "calendar" | "corporate_actions" |
    "paper_orders")[];
  access: "public" | "authentication_required";
  limits: readonly string[];
}

export type ProviderAccess =
  | { mode: "public"; proof: "official_contract" | "live_public" }
  | { mode: "authentication_required"; reason: string; proof: "official_contract_only" }
  | { mode: "unavailable"; reason: string; proof: "official_contract_only" };

export interface StreamContract {
  support: "supported" | "unsupported";
  reason?: string;
  origins?: readonly string[];
  protocol?: "url_subscription" | "json_subscription" | "tokenized_json_subscription";
  /** Provider topic template; `{symbol}` and `{interval}` are substituted by clients. */
  topic?: string;
  resolutions?: readonly Interval[];
}

export interface CandlePaginationPolicy {
  maxPageSize: number;
  direction: "forward" | "backward" | "latest_window_only";
  maximumBars?: number;
  limitation?: string;
}

export interface TickerObservation {
  canonicalInstrumentId: string;
  providerSymbol: string;
  observedAt: number;
  values: Partial<Record<"last" | "bid" | "ask" | "mid" | "mark" | "index", number>>;
}

export type QuantityUnit = "contracts" | "base" | "quote" | "usd";

export interface UnitValue {
  value: number;
  unit: QuantityUnit;
  /** Present only when the provider publishes the conversion, never inferred from last price. */
  converted?: { value: number; unit: QuantityUnit; role: "provider_reported" };
}

export interface FundingObservation {
  canonicalInstrumentId: string;
  providerSymbol: string;
  /** Rate for one provider funding interval, as a decimal fraction. */
  rate: number;
  intervalMs: number;
  fundingAt: number;
  observedAt: number;
}

export interface DerivativeObservation {
  canonicalInstrumentId: string;
  providerSymbol: string;
  observedAt: number;
  prices: Partial<Record<"last" | "mark" | "index", number>>;
  funding: null | { rate: number; intervalMs: number; nextFundingAt: number | null };
  openInterest: UnitValue | null;
  volume24h: UnitValue | null;
  basis: null | { absolute: number; rate: number; mark: number; index: number };
  liquidation: null | {
    maintenanceMarginRate?: number;
    riskLimit?: UnitValue;
    source: "provider_contract_metadata";
  };
}

export type OptionalDerivativeMarketData =
  | { support: "unsupported"; reason: string }
  | {
      support: "supported";
      snapshot(providerSymbols: readonly string[]): Promise<DerivativeObservation[]>;
      fundingHistory:
        | { support: "unsupported"; reason: string }
        | { support: "supported"; fetch(providerSymbol: string, startMs: number, endMs: number): Promise<FundingObservation[]> };
      stream: StreamContract;
    };

export interface TradeObservation {
  canonicalInstrumentId: string;
  observedAt: number;
  price: number;
  quantity: number;
  aggressor: "buy" | "sell" | "unknown";
}

export interface OrderBookSnapshot {
  canonicalInstrumentId: string;
  observedAt: number;
  bids: readonly [price: number, quantity: number][];
  asks: readonly [price: number, quantity: number][];
}

export type OptionalTrades =
  | { support: "unsupported"; reason: string }
  | { support: "supported"; fetch(providerSymbol: string, limit: number): Promise<TradeObservation[]> };

export type OptionalOrderBook =
  | { support: "unsupported"; reason: string }
  | { support: "supported"; fetch(providerSymbol: string, depth: number): Promise<OrderBookSnapshot> };

export type OptionalDerivativeMetadata =
  | { support: "unsupported"; reason: string }
  | { support: "supported"; fetch(providerSymbols: readonly string[]): Promise<CanonicalInstrument[]> };

export interface MarketDataProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly venueIds: readonly string[];
  readonly healthPolicy: ProviderHealthPolicy;
  readonly rateLimits: ProviderRateLimitPolicy;
  readonly access: ProviderAccess;
  readonly documentation: readonly ProviderDocumentationSource[];

  readonly catalog: {
    availability: Support;
    list(): Promise<CanonicalInstrument[]>;
    metadata(providerSymbols: readonly string[]): Promise<CanonicalInstrument[]>;
  };
  readonly candles: {
    availability: Support;
    resolutions: readonly Interval[];
    pagination: CandlePaginationPolicy;
    stream: StreamContract;
    fetch(providerSymbol: string, interval: Interval, startMs: number, endMs: number,
      signal?: AbortSignal): Promise<Candle[]>;
  };
  readonly ticker: {
    availability: Support;
    prices: PriceRoleCapabilities;
    fetch(providerSymbols: readonly string[]): Promise<TickerObservation[]>;
    stream: StreamContract;
  };
  readonly trades: OptionalTrades;
  readonly orderBook: OptionalOrderBook;
  readonly derivativeMetadata: OptionalDerivativeMetadata;
  readonly derivatives: OptionalDerivativeMarketData;
  /** Cash-equity semantics. Absent on every non-equity adapter. */
  readonly equities?: EquityMarketData;
  /** Declaration only. All credentialed mutation remains behind the Bot boundary. */
  readonly execution: ExecutionCapabilities;
}

export type EquityAdjustmentMode = "raw" | "split" | "dividend" | "all";
export type EquitySessionMode = "regular" | "extended" | "all";
export type EquitySessionPhase = "pre" | "regular" | "after" | "closed";

export interface MarketCalendarDay {
  /** Exchange-local YYYY-MM-DD. */
  date: string;
  /** Exact instants returned by the official provider calendar. */
  open: string;
  close: string;
}

export interface EquityCorporateAction {
  id: string;
  canonicalInstrumentId: string;
  providerSymbol: string;
  type: "split" | "dividend" | "symbol_change" | "merger";
  exDate: string;
  processDate: string;
  dataQuality: "complete" | "incomplete";
  splitRatio?: number;
  cashAmount?: number;
  currency?: string;
  oldSymbol?: string;
  newSymbol?: string;
}

export interface EquityBarSet {
  bars: Candle[];
  adjustmentMode: EquityAdjustmentMode;
  sessionMode: EquitySessionMode;
  phasesIncluded: readonly Exclude<EquitySessionPhase, "closed">[];
  feed: {
    id: string;
    entitlement: string;
    coverage: "single_venue" | "consolidated";
    delaySeconds: number;
    historicalEmbargoSeconds: number;
  };
  executionCompatible: boolean;
  studies: { regularSessionOnly: boolean; extendedHoursIncluded: boolean };
  completeness: {
    complete: boolean;
    expectedBars: number;
    presentBars: number;
    missingBars: number;
    closedSessionGapsIgnored: true;
  };
  corporateActionIds: readonly string[];
}

export interface EquityMarketData {
  readonly adjustmentModes: readonly EquityAdjustmentMode[];
  readonly sessionModes: readonly EquitySessionMode[];
  readonly defaultAdjustment: "raw";
  readonly defaultSession: "regular";
  readonly executionPriceAdjustment: "raw";
  readonly calendar: {
    timezone: "America/New_York";
    source: string;
    days(startDate: string, endDate: string): Promise<MarketCalendarDay[]>;
  };
  fetchCandles(input: {
    instrument: CanonicalInstrument;
    interval: Interval;
    startMs: number;
    endMs: number;
    adjustment: EquityAdjustmentMode;
    session: EquitySessionMode;
    feed: string;
    signal?: AbortSignal;
  }): Promise<EquityBarSet>;
  corporateActions(input: {
    instrument: CanonicalInstrument;
    startDate: string;
    endDate: string;
    signal?: AbortSignal;
  }): Promise<EquityCorporateAction[]>;
}

export type ProviderHealthState = "unknown" | "healthy" | "degraded" | "rate_limited" | "unavailable";

export interface ProviderHealthSnapshot {
  providerId: string;
  state: ProviderHealthState;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  stale: boolean;
  retryAfterMs: number | null;
}

export function observationFreshness(observedAt: number, now: number, staleAfterMs: number):
  { state: "fresh"; ageMs: number } | { state: "stale"; ageMs: number } {
  const ageMs = Math.max(0, now - observedAt);
  return ageMs <= staleAfterMs ? { state: "fresh", ageMs } : { state: "stale", ageMs };
}
