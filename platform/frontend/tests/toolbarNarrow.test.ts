/**
 * What survives a 320px toolbar.
 *
 * ── The rule this file exists to keep ──────────────────────────────────────
 *
 * This toolbar's answer to a narrow window is NOT to hide controls. It is one
 * component with two placements: on the primary row above `sm`, and in the
 * `More` strip below — one tap away, and where the workspace actions already
 * live at that width. `ContextActions` and `WorkspaceActions` are both built
 * that way, and both say so.
 *
 * `Compare` was not. It carried `hidden sm:flex` and had no second placement,
 * no keyboard binding and no palette row — and the palette's own trigger is
 * hidden below `sm` too. On a 390px phone, comparing one instrument against
 * another was not hard to reach; it was absent.
 *
 * Showing it at every width was tried first, and measured: at 320px it pushed
 * `More` 41px past the right edge, which is the same clipping `ContextActions`
 * records at 8.7px. The row was already exactly full. So the rule below is not
 * "show everything" — it is "hide nothing without a second home".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(__dirname, "..", "components", "tv", "ChartToolbar.tsx");
const source = fs.readFileSync(FILE, "utf8");
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("NOTHING IS HIDDEN BELOW `sm` WITHOUT A SECOND PLACEMENT", () => {
  /*
   * Every cluster that disappears below `sm` must be rendered again with the
   * mirrored class. Read as PAIRS rather than as a list of allowed names, so a
   * control added tomorrow is held to the same rule.
   */
  const hides = [...code.matchAll(/<(\w+)[^>]*className="hidden sm:flex"/g)].map((m) => m[1]!);
  const shows = new Set(
    [...code.matchAll(/<(\w+)[^>]*className="flex sm:hidden"/g)].map((m) => m[1]!));

  assert.ok(hides.length >= 2,
    `found only ${hides.length} controls hidden below sm — this rule has stopped reading`);

  const orphans = hides.filter((name) => !shows.has(name));
  assert.deepEqual(orphans, [],
    "these vanish below 640px with nowhere else to be reached from:\n  "
    + orphans.join("\n  "));
});

test("COMPARE HAS BOTH HOMES, AND ONE IMPLEMENTATION BEHIND THEM", () => {
  assert.match(code, /<CompareButton \{\.\.\.props\} className="hidden sm:flex"/,
    "beside the symbol, where the reference puts it");
  assert.match(code, /<CompareButton \{\.\.\.props\} className="flex sm:hidden"/,
    "and in the More strip, which is where a 320px row's overflow lives");

  // One button in the source, or the two placements drift.
  assert.equal((code.match(/aria-label="Compare with another instrument"/g) ?? []).length, 1,
    "two copies of a control is two things to keep in step");
  assert.equal((code.match(/ctl\("compare"\)/g) ?? []).length, 1);

  /*
   * Icon-only beside the symbol, labelled in the More strip — the same
   * asymmetry Indicators and Replay already have. `labelClass` carries it,
   * so the caller decides and the button does not guess from a breakpoint.
   */
  assert.match(code,
    /className=\{`\$\{props\.labelClass \? TOOL_BUTTON : TOOL_ICON_BUTTON\} \$\{props\.className\}`\}/);
  assert.match(code, /\{props\.labelClass && <span className=\{props\.labelClass\}>Compare<\/span>\}/);
});

test("the More strip is where every overflowing control goes", () => {
  // Pinned because the alternative — a popover — was tried and clips the
  // overlay menu that opens downward inside it. The comment says so; this
  // stops the comment from being the only thing that does.
  assert.match(code, /id="chart-toolbar-more"/);
  assert.match(code, /aria-controls="chart-toolbar-more"/);
  assert.match(code, /<ContextActions \{\.\.\.props\} className="flex sm:hidden"/);
  assert.match(code, /<CompareButton \{\.\.\.props\} className="flex sm:hidden"/);
});
