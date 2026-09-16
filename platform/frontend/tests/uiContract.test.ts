/**
 * The UI/UX decisions that a later agent is most likely to walk backwards.
 *
 * `docs/TRADING_SCENE_UI_UX_CONTRACT.md` is the prose; this file is the part a
 * CI run can refuse. Every rule here has actually regressed on this project at
 * least once, which is the bar for being in this file — it is not a style
 * guide, it is a list of scars.
 *
 * ── What these rules can and cannot do ────────────────────────────────────
 *
 * Every rule here reads SOURCE TEXT. None of them mounts a component, so none
 * of them can prove a behaviour — and an earlier version of this header
 * claimed they assert "SEMANTICS, not pixels", which an adversarial pass
 * rightly called out: several rules are exactly the class-string proxies that
 * sentence forbids.
 *
 * The honest description is narrower and still worth having. These rules
 * catch a DECISION being reversed: an accent reappearing in a conditional, a
 * raw symbol reaching a label, a menu drawing its own rows, a monospace face
 * on a price. They are cheap, they run in milliseconds, and each one exists
 * because the thing it names actually regressed.
 *
 * What they cannot catch is a control that renders correctly and does nothing.
 * That needs the DOM suite (`tests/dom/`), which mounts and drives, or a
 * browser. When a rule here reads like a behaviour ("every settings control
 * reaches something") it is checking the STRUCTURE that behaviour depends on,
 * not the behaviour — and where that distinction matters the rule says so.
 *
 * Where a literal is unavoidable (a measured token value) it is the value the
 * contract documents, and the contract says where it came from.
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

/*
 * TVP8: the grammar rules below used to be scoped to WORKSTATION, so every one
 * of them — accent-as-selection, the hover token, raw provider copy — was
 * enforced on the chart and on nothing else. That is how `/alerts` kept an
 * accent-tinted selected row through a whole campaign whose contract says in
 * as many words that selection is a neutral chip.
 *
 * A rule that only holds on the page it was written for is a preference. These
 * are rules, so they are checked everywhere the product renders.
 */
const PRODUCT = [...sourceFiles("app"), ...sourceFiles("components")];

/*
 * TVP8 round two: `lib` counts.
 *
 * The native-dialog ban scoped itself to `app` and `components`, and
 * `lib/useSavedLayouts.ts` held five browser prompts and a confirm — the whole
 * Layouts workflow, invisible to the rule that exists to forbid exactly that.
 * A hook renders UI; where the file sits in the tree does not change what the
 * user sees.
 */
const PRODUCT_AND_LIB = [...PRODUCT, ...sourceFiles("lib")];

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
  /*
   * `.tvc-menu-heading` joined the list when the drawing flyouts took the
   * reference's sections: a seventeen-row menu with no section labels is a
   * list you read rather than scan, and the heading is only a heading while
   * the rule that styles it is in scope for both roots.
   */
  for (const rule of ["\\.tvc-control", "\\.tvc-menu", "\\.tvc-menu-heading"]) {
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
  // `border-l-accent` and friends are accent too — the first version of this
  // matched only the unsided `border-accent` and missed the symbol search's
  // current-row edge entirely.
  /*
   * TVP8: two holes, both of which let real defects through.
   *
   * 1. The shape was `(?|&&) "…accent…"` — the accent class had to sit in a
   *    STRING directly after the operator. `{selected && <div className="…
   *    bg-accent/5">}` puts a `<` there instead, so the single genuine
   *    accent-as-selection left in the product (the /alerts row) matched
   *    nothing. The operator is now followed by any of `<`, a quote or a
   *    backtick — conditional element, conditional string, conditional
   *    template.
   * 2. A `focus:`/`hover:`/`group-*:` variant cannot express "this one is
   *    selected" — it expresses a pointer or keyboard state, and the contract
   *    names the focus ring as accent's job. Those are no longer offenders, so
   *    the rule does not push people into marking a focus ring as meaningful.
   *
   * Checked against PRODUCT, not WORKSTATION. Counted at the time of writing:
   * 0 in the old shape, 23 legitimate uses + 1 real defect in the new one.
   */
  /*
   * TVP8 round two: the exclusion was `(?<![\w:-])`, which walks past EVERY
   * Tailwind variant prefix and not only the pointer ones the comment above
   * names. `aria-selected:bg-accent/10` and `data-[state=selected]:text-accent`
   * are the idiomatic spellings of exactly the defect this rule exists to
   * catch, and both passed.
   *
   * So: only a POINTER or focus variant is exempt, by name. A state variant —
   * `aria-selected:`, `data-[…]:`, `group-aria-*` — is the rule's whole
   * subject and must not be excused.
   */
  const POINTER_VARIANT = String.raw`(?:hover|focus|focus-visible|focus-within|active|group-hover|group-focus|peer-hover|peer-focus)`;
  const ACCENT = String.raw`(?<!\w)(?<!${POINTER_VARIANT}:)(?:bg-accent(?:\/\d+)?|text-accent|border(?:-[xytrbl])?-accent(?:\/\d+)?)`;
  const CONDITIONAL = new RegExp(String.raw`(?:\?|&&|\|\|)\s*\(?\s*(?:<|\`|")`);
  const offenders: string[] = [];
  for (const file of PRODUCT) {
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
  /*
   * Hover is a STATE, and this product has a token for it. A panel colour is
   * a place, and using one as a hover moves the control a step in whichever
   * direction that panel happens to sit — on the dark theme `surface` is
   * `#0f0f0f` against a `#2e2e2e` ground, so hovering made the control DARKER,
   * which reads as pressed or disabled rather than hot.
   *
   * TVP8 round two: this rule named `surface-2` alone, and six sites were
   * hovering to `surface` — five of them in the Screener, where they were
   * spelt `hover:bg-[var(--color-surface-3)]` and therefore invisible to a
   * rule about Tailwind tokens at all. Removing that second vocabulary is what
   * surfaced them; the rule now covers every surface rather than the one it
   * was written against.
   */
  const SURFACE_HOVER = /hover:bg-(?:bg|surface|surface-2)\b(?!-)/;
  const offenders = PRODUCT_AND_LIB.filter((f) => SURFACE_HOVER.test(read(f)));
  assert.deepEqual(offenders, [],
    `hover must be the state token, not a panel colour: ${offenders.join(", ")}`);

  // The tripwire: 69 sites use the state token, so a rule reading zero of
  // either is a rule that has stopped reading.
  const using = PRODUCT_AND_LIB.filter((f) => /hover:bg-state-hover\b/.test(read(f)));
  assert.ok(using.length >= 20,
    `only ${using.length} files use the state hover — this rule has stopped reading`);
});

test("CONTRACT — a provider's raw words are never a headline (STRUCTURE ONLY)", () => {
  /*
   * ── What this test is, and what it is NOT ─────────────────────────────────
   *
   * READ THIS BEFORE TRUSTING IT. Everything below is a regular expression
   * over SOURCE TEXT. It cannot see what the page says, and it did not:
   *
   * this test was green for the whole of TVP7 and most of TVP8 while the hook
   * it reads put `invalid SOLUSDT 15m backfill: invalid_close_time` across the
   * top of the plot as the most prominent sentence on the page. It passed
   * because the identifiers it greps for were present — in the OTHER branch.
   * The stream-warning path split headline from cause; the hard-error path did
   * `setError((cause as Error).message)` and set no detail at all. A test that
   * asks whether a word appears in a file cannot tell those two apart.
   *
   * The rule itself is pinned by `tests/dom/providerFailureCopy.test.tsx`,
   * which mounts the real workspace against a fixture that refuses the candles
   * route and reads the DOM. That is the test to change if the rule changes.
   *
   * This one is kept for what it can honestly do: catch the two channels being
   * DELETED outright, cheaply, in the unit suite. It is a smoke alarm, not an
   * inspection, and its name now says so.
   */
  const hook = read("lib/useCandleHistory.ts");
  assert.match(hook, /errorDetail/, "the technical cause has its own channel");
  assert.match(hook, /errorLevel/, "degraded and broken are different events");
  assert.doesNotMatch(hook, /setStreamWarning\(`[^`]*\$\{\(cause as Error\)\.message\}/,
    "a cause may be carried, never interpolated into the user's sentence");
  assert.match(read("components/tv/ChartPane.tsx"), /title=\{history\.errorDetail/,
    "the cause belongs in the tooltip");

  /*
   * The one thing this file CAN check that the DOM test cannot: that the
   * behavioural test still exists and still drives the hook. A rule whose only
   * real coverage is one file is a rule that a deletion silently repeals.
   */
  const behavioural = read("tests/dom/providerFailureCopy.test.tsx");
  assert.match(behavioural, /mountChart/,
    "the rule's real coverage must mount the product, not read it");
  assert.match(behavioural, /assertRefused/,
    "and must fail if it never reached the failure path");
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

  /*
   * Exported is not adopted. This rule used to assert only that `PageHeader`
   * EXISTED, and it did — with zero call sites, while its own doc comment
   * claimed it had unified seventeen headings. A primitive nobody imports is a
   * second definition of the thing it was meant to replace.
   */
  const callers = [...sourceFiles("app")].filter((f) => /<PageHeader\b/.test(read(f)));
  assert.ok(callers.length > 0,
    "PageHeader has no call sites — either use it or delete it");
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

test("CONTRACT — nothing floats over the chart", () => {
  /*
   * The rule this replaces asserted that the floating theme toggle CLEARED the
   * phone action bar, which it did — a `:has()` rule lifted a fixed 44px
   * button off the "Automate" tab it had been covering at 390x844.
   *
   * Clearing was the wrong fix for the right complaint. The button was a
   * blurred, drop-shadowed, 10px-radius FAB parked on top of the price axis on
   * every page: no workstation floats a chrome control over its own canvas,
   * and it was the first non-chart pixel the eye landed on. It lives in
   * `ProductMenu` on the chart and in `Nav`'s control row everywhere else now,
   * so there is nothing to lift and nothing to collide with.
   *
   * What is asserted instead is the general rule, which is the one that keeps
   * the next FAB out.
   */
  assert.doesNotMatch(css, /\.theme-toggle/, "the floating toggle is gone, styles included");

  const floats = [...css.matchAll(/([^{}]+)\{([^}]*position:\s*fixed[^}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }))
    .filter(({ selector }) => !/^@|::backdrop|\.skip-link|html|body/.test(selector));
  assert.deepEqual(floats.map((f) => f.selector), [],
    "a fixed-position element in globals.css floats over the workspace; put it "
    + "in the chrome that already holds controls");

  // The bar still sizes itself from the token the lift used to share.
  assert.match(css, /--ts-phone-nav-height:\s*\d+px/);
  const panel = read("components/tv/ChartSidePanel.tsx");
  assert.match(panel, /<nav data-phone-nav/);
  assert.match(panel, /min-h-\[var\(--ts-phone-nav-height\)\]/);

  /*
   * And the control is where the shell keeps its other controls.
   *
   * TVP8 R1-02: this used to assert `<ThemeToggle` in BOTH shells, which was
   * the right rule wearing the wrong spelling. The chart's menu took
   * TradingView's grammar, in which a setting is a row that names the SETTING
   * and shows a switch on the right — not an icon button whose accessible name
   * is the verb ("Use Light theme") and whose only content is a sun. A single
   * button has no slot for a label AND a switch, so the chart's menu writes the
   * row itself.
   *
   * What matters is not which component draws it: it is that two theme
   * controls cannot become two themes. So what is pinned is the part that can
   * break silently — the same storage key, and the same announcement — rather
   * than the tag name.
   */
  const productMenu = read("components/tv/ProductMenu.tsx");
  assert.match(productMenu, /Dark theme/, "the chart's menu still carries the theme");
  assert.match(productMenu, /THEME_KEY/,
    "…written through the same storage key as `ThemeToggle`, not a second one");
  assert.match(productMenu, /"trading-scene-theme"/,
    "…and announced the same way, so the other control follows it");
  assert.match(read("components/Nav.tsx"), /<ThemeToggle/);
  assert.doesNotMatch(read("app/layout.tsx"), /ThemeToggle/,
    "it is no longer rendered outside the shell");
});

test("CONTRACT — the product entry is a rail cell, and its menu is the row grammar", () => {
  /*
   * TVP8 R1-02, measured live at 1440×900 dark
   * (`measurements/tv-product-menu-20260914.md`).
   *
   * TradingView's account/product entry is not on the toolbar at all: it is a
   * 52×38 cell at the very top-left of the WINDOW, above the left rail,
   * holding a 28px circular avatar with the user's initial and a small badge
   * at its top-right. Nothing product-branded sits on the bar, which is why
   * TV's symbol pill is the first thing there at x=56. Ours was a glyph plus a
   * chevron plus a separator INSIDE the row, and it pushed every control after
   * it 57px right (our pill measured at x=113).
   *
   * The menu it opens is 260px at [53,0]: a 40px BRAND row, then 40px rows
   * with a 28px glyph box on every one of them, 14px/400 labels, 13px spacer
   * separators, a switch row for the theme, a key hint on the shortcuts row
   * and a red sign-out at the end. Ours was 288px of 30px rows at 13px with no
   * glyphs, under a product name and two sentences of status prose — and then,
   * for a wave, under an `● System Attention` operations readout (R1b-04).
   *
   * Read as CODE: this file's own header describes the cell it replaced, and a
   * rule that reads prose about a shape cannot tell it from the shape.
   */
  const menu = code(read("components/tv/ProductMenu.tsx"));

  // Two shapes for the trigger, so the bar keeps working until the page moves.
  assert.match(menu, /variant\?:\s*"bar"\s*\|\s*"rail"/,
    "the trigger must offer both shapes, not swap one for the other");
  assert.match(menu, /h-\[38px\] w-\[52px\]/, "TV's cell is 52 wide and 38 tall");
  assert.match(menu, /h-7 w-7 items-center justify-center rounded-full bg-state-active/,
    "…holding a 28px circular avatar");
  /*
   * ── TVP8 R1c-10: the corner carries a COUNT, or nothing ──────────────────
   *
   * This used to REQUIRE a 10px dot at the avatar's top-right whenever the
   * manual was unread. Measured on the reference at 1440, the same corner
   * carries a red pill with a NUMBER in it and is empty otherwise — and ours
   * was a blue dot with no count, lit on every first run, in every capture
   * round 3 took. A number is a fact a user can act on; a bare mark on an
   * account button says only "there is a thing somewhere", which is the kind
   * of signal that trains people to ignore the corner.
   *
   * Nothing was lost with it: the unread manual is still nudged, on the Help
   * row inside this menu, in the muted `Start here` note the reference uses
   * for the same purpose — asserted below.
   */
  assert.doesNotMatch(menu, /-right-0\.5 -top-0\.5 h-2\.5 w-2\.5 rounded-full/,
    "the account cell carries a numeric badge or nothing — never a bare dot");
  assert.match(menu, /note=\{l\.href === HELP_HREF && firstRun \? "Start here" : undefined\}/,
    "the unread manual keeps the nudge the reference gives it");
  /*
   * R1c-10: and the brand row has no dot either. Same finding, other end of
   * the same control — an amber health mark at x≈297 in every 1440 capture.
   */
  assert.doesNotMatch(menu, /role="status"[\s\S]{0,200}?rounded-full \$\{statusDot\}/,
    "the brand row is a wordmark; health is its tooltip and Operations' page");
  /*
   * R1c-10: the menu's own geometry. TV's box is [53,0,260,525] and its first
   * link is at y=53 — a 40px brand row from y=0, the hairline at 46, the row
   * at 53. `.tvc-menu`'s own 6px of top padding put every one of those six
   * low, and the menu started one pixel early at x=52.
   */
  assert.match(menu, /rail \? "left-\[53px\] top-0 !pt-0"/);
  /*
   * R1b-04: and it is a NOTIFICATION, never an ops readout.
   *
   * The avatar used to badge whichever of the stream and the system was
   * unwell, so a healthy-looking workstation was one backend poll away from an
   * amber dot on its account button — a control reporting on infrastructure,
   * which is not what an account button is for and which TradingView's own
   * (an unread count) never does. The health truth is the brand row's tooltip.
   */
  assert.doesNotMatch(menu, /\$\{\s*alert \?\? "bg-accent"\s*\}/,
    "the account cell must not carry a health dot");

  // The menu's box: 260px, anchored beside the cell rather than under it.
  assert.match(menu, /w-\[260px\]/, "TV's menu box is 260px wide");
  // R1c-10: 53, not 52 — the reference's box starts one pixel past the cell.
  assert.match(menu, /left-\[53px\] top-0/, "…opening beside the cell, at y=0");

  // The row grammar, on every row: 40px (`.tvc-menu-row`), a 28px glyph box,
  // 14px/400 label, and 13px spacer separators between sections.
  assert.match(menu, /tvc-menu-row/, "rows are the shared 40px row");
  assert.match(menu, /text-\[14px\] font-normal/, "labels are 14px/400, not 13px");
  assert.match(menu, /className="flex h-7 w-7 shrink-0 items-center justify-center"/,
    "every row carries a 28px glyph box");
  assert.match(menu, /tvc-menu-sep/, "sections are separated by the 13px spacer");

  /*
   * ── R1b-04: the FIRST row is the brand, and health is a tooltip ──────────
   *
   * The two readouts were two lines of 11px prose under the product name, then
   * one 32px `role="status"` row — `● System Attention` — as the menu's
   * headline. Measured on the reference, the first row is the WORDMARK at 40px
   * and there is no health readout on this control at all: an operations
   * string as the first thing a user reads when they reach for "where else can
   * I go" was the loudest non-TradingView signal the shared chrome had.
   *
   * What survives, and must: the detail — including the cause `useOpsHealth`
   * separates out — is the brand row's `title` (REV-UX-01).
   *
   * ── TVP8 R1c-10: and the dot went with the readout ───────────────────────
   *
   * This used to REQUIRE a 6px dot on the brand row whenever anything was
   * degraded. Round 3 found it lit in every 1440 capture, which makes it
   * decoration rather than a signal, and the reference's own brand row is a
   * wordmark and nothing else. The escalation path is unchanged and better
   * than a dot: the sentence is this row's tooltip, and Operations — two rows
   * below — is the page that can say what is wrong and what to do about it.
   */
  const brandRow = /className="flex h-10 items-center[^"]*"[\s\S]{0,900}?<\/div>/.exec(menu)?.[0] ?? "";
  assert.ok(brandRow, "the menu has no 40px brand row");
  assert.match(brandRow, /\{PRODUCT_NAME\}/, "…carrying the product's own wordmark");
  assert.match(brandRow, /title=\{statusDetail\}/,
    "…and the whole of both readouts, in its title");
  assert.doesNotMatch(brandRow, /rounded-full/,
    "the brand row is a wordmark: no status dot at any health (R1c-10)");
  assert.doesNotMatch(menu, /role="status"/,
    "the ops readout must not be a row, a chip or a dot of this menu");
  assert.doesNotMatch(menu, />\s*\{health\.summary\}/,
    "the health SENTENCE is a tooltip, never rendered copy");

  /*
   * And the route the user is on is ANNOUNCED, not painted.
   *
   * `data-active` on the current destination is the inverted selection chip —
   * 260px of rgb(242) on `Chart` every time the menu is opened from the chart,
   * which is every time it is opened. TV marks nothing in this list as
   * current; `aria-current="page"` keeps the fact for anyone who needs it.
   */
  assert.match(menu, /aria-current=\{current \? "page" : undefined\}/);
  assert.doesNotMatch(menu, /data-active=\{current/,
    "a destination is not a value in force, so it takes no selection chip");

  // A menu entry that does nothing is worse than no entry, so the shortcuts
  // row exists only when something can open the sheet.
  assert.match(menu, /onOpenShortcuts && /,
    "the shortcuts row renders only behind an opener");
  assert.match(menu, /BINDINGS\.find/,
    "and its key hint is read from the binding table, so it cannot advertise a dead key");

  // Sign out is the last row, and it is the only red one.
  assert.match(menu, /text-down[\s\S]{0,400}Sign out/, "sign out reads as destructive");
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
  const notice = /role="status"[\s\S]{0,1600}?className="([^"]+)"/.exec(pane)?.[1] ?? "";
  assert.ok(notice.includes("bottom-2"), "on a phone it sits at the foot of the pane");
  assert.ok(notice.includes("sm:top-2") && notice.includes("sm:bottom-auto"),
    "and returns to the top only where there is room for it");

  /*
   * TVP8 round two: and it is not centred over the price action.
   *
   * It was a pill across the top-centre of the plot carrying the whole
   * sentence — and it is NOT transient: whenever streaming is unavailable it
   * stays for the session. The reference keeps feed state as a small marker
   * and puts the sentence in the tooltip, which is what this is now.
   */
  assert.equal(notice.includes("left-1/2"), false,
    "a persistent notice must not sit across the middle of the plot");
  assert.ok(notice.includes("right-2"), "it lives opposite the legend");
  assert.match(pane, /<span>Delayed<\/span>/, "two words, with the sentence in the title");
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

  /*
   * TVP8: this assertion could not fail.
   *
   * It was `created.slice(0, indexOf("}, []);") + 7).endsWith("}, []);")` —
   * a slice that ENDS at the first `}, []);` and is then asked whether it ends
   * with `}, []);`. True by construction. Give the effect a dependency and
   * `indexOf` simply walks on to the next zero-dependency effect in the file
   * and the test stays green; verified by mutating the real array to
   * `}, [symbol]);`.
   *
   * What it has to do instead is read the dependency array that CLOSES THIS
   * EFFECT, so: find the effect's own closing line and capture what is in the
   * brackets. `[\s\S]*?` is lazy, so this is the first `}, [...]);` after
   * `createChart(` — the effect's own — and the captured text has to be empty.
   */
  const created = chart.slice(chart.indexOf("const chart = createChart("));
  const closes = /[\s\S]*?\n\s*\}, \[([^\]]*)\]\);/.exec(created);
  assert.ok(closes, "could not find the end of the chart-creating effect");
  assert.equal(closes![1].trim(), "",
    `the chart-creating effect must have no dependencies — found [${closes![1].trim()}]`);

  /*
   * TVP8: and this one was case-blind. The token was the lowercase word
   * `settings`, which does not appear in `transformSettings` — so the one
   * presentation value that WAS in the array went unseen for a whole campaign,
   * and a chart-type setting change tore down the websocket. Matching is now
   * case-insensitive and the array is located by the effect that closes after
   * the subscribe call, not by the first `]);` in the remaining file.
   */
  const feed = chart.slice(chart.indexOf("marketFeed.subscribe("));
  const feedCloses = /[\s\S]*?\n\s*\}, \[([^\]]*)\]\);/.exec(feed);
  assert.ok(feedCloses, "could not find the end of the market-feed effect");
  const deps = feedCloses![1].toLowerCase();
  for (const presentation of ["upColor", "downColor", "themeTick", "volumeBarColor", "Settings"]) {
    assert.equal(deps.includes(presentation.toLowerCase()), false,
      `the market feed must not resubscribe on ${presentation} — read it through a ref`);
  }
  assert.match(chart, /volumeBarColorRef\.current\(/,
    "the live tick reads the palette through a ref, not a closure");
});

test("CONTRACT — a menu that adopts the popover also adopts the ROW", () => {
  /*
   * `.tvc-menu` is the container: #1f1f1f, radius 6, 6px of padding. It is
   * cheap to adopt and two menus adopted only that — the layout selector's
   * arrangement list and the layout menu's "Open a layout" list — leaving
   * hand-rolled `px-2 py-1.5` rows at about 28px inside a popover whose whole
   * contract is 40px. Half the grammar looks more wrong than none of it,
   * because the padding is right and the rhythm is not.
   *
   * The rule: a file that renders `.tvc-menu` must render `.tvc-menu-row` too.
   *
   * The exception declares itself rather than appearing on a list here, and
   * TVP8 round two generalised it to what it was always about. It used to name
   * `role="toolbar"` — the drawing style bar, which borrows the popover
   * SURFACE and has no rows, being a horizontal strip of controls. The rule
   * underneath that is simply: a thing with MENU SEMANTICS owes the row
   * grammar; a thing that merely borrows the ground does not. The trading
   * overlay panel is the second of those — three checkboxes and a disclosure
   * — and it is a `group`, not a `menu`, for exactly the same reason a screen
   * reader should not be promised `menuitem` children it will not find.
   */
  /*
   * PRODUCT, not WORKSTATION. TVP8 round two: this rule read only the chart's
   * own files, and the menu that had been hand-rolling its rows for the whole
   * campaign was the System menu in the navigation bar — outside that list,
   * and therefore outside the rule that exists to catch exactly it.
   */
  const offenders: string[] = [];
  for (const file of PRODUCT) {
    if (!file.endsWith(".tsx")) continue;
    const src = code(read(file));
    if (!/\btvc-menu\b/.test(src)) continue;
    if (!/role="menu"/.test(src)) continue;
    if (!/\btvc-menu-row\b/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    `these open a .tvc-menu and then draw their own rows inside it: ${offenders.join(", ")}`);
});

test("CONTRACT — the product never asks through the browser's own dialog", () => {
  /*
   * TVP8: there were seventeen `window.confirm` / `window.prompt` calls.
   *
   * A native sheet drops from the top of the browser window in the OS's font
   * with the ORIGIN printed above it — "localhost:3000 says". Nothing else in
   * the product looks anything like it, and placing one piece of text on a
   * chart, the most ordinary use of the annotation rail, produced one. It also
   * blocks the main thread, which on a page built around a live chart stops
   * every tick and every animation until the user answers.
   *
   * `components/AskDialog.tsx` is the replacement, through the same `Modal` as
   * every other dialog — so it inherits the focus trap, Escape, restore-focus
   * and `role="dialog"` that `Modal` exists to guarantee, and it can say which
   * list it is about and paint a destructive button as destructive.
   *
   * `AskDialog` itself is exempt: it is the thing that replaced them, and it
   * names them in its own documentation.
   */
  /*
   * TVP8 round two: `window.` is optional.
   *
   * The first version of this matched `window.confirm(` and walked straight
   * past `app/trading/page.tsx`'s bare `confirm(...)` — the same global, the
   * same native sheet, one qualifier short of being caught. A rule that only
   * catches the spelling it was written against is not a rule, which is the
   * second time this campaign has had to learn that.
   *
   * `\b(?<!\.)` so a method called `confirm` on something of ours is not a
   * false positive; only the bare global and the `window.`-qualified one.
   */
  const NATIVE = /(?:\bwindow\.(?:confirm|prompt|alert)|(?<![.\w])(?:confirm|prompt|alert))\s*\(/;
  /*
   * Strings stripped as well as comments, because widening the rule to the
   * bare global immediately matched `${count} alert(s) — click to add another`
   * in a tooltip. A rule that fires on prose is a rule people turn off.
   */
  const withoutLiterals = (src: string): string => code(src)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  const offenders = PRODUCT_AND_LIB
    .filter((f) => !f.endsWith("AskDialog.tsx"))
    .filter((f) => NATIVE.test(withoutLiterals(read(f))));
  assert.deepEqual(offenders, [],
    `ask through <AskProvider>'s useAsk(), not the browser: ${offenders.join(", ")}`);

  /*
   * And the provider is actually MOUNTED, or `useAsk` throws on first use.
   *
   * TVP8 round two: this matched `/<AskProvider>/` against the raw file, so
   * replacing the real element with `{/* <AskProvider> was here *\/}` left it
   * green while every one of the seventeen migrated confirmations would have
   * thrown. Comments stripped, and both halves of the element required — an
   * opening tag with no closing tag does not wrap anything.
   */
  const layout = code(read("app/layout.tsx"));
  assert.match(layout, /<AskProvider>/, "the dialog has to be mounted above every page that asks");
  assert.match(layout, /<\/AskProvider>/, "and it has to wrap the tree, not just open");
});

test("CONTRACT — every page renders inside the shared grammar", () => {
  /*
   * TVP8. `.tvc-control`, `.tvc-menu`, the 40px menu row, `font-size: inherit`
   * on controls and the 1px focus offset are all scoped in `globals.css` as
   * `:is(.tv-workstation, .ts-app)`. A page outside both selectors does not
   * get any of them — and five routes plus the nav were outside.
   *
   * It is not subtle once you know: `<Button>` paints hover and selection on a
   * `::before` chip that only exists inside those selectors, so the four
   * buttons on Operations and the two on a Research detail had NO hover state
   * at all, and `variant="ghost"` rendered as bare text. The nav is worse than
   * a page, because it sits above every route including the chart: the theme
   * toggle's `tvc-control` was dead everywhere in the product.
   *
   * `PageShell` puts the class on for the pages that use it. The four that own
   * their own full-bleed layout — the Screener's grid, sign-in, and the two
   * with their own max-width — carry it themselves, which is what this checks.
   */
  const ROUTES = sourceFiles("app").filter((f) => f.endsWith("page.tsx"));
  const offenders: string[] = [];
  for (const route of ROUTES) {
    // TVP8 round two: comments stripped. A file that merely MENTIONS `ts-app`
    // in a docstring is not inside it.
    const src = code(read(route));
    // A redirect-only route renders nothing to style.
    if (/redirect\(/.test(src) && !/return \(/.test(src)) continue;
    const inside = /\bts-app\b/.test(src)
      || /\btv-workstation\b/.test(src)
      || /<PageShell\b/.test(src);
    if (!inside) offenders.push(route);
  }
  assert.deepEqual(offenders, [],
    `outside .ts-app / .tv-workstation, so the control grammar does not apply: ${offenders.join(", ")}`);

  /*
   * TVP8 round two: EVERY shell in the file, not just one.
   *
   * The check above is satisfied by a single occurrence anywhere in a file.
   * Two pages return a different root for their error/loading branch and for
   * their success branch, and the first fix landed on the error branch — which
   * is the one a broken fixture renders and a reviewer therefore screenshots.
   * So the page a user actually reaches stayed outside the design system while
   * the test went green.
   *
   * A page shell is recognisable: it centres itself and caps its width. Every
   * one of those has to carry the class.
   */
  const SHELL = /className="([^"]*\bmx-auto\b[^"]*\bmax-w-\[[^\]]+\][^"]*)"/g;
  const looseShells: string[] = [];
  for (const route of [...ROUTES, "app/error.tsx", "app/not-found.tsx"]) {
    const src = code(read(route));
    for (const match of src.matchAll(SHELL)) {
      if (!/\bts-app\b/.test(match[1]!)) looseShells.push(`${route} → ${match[1]!.slice(0, 48)}…`);
    }
  }
  assert.deepEqual(looseShells, [],
    `a page shell outside the grammar: ${looseShells.join(" | ")}`);

  // And the nav, which is above every one of them.
  assert.match(code(read("components/Nav.tsx")), /className="ts-app /,
    "the nav sits outside <main>, so it needs the class itself");
});

test("ONE COLOUR VOCABULARY, INCLUDING IN THE SCREENER", () => {
  /*
   * ── TVP8 round two ─────────────────────────────────────────────────────
   *
   * `.scanner-workspace` declared nine `--color-*` custom properties, each
   * aliasing one of the product's own tokens, and `components/scanner/*` then
   * spelt every colour as `text-[var(--color-ink-dim)]` — 112 call sites
   * across six files and the stylesheet.
   *
   * Nothing was WRONG with it: the aliases resolved, the colours were right
   * and both themes worked. What it cost was a SECOND SET OF NAMES for the
   * same eight colours, so a reader of those six files learned a vocabulary
   * that exists nowhere else, and a token added to the design system did not
   * exist there until somebody remembered to alias it. The contract's own
   * words are that the unique pages use the same primitives as the chart
   * workstation.
   *
   * The rule is on the SHAPE rather than on the nine names, so a tenth alias
   * invented tomorrow fails it too.
   */
  const offenders: string[] = [];
  for (const file of PRODUCT_AND_LIB) {
    const src = read(file);
    for (const m of src.matchAll(/var\(--color-[a-z0-9-]+\)/g)) {
      // The one in `globals.css` is the sentence explaining the removal.
      const at = m.index ?? 0;
      const line = src.slice(src.lastIndexOf("\n", at) + 1, src.indexOf("\n", at));
      if (/^\s*\*/.test(line)) continue;
      offenders.push(`${file}: ${line.trim().slice(0, 84)}`);
    }
  }
  assert.deepEqual(offenders, [],
    "`--color-*` is a second name for a token that already has one — use the "
    + "product's own:\n  " + offenders.join("\n  "));

  /*
   * And the alias block itself is gone, rather than merely unused: an unused
   * declaration is an invitation, and this one was taken 112 times.
   */
  const css = read("app/globals.css");
  assert.doesNotMatch(css, /^\s*--color-[a-z0-9-]+:/m,
    "the Screener's alias block is the thing that made the second vocabulary possible");

  // What survives is the part that was never a vocabulary: the Scanner's
  // DENSITY, which is genuinely its own.
  assert.match(css, /\.scanner-workspace table\.dense th,/);
  assert.match(css, /\.scanner-workspace \.sticky-col \{/);
});

test("CONTRACT — ANYTHING THAT CALLS ITSELF A MENU LOOKS LIKE ONE", () => {
  /*
   * ── TVP8 round two ─────────────────────────────────────────────────────
   *
   * The rule above is the converse of this one, and only one of the two
   * existed. "A menu that adopts the popover also adopts the row" catches half
   * the grammar; it says nothing about a menu that adopts NEITHER — and two
   * did, one of them the System menu in the product's own navigation bar,
   * which is outside `WORKSTATION` and so outside every rule there is.
   *
   * Both hand-rolled `rounded-md border border-border bg-surface … shadow-xl`,
   * which on the dark theme is `#0f0f0f` under a popover grammar of `#1f1f1f`:
   * a popover DARKER than the bar it opens from, which is the opposite of the
   * contract, under Tailwind's heaviest shadow instead of the measured
   * `0 2px 4px rgba(0,0,0,0.4)`. The Nav's rows were ~33px against a 40px
   * contract and, without the 6px gutter, hovered edge to edge rather than as
   * the inset chip the control-state grammar is recognisable by.
   *
   * `role="menu"` is the trigger because it is the author's own claim about
   * what the thing is. A panel that is not a menu should not say it is.
   */
  const offenders: string[] = [];
  for (const file of PRODUCT) {
    if (!file.endsWith(".tsx")) continue;
    const src = read(file);
    for (const m of src.matchAll(/role="menu"/g)) {
      /*
       * The whole opening tag, parsed past braces and quotes — a className
       * built from a template literal or sitting after a `style={…}` is still
       * part of the element, and a lazy `[\s\S]*?>` would stop at the first
       * `>` inside an arrow function and miss it.
       */
      const start = src.lastIndexOf("<", m.index ?? 0);
      let i = (m.index ?? 0) + m[0].length, depth = 0, quote = "";
      while (i < src.length) {
        const c = src[i]!;
        if (quote) { if (c === quote) quote = ""; }
        else if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
        i++;
      }
      const tag = src.slice(start, i);
      /*
       * `MENU_BOX`-style constants count: the class reaches the element, and a
       * rule that insisted on the literal would have reported two perfectly
       * correct menus in the timeframe picker.
       */
      const named = [...tag.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((c) => c[1]!);
      const reaches = /\btvc-menu\b/.test(tag)
        || named.some((name) => new RegExp(`const ${name} =[\\s\\S]{0,400}?tvc-menu`).test(src));
      if (!reaches) offenders.push(`${file}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepEqual(offenders, [],
    "these declare role=\"menu\" and then paint their own popover:\n  " + offenders.join("\n  "));

  // Tripwire: the parse must still be finding menus at all.
  const menus = PRODUCT.filter((f) => f.endsWith(".tsx") && /role="menu"/.test(read(f)));
  assert.ok(menus.length >= 6,
    `found role="menu" in only ${menus.length} files — this rule has stopped reading`);
});

/*
 * ── The watchlist column (TVP8 R7b, R1c-06) ────────────────────────────────
 *
 * Every number below was measured by the R7b reviewer on
 * `tradingview/watchlist-open-1440-dark.png` against
 * `fable-reviews/r7b-captures/base-1440.png`, and every one of them was wrong
 * in the shipped build by between one and nine pixels. They are pinned as
 * CLASSES because that is where they live — a 29px row is a `md:h-[29px]` in
 * one file, and the failure it caused (eight rows ending 8px early, every row
 * below the first offset from the reference by one pixel per row) is invisible
 * to any assertion that does not read it.
 */
const WATCHLIST = read("components/tv/Watchlist.tsx");
const SIDE_PANEL = read("components/tv/ChartSidePanel.tsx");

test("CONTRACT — the watchlist row is 30px of pitch, separator included", () => {
  /*
   * R7b-01. `box-sizing: border-box` puts the `border-b` INSIDE the height, so
   * `md:h-[29px]` is a 29px pitch and not 29 + 1. Round 1 shipped 31 and this
   * is the same class of slip in the other direction.
   */
  assert.match(WATCHLIST, /md:h-\[30px\]/,
    "the row wrapper must be 30px — 29 of content plus the 1px separator inside it");
  assert.doesNotMatch(WATCHLIST, /md:h-\[29px\]/,
    "29 was the defect, not the target");
  const row = /className=\{`group relative h-11 border-b md:h-\[30px\]/.exec(WATCHLIST);
  assert.ok(row, "the row must still carry `border-b` — the separator is what the 30th pixel is");
});

test("CONTRACT — a token that has both spellings has the SAME colour in both", () => {
  /*
   * R7b-02, and the most expensive single line in the batch. `tailwind.config`
   * builds every colour as `rgb(var(--ts-X-rgb) / <alpha-value>)`, so the hex
   * twins are read by almost nothing — `lib/chartTheme` and a handful of
   * inline `var()`s. Round 1 moved `--ts-positive` to the reference's `#22ab94`
   * and left `--ts-positive-rgb: 46 189 133` beside it, so the whole watchlist
   * went on painting the OLD green under a token that said the new one, and
   * the repair reported itself as landed for a round.
   */
  /*
   * Comments stripped first: the dark block's own prose quotes
   * `--ts-surface: #121722` while explaining why that legacy value is gone,
   * and a rule that reads its own documentation is a rule that reports a
   * repair as a regression.
   */
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = declarations.split(/:root\s*(?:\[data-theme="light"\])?\s*\{/);
  assert.ok(blocks.length >= 3, "expected a dark :root block and a light one");
  for (const [theme, block] of [["dark", blocks[1]!], ["light", blocks[2]!]] as const) {
    for (const name of ["positive", "negative", "ink", "ink-faint", "line", "surface"]) {
      const hex = new RegExp(`--ts-${name}:\\s*#([0-9a-f]{6})`, "i").exec(block)?.[1];
      const triple = new RegExp(`--ts-${name}-rgb:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`).exec(block);
      assert.ok(hex && triple, `${theme}: --ts-${name} must be declared in both spellings`);
      const fromHex = [0, 2, 4].map((i) => parseInt(hex!.slice(i, i + 2), 16));
      assert.deepEqual(triple!.slice(1, 4).map(Number), fromHex,
        `${theme}: --ts-${name}-rgb is #${hex} written as numbers, or the two disagree and `
        + "the -rgb one is the one that paints");
    }
  }
});

test("CONTRACT — the watchlist gives Symbol 122px and clips only the ticker", () => {
  /*
   * R7b-03. `gap-x-1` gave four gaps' worth of the 300px away, and the cell
   * that paid was the ticker: a computed 30px, so the rows read `BTC▏`,
   * `ETH▏`, `LINK`, `AVA)` against the reference's six glyphs. The reference's
   * own ticker cell is 50px and MASKS its right edge, so a long name ends in a
   * gradient rather than mid-glyph.
   */
  assert.doesNotMatch(WATCHLIST, /gap-x-1/,
    "16px of a 300px panel spent on gaps is 16px the ticker does not have");
  for (const [name, value] of [
    ["mark", "18px"], ["markGap", "8px"], ["ticker", "minmax(0,1fr)"],
    ["last", "56px"], ["change", "54px"], ["changePct", "44px"],
  ] as const) {
    assert.match(WATCHLIST, new RegExp(`${name}:\\s*"${value.replace(/[()]/g, "\\$&")}"`),
      `the ${name} column is ${value} on the reference`);
  }
  assert.doesNotMatch(WATCHLIST, /maskImage:/,
    "D-01 hard-clips the ticker only when necessary and never fades or ellipsises it");
});

test("CONTRACT — the watchlist gutter is 4px, once, and outside the panel's 300", () => {
  /*
   * R7b-05 / R1c-06. The workspace row already lays its regions out with a 4px
   * `gap` of page ground; the panel ALSO painted a `w-[4px] bg-border` strip as
   * its own first column, so the seam measured 9px (chart frame 1085 + gutter
   * 1086–1089 + strip 1090–1093) and the panel's content was 296 wide instead
   * of 300. The reference: chart to 1089, gutter 1090–1093, panel 1094–1393,
   * a 1px line at 1394, rail 1395–1439.
   */
  assert.doesNotMatch(WATCHLIST, /w-\[4px\] shrink-0 bg-border/,
    "the gutter is the layout gap; a second one inside the panel is 4px of the panel's width");
  assert.match(SIDE_PANEL, /md:-mr-1/,
    "the panel's right edge meets the rail through a hairline, not through the row's gap");
  assert.match(SIDE_PANEL, /w-\[46px\][^"]*border-l border-border/,
    "46px of layout, 45 of paint: the last pixel is the rail's hairline to the watchlist");
  assert.match(SIDE_PANEL, /h-\[46px\] w-\[45px\]/,
    "R1c-06: the rail's painted cells are 45 wide (1395–1439 at 1440)");
});

test("CONTRACT — the watchlist grip is always drawn, 10x24, near the bottom", () => {
  /*
   * R7b-05b. Ours was 10x42, vertically centred and `opacity-0` until the
   * panel was hovered — so the one control that closes the column could not be
   * found by looking at it. The reference's is a notch cut into the band,
   * always painted, anchored about 60px above the bottom edge.
   */
  const grip = /aria-label="Hide the watchlist"[\s\S]{0,600}?\/>/.exec(WATCHLIST)?.[0]
    ?? WATCHLIST.slice(WATCHLIST.indexOf('aria-label="Hide the watchlist"') - 400,
      WATCHLIST.indexOf('aria-label="Hide the watchlist"') + 600);
  assert.match(grip, /h-\[24px\] w-\[10px\]/, "the reference's notch is 10 x 24");
  assert.doesNotMatch(grip, /opacity-0/,
    "a control that only exists under the pointer cannot be found by looking");
  assert.match(grip, /calc\(100% - 64px\)/, "anchored above the bottom edge, not centred");
});

test("CONTRACT — the right rail's first chip is at y=47, in the strong line colour", () => {
  /*
   * R7b-12. Six pixels of column padding plus the chip's own 4px inset put the
   * first chip at y=52 where the reference has it at 47, and every glyph
   * centre below it inherited the same five. The chip itself was
   * `--ts-state-active` (rgb 61) where the reference paints `--ts-line-strong`
   * (rgb 74) — the only painted thing in a column of bare glyphs.
   */
  assert.match(SIDE_PANEL, /data-side-rail="true"[\s\S]{0,400}?pt-\[1px\]/,
    "the rail column starts at y=42, so 1px of padding puts its first cell at 43 and its chip at 47");
  assert.match(css,
    /\[data-side-rail="true"\] \.tvc-control\[aria-pressed="true"\]::before[\s\S]{0,200}background-color:\s*var\(--ts-line-strong\)/,
    "the rail's active chip is a step stronger than a menu chip");
});

test("CONTRACT — the light theme's watchlist neutrals are measured, not mirrored", () => {
  /*
   * R7b-13. The separator, the selection ring and the news tint were all dark
   * values reflected onto white: separators heavier than the text hierarchy, a
   * ring that disappeared, and a card at 10% where the reference measures 13%.
   */
  const blocks = css.replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/:root\s*(?:\[data-theme="light"\])?\s*\{/);
  for (const [theme, block] of [["dark", blocks[1]!], ["light", blocks[2]!]] as const) {
    for (const token of ["--ts-line-soft", "--ts-ring", "--ts-control-border-strong"]) {
      assert.match(block, new RegExp(`${token}:`), `${theme} must declare ${token}`);
    }
  }
  assert.match(blocks[2]!, /--ts-line-soft:\s*#f2f2f2/,
    "the light reference separates rows with rgb(242,242,242)");
  assert.match(blocks[2]!, /--ts-ring:\s*#2e2e2e/,
    "the light reference rings the selected row in rgb(46,46,46)");
  assert.match(blocks[1]!, /--ts-news-tint:\s*rgba\(179, 136, 255, 0\.20\)/);
  assert.match(blocks[2]!, /--ts-news-tint:\s*rgba\(69, 39, 160, 0\.13\)/);
  assert.match(WATCHLIST, /var\(--ts-line-soft\)/, "the row's separator reads the token");
  assert.match(WATCHLIST, /var\(--ts-ring\)/, "the selected row's ring reads the token");
});

test("CONTRACT — the section band is a 6px gap over a 36px row, and carries no count", () => {
  /*
   * R7b-14. The band was 36px INCLUDING its 6px of top padding, so its label
   * sat high in its own row and the first quote arrived at y=153 where the
   * reference has it at 161. The count at the right end is the reference's own
   * absence — it paints none, and a number beside a group heading in a 300px
   * column is one more digit competing with eight prices.
   */
  assert.match(WATCHLIST, /data-watchlist-band[\s\S]{0,200}?mt-\[6px\] flex h-\[36px\]/,
    "6px of gap ABOVE a 36px row, not 6px of padding inside one");
  assert.doesNotMatch(WATCHLIST, /\{section\.rows\.length\}/,
    "the reference paints no count on its section band");
});
