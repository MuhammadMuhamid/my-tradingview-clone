/**
 * ── B-07: "High and low" = Value froze the price scale ────────────────────
 *
 * Chart settings → Scales and lines → High and low → Value → Ok, and the price
 * scale stayed on the whole-history range: zoomed in, the candles were a flat
 * line across the middle of the plot, after a revert and after a reload, and
 * only ticking Auto scale repaired it. The dialog half (a scale control
 * writing a stale `autoScale: false`) is another fixer's; this file holds the
 * chart's half: with the High/Low levels on, the scale must still fit the
 * bars on screen, the levels must not stretch it, and nothing on the chart
 * may switch Auto off by itself.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { advance, closeBrowser, resetBrowser, server, settle } from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";
import { pricePlotRange, priceView } from "./harness/timeScales";
import { createWorkspace, WORKSPACE_STORAGE_KEY } from "@/lib/workspace";
import type { CompactBar } from "./harness/server";

const STEP = 15 * 60_000;

/** A steady climb from 50 to 150: the whole history spans far more than any recent window. */
function climb(count: number): CompactBar[] {
  const end = Math.floor(Date.now() / STEP) * STEP;
  return Array.from({ length: count }, (_, i): CompactBar => {
    const price = 50 + (100 * i) / (count - 1);
    return [end - (count - 1 - i) * STEP, price, price + 0.2, price - 0.2, price + 0.05, 1_000];
  });
}

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(climb(1_000));
});
after(closeBrowser);

async function zoomToRecent(chart: MountedChart): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    fireEvent.wheel(chart.plot, { deltaY: -120, clientX: 1279, bubbles: true, cancelable: true });
    await advance(20);
  }
  // Pointer activity is what runs the scale's reconcile; make some.
  // On the plot cell itself, which is where the library listens.
  const cell = chart.plot.querySelector("table")?.rows[0]?.cells[1] ?? chart.plot;
  for (const target of [cell, ...cell.querySelectorAll("canvas, div")]) {
    fireEvent.mouseEnter(target, { clientX: 600, clientY: 300 });
    fireEvent.mouseMove(target, { clientX: 600, clientY: 300, bubbles: true });
    fireEvent.mouseMove(target, { clientX: 640, clientY: 320, bubbles: true });
  }
  await advance(100);
  await settle();
}

for (const mode of ["hidden", "value", "line"] as const) {
  test(`B-07 — with High and low = ${mode}, the scale still fits the bars on screen`, async () => {
    const ws = createWorkspace({ symbol: "SOLUSDT", interval: "15m" });
    ws.panes[0]!.chartSettings = { highLow: mode } as never;
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws));

    const chart = await mountChart();
    await zoomToRecent(chart);
    const view = priceView(chart.container);
    const shown = view.logicalTo - view.logicalFrom;
    assert.ok(shown < 400, `the zoom did not narrow the window (${shown} bars)`);

    const range = pricePlotRange(chart.container);
    // The window spans about a third of the history (~32 of 100, ~50 with the
    // scale margins); a scale
    // still on 50–150 is the flattened chart the reviewer saw. `hidden` is the
    // control: the levels must change nothing about the fit.
    assert.ok(range.low > 100, `the scale reaches down to ${range.low}: the Low level is stretching it`);
    assert.ok(range.high - range.low < 60,
      `the scale spans ${range.low}–${range.high}, the whole history, not the bars on screen`);

    const stored = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}");
    assert.notEqual(stored.panes?.[0]?.priceScale?.autoScale, false,
      "something on the chart switched Auto scale off by itself");
  });
}
