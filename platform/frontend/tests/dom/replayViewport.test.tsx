/**
 * Leaving a Replay puts the chart back where the reader left it.
 *
 * ── B-02 ───────────────────────────────────────────────────────────────────
 *
 * Replay → Start → step three bars → Exit, twice, and the live chart was left
 * showing two candles across 1,334 pixels — a bar spacing of about 630px. The
 * first exit had already halved the window, two days to one. Each session
 * moved the viewport to keep the horizon on screen (correctly), and nothing
 * ever moved it back, so every session compounded the last.
 *
 * The chart now snapshots its window on the way in and restores it on the way
 * out — the same bars, anchored by time, so a window whose bars moved in the
 * array still lands on them. The windows are read from the charts themselves
 * (`harness/timeScales`); the plot is canvas and the DOM cannot say.
 *
 * ── B-14 ───────────────────────────────────────────────────────────────────
 *
 * And it leaves the side panel alone: entering Replay used to close the
 * Objects / Data window panel, which is the panel a person reading replayed
 * bars most wants open, and exiting did not bring it back.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { advance, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";
import { priceView } from "./harness/timeScales";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(900));
});
after(closeBrowser);

async function replayCycle(chart: MountedChart, steps: number): Promise<void> {
  const open = chart.container.querySelector<HTMLElement>('button[aria-label="Bar replay"]');
  assert.ok(open, "the toolbar has no Replay control");
  fireEvent.click(open);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Start Replay" }));
  await settle();
  await advance(50);
  for (let i = 0; i < steps; i += 1) {
    fireEvent.click(screen.getAllByRole("button", { name: "Next replay candle" })[0]!);
    await settle();
    await advance(20);
  }
  fireEvent.click(screen.getAllByRole("button", { name: "Exit Replay" })[0]!);
  await settle();
  await advance(50);
}

test("B-02 — two Replay sessions leave the live chart on the window it started on", async () => {
  const chart = await mountChart();
  // A reader's own window, not the opening fit: zoomed in near the live edge.
  const zoomHost = chart.plot;
  for (let i = 0; i < 3; i += 1) {
    fireEvent.wheel(zoomHost, { deltaY: -120, clientX: 900, bubbles: true, cancelable: true });
    await advance(20);
  }
  const before = priceView(chart.container);
  assert.ok(before.to - before.from > 0, "the chart shows no window to keep");

  await replayCycle(chart, 3);
  const once = priceView(chart.container);
  assert.deepEqual({ first: once.from, last: once.to }, { first: before.from, last: before.to },
    "the first Replay session moved the live window and left it moved");

  await replayCycle(chart, 3);
  const twice = priceView(chart.container);
  assert.deepEqual({ first: twice.from, last: twice.to }, { first: before.from, last: before.to },
    "a second Replay session compounded the first");
  assert.ok(Math.abs(twice.barSpacing - before.barSpacing) < 1e-6,
    `the bar spacing drifted from ${before.barSpacing} to ${twice.barSpacing}`);
});

test("B-14 — entering Replay leaves the Objects panel open, and exiting keeps it", async () => {
  const chart = await mountChart();
  const objects = chart.container.querySelector<HTMLElement>(
    'button[aria-label="Object tree and Data window"]');
  assert.ok(objects, "the rail has no Object tree control");
  fireEvent.click(objects);
  await settle();
  assert.ok(chart.container.querySelector('[aria-label="objects panel"]'),
    "the Objects panel did not open");

  const open = chart.container.querySelector<HTMLElement>('button[aria-label="Bar replay"]');
  fireEvent.click(open!);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Start Replay" }));
  await settle();
  assert.ok(chart.container.querySelector('[aria-label="objects panel"]'),
    "entering Replay closed the Objects panel");

  fireEvent.click(screen.getAllByRole("button", { name: "Exit Replay" })[0]!);
  await settle();
  assert.ok(chart.container.querySelector('[aria-label="objects panel"]'),
    "the Objects panel was not there after Replay ended");
});
