import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupChartOverlays, planCandleMutation, planSeriesMutation,
  plotValueAt, shiftedPlotTime, type ChartOverlay,
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
  assert.match(output.overlays[0]!.instanceTitle!, /nce-a/);
});
