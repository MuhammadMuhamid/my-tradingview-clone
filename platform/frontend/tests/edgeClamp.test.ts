/**
 * Menus that stay inside the window.
 *
 * TVP8 round two, measured on the production build at 390×844 — the campaign's
 * own phone viewport. The chart-type trigger sits at x=208 and its menu is a
 * fixed 264px anchored `left-0`, so the menu ran from 208 to 472 in a 390px
 * window: 82px of every row off the right edge, with no horizontal scroll to
 * reach it. "Session volume profi…", "Time Price Opportun…" and "Volume
 * footprint" were cut mid-word.
 *
 * The arithmetic is here because it is the part with edge cases, and because a
 * hook that only works in a browser is a hook nothing can check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EDGE_GUTTER, clampOffset } from "../lib/useEdgeClamp";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.tsx$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test("A MENU INSIDE THE WINDOW IS NOT MOVED", () => {
  // The overwhelmingly common case, and it must produce no transform at all.
  assert.equal(clampOffset({ left: 100, right: 364 }, 1440), 0);
  assert.equal(clampOffset({ left: EDGE_GUTTER, right: 200 }, 1440), 0);
  assert.equal(clampOffset({ left: 100, right: 1440 - EDGE_GUTTER }, 1440), 0);
});

test("THE MEASURED DEFECT: 264px AT x=208 IN A 390px WINDOW", () => {
  const offset = clampOffset({ left: 208, right: 472 }, 390);
  assert.equal(offset, -90, "it must come back by exactly the overflow");
  assert.equal(472 + offset, 390 - EDGE_GUTTER, "landing its right edge on the gutter");
  assert.equal(208 + offset, 118, "and its left edge still well inside the window");
});

test("A MENU WIDER THAN THE WINDOW IS NOT MADE WORSE", () => {
  /*
   * The case a naive `right = viewportWidth - gutter` gets wrong. A 500px menu
   * in a 390px window cannot fit; pulling its right edge in would drag its
   * left edge off screen, so the FIRST characters of every row are lost
   * instead of the last — strictly worse, because a truncated label is still
   * recognisable from its start.
   */
  const offset = clampOffset({ left: 20, right: 520 }, 390);
  assert.equal(20 + offset, EDGE_GUTTER, "it comes to the gutter and stops");
  assert.ok(20 + offset >= EDGE_GUTTER, "and never past it");
});

test("A MENU OFF THE LEFT EDGE COMES BACK, BY THE SAME RULE", () => {
  // `right-0` anchoring near the left of a toolbar is the mirror image, and a
  // shared hook has to answer both or it is half a fix.
  assert.equal(clampOffset({ left: -40, right: 200 }, 1440), EDGE_GUTTER + 40);
  // Unless coming back would push the other edge out, which is the same
  // too-wide case from the other side.
  const tight = clampOffset({ left: -40, right: 388 }, 390);
  assert.equal(tight, 0, "a menu that overflows BOTH edges is left where it is");
});

test("EVERY ANCHORED MENU IN THE PRODUCT IS CLAMPED", () => {
  /*
   * The class, not the two that were found. A menu positioned against its
   * trigger is only inside the window while the trigger is, and whether that
   * holds depends on where the trigger happens to sit — which no media query
   * knows and no reviewer will re-check.
   */
  const offenders: string[] = [];
  let anchored = 0;
  for (const file of ["app", "components"].flatMap((d) => walk(d))) {
    const src = read(file);
    // An absolutely positioned popover hung off its trigger's edge.
    for (const m of src.matchAll(/className="absolute (?:left-0|right-0) top-full[^"]*"/g)) {
      anchored++;
      // The `style={…Clamp}` must be on the same element, which for this
      // codebase's formatting means within the few lines above the class.
      const at = m.index ?? 0;
      const around = src.slice(Math.max(0, at - 700), at + m[0].length);
      if (!/style=\{edgeClamp\}/.test(around)) {
        offenders.push(`${file}: ${m[0].slice(0, 80)}`);
      }
    }
  }
  assert.ok(anchored >= 2,
    `found only ${anchored} anchored menus — this rule has stopped reading the product`);
  assert.deepEqual(offenders, [],
    "these hang off their trigger and will leave the window on a narrow one — "
    + "use useEdgeClamp:\n  " + offenders.join("\n  "));
});

test("the correction is applied before paint, not after it", () => {
  /*
   * A menu measured in `useEffect` is corrected one frame late, and the user
   * sees it appear in the wrong place and jump. `useLayoutEffect` is the
   * difference between a fix and a flicker.
   */
  const hook = read("lib/useEdgeClamp.ts");
  assert.match(hook, /useLayoutEffect\(\(\) => \{/);
  assert.doesNotMatch(hook, /\buseEffect\(/);

  // And it re-measures with its own correction removed, so a window that grows
  // lets the menu come back rather than compounding last time's offset.
  assert.match(hook, /el\.style\.transform = "";\s*const rect = el\.getBoundingClientRect\(\);/);
  assert.match(hook, /window\.addEventListener\("resize", measure\)/);
  assert.match(hook, /window\.removeEventListener\("resize", measure\)/);
});
