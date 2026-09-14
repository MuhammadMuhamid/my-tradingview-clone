/**
 * How a watchlist is ordered.
 *
 * ── The property that matters ──────────────────────────────────────────────
 *
 * The manual order is the USER'S, and sorting is a way of looking at it rather
 * than a rewrite of it. A watchlist someone spent time arranging, destroyed by
 * a click on a column header, is a small feature costing a real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MANUAL_SORT, canReorder, nextSort, reorderRefusal, reorderSymbols, sortSymbols,
  type WatchlistQuote,
} from "../lib/watchlistOrder";

const LIST = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT"];
/*
 * TVP8 R7b-07: a quote now carries `chg` as well as `chgPct`, because `Chg`
 * and `Chg%` are two columns that sort differently — BTC's 900 is a bigger
 * move than ADA's 0.006 and a smaller one in percent. These figures keep that
 * disagreement live: SOL leads on percent, BTC on absolute change.
 */
const quotes: Record<string, WatchlistQuote> = {
  BTCUSDT: { last: 64_000, chg: 760, chgPct: 1.2 },
  ETHUSDT: { last: 3_200, chg: -25.8, chgPct: -0.8 },
  SOLUSDT: { last: 150, chg: 7.7, chgPct: 5.4 },
  // ADAUSDT has no quote yet.
};

test("the manual order is returned untouched, because it is the user's", () => {
  assert.deepEqual(sortSymbols(LIST, quotes, MANUAL_SORT), LIST);
});

test("a numeric sort runs biggest-first, because that is what a watchlist is read for", () => {
  const byChangePct = sortSymbols(LIST, quotes, { column: "changePct", direction: "desc" });
  assert.deepEqual(byChangePct.slice(0, 3), ["SOLUSDT", "BTCUSDT", "ETHUSDT"]);
});

/*
 * ── R7b-07: `Chg` and `Chg%` were the same sort ───────────────────────────
 *
 * `columns[]` in `Watchlist.tsx` gave both headers the key `"change"`, and
 * `sortSymbols` read `chgPct` for it — so the `Chg` header sorted by percent
 * while claiming to sort by change, and BOTH headers wore the arrow. Run
 * against that, the first assertion below returns `["SOLUSDT","BTCUSDT"]`.
 */
test("R7b-07 — Chg sorts by the absolute move and Chg% by the percentage", () => {
  const two = ["BTCUSDT", "ADAUSDT"];
  const twoQuotes: Record<string, WatchlistQuote> = {
    BTCUSDT: { last: 77_000, chg: 900, chgPct: 1.1 },
    ADAUSDT: { last: 0.21, chg: 0.006, chgPct: 3 },
  };
  assert.deepEqual(sortSymbols(two, twoQuotes, { column: "change", direction: "desc" }),
    ["BTCUSDT", "ADAUSDT"], "900 is a bigger move than 0.006");
  assert.deepEqual(sortSymbols(two, twoQuotes, { column: "changePct", direction: "desc" }),
    ["ADAUSDT", "BTCUSDT"], "3% is a bigger move than 1.1%");
});

test("a row with no quote sorts last in BOTH directions", () => {
  // Treating a missing quote as zero would put unquoted symbols among the flat
  // ones and invite the reader to believe they had not moved.
  for (const direction of ["asc", "desc"] as const) {
    const sorted = sortSymbols(LIST, quotes, { column: "last", direction });
    assert.equal(sorted[sorted.length - 1], "ADAUSDT",
      `an unquoted row must not be mistaken for a flat one (${direction})`);
  }
});

test("clicking a column three times returns the user to their own order", () => {
  // A sort that cannot be cleared is a one-way door out of an arrangement
  // someone spent time on.
  let sort = MANUAL_SORT;
  sort = nextSort(sort, "change");
  assert.deepEqual(sort, { column: "change", direction: "desc" });
  sort = nextSort(sort, "change");
  assert.deepEqual(sort, { column: "change", direction: "asc" });
  sort = nextSort(sort, "change");
  assert.deepEqual(sort, MANUAL_SORT);
});

test("symbol sorts A-Z first; the numeric columns sort biggest first", () => {
  assert.deepEqual(nextSort(MANUAL_SORT, "symbol"), { column: "symbol", direction: "asc" });
  assert.deepEqual(nextSort(MANUAL_SORT, "last"), { column: "last", direction: "desc" });
});

test("dragging is refused while sorted, and says why", () => {
  // A drag under an active sort would write a manual position the user cannot
  // see the effect of: the row would appear not to have moved, so the drag
  // would look broken AND would silently have done something.
  assert.equal(canReorder(MANUAL_SORT), true);
  assert.equal(reorderRefusal(MANUAL_SORT), null);
  const sorted = { column: "change", direction: "desc" } as const;
  assert.equal(canReorder(sorted), false);
  assert.match(String(reorderRefusal(sorted)), /Clear the sort/);
});

test("a reorder moves exactly one row and keeps every other", () => {
  const moved = reorderSymbols(LIST, "SOLUSDT", 0);
  assert.deepEqual(moved, ["SOLUSDT", "BTCUSDT", "ETHUSDT", "ADAUSDT"]);
  assert.equal(moved.length, LIST.length);
  assert.deepEqual([...moved].sort(), [...LIST].sort(), "no symbol may be lost or duplicated");
});

test("a drag that ends somewhere unexpected does nothing, rather than something surprising", () => {
  assert.deepEqual(reorderSymbols(LIST, "NOTONLIST", 1), LIST);
  // Past either end clamps rather than appending twice or throwing.
  assert.deepEqual(reorderSymbols(LIST, "BTCUSDT", 99), ["ETHUSDT", "SOLUSDT", "ADAUSDT", "BTCUSDT"]);
  assert.deepEqual(reorderSymbols(LIST, "ADAUSDT", -5), ["ADAUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.deepEqual(reorderSymbols(LIST, "BTCUSDT", 0), LIST, "moving a row onto itself changes nothing");
});

test("sorting never adds or loses a row", () => {
  for (const column of ["symbol", "last", "change", "changePct"] as const) {
    for (const direction of ["asc", "desc"] as const) {
      const sorted = sortSymbols(LIST, quotes, { column, direction });
      assert.deepEqual([...sorted].sort(), [...LIST].sort(), `${column} ${direction}`);
    }
  }
});

test("the quote belongs to the symbol, not to the row's position", () => {
  // The reason a reorder cannot show the wrong price: `sortSymbols` returns
  // names, and every quote is looked up by name. A positional list of quotes
  // is what makes a reordered watchlist display the previous occupant's price.
  const sorted = sortSymbols(LIST, quotes, { column: "changePct", direction: "desc" });
  assert.equal(quotes[sorted[0]!]!.chgPct, 5.4, "SOLUSDT's own change, wherever it now sits");
  const reordered = reorderSymbols(LIST, "SOLUSDT", 0);
  assert.equal(quotes[reordered[0]!]!.last, 150);
});
