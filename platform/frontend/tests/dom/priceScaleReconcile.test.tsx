/**
 * ── W2D-06: a dragged price axis stops saying "Auto" when the drag ends ────
 *
 * Dragging the price axis is the library's own gesture
 * (`handleScale.axisPressedMouseMove.price`), and it switches the scale's
 * `autoScale` off without raising anything. The chart read it back only on a
 * crosshair move — which fires over a PANE, never over the axis where every
 * axis drag ends — so for as long as the pointer stayed off the plot (30 s+ in
 * the review) the axis group said `Linear · Auto` and Chart settings → Scales
 * showed `Auto scale` ticked over a scale that was not auto at all.
 *
 * The drag itself is the library's and runs unmodified; what the test does is
 * leave the library in the state that drag leaves it in, then end the gesture.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";
import { chartsIn } from "./harness/timeScales";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

const axisLabel = (): string =>
  screen.getByRole("group", { name: /^Price scale — / }).getAttribute("aria-label") ?? "";

/** What the library does to the scale during an axis drag (or a double-click). */
async function libraryAutoScale(chart: MountedChart, on: boolean): Promise<void> {
  const price = chartsIn(chart.container).get("price");
  assert.ok(price, "no price chart");
  await act(async () => { price.priceScale("right").applyOptions({ autoScale: on }); });
  assert.equal(price.priceScale("right").options().autoScale, on);
}

test("W2D-06 — releasing an axis drag on the axis reconciles the badge", async () => {
  const chart = await mountChart();
  assert.match(axisLabel(), /Linear · Auto$/);

  await libraryAutoScale(chart, false);
  // No crosshair move: the pointer is on the axis, and is released there.
  const axis = screen.getByRole("group", { name: /^Price scale — / });
  await act(async () => {
    fireEvent.pointerUp(axis, { bubbles: true });
    fireEvent.mouseUp(axis, { bubbles: true });
  });
  await settle();
  assert.match(axisLabel(), /Linear · Manual$/,
    "the badge still claims Auto over a scale the library has switched to manual");

  // And the double-click reset back to auto is read the same way.
  await libraryAutoScale(chart, true);
  await act(async () => { fireEvent.doubleClick(axis, { bubbles: true }); });
  await settle();
  assert.match(axisLabel(), /Linear · Auto$/);
});

test("W2D-06 — Chart settings opened after a drag shows the scale as it is", async () => {
  const chart = await mountChart();
  await libraryAutoScale(chart, false);
  // Opened by a click alone — no pointer release reaches the window first.
  const trigger = [...chart.container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.getAttribute("aria-label") === "Chart settings");
  assert.ok(trigger, "the chart settings action is missing from the toolbar");
  fireEvent.click(trigger);
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: /Scales and lines/ }));
  await settle();
  const box = screen.getByRole("checkbox", { name: "Auto scale" }) as HTMLInputElement;
  assert.equal(box.checked, false,
    "Scales showed Auto scale ticked over a scale the library had switched to manual");
});
