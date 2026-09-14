/**
 * The fixture's market: a catalogue of canonical instruments, in the shapes
 * the product's own contracts describe.
 *
 * ── TVP8 IO-A2-COV ─────────────────────────────────────────────────────────
 *
 * The DOM fixture served no canonical instrument at all. `/api/symbols` was
 * two bare Binance names with no `canonicalId`, `/api/symbols/tickers` was
 * `[]`, `/api/watchlists` was `[]` with nothing to POST to, and every
 * `/api/market/v1/*` route was a 404. So the paths the product takes for an
 * `instrument:v1:…` identity — the canonical candle route, the provider
 * stream config, the market ticker poll, a watchlist that persists — were
 * unreachable from any DOM test. Two behavioural tests written for IO-A2 and
 * IO-A7 passed before their repairs for exactly that reason, and were deleted.
 *
 * Every payload here is TYPED against `lib/api` and `lib/types`, which mirror
 * the backend's response shapes. That is the point: a fixture that answers in
 * a shape production never sends is worse than a 404, because a component
 * that reads the wrong field passes here and crashes there. Typecheck is the
 * drift guard; `tests/instrument.test.ts` already pins the id grammar to the
 * backend's.
 *
 * It is a catalogue, not a market. Prices are fixed, the daily move is a hash
 * of the ticker so a row's colour is stable, and nothing here reaches an
 * exchange. Tests that need particular bars set them with `server.setCandles`
 * under the instrument's PROVIDER symbol — `SOLUSDT` — which is how the
 * canonical candle route looks them up, exactly as the backend resolves a
 * canonical id to its provider listing before reading bars.
 */
import type {
  MarketStreamConfig, MarketTickerResponse, ServerWatchlist, SymbolSearchResponse,
  SymbolSearchResult, Ticker24h,
} from "@/lib/api";
import type { SymbolInfo } from "@/lib/types";
import { CRYPTO_SPOT, canonicalDisplayParts } from "@/lib/instrument";

export interface FixtureInstrument {
  base: string;
  quote: string;
  venue: string;
  type: "spot" | "perpetual" | "fx_pair" | "stock" | "index";
  name: string;
  price: number;
  /** In the local symbols table — has candles, can be charted at once. */
  tracked: boolean;
}

const SERIES = { spot: "spot", perpetual: "perpetual", fx_pair: "cash", stock: "cash", index: "cash" } as const;

export const CATALOGUE: readonly FixtureInstrument[] = [
  { base: "SOL", quote: "USDT", venue: "BINANCE", type: "spot", name: "Solana / TetherUS", price: 145, tracked: true },
  { base: "BTC", quote: "USDT", venue: "BINANCE", type: "spot", name: "Bitcoin / TetherUS", price: 77_000, tracked: true },
  { base: "ETH", quote: "USDT", venue: "BINANCE", type: "spot", name: "Ethereum / TetherUS", price: 2_520, tracked: false },
  { base: "BNB", quote: "USDT", venue: "BINANCE", type: "spot", name: "BNB / TetherUS", price: 604, tracked: false },
  { base: "XRP", quote: "USDT", venue: "BINANCE", type: "spot", name: "XRP / TetherUS", price: 1.94, tracked: false },
  { base: "ADA", quote: "USDT", venue: "BINANCE", type: "spot", name: "Cardano / TetherUS", price: 0.61, tracked: false },
  { base: "DOGE", quote: "USDT", venue: "BINANCE", type: "spot", name: "Dogecoin / TetherUS", price: 0.152, tracked: false },
  { base: "LINK", quote: "USDT", venue: "BINANCE", type: "spot", name: "Chainlink / TetherUS", price: 13.4, tracked: false },
  /*
   * A direct-stream venue. Binance spot rows ride the combined legacy
   * mini-ticker socket; `useWatchlistTickers` opens a per-instrument provider
   * stream — and runs its fifteen-second poll — only for the venues in its
   * `DIRECT_STREAM_VENUES`. A catalogue with no such venue would leave that
   * whole effect, which is where IO-A7 lived, unreachable.
   */
  { base: "BTC", quote: "USD", venue: "COINBASE", type: "spot", name: "Bitcoin / US Dollar", price: 77_010, tracked: false },
  { base: "BTC", quote: "USD", venue: "BINANCE", type: "perpetual", name: "Bitcoin Perpetual", price: 77_050, tracked: false },
  { base: "ETH", quote: "USD", venue: "BINANCE", type: "perpetual", name: "Ethereum Perpetual", price: 2_522, tracked: false },
  { base: "EUR", quote: "USD", venue: "OANDA", type: "fx_pair", name: "Euro / US Dollar", price: 1.0842, tracked: false },
  { base: "GBP", quote: "USD", venue: "OANDA", type: "fx_pair", name: "British Pound / US Dollar", price: 1.2671, tracked: false },
  { base: "USD", quote: "JPY", venue: "OANDA", type: "fx_pair", name: "US Dollar / Japanese Yen", price: 143.21, tracked: false },
  { base: "AAPL", quote: "USD", venue: "NASDAQ", type: "stock", name: "Apple Inc.", price: 228.4, tracked: false },
  { base: "MSFT", quote: "USD", venue: "NASDAQ", type: "stock", name: "Microsoft Corporation", price: 421.7, tracked: false },
  { base: "NVDA", quote: "USD", venue: "NASDAQ", type: "stock", name: "NVIDIA Corporation", price: 138.2, tracked: false },
  { base: "SPX", quote: "USD", venue: "SP", type: "index", name: "S&P 500 Index", price: 5_812, tracked: false },
];

export const providerSymbol = (i: FixtureInstrument): string => `${i.base}${i.quote}`;

export function canonicalId(i: FixtureInstrument): string {
  return `instrument:v1:${i.venue}:${i.type}:${i.base}:${i.quote}:${i.quote}:${SERIES[i.type]}`;
}

/*
 * Every id this catalogue mints must parse under the PRODUCT's grammar, at
 * load time. An id the product cannot parse is not "a canonical instrument the
 * fixture serves", it is a string the chart would treat as a legacy ticker —
 * and every canonical path under test would silently be skipped.
 */
for (const item of CATALOGUE) {
  const id = canonicalId(item);
  if (canonicalDisplayParts(id) === null) throw new Error(`fixture minted an id the product cannot parse: ${id}`);
}

/** The Binance spot ids a test is most likely to want, by provider symbol — `CANONICAL.SOLUSDT`. */
export const CANONICAL: Readonly<Record<string, string>> = Object.fromEntries(
  CATALOGUE.filter((i) => i.venue === "BINANCE" && i.type === "spot").map((i) => [providerSymbol(i), canonicalId(i)]));

/** Any catalogue id, by venue and pair. Throws for one the catalogue does not hold. */
export function idFor(venue: string, base: string, quote: string, type: FixtureInstrument["type"] = "spot"): string {
  const found = CATALOGUE.find((i) => i.venue === venue && i.base === base && i.quote === quote && i.type === type);
  if (!found) throw new Error(`the fixture catalogue has no ${type} ${base}/${quote} on ${venue}`);
  return canonicalId(found);
}

export function findByCanonicalId(id: string): FixtureInstrument | undefined {
  return CATALOGUE.find((i) => canonicalId(i) === id);
}

/**
 * The provider symbol a canonical id resolves to, for reading bars — the
 * backend does the same resolution before it touches the candle store. Ids
 * outside the catalogue but inside the grammar (a test may mint one) resolve
 * by their parts, so `setCandles` under the provider symbol still works.
 */
export function providerSymbolOf(id: string): string | null {
  const known = findByCanonicalId(id);
  if (known) return providerSymbol(known);
  const parts = canonicalDisplayParts(id);
  return parts ? `${parts.base}${parts.quote}` : null;
}

export function symbolInfo(i: FixtureInstrument): SymbolInfo {
  return {
    symbol: providerSymbol(i),
    canonicalId: canonicalId(i),
    baseAsset: i.base,
    quoteAsset: i.quote,
    priceTick: i.price >= 1000 ? 0.1 : i.price >= 10 ? 0.01 : 0.0001,
    qtyStep: i.price >= 1000 ? 0.00001 : 0.001,
    minNotional: 5,
    isActive: true,
    venue: i.venue,
    assetClass: CRYPTO_SPOT,
  };
}

export function searchResult(i: FixtureInstrument): SymbolSearchResult {
  return {
    symbol: providerSymbol(i),
    canonicalId: canonicalId(i),
    providerId: `${i.venue.toLowerCase()}-${i.type === "perpetual" ? "derivatives" : "spot"}`,
    providerSymbol: providerSymbol(i),
    venueId: i.venue,
    baseAsset: i.base,
    quoteAsset: i.quote,
    settlementAsset: i.quote,
    instrumentType: i.type,
    series: { kind: SERIES[i.type] },
    status: "active",
    tracked: i.tracked,
  };
}

/** A stable pseudo-random daily move, so a row's colour does not flicker. */
export function dayChange(i: FixtureInstrument): number {
  let h = 0;
  for (const c of providerSymbol(i)) h = (h * 31 + c.charCodeAt(0)) % 997;
  return (h % 61 - 30) / 1000;
}

const venueLabel = (id: string): string =>
  id === "SP" ? "S&P" : id[0]! + id.slice(1).toLowerCase();

/**
 * The `market.v1` asset class of a fixture instrument.
 *
 * The catalogue is written in the PRODUCT's instrument types; the search
 * route filters on the contract's asset classes, which are a coarser set
 * (`crypto` covers spot and perpetual alike). The dialog's Crypto chip asks
 * by class precisely because no single `type=` names that union, so a fixture
 * that could not answer `assetClass=` would leave the chip untestable.
 */
const ASSET_CLASS = { spot: "crypto", perpetual: "crypto", fx_pair: "fx", stock: "equity", index: "index" } as const;

export const assetClassOf = (i: FixtureInstrument): string => ASSET_CLASS[i.type];

/** `GET /api/market/v1/search` and, with `legacyOnly`, `GET /api/symbols/search`. */
export function searchResponse(url: URL, legacyOnly = false): SymbolSearchResponse {
  const q = (url.searchParams.get("q") ?? "").trim().toUpperCase();
  const venue = (url.searchParams.get("venue") ?? "").trim().toUpperCase();
  const quote = (url.searchParams.get("quote") ?? "").trim().toUpperCase();
  const type = url.searchParams.get("type") ?? "all";
  // Optional and additive, exactly as the route treats it: absent, it filters
  // nothing and the answer is the one this fixture has always given.
  const assetClass = (url.searchParams.get("assetClass") ?? "").trim().toLowerCase();
  const limit = Number(url.searchParams.get("limit") ?? 60);
  const matches = CATALOGUE.filter((i) => {
    if (legacyOnly && i.type !== "spot") return false;
    const ticker = providerSymbol(i);
    if (q && !ticker.includes(q) && !i.name.toUpperCase().includes(q) && !i.base.includes(q)) return false;
    if (venue && i.venue !== venue) return false;
    if (quote && i.quote !== quote) return false;
    if (type !== "all" && i.type !== type) return false;
    if (assetClass && assetClassOf(i) !== assetClass) return false;
    return true;
  });
  return {
    total: matches.length,
    quotes: [...new Set(CATALOGUE.map((i) => i.quote))].sort(),
    venues: [...new Set(CATALOGUE.map((i) => i.venue))].sort().map((id) => ({ id, label: venueLabel(id) })),
    results: matches.slice(0, Number.isFinite(limit) ? limit : matches.length).map(searchResult),
    errors: [],
  };
}

/**
 * `GET /api/symbols/tickers?symbols=` — the Binance-spot 24h seed.
 *
 * TVP8 R7-09: this route is now the seed for CANONICAL Binance spot rows too,
 * not only for bare legacy tickers, because a canonical row seeded through the
 * provider snapshot arrives with a last price and no `open` — and therefore
 * with `—` in Chg and Chg% until a stream frame lands. Nothing about the
 * fixture changes for that (a canonical id resolves to the same provider
 * symbol the catalogue is keyed by); what is new is `volume`/`quoteVolume`/
 * `high`/`low`, which the backend used to drop and the details block now
 * renders. They are derived from the catalogue's own price so a test can
 * assert a formatted value without the fixture inventing a market.
 */
export function legacyTickers(symbols: readonly string[], now = Date.now()): Ticker24h[] {
  return symbols.flatMap((symbol) => {
    const found = CATALOGUE.find((i) => providerSymbol(i) === symbol.toUpperCase());
    if (!found) return [];
    const open = found.price / (1 + dayChange(found));
    const volume = Math.round(1_000_000 / found.price);
    return [{
      symbol: symbol.toUpperCase(), last: found.price, open, at: now,
      volume, quoteVolume: volume * found.price,
      high: found.price * 1.01, low: found.price * 0.99,
    }];
  });
}

/**
 * `GET /api/market/v1/tickers?instruments=` — the provider contract.
 *
 * An id the catalogue does not hold goes in `missing`, which is what the
 * backend does; it does not get an invented price. The watchlist's header
 * counts `missing`, and a fixture that never produced one would leave that
 * copy untested.
 */
export function marketTickers(ids: readonly string[], now = Date.now()): MarketTickerResponse {
  const observations: MarketTickerResponse["providers"][number]["observations"] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const found = findByCanonicalId(id);
    if (!found) { missing.push(id); continue; }
    const price = found.price;
    observations.push({
      canonicalInstrumentId: id,
      providerSymbol: providerSymbol(found),
      observedAt: now,
      values: { last: price, bid: price * 0.9999, ask: price * 1.0001, mid: price },
      freshness: { state: "fresh", ageMs: 120 },
    });
  }
  return { providers: [{ providerId: "binance-spot", observations }], errors: [], missing };
}

/**
 * `GET /api/market/v1/stream/:id` — the trusted stream description.
 *
 * Shaped as `backend/src/market/spotStreams.ts` shapes Binance's: a
 * `/ws/<symbol>@kline_<interval>` or `@miniTicker` path, no subscribe
 * message. The origin is a name that resolves nowhere, because the harness's
 * `WebSocket` is `FakeSocket` and a test delivers frames by hand — and
 * because the provider id is `binance-spot`, the product parses those frames
 * with the same branch it uses for the real exchange.
 */
export function streamConfig(id: string, kind: "ticker" | "candle", interval: string): MarketStreamConfig | null {
  const found = findByCanonicalId(id);
  if (!found || (found.type !== "spot" && found.type !== "perpetual")) return null;
  const symbol = providerSymbol(found);
  const base = { contractVersion: "market.v1" as const, canonicalId: id, providerSymbol: symbol, interval };
  if (found.venue === "COINBASE") {
    // Coinbase subscribes by message on a bare origin, as `spotStreams.ts` describes it.
    const product = `${found.base}-${found.quote}`;
    return { ...base, providerId: "coinbase-spot", providerSymbol: product,
      request: { origins: ["wss://fixture.invalid"], path: "",
        subscribeMessage: JSON.stringify({ type: "subscribe", product_ids: [product],
          channels: [kind === "ticker" ? "ticker" : "candles"] }), requiresBootstrapToken: false } };
  }
  const stream = kind === "ticker" ? `${symbol.toLowerCase()}@miniTicker` : `${symbol.toLowerCase()}@kline_${interval}`;
  return { ...base,
    providerId: found.type === "perpetual" ? "binance-derivatives" : "binance-spot",
    request: { origins: ["wss://fixture.invalid"], path: `/ws/${stream}`, subscribeMessage: null, requiresBootstrapToken: false },
  };
}

/**
 * A Binance-shaped kline frame for `FakeSocket.deliver`, so a test can say
 * exactly which bar arrived on the canonical candle stream.
 */
export function klineFrame(id: string, interval: string, bar: {
  openTime: number; open: number; high: number; low: number; close: number; volume: number; closed: boolean;
}): unknown {
  const found = findByCanonicalId(id);
  const symbol = found ? providerSymbol(found) : id;
  return {
    stream: `${symbol.toLowerCase()}@kline_${interval}`,
    data: {
      e: "kline", E: bar.openTime + 1, s: symbol,
      k: { t: bar.openTime, s: symbol, i: interval, o: String(bar.open), h: String(bar.high),
        l: String(bar.low), c: String(bar.close), v: String(bar.volume), x: bar.closed },
    },
  };
}

export type { ServerWatchlist };
