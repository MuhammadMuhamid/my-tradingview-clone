/**
 * How a watchlist is ordered, and what happens to a quote when it moves.
 *
 * ── The order is the user's, until they ask for another one ────────────────
 *
 * A watchlist has a MANUAL order — the order the user dragged rows into — and
 * that is what is persisted. Sorting by a column is a VIEW of that list, not a
 * rewrite of it: sorting by change, looking, then clearing the sort must give
 * the user their own arrangement back rather than leaving them to reconstruct
 * it. So a sort is remembered separately from the list, and dragging while a
 * sort is active is refused rather than silently reordering something the user
 * cannot see the effect of.
 *
 * ── The quote does not follow the row ──────────────────────────────────────
 *
 * Quotes are keyed by SYMBOL, never by position, so reordering cannot move a
 * price onto the wrong row — that failure only exists when quotes are held
 * positionally. Dropping the quote of a REMOVED symbol is
 * `retainTickers` in `lib/useWatchlistTickers`, which already did it and is
 * not duplicated here: a second implementation of "which quotes are still
 * ours" is how the two come to disagree.
 */

export type SortColumn = "manual" | "symbol" | "last" | "change";
export type SortDirection = "asc" | "desc";

export interface WatchlistSort {
  column: SortColumn;
  direction: SortDirection;
}

export const MANUAL_SORT: WatchlistSort = { column: "manual", direction: "asc" };

export interface WatchlistQuote {
  last: number;
  chgPct: number;
}

/**
 * Clicking a column header.
 *
 * First click sorts descending for the numeric columns — a watchlist is read
 * top-down for "what moved most", so ascending first would show the least
 * interesting rows. Clicking the active column flips it; clicking a third time
 * returns to the user's own order, so a sort is never a one-way door.
 */
export function nextSort(current: WatchlistSort, column: SortColumn): WatchlistSort {
  if (column === "manual") return MANUAL_SORT;
  if (current.column !== column) {
    return { column, direction: column === "symbol" ? "asc" : "desc" };
  }
  if (current.direction === (column === "symbol" ? "asc" : "desc")) {
    return { column, direction: column === "symbol" ? "desc" : "asc" };
  }
  return MANUAL_SORT;
}

/**
 * The rows in display order.
 *
 * A row with no quote yet sorts LAST in every numeric order, ascending or
 * descending. Treating a missing quote as zero would put unquoted symbols
 * among the flat ones and invite the reader to believe they had not moved.
 */
export function sortSymbols(
  symbols: readonly string[],
  quotes: Readonly<Record<string, WatchlistQuote | undefined>>,
  sort: WatchlistSort
): string[] {
  if (sort.column === "manual") return [...symbols];
  const sign = sort.direction === "asc" ? 1 : -1;
  const value = (symbol: string): number | null => {
    const quote = quotes[symbol];
    if (!quote) return null;
    const v = sort.column === "last" ? quote.last : quote.chgPct;
    return Number.isFinite(v) ? v : null;
  };
  return [...symbols].sort((a, b) => {
    if (sort.column === "symbol") return sign * a.localeCompare(b);
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return a.localeCompare(b);
    if (va === null) return 1;
    if (vb === null) return -1;
    return sign * (va - vb) || a.localeCompare(b);
  });
}

/**
 * Move one symbol to a new position in the manual order.
 *
 * Total: a symbol not on the list, or a target outside it, returns the list
 * unchanged rather than appending or throwing. A drag that ends somewhere
 * unexpected should do nothing, not something surprising.
 */
export function reorderSymbols(
  symbols: readonly string[], symbol: string, toIndex: number
): string[] {
  const from = symbols.indexOf(symbol);
  if (from < 0) return [...symbols];
  const target = Math.max(0, Math.min(symbols.length - 1, Math.trunc(toIndex)));
  if (from === target) return [...symbols];
  const next = [...symbols];
  next.splice(from, 1);
  next.splice(target, 0, symbol);
  return next;
}

/**
 * Whether dragging is allowed right now.
 *
 * Only in the user's own order. Dragging a row while the list is sorted by
 * change would write a manual position the user cannot see, and the row would
 * appear not to have moved — the drag would look broken and would silently
 * have done something.
 */
export function canReorder(sort: WatchlistSort): boolean {
  return sort.column === "manual";
}

export function reorderRefusal(sort: WatchlistSort): string | null {
  return canReorder(sort)
    ? null
    : "Clear the sort to rearrange this list — dragging while sorted would move " +
      "a row you cannot see move.";
}
