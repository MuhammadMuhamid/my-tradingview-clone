/**
 * Every refusal at a series seam must DRAW the bars, not lose them.
 *
 * ── Why this is a source test ─────────────────────────────────────────────
 *
 * `tests/dom/studyWindowZoom.test.tsx` drives the seam FUNCTIONS against real
 * lightweight-charts series, and that is the right test for what they do. It
 * cannot say anything about what their CALLERS pass, because the callers live
 * inside `CandleChart`'s effects and nothing renders them with a backwards row.
 *
 * A read-only reviewer proved that gap by turning all three repaint thunks
 * into `() => {}` and watching all 1,228 tests stay green — structurally the
 * same defect as the one before it, where the regression test re-implemented
 * the seam instead of calling it. A guard is only pinned by something that
 * fails when it is removed, and for a caller-supplied argument that something
 * has to read the call site.
 *
 * So this reads them. The rule, stated once:
 *
 *   A writer that can refuse a row must be handed a repaint argument that
 *   really calls the replacing writer — and the live-tick volume write is the
 *   one documented exception, because a frame behind the drawn bar has nothing
 *   to say that the next frame will not (`lib/liveDataset`).
 *
 * ── What this cannot prove, stated so nobody reads more into it ────────────
 *
 * That the repaint draws THE SAME CONTENT the refused row belonged to. That is
 * not decidable from source text: a repaint can call the right writer with a
 * shortened list, or behind a condition that is never true, and this file will
 * pass it. A second reviewer demonstrated both. What it does catch is the
 * whole class that actually happened — an argument emptied, dropped, hidden
 * behind `?.()`, moved to another module, or a new call site added without one
 * — and it catches an `[]` repaint, which is worse than the bug it replaces
 * because it blanks the series.
 *
 * The behavioural half lives in `tests/dom/studyWindowZoom.test.tsx`, which
 * drives the writers themselves against real lightweight-charts series.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/**
 * Comments are removed first, and that is not cosmetic: a reviewer defeated
 * the first version of this file by commenting a guard out and writing
 * `if (true)` under it, and by hiding `setMainSeriesData(` inside a `/* … *\/`
 * so the substring check found a name that no longer ran.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const CHART = stripComments(readFileSync(join(ROOT, "components/CandleChart.tsx"), "utf8"));

/**
 * The argument list of every call to `name(`, split at top-level commas.
 *
 * A real parse rather than a regex: these arguments contain nested calls,
 * ternaries, object literals and arrow functions, and a regex that matched
 * them would either miss a call site or match half of one — and a source test
 * that silently matches nothing is worse than no test.
 */
function callArguments(source: string, name: string): string[][] {
  const calls: string[][] = [];
  const needle = `${name}(`;
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    // `foo(` inside `updateFoo(` or `.foo(` is a different function, and the
    // declaration of `foo` is not a call to it.
    const before = source[at - 1];
    if (before && /[A-Za-z0-9_$.]/.test(before)) continue;
    if (/\bfunction\s+$/.test(source.slice(Math.max(0, at - 20), at))) continue;
    let depth = 0;
    let start = at + needle.length;
    const args: string[] = [];
    let i = start;
    for (; i < source.length; i++) {
      const c = source[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (c === ")" && depth === 0) { args.push(source.slice(start, i)); break; }
        depth--;
      } else if (c === "," && depth === 0) {
        args.push(source.slice(start, i));
        start = i + 1;
      }
    }
    calls.push(args.map((a) => a.trim()).filter((a) => a.length > 0));
  }
  return calls;
}

/**
 * Whether an argument is a repaint that will actually redraw something.
 *
 * An identifier is followed to its declaration in the same file, because
 * hoisting a thunk to a `const` is an ordinary refactor and a test that forbids
 * it is a test somebody deletes.
 */
function isRealRepaint(arg: string | undefined, writer: string, source: string): boolean {
  if (arg === undefined) return false;
  let body = arg;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(arg.trim())) {
    const declared = new RegExp(`\\bconst\\s+${arg.trim()}\\s*=([\\s\\S]{0,600}?);\\n`).exec(source);
    if (!declared) return false;
    body = declared[1]!;
  }
  if (!body.includes("=>") || !body.includes(`${writer}(`)) return false;
  // An empty thunk, or one whose only statement is unreachable.
  if (/=>\s*\{\s*\}\s*$/.test(body)) return false;
  // `setData([])` satisfies every name check and blanks the series — worse
  // than the silent drop this whole rule exists to replace.
  for (const call of callArguments(body, writer)) {
    if (call.some((a) => a === "[]")) return false;
  }
  return true;
}

test("EVERY MAIN-SERIES WRITE THAT CAN REFUSE IS GIVEN THE REPAINT FOR ITS OWN CONTENT", () => {
  const calls = callArguments(CHART, "updateMainSeries");
  assert.ok(calls.length >= 4,
    `expected at least 4 updateMainSeries call sites, parsed ${calls.length} — the parser is broken`);

  for (const [i, args] of calls.entries()) {
    assert.equal(args.length, 5,
      `updateMainSeries call ${i + 1} passes ${args.length} arguments: a writer that can refuse a row `
      + "must be handed the replacement for the content that row belonged to, or the refusal is a "
      + "silent drop and `displayRef`/`candlesRef` go on claiming a bar the series never got");
    assert.ok(isRealRepaint(args[4], "setMainSeriesData", CHART),
      `updateMainSeries call ${i + 1} was given "${args[4]}" as its repaint. It must actually call `
      + "`setMainSeriesData`; an empty thunk satisfies the signature and loses the bar");
  }
});

test("THE VOLUME HISTOGRAM REPAINTS IN THE DATA EFFECT AND DROPS ON THE LIVE PATH", () => {
  const calls = callArguments(CHART, "updateVolumeSeries");
  assert.ok(calls.length >= 2,
    `expected at least 2 updateVolumeSeries call sites, parsed ${calls.length} — the parser is broken`);

  const withRepaint = calls.filter((args) => args.length === 4);
  const without = calls.filter((args) => args.length === 3);
  assert.equal(withRepaint.length + without.length, calls.length,
    "an updateVolumeSeries call takes either 3 arguments (a documented drop) or 4 (a repaint)");
  assert.equal(withRepaint.length, 1,
    "exactly one volume write repaints — the data effect's, whose window can move backwards, and "
    + "where a dropped bar is a histogram that disagrees with the candles above it");
  for (const args of withRepaint) {
    assert.ok(isRealRepaint(args[3], "setVolumeData", CHART),
      `a volume repaint was given "${args[3]}"; it must actually call \`setVolumeData\``);
  }
  assert.equal(without.length, 1,
    "exactly one volume write drops — the live tick's. Giving it a repaint would silently invert "
    + "the policy this test exists to state, and `<= 1` could not tell the difference");
});

test("THE LIVE VOLUME WRITE IS STILL SKIPPED WHERE THE HISTOGRAM IS DELIBERATELY EMPTY", () => {
  /*
   * Kagi, Point & Figure and Line Break are not drawn on a time axis, so the
   * data effect clears volume under them. The tick handler used to write one
   * stray bar back into that empty histogram; it knew only about Renko.
   *
   * Found by a reviewer, and unpinned by anything until now: removing either
   * condition left all 1,228 tests green.
   */
  const guard = CHART.slice(CHART.indexOf("const applyTick = (tick"));
  const at = guard.indexOf("updateVolumeSeries(");
  assert.ok(at > 0, "the live-tick volume write moved; this test no longer reads it");
  const condition = guard.slice(Math.max(0, at - 400), at);
  assert.match(condition, /transform !== "renko"/,
    "a Renko brick is not a time bar, so no honest volume can be drawn under it");
  assert.match(condition, /volumeDrawnRef\.current/,
    "under Kagi, Point & Figure and Line Break the data effect empties the histogram; without this "
    + "condition the tick handler puts one stray bar back into a chart that is showing none");
});
