/**
 * The Phase 02A usability pass, pinned.
 *
 * Every case here is a defect that was found by looking at the product in a
 * real browser and that no existing test could see — because the suite reads
 * source and reasons about state, and none of these were state bugs. They were
 * a missing utility class, a row that could not compress, two branches that
 * rendered at once, a date formatted in the wrong zone, and several screens
 * that answered a question they had never actually asked.
 *
 * These are static checks over the source. That is the honest description of
 * what they are: they cannot see a rendered pixel, so each one pins the
 * specific CAUSE that was measured, not the appearance it produced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fmtDate, fmtDateTime } from "../lib/format";
import { TRADE_LABEL_LIMIT, tradeMarkerCount } from "../components/CandleChart";
import { allNavLinks, productMenuLinks, SYSTEM_LINKS } from "../lib/navigation";
import type { Trade } from "../lib/types";

const ROOT = path.join(__dirname, "..");
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), "utf8");

// ── The chart workspace ─────────────────────────────────────────────────────

test("a pane fills the workspace cell it was given", () => {
  const pane = read("components/tv/ChartPane.tsx");
  const host = read("components/tv/ChartWorkspace.tsx");

  // The measured defect: the cell is a flex row, and the pane took `flex: 0 1
  // auto`, so it sized to its CONTENT — 128px inside a 1044px cell, at every
  // desktop width and every pane count.
  const root = /data-pane-id=\{pane\.id\}[\s\S]{0,2400}?className=\{`([^`]*)`/.exec(pane);
  assert.ok(root, "the pane root's className could not be located");
  assert.match(root[1]!, /\bflex-1\b/,
    "the pane root must grow into its cell, or the chart collapses to its content width");
  assert.match(root[1]!, /\bmin-w-0\b/,
    "flex-1 without min-w-0 cannot shrink below content, which reintroduces overflow");

  // …and the pairing only holds while the cell is a flex container.
  for (const cell of host.match(/className="flex min-h-0 min-w-0"/g) ?? []) {
    assert.equal(cell, 'className="flex min-h-0 min-w-0"');
  }
  assert.equal((host.match(/className="flex min-h-0 min-w-0"/g) ?? []).length, 2,
    "both the maximised cell and the grid cell must stay flex containers");
});

test("the toolbar's primary row can give width back", () => {
  const bar = read("components/tv/ChartToolbar.tsx");
  const strip = /ctl\("timeframe"\)[\s\S]{0,400}?className="([^"]*)"/.exec(bar);
  assert.ok(strip, "the timeframe strip could not be located");

  // `flex-none` pinned the absorber at its content width, which made the whole
  // row incompressible: with the 341px trading panel open the row overflowed
  // the main column and painted the saved-layout button over the ticket header.
  assert.doesNotMatch(strip[1]!, /\bsm:flex-none\b/,
    "the one element allowed to absorb width pressure must not be flex-none");
  assert.match(strip[1]!, /\bmin-w-0\b/);
  assert.match(strip[1]!, /\bsm:flex-initial\b/);

  // The strip alone was 6px short at 1024 with the ticket open. The saved-layout
  // name is the row's second absorber and must be able to truncate.
  const saved = /ctl\("savedLayouts"\)[\s\S]{0,120}?className=\{`([^`]*)`/.exec(bar);
  assert.ok(saved, "the saved-layout identity could not be located");
  assert.doesNotMatch(saved[1]!, /\bshrink-0\b/);
  assert.match(saved[1]!, /\bmin-w-0\b/);
  assert.match(read("components/tv/LayoutMenu.tsx"), /min-w-0 max-w-\[130px\] truncate/);
});

test("the feed-state badge is not drawn over the price scale", () => {
  const chart = read("components/CandleChart.tsx");
  const badge = /FEED_BADGE\[feedState\.status\]\.className/.exec(chart);
  assert.ok(badge, "the feed badge could not be located");
  const around = chart.slice(Math.max(0, badge.index - 600), badge.index);
  assert.doesNotMatch(around, /absolute right-2/,
    "the badge must not be pinned to the right edge, where the price scale is");
});

// ── Backtest results ────────────────────────────────────────────────────────

test("a backtest window is labelled in the zone it is defined in", () => {
  // 2026-06-01T00:00:00Z is the window boundary a user who typed 2026-06-01
  // gets. Rendered in a negative-UTC-offset zone it used to read May 31.
  const boundary = Date.UTC(2026, 5, 1, 0, 0, 0);
  for (const tz of ["America/New_York", "Pacific/Honolulu", "Asia/Tokyo", "UTC"]) {
    const before = process.env.TZ;
    process.env.TZ = tz;
    assert.match(fmtDate(boundary), /Jun 01, 2026|01 Jun 2026/,
      `fmtDate must not shift the day in ${tz}`);
    process.env.TZ = before;
  }
});

test("an event time is still the reader's own, and both zones are named", () => {
  // Deliberately unchanged: "when did this happen to me" is a local question.
  // What changed is that the surfaces printing it now say which zone it is.
  assert.equal(typeof fmtDateTime(Date.UTC(2026, 5, 1, 12, 0, 0)), "string");
  assert.match(read("lib/format.ts"), /LOCAL_TIME_NOTE/);
  assert.match(read("lib/format.ts"), /UTC_DATE_NOTE/);
  assert.match(read("app/journal/page.tsx"), /LOCAL_TIME_NOTE/);
  assert.match(read("app/research/page.tsx"), /Window \(UTC\)/);
  assert.match(read("app/trading/page.tsx"), /Bar \(\{CHART_TIME_ZONE\}\)/);
});

test("trade markers stop carrying prices before they stop being readable", () => {
  const trade = (i: number): Trade => ({
    id: String(i), entryTime: 1_000 + i, exitTime: 2_000 + i,
    entryPrice: 100, exitPrice: 101, pnl: 1,
  } as unknown as Trade);
  const all = (): boolean => true;

  assert.equal(tradeMarkerCount([], all), 0);
  assert.equal(tradeMarkerCount([trade(0)], all), 2, "a closed trade draws two markers");
  assert.equal(tradeMarkerCount([trade(0)], () => false), 0, "markers outside the bars are not drawn");

  const many = Array.from({ length: 321 }, (_, i) => trade(i));
  assert.ok(tradeMarkerCount(many, all) > TRADE_LABEL_LIMIT,
    "the real 321-trade run must be over the limit");
  assert.ok(tradeMarkerCount([trade(0), trade(1)], all) <= TRADE_LABEL_LIMIT,
    "a handful of trades must keep their labels");

  const chart = read("components/CandleChart.tsx");
  assert.match(chart, /const labelled = tradeMarkerCount\(trades, inWindow\) <= TRADE_LABEL_LIMIT/);
  // Suppressed labels are announced, not silently dropped.
  assert.match(read("app/research/[id]/page.tsx"), /TRADE_LABEL_LIMIT/);
});

// ── One state at a time ─────────────────────────────────────────────────────

test("the trading panel never shows an error and a spinner at the same time", () => {
  const panel = read("components/tv/ManualTradingPanel.tsx");

  // The banner is for a failed ACTION against loaded state.
  assert.match(panel, /\{error && state && <div role="alert"/);
  // The body is a single chain: unavailable, or loading, or the ticket.
  assert.match(panel, /\{unavailable \? </);
  assert.match(panel, /: !state \? <div role="status"[^>]*>Loading manual trading…/);
  assert.doesNotMatch(panel, /Manual trading is disabled by server configuration/,
    "the disabled case must name itself, not restate the server's flag");

  // The two situations that reached the operator as one 500 are separated.
  assert.match(panel, /Manual trading is not enabled on this install/);
  assert.match(panel, /The execution bot could not be reached/);
});

test("a screen that could not read something does not claim it is empty", () => {
  const cases: [string, RegExp][] = [
    ["app/research/page.tsx", /this is not a statement that you have none/],
    ["app/trading/page.tsx", /this is not a statement that you have none/],
    ["app/shariah/page.tsx", /this is not a statement that it is empty/],
    ["app/shariah/page.tsx", /this is not a statement that there are none/],
  ];
  for (const [file, claim] of cases) assert.match(read(file), claim, `${file} still guesses`);

  // …and the list that swallowed its failure outright now keeps it.
  assert.doesNotMatch(read("app/research/page.tsx"), /listBacktests\(\)\.then\(setRows\)\.catch\(\(\) => \{\}\)/);
});

test("a placeholder stops claiming that an answer is coming", () => {
  const shariah = read("app/shariah/page.tsx");
  assert.match(shariah, /loaded \? "unknown" : "…"/);
  assert.match(shariah, /universeLoaded \? "unknown" : "…"/);
  assert.match(shariah, /Bot floor: could not be read/);

  const scanner = read("app/screener/page.tsx");
  assert.match(scanner, /error \? "market identity unknown" : "market identity loading"/);
  assert.match(scanner, /error \? "No snapshot loaded" : "Loading cached snapshot…"/);

  const optimizers = read("app/optimizers/page.tsx");
  assert.match(optimizers, /treesError \? "Optimizer trees unavailable" : "Loading trees…"/);
  assert.doesNotMatch(optimizers, /\(data\?\.totalBacktests \?\? 0\)\.toLocaleString\(\)/,
    "a failed read is not a total of zero");
});

test("a backtest that is still running is asked about again", () => {
  const detail = read("app/research/[id]/page.tsx");
  assert.match(detail, /setTimeout\(\(\) => void load\(\), 2500\)/);
  assert.match(detail, /if \(b\.status === "error"\) return;/,
    "polling must stop at a terminal state");
  // …and every state of the page keeps its heading and its way back.
  assert.match(detail, /const shell = \(body: ReactNode\)/);
  assert.match(detail, /if \(!bt\) return shell\(/);
});

test("a failed operator control is not erased by the next poll", () => {
  const ops = read("app/operations/page.tsx");
  assert.match(ops, /const \[actionError, setActionError\]/);
  assert.match(ops, /setActionError\(\(e as Error\)\.message\)/);
  // The 10s poll clears `error` on success; it must not reach the action.
  assert.doesNotMatch(ops, /catch \(e\) \{\s*setError\(\(e as Error\)\.message\);\s*\}\s*finally \{\s*setBusy\(false\)/);
});

test("the Shariah status the Scanner cannot read is stated, not hidden", () => {
  const scanner = read("app/screener/page.tsx");
  assert.match(scanner, /Shariah classifications could not be read/);
  assert.match(scanner, /buying is gated by the server either\s*\n?\s*way/);
});

// ── One name per thing ──────────────────────────────────────────────────────

test("the product has one word for paper trading, and one name per subsystem", () => {
  // Comments stripped: prose ABOUT a retired string is not a use of it.
  const health = read("lib/operationsHealth.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(health, /"Dry run"/, "paper is called paper everywhere else");
  assert.doesNotMatch(health, /LiveRunner/, "one name for the live runner, in copy and in evidence");
  assert.match(health, /\? "Paper"/);
  assert.doesNotMatch(health, /name: "LiveRunner"/);
  assert.match(health, /name: "Live runner"/);
  assert.doesNotMatch(health, /name: "Market Data"/);

  const ops = read("app/operations/page.tsx");
  // The health list's name and the card beneath it must be the same words.
  assert.match(ops, /\/>Webhook delivery</);
  assert.match(ops, /\/>Market data</);
  assert.match(ops, /\/>Live runner</);

  assert.doesNotMatch(read("app/journal/page.tsx"), /Simulation evidence/);
  assert.doesNotMatch(read("app/optimizers/page.tsx"), /optimiser/i);
  for (const f of ["app/trading/page.tsx", "app/operations/page.tsx"]) {
    assert.doesNotMatch(read(f), />Realised</, `${f} still spells the label two ways`);
  }
});

// ── Reachability ────────────────────────────────────────────────────────────

test("a backtest result can be opened without a mouse", () => {
  const list = read("app/research/page.tsx");
  // A <tr onClick> has no tab stop and no Enter handler, and this was the only
  // route to a result.
  assert.match(list, /<Link href=\{`\/research\/\$\{r\.id\}`\}/);
  assert.match(list, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
});

test("the not-found page and the chart's product menu offer every destination the nav has", () => {
  // The not-found page renders `allNavLinks()` directly. The chart workspace,
  // which has no header bar at all after FC2-H3 and is also the manifest's
  // start_url, reaches the same set through `productMenuLinks()` plus
  // `SYSTEM_LINKS` — the split exists only so section tabs can be indented
  // under their destination. What may never happen is a destination existing
  // in one list and not the other, so that is asserted as set equality rather
  // than by grepping for a call.
  assert.match(read("app/not-found.tsx"), /allNavLinks\(\)\.map/);
  const menu = read("components/tv/ProductMenu.tsx");
  assert.match(menu, /productMenuLinks\(\)\.map/);
  assert.match(menu, /SYSTEM_LINKS\.map/);
  assert.deepEqual(
    [...productMenuLinks().map((e) => e.link.href), ...SYSTEM_LINKS.map((l) => l.href)].sort(),
    allNavLinks().map((l) => l.href).sort(),
    "the chart's only navigation must offer exactly what the header offers"
  );

  const links = allNavLinks().map((l) => l.href);
  for (const route of ["/chart", "/screener", "/alerts", "/optimizers", "/research",
    "/trading", "/journal", "/operations", "/shariah", "/getting-started"]) {
    assert.ok(links.includes(route), `${route} is no longer reachable from navigation`);
  }
});

test("controls that speak, and failures that are announced", () => {
  assert.match(read("app/shariah/page.tsx"), /aria-label="Load a ChatGPT review results JSON file"/);
  assert.match(read("app/shariah/page.tsx"), /aria-label="Filter the screening universe"/);
  assert.match(read("app/login/page.tsx"), /\{err && <p role="alert"/);
  assert.match(read("app/shariah/page.tsx"), /<div role="alert" className="mb-3 rounded-md border border-down/);
  assert.match(read("app/screener/page.tsx"), /<div role="status" aria-live="polite">/);
});
