/**
 * The chart-type selector is a *presentation* switch, not a data one: every
 * mode is drawn from the same authoritative OHLC candles. These pin the two
 * properties that guarantee that — the datum builder never invents a price,
 * and the list never grows a mode this chart cannot honestly draw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHART_TYPES, chartTypeLabel, drawsOhlc, isChartType, mainSeriesDatum,
  type ChartType,
} from "../lib/chartType";

const BAR = { openTime: 1_700_000_000_000, open: 10, high: 12, low: 9, close: 11 };

test("only the four presentations this chart can draw are offered", () => {
  assert.deepEqual(CHART_TYPES.map((t) => t.value), ["candles", "bars", "line", "area"]);
  // Synthetic bar types would have to invent prices from this dataset.
  for (const banned of ["heikinashi", "renko", "kagi", "range", "pnf"]) {
    assert.equal(isChartType(banned), false, banned);
  }
});

test("isChartType rejects anything that is not a mode", () => {
  assert.equal(isChartType("candles"), true);
  assert.equal(isChartType(""), false);
  assert.equal(isChartType(null), false);
  assert.equal(isChartType(undefined), false);
  assert.equal(isChartType(3), false);
});

test("every mode has a label, and drawsOhlc splits them the way the API does", () => {
  for (const t of CHART_TYPES) assert.ok(chartTypeLabel(t.value).length > 0);
  assert.equal(drawsOhlc("candles"), true);
  assert.equal(drawsOhlc("bars"), true);
  assert.equal(drawsOhlc("line"), false);
  assert.equal(drawsOhlc("area"), false);
});

test("time is the bar's own open time in seconds, in every mode", () => {
  for (const t of CHART_TYPES) {
    assert.equal(mainSeriesDatum(t.value, BAR).time, 1_700_000_000);
  }
});

test("OHLC modes carry the candle unchanged", () => {
  for (const t of ["candles", "bars"] as ChartType[]) {
    const d = mainSeriesDatum(t, BAR);
    assert.equal(d.open, 10);
    assert.equal(d.high, 12);
    assert.equal(d.low, 9);
    assert.equal(d.close, 11);
    assert.equal(d.value, undefined);
  }
});

test("line and area plot the close, and nothing derived from it", () => {
  for (const t of ["line", "area"] as ChartType[]) {
    const d = mainSeriesDatum(t, BAR);
    assert.equal(d.value, 11);
    assert.equal(d.open, undefined);
    assert.equal(d.high, undefined);
    assert.equal(d.low, undefined);
  }
});

test("a barcolor() override paints candles fully and bars by body only", () => {
  const candle = mainSeriesDatum("candles", BAR, "#ff0000");
  assert.equal(candle.color, "#ff0000");
  assert.equal(candle.borderColor, "#ff0000");
  assert.equal(candle.wickColor, "#ff0000");

  const bar = mainSeriesDatum("bars", BAR, "#ff0000");
  assert.equal(bar.color, "#ff0000");
  assert.equal(bar.borderColor, undefined);
  assert.equal(bar.wickColor, undefined);
});

test("a bar colour says nothing about a continuous line, so it is not applied", () => {
  for (const t of ["line", "area"] as ChartType[]) {
    const d = mainSeriesDatum(t, BAR, "#ff0000");
    assert.equal(d.color, undefined);
    assert.equal(d.value, 11);
  }
});

test("no colour override leaves the datum uncoloured rather than defaulted", () => {
  for (const t of CHART_TYPES) {
    const d = mainSeriesDatum(t.value, BAR, null);
    assert.equal(d.color, undefined);
  }
});
