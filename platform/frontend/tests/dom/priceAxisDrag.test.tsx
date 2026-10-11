/**
 * B-07: dragging the price axis SCALES it — and the badge then says Manual.
 *
 * Reproduced on the dev build at fb59851: mouse-down on the price axis, drag
 * 120–300 px, release, and the visible price range was UNCHANGED (axis labels
 * identical before and after) while `autoScale` had flipped off — the `A` chip
 * off and `reset` offered over a scale that had not moved. In wave 2 at
 * 3f57ea9 the same drag scaled.
 *
 * The drag here is the library's own gesture, unmodified, driven through the
 * price axis's own canvas; what is read is the library's own coordinate
 * conversion on the main series, before and after.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, fireEvent, screen } from "@testing-library/react";
import type { ISeriesApi, SeriesType } from "lightweight-charts";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";
import { chartsIn } from "./harness/timeScales";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

interface Fiber {
  child: Fiber | null; sibling: Fiber | null; type: unknown;
  memoizedState: { memoizedState: unknown; next: unknown } | null;
  return?: Fiber | null;
}

/** The price chart's main series, read from `CandleChart`'s own refs. */
function mainSeries(chart: MountedChart): ISeriesApi<SeriesType> {
  const node = chart.plot.parentElement!;
  const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
  assert.ok(key, "no fiber on the chart host");
  let fiber: Fiber | null | undefined = (node as unknown as Record<string, Fiber>)[key];
  while (fiber && !(typeof fiber.type === "function"
    && (fiber.type as { name?: string }).name === "CandleChart")) fiber = fiber.return;
  assert.ok(fiber, "no CandleChart above the host");
  let hook = fiber.memoizedState as { memoizedState: unknown; next: unknown } | null;
  while (hook) {
    const ref = hook.memoizedState as { current?: unknown } | null;
    const value = ref && typeof ref === "object" && "current" in ref ? ref.current : null;
    if (value && typeof (value as ISeriesApi<SeriesType>).coordinateToPrice === "function"
      && typeof (value as ISeriesApi<SeriesType>).seriesType === "function"
      && (value as ISeriesApi<SeriesType>).seriesType() === "Candlestick") {
      return value as ISeriesApi<SeriesType>;
    }
    hook = hook.next as typeof hook;
  }
  throw new Error("no main series ref on CandleChart");
}

/** The price axis's top canvas — the element the library's axis listens on. */
function axisCanvas(chart: MountedChart): HTMLElement {
  const canvas = chart.plot.querySelector<HTMLElement>(
    "tr:first-child > td:nth-child(3) canvas:nth-of-type(2)");
  assert.ok(canvas, "the price axis has no top canvas");
  return canvas;
}

const span = (series: ISeriesApi<SeriesType>): number =>
  Math.abs(Number(series.coordinateToPrice(100)) - Number(series.coordinateToPrice(400)));

const axisLabel = (): string =>
  screen.getByRole("group", { name: /^Price scale — / }).getAttribute("aria-label") ?? "";

test("B-07 — A PRICE-AXIS DRAG CHANGES THE VISIBLE PRICE SPAN, AND THE BADGE FOLLOWS", async () => {
  const chart = await mountChart();
  const series = mainSeries(chart);
  const price = chartsIn(chart.container).get("price")!;
  assert.equal(price.priceScale("right").options().autoScale, true);
  const before = span(series);
  assert.ok(Number.isFinite(before) && before > 0, "the fixture's scale has no span");

  const axis = axisCanvas(chart);
  await act(async () => {
    fireEvent.mouseEnter(axis, { clientX: 1_240, clientY: 300 });
    fireEvent.mouseMove(axis, { clientX: 1_240, clientY: 300, bubbles: true });
    fireEvent.mouseDown(axis, { button: 0, clientX: 1_240, clientY: 300, bubbles: true });
  });
  for (const y of [340, 400, 460, 500]) {
    await act(async () => {
      fireEvent.mouseMove(document.documentElement,
        { buttons: 1, clientX: 1_240, clientY: y, bubbles: true });
    });
  }
  await act(async () => {
    fireEvent.pointerUp(axis, { button: 0, clientX: 1_240, clientY: 500, bubbles: true });
    fireEvent.mouseUp(document.documentElement, { button: 0, clientX: 1_240, clientY: 500, bubbles: true });
  });
  await settle();

  assert.equal(price.priceScale("right").options().autoScale, false,
    "an axis drag switches auto-fit off");
  const after = span(series);
  assert.ok(Math.abs(after - before) > before * 0.05,
    `the drag flipped autoScale off but left the visible span at ${after} (was ${before})`);
  assert.match(axisLabel(), /Manual$/, "the badge must follow the drag");
});
