/**
 * The price axis's own pointer surfaces: the `⊕` at the crosshair's price and
 * the `A` / `L` / `%` chips at the axis foot (W2A-01, W2A-02).
 *
 * The geometry here is the library's own: `lightweight-charts` lays out the
 * pane table against the harness's fixed 1280×800 host, so the price axis's
 * width is whatever the library wrote on its cell's canvas, and a crosshair
 * move is a real `mousemove` on the plot canvas. Nothing is asserted about a
 * pixel; what is asserted is where the product PUT its controls relative to
 * the axis the library drew.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart, plotOf, type MountedChart } from "./harness/chart";

beforeEach(() => { resetBrowser(); server.setDefaultCandles(compactSeries(600)); });
after(closeBrowser);

/** The library's own price-axis cell and its width, as the library wrote it. */
function priceAxis(chart: MountedChart): { cell: HTMLElement; width: number } {
  const table = plotOf(chart.pane(0)).querySelector("table");
  assert.ok(table, "the chart host has no pane table");
  const row = table.rows[0]!;
  const cell = row.cells[row.cells.length - 1]!;
  const canvas = cell.querySelector("canvas");
  const width = parseFloat(canvas?.style.width ?? "");
  assert.ok(width > 0, "the library drew no price axis");
  return { cell, width };
}

/** Move the pointer over the plot, the way a crosshair is driven. */
async function hoverPlot(chart: MountedChart, x: number, y: number): Promise<void> {
  const cell = plotOf(chart.pane(0)).querySelector("table")!.rows[0]!.cells[1]!;
  for (const target of cell.querySelectorAll("canvas")) {
    fireEvent.mouseEnter(target, { clientX: x, clientY: y });
    fireEvent.mouseMove(target, { clientX: x, clientY: y, bubbles: true });
  }
  await settle();
}

test("W2A-01 — the ⊕ sits on the plot side of the axis, never over its labels", async () => {
  const chart = await mountChart();
  const axis = priceAxis(chart);
  await hoverPlot(chart, 300, 200);

  const plus = chart.pane(0).querySelector<HTMLButtonElement>("button[data-axis-plus]");
  assert.ok(plus, "hovering the plot puts the axis ⊕ on screen");
  assert.match(plus.getAttribute("aria-label") ?? "", /^Create price alert at [\d,.]+$/,
    "it keeps an accessible name carrying the price it will alert at");
  /*
   * The button is 20px wide and anchored by `right` against the host the
   * axis is the right-most column of. Its right edge must be at or left of
   * the axis's inner edge, so no part of it covers a tick or the crosshair's
   * own label. It used to be `right-0` pulled in by half its width — 10 to
   * 30px inside a 76px axis, over the label's last digits.
   */
  const right = parseFloat(plus.style.right);
  assert.ok(Number.isFinite(right), `anchored from the axis side: ${plus.getAttribute("style")}`);
  assert.ok(right >= axis.width,
    `the ⊕'s right edge (${right}px from the edge) is outside the ${axis.width}px axis`);
  assert.ok(right - axis.width <= 4, "and beside it, not floating out into the plot");
  assert.equal(plus.style.transform, "", "no transform drags it back over the axis");

  fireEvent.click(plus);
  await settle();
  assert.ok(screen.getByRole("dialog"), "and it is still the axis route to an alert");
});

test("W2A-02 — the axis chips light for the WHOLE axis, not only their own box", async () => {
  const chart = await mountChart();
  const axis = priceAxis(chart);
  const strip = (): HTMLElement =>
    chart.pane(0).querySelector<HTMLElement>("[data-axis-buttons]")!;
  assert.ok(strip(), "the strip is rendered");
  assert.match(strip().className, /opacity-0/, "at rest the chips are hidden");

  // High on the axis — well clear of the strip's own box at the foot.
  const host = plotOf(chart.pane(0)).getBoundingClientRect();
  fireEvent.mouseMove(axis.cell, { clientX: host.width - axis.width / 2, clientY: 60, bubbles: true });
  await settle();
  assert.equal(strip().hasAttribute("data-axis-hover"), true, "the pointer is on the axis");
  assert.doesNotMatch(strip().className, /opacity-0/, "and the chips are lit for it");

  // Back onto the plot: the axis is no longer hovered and the chips fade.
  fireEvent.mouseMove(axis.cell, { clientX: 300, clientY: 60, bubbles: true });
  await settle();
  assert.equal(strip().hasAttribute("data-axis-hover"), false);
  assert.match(strip().className, /opacity-0/);

  // The chips are the reference's square A / L, with % beside them, and
  // every one keeps a name that says what it does.
  const chips = [...strip().querySelectorAll<HTMLButtonElement>("button[data-axis-chip]")];
  assert.deepEqual(chips.map((b) => b.textContent?.trim()), ["A", "L", "%"]);
  assert.deepEqual(chips.map((b) => b.getAttribute("aria-label")),
    ["Auto scale", "Log scale", "Percent scale"]);
  assert.equal(chips[0]!.getAttribute("aria-pressed"), "true", "auto is on by default");
  fireEvent.click(chips[1]!);
  await settle();
  assert.equal(screen.getByRole("button", { name: "Log scale" }).getAttribute("aria-pressed"), "true",
    "L still switches the axis to logarithmic");
});
