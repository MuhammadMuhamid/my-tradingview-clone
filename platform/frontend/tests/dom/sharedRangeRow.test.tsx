/**
 * One range row for the whole layout, acting on the focused chart (C11).
 *
 * Every pane at `large` density drew its own 38px `1D 5D 1M …` row and its own
 * clock, so a 2×2 at 1440×900 showed four rows and four clocks where the
 * reference shows one of each under the whole layout. The repair keeps the
 * row in the focused pane's `CandleChart` — its chips, its pressed state, its
 * own chart — and renders it into one workspace host through a portal. These
 * tests hold the three things that makes true: there is one row, it is not
 * inside any pane, and it acts on whichever pane is focused.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, within } from "@testing-library/react";
import { assertPresent, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { createWorkspace, saveWorkspace } from "@/lib/workspace";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  saveWorkspace(createWorkspace({ symbol: "SOLUSDT", interval: "15m" }, "2-cols"));
});
after(closeBrowser);

const rows = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[role="group"][aria-label="Visible range"]')];

const pane = (root: HTMLElement, id: string): HTMLElement =>
  assertPresent(root.querySelector(`[data-pane-id="${id}"]`), `no pane ${id}`) as HTMLElement;

const chip = (row: HTMLElement, label: string): HTMLElement => {
  const found = within(row).getAllByRole("button").find((b) => b.textContent === label);
  if (!found) throw new Error(`no ${label} chip`);
  return found;
};

test("C11 — two panes draw ONE range row and one clock, under the layout, inside neither pane", async () => {
  const chart = await mountChart();
  await settle();
  const root = chart.container;
  assert.equal(root.querySelectorAll("[data-pane-id]").length, 2);

  const found = rows(root);
  assert.equal(found.length, 1, `expected one range row for the layout, found ${found.length}`);
  assert.equal(found[0]!.closest("[data-shared-range-row]") !== null, true,
    "the row is not in the workspace's host");
  assert.equal(found[0]!.closest("[data-pane-id]") === null, true, "the row is inside a pane");
  assert.equal(root.querySelectorAll('button[aria-label="Go to date"]').length, 1,
    "one go-to-date control, not one per pane");
  const clocks = [...root.querySelectorAll("span")]
    .filter((s) => s.textContent === " — chart display timezone").length;
  assert.equal(clocks, 1, `one clock for the layout, found ${clocks}`);
});

test("C11 — the row acts on the focused pane, and follows focus without losing either pane's state", async () => {
  const chart = await mountChart();
  await settle();
  const root = chart.container;
  const first = root.querySelector<HTMLElement>("[data-pane-id]")!.getAttribute("data-pane-id")!;
  const second = [...root.querySelectorAll<HTMLElement>("[data-pane-id]")][1]!.getAttribute("data-pane-id")!;

  fireEvent.pointerDown(pane(root, first));
  await settle();
  fireEvent.click(chip(rows(root)[0]!, "1D"));
  await settle();
  assert.equal(chip(rows(root)[0]!, "1D").getAttribute("aria-pressed"), "true");

  // Focus the other pane: the row is now ITS row, which has chosen nothing.
  fireEvent.pointerDown(pane(root, second));
  await settle();
  assert.equal(pane(root, second).getAttribute("data-active"), "true");
  assert.equal(rows(root).length, 1, "focus moved and a second row appeared");
  assert.equal(chip(rows(root)[0]!, "1D").getAttribute("aria-pressed"), "false",
    "the row still shows the first pane's choice: it is not acting on the focused pane");
  fireEvent.click(chip(rows(root)[0]!, "5D"));
  await settle();
  assert.equal(chip(rows(root)[0]!, "5D").getAttribute("aria-pressed"), "true");

  // And back: the first pane kept its own range.
  fireEvent.pointerDown(pane(root, first));
  await settle();
  assert.equal(chip(rows(root)[0]!, "1D").getAttribute("aria-pressed"), "true",
    "the first pane's range was lost when focus left it");
  assert.equal(chip(rows(root)[0]!, "5D").getAttribute("aria-pressed"), "false");
});

test("C11 — a maximised pane is one chart again, and draws its own row", async () => {
  const chart = await mountChart();
  await settle();
  const root = chart.container;
  const maximise = [...root.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => /Maximize this pane/.test(b.getAttribute("aria-label") ?? ""));
  assert.ok(maximise, "no maximise control");
  fireEvent.click(maximise);
  await settle();

  assert.equal(root.querySelector("[data-shared-range-row]") === null, true,
    "a single chart on screen still has the workspace host");
  const found = rows(root);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.closest("[data-pane-id]") !== null, true, "the maximised pane lost its own row");
});
