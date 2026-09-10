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
 * The market context is explicit because one catalog now spans crypto, U.S.
 * stocks and ETFs. Product and venue filters preserve the canonical identity;
 * options and FX remain absent because no provider contract supports them.
 */
import type { SymbolSearchResult } from "./api";

/** Search is provider-aggregated and can return several canonical venues. */
export const SEARCH_VENUE = "All venues";
/** The supported read-only market catalog. Options remain intentionally absent. */
export const SEARCH_MARKET = "Crypto, stocks, FX, futures & indices";

/** The chip that means "do not filter by quote asset". */
export const ALL_QUOTES = "ALL";
export const ALL_VENUES = "ALL";
export const ALL_TYPES = "all";
export const LIVE_EXPIRIES = "live";
export type SearchInstrumentType = "all" | "spot" | "perpetual" | "future" | "continuous_future" | "stock" | "etf" |
  "fx_pair" | "commodity" | "index";
export type SearchExpiry = "all" | "live" | "30d" | "90d" | "expired";

/**
 * The quote-asset chips, from whatever the server reported.
 *
 * Quote/currency is one of several explicit filter axes; product type and
 * venue remain separate so identical tickers cannot collapse together.
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

export function venueFilters(venues: readonly { id: string; label: string }[] | null | undefined):
  { id: string; label: string }[] {
  const seen = new Set<string>();
  return [{ id: ALL_VENUES, label: "All venues" }, ...(venues ?? []).filter((venue) => {
    const id = venue.id.trim().toUpperCase();
    if (!id || id === ALL_VENUES || seen.has(id)) return false;
    seen.add(id); return true;
  }).map((venue) => ({ id: venue.id.trim().toUpperCase(), label: venue.label.trim() || venue.id }))];
}

/**
 * The identity of one search: what was typed, and which quote chip is on.
 *
 * Results carry the key of the query they answer, so the dialog can tell an
 * answer to the current input from an answer to the previous one. Enter is
 * allowed to select only from the former — a debounced search means the two
 * are routinely different for the first 180 ms after a keystroke or a paste,
 * which is exactly when an impatient user presses Enter.
 *
 * The term is trimmed and upper-cased because the server treats it that way:
 * two inputs the search cannot distinguish must not count as different
 * queries, or Enter would stall waiting for an answer that already arrived.
 */
export function searchKey(term: string, quote: string, venue = ALL_VENUES,
  type: SearchInstrumentType = ALL_TYPES, expiry: SearchExpiry = LIVE_EXPIRIES): string {
  return `${term.trim().toUpperCase()}|${quote.trim().toUpperCase()}|${venue.trim().toUpperCase()}|${type}|${expiry}`;
}

/* ── Enter, the debounce, and which results may answer it ──────────────────
 *
 * The dialog debounces its search by 180 ms and opens seeded with the current
 * symbol, so for the first fraction of a second after a keystroke or a paste
 * the rows on screen answer the PREVIOUS query. Enter in that window must not
 * select from them.
 *
 * The arbitration is a small state machine, and it lives here — pure, with no
 * React and no timers — because every one of its interesting states is a race:
 * Enter before the answer, Enter then more typing, Enter then Escape, an
 * answer arriving after the dialog has closed. Those are the cases that were
 * got wrong when this logic was inline in the component, and they are cases a
 * source-text assertion cannot observe at all.
 * ──────────────────────────────────────────────────────────────────────── */

export interface SearchIntent {
  /** The query the rows currently on screen answer, or null for none yet. */
  rowsKey: string | null;
  /** An Enter is waiting for the answer to the query that was in the box. */
  pendingEnter: boolean;
}

export const NO_INTENT: SearchIntent = { rowsKey: null, pendingEnter: false };

/**
 * What Enter should do, given what the rows currently answer.
 *
 *   `select`  the rows answer the live query; take the highlighted row.
 *   `flush`   they do not; issue the query NOW and remember that an Enter is
 *             waiting for it. Flushing rather than guessing is what makes the
 *             impatient path cost one request instead of two.
 */
export function pressEnter(
  intent: SearchIntent, currentKey: string
): { intent: SearchIntent; action: "select" | "flush" } {
  if (intent.rowsKey === currentKey) return { intent, action: "select" };
  return { intent: { ...intent, pendingEnter: true }, action: "flush" };
}

/**
 * The query changed — a keystroke, a backspace, a different quote chip.
 *
 * The waiting Enter is dropped. It was an instruction about the text that was
 * in the box at the time; honouring it against a later query would commit the
 * user to a symbol they never confirmed for that query.
 */
export function queryChanged(intent: SearchIntent): SearchIntent {
  return intent.pendingEnter ? { ...intent, pendingEnter: false } : intent;
}

/**
 * A response arrived for `key`.
 *
 * `select` only when an Enter was waiting AND the dialog is still open. A
 * dialog the user has closed — Escape, the backdrop, the ✕ — must not go on to
 * change the chart's symbol and register a pair, which is exactly what an
 * unguarded in-flight request would do after the panel had disappeared.
 */
export function responseArrived(
  intent: SearchIntent, key: string, open: boolean
): { intent: SearchIntent; action: "select-top" | "none" } {
  const settled: SearchIntent = { rowsKey: key, pendingEnter: false };
  const take = intent.pendingEnter && open;
  return { intent: settled, action: take ? "select-top" : "none" };
}

/** The dialog closed. Nothing survives it. */
export function dialogClosed(): SearchIntent {
  return NO_INTENT;
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
  if (input.total === 0) return "No market instrument matches";
  if (input.shown >= input.total) {
    return `${input.total} market instrument${input.total === 1 ? "" : "s"}`;
  }
  return `${input.shown} of ${input.total} market instruments`;
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
    venue: row.venueId ?? SEARCH_VENUE,
    market: row.instrumentType === "perpetual" ? "PERP"
      : row.instrumentType === "future" ? `FUTURE${row.series?.kind === "dated" ? ` ${row.series.expiry}` : ""}`
      : row.instrumentType === "stock" ? "STOCK" : row.instrumentType === "etf" ? "ETF" : "SPOT",
    needsAdding: !row.tracked,
  };
}
