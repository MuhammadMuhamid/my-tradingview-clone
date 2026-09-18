/*
 * The Range chart type, driven from the menu a person uses.
 *
 * Phase 3D found Range the one advanced type that was not credibly usable: a
 * price axis fitted to the MA overlay while the bars sat in a thin strip, a
 * two-or-three-bar window after switching in, BTC's axis and BTC's readouts
 * left over SOLUSDT after a symbol change, and 36 uncaught `Value is null`
 * errors that occurred on Range and on no other type.
 *
 * They were one defect wearing four faces. Range declared `transform: null`,
 * because it applies no candle transform — it is built from the execution tape
 * — and both `isSyntheticTimeBase` and `timeAnchoredVisualsTruthful` derived
 * their answer from that field. So a type whose bars complete on a price
 * crossing was classified as drawing at canonical bar times: time-anchored
 * layers were drawn over it, the MA took the shared price scale with it, and
 * the refit compared null with null across a total time-base swap and
 * concluded nothing had changed. The crash was separate and worse: `rangeBars`
 * emitted the raw execution timestamp, so one trade crossing three boundaries
 * emitted three bars at one time point, and the production renderer accepts
 * that silently and then cannot find its own rows.
 *
 * These tests hold the seam end to end. `setMainSeriesData` now throws outside
 * production on non-ascending data, so simply reaching Range with a live tape
 * is the crash regression.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { api, type MarketTrade } from "@/lib/api";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { isSyntheticTimeBase, timeAnchoredVisualsTruthful } from "@/lib/chartType";

let original: typeof api.marketTrades;
beforeEach(() => {
  resetBrowser();
  original = api.marketTrades;
  server.setDefaultCandles(compactSeries(400));
});
after(() => { api.marketTrades = original; closeBrowser(); });

/*
 * A tape that crosses many range boundaries, including several within one
 * execution — the exact shape that produced duplicate time points.
 */
function crossingTape(): MarketTrade[] {
  const start = Date.now() - 20 * 60_000;
  const rows: MarketTrade[] = [];
  for (let i = 0; i < 400; i += 1) {
    rows.push({
      id: i + 1,
      timestamp: start + i * 3_000,
      // Big alternating jumps: each one crosses several ranges at once.
      price: 100 + Math.sin(i / 3) * 4 + (i % 7) * 0.5,
      quantity: 1 + (i % 5),
      aggressor: i % 2 === 0 ? "buy" : "sell",
    });
  }
  return rows;
}

/** Drives the chart-style menu to `label`, the way a person does. */
async function chooseChartStyle(container: HTMLElement, label: RegExp): Promise<void> {
  const caret = [...container.querySelectorAll<HTMLElement>("button")]
    .find((b) => b.getAttribute("aria-label") === "Chart style");
  assert.ok(caret, "the chart-style caret is missing");
  fireEvent.click(caret);
  await settle();
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Chart style"]');
  assert.ok(menu, "the chart-style menu did not open");
  const row = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .find((el) => label.test((el.textContent ?? "").trim()));
  assert.ok(row, `the chart-style menu has no ${label} row`);
  fireEvent.click(row);
  await settle();
}

test("Range declares a time base of its own, and the two predicates agree", () => {
  assert.equal(isSyntheticTimeBase("range"), true,
    "range bars complete on a price crossing; they are not at canonical bar times");
  assert.equal(timeAnchoredVisualsTruthful("range"), false,
    "a layer anchored to a canonical timestamp cannot line up with a range bar");
  // Footprint applies no transform either, and IS canonical — its series holds
  // the exchange's own candles. The two must not be lumped together again.
  assert.equal(isSyntheticTimeBase("footprint"), false);
  assert.equal(timeAnchoredVisualsTruthful("footprint"), true);
});

test("switching into Range, and back, does not corrupt the series", async () => {
  api.marketTrades = async () => crossingTape();
  const chart = await mountChart();

  // Each of these renders the main series from scratch. `setMainSeriesData`
  // throws outside production on a non-ascending row, so a duplicate time
  // point — the cause of the 36 `Value is null` errors — fails here.
  await chooseChartStyle(chart.container, /^Range/);
  await chooseChartStyle(chart.container, /^Candles/);
  await chooseChartStyle(chart.container, /^Range/);

  // And the pane must not be refusing the presentation it has the tape for.
  assert.equal(screen.queryByText(/Range bars have no executions/), null,
    "the tape reached the chart but the pane said it had none");
});

test("Range says its time-anchored layers are hidden rather than losing them", async () => {
  api.marketTrades = async () => crossingTape();
  const chart = await mountChart();
  await chooseChartStyle(chart.container, /^Range/);

  const note = screen.queryByText(/Time-anchored layers hidden/);
  assert.ok(note, "Range suppressed the layers without telling the reader");
  assert.match(note.textContent ?? "", /unchanged and return on any other chart type/,
    "the reader must be told the configuration is kept, not dropped");

  // Returning restores them: suppression is a presentation decision, never a
  // deletion of what the user applied.
  await chooseChartStyle(chart.container, /^Candles/);
  assert.equal(screen.queryByText(/Time-anchored layers hidden/), null,
    "the layers must come back on a canonical chart type");
});

test("Range's synthetic ordering key never escapes to another pane", async () => {
  /*
   * `isSyntheticTimeBase` was introduced to replace the proxy
   * `transform !== null && transform !== "heikinAshi"`, and three branches in
   * `CandleChart` were left asking the proxy. Range applies no candle transform,
   * so it took the CANONICAL branch in all three — publishing its ordering key
   * to cross-pane crosshair sync, and drawing exchange volume at canonical times
   * under a series drawn at synthetic ones.
   *
   * Asserted structurally: the predicate is the thing that must be asked, and a
   * fourth branch added later asking the proxy is the way this regresses.
   */
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("./components/CandleChart.tsx", `file://${process.cwd()}/`), "utf8");
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(stripped, /transform !== null && transform !== "heikinAshi"/,
    "a branch still decides synthetic-vs-canonical by transform; Range answers that wrongly");
  // And the volume omission is keyed on the same predicate, so Range gets it.
  assert.match(stripped, /if \(isSyntheticTimeBase\(kind\)\)/,
    "the volume histogram must be omitted for every synthetic time base, Range included");
});
