/**
 * The symbol dialog's non-visual rules.
 *
 * ── Why this is not inside the component ───────────────────────────────────
 *
 * Two of them are worth holding onto with a test rather than a screenshot.
 *
 * The keyboard cursor: ↑/↓ used to clamp against `rows.length - 1`, which is
 * `-1` for an empty result set, so a search that matched nothing left the
 * cursor at 0 pointing into an empty array. Nothing crashed — `rows[0]` is
 * `undefined` and Enter was a no-op — but the rule is easy to get wrong again
 * and impossible to see in review.
 *
 * The market context: this installation trades Binance SPOT and nothing else.
 * There is no futures feed, no equities feed and no FX feed, so a filter chip
 * for any of them would be a control that cannot work. The venue and market
 * are stated here as constants so the dialog says them out loud rather than
 * leaving the user to infer what they are searching.
 */
import type { SymbolSearchResult } from "./api";

/** The only venue this installation has a feed for. */
export const SEARCH_VENUE = "Binance";
/** The only market. Spot: no futures, no margin, no shorting. */
export const SEARCH_MARKET = "Spot";

/** The chip that means "do not filter by quote asset". */
export const ALL_QUOTES = "ALL";

/**
 * The quote-asset chips, from whatever the server reported.
 *
 * Quote asset is the only filter axis that exists here — every result is a
 * Binance spot pair, so an asset-class filter would have exactly one value.
 */
export function quoteFilters(quotes: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [ALL_QUOTES];
  for (const q of quotes ?? []) {
    if (typeof q !== "string") continue;
    const upper = q.trim().toUpperCase();
    if (upper.length === 0 || upper === ALL_QUOTES || seen.has(upper)) continue;
    seen.add(upper);
    out.push(upper);
  }
  return out;
}

/**
 * Where the highlight lands after a key press.
 *
 * Total for every length, including zero — an empty result set has no row to
 * highlight, and `-1` says so rather than pointing at a row that is not there.
 */
export function moveCursor(cursor: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  const next = (Number.isFinite(cursor) ? Math.trunc(cursor) : 0) + delta;
  return Math.max(0, Math.min(length - 1, next));
}

/** The row Enter would select, or null when there is none. */
export function rowAtCursor<T>(rows: readonly T[], cursor: number): T | null {
  if (cursor < 0 || cursor >= rows.length) return null;
  return rows[cursor] ?? null;
}

/** The footer count. Says what it is looking at, not just a number. */
export function searchSummary(input: {
  busy: boolean; shown: number; total: number;
}): string {
  if (input.busy) return "Searching…";
  if (input.total === 0) return `No ${SEARCH_VENUE} ${SEARCH_MARKET} pair matches`;
  if (input.shown >= input.total) {
    return `${input.total} ${SEARCH_VENUE} ${SEARCH_MARKET} pair${input.total === 1 ? "" : "s"}`;
  }
  return `${input.shown} of ${input.total} ${SEARCH_VENUE} ${SEARCH_MARKET} pairs`;
}

/**
 * What one result row says about itself, beyond its ticker.
 *
 * `tracked: false` means the pair exists on the venue but this installation has
 * never stored it; choosing it registers it first. Saying "add" rather than
 * nothing is what makes that a decision instead of a surprise.
 */
export function describeResult(row: SymbolSearchResult): {
  pair: string; venue: string; market: string; needsAdding: boolean;
} {
  return {
    pair: `${row.baseAsset} / ${row.quoteAsset}`,
    venue: SEARCH_VENUE,
    market: SEARCH_MARKET,
    needsAdding: !row.tracked,
  };
}
