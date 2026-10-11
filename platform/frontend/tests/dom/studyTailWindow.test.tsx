/**
 * B-01: a chart panned back into history still reads its studies at the
 * NEWEST bar when nothing is hovered.
 *
 * Reproduced by an independent reviewer, twice: pan ~600 bars back, move the
 * pointer off the chart, and the ATR legend printed 0.1843 against a last-bar
 * ATR(14) of 0.0705, the RSI 69.47 against 45.83 — the value at the right edge
 * of the study's COMPUTE WINDOW, which followed the viewport — while the SMA and
 * Pine rows beside them printed the last bar. The plotted line ended at the
 * window edge too, so the price-axis label agreed with neither.
 *
 * This mounts the real hook with a viewport panned back and reads what the
 * legend, the Data window and the axis read: each overlay's points.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act } from "@testing-library/react";
import { render, closeBrowser, resetBrowser, settle } from "./harness/env";
import { useNativeStudies, type NativeStudiesApi } from "@/lib/useNativeStudies";
import { studyById } from "@/lib/native/catalog";
import { defaultParams } from "@/lib/native/registry";
import { studySourceToken } from "@/lib/native/graph";
import { plotValueAt, type ChartOverlay } from "@/lib/chartSeries";
import { dataWindowStudies } from "@/lib/dataWindow";
import type { Viewport } from "@/lib/native/compute";
import type { Candle } from "@/lib/types";

const SCOPE = "tail-pane";
const N = 3_000;

const CANDLES: Candle[] = (() => {
  let price = 10;
  let seed = 7;
  const next = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  return Array.from({ length: N }, (_, i) => {
    const open = price;
    price *= 1 + (next() - 0.5) * 0.03;
    return {
      symbol: "SOLUSDT", interval: "15m" as const,
      openTime: Date.UTC(2026, 0, 1) + i * 900_000,
      closeTime: Date.UTC(2026, 0, 1) + (i + 1) * 900_000 - 1,
      open, close: price,
      high: Math.max(open, price) * 1.004, low: Math.min(open, price) * 0.996,
      volume: 1_000 + next() * 500,
    };
  });
})();

const seconds = (bar: Candle) => Math.floor(bar.openTime / 1000);
const NEWEST = seconds(CANDLES[N - 1]!);

/** 200 bars on screen, ~600 bars back from the newest — the reviewer's state. */
const PANNED: Viewport = { firstVisibleIndex: N - 800, visibleBars: 200 };

function Pane({ viewport, onReady }: {
  viewport: Viewport; onReady: (api: NativeStudiesApi) => void;
}) {
  const api = useNativeStudies({ candles: CANDLES, interval: "15m", scope: SCOPE, viewport });
  onReady(api);
  return null;
}

/** A full-history computation of one plot — the truth to compare against. */
function fullHistory(defId: string, plotId: string, params = {}): readonly number[] {
  const def = studyById(defId)!;
  return def.compute({
    candles: CANDLES, params: { ...defaultParams(def), ...params }, interval: "15m",
  }).plots[plotId]!;
}

const close = (a: number | null, b: number, what: string) => {
  assert.ok(a !== null && Number.isFinite(a), `${what}: no value`);
  assert.ok(Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6), `${what}: ${a} ≠ ${b}`);
};

const plotOf = (overlays: readonly ChartOverlay[], key: string, plotId: string) =>
  overlays.find((overlay) => overlay.id === `${key}:${plotId}`)!;

beforeEach(resetBrowser);
after(closeBrowser);

test("PANNED BACK, A STUDY'S RESTING LEGEND, DATA WINDOW AND AXIS READ THE NEWEST BAR", async () => {
  let api: NativeStudiesApi | null = null;
  render(<Pane viewport={PANNED} onReady={(a) => { api = a; }} />);
  await settle();
  let rsi = "", atr = "", ma = "";
  await act(async () => { rsi = api!.add("rsi") ?? ""; });
  await act(async () => { atr = api!.add("atr") ?? ""; });
  // A study that READS another: computed over the tail window as well, from
  // its source's tail arrays, bar for bar.
  await act(async () => { ma = api!.add("ma") ?? ""; });
  await act(async () => { api!.setParam(ma, "source", studySourceToken(rsi, "rsi")); });
  await settle();

  const overlays = api!.overlays;
  const rsiFull = fullHistory("rsi", "rsi");
  const atrFull = fullHistory("atr", "atr");

  for (const [key, plotId, full] of [[rsi, "rsi", rsiFull], [atr, "atr", atrFull]] as const) {
    const plot = plotOf(overlays, key, plotId);
    assert.equal(plot.data[plot.data.length - 1]!.time, NEWEST,
      `${plotId}: the plotted series ends before the last candle — the axis label reads another bar`);
    // No crosshair: the legend's and the Data window's reading.
    close(plotValueAt(plot.data, null), full[N - 1]!, `${plotId} resting legend`);
    // A crosshair on a bar the user can see still reads THAT bar.
    const visibleBar = PANNED.firstVisibleIndex + 100;
    close(plotValueAt(plot.data, seconds(CANDLES[visibleBar]!)), full[visibleBar]!,
      `${plotId} hovered bar`);
    // And the times stay strictly increasing across the seam.
    for (let i = 1; i < plot.data.length; i++) {
      assert.ok(plot.data[i]!.time > plot.data[i - 1]!.time, `${plotId} out of order at ${i}`);
    }
  }

  // The study panel's row values are the newest bar's too.
  const row = api!.rows.find((r) => r.study.key === atr)!;
  close(row.values.atr ?? null, atrFull[N - 1]!, "ATR panel value");

  // The dependent MA of the RSI reads its source's newest values.
  const maPlot = plotOf(overlays, ma, "ma");
  assert.equal(maPlot.data[maPlot.data.length - 1]!.time, NEWEST);
  const maDef = studyById("ma")!;
  const maFull = maDef.compute({
    candles: CANDLES,
    params: { ...defaultParams(maDef), source: studySourceToken(rsi, "rsi") },
    interval: "15m",
    sources: { [studySourceToken(rsi, "rsi")]: rsiFull },
  }).plots.ma!;
  close(plotValueAt(maPlot.data, null), maFull[N - 1]!, "MA-of-RSI resting legend");

  // The Data window with no hover — the same rows the legend prints.
  const window_ = dataWindowStudies(overlays, null);
  const atrGroup = window_.find((group) => group.id === atr)!;
  const precision = plotOf(overlays, atr, "atr").precision ?? 2;
  assert.equal(atrGroup.rows[0]!.value, atrFull[N - 1]!.toFixed(precision));
});
