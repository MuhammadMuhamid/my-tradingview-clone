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

/** Every `.tsx` under a directory, relative to the frontend root. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(rel, out);
    else if (entry.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

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
  /*
   * IO-A1 folded the maximised case into the same keyed render path as the
   * grid, so there is ONE cell wrapper now rather than two near-identical ones
   * — which is the repair, not a regression: two wrappers is precisely what
   * made React unmount the pane the user had just maximised.
   */
  assert.equal((host.match(/className="flex min-h-0 min-w-0"/g) ?? []).length, 1,
    "the one cell wrapper must stay a flex container");
});

test("the toolbar's primary row can give width back", () => {
  const bar = read("components/tv/ChartToolbar.tsx");
  const strip = /ctl\("timeframe"\)[\s\S]{0,400}?className="([^"]*)"/.exec(bar);
  assert.ok(strip, "the timeframe strip could not be located");

  /*
   * TVP8 (owner veto R1-03): the timeframe strip is no longer the row's
   * absorber. The toolbar is the workstation's first full-width row, so
   * nothing narrows it at desktop widths, and the favourites strip — the
   * thing a trader aims at — must never clip (`1h 4 ⌄` at 1440 was the
   * defect). The wrapper is `shrink-0`; the SYMBOL pill truncates below `sm`,
   * and the saved-layout name below.
   */
  assert.match(strip[1]!, /\bshrink-0\b/, "the timeframe strip must not be squeezable");
  assert.doesNotMatch(strip[1]!, /\bmin-w-0\b|\bsm:flex-initial\b|\bflex-1\b/,
    "a shrinkable wrapper lets the favourites clip mid-glyph");

  // The strip alone was 6px short at 1024 with the ticket open. The saved-layout
  // name is the row's second absorber and must be able to truncate.
  const saved = /ctl\("savedLayouts"\)[\s\S]{0,120}?className=\{`([^`]*)`/.exec(bar);
  assert.ok(saved, "the saved-layout identity could not be located");
  assert.doesNotMatch(saved[1]!, /\bshrink-0\b/);
  assert.match(saved[1]!, /\bmin-w-0\b/);
  // TVP8 R1-07: the name is now on the bar at every width from `sm` up, so it
  // absorbs more of the row and is allowed a little more of it (130 -> 160).
  assert.match(read("components/tv/LayoutMenu.tsx"), /min-w-0 max-w-\[160px\] truncate/);
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
  // A failure says unknown; only an unanswered request says loading. The shape
  // changed when the provenance claim was made conditional (below), so this
  // asserts the two branches rather than one literal ternary.
  assert.match(scanner, /error \? "market identity unknown"/);
  assert.match(scanner, /!snapshot \? "market identity loading"/);
  assert.match(scanner, /error \? "No snapshot loaded" : "Loading cached snapshot…"/);

  /*
   * And the provenance claim itself.
   *
   * `snapshot.market.spot` is hard-returned true by the scanner service, so it
   * describes the REQUEST rather than the answer — "API provenance verified"
   * printed unchanged on this install while every one of 36 rows had failed to
   * resolve. A provenance claim that survives total failure is not one.
   */
  assert.match(scanner, /resolvedAny/,
    "the provenance line must consult whether anything actually resolved");
  assert.match(scanner, /no instrument resolved against the exchange/);

  const optimizers = read("app/optimizers/page.tsx");
  assert.match(optimizers, /treesError \? "Optimizer trees unavailable" : "Loading trees…"/);
  assert.doesNotMatch(optimizers, /\(data\?\.totalBacktests \?\? 0\)\.toLocaleString\(\)/,
    "a failed read is not a total of zero");
});

test("EVERY PAGE ROOT IS THE SHELL, AND THE SHELL IS BOUNDED", () => {
  /*
   * The optimizer page sits inside a flex `main` and will shrink-wrap to its
   * content without an explicit width — which is what this test has always
   * been about. TVP8: it asserted the literal
   *
   *   className="ts-app mx-auto w-full max-w-[1400px] space-y-4 px-3 py-4 sm:px-4"
   *
   * twice, which was the right constraint written against a COPY of it. Six
   * pages had that string letter for letter while five used `PageShell`, so
   * the product had one page shell with two implementations and the component
   * had a single caller's worth of authority over a measurement eleven pages
   * depend on.
   *
   * The width is now asserted where it lives, and every root is asserted to be
   * the component — which is strictly stronger, because a page that copies the
   * string again fails rather than passes.
   */
  const ui = read("components/ui.tsx");
  assert.match(ui, /width === "narrow" \? "max-w-\[1100px\]" : "max-w-\[1400px\]"/,
    "the shell's own width, which is what the constraint actually is");
  assert.match(ui, /ts-app mx-auto w-full \$\{max\} space-y-4 px-3 py-4 sm:px-4/);

  const optimizers = read("app/optimizers/page.tsx");
  assert.equal((optimizers.match(/<PageShell/g) ?? []).length, 2,
    "both the empty and populated optimizer roots need an explicit width inside the flex main");

  // And nothing anywhere re-implements it.
  const copies = sourceFiles("app")
    .filter((f) => /className="ts-app mx-auto w-full max-w-\[/.test(read(f)));
  assert.deepEqual(copies, [],
    `these hand-roll PageShell instead of rendering it: ${copies.join(", ")}`);
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
  /*
   * The intent here is "a failure is ANNOUNCED", not "a failure has these
   * Tailwind classes". It used to pin the exact class string, which made it a
   * CSS snapshot: the moment the page adopted the shared `Notice` primitive —
   * same role, same tone, same words — it failed for a reason that had nothing
   * to do with whether the failure is announced.
   *
   * These three assertions are the contract instead, and they are stricter
   * than the string was: announced, toned as an error, and — the part no class
   * string could check — not printing the provider's raw cause as the page's
   * headline. The Shariah page did exactly that, so on the QA fixture its most
   * prominent line read "fixture server has no route for GET
   * /api/shariah/universe".
   */
  const shariah = read("app/shariah/page.tsx");
  assert.match(shariah, /<Notice tone="error" role="alert">/);
  assert.match(shariah, /shortReason\(error\)/,
    "the headline must be a sentence a reader can act on");
  assert.match(shariah, /<span title=\{error\}>/,
    "the provider's own words belong in the tooltip, not the headline");
  assert.doesNotMatch(shariah, /role="alert"[^>]*>\{error\}</,
    "a raw backend error must never be the page's own copy");
  assert.match(read("app/screener/page.tsx"), /<div role="status" aria-live="polite">/);
});

test("EVERY PAGE NAMES ITSELF THROUGH THE SHARED HEADER", () => {
  /*
   * ── TVP8 round two ─────────────────────────────────────────────────────
   *
   * `PageHeader` had ONE caller. Six pages hand-rolled it, and not
   * consistently: Journal, Alerts, Trading and Shariah wrote
   *
   *   <h1 class="text-lg font-semibold text-ink">…</h1>
   *   <p class="mt-0.5 max-w-3xl text-sm text-ink-muted">…</p>
   *
   * which is the component's markup letter for letter, while Operations and
   * Optimizers wrote the same heading over `text-xs text-ink-faint` — a
   * description two sizes smaller and a shade fainter — and the manual wrote a
   * third variant at `leading-6`. The same sentence in the same slot on six
   * pages, at three type treatments, because there was no one place to change
   * it.
   *
   * Three headings are deliberately NOT this: `error`, `not-found` and `login`
   * are centred cards rather than page shells, and the Screener's is a
   * toolbar-level heading that sits inline with a badge and a market picker.
   * They are named here rather than pattern-matched, because an exemption
   * nobody wrote down is just a gap.
   */
  const CENTRED_CARDS = ["app/error.tsx", "app/not-found.tsx", "app/login/page.tsx"];
  const TOOLBAR_HEADING = ["app/screener/page.tsx"];
  const exempt = new Set([...CENTRED_CARDS, ...TOOLBAR_HEADING, "app/global-error.tsx"]);

  const offenders: string[] = [];
  for (const file of sourceFiles("app")) {
    if (exempt.has(file)) continue;
    const src = read(file);
    for (const m of src.matchAll(/<h1[^>]*>/g)) {
      // A screen-reader-only h1 is a landmark, not a page title.
      if (/sr-only/.test(m[0])) continue;
      offenders.push(`${file}: ${m[0].slice(0, 70)}`);
    }
  }
  assert.deepEqual(offenders, [],
    "these draw their own page title instead of rendering PageHeader:\n  "
    + offenders.join("\n  "));

  // The tripwire: PageHeader must actually be in use, or the rule above is
  // satisfied by a product with no page titles at all.
  const callers = sourceFiles("app").filter((f) => /<PageHeader[\s/>]/.test(read(f)));
  assert.ok(callers.length >= 6,
    `only ${callers.length} pages render PageHeader — it had one caller before this rule`);
});

test("A PAGE'S ERROR BOXES ARE THE SHARED NOTICE", () => {
  /*
   * ── TVP8 round two ─────────────────────────────────────────────────────
   *
   * `Notice` had one caller. Its own docstring says it exists because there
   * were "nine distinct error treatments and four more for warnings and
   * successes — differing in radius, padding, type size, and in one case using
   * `text-ink` body copy on a red box, which is the hardest of the nine to
   * scan."
   *
   * That last one was still there, twice, on the Operations page — with a
   * hand-rolled underlined "Dismiss" link beside it where the primitive has a
   * dismiss button. Four more page-level boxes carried three different
   * paddings, two border alphas and three type sizes between them.
   *
   * ── Why this is `app/` and not the workstation ─────────────────────────
   *
   * The chart's panels are a DIFFERENT DENSITY by contract — 11px and 12px
   * notices inside an order ticket and a study browser, where `Notice`'s
   * `text-sm px-3 py-2` would be a banner. Converting them would be adopting
   * a primitive by making the product worse, which is the opposite of the
   * point. They are out of scope here, deliberately and in writing, rather
   * than quietly left out.
   *
   * Inline FIELD errors are not notices either — a `<p class="text-xs
   * text-down">` under an input is not a box and must not become one — so the
   * rule looks for the box: a bordered, tinted, padded block.
   */
  const BOX = /role="alert"[^>]*className="[^"]*\bborder-(?:down|warn)\/\d+[^"]*\bbg-(?:down|warn)\/\d+/;
  const offenders: string[] = [];
  for (const file of sourceFiles("app")) {
    const src = read(file);
    for (const m of src.matchAll(/<(?:div|p)[^>]*role="alert"[^>]*>/g)) {
      if (BOX.test(m[0])) offenders.push(`${file}: ${m[0].replace(/\s+/g, " ").slice(0, 96)}`);
    }
  }
  assert.deepEqual(offenders, [],
    "these paint their own error box instead of rendering Notice:\n  " + offenders.join("\n  "));

  /*
   * And nothing writes body-colour copy on an ERROR ground, which is the
   * specific treatment the primitive's docstring names as the hardest of the
   * nine to scan: red says urgent and grey copy undercuts it, so the box
   * carries two messages.
   *
   * `warn` is deliberately NOT included. An amber box with an amber `<strong>`
   * lead and body-colour explanation beneath it — which is what the Operations
   * risk notes and the Optimizer methodology caveats are — is a paragraph the
   * reader is meant to READ, and colouring three lines of it amber would be
   * shouting. The first version of this rule caught all eight of those and it
   * was the rule that was wrong, not the product.
   */
  const inkOnRed = sourceFiles("app").filter((f) =>
    /bg-down\/\d+[^"]*\btext-ink\b/.test(read(f)));
  assert.deepEqual(inkOnRed, [],
    `body copy on a tinted error ground is the hardest treatment to read: ${inkOnRed.join(", ")}`);

  const callers = [...sourceFiles("app"), ...sourceFiles("components")]
    .filter((f) => /<Notice[\s/>]/.test(read(f)));
  assert.ok(callers.length >= 4,
    `only ${callers.length} files render Notice — it had one caller before this rule`);
});
