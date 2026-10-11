/**
 * A4: the series legend's `⋯` is the SERIES menu, and its rows act.
 *
 * It opened the chart's own context menu. Live Premium opens a menu about the
 * instrument, priced at its last value — see `seriesLegendMenu`. Driven
 * through the workspace, because what matters is that each row reaches the
 * surface it names.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { chooseMenuItem, menuItems, menuLabel, mountChart, press } from "./harness/chart";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

async function openSeriesMenu(): Promise<void> {
  await mountChart();
  await settle();
  const more = screen.getAllByRole("button", { name: "More for SOLUSDT" })[0];
  assert.ok(more, "the series legend has no More");
  fireEvent.click(more);
  await settle();
}

test("A4 — More opens the series menu, not the chart's", async () => {
  await openSeriesMenu();
  assert.equal(menuLabel(), "SOLUSDT series", "More opened some other menu");
  const labels = menuItems().map((i) => i.label);
  assert.match(labels[0] ?? "", /^Add alert on SOLUSDT at [\d,.]+…/,
    "the first row is the alert at the series' last price");
  assert.ok(labels.includes("Add indicator/strategy on SOLUSDT…"));
  assert.ok(labels.includes("Symbol info…"));
  assert.ok(labels.some((l) => /^Add text note for SOLUSDT/.test(l)));
  // The chart menu's own rows are not here.
  assert.ok(!labels.some((l) => /^Reset chart view|^Candlestick patterns|^Remove \d+ indicator/.test(l)),
    `the chart's rows leaked into the series menu: ${JSON.stringify(labels)}`);
  const panel = document.querySelector<HTMLElement>('[role="menu"]');
  assert.equal(panel?.style.width, "325px", "the series menu is the chart menu's width");
  await press("Escape");
});

test("A4 — Add indicator/strategy opens the indicator browser", async () => {
  await openSeriesMenu();
  await chooseMenuItem(/^Add indicator\/strategy on SOLUSDT/);
  await settle();
  assert.ok(screen.queryByRole("dialog"), "the row opened nothing");
});

test("A4 — Settings… opens Chart settings on its Symbol tab", async () => {
  await openSeriesMenu();
  await chooseMenuItem(/^Settings…/);
  await settle();
  const dialog = screen.getByRole("dialog");
  const selected = dialog.querySelector('[role="tab"][aria-selected="true"]');
  assert.match(selected?.textContent ?? "", /Symbol/);
});
