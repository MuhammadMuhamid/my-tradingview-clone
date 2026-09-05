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
 * The ability to WRITE a venue down. `BTCUSDT` is still the stored form, still
 * what a layout, a watchlist, an alert and a deep link carry, and still what
 * reaches the API. `BINANCE:BTCUSDT` resolves to the identical instrument and
 * is reduced back to the bare ticker before it leaves — on the two paths that
 * reduce today, the apply deep link and the symbol dialog's selection, and on
 * the four backend market-data routes listed in the backend's own copy.
 *
 * No second venue, no second asset class and no second feed is implemented —
 * this is the vocabulary, so that implementing one later is not a rewrite of
 * every screen that names a pair.
 *
 * BINANCE_US is a different exchange with a different listing set, not a host
 * variant of this one. It is not registered, and resolving it fails rather
 * than quietly returning Binance.
 */

/** The one venue this installation has a feed for. */
export const DEFAULT_VENUE = "BINANCE";

/** The one asset class. Spot: no futures, no margin, no leverage, no shorts. */
export const CRYPTO_SPOT = "crypto_spot";

export type AssetClass = typeof CRYPTO_SPOT;

export const DEFAULT_ASSET_CLASS: AssetClass = CRYPTO_SPOT;

export interface VenueProfile {
  id: string;
  label: string;
  assetClass: AssetClass;
}

/** Every venue that is actually implemented. Exactly one. */
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

export class InstrumentIdError extends Error {}

/** Split into venue and ticker without judging whether either is supported. */
export function splitInstrumentId(raw: string): { venue: string; ticker: string } {
  const value = String(raw ?? "").trim().toUpperCase();
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
  return resolveInstrument(raw).ticker;
}

/** The same, without the throw: unresolvable input yields null. */
export function tryStoredSymbol(raw: string): string | null {
  return tryResolveInstrument(raw)?.ticker ?? null;
}

/** True when two symbol strings name the same instrument, however written. */
export function sameInstrument(a: string, b: string): boolean {
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
  const id = tryResolveInstrument(raw);
  if (!id) return String(raw ?? "").toUpperCase();
  return Object.keys(VENUES).length > 1 ? formatInstrumentId(id) : id.ticker;
}
