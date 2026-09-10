/**
 * Legacy Binance Spot symbol compatibility.
 *
 * X0's provider-neutral economic identity and full market vocabulary live in
 * `market/model.ts`. This module intentionally remains the FC3 compatibility
 * resolver for bare Binance provider symbols and old `BINANCE:SYMBOL` links.
 * Neither form is the canonical X0 instrument id; `instrument:v1:...` is.
 *
 * ── What this is, and firmly is not ────────────────────────────────────────
 *
 * This platform trades Binance crypto SPOT and nothing else. Nothing here adds
 * a venue, an asset class, a feed or an endpoint. What it adds is the ability
 * to SAY which venue and which asset class a symbol belongs to, so that the
 * day a second one is genuinely implemented, the identity does not have to be
 * retrofitted through layouts, watchlists, alerts, journal rows, deployments,
 * strategy manifests and the Bot contract — all of which name an instrument by
 * a bare ticker today and must go on doing so.
 *
 * ── Bare stays canonical on the wire ───────────────────────────────────────
 *
 * `BTCUSDT` is the legacy stored form and Bot contract form. It resolves, by the only
 * default this installation has, to BINANCE / crypto_spot.
 *
 * `BINANCE:BTCUSDT` is the qualified form. It is reduced back to the bare
 * ticker before it reaches storage or the Bot, and it is accepted today by the
 * four market-data surfaces that a link or a client can reasonably name an
 * instrument to: `GET /api/symbols/:symbol/candles`, and the three
 * `/api/data/*` routes. Every OTHER symbol-bearing route accepts bare tickers
 * only, exactly as it always has — introducing the vocabulary was the Wave A
 * scope, not rewriting every route that handles a symbol.
 * `tests/instrumentIdentity.test.ts` pins that list so this comment cannot
 * quietly stop being true.
 *
 * There is no migration of historical rows, because there is nothing to
 * migrate: every existing row already means exactly what the default says.
 *
 * ── BINANCE_US is not Binance ──────────────────────────────────────────────
 *
 * It is a different venue with a different listing set, different filters and
 * a different feed. Treating it as an alias — or as a "host variant" of the
 * same venue — would silently price one exchange's instrument from another's
 * tape. It is therefore an UNREGISTERED venue here: parseable as a name,
 * refused as a target, and left as a deliberate future decision.
 */

/** The one venue this installation has a feed for. */
export const DEFAULT_VENUE = "BINANCE";

/** The one asset class. Spot: no futures, no margin, no leverage, no shorts. */
export const CRYPTO_SPOT = "crypto_spot";

export type AssetClass = typeof CRYPTO_SPOT;

export const DEFAULT_ASSET_CLASS: AssetClass = CRYPTO_SPOT;

export interface VenueProfile {
  /** Canonical venue token, as it appears in a qualified identity. */
  id: string;
  label: string;
  assetClass: AssetClass;
}

/**
 * Every venue that is actually implemented. Exactly one.
 *
 * A registry with one entry is not over-generalisation: it is the difference
 * between "the venue is BINANCE because a constant says so" and "the venue is
 * BINANCE because it is the only one registered", and only the second can be
 * checked by a test or extended without hunting for string literals.
 */
export const VENUES: Readonly<Record<string, VenueProfile>> = Object.freeze({
  [DEFAULT_VENUE]: { id: DEFAULT_VENUE, label: "Binance", assetClass: CRYPTO_SPOT },
});

export function isRegisteredVenue(venue: string): boolean {
  return Object.prototype.hasOwnProperty.call(VENUES, venue.toUpperCase());
}

export interface InstrumentId {
  /** Canonical venue token, upper case. */
  venue: string;
  /** The venue's own ticker, upper case — the bare stored form. */
  ticker: string;
  assetClass: AssetClass;
}

/** Venue tokens are upper-case alphanumerics with underscores (`BINANCE_US`). */
const VENUE_RE = /^[A-Z][A-Z0-9_]{1,23}$/;
/** Binance tickers, matching the outbound market-data guard in `binanceRest`. */
const TICKER_RE = /^[A-Z0-9]{2,24}$/;

export class InstrumentIdError extends Error {}

/**
 * Split a symbol into venue and ticker without deciding whether either is
 * supported. Bare input takes the default venue.
 *
 * Deliberately separate from `resolveInstrument`: a stored row, a deep link or
 * a Bot payload must be readable even when it names something this build
 * cannot serve, so that the refusal can say what it refused.
 */
export function splitInstrumentId(raw: string): { venue: string; ticker: string } {
  const value = String(raw ?? "").trim().toUpperCase();
  const colon = value.indexOf(":");
  if (colon < 0) return { venue: DEFAULT_VENUE, ticker: value };
  return { venue: value.slice(0, colon), ticker: value.slice(colon + 1) };
}

/**
 * The full identity of a symbol, or a refusal that names the reason.
 *
 * Accepts `BTCUSDT` and `BINANCE:BTCUSDT` and produces the identical result
 * for both — which is the compatibility guarantee this whole module exists
 * for. Refuses a venue that is not registered rather than falling back to the
 * default, because a silent fallback is exactly how `BINANCE_US:BTCUSDT` would
 * come to be priced off Binance's tape.
 */
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

/** `resolveInstrument` without the throw, for callers that have a fallback. */
export function tryResolveInstrument(raw: string): InstrumentId | null {
  try { return resolveInstrument(raw); }
  catch { return null; }
}

/** `BINANCE:BTCUSDT` — the legacy qualified form, for display and links. */
export function formatInstrumentId(id: InstrumentId): string {
  return `${id.venue}:${id.ticker}`;
}

/**
 * The bare ticker, which is what every table, contract and Bot payload holds.
 *
 * The routes that accept a qualified identity call this before doing anything
 * with the symbol, so a qualified id cannot travel past them into a column, a
 * dedupe key or a webhook body. Routes that do not call it accept bare tickers
 * only — see the module header for exactly which is which.
 */
export function storedSymbol(raw: string): string {
  return resolveInstrument(raw).ticker;
}

/** True when two symbol strings name the same instrument, however written. */
export function sameInstrument(a: string, b: string): boolean {
  const left = tryResolveInstrument(a);
  const right = tryResolveInstrument(b);
  if (!left || !right) return false;
  return left.venue === right.venue && left.ticker === right.ticker;
}

/**
 * Base and quote asset for an instrument, from its METADATA.
 *
 * ── Why this is not `symbol.replace(/USDT$/, "")` ──────────────────────────
 *
 * Because that is a guess that happens to be right for the pairs this
 * installation charts most. `ETHBTC` is not `ETHB`/`TC`; `BTCUSDC` is not a
 * USDT pair; and a venue whose tickers are not concatenations at all — every
 * venue that separates them, and every asset class that has no quote asset —
 * makes the guess meaningless rather than merely wrong.
 *
 * The venue publishes both assets in its instrument metadata and the `symbols`
 * table already stores them. NEW code reads them from here.
 *
 * Four suffix-parsing sites are deliberately left as they were, because
 * changing them now would be risk without a defect. Each carries a pointer
 * back to this module:
 *
 *   backend/src/scripts/seedMaWatchlist.ts   a seed list of USDT pairs
 *   backend/src/shariah/gate.ts              a USDT-only screening gate
 *   frontend/lib/manualTicket.ts             a display label
 *   frontend/components/tv/Watchlist.tsx     a USDT-only add form
 */
export interface InstrumentAssets {
  baseAsset: string;
  quoteAsset: string;
}

export function assetsFromMetadata(
  metadata: Partial<InstrumentAssets> | null | undefined
): InstrumentAssets | null {
  const base = metadata?.baseAsset?.trim().toUpperCase();
  const quote = metadata?.quoteAsset?.trim().toUpperCase();
  if (!base || !quote) return null;
  return { baseAsset: base, quoteAsset: quote };
}

/**
 * The legacy suffix split, named so its call sites are findable.
 *
 * Kept because several paths register a pair before any metadata for it exists
 * and must not fail if the venue directory is unreachable. It is a FALLBACK,
 * never a first choice — `assetsFromMetadata` is.
 */
export function assetsBySuffixFallback(ticker: string): InstrumentAssets {
  const upper = ticker.toUpperCase();
  for (const quote of ["USDT", "FDUSD", "USDC", "TUSD", "BUSD", "BTC", "ETH", "BNB", "TRY", "EUR"]) {
    if (upper.length > quote.length && upper.endsWith(quote)) {
      return { baseAsset: upper.slice(0, -quote.length), quoteAsset: quote };
    }
  }
  return { baseAsset: upper, quoteAsset: "" };
}
