/**
 * What names an instrument, in the browser.
 *
 * Mirrors `backend/src/types/instrument.ts`, the way `lib/types` mirrors the
 * backend response shapes: there is no shared package in this repository, and
 * `tests/instrument.test.ts` asserts the two agree on the venue registry, the
 * default asset class and the parse rules so they cannot drift in silence.
 *
 * ── The whole of what this adds ────────────────────────────────────────────
 *
 * Legacy bare/venue-qualified Binance spot names keep their established
 * behavior. Multi-venue spot and derivative instruments use the full
 * `instrument:v1` identity so venue, product type, settlement and dated series
 * survive chart, watchlist, search, storage and API seams without collisions.
 *
 * BINANCE_US is a different exchange with a different listing set, not a host
 * variant of this one. It is not registered, and resolving it fails rather
 * than quietly returning Binance.
 */

/** Default venue for legacy bare spot symbols. */
export const DEFAULT_VENUE = "BINANCE";

/** Browser routing classes; execution remains separately capability-gated. */
export const CRYPTO_SPOT = "crypto_spot";
export const CRYPTO_DERIVATIVE = "crypto_derivative";
export const US_EQUITY = "us_equity";
export const FX = "fx";
export const TRADITIONAL_FUTURE = "traditional_future";
export const REFERENCE_INDEX = "reference_index";

export type AssetClass = typeof CRYPTO_SPOT | typeof CRYPTO_DERIVATIVE | typeof US_EQUITY |
  typeof FX | typeof TRADITIONAL_FUTURE | typeof REFERENCE_INDEX;

export const DEFAULT_ASSET_CLASS: AssetClass = CRYPTO_SPOT;

export interface VenueProfile {
  id: string;
  label: string;
  assetClass: AssetClass;
}

/** Legacy venue-qualified shorthand remains Binance-only; X1 venues use full canonical ids. */
export const VENUES: Readonly<Record<string, VenueProfile>> = Object.freeze({
  [DEFAULT_VENUE]: { id: DEFAULT_VENUE, label: "Binance", assetClass: CRYPTO_SPOT },
});

export function isRegisteredVenue(venue: string): boolean {
  return Object.prototype.hasOwnProperty.call(VENUES, venue.toUpperCase());
}

export interface InstrumentId {
  venue: string;
  ticker: string;
  assetClass: AssetClass;
}

const VENUE_RE = /^[A-Z][A-Z0-9_]{1,23}$/;
const TICKER_RE = /^[A-Z0-9]{2,24}$/;
const CANONICAL_RE = /^instrument:v1:([A-Z][A-Z0-9_]{1,23}):(spot|perpetual|future|continuous_future|stock|etf|fx_pair|commodity|index):([A-Z0-9._-]+):([A-Z0-9._-]+):([A-Z0-9._-]+):(spot|cash|perpetual|dated-(\d{8})|continuous-([a-z0-9._-]+))$/i;

export type CanonicalInstrumentType = "spot" | "perpetual" | "future" | "continuous_future" | "stock" | "etf" |
  "fx_pair" | "commodity" | "index";

export interface CanonicalDisplayParts {
  venue: string;
  type: CanonicalInstrumentType;
  base: string;
  quote: string;
  settlement: string;
  series: string;
  expiry: string | null;
}

export function isCanonicalInstrumentId(raw: string): boolean {
  return canonicalDisplayParts(raw) !== null;
}

export function canonicalDisplayParts(raw: string): CanonicalDisplayParts | null {
  const match = CANONICAL_RE.exec(String(raw ?? "").trim());
  if (!match) return null;
  const type = match[2]!.toLowerCase() as CanonicalInstrumentType;
  const series = match[6]!.toLowerCase();
  if ((type === "spot" && series !== "spot") || (type === "perpetual" && series !== "perpetual") ||
    (type === "future" && !series.startsWith("dated-")) ||
    (type === "continuous_future" && !series.startsWith("continuous-")) ||
    ((type === "stock" || type === "etf" || type === "fx_pair" || type === "commodity" || type === "index") && series !== "cash")) return null;
  const compact = match[7];
  const expiry = compact ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}` : null;
  if (expiry) {
    const parsed = new Date(`${expiry}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== expiry) return null;
  }
  return { venue: match[1]!.toUpperCase(), type, base: match[3]!.toUpperCase(), quote: match[4]!.toUpperCase(),
    settlement: match[5]!.toUpperCase(), series, expiry };
}

export function instrumentTypeLabel(type: CanonicalInstrumentType): "SPOT" | "PERP" | "FUTURE" | "CONTINUOUS" | "STOCK" | "ETF" | "FX" | "COMMODITY" | "INDEX" {
  return type === "spot" ? "SPOT" : type === "perpetual" ? "PERP" : type === "future" ? "FUTURE"
    : type === "continuous_future" ? "CONTINUOUS" : type === "stock" ? "STOCK" : type === "etf" ? "ETF"
      : type === "fx_pair" ? "FX" : type === "commodity" ? "COMMODITY" : "INDEX";
}

export function isDerivativeInstrumentId(raw: string): boolean {
  const parts = canonicalDisplayParts(raw); return parts?.type === "perpetual" || parts?.type === "future";
}

export function isEquityInstrumentId(raw: string): boolean {
  const parts = canonicalDisplayParts(raw); return parts?.type === "stock" || parts?.type === "etf";
}

export function isTraditionalInstrumentId(raw: string): boolean {
  const parts = canonicalDisplayParts(raw);
  return parts?.type === "fx_pair" || parts?.type === "continuous_future" || parts?.type === "index" ||
    (parts?.type === "future" && ["CME", "NYMEX", "COMEX", "CBOT"].includes(parts.venue));
}

/** Query semantics shared by chart and backtest candle callers. */
export function canonicalCandleSemantics(raw: string, purpose: "chart" | "backtest" = "chart"): string {
  const parts = canonicalDisplayParts(raw);
  if (!parts) return "";
  if (parts.type === "fx_pair") return `&purpose=${purpose}&priceBasis=mid`;
  if (parts.type === "continuous_future") {
    const schedule = parts.series.replace(/^continuous-/, "");
    const adjustment = schedule.endsWith("-unadjusted") ? "none" : "none";
    return `&purpose=${purpose}&rollSchedule=${encodeURIComponent(schedule)}&continuousAdjustment=${adjustment}`;
  }
  return `&purpose=${purpose}`;
}

export class InstrumentIdError extends Error {}

/** Split into venue and ticker without judging whether either is supported. */
export function splitInstrumentId(raw: string): { venue: string; ticker: string } {
  const original = String(raw ?? "").trim();
  const canonical = CANONICAL_RE.exec(original);
  if (canonical) return { venue: canonical[1]!.toUpperCase(), ticker: `${canonical[3]}-${canonical[4]}`.toUpperCase() };
  const value = original.toUpperCase();
  const colon = value.indexOf(":");
  if (colon < 0) return { venue: DEFAULT_VENUE, ticker: value };
  return { venue: value.slice(0, colon), ticker: value.slice(colon + 1) };
}

/** The full identity, or a refusal that names the reason. */
export function resolveInstrument(raw: string): InstrumentId {
  const { venue, ticker } = splitInstrumentId(raw);
  if (!VENUE_RE.test(venue)) {
    throw new InstrumentIdError(`invalid venue in instrument id: ${JSON.stringify(raw)}`);
  }
  if (!TICKER_RE.test(ticker)) {
    throw new InstrumentIdError(`invalid ticker in instrument id: ${JSON.stringify(raw)}`);
  }
  const profile = VENUES[venue];
  if (!profile) {
    throw new InstrumentIdError(
      `venue ${venue} is not implemented on this installation ` +
      `(registered: ${Object.keys(VENUES).join(", ")})`
    );
  }
  return { venue: profile.id, ticker, assetClass: profile.assetClass };
}

export function tryResolveInstrument(raw: string): InstrumentId | null {
  try { return resolveInstrument(raw); }
  catch { return null; }
}

/** `BINANCE:BTCUSDT` — the qualified form, for display and for links. */
export function formatInstrumentId(id: InstrumentId): string {
  return `${id.venue}:${id.ticker}`;
}

/**
 * The bare ticker, which is what the API, storage and the Bot all carry.
 *
 * Two production paths reduce through it today: the apply deep link
 * (`lib/deepLink`) and the symbol dialog's selection
 * (`components/tv/SymbolSearch`). Every other surface accepts bare tickers
 * only, and that is deliberate — Wave A introduced the vocabulary, not a
 * repository-wide rewrite of every place a symbol is handled. Reducing here
 * before a symbol reaches a request is what keeps a qualified identity from
 * ever reaching a column or a Bot payload.
 */
export function storedSymbol(raw: string): string {
  if (isCanonicalInstrumentId(raw)) return String(raw).trim();
  return resolveInstrument(raw).ticker;
}

/** Canonical id used when importing legacy Binance-only saved state. */
export function canonicalizeLegacySpotSymbol(raw: string): string | null {
  const original = String(raw ?? "").trim();
  if (!original) return null;
  const parts = canonicalDisplayParts(original);
  if (parts) return `instrument:v1:${parts.venue}:${parts.type}:${parts.base}:${parts.quote}:${parts.settlement}:${parts.series}`;
  const value = original.toUpperCase();
  const ticker = value.replace(/^BINANCE:/, "");
  if (!/^[A-Z0-9]{2,24}$/.test(ticker)) return null;
  const quote = ["USDT", "USDC", "FDUSD", "TUSD", "BUSD", "BTC", "ETH", "BNB", "TRY", "EUR"]
    .find((candidate) => ticker.endsWith(candidate) && ticker.length > candidate.length);
  if (!quote) return null;
  return `instrument:v1:BINANCE:spot:${ticker.slice(0, -quote.length)}:${quote}:${quote}:spot`;
}

/** Compatibility projection for the legacy Binance-only strategy/optimizer store. */
export function legacyBinanceSpotTicker(raw: string): string | null {
  const canonical = canonicalDisplayParts(raw);
  if (canonical) {
    return canonical.venue === "BINANCE" && canonical.type === "spot"
      ? `${canonical.base}${canonical.quote}` : null;
  }
  return tryResolveInstrument(raw)?.ticker ?? null;
}

/** The same, without the throw: unresolvable input yields null. */
export function tryStoredSymbol(raw: string): string | null {
  if (isCanonicalInstrumentId(raw)) return String(raw).trim();
  return tryResolveInstrument(raw)?.ticker ?? null;
}

/** True when two symbol strings name the same instrument, however written. */
export function sameInstrument(a: string, b: string): boolean {
  if (isCanonicalInstrumentId(a) || isCanonicalInstrumentId(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  const left = tryResolveInstrument(a);
  const right = tryResolveInstrument(b);
  if (!left || !right) return false;
  return left.venue === right.venue && left.ticker === right.ticker;
}

/**
 * How an instrument would be named on screen once there is more than one venue.
 *
 * Bare while there is exactly one, because a `BINANCE:` prefix on every label
 * is noise that says nothing the header does not already say — which is why no
 * component calls this yet. It exists so that the day a second venue is
 * implemented, the answer is decided here rather than in forty JSX expressions
 * that each grew their own rule.
 */
export function displaySymbol(raw: string): string {
  const canonical = canonicalDisplayParts(raw);
  if (canonical) return `${canonical.venue}:${canonical.base}/${canonical.quote} · ${instrumentTypeLabel(canonical.type)}` +
    (canonical.expiry ? ` ${canonical.expiry}` : "");
  const id = tryResolveInstrument(raw);
  if (!id) return String(raw ?? "").toUpperCase();
  return Object.keys(VENUES).length > 1 ? formatInstrumentId(id) : id.ticker;
}
