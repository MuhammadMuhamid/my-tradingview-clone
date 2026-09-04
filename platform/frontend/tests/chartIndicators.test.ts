import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupChartOverlays, mergeBarColorLayers, planCandleMutation,
  planColoredCandleMutation, planOhlcMutation, planSeriesMutation, plotValueAt, shiftedPlotTime,
  type ChartOverlay,
} from "../lib/chartSeries";
import { toChartOutput } from "../lib/indicators";
import type { PineRunResult } from "../lib/api";
import type { Candle } from "../lib/types";

const overlay = (id: string, paneId = "price"): ChartOverlay => ({
  id, paneId, title: id, color: "#fff", data: [{ time: 1, value: 1 }],
});

test("overlay studies stay on price while each oscillator instance keeps a stable pane", () => {
  const grouped = groupChartOverlays([
    overlay("ma"),
    { ...overlay("rsi-a", "indicator:a"), instanceTitle: "RSI · a" },
    { ...overlay("rsi-a-level", "indicator:a"), instanceTitle: "RSI · a" },
    { ...overlay("rsi-b", "indicator:b"), instanceTitle: "RSI · b" },
  ]);
  assert.deepEqual(grouped.price.map((item) => item.id), ["ma"]);
  assert.deepEqual(grouped.panes.map((pane) => [pane.id, pane.overlays.length]), [
    ["indicator:a", 2], ["indicator:b", 1],
  ]);
});

test("last-bar and append changes use update while historical changes replace", () => {
  const before = [{ time: 1, value: null }, { time: 2, value: 10 }];
  assert.equal(planSeriesMutation(before, [...before]), "none");
  assert.equal(planSeriesMutation(before, [before[0]!, { time: 2, value: 11 }]), "update");
  assert.equal(planSeriesMutation(before, [...before, { time: 3, value: 12 }]), "update");
  assert.equal(planSeriesMutation(before, [{ time: 1, value: 9 }, before[1]!]), "replace");
  const tenThousand = Array.from({ length: 10_000 }, (_, i) => ({ time: i + 1, value: i }));
  assert.equal(
    planSeriesMutation(tenThousand, [...tenThousand.slice(0, -1), { time: 10_000, value: 10_001 }]),
    "update"
  );
});

const candle = (openTime: number, close: number): Candle => ({
  symbol: "BTCUSDT", interval: "1m", openTime, closeTime: openTime + 59_999,
  open: close, high: close, low: close, close, volume: 1,
});

test("incremental candle planning does not replay 10k bars for one live update", () => {
  const before = [candle(60_000, 1), candle(120_000, 2)];
  assert.equal(planCandleMutation(before, [before[0]!, candle(120_000, 3)]), "update");
  assert.equal(planCandleMutation(before, [...before, candle(180_000, 4)]), "update");
  assert.equal(planCandleMutation(before, [candle(60_000, 9), before[1]!]), "replace");
});

test("crosshair values restore the latest finite plot value when it leaves", () => {
  const points = [
    { time: 1, value: 10 }, { time: 2, value: null }, { time: 3, value: 12 },
  ];
  assert.equal(plotValueAt(points, 1), 10);
  assert.equal(plotValueAt(points, 2), null);
  assert.equal(plotValueAt(points, null), 12);
});

test("offsets shift onto chart bars and extrapolate only at the outer boundary", () => {
  assert.equal(shiftedPlotTime([60, 120, 180], 0, 1), 120);
  assert.equal(shiftedPlotTime([60, 120, 180], 2, 1), 240);
  assert.equal(shiftedPlotTime([60, 120, 180], 0, -2), null);
});

test("Pine output preserves styles, gaps, dynamic colours, hlines and instance identity", () => {
  const result: PineRunResult = {
    ok: true,
    errors: [],
    meta: {
      kind: "indicator", title: "RSI", shortTitle: "RSI", overlay: false,
      format: "price", precision: 2, inputs: [], warnings: [],
    },
    times: [60, 120, 180],
    plots: [{
      id: "plot_1", title: "RSI", color: "#7e57c2", width: 2,
      style: "stepline", offset: 0, forceOverlay: false, renderable: true,
      colors: ["#111111", null, "#333333"], data: [40, null, 60],
    }],
    hlines: [{
      id: "hline_2", price: 70, color: "#777777", title: "Upper",
      width: 1, style: "dashed", renderable: true,
    }],
  };
  const output = toChartOutput("instance-a", result);
  assert.equal(output.overlays.length, 2);
  assert.equal(output.overlays[0]!.paneId, "indicator:instance-a");
  assert.equal(output.overlays[0]!.style, "stepline");
  assert.deepEqual(output.overlays[0]!.data.map((point) => [point.value, point.color]), [
    [40, "#111111"], [null, null], [60, "#333333"],
  ]);
  assert.deepEqual(output.overlays[1]!.data.map((point) => point.value), [70, 70]);
  // Instance identity is the pane/series id, not the display title: the key
  // used to be printed in front of the user on every indicator.
  assert.equal(output.overlays[0]!.instanceId, "instance-a");
  assert.equal(output.overlays[0]!.instanceTitle, "RSI");
});

test("Pine visual contracts preserve pane ownership, handles, offsets and custom OHLC", () => {
  const result: PineRunResult = {
    ok: true,
    errors: [],
    meta: {
      kind: "indicator", title: "Visuals", shortTitle: "V", overlay: false,
      format: "price", precision: 2, inputs: [], warnings: [],
    },
    times: [60, 120, 180],
    plots: [
      { id: "plot_1", title: "Upper", color: "#fff", width: 1, style: "line",
        offset: 0, forceOverlay: false, renderable: true,
        colors: ["#fff", "#fff", "#fff"], data: [3, 4, 5] },
      { id: "plot_2", title: "Lower", color: "#fff", width: 1, style: "cross",
        offset: 0, forceOverlay: false, renderable: true,
        colors: ["#fff", null, "#fff"], data: [1, null, 3] },
    ],
    fills: [{
      id: "fill_3", title: "Band", firstId: "plot_1", secondId: "plot_2",
      forceOverlay: false, renderable: true, fillgaps: false,
      colors: ["#2962ff1a", null, "#2962ff1a"],
    }],
    backgrounds: [{
      id: "bgcolor_4", title: "State", offset: 1, forceOverlay: false,
      colors: ["#0899811a", null, null],
    }],
    barColors: [{
      id: "barcolor_5", title: "Bars", offset: 0,
      colors: [null, "#f23645", null],
    }],
    ohlcPlots: [{
      id: "plotcandle_6", title: "Synthetic", style: "candles", color: "#00e676",
      forceOverlay: false, renderable: true,
      data: [{ open: 1, high: 3, low: 0, close: 2 }, null,
        { open: 2, high: 4, low: 1, close: 3 }],
      colors: ["#00e676", null, "#00e676"],
      wickColors: ["#ffeb3b", null, "#ffeb3b"],
      borderColors: ["#ffffff", null, "#ffffff"],
    }],
  };
  const output = toChartOutput("instance-v", result);
  assert.deepEqual(output.overlays.map((item) => item.style), ["line", "cross", "candles"]);
  assert.equal(output.overlays[2]!.data[0]!.high, 3);
  assert.equal(output.overlays[2]!.data[1]!.value, null);
  assert.deepEqual(output.decorations.map((item) => [item.kind, item.paneId]), [
    ["background", "indicator:instance-v"], ["fill", "indicator:instance-v"],
  ]);
  const fill = output.decorations[1]!;
  assert.equal(fill.kind, "fill");
  if (fill.kind === "fill") {
    assert.equal(fill.firstId, "instance-v:plot_1");
    assert.equal(fill.secondId, "instance-v:plot_2");
  }
  assert.equal(output.decorations[0]!.data[0]!.time, 120);
  assert.deepEqual(output.barColors, [
    { time: 60, color: null }, { time: 120, color: "#f23645" }, { time: 180, color: null },
  ]);
  const duplicate = toChartOutput("instance-w", result);
  assert.notEqual(duplicate.overlays[0]!.id, output.overlays[0]!.id);
  assert.notEqual(duplicate.decorations[1]!.id, output.decorations[1]!.id);
});

test("barcolor precedence is deterministic and candle updates stay incremental", () => {
  assert.deepEqual(mergeBarColorLayers([
    [{ time: 1, color: "#111111" }, { time: 2, color: "#222222" }],
    [{ time: 1, color: null }, { time: 2, color: "#ffffff" }],
  ]), [
    { time: 1, color: "#111111" }, { time: 2, color: "#ffffff" },
  ]);
  assert.deepEqual(mergeBarColorLayers([[
    { time: 1, color: "#111111" }, { time: 2, color: "#222222" },
  ]]), [
    { time: 1, color: "#111111" }, { time: 2, color: "#222222" },
  ]);

  const candles = [candle(1_000, 1), candle(2_000, 2), candle(3_000, 3)];
  const base = new Map<number, string>([[1, "#111111"], [3, "#333333"]]);
  assert.equal(planColoredCandleMutation(candles, candles, base, new Map(base)), "none");
  assert.equal(
    planColoredCandleMutation(candles, candles, base,
      new Map<number, string>([[1, "#111111"], [3, "#ffffff"]])),
    "update"
  );
  assert.equal(
    planColoredCandleMutation(candles, candles, base,
      new Map<number, string>([[1, "#ffffff"], [3, "#333333"]])),
    "replace"
  );
});

test("an indicator instance is named by its script, not by its internal key", () => {
  const run: PineRunResult = {
    ok: true, errors: [],
    meta: {
      kind: "indicator", title: "Relative Strength Index", shortTitle: "RSI",
      overlay: false, format: "price", precision: 2,
      inputs: [{ key: "len", title: "Length", type: "int", defval: 14 }], warnings: [],
    },
    times: [1, 2],
    plots: [{
      id: "rsi", title: "RSI", color: "#fff", width: 1, style: "line", offset: 0,
      forceOverlay: false, renderable: true, colors: [], data: [1, 2],
    }],
  };
  const out = toChartOutput("ind_abcdef", run, { len: 14 });
  assert.equal(out.overlays[0]!.instanceTitle, "RSI");
  assert.equal(out.overlays[0]!.instanceParams, "Length 14");
  // The key still separates the two instances' series and panes.
  assert.equal(out.overlays[0]!.instanceId, "ind_abcdef");
  assert.equal(out.overlays[0]!.paneId, "indicator:ind_abcdef");
});

test("only instances a reader could not otherwise tell apart get an ordinal", () => {
  const grouped = groupChartOverlays([
    { ...overlay("a", "indicator:a"), instanceTitle: "RSI", instanceParams: "Length 14" },
    { ...overlay("b", "indicator:b"), instanceTitle: "RSI", instanceParams: "Length 7" },
    { ...overlay("c", "indicator:c"), instanceTitle: "RSI", instanceParams: "Length 14" },
    { ...overlay("d", "indicator:d"), instanceTitle: "MACD", instanceParams: "Fast 12" },
  ]);
  assert.deepEqual(grouped.panes.map((p) => p.title), [
    "RSI (1)", "RSI", "RSI (2)", "MACD",
  ]);
});

/**
 * The transformed main series has its own mutation planner, because neither
 * candle planner can speak for it: a Heikin-Ashi bar carries no volume, and a
 * Renko brick has no fixed relationship to the canonical bar count at all.
 *
 * The Renko cases below are the ones that matter. `update()` can rewrite the
 * last bar or append one; it cannot REMOVE a bar. So a forming candle that
 * retraces and un-completes a brick it had already produced, and one that
 * completes two bricks between ticks, both have to fall back to a full
 * repaint — drawing them incrementally would leave a brick on screen that the
 * data no longer contains.
 */
test("the transformed series is planned by its own rules", () => {
  const bar = (t: number, c: number) =>
    ({ openTime: t, open: c - 1, high: c + 1, low: c - 2, close: c });
  const before = [bar(60_000, 10), bar(120_000, 11)];

  assert.equal(planOhlcMutation(before, [...before]), "none");
  assert.equal(planOhlcMutation([], []), "none");
  assert.equal(planOhlcMutation([], before), "replace");
  assert.equal(planOhlcMutation(before, []), "replace");

  // Heikin Ashi's live case: the last bar is rewritten in place every tick.
  assert.equal(planOhlcMutation(before, [before[0]!, bar(120_000, 12)]), "update");
  // A closed bar, then one new brick or bar appended.
  assert.equal(planOhlcMutation(before, [...before, bar(180_000, 13)]), "update");

  // Renko: two bricks at once cannot be one update.
  assert.equal(
    planOhlcMutation(before, [...before, bar(180_000, 13), bar(181_000, 14)]), "replace");
  // Renko: a retrace that un-completes the newest brick.
  assert.equal(planOhlcMutation(before, [before[0]!]), "replace");
  // Any disagreement about already-drawn history is a repaint, never an update.
  assert.equal(planOhlcMutation(before, [bar(60_000, 99), before[1]!]), "replace");
});
