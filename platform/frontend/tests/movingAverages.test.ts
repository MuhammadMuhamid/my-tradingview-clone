/**
 * The chart's MA maths must equal the backend's, or an alert would appear to
 * fire on a line the user is not looking at. `lib/movingAverages.ts` says so in
 * its header; this pins it as an executable invariant.
 *
 * The expected values are computed here from first principles rather than
 * imported from the backend — the two trees are separate packages, and the
 * point is that they agree without sharing code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_VISIBLE_MA, MA_LENGTHS, buildMaOverlays, currentMaValues, defaultMaLines,
  ema, maColor, maId, maLabel, pricePrecision, sma,
} from "../lib/movingAverages";
import type { Candle } from "../lib/types";

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

const closes = [10, 11, 12, 13, 12, 11, 14, 15, 16, 15, 14, 13];

function candles(values: number[]): Candle[] {
  return values.map((close, i) => ({
    openTime: i * 900_000, open: close, high: close + 1, low: close - 1,
    close, volume: 1,
  })) as Candle[];
}

test("sma is null until the window is full, then the plain mean", () => {
  const out = sma(closes, 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  near(out[2]!, (10 + 11 + 12) / 3);
  near(out[3]!, (11 + 12 + 13) / 3);
  near(out[closes.length - 1]!, (15 + 14 + 13) / 3);
});

test("sma of a constant series is that constant", () => {
  const out = sma(new Array(50).fill(7), 21);
  for (let i = 20; i < 50; i++) near(out[i]!, 7);
});

test("ema is seeded with the SMA of the first `len` bars — the Pine and backend rule", () => {
  const len = 3;
  const out = ema(closes, len);
  assert.equal(out[len - 2], null);
  near(out[len - 1]!, (10 + 11 + 12) / 3);
  const alpha = 2 / (len + 1);
  near(out[len]!, closes[len]! * alpha + out[len - 1]! * (1 - alpha));
});

test("ema of a constant series equals that constant from the seed onward", () => {
  const out = ema(new Array(40).fill(3.5), 10);
  for (let i = 9; i < 40; i++) near(out[i]!, 3.5);
});

test("a series shorter than the window yields all nulls", () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
  assert.deepEqual(ema([1, 2], 5), [null, null]);
  assert.deepEqual(sma([1, 2, 3], 0), [null, null, null]);
});

test("the drawable MA set is the fixed five lengths the alert engine understands", () => {
  assert.deepEqual([...MA_LENGTHS], [200, 100, 50, 21, 15]);
  const lines = defaultMaLines();
  assert.equal(lines.length, MA_LENGTHS.length * 2, "one SMA and one EMA per length");
  assert.equal(new Set(lines.map((l) => maId(l.type, l.length))).size, lines.length);
});

test("a new chart draws ONE moving average, and keeps the other nine", () => {
  /*
   * The default used to be all ten visible. Since a length's SMA and EMA share
   * a hue, ten visible lines read as five doubled ones — the "duplicated
   * spaghetti" a fresh chart of any coin opened with.
   *
   * The one that is drawn is not a taste: `srtrend_v10` defaults to
   * `maType: "SMA"` with its chart-timeframe trend filter at length 200, so the
   * line on screen is the line the engine is deciding on.
   */
  const lines = defaultMaLines();
  const visible = lines.filter((l) => l.visible);
  assert.equal(visible.length, 1, "one line, not a mesh");
  assert.deepEqual(
    { type: visible[0]!.type, length: visible[0]!.length },
    { type: DEFAULT_VISIBLE_MA.type, length: DEFAULT_VISIBLE_MA.length });
  assert.deepEqual(DEFAULT_VISIBLE_MA, { type: "sma", length: 200 });

  // Nothing was removed: every line is still present, still armable, and the
  // MA panel's existing "show all" restores the previous set exactly.
  assert.equal(lines.length, 10);
  assert.match(read("components/tv/MaPanel.tsx"), /onToggleAll\(!allVisible\)/);
});

test("ids and labels are stable and match the backend's maLabel", () => {
  assert.equal(maId("ema", 200), "ma-ema-200");
  assert.equal(maLabel("ema", 200), "EMA 200");
  assert.equal(maLabel("sma", 15), "SMA 15");
  assert.equal(maColor(200), maColor(200));
  assert.equal(typeof maColor(9999), "string", "an unknown length still gets a colour");
});

test("currentMaValues reports the newest value of every requested line", () => {
  const bars = candles(closes);
  const values = currentMaValues(bars, [
    { type: "sma", length: 3, visible: true },
    { type: "ema", length: 3, visible: true },
    { type: "sma", length: 999, visible: true },
  ]);
  near(values["ma-sma-3"]!, (15 + 14 + 13) / 3);
  assert.ok(values["ma-ema-3"] !== null);
  assert.equal(values["ma-sma-999"], null, "not enough history yet");
});

test("currentMaValues reports hidden lines too — the alert dialog needs them", () => {
  const values = currentMaValues(candles(closes), [{ type: "sma", length: 3, visible: false }]);
  assert.ok(values["ma-sma-3"] !== null);
});

test("moving averages are read at the price's own precision, not each value's", () => {
  // fmtPrice's rule: >=100 -> 2dp, >=1 -> 4dp, else 6dp. Without this, one
  // legend row showed 210.228 beside 212.3651 for the same instrument.
  assert.equal(pricePrecision(218.53), 2);
  assert.equal(pricePrecision(12.5), 4);
  assert.equal(pricePrecision(0.3341), 6);
  assert.equal(pricePrecision(-218.53), 2);

  const overlays = buildMaOverlays(candles([180, 190, 200, 210, 220]), [
    { type: "sma", length: 3, visible: true },
    { type: "ema", length: 3, visible: true },
  ] as Parameters<typeof buildMaOverlays>[1]);
  assert.equal(overlays.length, 2);
  for (const o of overlays) assert.equal(o.precision, 2);
});
