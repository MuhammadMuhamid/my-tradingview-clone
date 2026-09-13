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
   * Two documented exemptions, both accent-as-MEANING rather than
   * accent-as-selection:
   *
   *   the focused PANE's border in a multi-pane layout. A pane is a container,
   *   not a control, so there is no chip to give it — and which pane the
   *   toolbar acts on is a high-stakes fact the reference also marks in colour.
   *
   *   a FAVOURITE star. "I keep this one" is data about the row, not a
   *   statement that the row is currently chosen.
   */
  const EXEMPT = /focused pane|multiPane|favourite/i;
  const offenders: string[] = [];
  for (const file of WORKSTATION) {
    const lines = read(file).split("\n");
    for (const [i, line] of lines.entries()) {
      if (!/\b(bg-accent\/\d+|text-accent|border-accent)\b/.test(line)) continue;
      if (!/\b(selected|isActive|active|open|checked|current)\b\s*(\?|&&)/.test(line)) continue;
      const context = lines.slice(Math.max(0, i - 4), i + 2).join(" ");
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
