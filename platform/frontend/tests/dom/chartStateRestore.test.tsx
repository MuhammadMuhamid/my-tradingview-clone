/**
 * A reload opens the chart the way it was left.
 *
 * ── B-08 ── the same saved state reloaded three times opened on three
 * different windows (about two days, then twenty-five, then five). The window
 * is now persisted with the pane and applied once the bars land, through the
 * one framing path every dataset change takes.
 *
 * ── B-09 ── a comparison added LAST came back FIRST: the stack's order was
 * whatever order the panes' data was assembled in.
 *
 * ── B-15 ── a dragged pane height reverted on reload.
 *
 * ── B-03 ── an interval change refitted the whole history (and a racing study
 * pane could then park it anywhere); it now keeps the right edge. A symbol
 * change drew the previous instrument's bars, status line and strategy values
 * under the new instrument's name until its bars arrived; it now draws none.
 *
 * Windows are read from the charts themselves (`harness/timeScales`).
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  advance, closeBrowser, compactSeries, resetBrowser, server, settle,
} from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";
import { chartViews, priceView } from "./harness/timeScales";
import { candleHistory } from "@/lib/candleHistory";
import { CANONICAL } from "./harness/market";
import { createWorkspace, WORKSPACE_STORAGE_KEY } from "@/lib/workspace";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(1_200));
});
after(closeBrowser);

async function reload(): Promise<MountedChart> {
  cleanup();
  candleHistory.reset();
  const chart = await mountChart();
  await advance(600);
  await settle();
  return chart;
}

/** Zoom with the wheel; at `x` 1279 the right edge stays put, at 900 it moves back. */
async function zoomIn(chart: MountedChart, notches: number, x = 900): Promise<void> {
  for (let i = 0; i < notches; i += 1) {
    fireEvent.wheel(chart.plot, { deltaY: -120, clientX: x, bubbles: true, cancelable: true });
    await advance(20);
  }
  // Past the report delay, so the window the reader stopped on is kept.
  await advance(900);
}

async function addStudies(chart: MountedChart, names: readonly string[]): Promise<void> {
  fireEvent.click(chart.container.querySelector<HTMLElement>('button[aria-label="Indicators"]')!);
  await settle();
  const dialog = screen.getByRole("dialog");
  for (const name of names) {
    fireEvent.click(within(dialog).getByRole("button", { name }));
    await settle();
  }
  fireEvent.keyDown(document, { key: "Escape" });
  await settle();
  await advance(1_500);
}

async function addComparison(chart: MountedChart): Promise<void> {
  const open = chart.container.querySelector<HTMLElement>(
    'button[aria-label="Compare with another instrument"]');
  assert.ok(open, "the toolbar has no Compare control");
  fireEvent.click(open);
  await settle();
  await advance(250);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-symbol-search="compare"]');
  assert.ok(dialog, "the compare dialog did not open");
  const row = dialog.querySelector<HTMLElement>('[data-idx="0"]');
  assert.ok(row, "the compare dialog lists nothing");
  fireEvent.click(row);
  await settle();
  await advance(1_500);
}

/** The study panes, top to bottom, by the name each pane announces. */
function stackOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("section[aria-label$=' indicator pane']")]
    .map((pane) => pane.getAttribute("aria-label")!.replace(/ indicator pane$/, ""));
}

test("B-08 — reloading the same state opens on the same window, every time", async () => {
  const chart = await mountChart();
  await zoomIn(chart, 4);
  const left = priceView(chart.container);
  const fit = { from: 0, to: 0 };
  assert.notDeepEqual({ from: left.from, to: left.to }, fit);

  for (let i = 0; i < 3; i += 1) {
    const again = await reload();
    const view = priceView(again.container);
    assert.deepEqual({ first: view.from, last: view.to }, { first: left.from, last: left.to },
      `reload ${i + 1} opened on a different window from the one the chart was left on`);
  }
});

test("B-09 / B-15 — a comparison added last stays last, and a dragged height stays", async () => {
  const chart = await mountChart();
  await addStudies(chart, ["Average True Range", "Relative Strength Index"]);
  await addComparison(chart);
  const before = stackOrder(chart.container);
  assert.equal(before.length, 3, `expected three study panes, saw ${before.join(", ")}`);
  assert.match(before[2]!, /vs /, "the comparison was not added at the bottom of the stack");

  const atr = chart.container.querySelector<HTMLElement>(
    "section[aria-label='Average True Range indicator pane']")!;
  const grip = within(atr).getByRole("button", { name: "Resize Average True Range pane" });
  const startHeight = Number.parseInt(atr.style.height, 10);
  fireEvent.pointerDown(grip, { clientY: 500 });
  fireEvent.pointerMove(window, { clientY: 440 });
  fireEvent.pointerUp(window, { clientY: 440 });
  await advance(500);
  const dragged = Number.parseInt(atr.style.height, 10);
  assert.ok(dragged > startHeight, "the drag did not resize the pane");

  const again = await reload();
  await advance(1_500);
  assert.deepEqual(stackOrder(again.container), before,
    "the stack came back in a different order");
  const restored = again.container.querySelector<HTMLElement>(
    "section[aria-label='Average True Range indicator pane']")!;
  assert.equal(Number.parseInt(restored.style.height, 10), dragged,
    "the dragged height reverted on reload");
});

test("B-03 — an interval change keeps the live edge and the width in bars", async () => {
  const chart = await mountChart();
  await zoomIn(chart, 4, 1279);
  const on15m = priceView(chart.container);
  const bars15 = on15m.logicalTo - on15m.logicalFrom;
  const last15 = server.candlesFor("SOLUSDT", "15m");
  assert.equal(on15m.to, last15[last15.length - 1]![0] / 1000, "the 15m chart left the live edge");

  fireEvent.click(chart.container.querySelector<HTMLElement>('button[data-resolution="1h"]')!);
  await settle();
  await advance(600);
  const on1h = priceView(chart.container);
  const last1h = server.candlesFor("SOLUSDT", "1h");
  assert.equal(on1h.to, last1h[last1h.length - 1]![0] / 1000,
    "the 1h chart is not at the live edge the 15m chart was on");
  assert.ok(Math.abs((on1h.logicalTo - on1h.logicalFrom) - bars15) < 1,
    "the interval change refitted instead of keeping the width");
});

test("B-22 — Renko opens on its newest bricks, not on every brick it has", async () => {
  // A long climb, so the bricks far outnumber what one window can read.
  const step = 15 * 60_000;
  const end = Math.floor(Date.now() / step) * step;
  server.setDefaultCandles(Array.from({ length: 1_200 }, (_, i) => {
    const price = 20 + i * 0.5;
    return [end - (1_199 - i) * step, price, price + 0.6, price - 0.1, price + 0.5, 1_000];
  }));
  const ws = createWorkspace({ symbol: "SOLUSDT", interval: "15m", chartType: "renko" });
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws));
  const chart = await mountChart();
  await advance(300);
  const view = priceView(chart.container);
  const width = view.logicalTo - view.logicalFrom;
  assert.ok(view.logicalFrom > 0, "every brick is on screen: the fit took the whole history");
  assert.ok(width > 140 && width < 160, `Renko opened ${width} bricks wide, not on its newest 150`);
});

test("B-03 — a symbol change draws none of the previous instrument while the new one loads", async () => {
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!]);
  const chart = await mountChart();
  await addStudies(chart, ["Relative Strength Index"]);
  assert.ok(chartViews(chart.container).length >= 2, "SOL drew no chart to switch away from");

  // BTC's bars are held in flight: what is on screen is what the pane shows
  // while the new instrument loads.
  const release = server.hold(({ path }) => path.includes("candles") && path.includes("BTC"));
  try {
    const row = chart.container.querySelector<HTMLElement>(
      `[data-watchlist-row="${CANONICAL.BTCUSDT}"] button`);
    assert.ok(row, "the watchlist has no BTC row to switch to");
    fireEvent.click(row);
    await settle();
    await advance(200);

    const status = chart.container.querySelector<HTMLElement>('[role="status"]');
    assert.ok(status && /Loading BTC/.test(status.textContent ?? ""),
      "the pane does not say what it is loading");
    assert.ok(!/showing SOL/.test(status.textContent ?? ""),
      "the pane still offers SOL's bars in BTC's place");
    assert.equal(chartViews(chart.container).length, 0,
      "a chart titled BTC is still drawing SOL's bars or SOL's studies");
  } finally {
    release();
  }
});
