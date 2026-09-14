/**
 * The two header menus, and what choosing a row in them does to the list.
 *
 * ── TVP8 R7b-08 ────────────────────────────────────────────────────────────
 *
 * The right actions were on the wrong buttons. The list's own NAME opened a
 * bare list of lists — so the control that says which list you are looking at
 * could not act on it — and `⋯`, which the reference fills with `Settings`,
 * held New / Rename / Delete list. There was no column or symbol-display
 * customisation in the product at all.
 *
 * This file drives the repaired pair the way a person does: open `⋯`, tick a
 * column, see the column; choose `Name`, see the names. Both preferences are
 * device-local, so the second assertion of each test is that they survive a
 * reload — a view that has to be re-chosen on every visit is not a preference.
 *
 * Run against the repair reverted, every test fails at its first step: there
 * is no menu named `Watchlist settings`.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!]);
});
after(closeBrowser);

/** A reload, as a browser does one: the document goes, the storage stays. */
function reload(): void { cleanup(); }

async function openSettings(container: HTMLElement): Promise<HTMLElement> {
  const button = container.querySelector<HTMLElement>('button[aria-label="Watchlist settings"]');
  assert.ok(button, "the watchlist header has no settings control — `⋯` still holds list editing");
  fireEvent.click(button);
  await settle();
  return screen.getByRole("menu", { name: "Watchlist settings" });
}

function menuRow(menu: HTMLElement, label: string): HTMLButtonElement {
  const found = [...menu.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => (b.textContent ?? "").trim() === label);
  if (!found) {
    throw new Error(`the settings menu has no ${JSON.stringify(label)} row; it has `
      + [...menu.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()).join(" · "));
  }
  return found;
}

const btcRow = (container: HTMLElement): HTMLElement => {
  const row = container.querySelector<HTMLElement>(`[data-watchlist-row="${CANONICAL.BTCUSDT}"]`);
  if (!row) throw new Error("the watchlist has no BTC row");
  return row;
};

test("R7b-08 — ticking Volume (24h) adds a fifth column with the provider's own figure", async () => {
  const chart = await mountChart();
  await settle(4);

  assert.equal(btcRow(chart.container).querySelector('[data-col="volume"]'), null,
    "Volume is the reference's own UNCHECKED column, so it must start absent");

  const menu = await openSettings(chart.container);
  fireEvent.click(menuRow(menu, "Volume (24h)"));
  await settle();

  const cell = btcRow(chart.container).querySelector('[data-col="volume"]');
  assert.ok(cell, "ticking Volume (24h) added no column");
  assert.notEqual((cell.textContent ?? "").trim(), "—",
    "the 24h volume already rides `useWatchlistTickers`; the column must read it, not a dash");

  reload();
  const second = await mountChart();
  await settle(4);
  assert.ok(btcRow(second.container).querySelector('[data-col="volume"]'),
    "a view that has to be re-chosen on every visit is not a preference");
});

test("R7b-08 — choosing Name writes the instrument's name in the row, not its ticker", async () => {
  const chart = await mountChart();
  await settle(4);
  assert.equal(
    (btcRow(chart.container).querySelector("[data-ticker]")?.textContent ?? "").trim(),
    "BTCUSDT");

  const menu = await openSettings(chart.container);
  fireEvent.click(menuRow(menu, "Name"));
  await settle();

  assert.equal(
    (btcRow(chart.container).querySelector("[data-ticker]")?.textContent ?? "").trim(),
    "Bitcoin / TetherUS",
    "`Symbol` and `Name` are the reference's two symbol-display choices");

  reload();
  const second = await mountChart();
  await settle(4);
  assert.equal(
    (btcRow(second.container).querySelector("[data-ticker]")?.textContent ?? "").trim(),
    "Bitcoin / TetherUS");
});

test("R7b-08 — the list NAME opens list editing, with the lists under a heading", async () => {
  const chart = await mountChart();
  await settle(4);

  const name = [...chart.container.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.getAttribute("aria-haspopup") === "menu"
      && (b.textContent ?? "").includes("Main Watchlist"));
  assert.ok(name, "the header has no list-name button");
  fireEvent.click(name);
  await settle();

  const menu = screen.getByRole("menu", { name: "My watchlists" });
  const rows = [...menu.querySelectorAll<HTMLButtonElement>("button")]
    .map((b) => (b.textContent ?? "").trim());
  assert.deepEqual(rows, [
    "Make a copy…", "Rename…", "Clear list", "Create new list…", "Main Watchlist", "Delete list",
  ], "list editing belongs on the control that names the list being edited");

  const current = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')][0];
  assert.equal(current?.getAttribute("aria-checked"), "true",
    "the current list is the checked radio — one of N, not N switches");
});

test("R7b-08 — the settings menu reports the state of the list it is looking at", async () => {
  const chart = await mountChart();
  await settle(4);

  const menu = await openSettings(chart.container);
  const state = (label: string): string | null =>
    menuRow(menu, label).getAttribute("aria-checked");
  assert.equal(state("Last"), "true");
  assert.equal(state("Change"), "true");
  assert.equal(state("Change %"), "true");
  assert.equal(state("Volume (24h)"), "false");
  assert.equal(state("Symbol"), "true");
  assert.equal(state("Name"), "false");
  assert.equal(state("Compact list"), "false");
});

test("R7b-08 — the header's compact cell and the menu's Compact list are ONE preference", async () => {
  const chart = await mountChart();
  await settle(4);

  const compact = chart.container.querySelector<HTMLElement>('button[aria-label="Compact list"]');
  assert.ok(compact, "the header has no compact toggle");
  fireEvent.click(compact);
  await settle();
  assert.equal(btcRow(chart.container).querySelector('[data-col="chg"]'), null,
    "compact is ticker and last price only");

  const menu = await openSettings(chart.container);
  assert.equal(menuRow(menu, "Compact list").getAttribute("aria-checked"), "true",
    "two controls for one preference must not be able to disagree about it");
});
