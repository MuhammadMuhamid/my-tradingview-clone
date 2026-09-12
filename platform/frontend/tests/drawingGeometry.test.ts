import { test } from "node:test";
import assert from "node:assert/strict";
import { fibonacciLevels, gannSquareGeometry, patternLabels, pitchforkGeometry, regression, timeProjection } from "../lib/drawingGeometry";

test("pitchfork variants derive distinct origins and four editable rays", () => {
  const points = [{ x: 10, y: 90 }, { x: 100, y: 40 }, { x: 100, y: 140 }];
  const standard = pitchforkGeometry(points, "standard");
  const schiff = pitchforkGeometry(points, "schiff");
  assert.equal(standard.segments.length, 4);
  assert.notDeepEqual(standard.segments[1], schiff.segments[1]);
});

test("fib levels and gann square are deterministic", () => {
  assert.deepEqual(fibonacciLevels(100, 200, [0, 0.5, 1]), [100, 150, 200]);
  const grid = gannSquareGeometry({ x: 0, y: 0 }, { x: 80, y: 40 });
  assert.ok(grid.segments.length >= 18, "square includes perimeter and 1/8 grid");
});

test("regression returns fitted centerline and non-zero deviation", () => {
  const fit = regression([{ x: 0, y: 0 }, { x: 10, y: 10 }], [
    { x: 0, y: 2 }, { x: 5, y: 7 }, { x: 10, y: 12 },
  ]);
  assert.ok(fit);
  assert.ok(Math.abs(fit!.center.a.y - 2) < 0.01);
  assert.ok(fit!.deviation > 0);
});

test("time projections use a stable interval and pattern labels are tool-specific", () => {
  const projection = timeProjection("cyclicLines", [{ x: 10, y: 50 }, { x: 30, y: 50 }], 200);
  assert.deepEqual(projection.verticals.slice(0, 3), [10, 30, 50]);
  assert.deepEqual(patternLabels("headAndShoulders"), ["L", "Head", "R", "Neck", "Break"]);
});
