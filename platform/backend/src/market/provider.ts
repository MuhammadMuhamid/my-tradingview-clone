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
  covers: readonly ("catalog" | "metadata" | "ticker" | "candles" | "ticker_stream" | "candle_stream")[];
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
  /** Declaration only. All credentialed mutation remains behind the Bot boundary. */
  readonly execution: ExecutionCapabilities;
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
