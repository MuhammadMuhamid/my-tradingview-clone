/**
 * One time axis, whatever order the data lands in.
 *
 * ── B-01, which was wrong data rather than wrong chrome ───────────────────
 *
 * Add ETHUSDT as a comparison to a chart carrying ATR and RSI, reload, and on
 * two reloads of five the price pane drew twenty-five days of candles while
 * the time axis, both study panes and the Data window described seven. The
 * Data window read `10/5 00:45 O 120.40` over a candle drawn at about 107: the
 * crosshair was naming one bar and standing over another.
 *
 * The cause was a study pane broadcasting its own window. A pane's window
 * moves on its own each time its data lands — the library's default for a new
 * series, then wherever the study's recomputed window puts it — and the price
 * chart adopted every one of those as though a person had panned. Whichever
 * landed last won, which is why the same saved state opened three different
 * ways (B-08).
 *
 * What is asserted is the invariant rather than any one window: every chart
 * on screen shows the SAME first and last bar, after a reload, after a study
 * is added, and after a person zooms from a study pane. The windows are read
 * from the charts themselves (`harness/timeScales`), because they are canvas
 * and nothing in the DOM can say what they show.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  advance, closeBrowser, compactSeries, resetBrowser, server, settle,
} from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";
import { chartViews, chartsIn, priceView, type ChartView } from "./harness/timeScales";
import { candleHistory } from "@/lib/candleHistory";
import { WORKSPACE_STORAGE_KEY } from "@/lib/workspace";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(1_500));
});
after(closeBrowser);

async function addStudies(chart: MountedChart, names: readonly string[]): Promise<void> {
  const open = chart.container.querySelector<HTMLElement>('button[aria-label="Indicators"]');
  assert.ok(open, "the toolbar has no Indicators control");
  fireEvent.click(open);
  await settle();
  const dialog = screen.getByRole("dialog");
  for (const name of names) {
    fireEvent.click(within(dialog).getByRole("button", { name }));
    await settle();
  }
  fireEvent.keyDown(document, { key: "Escape" });
  await settle();
  await advance(1_500);
  await settle();
}

/** A browser reload: the page goes, storage and the server stay. */
async function reload(): Promise<MountedChart> {
  cleanup();
  candleHistory.reset();
  const chart = await mountChart();
  await advance(600);
  await settle();
  return chart;
}

/** Put a comparison on the stored pane, as the Compare dialog would have. */
function storeComparison(): void {
  const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
  assert.ok(raw, "the workspace was never saved");
  const ws = JSON.parse(raw) as { panes: Array<Record<string, unknown>> };
  ws.panes[0]!.compare = { symbol: CANONICAL.ETHUSDT, mode: "percent", length: 60 };
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws));
}

function assertOneTimeAxis(views: ChartView[], when: string): void {
  const price = views.find((v) => v.id === "price");
  assert.ok(price, `${when}: the price chart shows no bars`);
  assert.ok(views.length > 1, `${when}: there are no study panes to compare against`);
  for (const view of views) {
    if (view.id === "price") continue;
    assert.deepEqual(
      { first: view.from, last: view.to },
      { first: price.from, last: price.to },
      `${when}: ${view.id} shows a different window from the price chart — ` +
      "the crosshair would name one bar while standing over another");
  }
}

test("B-01 — after a reload with a comparison, every pane shows the price chart's window", async () => {
  const first = await mountChart();
  await addStudies(first, ["Average True Range", "Relative Strength Index"]);
  storeComparison();

  for (let i = 0; i < 2; i += 1) {
    const chart = await reload();
    const views = chartViews(chart.container);
    assert.ok(views.some((v) => v.id.startsWith("compare:")),
      "the restored comparison drew no pane");
    assert.equal(views.filter((v) => v.id.startsWith("indicator:")).length, 2,
      "the restored studies drew no panes");
    assertOneTimeAxis(views, `reload ${i + 1}`);
  }
});

test("B-01 — adding a study does not move the price chart", async () => {
  const chart = await mountChart();
  const before = priceView(chart.container);
  await addStudies(chart, ["Average True Range", "Relative Strength Index"]);
  const afterAdd = priceView(chart.container);
  assert.deepEqual(
    { first: afterAdd.from, last: afterAdd.to },
    { first: before.from, last: before.to },
    "a study pane's own default window was pushed onto the price chart");
  assertOneTimeAxis(chartViews(chart.container), "after adding two studies");
});

test("B-01 — a person zooming from a study pane still moves every pane", async () => {
  const chart = await mountChart();
  await addStudies(chart, ["Relative Strength Index"]);
  const before = priceView(chart.container);
  const study = [...chartsIn(chart.container)].find(([id]) => id.startsWith("indicator:"));
  assert.ok(study, "no study pane mounted");
  const host = study[1].chartElement();
  // The time axis is drawn under the lowest pane, so zooming it IS a gesture
  // on a study pane. The library's own wheel handler does the zooming.
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      fireEvent.wheel(host, { deltaY: -120, clientX: 600, bubbles: true, cancelable: true });
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  await settle();
  await advance(100);
  const zoomed = priceView(chart.container);
  assert.ok(zoomed.to - zoomed.from < before.to - before.from,
    "zooming a study pane no longer moves the price chart");
  assertOneTimeAxis(chartViews(chart.container), "after zooming from a study pane");
});
