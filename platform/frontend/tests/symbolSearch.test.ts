/**
 * The symbol dialog: market-aware, keyboard-driven, and unable to retarget a
 * staged order.
 *
 * The last of those is the one that matters most and is the least visible. The
 * dialog is opened FOR a pane and holds that pane's id; the order ticket has a
 * target of its own that focus does not move. Both rules are checked here —
 * the first structurally, the second against `lib/tradingTarget`, because a
 * regression in either is silent and expensive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ALL_QUOTES, NO_INTENT, SEARCH_MARKET, SEARCH_VENUE, describeResult, dialogClosed,
  moveCursor, pressEnter, queryChanged, quoteFilters, responseArrived, rowAtCursor,
  searchKey, searchSummary, venueFilters,
} from "../lib/symbolSearch";
import type { SymbolSearchResult } from "../lib/api";
import { resolveTradingTarget, tradingTargetNotice } from "../lib/tradingTarget";
import {
  applyPaneSymbol, createWorkspace, setActivePane, setPaneCount,
  type ChartWorkspace, type PaneSeed,
} from "../lib/workspace";
import { DEFAULT_SYNC } from "../lib/paneSync";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readCode = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const DIALOG = "components/tv/SymbolSearch.tsx";
const SEED: PaneSeed = { symbol: "SOLUSDT", interval: "15m" };

const row = (over: Partial<SymbolSearchResult> = {}): SymbolSearchResult => ({
  symbol: "SOLUSDT", baseAsset: "SOL", quoteAsset: "USDT", tracked: true, ...over,
} as SymbolSearchResult);

// ── market identity ────────────────────────────────────────────────────────

test("the dialog offers spot, perpetual and future identity while options and unrelated markets remain absent", () => {
  const source = readCode(DIALOG);
  for (const supported of [/\bSPOT\b/, /\bPERP\b/, /\bFUTURE\b/, /Filter by instrument type/]) {
    assert.match(source, supported);
  }
  for (const forbidden of [
    /\bforex\b/i, /\bstocks?\b/i,
    /\bequit(y|ies)\b/i, /\bindices\b/i, /\bCUSIP\b/i, /\bISIN\b/i,
  ]) {
    assert.doesNotMatch(source, forbidden,
      `${forbidden} names a market with no feed — a filter for it would return nothing`);
  }
  assert.doesNotMatch(source, /value="option"|instrumentType:\s*"option"/i,
    "an HTML option element is not an options-market capability");
});

test("the venue and market are stated rather than left to be inferred", () => {
  assert.equal(SEARCH_VENUE, "All venues");
  assert.equal(SEARCH_MARKET, "Spot, perpetuals & futures");
  const source = read(DIALOG);
  assert.match(source, /SEARCH_VENUE/);
  assert.match(source, /SEARCH_MARKET/);
});

test("quote assets are deduplicated and normalised alongside type and expiry filters", () => {
  assert.deepEqual(quoteFilters(["USDT", "BTC"]), [ALL_QUOTES, "USDT", "BTC"]);
  assert.deepEqual(quoteFilters(["usdt", "USDT", " btc "]), [ALL_QUOTES, "USDT", "BTC"]);
  // A malformed or empty payload must not produce a blank chip.
  assert.deepEqual(quoteFilters([]), [ALL_QUOTES]);
  assert.deepEqual(quoteFilters(null), [ALL_QUOTES]);
  assert.deepEqual(quoteFilters(["", "  ", "ALL"] as string[]), [ALL_QUOTES]);
  assert.deepEqual(quoteFilters([1, "USDT"] as unknown as string[]), [ALL_QUOTES, "USDT"]);
});

test("venue filters are explicit and deduplicated for collision disambiguation", () => {
  assert.deepEqual(venueFilters([
    { id: "coinbase", label: "Coinbase" }, { id: "COINBASE", label: "Duplicate" },
    { id: "kraken", label: "Kraken" },
  ]), [
    { id: "ALL", label: "All venues" },
    { id: "COINBASE", label: "Coinbase" },
    { id: "KRAKEN", label: "Kraken" },
  ]);
});

test("a result describes its exact product type, and says when choosing it registers a pair", () => {
  assert.deepEqual(describeResult(row()), {
    pair: "SOL / USDT", venue: "All venues", market: "SPOT", needsAdding: false,
  });
  assert.equal(describeResult(row({ instrumentType: "perpetual" })).market, "PERP");
  assert.equal(describeResult(row({ instrumentType: "future", series: { kind: "dated", expiry: "2026-12-18", delivery: "cash" } })).market,
    "FUTURE 2026-12-18");
  assert.equal(describeResult(row({ tracked: false })).needsAdding, true);
});

// ── keyboard ───────────────────────────────────────────────────────────────

test("the highlight cannot point at a row that is not there", () => {
  // The regression: clamping to `rows.length - 1` gives -1 for an empty list,
  // and clamping the lower bound to 0 then points at nothing.
  assert.equal(moveCursor(0, 1, 0), -1);
  assert.equal(moveCursor(5, -1, 0), -1);
  assert.equal(rowAtCursor([], -1), null);
  assert.equal(rowAtCursor([], 0), null);
});

test("arrow keys move within the list and stop at both ends", () => {
  assert.equal(moveCursor(0, 1, 3), 1);
  assert.equal(moveCursor(2, 1, 3), 2, "Down at the last row stays there");
  assert.equal(moveCursor(0, -1, 3), 0, "Up at the first row stays there");
  assert.equal(moveCursor(-1, 1, 3), 0, "the first Down enters the list");
  // Total for nonsense input rather than producing NaN.
  assert.equal(moveCursor(Number.NaN, 1, 3), 1);
});

test("Enter selects the highlighted row and nothing otherwise", () => {
  const rows = [row({ symbol: "A" }), row({ symbol: "B" })];
  assert.equal(rowAtCursor(rows, 1)?.symbol, "B");
  assert.equal(rowAtCursor(rows, 2), null);
  assert.equal(rowAtCursor(rows, -1), null);
});

test("the dialog implements the keyboard contract it advertises", () => {
  const source = read(DIALOG);
  assert.match(source, /e\.key === "Escape"/);
  assert.match(source, /ArrowDown/);
  assert.match(source, /ArrowUp/);
  assert.match(source, /e\.key === "Enter"/);
  // Focus must stay inside a modal dialog and go back to the trigger after.
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /e\.key !== "Tab"/);
  assert.match(source, /restoreTo\.current/);
  assert.match(source, /inputRef\.current\?\.focus\(\)/, "search must be focused on open");
});

// ── empty, malformed and failed states ─────────────────────────────────────

test("the footer says what it is counting, and never a bare number", () => {
  assert.equal(searchSummary({ busy: true, shown: 0, total: 0 }), "Searching…");
  assert.equal(searchSummary({ busy: false, shown: 0, total: 0 }),
    "No market instrument matches");
  assert.equal(searchSummary({ busy: false, shown: 1, total: 1 }), "1 market instrument");
  assert.equal(searchSummary({ busy: false, shown: 60, total: 240 }),
    "60 of 240 market instruments");
});

test("a failed search clears the rows rather than leaving a stale answer under an error", () => {
  const source = read(DIALOG);
  const failure = source.slice(source.indexOf(".catch((e)"), source.indexOf(".finally("));
  assert.match(failure, /setRows\(\[\]\)/,
    "rows from a previous term are not an answer to this one, and are clickable");
  assert.match(failure, /setCursor\(-1\)/);
  assert.match(source, /role="alert"/);
  assert.match(source, /The chart keeps its current symbol\. Nothing was changed\./);
});

test("an empty search is distinguished from a search that matched nothing", () => {
  const source = read(DIALOG);
  assert.match(source, /term\.trim\(\)\.length === 0/);
  assert.match(source, /Type to search every/);
});

// ── which chart it changes ─────────────────────────────────────────────────

test("the dialog holds the pane it was opened for and never resolves one itself", () => {
  const dialog = readCode(DIALOG);
  assert.doesNotMatch(dialog, /activePaneId|from "@\/lib\/workspace"/,
    "resolving the active pane here would let a click elsewhere move the target");

  const page = read("app/chart/page.tsx");
  assert.match(page, /const \[searchPaneId, setSearchPaneId\] = useState<string \| null>\(null\)/);
  assert.match(page, /onSelectSymbol=\{\(s\) => \{ if \(searchPaneId\) changePaneSymbol\(searchPaneId, s\); \}\}/,
    "the selection must land on the pane the dialog was opened for");
  assert.match(page, /onOpenSearch=\{\(\) => setSearchPaneId\(active\.id\)\}/,
    "from the toolbar, that pane is the focused one");
});

test("selecting a symbol changes the targeted pane and only that pane", () => {
  // Sync off, so the change is provably scoped rather than incidentally global.
  const sync = { ...DEFAULT_SYNC, symbol: false };
  const four = setPaneCount(createWorkspace(SEED, "4-grid"), 4);
  const second = four.panes[1]!.id;
  const next = applyPaneSymbol(four, second, "BTCUSDT", sync);
  assert.equal(next.panes[1]!.symbol, "BTCUSDT");
  assert.deepEqual(
    next.panes.filter((p) => p.id !== second).map((p) => p.symbol),
    ["SOLUSDT", "SOLUSDT", "SOLUSDT"]
  );
});

// ── the staged order is not retargeted by any of this ───────────────────────

const staged = (workspace: ChartWorkspace, previous: ReturnType<typeof resolveTradingTarget> | null) =>
  resolveTradingTarget({ workspace, previous, ticketStaged: true });

test("focusing another chart while an order is staged does not move the ticket", () => {
  let ws = setPaneCount(createWorkspace(SEED, "2-cols"), 2);
  const [first, second] = [ws.panes[0]!.id, ws.panes[1]!.id];
  ws = applyPaneSymbol(ws, second, "BTCUSDT", { ...DEFAULT_SYNC, symbol: false });

  const armed = staged(ws, { paneId: first, symbol: "SOLUSDT", pinned: false });
  assert.equal(armed.symbol, "SOLUSDT");

  // The operator's pointer lands on the other chart. Focus moves; the order
  // does not, and the panel is told to say so.
  ws = setActivePane(ws, second);
  const afterFocus = staged(ws, armed);
  assert.equal(afterFocus.symbol, "SOLUSDT", "the staged ticket was silently retargeted");
  assert.equal(afterFocus.pinned, true);
  assert.match(tradingTargetNotice(afterFocus, ws) ?? "", /staged for SOLUSDT/);
});

test("opening the symbol dialog does not itself change the ticket's target", () => {
  // The dialog is a dialog: it changes a pane's symbol only when a row is
  // chosen. Opening it, typing in it and closing it touch no workspace state,
  // so the resolver sees an unchanged workspace and holds the pin.
  const ws = setPaneCount(createWorkspace(SEED, "2-cols"), 2);
  const armed = staged(ws, { paneId: ws.panes[0]!.id, symbol: "SOLUSDT", pinned: false });
  assert.deepEqual(staged(ws, armed), armed);

  const page = read("app/chart/page.tsx");
  const opener = /setSearchPaneId\(active\.id\)/;
  assert.match(page, opener);
  // Opening the dialog must not also focus, disarm or restage anything.
  assert.doesNotMatch(page, /setSearchPaneId\([^)]*\);\s*set(ActivePane|Panel|Trading)/);
});

test("changing the pinned pane's own symbol follows it, so the panel's disarm still runs", () => {
  let ws = setPaneCount(createWorkspace(SEED, "2-cols"), 2);
  const first = ws.panes[0]!.id;
  const armed = staged(ws, { paneId: first, symbol: "SOLUSDT", pinned: false });

  ws = applyPaneSymbol(ws, first, "ETHUSDT", { ...DEFAULT_SYNC, symbol: false });
  const followed = staged(ws, armed);
  assert.equal(followed.symbol, "ETHUSDT",
    "a deliberate symbol change on the pinned pane is a supported workflow");
  assert.equal(followed.paneId, first);
});

// ── Enter cannot select a previous query's results ──────────────────────────

/**
 * The race, driven directly.
 *
 * The dialog opens seeded with the CURRENT symbol and debounces its search by
 * 180 ms. Pasting a different ticker and pressing Enter inside that window used
 * to select `rows[cursor]` — still the answer to the seeded query — so the
 * chart kept the symbol the user had just replaced, silently.
 *
 * These drive `SearchIntent` itself rather than asserting that the component's
 * source text contains certain regexes. Every case below is a race, and a race
 * is exactly what a source-text assertion cannot observe: two of them shipped
 * green underneath one.
 */

test("Enter against the answered query selects; Enter against a stale one flushes", () => {
  const answered = { rowsKey: searchKey("SOL", ALL_QUOTES), pendingEnter: false };
  assert.equal(pressEnter(answered, searchKey("SOL", ALL_QUOTES)).action, "select");

  const stale = pressEnter(answered, searchKey("SOLUSDT", ALL_QUOTES));
  assert.equal(stale.action, "flush", "rows answering an older query are not an answer");
  assert.equal(stale.intent.pendingEnter, true, "and the Enter is remembered, not dropped");
});

test("a flushed Enter is honoured by its own query's answer", () => {
  let intent = NO_INTENT;
  intent = pressEnter(intent, searchKey("SOLUSDT", ALL_QUOTES)).intent;
  const landed = responseArrived(intent, searchKey("SOLUSDT", ALL_QUOTES), true);
  assert.equal(landed.action, "select-top",
    "the impatient path must still change the symbol — that is the point of A3");
  assert.equal(landed.intent.pendingEnter, false, "and it is consumed exactly once");
  assert.equal(landed.intent.rowsKey, searchKey("SOLUSDT", ALL_QUOTES));
});

test("typing again drops the armed Enter rather than committing a later query", () => {
  // Type SOL, press Enter before the debounce, then fix a typo.
  let intent = pressEnter(NO_INTENT, searchKey("SOL", ALL_QUOTES)).intent;
  assert.equal(intent.pendingEnter, true);
  intent = queryChanged(intent);
  assert.equal(intent.pendingEnter, false,
    "the Enter was about the earlier text; honouring it for a later query " +
    "commits the user to a symbol they never confirmed");
  assert.equal(responseArrived(intent, searchKey("SOLU", ALL_QUOTES), true).action, "none");
});

test("closing the dialog cancels an armed Enter, so a cancelled search changes nothing", () => {
  // Enter, then Escape inside the request latency.
  const armed = pressEnter(NO_INTENT, searchKey("SOLUSDT", ALL_QUOTES)).intent;
  const afterClose = dialogClosed();
  assert.equal(afterClose.pendingEnter, false);

  // Even if the intent somehow survived, a closed dialog must not select: the
  // panel is gone, and selecting would retarget the pane and can POST a new
  // symbol with nothing on screen to explain it.
  assert.equal(responseArrived(armed, searchKey("SOLUSDT", ALL_QUOTES), false).action, "none");
  assert.equal(responseArrived(armed, searchKey("SOLUSDT", ALL_QUOTES), true).action, "select-top",
    "and an open dialog is still served");
});

test("an answer records which query it answered, whether or not an Enter was waiting", () => {
  const settled = responseArrived(NO_INTENT, searchKey("BTC", "USDT"), true);
  assert.equal(settled.action, "none");
  assert.equal(settled.intent.rowsKey, searchKey("BTC", "USDT"));
  // Which is what makes the very next Enter a selection rather than a flush.
  assert.equal(pressEnter(settled.intent, searchKey("BTC", "USDT")).action, "select");
});

test("the dialog wires the reducer up rather than re-implementing it", () => {
  const source = readCode(DIALOG);
  for (const call of ["pressEnter(", "queryChanged(", "responseArrived(", "dialogClosed("]) {
    assert.ok(source.includes(call), `${call} must be the dialog's own arbitration`);
  }
  assert.match(source, /if \(open\) return;[\s\S]{0,160}reqId\.current \+= 1;/,
    "closing must also invalidate requests in flight, not only the intent");
  assert.match(source, /clearTimeout\(timer\);\s*run\(\);/,
    "the flush cancels the pending timer, so it costs one request rather than two");
});

test("mouse, focus and Escape behaviour is untouched by the Enter fix", () => {
  const source = readCode(DIALOG);
  assert.match(source, /onMouseEnter=\{\(\) => setCursor\(i\)\}/);
  assert.match(source, /onClick=\{\(\) => void choose\(r\)\}/);
  assert.match(source, /restoreTo\.current/, "focus is still returned to the trigger");
  // Enter is prevented only on the branches that act, so a keyboard user on a
  // quote chip or the Clear button keeps their ordinary Enter-to-activate.
  const enterBlock = source.slice(source.indexOf('if (e.key === "Enter")'));
  const guard = enterBlock.indexOf("pressEnter(");
  const firstPrevent = enterBlock.indexOf("e.preventDefault()");
  assert.ok(guard >= 0 && firstPrevent > guard,
    "preventDefault must follow the decision, not precede it");
});

test("a chosen symbol persists canonical identity with a Binance compatibility fallback", () => {
  const source = readCode(DIALOG);
  assert.match(source, /onSelect\(row\.canonicalId \?\? storedSymbol\(row\.symbol\)\)/,
    "canonical results keep identity while legacy Binance rows reduce through the resolver");
});
