/**
 * What survives a 320px toolbar.
 *
 * ── The rule this file exists to keep ──────────────────────────────────────
 *
 * This toolbar's answer to a narrow window is NOT to hide controls. It is one
 * component with two placements: on the primary row from its own width up, and
 * in the ⋯ dropdown below it — one tap away (`TOOLBAR_TIERS`). `ContextActions`,
 * `EditHistory` and `WorkspaceActions` are all built that way, and say so.
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

test("NOTHING IS HIDDEN WITHOUT A SECOND PLACEMENT", () => {
  /*
   * Every control that disappears from the row at some width is rendered again,
   * inside the ⋯ dropdown, with the mirrored class. The tiers are read as
   * PAIRS from the one table both copies use, so a control added tomorrow is
   * held to the same rule — and no row copy may hide itself with a literal
   * that has no mirror.
   */
  assert.doesNotMatch(code, /className="hidden (sm|md|lg|xl):flex"/,
    "a row control hidden by a bare literal has no second home; use its tier");
  const density = fs.readFileSync(path.join(__dirname, "..", "components", "tv", "toolbarDensity.ts"), "utf8");
  const pairs = [...density.matchAll(/(\w+): \{ row: "hidden ([^"]+):flex", menu: "flex ([^"]+):hidden" \}/g)];
  assert.ok(pairs.length >= 10, `found only ${pairs.length} tiers — this rule has stopped reading`);
  for (const [, id, rowAt, menuAt] of pairs) {
    assert.equal(rowAt, menuAt, `${id}: its two copies switch at different widths`);
  }
});

test("COMPARE HAS BOTH HOMES, AND ONE IMPLEMENTATION BEHIND THEM", () => {
  assert.match(code, /<CompareButton \{\.\.\.props\} className=\{tier\("compare", "row"\)\}/,
    "beside the symbol, where the reference puts it");
  assert.match(code, /className=\{tier\("compare", "menu"\)\}>\s*<CompareButton \{\.\.\.props\}/,
    "and in the ⋯ dropdown, which is where a narrow row's overflow lives");

  // One button in the source, or the two placements drift.
  assert.equal((code.match(/aria-label="Compare with another instrument"/g) ?? []).length, 1,
    "two copies of a control is two things to keep in step");
  assert.equal((code.match(/ctl\("compare"\)/g) ?? []).length, 1);

  // Icon-only in both places (TVP8: the reference's bar has no text labels);
  // the caller decides the placement class and the button does not guess
  // from a breakpoint.
  assert.match(code, /className=\{`\$\{TOOL_ICON_BUTTON\} \$\{props\.className\}`\}/);
});

test("the ⋯ dropdown is where every overflowing control goes, and it cannot clip their menus", () => {
  /*
   * A13: overflowed controls used to land in a second 38px row. They land in a
   * dropdown now — but the reason that row was not a popover still holds for
   * the menus the dropdown's rows open: a scrolling popover clips a menu that
   * opens inside it. So the panel takes no `overflow` of its own.
   */
  assert.match(code, /id="chart-toolbar-overflow"/);
  assert.match(code, /aria-controls="chart-toolbar-overflow"/);
  const panel = source.slice(source.indexOf('id="chart-toolbar-overflow"'));
  const tag = panel.slice(0, panel.indexOf("\n              >"));
  assert.doesNotMatch(tag, /overflow-(auto|hidden|y-auto|scroll)/, "the dropdown must not clip the menus its rows open");
  assert.match(code, /<ContextActions \{\.\.\.props\} placement="menu"/);
  // And the strip it used to open is still there, by name.
  assert.match(code, /id="chart-toolbar-more"/);
  assert.match(code, /aria-controls="chart-toolbar-more"/);
});
