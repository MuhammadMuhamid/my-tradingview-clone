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

// ── W2D-03: the legend column is an obstacle too ───────────────────────────

/** The series row and one study row, pinned at the pane's top-left. */
const LEGEND = { left: 8, top: 6, right: 380, bottom: 64 };

test("W2D-03 — a drawing under the legend does not dock the bar on the legend", () => {
  // Too near the top for "above the drawing": the old rule's next stops were
  // below it at its left edge, and the top-left — both on the legend.
  const a = { x: 120, y: 90 }, b = { x: 320, y: 70 };
  const placed = toolbarPlacement([a, b], BAR, PANE, segment(a, b), { avoid: [LEGEND] });
  const box = { ...placed, width: BAR.width, height: BAR.height };
  assert.equal(overlaps(box, LEGEND), false, `the bar ${JSON.stringify(placed)} sits on the legend`);
  assert.ok(clearOf(placed, segment(a, b)), "and it still keeps off the drawing");
});

test("W2D-03 — the bar may dock just under the legend", () => {
  // A vertical line at the pane's right edge rules out every column but the
  // left, and the top is the legend's: under it is the candidate that is left.
  const a = { x: 990, y: 0 }, b = { x: 990, y: 700 };
  const placed = toolbarPlacement([a, b], BAR, PANE, segment(a, b), { avoid: [LEGEND] });
  assert.equal(overlaps({ ...placed, width: BAR.width, height: BAR.height }, LEGEND), false);
});

test("W2D-03 — with nowhere clear, keeping off the legend beats sitting on it", () => {
  const tiny = { width: 440, height: 110 };
  const placed = toolbarPlacement([{ x: 200, y: 80 }], BAR, tiny, undefined, {
    avoid: [{ left: 0, top: 0, right: 440, bottom: 50 }],
  });
  assert.ok(placed.top >= 50, `the bar ${JSON.stringify(placed)} was put back over the legend`);
});

// ── W2A-05: a dragged bar ──────────────────────────────────────────────────

test("W2A-05 — a dragged position is used for a drawing it does not cover", () => {
  const a = { x: 300, y: 500 }, b = { x: 600, y: 420 };
  const at = { left: 500, top: 40 };
  assert.deepEqual(toolbarPlacement([a, b], BAR, PANE, segment(a, b), { preferred: { at } }), at);
});

test("W2A-05 — …and not for one it would cover, unless it was dropped there", () => {
  const a = { x: 400, y: 60 }, b = { x: 800, y: 60 };
  const at = { left: 450, top: 40 };
  const auto = toolbarPlacement([a, b], BAR, PANE, segment(a, b), { preferred: { at } });
  assert.notDeepEqual(auto, at, "a remembered spot was allowed to cover a different drawing");
  assert.ok(clearOf(auto, segment(a, b)));
  assert.deepEqual(
    toolbarPlacement([a, b], BAR, PANE, segment(a, b), { preferred: { at, force: true } }), at,
    "the drawing the bar was dropped beside keeps it where the user put it");
});

test("W2A-05 — a dragged position is kept inside the pane", () => {
  const placed = toolbarPlacement([{ x: 100, y: 600 }], BAR, PANE, undefined,
    { preferred: { at: { left: 5000, top: -50 }, force: true } });
  assert.equal(placed.left, PANE.width - BAR.width - 4);
  assert.equal(placed.top, 4);
});
