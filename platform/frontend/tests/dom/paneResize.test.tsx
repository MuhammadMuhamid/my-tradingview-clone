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
