/**
 * A11: the selected drawing's toolbar is placed where it touches nothing the
 * drawing draws (`lib/drawingToolbarPlacement`). The DOM version of this is
 * `tests/dom/drawingStyleBar.test.tsx`; these are the cases a single gesture
 * there cannot reach.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { overlaps, toolbarPlacement, type Point } from "../lib/drawingToolbarPlacement";

const PANE = { width: 1000, height: 700 };
const BAR = { width: 420, height: 38 };

/** Distance from `p` to the segment a→b. */
function segment(a: Point, b: Point): (p: Point) => number {
  return (p) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
}

function clearOf(placed: { left: number; top: number }, distance: (p: Point) => number): boolean {
  for (let y = placed.top; y <= placed.top + BAR.height; y += 2) {
    for (let x = placed.left; x <= placed.left + BAR.width; x += 2) {
      if (distance({ x, y }) < 6) return false;
    }
  }
  return true;
}

test("A11 — the measured defect: a rising line no longer runs under the bar", () => {
  // The old rule: 44px above the first anchor, left-aligned on it.
  const a = { x: 300, y: 560 }, b = { x: 600, y: 420 };
  const old = { left: a.x, top: a.y - 44 };
  assert.equal(clearOf(old, segment(a, b)), false, "the old placement did cover the line");
  const placed = toolbarPlacement([a, b], BAR, PANE, segment(a, b));
  assert.ok(clearOf(placed, segment(a, b)), JSON.stringify(placed));
  assert.ok(placed.top + BAR.height <= 420 - 8, "above the drawing, which is the preferred side");
});

test("A11 — no room above: it goes below", () => {
  const a = { x: 200, y: 20 }, b = { x: 500, y: 60 };
  const placed = toolbarPlacement([a, b], BAR, PANE, segment(a, b));
  assert.ok(placed.top >= 60 + 8, JSON.stringify(placed));
  assert.ok(clearOf(placed, segment(a, b)));
});

test("A11 — a full-height vertical line: the bar steps aside rather than over it", () => {
  const x = 500;
  const distance = (p: Point): number => Math.abs(p.x - x);
  const placed = toolbarPlacement([{ x, y: 300 }], BAR, PANE, distance);
  assert.ok(clearOf(placed, distance), JSON.stringify(placed));
});

test("A11 — a line the anchor box underestimates (a ray to the right edge) is still avoided", () => {
  const a = { x: 100, y: 400 }, b = { x: 200, y: 380 };
  const edge = { x: PANE.width, y: 380 - (PANE.width - 200) * 0.2 };
  const ray = segment(a, edge);
  const placed = toolbarPlacement([a, b], BAR, PANE, ray);
  assert.ok(clearOf(placed, ray), JSON.stringify(placed));
});

test("A11 — always inside the pane", () => {
  const placed = toolbarPlacement([{ x: 990, y: 690 }], BAR, PANE);
  assert.ok(placed.left >= 4 && placed.left + BAR.width <= PANE.width - 4 + 0.01);
  assert.ok(placed.top >= 4 && placed.top + BAR.height <= PANE.height - 4 + 0.01);
  assert.equal(overlaps({ ...placed, ...BAR }, { left: 982, top: 682, right: 998, bottom: 698 }), false);
});
