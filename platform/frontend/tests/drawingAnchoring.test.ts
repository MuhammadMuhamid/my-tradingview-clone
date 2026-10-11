/**
 * B-21: where a drawing is, and what it is written in.
 *
 *   - anchors are TIMESTAMPS, and the chart's own time scale says where a
 *     timestamp is — not the bar's index in `candles` (`lib/drawingTimeMap`);
 *   - a level's price, and `Price labels`, are tags ON the price axis, not
 *     boxes inside the plot (`lib/drawingAxisLabels`);
 *   - drawing text is in the product's face, not a code face.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { timeMap } from "../lib/drawingTimeMap";
import { drawingAxisTags } from "../lib/drawingAxisLabels";
import type { Drawing } from "../lib/drawings";

const DAY = 86_400;
const T0 = 1_760_000_000 - (1_760_000_000 % DAY);
const days = Array.from({ length: 10 }, (_, i) => T0 + i * DAY);

test("B-21 — with nothing else on the time scale, the mapping is the bar index it always was", () => {
  const map = timeMap(days, DAY);
  assert.equal(map.timeToLogical(days[4]!), 4);
  assert.equal(map.timeToLogical(days[4]! + DAY / 4), 4.25, "between bars, by time");
  assert.equal(map.timeToLogical(days[9]! + 2 * DAY), 11, "past the end, by the interval");
  assert.equal(map.logicalToTime(4), days[4]);
  assert.equal(map.logicalToTime(-1), days[0]! - DAY);
});

test("B-21 — the chart's own logical index wins over the candle's index", () => {
  /*
   * The defect: the time scale also held 37 points of another series before
   * the candles (an overlay still on the previous interval's grid), so the
   * candle at index 5 is logical 42 on the chart. Mapped by index, a drawing
   * there was drawn 37 bars to the left — at the far-left edge, on 1d.
   */
  const map = timeMap(days, DAY, (barTime) => days.indexOf(barTime) + 37);
  assert.equal(map.timeToLogical(days[5]!), 42);
  assert.equal(map.timeToLogical(days[9]! + DAY / 2), 46.5);
  assert.equal(map.logicalToTime(42), days[5], "and back: the inverse uses the same answer");
  assert.equal(map.logicalToTime(42.5), days[5]! + DAY / 2);
});

test("B-21 — a 15m anchor on a 1d chart lands inside its day, not at the edge", () => {
  const fifteen = days[7]! + 5 * 3600; // 05:00 on the eighth day
  const map = timeMap(days, DAY, (barTime) => days.indexOf(barTime) + 120);
  const logical = map.timeToLogical(fifteen);
  assert.ok(logical > 127 && logical < 128, `${logical}`);
});

test("B-21 — a bar the chart cannot place falls back to its index, so nothing jumps to 0", () => {
  const map = timeMap(days, DAY, () => null);
  assert.equal(map.timeToLogical(days[3]!), 3);
  assert.equal(map.barIndexAt(days[3]! + 10), 3);
  assert.equal(map.barIndexAt(days[0]! - 10), -1);
});

const drawing = (tool: Drawing["tool"], style: Partial<Drawing["style"]>, prices: number[]): Drawing => ({
  id: `${tool}-${prices.join("-")}`, tool,
  points: prices.map((price, i) => ({ time: days[i]!, price })),
  style: { color: "#7e57c2", width: 1, ...style },
} as Drawing);

test("B-21 — a level is tagged on the axis; `Price labels` tag each distinct anchor", () => {
  assert.deepEqual(drawingAxisTags([drawing("hline", {}, [109.83])], "15m"),
    [{ price: 109.83, color: "#7e57c2" }]);
  assert.deepEqual(drawingAxisTags([drawing("trend", {}, [110.26, 110.04])], "15m"), [],
    "a trend line with the setting off carries no tags");
  assert.deepEqual(
    drawingAxisTags([drawing("trend", { priceLabels: true }, [110.26, 110.04])], "15m").map((t) => t.price),
    [110.26, 110.04]);
  assert.equal(drawingAxisTags([drawing("trend", { priceLabels: true }, [150, 150])], "15m").length, 1,
    "a flat line's two anchors share one tag");
  assert.deepEqual(drawingAxisTags([drawing("hline", {}, [1])], "15m", true), [], "Hide all drawings hides them");
  assert.deepEqual(drawingAxisTags([{ ...drawing("hline", {}, [1]), hidden: true }], "15m"), []);
});

test("B-21 — the canvas no longer paints price boxes inside the plot, and sets no code face", () => {
  const canvas = readFileSync(path.join(__dirname, "..", "components", "tv", "DrawingCanvas.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(canvas, /label\(fmtPrice\(d\.points\[\d\]!\.price\), w - 62/,
    "a level's price painted 62px inside the pane is the box this replaces");
  assert.doesNotMatch(canvas, /monospace/, "drawing text is prose; the code face is for code");
  assert.match(canvas, /new DrawingAxisLabelsPrimitive\(\)/);
});

test("W2D-02 — a position between two bars is painted between them, never at the library's 0", async () => {
  const { coordinateAtLogical } = await import("../lib/drawingTimeMap");
  // lightweight-charts 4.2: a non-integer index answers 0.
  const library = (l: number): number => (Number.isInteger(l) ? 100 + l * 10 : 0);
  assert.equal(coordinateAtLogical(library, 4), 140);
  assert.equal(coordinateAtLogical(library, 4.25), 142.5);
  assert.equal(coordinateAtLogical(library, -1.5), 85, "before the data, still by the interval");
  assert.equal(coordinateAtLogical(() => null, 4.25), null);
  assert.equal(coordinateAtLogical(library, Number.NaN), null);
  // A 15m anchor on 1d lands inside its day — and its pixel is inside the day too.
  const map = timeMap(days, DAY);
  const x = coordinateAtLogical(library, map.timeToLogical(days[6]! + 17.75 * 3600));
  assert.ok(x !== null && x > 160 && x < 170, `x=${x}`);
});

test("W2D-02 — both drawing layers ask the library for whole bars only", () => {
  for (const file of ["components/tv/DrawingCanvas.tsx", "components/tv/PineDrawingLayer.tsx"]) {
    const src = readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.match(src, /coordinateAtLogical\(/, file);
    assert.doesNotMatch(src, /logicalToCoordinate\(timeToLogical\(/, file);
  }
});
