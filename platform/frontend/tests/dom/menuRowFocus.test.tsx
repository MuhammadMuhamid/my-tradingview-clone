/*
 * B-24 — the arrow keys travel a menu's ROWS, not the accessories inside them.
 *
 * In the chart-style and interval menus every row carries a favourite star —
 * a second button — and the shared `menuItems` matched it as `button`, so
 * ArrowDown from "Bars" focused "Take Bars off the toolbar" instead of
 * "Candles". The star is still a pointer target; it is out of the arrow walk
 * and out of the tab order.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { ChartTypeMenu } from "@/components/tv/ChartTypeMenu";
import { TimeframePicker, useResolutionPreferences } from "@/components/tv/TimeframePicker";

beforeEach(resetBrowser);
after(closeBrowser);

const role = (): string | null => (document.activeElement as HTMLElement | null)?.getAttribute("role") ?? null;

test("ArrowDown in the chart-style menu moves row to row, never onto a star", async () => {
  const { container } = render(<ChartTypeMenu value="candles" onChange={() => {}} />);
  fireEvent.click(container.querySelector<HTMLElement>('button[aria-label="Chart style"][aria-haspopup="menu"]')!);
  await settle();
  const menu = container.querySelector<HTMLElement>('[role="menu"][aria-label="Chart style"]')!;
  assert.ok(menu, "the style menu did not open");
  for (const star of menu.querySelectorAll<HTMLElement>("button[aria-pressed]")) {
    assert.equal(star.tabIndex, -1, `${star.getAttribute("aria-label")} is in the tab order`);
  }
  for (let i = 0; i < 6; i += 1) {
    fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown", bubbles: true });
    await settle(1);
    assert.equal(role(), "menuitemradio",
      `step ${i + 1} landed on ${(document.activeElement as HTMLElement)?.getAttribute("aria-label")}`);
  }
});

function Picker() {
  const preferences = useResolutionPreferences();
  return <TimeframePicker interval="1h" onInterval={() => {}} preferences={preferences} />;
}

test("ArrowDown in the interval menu moves row to row, never onto a star", async () => {
  const { container } = render(<Picker />);
  fireEvent.click(container.querySelector<HTMLElement>('button[aria-label="Chart interval — all timeframes"]')!);
  await settle();
  const menu = container.querySelector<HTMLElement>('[role="menu"][aria-label="All timeframes"]')!;
  assert.ok(menu, "the interval menu did not open");
  for (let i = 0; i < 6; i += 1) {
    fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown", bubbles: true });
    await settle(1);
    const label = (document.activeElement as HTMLElement)?.getAttribute("aria-label") ?? "";
    assert.doesNotMatch(label, /toolbar|Remove the custom/, `step ${i + 1} landed on an accessory: ${label}`);
    assert.ok(menu.contains(document.activeElement), "focus left the menu");
  }
});
