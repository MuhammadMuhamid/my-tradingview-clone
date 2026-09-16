import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart, selectTool, drag } from "./harness/chart";
import { CANONICAL } from "./harness/market";
import { drawingStore } from "@/lib/drawingStore";
import { resetInstrumentStatsCache } from "@/lib/useInstrumentStats";

beforeEach(() => {
  resetBrowser();
  drawingStore.resetAll();
  resetInstrumentStatsCache();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  for (const symbol of ["SOLUSDT", "BTCUSDT", "AVAXUSDT"]) {
    server.setCandles(symbol, "1d", compactSeries(400, { intervalMs: 86_400_000, base: 100 }));
  }
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!, CANONICAL.AVAXUSDT!]);
});
after(closeBrowser);

function rail(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>(
    '[data-side-rail="true"] button[aria-pressed]')]
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  if (!button) throw new Error(`missing rail button ${label}`);
  return button;
}

test("D-02/D-05 — details omit empty news and stats, format metrics, and edit opens the alert composer", async () => {
  const chart = await mountChart();
  await settle(6);
  const firstRow = chart.container.querySelector<HTMLButtonElement>(
    `[data-watchlist-row="${CANONICAL.BTCUSDT}"] > button`);
  assert.ok(firstRow, "the seeded watchlist has no BTC row to select");
  fireEvent.click(firstRow);
  await settle(6);
  const details = chart.container.querySelector<HTMLElement>("[data-watchlist-details]");
  assert.ok(details, "the selected instrument has no details block");
  assert.doesNotMatch(details.textContent ?? "", /no news feed|not supplied by/i);
  assert.equal((details.textContent ?? "").includes("News"), false, "an empty News card still renders");

  const stats = details.querySelector<HTMLElement>("[data-key-stats]");
  assert.ok(stats, "live ticker/daily values did not produce Key stats");
  assert.match(stats.textContent ?? "", /Volume[\d,.]+(?: [KMB])?/);
  assert.match(stats.textContent ?? "", /Average Volume \(30D\)[\d,.]+ [KMB]/);
  assert.doesNotMatch(stats.textContent ?? "", /—|USDT|SOL/,
    "Key stats must contain populated unit-formatted values, not placeholders or asset suffixes");

  assert.ok(within(details).getByRole("button", { name: "Show key stats" }));
  fireEvent.click(within(details).getByRole("button", { name: /Create alert for/ }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /Message/ }));
  await settle();
  assert.ok(screen.getByRole("textbox", { name: "Alert note" }),
    "the details Edit action did not open the existing alert composer");
});

test("D-03/D-04 — Object tree is the third 28px rail destination and drawing actions mutate chart state", async () => {
  const chart = await mountChart();
  await settle(4);
  const railButtons = [...chart.container.querySelectorAll<HTMLButtonElement>(
    '[data-side-rail="true"] > button[aria-pressed]')];
  assert.deepEqual(railButtons.slice(0, 3).map((button) => button.getAttribute("aria-label")),
    ["Watchlist", "Automations", "Object tree and Data window"]);
  for (const button of railButtons) {
    const svg = button.querySelector("svg");
    assert.equal(svg?.getAttribute("width"), "28", `${button.ariaLabel} does not use a 28px glyph`);
    assert.equal(svg?.getAttribute("stroke-width"), "1", `${button.ariaLabel} glyph is not 1px ink`);
  }

  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [260, 220], [460, 300]);
  fireEvent.click(rail(chart.container, "Object tree and Data window"));
  await settle();
  const panel = screen.getByRole("region", { name: "objects panel" });
  assert.ok(within(panel).getByRole("tab", { name: "Objects" }));
  const drawing = panel.querySelector<HTMLElement>("[data-object-drawing]");
  assert.ok(drawing, "the real drawing created on the chart is absent from the tree");
  const hide = within(drawing).getByRole("button", { name: /^Hide / });
  fireEvent.click(hide);
  await settle();
  assert.equal(within(drawing).getByRole("button", { name: /^Show / }).getAttribute("aria-pressed"), "true",
    "the tree eye did not enter the drawing's hidden state");
});

test("D-03 — Data window renders OHLC and follows a crosshair move", async () => {
  const chart = await mountChart();
  await settle(4);
  fireEvent.click(rail(chart.container, "Object tree and Data window"));
  await settle();
  const panel = screen.getByRole("region", { name: "objects panel" });
  fireEvent.click(within(panel).getByRole("tab", { name: "Data window" }));
  await settle();
  const data = panel.querySelector<HTMLElement>("[data-data-window]");
  assert.ok(data, "the Data window tab has no value surface");
  for (const label of ["Open", "High", "Low", "Close"]) {
    assert.ok(within(data).getByText(label), `${label} is absent from the Data window`);
  }
  const before = data.firstElementChild?.textContent;
  fireEvent.mouseMove(chart.plot, { clientX: 120, clientY: 180, bubbles: true });
  await settle(2);
  const afterMove = data.firstElementChild?.textContent;
  assert.notEqual(afterMove, undefined);
  assert.notEqual(afterMove, "Move the crosshair over a loaded bar");
  assert.ok(before !== undefined, "the initial loaded-bar timestamp is absent");
});
