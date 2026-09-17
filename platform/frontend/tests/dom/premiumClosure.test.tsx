/*
 * Phase 3P — premium-surface closure.
 *
 * Three surfaces that existed in full and could not be reached from the
 * product, each proven from the rendered workstation rather than from source:
 *
 *  1. the pattern overlays (candlestick and classical) — engines, panels,
 *     persisted state and two chart-menu handlers, and nothing that emitted
 *     the ids; switching them on meant editing localStorage by hand;
 *  2. ⌥R, ⌥L and ⌘⇧A — printed on the shortcuts sheet, in the palette and as
 *     hints on two menus, with no arm in the page's dispatcher;
 *  3. the bottom workstation — Positions & Orders, the Strategy Tester and the
 *     Pine Editor — whose tab strip unmounts when collapsed, leaving the ⇧⌥P
 *     chord and the palette as the only ways in.
 *
 * Each test drives the control a person drives, and each fails on the
 * pre-repair page.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { chooseMenuItem, menuItems, mountChart, openMenu, press, rightClickAt } from "./harness/chart";
import { isMacPlatform } from "@/lib/shortcuts";

const PLOT = { x: 600, y: 300 };
const AXIS_X = 1_260;

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** The `aria-checked` of the open menu's row whose label starts with `label`. */
function checkedRow(label: string): string | null {
  const menu = openMenu();
  assert.ok(menu, "no menu is open");
  const row = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .find((el) => (el.textContent ?? "").trim().startsWith(label));
  assert.ok(row, `the open menu has no "${label}" row`);
  return row.getAttribute("aria-checked");
}

/** The platform's own primary modifier, as `resolveShortcut` reads it. */
function mod(): Partial<KeyboardEventInit> {
  return isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
}

test("the pattern overlays are one right-click away, and the menu reads their state back", async () => {
  const chart = await mountChart();

  await rightClickAt(chart.plot, PLOT.x, PLOT.y);
  const labels = menuItems().map((i) => i.label);
  assert.ok(labels.includes("Candlestick patterns"), "the candlestick overlay has no entry point");
  assert.ok(labels.includes("Chart patterns"), "the classical overlay has no entry point");
  assert.equal(checkedRow("Candlestick patterns"), "false");
  assert.equal(checkedRow("Chart patterns"), "false");
  // The rows that only raised a toast are gone; a control that moves nothing must not exist.
  assert.ok(!labels.some((l) => /cursor line|template/i.test(l)), labels.join(" | "));

  await chooseMenuItem("Candlestick patterns");
  await settle();
  assert.ok(screen.getByRole("group", { name: "Visible candlestick patterns" }),
    "choosing the row must mount the overlay's own controls on the pane");

  await rightClickAt(chart.plot, PLOT.x, PLOT.y);
  assert.equal(checkedRow("Candlestick patterns"), "true", "the row must read the overlay's state back");
  await chooseMenuItem("Chart patterns");
  await settle();
  assert.ok(screen.getByText(/^Chart patterns · \d+/),
    "choosing the row must mount the classical overlay's own controls on the pane");
});

test("⌥L, ⌘⇧A and ⌥R do what their printed caps say", async () => {
  const chart = await mountChart();

  const axis = async (): Promise<{ log: string | null; auto: string | null }> => {
    await rightClickAt(chart.plot, AXIS_X, PLOT.y);
    const state = { log: checkedRow("Logarithmic"), auto: checkedRow("Auto") };
    await press("Escape");
    return state;
  };
  assert.deepEqual(await axis(), { log: "false", auto: "true" }, "the pane starts linear and auto-fitted");

  await press("l", { altKey: true }, document.body);
  assert.equal((await axis()).log, "true", "⌥L is printed as the logarithmic scale and must switch to it");

  await press("a", { ...mod(), shiftKey: true }, document.body);
  assert.equal((await axis()).auto, "false", "⌘⇧A is printed as auto scale and must toggle it");

  await press("r", { altKey: true }, document.body);
  assert.deepEqual(await axis(), { log: "false", auto: "true" }, "⌥R is printed as reset and must restore the default scale");
});

test("the bottom workstation has a pointer route, not only a chord", async () => {
  await mountChart();
  assert.equal(screen.queryByRole("tab", { name: /Pine Editor/ }) === null, true,
    "the panel starts collapsed");

  // The product menu is mounted for both the rail and the bar breakpoint; CSS
  // decides which one is on screen, and either opens the same menu.
  fireEvent.click(screen.getAllByRole("button", { name: /go to another part of the application/ })[0]!);
  await settle();
  const row = screen.getByRole("menuitem", { name: /Positions, tester and Pine editor/ });
  assert.match(row.textContent ?? "", /P$/, "the row prints the chord that does the same thing");
  fireEvent.click(row);
  await settle();

  assert.ok(screen.getByRole("tab", { name: /Pine Editor/ }), "the row must open the bottom workstation");
  assert.ok(screen.getByRole("tab", { name: /Strategy Tester/ }));
  assert.ok(screen.getAllByRole("tab", { name: /^Positions & Orders/ }).length >= 1);
});
