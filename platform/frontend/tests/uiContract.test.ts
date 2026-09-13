/**
 * The UI/UX decisions that a later agent is most likely to walk backwards.
 *
 * `docs/TRADING_SCENE_UI_UX_CONTRACT.md` is the prose; this file is the part a
 * CI run can refuse. Every rule here has actually regressed on this project at
 * least once, which is the bar for being in this file — it is not a style
 * guide, it is a list of scars.
 *
 * These assert SEMANTICS, not pixels. A Tailwind class string pinned as a
 * proxy for a behaviour is a CSS snapshot wearing a behaviour's name: it fails
 * when the styling is refactored and passes when the behaviour breaks. Where a
 * literal is unavoidable (a measured token value) it is the value the contract
 * documents, and the contract says where it came from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mixToward } from "../lib/chartTheme";

const ROOT = path.join(__dirname, "..");
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), "utf8");
const css = read("app/globals.css");
/**
 * Prose about a class is not a use of it.
 *
 * A comment that names the class it REMOVED is the most useful kind of
 * comment and the easiest thing for a source scanner to mistake for the
 * defect — the rule below about `flex-wrap` failed on the sentence
 * explaining why `flex-wrap` was taken out. Scan the code.
 */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const WORKSTATION = [
  ...sourceFiles("components/tv"),
  "components/CandleChart.tsx",
  "app/chart/page.tsx",
];

test("CONTRACT — the measured density numbers are the ones in the tokens", () => {
  /*
   * Each of these was wrong once, and each error was systemic rather than
   * cosmetic. 42px cost four pixels of chart on every pane; a 3px radius made
   * every state chip a different shape from the reference's; 36px menu rows
   * made every dropdown shorter than the thing it was copying.
   */
  for (const [token, value] of [
    ["--ts-workstation-font-size", "14px"],
    ["--ts-workstation-toolbar-height", "38px"],
    ["--ts-workstation-rail-width", "52px"],
    ["--ts-workstation-menu-row-height", "40px"],
    ["--ts-workstation-radius", "6px"],
  ] as const) {
    assert.match(css, new RegExp(`${token}:\\s*${value.replace(".", "\\.")}\\s*;`),
      `${token} must be ${value} — see docs/TRADING_SCENE_UI_UX_CONTRACT.md §3`);
  }
});

test("CONTRACT — hover and selected are two DIFFERENT neutrals, in both themes", () => {
  /*
   * The failure this catches is not "a wrong colour". It is the two being the
   * SAME colour, which made hovering an unselected row render identically to
   * the selected one — shipped on the Shariah asset list, and invisible to any
   * test that only checked that a hover existed.
   */
  const blocks = css.split(/:root\s*(?:\[data-theme="light"\])?\s*\{/);
  assert.ok(blocks.length >= 3, "expected a dark :root block and a light one");
  for (const [name, block] of [["dark", blocks[1]!], ["light", blocks[2]!]] as const) {
    const hover = /--ts-state-hover:\s*(#[0-9a-f]{6})/i.exec(block)?.[1];
    const active = /--ts-state-active:\s*(#[0-9a-f]{6})/i.exec(block)?.[1];
    assert.ok(hover && active, `${name}: both state tokens must be declared`);
    assert.notEqual(hover!.toLowerCase(), active!.toLowerCase(),
      `${name}: hover and selected must differ, or selection is invisible under the pointer`);
  }
});

test("CONTRACT — the state chip is driven by the ANNOUNCED state", () => {
  // A control cannot look active while reporting that it is not, and no
  // component has to remember which utility class meant "on".
  for (const attr of ["aria-pressed", "aria-checked", "aria-selected", "aria-expanded", "data-active"]) {
    assert.match(css, new RegExp(`\\.tvc-control\\[${attr}="true"\\]::before`),
      `.tvc-control must read ${attr}`);
  }
  assert.match(css, /\.tvc-control::before[\s\S]{0,200}inset:\s*2px/,
    "the chip is inset, so adjacent lit controls keep a hairline between them");
});

test("CONTRACT — the shared grammar reaches the whole product, not only the chart", () => {
  /*
   * These rules were scoped to `.tv-workstation`, so a button on Research
   * could not hover the way the same button hovers on the chart even if it
   * asked to — and every dialog, which portals outside the chart, silently
   * lost the grammar entirely.
   */
  for (const rule of ["\\.tvc-control", "\\.tvc-menu"]) {
    assert.match(css, new RegExp(`:is\\(\\.tv-workstation, \\.ts-app\\) ${rule}`),
      `${rule} must be available to both roots`);
  }
  assert.match(read("components/Modal.tsx"), /createPortal\([\s\S]{0,400}tv-workstation/,
    "a dialog portals out of the workstation and must carry the grammar with it");
});

test("CONTRACT — the focus ring never rewrites an element's own radius", () => {
  // `border-radius` in a :focus-visible rule is not a property of the ring: it
  // reshapes the element for as long as it has focus. The symbol pill squared
  // itself off when tabbed to.
  const focus = /:focus-visible\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.ok(focus.length > 0, "the product must declare a visible focus style");
  assert.doesNotMatch(focus, /border-radius/,
    "see docs/TRADING_SCENE_UI_UX_CONTRACT.md §4");
});

test("CONTRACT — primary chrome shows a ticker, never a canonical identity", () => {
  /*
   * `displaySymbol` renders `OANDA:EUR/USD · FX` for a canonical id. It is the
   * right answer for a tooltip, a dialog row or an export, and the wrong one
   * for the control a user aims at first.
   */
  const toolbar = read("components/tv/ChartToolbar.tsx");
  assert.match(toolbar, /displayTicker\(symbol\)/);
  assert.match(toolbar, /\{tickerLabel\}/, "the pill renders the ticker");
  assert.doesNotMatch(toolbar, />\{symbolLabel\}</,
    "the qualified identity belongs in the tooltip and the accessible name");

  const legend = read("components/tv/PaneLegend.tsx");
  assert.match(legend, /\{tickerLabel\}/);
  assert.match(legend, /displayVenue\(symbol\)/, "the venue trails the interval, muted");

  // And the settings dialog, which printed the raw `instrument:v1:…` URN.
  assert.doesNotMatch(read("components/tv/ChartSettingsModal.tsx"), /<dd[^>]*>\{symbol\}</,
    "the Instrument block shows the ticker, with the URN in the title");
});

test("CONTRACT — accent never means 'this one is selected' in the workstation", () => {
  /*
   * Accent is a primary action, a link, a focus ring, or data that is
   * categorically ours. Selection is a neutral chip. A toolbar with two
   * toggles on used to read as a row of blue lights.
   */
  /*
   * Matched by SHAPE, not by the name of the condition.
   *
   * The first version of this rule required a predicate from a fixed word
   * list — selected|isActive|active|open|checked|current — to appear on the
   * SAME LINE as the accent class. Three menus slipped past it and stayed
   * blue for a whole campaign: `isBrowsing` had its ternary wrapped onto the
   * previous line, and `isCurrent` did not match `\bcurrent\b` at all. A rule
   * that only catches the formatting it was written against is not a rule.
   *
   * So: an accent class sitting in a branch of a conditional is the defect,
   * whatever the condition is called and however the line is wrapped.
   */
  /*
   * Exemption is a MARKER AT THE SITE, not a pattern in this file.
   *
   * The exemptions used to be a regex over the surrounding lines — "focused
   * pane", "favourite". Widening the rule surfaced a dozen more legitimate
   * uses (a script-kind badge, a paper-trading badge, a switch track, a
   * notification dot), and growing that regex to cover them would have made
   * the rule guess at intent from nearby words, exempting real defects that
   * happened to sit near an innocent one.
   *
   * So a legitimate accent says so, in a comment within three lines above it:
   *
   *     a JSX comment reading `accent-is-meaning: <why>`
   *
   * That costs one line at the site and buys two things — the reason is
   * written where the next person reads it, and every accent that is NOT
   * marked is a defect, with no judgement left in this test.
   */
  const EXEMPT = /accent-is-meaning/;
  const ACCENT = String.raw`(?:bg-accent(?:\/\d+)?|text-accent|border-accent(?:\/\d+)?)`;
  const CONDITIONAL = new RegExp(String.raw`(?:\?|&&)\s*"[^"]*\b${ACCENT}\b`);
  const offenders: string[] = [];
  for (const file of WORKSTATION) {
    const lines = read(file).split("\n");
    for (const [i, line] of lines.entries()) {
      if (!new RegExp(String.raw`\b${ACCENT}\b`).test(line)) continue;
      // The conditional may open on an earlier line than the class it chooses.
      const window = lines.slice(Math.max(0, i - 2), i + 1).join(" ");
      if (!CONDITIONAL.test(window)) continue;
      // Five lines, because a marker that explains itself properly runs to
      // three and must still clear the class it excuses. It has to sit
      // immediately above — this is not a licence to excuse the whole block.
      const context = lines.slice(Math.max(0, i - 5), i + 1).join(" ");
      if (EXEMPT.test(context)) continue;
      offenders.push(`${file}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [],
    `accent used as a selection state — use .tvc-control: ${offenders.join(", ")}`);
});

test("CONTRACT — no workstation surface reverts to the pre-TVP7 hover", () => {
  // `surface-2` is #1f1f1f: a correct panel, and one step too dark for a hover
  // on every surface that used it.
  const offenders = WORKSTATION.filter((f) => /hover:bg-surface-2\b/.test(read(f)));
  assert.deepEqual(offenders, [],
    `hover must be the state token, not a panel colour: ${offenders.join(", ")}`);
});

test("CONTRACT — a provider's raw words are never a headline", () => {
  /*
   * `useCandleHistory` used to concatenate the provider's exception into the
   * sentence it rendered across the top of the chart, so a working chart could
   * be captioned with a URL-encoded route path.
   */
  const hook = read("lib/useCandleHistory.ts");
  assert.match(hook, /errorDetail/, "the technical cause has its own channel");
  assert.match(hook, /errorLevel/, "degraded and broken are different events");
  assert.doesNotMatch(hook, /setStreamWarning\(`[^`]*\$\{\(cause as Error\)\.message\}/,
    "a cause may be carried, never interpolated into the user's sentence");
  assert.match(read("components/tv/ChartPane.tsx"), /title=\{history\.errorDetail/,
    "the cause belongs in the tooltip");
});

test("CONTRACT — every settings control reaches something", () => {
  /*
   * The rule the settings model states about itself. Two specific failures it
   * has had: candle Body/Borders/Wick rendered for chart types whose applying
   * effect returns early, and a study pane's eye and trash resolved to the
   * wrong API for all thirty-five built-ins.
   */
  const modal = read("components/tv/ChartSettingsModal.tsx");
  assert.match(modal, /seriesColoursApply/,
    "series appearance appears only for presentations that have it");

  const pane = read("components/tv/ChartPane.tsx");
  assert.match(pane, /nativeRef\.current\.list\.some\(\(study\) => study\.key === key\)/,
    "a pane action must resolve to the API that owns the study");
});

test("CONTRACT — the shared page primitives exist and the unique pages use them", () => {
  const ui = read("components/ui.tsx");
  for (const primitive of ["PageShell", "PageHeader", "Notice", "Loading", "Textarea"]) {
    assert.match(ui, new RegExp(`export function ${primitive}\\b`),
      `${primitive} is part of the shared system`);
  }
  // The field primitive is an outline on a transparent ground, like the
  // workstation's — it used to be an invisible border over a lighter fill.
  assert.match(ui, /const FIELD = [^;]*border-control-border/);
  assert.match(ui, /const FIELD = [^;]*bg-transparent/);

  for (const page of ["app/research/page.tsx", "app/shariah/page.tsx",
    "app/trading/page.tsx", "app/alerts/page.tsx", "app/journal/page.tsx"]) {
    assert.match(read(page), /<PageShell/,
      `${page} must use the shared shell — see the contract §7`);
  }
});

test("CONTRACT — the canvas is themed too, not just the DOM", () => {
  /*
   * A real light-theme defect, found by USING the product in light mode rather
   * than by inverting tokens on paper: the volume histogram painted very dark
   * bars across a white chart. Its two colours were the literals `#1c3a30` and
   * `#3a1c24`, and a canvas cannot read a custom property, so nothing about
   * switching the theme could ever have reached them.
   *
   * The rule that replaced them: a canvas colour that should change with the
   * theme is MIXED at render time between a value the user chose and a token
   * read off the document. This test guards the two halves of that — that the
   * literals are gone, and that both themes actually define the weight.
   */
  const theme = read("lib/chartTheme.ts");
  assert.doesNotMatch(theme, /CHART_VOLUME_(UP|DOWN)\s*=/,
    "volume must be derived from the series colour, not a second fixed palette");
  assert.match(theme, /cssToken\("--ts-surface"/,
    "the mix target is the surface the bars are drawn on");

  // Both themes define the weight; a token defined only in dark is how the
  // original defect would come back.
  const alpha = [...css.matchAll(/--ts-chart-volume-alpha:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  assert.equal(alpha.length, 2, "dark and light each state their own weight");
  assert.ok(alpha.every((a) => a > 0 && a <= 1), alpha.join(", "));
  assert.ok(Math.max(...alpha) > Math.min(...alpha),
    "the same weight in both themes is the bug, not the fix: what recedes on "
    + "black disappears on white");

  // The muted fallback is themed for the same reason.
  assert.equal([...css.matchAll(/--ts-chart-muted:/g)].length, 2);
});

test("CONTRACT — the volume weight is TradingView's own, measured", () => {
  /*
   * Sampling the live TradingView light chart canvas (BINANCE:BTCUSDT,
   * `getImageData` across the volume band) returns rgb(131,204,192) as the
   * dominant bar colour. TradingView's light up colour is `#089981` — which is
   * also this product's measured `--ts-positive` for light — so their bar is
   * that colour at half strength over white, and half strength is what the
   * light token says.
   *
   * Asserted to within one step per channel: their compositor and this mix
   * round a .5 in opposite directions, and that is not a difference anyone can
   * see. Anything larger means the rule drifted.
   */
  const mixed = mixToward("#089981", "#ffffff", 0.5);
  const channels = [1, 3, 5].map((at) => parseInt(mixed.slice(at, at + 2), 16));
  const measured = [131, 204, 192];
  channels.forEach((value, i) => {
    assert.ok(Math.abs(value - measured[i]!) <= 1,
      `channel ${i}: mixed ${value} vs TradingView's measured ${measured[i]} (${mixed})`);
  });

  // The ends of the range mean what they say.
  assert.equal(mixToward("#2ebd85", "#0f0f0f", 1), "#2ebd85");
  assert.equal(mixToward("#2ebd85", "#0f0f0f", 0), "#0f0f0f");
  // A non-hex series colour is returned untouched rather than mangled.
  assert.equal(mixToward("rgba(0,0,0,0)", "#ffffff", 0.5), "rgba(0,0,0,0)");

  /*
   * Shorthand hex, which is not hypothetical.
   *
   * `--ts-surface` is authored `#ffffff`, but the CSS pipeline shortens it and
   * `getComputedStyle` returns `#fff` at runtime. The first version of this
   * mix accepted six digits only, so in the browser it fell through to
   * "return the colour unmixed" — a full-strength volume bar on white, which
   * is the defect wearing a passing unit test. Found by reading the live
   * document, not by reading the stylesheet.
   */
  assert.equal(mixToward("#2ebd85", "#fff", 0.5), mixToward("#2ebd85", "#ffffff", 0.5));
  assert.notEqual(mixToward("#2ebd85", "#fff", 0.5), "#2ebd85");
});

test("CONTRACT — the phone action bar owns the bottom edge, alone", () => {
  /*
   * At 390x844 the floating theme toggle is `position: fixed; bottom: 12px`,
   * and the chart workstation's action bar is fixed to the same edge. The
   * toggle landed on "Automate" — the last tab of the primary navigation was
   * unreachable on a phone, underneath a control for changing the colour
   * scheme.
   *
   * The height is one token with two readers so the clearance cannot drift
   * away from the thing it is clearing.
   */
  assert.match(css, /--ts-phone-nav-height:\s*\d+px/, "the bar's height is a token");
  assert.match(css, /body:has\(nav\[data-phone-nav\]\) \.theme-toggle/,
    "the toggle lifts only where the bar actually exists");
  assert.match(css, /bottom:\s*calc\(var\(--ts-phone-nav-height\)[^)]*\+[^;]*\)/,
    "it lifts BY the bar's own height, not by a number that happens to match");

  const panel = read("components/tv/ChartSidePanel.tsx");
  assert.match(panel, /<nav data-phone-nav/, "the bar announces itself to the rule above");
  assert.match(panel, /min-h-\[var\(--ts-phone-nav-height\)\]/,
    "and sizes itself from the same token");
});

test("CONTRACT — collapsing a legend never makes it taller", () => {
  /*
   * `IndicatorLegend` has two branches, collapsed and expanded. The expanded
   * one was fixed for this once — at 390px a long study name wrapped to three
   * stacked lines down over the candles — and the collapsed one kept
   * `flex-wrap`, so hiding a study's values made its legend TALLER than
   * showing them. A comment guarded the fixed branch and nothing guarded the
   * other, which is exactly how it came back.
   */
  const legend = code(read("components/tv/IndicatorLegend.tsx"));
  assert.doesNotMatch(legend, /flex-wrap/,
    "a legend row clips; it never wraps — see docs/TRADING_SCENE_UI_UX_CONTRACT.md §3");
  /*
   * Every legend row, not a count of them — the first version of this pinned
   * the number 2 and failed the moment a third row was added, which is a test
   * measuring the file rather than the rule.
   */
  const rows = [...legend.matchAll(/className="((?:group\/study )?flex[^"]*items-baseline[^"]*)"/g)]
    .map((match) => match[1]!);
  assert.ok(rows.length >= 3, `expected collapsed, expanded and hidden rows, saw ${rows.length}`);
  for (const row of rows) {
    assert.match(row, /whitespace-nowrap/, `a legend row that can wrap: ${row}`);
  }
  assert.ok((legend.match(/truncate/g) ?? []).length >= 3,
    "and the name that no longer fits is truncated, not dropped");
  // The full text stays reachable rather than being lost to the clip.
  assert.match(legend, /title=\{groups\.map\(\(group\) => group\.title\)\.join/,
    "the collapsed row carries its full contents in a title");
});

test("CONTRACT — a transient notice never covers the permanent legend", () => {
  /*
   * The degraded-feed badge is z-20 and centred; the pane legend is z-3 and
   * left-aligned. On a desktop pane they miss each other, and at 390px the
   * badge sat squarely on the symbol and the last price — a message about the
   * feed hiding the number the user came for.
   */
  const pane = read("components/tv/ChartPane.tsx");
  const notice = /role="status"[\s\S]{0,900}?className="([^"]+)"/.exec(pane)?.[1] ?? "";
  assert.ok(notice.includes("bottom-2"), "on a phone it sits at the foot of the pane");
  assert.ok(notice.includes("sm:top-2") && notice.includes("sm:bottom-auto"),
    "and returns to the top only where there is room for it");
});

test("CONTRACT — monospace is for code and machine identifiers, nothing else", () => {
  /*
   * `lib/chartTheme.ts` states the rule for the canvas: monospace earns its
   * place on code, not on prose, not on a name, and not on a price — a number
   * that needs to line up in a column gets `tabular` on the product's own
   * face instead. The rule is the product's, not the chart's, and the rest of
   * the product had drifted from it:
   *
   *   the Journal set nine figures — realized P&L, fees, wins/losses,
   *   durations — in a typewriter face, so its headline number read as a code
   *   token and the word "Unknown" beside it read as a literal;
   *
   *   the Screener and Research printed service ERROR SENTENCES in it, which
   *   is prose wearing the costume of a stack trace.
   *
   * What legitimately keeps it: the Pine editor and the strategy/Shariah JSON
   * inputs (code), and opaque machine identifiers — a deployment id, a lease
   * holder, a content hash, an exchange order id, an issue code. Those are
   * enumerated here so that adding a new one is a decision rather than a
   * drift.
   */
  const ALLOWED = new Set([
    "components/tv/PineEditor.tsx",           // Pine source
    "components/tv/StrategySettingsModal.tsx", // strategy input JSON
    "app/shariah/page.tsx",                    // review-results JSON + content hash
    "app/operations/page.tsx",                 // process, lease, version, issue codes
    "components/TradeOrderTimeline.tsx",       // exchange order identifiers
    "components/tv/TradingOverlays.tsx",       // exchange order identifiers
    "components/scanner/CalibrationPanel.tsx", // fingerprint
  ]);
  const offenders: string[] = [];
  for (const file of [...sourceFiles("app"), ...sourceFiles("components")]) {
    if (ALLOWED.has(file)) continue;
    if (/font-mono/.test(code(read(file)))) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    "these set something in a code face that is not code — use `tabular` for "
    + "figures and the plain face for prose; see docs/TRADING_SCENE_UI_UX_CONTRACT.md §3");

  // And the Journal specifically uses the alignment primitive it needs.
  assert.match(read("app/journal/page.tsx"), /\btabular\b/,
    "the Journal's figures still line up — on the product's own face");
});

test("CONTRACT — a study can be acted on from the row that names it", () => {
  /*
   * A study in its own pane had hide / settings / remove in the pane header.
   * A study overlaid on the PRICE pane had none of them anywhere on the chart:
   * hiding an EMA meant leaving the chart, finding it in the Studies panel and
   * clicking a gear there. The reference puts the actions on the legend row
   * for both kinds.
   *
   * Two things make this safe rather than decorative, and both are the point:
   */
  const legend = read("components/tv/IndicatorLegend.tsx");

  // 1. Nothing is wired to a line that is not a study. The price legend also
  //    carries the moving-average panel, Anchored VWAPs and volume-profile
  //    drawings; none is in a study list, and a trash can on them would be
  //    three dead controls on the busiest surface in the product.
  assert.match(legend, /canAction\?:\s*\(instanceId: string\) => boolean/);
  assert.match(legend, /onAction && canAction\?\.\(group\.id\)/,
    "the cluster renders only for an instance the owner confirms it can move");
  const pane = read("components/tv/ChartPane.tsx");
  assert.match(pane, /nativeRef\.current\.list\.some[\s\S]{0,120}indicatorsRef\.current\.list\.some/,
    "and the owner answers from the same two lists paneAction resolves against");

  // 2. The eye is not a one-way door. A hidden instance emits no overlays, so
  //    hiding one used to delete its own row; the study stays listed, dimmed.
  assert.match(legend, /hidden\?:\s*\{ id: string; title: string \}\[\]/);
  assert.match(legend, /Show \$\{study\.title\}/, "the dimmed row turns it back on");
  assert.match(pane, /rows\.filter\(\(row\) => !row\.study\.visible\)/);
  assert.match(pane, /list\.filter\(\(instance\) => !instance\.visible\)/,
    "both study kinds are listed, not just the built-ins");

  // The key handed back is the instance key the existing resolver expects.
  assert.match(read("components/CandleChart.tsx"), /onIndicatorPaneAction\(`indicator:\$\{key\}`, action\)/);
});

test("CONTRACT — no workstation surface renders a raw symbol variable", () => {
  /*
   * The symbol-display rule, enforced by SHAPE rather than by naming the
   * surfaces that had broken it.
   *
   * The earlier rule named four files — the toolbar, the pane legend, the
   * settings dialog, the indicator browser — and each was fixed. Meanwhile the
   * Strategy Tester printed `instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot 15m`
   * across its own toolbar; the manual ticket said "No live quote for
   * instrument:v1:… right now"; three alert dialogs put it in their
   * confirmation toasts; and a screen reader announced the whole URN as the
   * focused pane's name. A rule that lists its own known failures only ever
   * covers the past.
   *
   * So: a symbol reaches the user through `displayTicker` (the control) or
   * `displaySymbol` (the qualified identity, for a tooltip or an accessible
   * name). Interpolating the variable itself is the defect.
   */
  // `{ symbol }` with spaces is object shorthand, not JSX — `{symbol}` is.
  const RAW = /(?:\{(?:props\.|pane\.|history\.dataset\.)?symbol\}|\$\{\s*(?:props\.|pane\.)?symbol\s*\})/;
  const offenders: string[] = [];
  for (const file of WORKSTATION) {
    const lines = code(read(file)).split("\n");
    for (const [i, line] of lines.entries()) {
      if (!RAW.test(line)) continue;
      /*
       * Three shapes that are not a render, and each is genuinely present:
       *   `symbol={symbol}` / `baseSymbol={symbol}` hands the value DOWN to a
       *     component that will display it properly itself;
       *   `key={symbol}` and `value={symbol}` are React and form plumbing;
       *   a lookup or a comparison is not text at all.
       */
      if (/\w+=\{(?:props\.|pane\.)?symbol\}/.test(line)) continue;
      if (/\[(?:props\.|pane\.)?symbol\]|===|!==/.test(line)) continue;
      offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [],
    "a symbol must reach the user through displayTicker/displaySymbol:\n"
    + offenders.join("\n"));
});

test("CONTRACT — presentation never re-subscribes the feed or remounts the chart", () => {
  /*
   * Measured in the browser on a production build: every interaction in the
   * workstation — theme, chart type, timeframe, settings, drawing tool, rail
   * panel, replay, bottom panel, pan, zoom, resize — completes in 25-44ms with
   * ZERO chart remounts and ZERO new sockets. This test guards the two
   * structural facts that make that true, because both are one careless
   * dependency away from being false.
   *
   * 1. The chart is created in an effect with NO dependencies, so nothing can
   *    recreate it. (`tests/chartControls.test.ts` also asserts this from the
   *    price-scale angle; it is repeated here because it is the single largest
   *    contributor to the product feeling immediate rather than reloading.)
   *
   * 2. The market feed's subscription depends on WHAT is being watched, never
   *    on how it is drawn. Adding a colour to that dependency array tears down
   *    and re-opens a websocket every time the user changes a candle colour or
   *    flips the theme — which is why the volume palette reaches the live tick
   *    through a ref instead.
   */
  const chart = code(read("components/CandleChart.tsx"));

  const created = chart.slice(chart.indexOf("const chart = createChart("));
  assert.ok(created.slice(0, created.indexOf("}, []);") + 7).trimEnd().endsWith("}, []);"),
    "the chart-creating effect must have no dependencies");

  const feed = chart.slice(chart.indexOf("marketFeed.subscribe("));
  const deps = feed.slice(0, feed.indexOf("]);") + 3);
  for (const presentation of ["upColor", "downColor", "themeTick", "volumeBarColor", "settings"]) {
    assert.equal(deps.includes(presentation), false,
      `the market feed must not resubscribe on ${presentation} — read it through a ref`);
  }
  assert.match(chart, /volumeBarColorRef\.current\(/,
    "the live tick reads the palette through a ref, not a closure");
});
