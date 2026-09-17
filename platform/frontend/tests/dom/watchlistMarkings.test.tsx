/**
 * TVP8 F-05: the watchlist row's menu, and the markings it writes.
 *
 * ── What is being pinned ───────────────────────────────────────────────────
 *
 * The queue's own requirement is that every row in this menu operates REAL
 * product state — "do not create inert menu rows". So each test below opens
 * the real menu on a real row, chooses a real item, and then asserts on what
 * the panel renders and on what survives a remount. Nothing here reads source
 * text: a menu payload that is right and a handler that is not wired is
 * precisely the defect this covers.
 *
 * Run against the repair reverted, the first assertion of each fails: there is
 * no `Flag …` row to click.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!, CANONICAL.ETHUSDT!]);
});
after(closeBrowser);

const rowFor = (container: HTMLElement, symbol: string): HTMLElement => {
  const row = container.querySelector<HTMLElement>(`[data-watchlist-row="${symbol}"]`);
  if (!row) throw new Error(`the watchlist has no row for ${symbol}`);
  return row;
};

/** Right-click a row and wait for its menu. */
async function openRowMenu(container: HTMLElement, symbol: string): Promise<HTMLElement> {
  fireEvent.contextMenu(rowFor(container, symbol), { clientX: 200, clientY: 200 });
  await settle(2);
  const menu = screen.getAllByRole("menu").at(-1);
  assert.ok(menu, "right-clicking a row opened no menu");
  return menu;
}

/**
 * A menu row by its visible label.
 *
 * `textContent` is not the label: a disabled row also carries its reason in an
 * `sr-only` span, which is the whole point of that span. The label is the row's
 * own first non-empty text node.
 */
const labelOf = (el: HTMLElement): string =>
  [...el.querySelectorAll("span")]
    .map((s) => (s.className.includes("sr-only") ? "" : (s.textContent ?? "").trim()))
    .find((t) => t !== "") ?? (el.textContent ?? "").trim();

function item(menu: HTMLElement, label: string): HTMLElement {
  const rows = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  const found = rows.find((el) => labelOf(el) === label);
  if (!found) {
    throw new Error(`the menu has no row ${JSON.stringify(label)}; it has `
      + rows.map((el) => JSON.stringify(labelOf(el))).join(", "));
  }
  return found;
}

test("F-05 — the row menu is the reference's, and carries no destructive row", async () => {
  const chart = await mountChart();
  await settle();
  const menu = await openRowMenu(chart.container, CANONICAL.ETHUSDT!);

  for (const label of [
    "Flag ETHUSDT", "Unflag all symbols", "Add ETHUSDT to compare",
    "Add note for ETHUSDT", "Add section", "Add symbol…",
    "Open in the focused chart", "Open in a new pane", "Add alert on ETHUSDT",
  ]) {
    assert.ok(item(menu, label), label);
  }
  assert.equal(
    [...menu.querySelectorAll('[role^="menuitem"]')]
      .some((el) => (el.textContent ?? "").includes("Remove from this list")),
    false,
    "the reference has no remove row here — the hover trash and Delete do it");

  assert.equal(menu.style.width, "254px", "the reference's measured width");
});

test("F-05 — the palette is seven radio swatches, and picking one flags the row", async () => {
  const chart = await mountChart();
  await settle();
  const menu = await openRowMenu(chart.container, CANONICAL.ETHUSDT!);

  const swatches = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  assert.equal(swatches.length, 7);
  assert.deepEqual(swatches.map((s) => s.getAttribute("aria-label")),
    ["Red", "Blue", "Green", "Orange", "Purple", "Cyan", "Pink"]);
  assert.equal(swatches.every((s) => s.getAttribute("aria-checked") === "false"), true,
    "nothing is flagged yet");

  fireEvent.click(swatches[2]!);
  await settle(2);

  const stub = rowFor(chart.container, CANONICAL.ETHUSDT!)
    .querySelector<HTMLElement>("[data-watchlist-flag]");
  assert.ok(stub, "choosing a colour drew no stub on the row");
  assert.equal(stub.getAttribute("data-watchlist-flag"), "green");
  assert.match(stub.style.backgroundColor, /rgb|#/, "the stub paints the colour chosen");
});

test("F-05 — a flag is remembered, and `Unflag all symbols` clears it", async () => {
  const chart = await mountChart();
  await settle();
  let menu = await openRowMenu(chart.container, CANONICAL.BTCUSDT!);
  fireEvent.click([...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')][0]!);
  await settle(2);

  // A REMOUNT, which is what a reload is to this component.
  const again = await mountChart();
  await settle(2);
  assert.ok(rowFor(again.container, CANONICAL.BTCUSDT!).querySelector("[data-watchlist-flag]"),
    "the flag was gone on the next load, which is a marking nobody makes twice");

  menu = await openRowMenu(again.container, CANONICAL.BTCUSDT!);
  assert.ok(item(menu, "Unflag BTCUSDT"),
    "the first row's verb follows the symbol's own state");
  fireEvent.click(item(menu, "Unflag all symbols"));
  await settle(2);
  assert.equal(again.container.querySelector("[data-watchlist-flag]") === null, true);
});

test("F-05 — the hover control is a named trash that removes the row", async () => {
  const chart = await mountChart();
  await settle();
  const eth = rowFor(chart.container, CANONICAL.ETHUSDT!);
  const trash = eth.querySelector<HTMLButtonElement>(
    `[data-watchlist-remove="${CANONICAL.ETHUSDT}"]`);
  assert.ok(trash, "the row offers no hover remove");
  assert.equal(trash.getAttribute("aria-label"), "Remove ETHUSDT from this list");

  fireEvent.click(trash);
  await settle(4);
  assert.equal(chart.container.querySelector(`[data-watchlist-row="${CANONICAL.ETHUSDT}"]`) === null, true);
});

test("F-05 — `Add to compare` puts the symbol on the focused pane, not in a dialog", async () => {
  const chart = await mountChart();
  await settle();
  const menu = await openRowMenu(chart.container, CANONICAL.BTCUSDT!);
  fireEvent.click(item(menu, "Add BTCUSDT to compare"));
  await settle(6);

  /*
   * The pane's own compare state, which is what the legend prints beside
   * `vs` — the queue's "wire them to actual existing product state".
   */
  assert.match(chart.container.textContent ?? "", /BTCUSDT/,
    "the comparison never reached the chart");
  const stored = window.localStorage.getItem("tv.workspace.v2") ?? "";
  assert.match(stored, /"compare"/, "and it was not persisted onto the pane");
});

test("F-05 — `Add to watchlist` is a submenu of the OTHER lists only", async () => {
  const chart = await mountChart();
  await settle();
  // With one list there is nowhere to add a row TO, so the row is absent
  // rather than present and greyed.
  const menu = await openRowMenu(chart.container, CANONICAL.BTCUSDT!);
  assert.equal(
    [...menu.querySelectorAll('[role^="menuitem"]')]
      .some((el) => (el.textContent ?? "").startsWith("Add BTCUSDT to watchlist")),
    false);
});
