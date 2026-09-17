import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { assertAbsent, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";
import { giveLayout } from "./harness/register";
import { WORKSPACE_STORAGE_KEY } from "@/lib/workspace";

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

  assert.equal(chart.container.querySelector("[data-watchlist]") === null, true,
    "a persisted desktop watchlist must not mount at phone width");
  assert.equal(chart.container.querySelector("[data-drawing-rail]") === null, true,
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
  assert.equal(chart.container.querySelector("[data-watchlist]") === null, true,
    "tapping Watchlist again must close the sheet");
});

test("the phone More menu reaches correlation, objects and focused-pane maximize", async () => {
  const chart = await mountChart();

  const openMore = async (): Promise<void> => {
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await settle();
    assert.ok(screen.getByRole("menu", { name: "More chart tools" }));
  };

  await openMore();
  fireEvent.click(screen.getByRole("menuitem", { name: "Correlation" }));
  await settle();
  assert.ok(screen.getByRole("region", { name: "correlation panel" }));
  assertAbsent(screen.queryByRole("menu", { name: "More chart tools" }),
    "choosing a phone route left its menu over the destination");

  await openMore();
  fireEvent.click(screen.getByRole("menuitem", { name: "Object tree and Data window" }));
  await settle();
  assert.ok(screen.getByRole("region", { name: "objects panel" }));

  await openMore();
  fireEvent.click(screen.getByRole("menuitem", { name: "Maximize focused pane" }));
  await settle();
  const stored = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "null") as {
    activePaneId?: string; maximizedPaneId?: string | null;
  } | null;
  assert.ok(stored?.activePaneId, "the workspace did not persist its focused pane");
  assert.equal(stored?.maximizedPaneId, stored?.activePaneId,
    "the phone maximize route targeted something other than the focused pane");
  assert.equal(chart.container.querySelectorAll("[data-pane-id]").length, 1);
});
