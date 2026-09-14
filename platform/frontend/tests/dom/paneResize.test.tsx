/**
 * The resize axis is executable.
 *
 * ── TVP8 IO-RESIZE-COV ─────────────────────────────────────────────────────
 *
 * Until this file, `ResizeObserver` in the DOM harness was a no-op: nothing
 * was ever delivered, so every effect in the product that reacts to a box
 * changing size — the pane's density, the layers' repaints, the library's own
 * `autoSize` — ran its registration and then nothing else. A test could delete
 * the reaction and stay green. Two behavioural tests were deleted in the last
 * session for want of this.
 *
 * `harness/register.ts` now delivers entries on a test's say-so, and these two
 * tests are the proof that the delivery reaches the product's own reactions:
 * one in a component this repository owns, one in the library the chart is
 * drawn by. Each was run against a deliberately broken reaction first and
 * failed — see the commit for the perturbations.
 *
 * No pixel is asserted. What is asserted is the DECISION the product makes
 * from a size: a pane 300px wide is a `small` pane, and a small pane gives the
 * range bar under its plot back to the plot — `CandleChart`'s own rule, made
 * from `ChartPane`'s own measurement.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { within } from "@testing-library/react";
import {
  assertAbsent, assertPresent, closeBrowser, compactSeries, observedElements, resetBrowser,
  resize, server,
} from "./harness/env";
import { mountChart } from "./harness/chart";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
});
after(closeBrowser);

/**
 * The range bar under the plot — `1D 5D 1M …` and the price-scale group — which
 * `CandleChart` shows only on a `large` pane (`showBottomBar = !compact`, and
 * `compact` is `density !== "large"`). It is the product's own decision made
 * from the measured box: a pane below 640×380 gives that row back to the plot.
 */
const rangeBar = (pane: HTMLElement): HTMLElement | null =>
  within(pane).queryByRole("group", { name: "Visible range" });

test("A PANE SQUEEZED TO 300PX GIVES ITS RANGE BAR BACK TO THE PLOT, AND SHOWS IT AGAIN WHEN IT GROWS", async () => {
  const chart = await mountChart();
  const pane = chart.pane(0);
  assert.equal(observedElements().includes(pane), true,
    "the pane must observe its own root — density is derived from its measured box");

  assertPresent(rangeBar(pane),
    "at 1280×800 the pane is `large` and the range bar is shown under the plot");

  await resize(pane, { width: 300, height: 200 });
  assertAbsent(rangeBar(pane),
    "at 300×200 the pane is `small`: the range bar must be dropped");

  await resize(pane, { width: 1280, height: 800 });
  assertPresent(rangeBar(pane),
    "grown back to 1280×800 the range bar must return");
});

test("THE RANGE ROW IS ALWAYS NINE CHIPS; THE ONES THIS PANE CANNOT FILL ARE DISABLED", async () => {
  /*
   * TVP8 R1-11. The row used to render `availableRangeShortcuts()`, so the
   * BUTTONS changed with the pane's history: seventy-five hours of 15m bars
   * produced `1D All` and nothing else, and `5Y` did not exist anywhere in the
   * product at 1h either. A row that is sometimes two wide and sometimes nine
   * reads as a row that has lost something, and it moves the target the eye is
   * already aiming at.
   *
   * The rule the module exists to hold is untouched — a range the loaded
   * window cannot fill still cannot be applied. What changed is that the
   * refusal is now VISIBLE and announced, instead of being an absence.
   */
  const chart = await mountChart();
  const bar = rangeBar(chart.pane(0));
  assertPresent(bar, "the pane is large, so the range row is under its plot");

  const chips = within(bar!).getAllByRole("button");
  assert.deepEqual(chips.map((c) => c.textContent),
    ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "All"],
    "all nine, in the reference's order, whatever this pane has loaded");

  // 300 bars of 15m is about three days: one day fits, five do not, and `All`
  // is always honourable because it is the loaded window by definition.
  const state = (label: string): { disabled: boolean; announced: string | null } => {
    const chip = chips.find((c) => c.textContent === label);
    if (!chip) throw new Error(`no ${label} chip`);
    return {
      disabled: (chip as HTMLButtonElement).disabled,
      announced: chip.getAttribute("aria-disabled"),
    };
  };
  assert.deepEqual(state("1D"), { disabled: false, announced: "false" });
  assert.deepEqual(state("All"), { disabled: false, announced: "false" });
  for (const label of ["5D", "1M", "3M", "6M", "YTD", "1Y", "5Y"]) {
    assert.deepEqual(state(label), { disabled: true, announced: "true" },
      `${label} is beyond this pane's loaded history and must be offered dead, not hidden`);
  }

  // The go-to-date control sits after the chips, outside the range group.
  assert.equal(within(bar!).queryByLabelText("Go to date"), null);
  assertPresent(within(chart.pane(0)).queryByLabelText("Go to date"),
    "the row carries a go-to-date control beside the ranges");
});

test("THE CHART IS RE-MEASURED WHEN ITS HOST CHANGES SIZE", async () => {
  const chart = await mountChart();
  const host = chart.plot.parentElement;
  assert.ok(host, "the chart host has no parent");
  assert.equal(observedElements().includes(host), true,
    "lightweight-charts (autoSize) must be observing the container the chart was created in");
  assert.equal(chart.plot.style.width, "1280px", "the chart was created at the harness's default box");

  await resize(host, { width: 640, height: 360 });
  assert.equal(chart.plot.style.width, "640px",
    "the library must resize the chart to the box its observer was handed");
  assert.equal(chart.plot.style.height, "360px");
});
