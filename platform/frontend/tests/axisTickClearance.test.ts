import { test } from "node:test";
import assert from "node:assert/strict";
import {
  axisColumns, classifyRows, groundFor, parseColour, truncatedTickRuns, type Rgb, type Rgba,
} from "../lib/axisTickClearance";

/*
 * A synthetic right-hand price axis, 40 columns by 60 rows at 1x.
 *
 * Ground is black. A label box is drawn flush from column 0 (as the library
 * draws one) over rows 20–35, in a colour, with dark text inside it. A tick
 * label is glyph pixels starting after the stub and padding.
 */
const W = 40;
const H = 60;
const GROUND: Rgb = [15, 15, 15];

function axis(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([...GROUND, 255], i * 4);
  return data;
}
function paint(data: Uint8ClampedArray, x: number, y: number, rgb: Rgb): void {
  data.set([...rgb, 255], (y * W + x) * 4);
}
function labelBox(data: Uint8ClampedArray, top: number, bottom: number, right: number): void {
  for (let y = top; y <= bottom; y++) for (let x = 0; x < right; x++) paint(data, x, y, [255, 200, 0]);
  // Its own text: dark glyphs inside the box, which break the fill into short runs.
  for (let y = top + 3; y <= bottom - 3; y++) for (let x = 12; x < right - 2; x += 3) paint(data, x, y, [10, 10, 10]);
}
function tickText(data: Uint8ClampedArray, top: number, bottom: number): void {
  for (let y = top; y <= bottom; y++) for (let x = 11; x < 34; x += 4) paint(data, x, y, [180, 180, 180]);
}

const columns = axisColumns(12, 1, W, "right");
const ground = (): Rgba => [...GROUND, 255];

test("E2 — the probe column sits in the padding no tick text reaches", () => {
  // 5px stub + 5px padding at 12px type: text from column 10, probe at 7.5.
  assert.deepEqual(columns, { probe: 8, textFrom: 10, textTo: W });
  const left = axisColumns(12, 2, 80, "left");
  assert.equal(left.probe, 80 - 1 - 15);
  assert.equal(left.textTo, 80 - 20);
});

test("E2 — a tick a label box overlaps is found; one it never reached is not", () => {
  const data = axis();
  labelBox(data, 20, 35, 30);
  tickText(data, 14, 24); // its lower half is under the box: rows 14–19 survive
  tickText(data, 45, 55); // clear of everything
  const rows = classifyRows(data, W, H, columns, ground);
  // Every row of the box is a label row — including those through its own
  // dark glyphs, which a run-length test misread and would have erased.
  for (let y = 20; y <= 35; y++) assert.equal(rows[y], "label", `row ${y}`);
  assert.deepEqual(truncatedTickRuns(rows), [[14, 19]]);
});

test("E2 — a tick the box covered completely leaves nothing to clear", () => {
  const data = axis();
  tickText(data, 24, 30);
  labelBox(data, 20, 35, 30);
  assert.deepEqual(truncatedTickRuns(classifyRows(data, W, H, columns, ground)), []);
});

test("E2 — a tick touching the box from below is cleared too", () => {
  const data = axis();
  labelBox(data, 10, 25, 30);
  tickText(data, 26, 33);
  assert.deepEqual(truncatedTickRuns(classifyRows(data, W, H, columns, ground)), [[26, 33]]);
});

test("E2 — the ground is read from the chart's own background, solid or gradient", () => {
  assert.deepEqual(parseColour("#0f0f0f"), [15, 15, 15, 255]);
  assert.deepEqual(parseColour("#fff"), [255, 255, 255, 255]);
  assert.deepEqual(parseColour("rgba(1, 2, 3, 0.5)"), [1, 2, 3, 128]);
  assert.deepEqual(parseColour("rgba(0,0,0,0)"), [0, 0, 0, 0]);
  assert.deepEqual(parseColour("transparent"), [0, 0, 0, 0]);
  assert.equal(parseColour("var(--x)"), null);
  assert.deepEqual(groundFor({ type: "solid", color: "#101010" }, 10)!(5), [16, 16, 16, 255]);
  const gradient = groundFor({ type: "gradient", topColor: "#000000", bottomColor: "#ffffff" }, 11)!;
  assert.deepEqual(gradient(0), [0, 0, 0, 255]);
  assert.deepEqual(gradient(10), [255, 255, 255, 255]);
  // A colour this module cannot read means it does nothing rather than guess.
  assert.equal(groundFor({ type: "solid", color: "hsl(0 0% 6%)" }, 10), null);
});

test("E2 — on a TRANSPARENT ground a dark glyph is still ink", () => {
  // A study pane draws over the page: its empty axis pixels are 0,0,0,0.
  const data = new Uint8ClampedArray(W * H * 4);
  const clear: Rgba = [0, 0, 0, 0];
  for (let y = 20; y <= 35; y++) for (let x = 0; x < 30; x++) data.set([255, 200, 0, 255], (y * W + x) * 4);
  for (let y = 14; y <= 24; y++) for (let x = 11; x < 34; x += 4) data.set([0, 0, 0, 255], (y * W + x) * 4);
  assert.deepEqual(truncatedTickRuns(classifyRows(data, W, H, columns, () => clear)), [[14, 19]]);
});
