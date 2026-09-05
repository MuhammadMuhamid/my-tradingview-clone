/**
 * The in-product Getting Started page.
 *
 * Two kinds of assertion, and they are worth separating.
 *
 * The first kind pins the SAFETY STATEMENTS. A manual that quietly loses the
 * sentence "Paper is not Live", or stops saying that a missing screen update is
 * not evidence an order failed, is worse than no manual: it reads as complete
 * while the one thing a new operator most needs is gone. These are the claims
 * this phase exists to make, so they are asserted literally.
 *
 * The second kind pins the page against DRIFT in the product it describes. The
 * page quotes real control names, and the whole value of quoting them is that
 * they are the ones on screen. Where the product owns a vocabulary in a module
 * — chart types, sync switches, alert frequencies, the Bot-floor states — the
 * test reads that module and requires the page to still agree with it, so
 * renaming a control fails here instead of silently making the manual wrong.
 *
 * There is deliberately no assertion on prose length, section count or wording
 * style. That is editing, not correctness, and pinning it would only make the
 * page harder to improve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeStreamState, MARKET_STREAM_ORIGINS, type StreamState } from "../lib/marketStream";
import { allNavLinks } from "../lib/navigation";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const PAGE = "app/getting-started/page.tsx";
const page = read(PAGE);

/**
 * The page with every run of whitespace collapsed to one space.
 *
 * JSX wraps prose across lines wherever the formatter put the break, so a
 * sentence this file asserts on is not a substring of the source. Matching the
 * flattened text asserts the sentence rather than the line wrapping, which is
 * the difference between a test that guards meaning and one that fails the
 * next time somebody reflows a paragraph.
 */
const prose = page.replace(/\s+/g, " ");

// ── The page exists, and is what it claims to be ────────────────────────────

test("the route exists, has an h1, and is a static server component", () => {
  assert.match(page, /<h1[^>]*>\s*Getting started\s*<\/h1>/,
    "every route in this product has an h1; this one is the page title");

  // A manual that fetches, polls or holds state can fail, and then the one page
  // a confused operator opens is itself broken. It must be plain HTML.
  assert.doesNotMatch(page, /"use client"/, "this page must not become a client component");
  for (const forbidden of ["useState", "useEffect", "fetch(", "api."]) {
    assert.ok(!page.includes(forbidden), `${PAGE} must not ${forbidden} — it is static content`);
  }
});

test("it is reachable from permanent navigation, and forces itself on nobody", () => {
  const href = '"/getting-started"';

  // The global header, on every page that shows it.
  assert.ok(read("components/Nav.tsx").includes(href),
    "the header must offer Getting started");
  // The chart's phone drawer, which is the site nav on a phone because the
  // global bar is hidden there, renders every navigation link — including it.
  assert.match(read("components/tv/ChartSidePanel.tsx"), /allNavLinks\(\)\.map/,
    "the chart's mobile menu must render the shared navigation list");
  assert.ok(allNavLinks().some((l) => l.href === "/getting-started"),
    "the chart's mobile menu must offer Getting started");
  // A stale or mistyped URL should be able to reach it too: the not-found
  // page renders the same shared list.
  assert.match(read("app/not-found.tsx"), /allNavLinks\(\)\.map/,
    "the not-found page must offer Getting started");

  // Nothing may send a user here who did not ask. The brief is explicit that
  // this is not a first-launch flow.
  const redirects = ["app/page.tsx", "components/Nav.tsx", "app/layout.tsx", "app/login/page.tsx"];
  for (const file of redirects) {
    const source = read(file);
    assert.ok(
      !/(redirect|router\.(push|replace)|location\.href\s*=)[^\n]*getting-started/.test(source),
      `${file} redirects to Getting started — it must be opened deliberately, never forced`
    );
  }
});

// ── The safety statements ───────────────────────────────────────────────────

test("SPOT ONLY IS STATED, AND NOTHING IS OFFERED THAT DOES NOT EXIST", () => {
  assert.match(prose, /Spot/);
  assert.match(
    prose,
    /no futures, leverage, margin or short selling/i,
    "the page must say in one place that none of these exist in this product"
  );
});

test("PAPER IS NOT LIVE", () => {
  assert.match(prose, /Paper is not Live/,
    "the strongest single statement on the page; it names the callout");
  assert.match(prose, /simulates the fill instead of sending it/);
  // The precise reason it proves nothing about execution.
  assert.match(prose, /no slippage and no partial fill/);
});

test("HEIKIN ASHI AND RENKO ARE DECLARED DISPLAY-ONLY", () => {
  assert.match(prose, /never traded/,
    "a transform draws prices that never traded, and the page must say so");
  assert.match(
    prose,
    /never execution authority|not execution authority/,
    "the page must state that a synthetic bar cannot be an execution price"
  );
});

test("SELL IS NEVER GATED BY SHARIAH MODE", () => {
  assert.match(prose, /SELL \/ exit — never gated/);
  assert.match(prose, /must always remain exitable/);
  // And the other half of the same fact: enforcement does not liquidate.
  assert.match(prose, /does not sell what you already hold/);
});

test("A MISSING UI UPDATE IS NOT EVIDENCE THAT AN ORDER FAILED", () => {
  assert.match(prose, /not proof that an order failed/);
  assert.match(prose, /Never resubmit/,
    "the actionable half of the statement, not just the warning");
});

test("the page says which component holds credentials and places orders", () => {
  assert.match(prose, /Only the Bot holds exchange credentials/);
  assert.match(prose, /cannot flatten a position/i,
    "an operator must not expect this application to close anything");
});

test("it disclaims being advice, and does not instruct a strategy", () => {
  assert.match(prose, /not financial advice/i);
  // Two independent statements: the lede and the footer. Losing either is fine
  // individually; losing the idea is not.
  assert.ok(
    (prose.match(/no trading advice|not financial advice|recommends no instrument/gi) ?? []).length >= 2
  );
});

// ── Drift: the page quotes controls that still exist ────────────────────────

test("EVERY NAV DESTINATION THE PRODUCT HAS IS DESCRIBED", () => {
  const missing: string[] = [];
  for (const { href, label } of allNavLinks()) {
    if (href === "/getting-started") continue; // this page
    // Either the route is linked, or the label is named. A page the manual does
    // not mention at all is the gap this catches.
    if (!page.includes(`"${href}"`) && !prose.includes(label)) missing.push(`${label} (${href})`);
  }
  assert.deepEqual(missing, [], "nav destinations the Getting Started page never mentions");
});

test("the chart types it names are the chart types that exist", () => {
  const chartType = read("lib/chartType.ts");
  for (const label of ["Candles", "Bars", "Line", "Area", "Heikin Ashi"]) {
    assert.ok(chartType.includes(`label: "${label}"`), `lib/chartType no longer has ${label}`);
    assert.ok(prose.includes(label), `the page stopped naming the ${label} chart type`);
  }

  // Renko's label carries its fixed period, and the page prints that number.
  const period = read("lib/chartTransforms.ts").match(/DEFAULT_RENKO_ATR_PERIOD = (\d+)/)?.[1];
  assert.ok(period, "the Renko ATR period is no longer a named constant");
  assert.ok(
    prose.includes(`Renko · ATR(${period})`),
    `the page must print Renko · ATR(${period}), matching the menu`
  );

  // Types that do not exist must not be advertised as if they did.
  for (const absent of ["Kagi", "Point & Figure", "Line Break"]) {
    assert.ok(!chartType.includes(`label: "${absent}"`), `${absent} now exists — describe it`);
  }
});

test("the sync switches it names are the sync switches that exist", () => {
  const labels = [...read("lib/paneSync.ts").matchAll(/label: "([^"]+)", help:/g)].map((m) => m[1]!);
  assert.ok(labels.length > 0, "SYNC_LABELS could not be read");
  for (const label of labels) {
    assert.ok(prose.includes(label), `the Sync menu offers "${label}" and the page never says so`);
  }
});

test("the alert frequencies it names are the frequencies that exist", () => {
  const alerts = read("lib/alerts.ts");
  // Scope to FREQUENCY_LABELS: FREQUENCY_HELP is keyed the same way and its
  // values are sentences, not labels.
  const block = alerts.match(/FREQUENCY_LABELS[\s\S]*?\n\};/)?.[0] ?? "";
  const labels = [...block.matchAll(/^\s+once_[a-z_]+: "([^"]+)",$/gm)].map((m) => m[1]!);
  assert.ok(labels.length === 4, `expected four frequency labels, read ${labels.length}`);
  for (const label of labels) {
    assert.ok(prose.includes(label), `frequency "${label}" is offered and the page never says so`);
  }
});

test("the manual ticket's order types are the ones the page lists", () => {
  const panel = read("components/tv/ManualTradingPanel.tsx");
  const types = [...panel.matchAll(/\{ id: "(?:MARKET|LIMIT)", label: "([^"]+)" \}/g)].map((m) => m[1]!);
  assert.deepEqual(types, ["Market", "Limit"],
    "the supported order types changed; the page says there are exactly two");
  assert.match(prose, /Two, and nothing else is offered/);
});

test("the Bot-floor states it explains are the states the console can show", () => {
  const labels = [...read("lib/shariah.ts").matchAll(/label: "(Bot floor: [^"]+)"/g)].map((m) => m[1]!);
  assert.ok(labels.length >= 6, `expected the full set of sync states, read ${labels.length}`);
  for (const label of labels) {
    assert.ok(prose.includes(label), `the console can show "${label}" and the page never explains it`);
  }
  // The seventh case lives on the console itself: the mode read that returned
  // nothing at all. It is the one an operator is most likely to misread as "off".
  const console_ = read("app/shariah/page.tsx");
  assert.ok(console_.includes("Bot floor: could not be read"));
  assert.ok(prose.includes("Bot floor: could not be read"));
});

test("the feed badge states it explains are the states a pane can show", () => {
  // The words come from one function; every state it can produce, including
  // the refused-host causes, must be explained on this page.
  const origins = [...MARKET_STREAM_ORIGINS];
  const states: StreamState[] = [
    { status: "idle", origin: null, attempt: 0, everLive: false, refused: [] },
    { status: "connecting", origin: origins[0]!, attempt: 0, everLive: false, refused: [] },
    { status: "open", origin: origins[0]!, attempt: 0, everLive: false, refused: [] },
    { status: "live", origin: origins[0]!, attempt: 0, everLive: true, refused: [] },
    { status: "reconnecting", origin: origins[0]!, attempt: 1, everLive: true, refused: [] },
    { status: "reconnecting", origin: origins[1]!, attempt: 1, everLive: false, refused: [origins[0]!] },
    { status: "reconnecting", origin: origins[0]!, attempt: 2, everLive: false, refused: origins },
    { status: "stale", origin: origins[0]!, attempt: 0, everLive: true, refused: [] },
  ];
  const badges = [...new Set(states.map((s) => describeStreamState(s).label))];
  assert.equal(badges.length, 8, `expected eight distinct feed badge labels, read ${badges.length}`);
  for (const badge of badges) {
    assert.ok(prose.includes(badge), `a pane can read "${badge}" and the page never explains it`);
  }
  // And the cause the owner's network produces is named with both hosts.
  for (const origin of origins) {
    assert.ok(prose.includes(origin.replace(/^wss:\/\//, "").replace(/:9443$/, "")),
      `the troubleshooting entry must name ${origin}`);
  }
});

test("the trading modes it explains are the modes Operations can report", () => {
  const ops = read("app/operations/page.tsx");
  for (const mode of ["LIVE", "STANDBY", "HALTED", "DISABLED"]) {
    assert.ok(ops.includes(`${mode}:`), `Operations no longer reports ${mode}`);
    assert.ok(prose.includes(mode), `the page stopped explaining the ${mode} trading mode`);
  }
});

test("the pane ceiling it quotes is the real one", () => {
  const max = read("lib/layoutPresets.ts").match(/MAX_PANES = (\d+)/)?.[1];
  assert.equal(max, "16", "MAX_PANES changed — the page says one to sixteen panes");
  assert.match(prose, /one to sixteen independent panes/);

  const presets = (read("lib/layoutPresets.ts").match(/^\s+(?:packed|explicit)\(/gm) ?? []).length;
  assert.ok(
    prose.includes(`${presets} arrangements`),
    `there are ${presets} layout presets and the page quotes a different number`
  );
});
