/**
 * The chart-type model: which types exist, which of them are canonical
 * presentations and which are synthetic transforms, and how a bar becomes a
 * datum.
 *
 * Two properties carry the weight here. `mainSeriesDatum` never invents a
 * price — it reshapes exactly the bar it is handed, so it cannot be the place
 * a transform leaks in. And the presentation/transform split is data on the
 * type itself rather than a convention: the menu, the disclosure badge and the
 * renderer all read it from one place, so a type cannot be synthetic in one of
 * them and canonical in another.
 *
 * The transform arithmetic lives in `tests/chartTransforms.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CHART_TYPES, chartTransform, chartTypeLabel, chartTypeOrDefault, DEFAULT_RENKO_ATR_PERIOD,
  drawsOhlc, isChartType, isSyntheticChartType, mainSeriesDatum, renderKind, renkoParams,
  syntheticDisclosure, SYNTHETIC_DISCLOSURE_HINT,
  type ChartType,
} from "../lib/chartType";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const BAR = { openTime: 1_700_000_000_000, open: 10, high: 12, low: 9, close: 11 };

test("only the types this chart actually implements are offered", () => {
  assert.deepEqual(CHART_TYPES.map((t) => t.value),
    ["candles", "bars", "line", "area", "heikinAshi", "renko"]);
  // Unimplemented synthetic systems stay absent rather than appearing as
  // placeholders that cannot be chosen.
  for (const absent of ["kagi", "range", "pnf", "lineBreak", "heikinashi", "Renko"]) {
    assert.equal(isChartType(absent), false, absent);
  }
});

test("presentations and transforms are separate, and the split is data", () => {
  const presentations = CHART_TYPES.filter((t) => t.group === "presentation").map((t) => t.value);
  const transforms = CHART_TYPES.filter((t) => t.group === "transform").map((t) => t.value);
  assert.deepEqual(presentations, ["candles", "bars", "line", "area"]);
  assert.deepEqual(transforms, ["heikinAshi", "renko"]);

  // The transforms come last, so the menu can render them as a terminal group.
  assert.deepEqual(CHART_TYPES.map((t) => t.group),
    [...presentations.map(() => "presentation"), ...transforms.map(() => "transform")]);

  for (const t of CHART_TYPES) {
    assert.equal(isSyntheticChartType(t.value), t.group === "transform");
    assert.equal(chartTransform(t.value) === null, t.group === "presentation",
      `${t.value} disagrees with itself about whether it transforms anything`);
  }
});

test("a synthetic type is disclosed and a canonical one never is", () => {
  assert.equal(syntheticDisclosure("heikinAshi"), "Heikin Ashi");
  assert.equal(syntheticDisclosure("renko"), `Renko · ATR(${DEFAULT_RENKO_ATR_PERIOD})`);
  for (const canonical of ["candles", "bars", "line", "area"] as ChartType[]) {
    assert.equal(syntheticDisclosure(canonical), null,
      `${canonical} draws the exchange's own candles and must not carry a synthetic label`);
  }
  assert.match(SYNTHETIC_DISCLOSURE_HINT, /canonical exchange candles/);
});

test("Renko's parameters are ATR(14), and they belong to the chart type", () => {
  assert.equal(DEFAULT_RENKO_ATR_PERIOD, 14);
  assert.deepEqual(renkoParams("renko"), { atrPeriod: 14 });
  // The label carries the period, so what is persisted is also what is shown.
  assert.equal(chartTypeLabel("renko"), "Renko · ATR(14)");
  for (const other of ["candles", "bars", "line", "area", "heikinAshi"] as ChartType[]) {
    assert.equal(renkoParams(other), null);
  }
});

test("an unknown or damaged persisted type falls back to canonical candles", () => {
  for (const bad of [null, undefined, 3, "", "renko ", "kagi", {}, ["renko"]]) {
    assert.equal(chartTypeOrDefault(bad), "candles", JSON.stringify(bad));
  }
  // A type that IS known round-trips unchanged, including the synthetic ones.
  for (const t of CHART_TYPES) assert.equal(chartTypeOrDefault(t.value), t.value);
});

test("transforms are drawn by a candlestick series, not by a series of their own", () => {
  assert.equal(renderKind("heikinAshi"), "candles");
  assert.equal(renderKind("renko"), "candles");
  for (const t of ["candles", "bars", "line", "area"] as ChartType[]) {
    assert.equal(renderKind(t), t);
  }
});

test("THE MENU OFFERS NO TYPE THE RENDERER CANNOT DRAW", () => {
  // Every entry has a glyph and reaches a real branch of the series factory.
  const menu = read("components/tv/ChartTypeMenu.tsx");
  const chart = read("components/CandleChart.tsx");
  for (const t of CHART_TYPES) {
    assert.ok(menu.includes(`${t.value}:`), `${t.value} has no icon in the menu`);
  }
  assert.ok(!/disabled/.test(menu), "the menu grew an entry that cannot be chosen");
  assert.match(menu, /Transforms · display only/, "the transform group lost its heading");
  // And the chart discloses the transform on the chart itself, not only in the
  // toolbar — sixteen panes, one toolbar.
  assert.match(chart, /syntheticDisclosure\(chartType\)/);
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
  // The transforms hand the series a full bar, so they draw OHLC too.
  assert.equal(drawsOhlc("heikinAshi"), true);
  assert.equal(drawsOhlc("renko"), true);
});

test("time is the bar's own open time in seconds, in every mode", () => {
  for (const t of CHART_TYPES) {
    assert.equal(mainSeriesDatum(t.value, BAR).time, 1_700_000_000);
  }
});

test("OHLC modes carry the candle unchanged", () => {
  // Including the transforms: `mainSeriesDatum` reshapes the bar it is given
  // and never derives one, whichever type asked for it.
  for (const t of ["candles", "bars", "heikinAshi", "renko"] as ChartType[]) {
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
