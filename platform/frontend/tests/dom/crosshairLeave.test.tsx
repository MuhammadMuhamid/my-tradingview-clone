/**
 * B-04: a hover ends when the pointer leaves the chart — after a drag-pan too.
 *
 * Reproduced by an independent reviewer: drag-pan, release, move the pointer
 * out of the chart, and the crosshair stayed on the bar the drag began at with
 * the legend on that bar's values, until the pointer re-entered and left again.
 * The library's own leave is not delivered in that sequence; the host's
 * `pointerleave` cleared only the drawn crosshair (`clearCrosshairPosition`
 * raises no event), so the legend, the study readouts and the cross-pane
 * broadcast all stayed on the old bar. The reference clears on the way out.
 *
 * The leave is fired at the HOST, never at the library's canvas, which is
 * exactly the delivery the defect lived in.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** The pane's status line: identity, the bar readout and the study legend. */
function legendText(chart: MountedChart): string {
  const legend = chart.pane(0).querySelector<HTMLElement>("[data-pane-legend]");
  assert.ok(legend, "the pane has no legend");
  return legend.parentElement!.parentElement!.textContent ?? "";
}

/** The price pane's top canvas — what lightweight-charts listens on. */
function paneCanvas(chart: MountedChart): HTMLElement {
  const canvas = chart.plot.querySelector<HTMLElement>(
    "tr:first-child > td:nth-child(2) canvas:nth-of-type(2)");
  assert.ok(canvas, "the price pane has no top canvas");
  return canvas;
}

/** The element `CandleChart` owns, around the library's own host. */
const hostOf = (chart: MountedChart): HTMLElement => chart.plot.parentElement!;

async function hoverThenDrag(chart: MountedChart): Promise<{ rest: string; hovered: string }> {
  const rest = legendText(chart);
  const canvas = paneCanvas(chart);
  fireEvent.mouseEnter(hostOf(chart), { clientX: 300, clientY: 300 });
  fireEvent.pointerEnter(hostOf(chart), { clientX: 300, clientY: 300 });
  fireEvent.mouseEnter(canvas, { clientX: 300, clientY: 300 });
  fireEvent.mouseMove(canvas, { clientX: 300, clientY: 300, bubbles: true });
  await settle();
  const hovered = legendText(chart);
  assert.notEqual(hovered, rest, "the fixture's hover must move the legend off the newest bar");
  // A drag-pan: press on the plot, move with the button held, release.
  fireEvent.mouseDown(canvas, { button: 0, clientX: 300, clientY: 300, bubbles: true });
  fireEvent.mouseMove(document.documentElement, { buttons: 1, clientX: 420, clientY: 300, bubbles: true });
  return { rest, hovered };
}

test("B-04 — RELEASED AND MOVED OFF THE CHART, THE LEGEND RETURNS TO THE NEWEST BAR", async () => {
  const chart = await mountChart();
  const { rest } = await hoverThenDrag(chart);
  fireEvent.mouseUp(document.documentElement, { button: 0, clientX: 420, clientY: 300, bubbles: true });
  await settle();

  // Out of the chart — delivered to the host only.
  fireEvent.pointerLeave(hostOf(chart), { clientX: 2_000, clientY: 300 });
  fireEvent.mouseLeave(hostOf(chart), { clientX: 2_000, clientY: 300 });
  await settle();
  assert.equal(legendText(chart), rest,
    "the legend stayed on the hovered bar after the pointer left the chart");
});

test("B-04 — A DRAG RELEASED OUTSIDE THE CHART ENDS THE HOVER", async () => {
  const chart = await mountChart();
  const { rest } = await hoverThenDrag(chart);
  // Released beyond the chart's box, with no leave delivered at all.
  fireEvent.pointerUp(window, { button: 0, clientX: 5_000, clientY: 5_000 });
  fireEvent.mouseUp(document.documentElement, { button: 0, clientX: 5_000, clientY: 5_000, bubbles: true });
  await settle();
  assert.equal(legendText(chart), rest,
    "a drag released outside the chart left the legend on the bar it began at");
});
