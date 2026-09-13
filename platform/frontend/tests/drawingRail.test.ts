/**
 * The drawing rail's taxonomy, as an assertion.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * TVP7 regrouped the rail from eleven ad-hoc groups into the reference's seven
 * families plus one Trading Scene group, and generalised the DOM harness's
 * `selectTool` so it opens whichever flyout holds a tool instead of assuming
 * every tool is the head of some group. That generalisation was necessary —
 * the old helper encoded the old taxonomy — but it also removed the only thing
 * in the suite that could notice a tool going missing from the rail, because
 * a tool that is in NO group simply makes `selectTool` throw in whichever test
 * happens to use it, and most of the 87 are used by none.
 *
 * So the taxonomy is pinned here directly, against the tool union itself:
 * every declared tool is reachable, exactly once, from a named group. A tool
 * added to `drawings.ts` without a rail entry fails this file rather than
 * shipping as dead code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TOOL_POINTS, type DrawingTool } from "../lib/drawings";

const RAIL = path.join(__dirname, "..", "components", "tv", "DrawingToolbar.tsx");
const source = fs.readFileSync(RAIL, "utf8");

/**
 * `{ tool: "trend", icon: "trend", label: "Trend line" }`, per group.
 *
 * Matched on `tool:` rather than on `{ tool:` because a long label wraps the
 * entry onto three lines — `vprange` does — and a parser that only saw the
 * one-line form would report a perfectly reachable tool as missing.
 */
function railGroups(): { id: string; tools: string[]; icons: string[] }[] {
  const start = source.indexOf("const GROUPS");
  const end = source.indexOf("\n];", start);
  assert.ok(start > 0 && end > start, "the rail no longer declares GROUPS");
  const block = source.slice(start, end);
  const groups: { id: string; tools: string[]; icons: string[] }[] = [];
  for (const chunk of block.split(/\n {2}\{/).slice(1)) {
    const id = /id: "([^"]+)"/.exec(chunk)?.[1];
    if (!id) continue;
    groups.push({
      id,
      tools: [...chunk.matchAll(/\btool: "([^"]+)"/g)].map((m) => m[1]!),
      icons: [...chunk.matchAll(/icon: "([^"]+)"/g)].map((m) => m[1]!),
    });
  }
  return groups;
}

test("every declared drawing tool is reachable from exactly one rail group", () => {
  const groups = railGroups();
  const railed = groups.flatMap((g) => g.tools);
  const declared = Object.keys(TOOL_POINTS) as DrawingTool[];

  const missing = declared.filter((t) => !railed.includes(t));
  assert.deepEqual(missing, [],
    `declared but unreachable from the rail: ${missing.join(", ")}`);

  const unknown = railed.filter((t) => !declared.includes(t as DrawingTool));
  assert.deepEqual(unknown, [],
    `on the rail but not a declared tool: ${unknown.join(", ")}`);

  const seen = new Map<string, number>();
  for (const t of railed) seen.set(t, (seen.get(t) ?? 0) + 1);
  const duplicated = [...seen].filter(([, n]) => n > 1).map(([t]) => t);
  assert.deepEqual(duplicated, [],
    `a tool in two groups has two homes and one of them is wrong: ${duplicated.join(", ")}`);
});

test("the rail's groups are the reference's families", () => {
  /*
   * These ids are TradingView's own, read off its live rail. They are asserted
   * because rail muscle memory is entirely group-POSITION based: a user
   * reaching for XABCD expects the patterns group to be fourth, and a rename
   * or a reorder here is a user-visible change that should be deliberate.
   *
   * `anchored` is Trading Scene's own and comes last: Anchored VWAP and the
   * two volume profiles compute a series from a point rather than describing a
   * shape, and the reference files its equivalents somewhere else entirely, so
   * there is no position to borrow.
   */
  assert.deepEqual(railGroups().map((g) => g.id), [
    "cursors",
    "trend-line",
    "gann-and-fibonacci",
    "patterns",
    "prediction-and-measurement",
    "geometric-shapes",
    "annotation",
    "anchored",
  ]);
});

test("no group is deeper than a flyout can show without scrolling to reach", () => {
  /*
   * The `advanced` group this replaced held 38 tools. At the measured 40px row
   * height that is 1520px of flyout in a 900px window, and the flyout had no
   * height cap — so roughly its bottom sixteen tools rendered below the fold
   * with nothing to scroll. They were not hard to find; they could not be
   * clicked.
   *
   * The flyout now caps its height and scrolls, so depth is survivable. This
   * still holds the groups to a size a human can scan, which is the actual
   * point of having groups.
   */
  for (const group of railGroups()) {
    assert.ok(group.tools.length <= 20,
      `${group.id} holds ${group.tools.length} tools — split it the way the reference does`);
  }
});

test("every rail icon key exists, so no tool silently wears another tool's glyph", () => {
  /*
   * `barsPattern` asked for `icon: "bars"`, which `ICONS` never had. `Icon`
   * falls back to the trend-line glyph, so Bars Pattern shipped wearing
   * another tool's picture with nothing anywhere reporting the mismatch.
   */
  const icons = new Set(
    [...source.slice(source.indexOf("const ICONS"), source.indexOf("const GROUPS"))
      .matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]!)
  );
  assert.ok(icons.size > 40, `parsed only ${icons.size} icons — the ICONS shape changed`);
  for (const group of railGroups()) {
    for (const key of group.icons) {
      assert.ok(icons.has(key), `${group.id} references a missing icon key: ${key}`);
    }
  }
});

test("RAIL — every icon-only control has a NAME, not only a tooltip", () => {
  /*
   * These buttons hold a 28px SVG and no text, so their accessible name fell
   * through to `title` — the last resort in the name algorithm, and the only
   * control family in this product that relied on it. `aria-pressed` was
   * already here (an earlier wave added it, with a comment about exactly this
   * class of invisibility) which made the gap easy to miss: the rail ANNOUNCED
   * ITS STATE while having no name to attach that state to.
   *
   * Found by driving the production build and failing to address a tool by its
   * accessible name.
   */
  const src = source;
  const buttons = [...src.matchAll(/<button[\s\S]*?>/g)].map((m) => m[0]);
  const iconOnly = buttons.filter((b) => !/aria-label/.test(b) && /title=/.test(b));
  assert.deepEqual(iconOnly, [],
    "an icon-only rail button must carry aria-label, not only title:\n"
    + iconOnly.map((b) => b.replace(/\s+/g, " ").slice(0, 90)).join("\n"));

  // And the icon itself is decoration, so it never competes for the name.
  assert.match(src, /const Icon = [\s\S]{0,320}aria-hidden="true"/);
});
