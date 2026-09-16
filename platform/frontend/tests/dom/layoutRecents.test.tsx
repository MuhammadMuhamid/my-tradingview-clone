/**
 * TVP8 F-07: switching between saved layouts, through the menu.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * The menu's `RECENTLY USED` section listed EVERY saved layout, in whatever
 * order the server returned them, and there was no `Open layout…` at all. For
 * one or two layouts that looks like a recents list; for a dozen it is the
 * whole library, unsorted, inside a dropdown — and there was no other door to
 * it.
 *
 * These run against the real layout store through the fixture origin, so what
 * is asserted is what a user would see after actually saving two layouts.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
});
after(closeBrowser);

/** Open the layout menu from one chart's toolbar. */
async function openMenu(container: HTMLElement): Promise<HTMLElement> {
  const caret = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Manage layouts"]');
  assert.ok(caret, "the toolbar has no Manage layouts control");
  fireEvent.click(caret);
  await settle(2);
  const menu = screen.getByRole("menu", { name: "Saved layouts" });
  return menu;
}

/** Rows under `RECENTLY USED`, in the order they are drawn. */
const recentNames = (menu: HTMLElement): string[] =>
  [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .filter((el) => el.className.includes("!min-h-[48px]"))
    .map((el) => (el.querySelector("span")?.textContent ?? "").trim());

test("F-07 — `Open layout…` is offered, and is inert with nothing saved", async () => {
  const chart = await mountChart();
  await settle();
  const menu = await openMenu(chart.container);

  const open = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((el) => (el.textContent ?? "").includes("Open layout…"));
  assert.ok(open, "the menu offers no way to open another layout");
  assert.equal(open.disabled, true,
    "with nothing saved, a dialog listing nothing is a dead end with a title");
});

test("F-07 — RECENTLY USED lists saved layouts, and `Open layout…` opens a searchable dialog",
  async () => {
    server.seedLayouts([
      { id: "l1", name: "Scalp desk", symbol: "SOLUSDT", timeframe: "15m" },
      { id: "l2", name: "Swing desk", symbol: "BTCUSDT", timeframe: "4h" },
    ]);
    const chart = await mountChart();
    await settle(4);
    const menu = await openMenu(chart.container);

    const names = recentNames(menu);
    assert.ok(names.includes("Scalp desk") && names.includes("Swing desk"),
      `RECENTLY USED drew ${JSON.stringify(names)}`);
    assert.ok(names.length <= 4,
      "the reference shows four; the rest belong behind `Open layout…`");

    const open = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((el) => (el.textContent ?? "").includes("Open layout…"));
    assert.ok(open && !open.disabled);
    fireEvent.click(open);
    await settle(2);

    const dialog = screen.getByRole("dialog", { name: /Open layout/ });
    for (const name of ["Scalp desk", "Swing desk"]) {
      assert.ok(within(dialog).getByText(name), `${name} is missing from the dialog`);
    }

    // The search field narrows the real list rather than decorating it.
    const search = within(dialog).getByPlaceholderText("Search layouts");
    fireEvent.change(search, { target: { value: "swing" } });
    await settle(2);
    assert.equal(within(dialog).queryByText("Scalp desk"), null);
    assert.ok(within(dialog).getByText("Swing desk"));
  });

test("F-07 — opening a layout from the dialog switches the workspace to it", async () => {
  server.seedLayouts([
    { id: "l1", name: "Scalp desk", symbol: "SOLUSDT", timeframe: "15m" },
    { id: "l2", name: "Swing desk", symbol: "BTCUSDT", timeframe: "4h" },
  ]);
  const chart = await mountChart();
  await settle(4);
  const menu = await openMenu(chart.container);
  const open = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((el) => (el.textContent ?? "").includes("Open layout…"));
  assert.ok(open);
  fireEvent.click(open);
  await settle(2);

  const dialog = screen.getByRole("dialog", { name: /Open layout/ });
  fireEvent.click(dialog.querySelector<HTMLButtonElement>('[data-layout-row="l2"]')!);
  await settle(6);

  assert.match(chart.container.textContent ?? "", /Swing desk/,
    "the toolbar still names the layout the workspace was on");
  assert.equal(window.localStorage.getItem("srtrend.currentLayout.v1"), "l2",
    "the switch was not recorded as the current layout");
  assert.match(window.localStorage.getItem("srtrend.layoutRecents.v1") ?? "", /^\["l2"/,
    "opening a layout is what makes it the most recent one");
});
