/**
 * The one boundary between "this platform needs market data" and "Binance
 * answers REST on these hosts".
 *
 * ── What this is ──────────────────────────────────────────────────────────
 *
 * A thin, dependency-free seam over the modules that already exist. Every
 * method delegates to `data/binanceRest`, unchanged, so nothing about how a
 * candle is fetched, paged, rate-limited, validated or persisted differs from
 * before. The value is not indirection for its own sake; it is that a caller
 * now expresses WHAT it needs — instrument metadata, historical candles, the
 * live tape — rather than which vendor module happens to provide it.
 *
 * ── What this deliberately is not ──────────────────────────────────────────
 *
 * Not an event bus. Not a backend fan-out. Not a repository-wide abstraction
 * rewrite, and not a plugin system. There is one implementation and there will
 * be one implementation until a second venue is genuinely built; a registry
 * that returns it by id is the whole of the extensibility here.
 *
 * New and modified callers route through `marketData`. Existing call sites are
 * left alone: rewriting sixty imports to prove a point would be a large diff
 * with no behaviour in it, and the audit asked for a boundary, not a migration.
 */
import type { Candle, Interval } from "../types/market";
import { DEFAULT_VENUE } from "../types/instrument";
import {
  ensureCandles, ensureSymbolMetadata, fetch24hTickers, fetchKlines,
  fetchSymbolMetadata, listExchangeSymbols, syncExchangeFilters,
  type ExchangeSymbol, type SymbolMetadata, type Ticker24h,
} from "./binanceRest";
import { BINANCE_SPOT_PROFILE, type ProviderProfile } from "./providerProfile";

export interface MarketDataProvider {
  readonly id: string;
  readonly venue: string;
  readonly profile: ProviderProfile;

  // ── instrument metadata ──
  /** Every instrument the venue lists. Cached upstream; safe to call often. */
  listInstruments(): Promise<ExchangeSymbol[]>;
  /** Full metadata — assets, status and the exchange filters — for these tickers. */
  instrumentMetadata(tickers: string[]): Promise<SymbolMetadata[]>;
  /** Register these tickers locally with their real assets, status and filters. */
  registerInstruments(tickers: string[]): Promise<SymbolMetadata[]>;
  /** Refresh stored tick/step/notional for tickers already registered. */
  syncInstrumentFilters(tickers: string[]): Promise<void>;

  // ── historical candles ──
  /** Fetch a window straight from the venue, without touching storage. */
  historicalCandles(
    ticker: string, interval: Interval, startMs: number, endMs: number
  ): Promise<Candle[]>;
  /** Guarantee local coverage of a window, fetching only if it is incomplete. */
  ensureCoverage(
    ticker: string, interval: Interval, startMs: number, endMs: number,
    log?: (msg: string) => void
  ): Promise<void>;

  // ── live market data ──
  /**
   * The rolling 24h ticker — the same-origin seed the watchlist paints before
   * its first stream frame arrives.
   */
  tickers(tickers: readonly string[]): Promise<Ticker24h[]>;
  /**
   * Where the browser opens its live streams. The tape itself is a browser
   * concern (`frontend/lib/marketStream`); the backend owns the policy, not
   * the socket, so this is the origin list rather than a connection.
   */
  streamOrigins(): readonly string[];
}

const binanceSpot: MarketDataProvider = {
  id: BINANCE_SPOT_PROFILE.id,
  venue: DEFAULT_VENUE,
  profile: BINANCE_SPOT_PROFILE,

  listInstruments: () => listExchangeSymbols(),
  instrumentMetadata: (tickers) => fetchSymbolMetadata(tickers),
  registerInstruments: (tickers) => ensureSymbolMetadata(tickers),
  syncInstrumentFilters: (tickers) => syncExchangeFilters(tickers),

  historicalCandles: (ticker, interval, startMs, endMs) =>
    fetchKlines(ticker, interval, startMs, endMs),
  ensureCoverage: (ticker, interval, startMs, endMs, log) =>
    ensureCandles(ticker, interval, startMs, endMs, log),

  tickers: (list) => fetch24hTickers(list),
  streamOrigins: () => BINANCE_SPOT_PROFILE.streamOrigins,
};

/** Every provider this build implements, by venue. One. */
const PROVIDERS: Readonly<Record<string, MarketDataProvider>> = Object.freeze({
  [DEFAULT_VENUE]: binanceSpot,
});

/** The provider for a venue, or null when that venue is not implemented. */
export function marketDataFor(venue: string): MarketDataProvider | null {
  return PROVIDERS[venue.toUpperCase()] ?? null;
}

/** The provider this installation uses. */
export const marketData: MarketDataProvider = binanceSpot;

export type { ExchangeSymbol, SymbolMetadata, Ticker24h };
