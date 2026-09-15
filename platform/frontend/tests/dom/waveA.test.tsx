import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";
import { giveLayout } from "./harness/register";

const desktopMatchMedia = window.matchMedia;

beforeEach(() => {
  resetBrowser();
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 767px)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!]);
});

after(() => {
  window.matchMedia = desktopMatchMedia;
  closeBrowser();
});

test("A-02 — phone load hides the desktop panel and drawing rail", async () => {
  const chart = await mountChart();
  await settle();

  assert.equal(chart.container.querySelector("[data-watchlist]"), null,
    "a persisted desktop watchlist must not mount at phone width");
  assert.equal(chart.container.querySelector("[data-drawing-rail]"), null,
    "the desktop drawing rail must not mount at phone width");

  const chartColumn = chart.container.querySelector<HTMLElement>("[data-chart-column]");
  assert.ok(chartColumn, "the chart column is missing");
  giveLayout(chartColumn, { width: 390, height: 792 });
  assert.ok(chartColumn.getBoundingClientRect().width >= 330,
    "the chart should fill the phone instead of being squeezed by a docked panel");
});

test("A-02 — the Watchlist bottom tab opens and closes a full-width sheet", async () => {
  const chart = await mountChart();
  await settle();

  const tab = screen.getByRole("button", { name: "Watchlist" });
  fireEvent.click(tab);
  await settle();
  const sheet = chart.container.querySelector<HTMLElement>("[data-watchlist]");
  assert.ok(sheet, "the Watchlist tab did not open the sheet");
  assert.equal(sheet.className.includes("w-screen"), true,
    "the phone watchlist sheet must span the viewport");
  fireEvent.click(tab);
  await settle();
  assert.equal(chart.container.querySelector("[data-watchlist]"), null,
    "tapping Watchlist again must close the sheet");
});
