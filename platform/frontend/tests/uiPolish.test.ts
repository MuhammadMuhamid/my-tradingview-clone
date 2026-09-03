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
  assert.match(pane, /absolute left-2 top-1 z-\[?\d/, "the pane's control row is no longer overlaid");
  assert.match(pane, /group-hover\/pane:opacity-100/, "the controls are always-on, or gone");
  for (const action of ["hide", "settings", "remove"]) {
    assert.match(pane, new RegExp(`"${action}"`), `the pane cannot ${action} its indicator`);
  }
  // The collapse, move and maximise controls added later share that same
  // overlaid row rather than earning one of their own.
  assert.equal((pane.match(/absolute left-2 top-1 z-/g) ?? []).length, 1);
});
