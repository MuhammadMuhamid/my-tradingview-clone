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
  ALL_QUOTES, ALL_TYPES, ASSET_CLASS_CHIPS, EXPIRY_LABELS, EXPIRY_OPTIONS, NO_INTENT, SEARCH_MARKET,
  SEARCH_VENUE, TYPE_LABELS, chipDegradedTitle, chipForInstrument, chipTypeDefault, currentFirst,
  degradedSources, degradedSummary, describeResult, dialogClosed, matchParts, moveCursor, pressEnter,
  queryChanged, quoteFilters, responseArrived, rowAtCursor, rowDescription, rowTicker, rowTitle,
  rowTypeWords, searchKey, searchSummary, showsExpiry, sourceLabel, typeOptionsFor, venueFilters,
  venueOptions, type SearchInstrumentType,
} from "../lib/symbolSearch";
import { shortReason } from "../lib/errorCopy";
import { displayTicker } from "../lib/instrument";
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
const LIB = "lib/symbolSearch.ts";
const SEED: PaneSeed = { symbol: "SOLUSDT", interval: "15m" };

const row = (over: Partial<SymbolSearchResult> = {}): SymbolSearchResult => ({
  symbol: "SOLUSDT", baseAsset: "SOL", quoteAsset: "USDT", tracked: true, ...over,
} as SymbolSearchResult);

// ── market identity ────────────────────────────────────────────────────────

/**
 * ── TVP8 R4: why this asserts a TABLE and not the component's text ────────
 *
 * This case used to grep `SPOT`, `PERP`, `FUTURE`, `CONT`… out of the JSX,
 * which is where the old dialog printed them as uppercase tab labels. That
 * could not tell a rendered filter from a deleted one — the strings would
 * have survived in a comment, a title or a dead branch — and it actively
 * fought the repair, because the reference's dialog has no uppercase type
 * tabs at all.
 *
 * The claim set now lives in `lib/symbolSearch` as the chip table and the
 * per-chip type menus, so what the dialog OFFERS can be asserted directly.
 */
test("the dialog offers every implemented market identity while unsupported identifiers remain absent", () => {
  const implemented: SearchInstrumentType[] = ["all", "spot", "perpetual", "future", "continuous_future",
    "fx_pair", "index", "commodity", "stock", "etf"];
  const offered = new Set(ASSET_CLASS_CHIPS.flatMap((chip) => typeOptionsFor(chip.id)));
  for (const type of implemented) {
    assert.ok(offered.has(type), `${type} is implemented but no chip's menu offers it`);
    assert.ok(TYPE_LABELS[type].length > 0, `${type} has no reader-facing label`);
  }
  assert.deepEqual([...EXPIRY_OPTIONS].sort(), ["30d", "90d", "all", "expired", "live"],
    "every expiry window the futures catalogue supports is offered");
  for (const expiry of EXPIRY_OPTIONS) assert.ok(EXPIRY_LABELS[expiry].length > 0);

  /*
   * Bonds, Economy and Options are the reference's chips that we have no
   * contract for. Rendering them would promise a catalogue that does not
   * exist — the same rule that keeps ISIN and CUSIP out of the placeholder.
   */
  assert.deepEqual(ASSET_CLASS_CHIPS.map((chip) => chip.label),
    ["All", "Stocks", "Funds", "Futures", "Forex", "Crypto", "Indices"]);
  const labels = ASSET_CLASS_CHIPS.map((chip) => chip.label).join(" ");
  for (const absent of [/bond/i, /econom/i, /option/i]) assert.doesNotMatch(labels, absent);

  const source = readCode(DIALOG);
  assert.match(source, /Filter by instrument type/,
    "the types menu keeps the accessible name the contract names it by");
  for (const forbidden of [/\bCUSIP\b/i, /\bISIN\b/i]) {
    for (const file of [source, readCode(LIB)]) {
      assert.doesNotMatch(file, forbidden,
        `${forbidden} names a market with no feed — a filter for it would return nothing`);
    }
  }
  assert.doesNotMatch(source, /value="option"|instrumentType:\s*"option"/i,
    "an HTML option element is not an options-market capability");
  // And the dialog no longer spends a control band on a native form control.
  assert.doesNotMatch(source, /<select/, "a workstation dialog does not use a native select");
});

test("each chip asks for exactly the market it names", () => {
  const byId = Object.fromEntries(ASSET_CLASS_CHIPS.map((chip) => [chip.id, chip]));
  assert.deepEqual(byId.all!.query, {});
  assert.deepEqual(byId.crypto!.query, { assetClass: "crypto" },
    "Crypto spans spot, perpetual and dated crypto futures — no single type names that set");
  assert.deepEqual(byId.futures!.query, { type: "future" });
  assert.deepEqual(byId.forex!.query, { type: "fx_pair" });
  assert.deepEqual(byId.indices!.query, { type: "index" });
  assert.deepEqual(byId.stocks!.query, { type: "stock" });
  assert.deepEqual(byId.funds!.query, { type: "etf" });

  /*
   * The chip's declared type and the type its menu opens on must agree: the
   * request carries the STATE, so a chip whose default widened back to "all"
   * would silently show the whole catalogue under its own name.
   */
  for (const chip of ASSET_CLASS_CHIPS) {
    assert.equal(chipTypeDefault(chip.id), chip.query.type ?? ALL_TYPES,
      `the ${chip.label} chip opens on a type it does not ask for`);
    assert.ok(typeOptionsFor(chip.id).includes(chipTypeDefault(chip.id)));
  }

  // Commodities are futures — NYMEX and COMEX contracts — so they are a type
  // under Futures rather than a chip of their own.
  assert.ok(typeOptionsFor("futures").includes("commodity"));
  assert.ok(!typeOptionsFor("futures").includes(ALL_TYPES),
    "the route filters one type at a time, so All here would widen past the chip");
  assert.equal(showsExpiry("futures", "future"), true);
  assert.equal(showsExpiry("crypto", "spot"), false, "expiry is a futures question");
});

test("the dialog opens on the class of the instrument the chart is showing", () => {
  assert.equal(chipForInstrument("BTCUSDT"), "crypto", "a legacy bare ticker is Binance spot");
  assert.equal(chipForInstrument("instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot"), "crypto");
  assert.equal(chipForInstrument("instrument:v1:GATEIO:perpetual:BTC:USDT:USDT:perpetual"), "crypto");
  assert.equal(chipForInstrument("instrument:v1:CME:future:ES:USD:USD:dated-20261218"), "futures");
  assert.equal(chipForInstrument("instrument:v1:NYMEX:continuous_future:CL:USD:USD:continuous-cl-front"), "futures");
  assert.equal(chipForInstrument("instrument:v1:OANDA:fx_pair:EUR:USD:USD:cash"), "forex");
  assert.equal(chipForInstrument("instrument:v1:NASDAQ:stock:AAPL:USD:USD:cash"), "stocks");
  assert.equal(chipForInstrument("instrument:v1:NASDAQ:etf:SPY:USD:USD:cash"), "funds");
  assert.equal(chipForInstrument("instrument:v1:SP:index:SPX:USD:USD:cash"), "indices");
});

/**
 * "Open, then Enter" must change nothing.
 *
 * The dialog pre-filled the BASE asset (`BTC` for BINANCE:BTC/USDT), which
 * answers with 162 instruments across every venue, and put the cursor on row
 * 0 — a Hyperliquid perpetual. The fastest gesture a user has therefore
 * switched the chart to a different instrument on a different venue and
 * registered a pair on the way. The ticker pre-fill and this ordering are
 * the two halves of the repair.
 */
test("the box opens on the chart's TICKER and the chart's instrument leads the list", () => {
  assert.equal(displayTicker("instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot"), "BTCUSDT");
  assert.equal(displayTicker("instrument:v1:BINANCE:perpetual:BTC:USD:USD:perpetual"), "BTCUSD.P");
  // A dated series keeps its expiry, because two contracts on one underlying
  // are different instruments. The pair still concatenates — `displayTicker`
  // is `lib/instrument`'s rule and this dialog does not have a second one.
  assert.equal(displayTicker("instrument:v1:CME:future:ES:USD:USD:dated-20261218"), "ESUSD 2026-12-18");

  const current = "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot";
  const answer = [
    row({ symbol: "BTCUSD", canonicalId: "instrument:v1:HYPERLIQUID:perpetual:BTC:USD:USDC:perpetual" }),
    row({ symbol: "BTCUSDT", canonicalId: current }),
    row({ symbol: "BTCUSDC", canonicalId: "instrument:v1:BINANCE:spot:BTC:USDC:USDC:spot" }),
  ];
  assert.deepEqual(currentFirst(answer, current).map((r) => r.canonicalId),
    [current, answer[0]!.canonicalId, answer[2]!.canonicalId],
    "the chart's own instrument leads, and the rest keep the backend's order");
  // Already first, or absent: the order is untouched either way.
  assert.deepEqual(currentFirst(answer, "nothing").map((r) => r.symbol), ["BTCUSD", "BTCUSDT", "BTCUSDC"]);
  assert.deepEqual(currentFirst([], current), []);

  const source = readCode(DIALOG);
  assert.match(source, /setTerm\(displayTicker\(current\)\)/, "the box opens on the ticker, not the base asset");
  assert.match(source, /currentFirst\(res\.results, currentRef\.current\)/);
  assert.match(source, /const row = ordered\[0\];/,
    "an armed Enter must select from the ORDERED rows, or it re-introduces the defect");
  assert.doesNotMatch(source, /on this chart<|border-l-accent/,
    "the current row is aria-current and a title, not an accent edge and a badge");
});

test("a row says what it is in the reference's words, and keeps every fact one hover away", () => {
  const spot = row({ canonicalId: "instrument:v1:BINANCE:spot:SOL:USDT:USDT:spot" });
  assert.equal(rowTicker(spot), "SOLUSDT");
  assert.equal(rowDescription(spot), "SOL / USDT");
  assert.equal(rowTypeWords(spot), "spot crypto");

  const perp = row({ instrumentType: "perpetual", baseAsset: "BTC", quoteAsset: "USD" });
  assert.equal(rowDescription(perp), "BTC / USD perpetual");
  assert.equal(rowTypeWords(perp), "perpetual crypto");

  const dated = row({ instrumentType: "future", baseAsset: "ES", quoteAsset: "USD",
    series: { kind: "dated", expiry: "2026-12-18", delivery: "cash" },
    // Only the three fields the row speaks about; the contract's other
    // fifteen are the identity panel's business, not this list's.
    futures: { contractCode: "ESZ26", chainPosition: "front",
      feed: { status: "auth_subscription_gated", label: "gated", delaySeconds: null },
    } as unknown as SymbolSearchResult["futures"] });
  assert.equal(rowDescription(dated), "ES / USD Dec 2026");
  assert.equal(rowTypeWords(dated), "futures", "a traditional contract is not crypto futures");
  const title = rowTitle(dated, "other");
  assert.match(title, /ESZ26 · front · auth subscription gated/,
    "the strings that used to shout on the row are the row's title now");

  assert.equal(rowTypeWords(row({ instrumentType: "continuous_future" })), "continuous futures");
  assert.equal(rowTypeWords(row({ instrumentType: "fx_pair" })), "forex");
  assert.equal(rowTypeWords(row({ instrumentType: "index" })), "index");
  assert.equal(rowTypeWords(row({ instrumentType: "stock" })), "stock");
  assert.equal(rowTypeWords(row({ instrumentType: "etf" })), "etf");

  // "on this chart" and "choosing it registers the pair" are still said —
  // in the title, which is where a detail belongs.
  assert.match(rowTitle(spot, "instrument:v1:BINANCE:spot:SOL:USDT:USDT:spot"), /on this chart/);
  assert.match(rowTitle(row({ tracked: false }), "other"), /choosing it registers the pair/);

  // The matched part of the description is what the reference marks.
  assert.deepEqual(matchParts("Bitcoin / TetherUS", "bit"), { pre: "", hit: "Bit", post: "coin / TetherUS" });
  assert.equal(matchParts("SOL / USDT", ""), null);
  assert.equal(matchParts("SOL / USDT", "zz"), null);
});

/**
 * Every truthful provider limitation stays visible — none of it is a headline.
 *
 * The dialog opened on a 50px amber banner reading `bybit-spot,
 * robinhood-crypto, binance-derivatives, … unavailable`, above the first
 * result, on every open. Contract §5 forbids a provider id as primary copy,
 * and `tests/dom/symbolSearchDialog.test.tsx` reads the rendered DOM for it.
 * What this pins is the vocabulary: venues by LABEL, causes behind a title.
 */
test("a failing provider is named by its venue, counted in the footer, and never as an id", () => {
  const venues = [{ id: "BYBIT", label: "Bybit" }, { id: "BINANCE", label: "Binance" }];
  const errors = [
    { providerId: "bybit-spot", error: "HTTP 403" },
    { providerId: "binance-derivatives", error: "HTTP 451" },
    { providerId: "robinhood-crypto", error: "no credential configured" },
  ];
  assert.equal(sourceLabel("bybit-spot", venues), "Bybit");
  assert.equal(sourceLabel("binance-derivatives", venues), "Binance derivatives");
  assert.equal(sourceLabel("robinhood-crypto", venues), "Robinhood Crypto");
  assert.equal(sourceLabel("alpaca-us-equities", venues), "Alpaca U.S. Equities");

  const down = degradedSources(errors, venues, shortReason);
  assert.deepEqual(down.map((item) => item.label), ["Bybit", "Binance derivatives", "Robinhood Crypto"]);
  for (const item of down) {
    assert.doesNotMatch(item.label, /-/, "a provider id is not a name a reader can use");
    assert.ok(item.error.length > 0, "the cause is kept verbatim, for the tooltip");
  }
  assert.equal(degradedSummary(3), "3 sources unavailable");
  assert.equal(degradedSummary(1), "1 source unavailable");

  // A chip dies only when EVERY provider carrying it is down.
  const stocks = ASSET_CLASS_CHIPS.find((chip) => chip.id === "stocks")!;
  assert.equal(chipDegradedTitle(stocks, [], shortReason), null);
  const why = chipDegradedTitle(stocks, [{ providerId: "alpaca-us-equities", error: "403 unverified" }], shortReason);
  assert.match(why ?? "", /^U\.S\. stocks are unavailable — /);
  assert.doesNotMatch(why ?? "", /alpaca-us-equities|403/,
    "the reason is a sentence; the raw cause belongs in the popover's detail column");
  assert.equal(chipDegradedTitle(ASSET_CLASS_CHIPS[0]!, errors, shortReason), null,
    "a class carried by many venues does not die because one of them did");

  // A venue that answered nothing and whose provider failed is offered
  // DISABLED, rather than removed — a venue that vanishes looks unsupported.
  const options = venueOptions({ venues, rows: [row({ venueId: "BINANCE" })], chip: "crypto",
    selected: "ALL", errors, reason: shortReason });
  const bybit = options.find((item) => item.id === "BYBIT");
  assert.ok(bybit, "Bybit is still listed");
  assert.equal(bybit.unavailable, true);
  assert.equal(options.find((item) => item.id === "BINANCE")?.unavailable, false,
    "Binance answered, so its failing derivatives book does not disable it");
});

test("the venue and market are stated rather than left to be inferred", () => {
  assert.equal(SEARCH_VENUE, "All venues");
  assert.equal(SEARCH_MARKET, "Crypto, stocks, FX, futures & indices");
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
  assert.equal(describeResult(row({ instrumentType: "stock" })).market, "STOCK");
  assert.equal(describeResult(row({ instrumentType: "etf" })).market, "ETF");
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
  assert.match(source, /Type to search crypto, U\.S\. stocks\/ETFs, FX, futures and indices/);
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
