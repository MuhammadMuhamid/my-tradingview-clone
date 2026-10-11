/**
 * B-02: collapse, expand and maximise a study pane — and stay that way.
 *
 * Reproduced twice by the interaction reviewer against the running product:
 * `Collapse Relative Strength Index` took the pane to 12px, after which
 * `Expand` did nothing; and in a two-column layout the LEFT chart's
 * `Maximize` did nothing while the right chart's worked. Every route in — the
 * Manage panes menu, the double-click and ⌘ double-click — goes through the
 * one `CandleChart` reducer, so these drive the menu the way a person does:
 * a press on the pane (which also focuses that chart), then the click.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  advance, closeBrowser, compactSeries, resetBrowser, server, settle,
} from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";
import { createWorkspace, saveWorkspace } from "@/lib/workspace";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

async function addRsi(chart: MountedChart, paneIndex = 0): Promise<void> {
  const pane = chart.pane(paneIndex);
  fireEvent.pointerDown(pane);
  await settle();
  fireEvent.click(chart.container.querySelector<HTMLElement>('button[aria-label="Indicators"]')!);
  await settle();
  const dialog = screen.getByRole("dialog");
  // Once added, the dialog also lists it under recents; either row adds it.
  fireEvent.click(within(dialog).getAllByRole("button", { name: "Relative Strength Index" })[0]!);
  await settle();
  fireEvent.keyDown(document, { key: "Escape" });
  await settle();
  await advance(1_500);
  await settle();
}

function rsiPane(scope: HTMLElement): HTMLElement {
  const pane = scope.querySelector<HTMLElement>(
    "section[aria-label='Relative Strength Index indicator pane']");
  assert.ok(pane, "no RSI pane in this chart");
  return pane;
}

/** Press, then click — the pointer's own order, which focuses the chart first. */
async function pressAndClick(el: HTMLElement): Promise<void> {
  fireEvent.pointerDown(el);
  await settle();
  fireEvent.click(el);
  await settle();
}

async function paneMenuRow(scope: HTMLElement, label: RegExp): Promise<void> {
  const manage = rsiPane(scope).querySelector<HTMLElement>("[data-pane-buttons] button");
  assert.ok(manage, "the pane has no Manage panes button");
  await pressAndClick(manage);
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Manage panes"]');
  assert.ok(menu, "Manage panes opened nothing");
  const row = [...menu.querySelectorAll<HTMLButtonElement>("button.tvc-menu-row")]
    .find((r) => label.test(r.textContent ?? ""));
  assert.ok(row, `no ${label} row: ${menu.textContent}`);
  fireEvent.click(row);
  await settle();
}

const heightOf = (pane: HTMLElement): string => pane.style.height;

test("B-02 — collapse, then expand, restores the pane's own height", async () => {
  const chart = await mountChart();
  await addRsi(chart);
  const before = heightOf(rsiPane(chart.container));
  assert.match(before, /^\d+px$/);

  await paneMenuRow(chart.container, /^Collapse pane/);
  const collapsed = rsiPane(chart.container);
  assert.equal(heightOf(collapsed), "24px", "collapsed is the header's height");
  // A collapsed pane holds its 24px: it does not shrink to 12 under the
  // stack's cap, where its controls ran under the next pane's resize grip.
  assert.match(collapsed.className, /\bshrink-0\b/);
  // And the button paints above every pane's resize grip (z-20), which is
  // what turned the Expand click into a resize drag.
  const grip = document.querySelector<HTMLElement>("button[aria-label^='Resize ']");
  const cluster = collapsed.querySelector<HTMLElement>("[data-pane-buttons]")!;
  const z = (el: HTMLElement | null): number =>
    Number(/\bz-\[?(\d+)\]?/.exec(el?.className ?? "")?.[1] ?? 0);
  assert.ok(z(cluster) > Math.max(20, z(grip)), `cluster z ${z(cluster)} vs grip z ${z(grip)}`);

  await paneMenuRow(chart.container, /^Expand pane/);
  assert.equal(heightOf(rsiPane(chart.container)), before, "Expand did not give the height back");
  assert.doesNotMatch(rsiPane(chart.container).className, /\bshrink-0\b/);

  // The gestures take the same path, both directions.
  const plot = rsiPane(chart.container).querySelector<HTMLElement>("section > div.absolute.inset-0")!;
  fireEvent.doubleClick(plot, { clientX: 50, clientY: 30, metaKey: true });
  await settle();
  assert.equal(heightOf(rsiPane(chart.container)), "24px");
  const cover = rsiPane(chart.container).querySelector<HTMLElement>("[data-pane-collapsed-cover]")!;
  fireEvent.doubleClick(cover, { clientX: 50, clientY: 10, metaKey: true });
  await settle();
  assert.equal(heightOf(rsiPane(chart.container)), before);
});

test("B-02 — Maximize on a collapsed pane expands it and gives it the column", async () => {
  const chart = await mountChart();
  await addRsi(chart);
  await paneMenuRow(chart.container, /^Collapse pane/);
  await paneMenuRow(chart.container, /^Maximize pane/);
  const pane = rsiPane(chart.container);
  assert.match(pane.className, /\bflex-1\b/, "the pane did not take the column");
  assert.equal(pane.querySelector("[data-pane-collapsed-cover]"), null, "still collapsed");
  await paneMenuRow(chart.container, /^Restore pane/);
  assert.doesNotMatch(rsiPane(chart.container).className, /\bflex-1\b/);
});

test("B-02 — a reload brings the pane back expanded, at its height", async () => {
  /*
   * Collapse and maximise are moment-to-moment (`SavedPaneLayout`): the
   * arrangement that survives a reload is the order and the heights. So a
   * pane collapsed before a reload comes back open — never stuck shut.
   */
  let chart = await mountChart();
  await addRsi(chart);
  const before = heightOf(rsiPane(chart.container));
  await paneMenuRow(chart.container, /^Collapse pane/);
  await advance(1_500);
  cleanup();
  chart = await mountChart();
  await advance(1_500);
  await settle();
  const pane = rsiPane(chart.container);
  assert.equal(heightOf(pane), before);
  assert.equal(pane.querySelector("[data-pane-collapsed-cover]"), null);
  await paneMenuRow(chart.container, /^Collapse pane/);
  assert.equal(heightOf(rsiPane(chart.container)), "24px", "and it still collapses");
});

test("B-02 — in a two-column layout the LEFT chart's Maximize acts on the left chart", async () => {
  saveWorkspace(createWorkspace({ symbol: "SOLUSDT", interval: "1h" }, "2-cols"));
  const chart = await mountChart();
  await settle();
  await addRsi(chart, 0);
  await addRsi(chart, 1);
  // The right chart is the focused one, as it was for the reviewer.
  fireEvent.pointerDown(chart.pane(1));
  await settle();

  await paneMenuRow(chart.pane(0), /^Maximize pane/);
  assert.match(rsiPane(chart.pane(0)).className, /\bflex-1\b/, "the left chart's pane did not maximise");
  assert.doesNotMatch(rsiPane(chart.pane(1)).className, /\bflex-1\b/, "the right chart's did instead");

  await paneMenuRow(chart.pane(0), /^Restore pane/);
  await paneMenuRow(chart.pane(1), /^Maximize pane/);
  assert.match(rsiPane(chart.pane(1)).className, /\bflex-1\b/);
  assert.doesNotMatch(rsiPane(chart.pane(0)).className, /\bflex-1\b/);

  // Collapse on the left, with the right focused.
  fireEvent.pointerDown(chart.pane(1));
  await settle();
  await paneMenuRow(chart.pane(0), /^Collapse pane/);
  assert.equal(heightOf(rsiPane(chart.pane(0))), "24px");
  await paneMenuRow(chart.pane(0), /^Expand pane/);
  assert.notEqual(heightOf(rsiPane(chart.pane(0))), "24px");
});
