/**
 * A6: the two axis menus' new rows reach the settings they name.
 *
 * `Plus button` on the price axis and `Time zone ›` on the time axis are
 * Premium's rows over settings this product already had in Chart settings →
 * Scales / Symbol. A row is only allowed to exist if it moves something, so
 * each is driven here through the real menu and read back.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { chooseMenuItem, mountChart, openMenu, rightClickRegion } from "./harness/chart";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** A row of ANY open menu — the submenu opens as a second one. */
function row(label: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .find((el) => (el.textContent ?? "").trim().startsWith(label)) ?? null;
}

async function click(label: string): Promise<void> {
  const el = row(label);
  assert.ok(el, `no "${label}" row is open`);
  fireEvent.click(el);
  await settle();
}

test("A6 — `Plus button` on the price-axis menu switches the setting", async () => {
  const chart = await mountChart();
  await rightClickRegion(chart.pane(0), "axis");
  assert.equal(row("Plus button")?.getAttribute("aria-checked"), "true", "on by default, as the setting is");
  await chooseMenuItem("Plus button");
  await rightClickRegion(chart.pane(0), "axis");
  assert.equal(row("Plus button")?.getAttribute("aria-checked"), "false");
});

test("A6 — `Time zone ›` on the time-axis menu sets the pane's zone", async () => {
  const chart = await mountChart();
  await rightClickRegion(chart.pane(0), "time");
  await click("Time zone");
  assert.equal(row("UTC")?.getAttribute("aria-checked"), "true");
  await click("(UTC+9) Tokyo");
  assert.equal(openMenu(), null, "picking a zone closes the menu");
  await rightClickRegion(chart.pane(0), "time");
  await click("Time zone");
  assert.equal(row("(UTC+9) Tokyo")?.getAttribute("aria-checked"), "true");
  assert.equal(row("UTC")?.getAttribute("aria-checked"), "false");
});
