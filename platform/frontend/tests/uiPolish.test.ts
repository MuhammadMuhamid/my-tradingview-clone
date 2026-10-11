/**
 * Presentation regressions that are invisible in review and silent at runtime.
 *
 * Static checks over the source, not a rendered audit — there is no browser
 * here, and claiming otherwise would be worse than checking less. Each of these
 * pins a specific defect that was found and fixed in this pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");

function sourceFiles(dir: string, ext = /\.tsx$/): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, ext));
    else if (ext.test(entry.name)) out.push(full);
  }
  return out;
}

const allTsx = (): string[] =>
  [...sourceFiles(path.join(ROOT, "app")), ...sourceFiles(path.join(ROOT, "components"))];

const rel = (f: string): string => path.relative(ROOT, f);

/** The file with its comments removed, so prose about a glyph is not a use of it. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\/.*$/gm, "");
}

// ── Icons ───────────────────────────────────────────────────────────────────

/*
 * Emoji and dingbats only.
 *
 * Arrows, geometric shapes and box-drawing characters are deliberately NOT
 * here: `→` between two date inputs, `●` beside a feed label and `┄` in a
 * dashed-line preview are typography, and they render in the page's own font at
 * the size and colour they inherit. An emoji does not.
 */
// FE0F is matched as its own alternative: a variation selector inside a
// character class combines with the range beside it.
const PICTOGRAPH = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}/u;

test("NO EMOJI OR DINGBAT IS USED AS A CONTROL", () => {
  /*
   * `🔔`, `✎`, `↻`, `✕`, `▣`, `🔒`, `⚠`, `★` were all rendered as text.
   *
   * A pictographic character is not an icon: it renders at whatever size and
   * colour the platform's emoji font decides, so it ignores the `text-accent`
   * or `text-ink-faint` the control is trying to express, and it is a different
   * size on macOS, Windows and Android. Several of these were the only content
   * of a button, which also left the button with no accessible name.
   *
   * Arrows are included because `→` and `▾` were used the same way.
   */
  const problems: string[] = [];
  for (const file of allTsx()) {
    const source = withoutComments(fs.readFileSync(file, "utf8"));
    source.split("\n").forEach((line, index) => {
      const match = line.match(PICTOGRAPH);
      if (!match) return;
      // An `aria-hidden` decorative character beside real text is not a control.
      if (/aria-hidden/.test(line)) return;
      problems.push(`${rel(file)}:${index + 1} uses "${match[0]}" — use an inline <svg>`);
    });
  }
  assert.deepEqual(problems, []);
});

// ── Tokens ──────────────────────────────────────────────────────────────────

test("NO TAILWIND CLASS POINTS AT A CSS VARIABLE THIS APP NEVER DEFINES", () => {
  /*
   * The deployments page styled its live-trading consent checkbox with
   * `accent-[var(--accent,#f0b90b)]`. Nothing in this application defines
   * `--accent`, so the control silently rendered at the hard-coded fallback
   * forever — a colour nobody chose, on the one checkbox that gates real
   * orders. Tailwind emits the class either way and no tool complains.
   */
  const css = fs.readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
  // Component-scoped custom properties are valid definitions too. Watchlist
  // sizes are intentionally set on the panel instance so each open panel can
  // carry its own persisted width rather than changing the global theme.
  for (const file of allTsx()) {
    const source = withoutComments(fs.readFileSync(file, "utf8"));
    for (const m of source.matchAll(/\[\s*["'](--[\w-]+)["'](?:\s+as\s+string)?\s*\]\s*:/g)) {
      defined.add(m[1]!);
    }
  }
  const problems: string[] = [];
  for (const file of allTsx()) {
    const source = withoutComments(fs.readFileSync(file, "utf8"));
    for (const m of source.matchAll(/\[var\((--[\w-]+)/g)) {
      if (defined.has(m[1]!)) continue;
      // No line number: comments are stripped above, so an index into this
      // string would not point at the right line of the real file.
      problems.push(`${rel(file)} reads ${m[1]}, which globals.css does not define`);
    }
  }
  assert.deepEqual(problems, []);
});

// ── State is never colour alone ─────────────────────────────────────────────

test("two-state toggles announce their state, not only tint it", () => {
  const cases: Array<[string, RegExp[]]> = [
    // Line visibility in the moving-average rail.
    ["components/tv/MaPanel.tsx", [/aria-pressed=\{line\.visible\}/]],
    // Study visibility in the Indicators panel.
    ["components/tv/IndicatorsPanel.tsx", [/aria-pressed=\{ind\.visible\}/]],
    // Buy versus sell — now two explicit buttons, because each carries its own
    // live price — and the tester's tabs.
    ["components/tv/ManualTradingPanel.tsx",
      [/aria-pressed=\{side === "SELL"\}/, /aria-pressed=\{side === "BUY"\}/, /role="tab"/]],
    ["components/tv/StrategyTester.tsx", [/role="tab"/, /aria-selected=/]],
    // Drawing lock, which differs in shape as well as tint.
    ["components/tv/DrawingCanvas.tsx", [/aria-pressed=\{Boolean\(sel\.locked\)\}/]],
  ];
  for (const [file, patterns] of cases) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const pattern of patterns) {
      assert.match(source, pattern, `${file} lost ${pattern}`);
    }
  }
});

// ── Operations tells the two systems apart ─────────────────────────────────

test("every Operations card says which system owns its numbers", () => {
  /*
   * The platform knows what it EMITTED; the bot knows what the exchange
   * actually did. Reading a platform-local number as an exchange fact is the
   * specific mistake this page is built to prevent, and it was carried only by
   * the prose under each title.
   */
  const source = fs.readFileSync(path.join(ROOT, "app", "operations", "page.tsx"), "utf8");
  const titles = [...source.matchAll(/title=\{<><Owner of="(platform|bot)" \/>/g)];
  assert.ok(titles.length >= 6, `only ${titles.length} cards name their owner`);
  assert.ok(
    titles.some((m) => m[1] === "bot"),
    "the execution bot's card is not marked as the authoritative one"
  );
  // The platform has no daily-loss limit at all, and must not read as one that
  // is merely switched off beside two limits that are real.
  assert.match(source, /No platform daily-loss limit/);
});

// ── R3b-15: the headline is 16px in the BROWSER, not only in the source ────

test("THE STATUS LINE'S HEADLINE WINS AGAINST THE WORKSTATION'S OWN BUTTON RULE", () => {
  /*
   * ── The regression this exists to make impossible ────────────────────────
   *
   * R3-14 set the pane legend's name to `text-[16px]`, the reviewer measured
   * it, and the class was in the file — so every source test passed. In the
   * browser the headline computed to FOURTEEN: `app/globals.css` carries
   *
   *     :is(.tv-workstation, .ts-app) button { font-size: inherit }
   *
   * unlayered and after `@tailwind utilities`, and at equal specificity
   * (0,1,1 — one class, one element, `:is()` taking its most specific
   * argument) the later rule wins. So the name ran at the inherited
   * `--ts-workstation-font-size: 14px` while the `1h` and the venue beside it
   * ran at 16, and one line carried three sizes.
   *
   * This is NOT a class-name assertion — a class name is exactly what was
   * green while the defect shipped. It is the cascade: IF that rule is in
   * globals.css, THEN the legend's own size must be an `!important` utility,
   * which is the one thing that beats an unlayered normal declaration. Either
   * half changing — the rule going away, the utility losing its `!` — is a
   * state this test has an answer for.
   *
   * jsdom cannot stand in for the browser here: asked the same question with
   * both rules loaded it answers 16px for the DEFEATED class too, so a
   * `getComputedStyle` assertion in `tests/dom` would have been green through
   * the whole regression. The live number belongs to the capture protocol
   * (`scripts/ts-capture.mjs --measure '[data-pane-legend] > button'`), and
   * the cascade belongs here.
   */
  const globals = fs.readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  const legend = fs.readFileSync(
    path.join(ROOT, "components", "tv", "PaneLegend.tsx"), "utf8");

  const defeats = /:is\(\.tv-workstation,\s*\.ts-app\)[^{]*\bbutton\b[^{]*\{[^}]*font-size:\s*inherit/
    .test(globals);

  // The headline button, and the size utility it carries.
  const headline = /data-pane-legend=\{paneId\}[\s\S]{0,600}?<button[\s\S]{0,400}?className:\s*`([^`]*)`/
    .exec(legend);
  assert.ok(headline, "the pane legend no longer opens with a headline button");
  const size = /(!?)text-\[(\d+)px\]/.exec(headline[1]!);
  assert.ok(size, `the headline carries no explicit size: ${headline[1]}`);
  assert.equal(size[2], "16", "the reference's status line is 16px throughout");
  if (defeats) {
    assert.equal(size[1], "!",
      "globals.css still sets `font-size: inherit` on every workstation button, so the "
      + "headline's 16px must be an important utility or it computes to 14px in the browser");
  }

  /*
   * And the two things beside it: the reference's `· 1h · Binance` is ONE ink
   * (rgb 219) at the same 16px, where this drew the name in ink and the rest
   * in muted — three tokens, two colours, one line (R3b-16).
   */
  assert.doesNotMatch(legend, /text-\[16px\] text-ink-muted/,
    "R3b-16: the dots, the interval and the venue are ink, not muted");
  assert.match(legend, /\[&>button\]:!text-\[16px\]/,
    "the interval is a button too, and the same rule defeats it");
  assert.match(legend, /\[&>button\]:!px-0/,
    "R3b-16: and it carries no padding of its own, so the gaps around the dots are equal");
});

// ── The chart keeps its height budget ──────────────────────────────────────

test("an oscillator pane spends no height on a header row", () => {
  /*
   * Panes are 96–360px. The identity and the hide/settings/remove controls are
   * overlaid on the plot, the way TradingView does it, rather than sitting in a
   * bar that would cost every pane ~20px of the oscillator it exists to show.
   */
  const pane = fs.readFileSync(path.join(ROOT, "components", "tv", "IndicatorPane.tsx"), "utf8");
  // The z-index moved above the collapsed-pane cover; the position, which is
  // what this test is about, is unchanged.
  assert.match(pane, /absolute left-2 top-1 z-\[?\d/, "the pane's legend row is no longer overlaid");
  /*
   * TVP8 R3-12/R3-13: the pane's OWN controls are a second overlaid cluster at
   * its top-right edge, the way the reference has them, and the reveal is
   * scoped to this pane (`group/studypane`) rather than to the whole chart
   * column (`group/pane`, which lit every pane at once).
   */
  /*
   * R3b-21: `right-1`, not `right-2` — the reference's right-most pane box
   * ends 4px before the axis, and ours ended 8px in. The rule this test is
   * about is unchanged: the cluster is OVERLAID at the pane's own top-right
   * edge and costs the oscillator no height.
   */
  /*
   * W2D-11: and that edge is the PLOT's, not the section's. The section's
   * chart spans the price axis too, so `right-1` put collapse and maximize on
   * the scale over its top tick; the cluster now sits 4px left of the axis's
   * measured width.
   */
  assert.match(pane, /style=\{\{ right: axisWidth \+ 4 \}\}\s*className=\{`absolute top-1 z-\[?\d/,
    "the pane actions are no longer overlaid at the plot's own edge");
  assert.match(pane, /priceScale\("right"\)\.width\(\)/, "the axis width is measured, not guessed");
  assert.match(pane, /items-center gap-1 transition-opacity focus-within:opacity-100/,
    "R3b-21: 4px between the boxes, as the reference has");
  assert.match(pane, /group-hover\/studypane:opacity-100/, "the controls are always-on, or gone");
  // Hide / settings / remove act on the STUDY and now live in the legend row —
  // the same row a study overlaid on the price pane gets. The pane still owns
  // the channel they travel down, and still offers remove at its own edge.
  const legend = fs.readFileSync(
    path.join(ROOT, "components", "tv", "IndicatorLegend.tsx"), "utf8");
  for (const action of ["hide", "settings", "remove"]) {
    assert.match(legend, new RegExp(`"${action}"`), `the legend cannot ${action} its indicator`);
  }
  assert.match(pane, /"remove"/, "the pane cannot remove its indicator");
  // Neither cluster reserves a row: both are absolutely positioned over the
  // plot, so a pane still spends zero height on chrome.
  assert.equal((pane.match(/absolute left-2 top-1 z-/g) ?? []).length, 1);
  assert.equal((pane.match(/absolute top-1 z-/g) ?? []).length, 1);
  /*
   * And neither paints a surface. Two `bg-surface/8x` boxes — one behind the
   * legend, one behind the cluster — were the "bordered mini-toolbar" the
   * owner vetoed (R3-10); the reference's legend is type on the plot.
   */
  // Comments stripped: the sentence explaining the defect names the classes it
  // removed, and a rule a comment can turn red is not a rule.
  assert.doesNotMatch(pane.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""),
    /bg-surface\/\d/,
    "a filled box over the oscillator is chrome, not a legend");
});
