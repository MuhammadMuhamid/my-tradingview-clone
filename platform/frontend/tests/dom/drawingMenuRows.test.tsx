/**
 * W2A-10: the drawing menu's `Template ›`, `Visibility on intervals ›` and
 * `Object tree`, driven through a real right-click and read back from the
 * drawing store — a row is only allowed to exist if it moves something.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { clickAt, menuLabel, mountChart, rightClickAt, selectTool } from "./harness/chart";
import { drawingStore } from "@/lib/drawingStore";

const SYMBOL = "SOLUSDT";

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

/** A horizontal line at y=300, and its drawing menu open. */
async function lineMenu(): Promise<Awaited<ReturnType<typeof mountChart>>> {
  const chart = await mountChart();
  await selectTool(chart.container, "Horizontal line");
  await clickAt(chart.plot, 400, 300);
  await selectTool(chart.container, "Cross");
  await openLineMenu(chart);
  return chart;
}

async function openLineMenu(chart: Awaited<ReturnType<typeof mountChart>>): Promise<void> {
  await rightClickAt(chart.plot, 700, 302);
  assert.equal(menuLabel(), "Drawing");
}

test("W2A-10 — Object tree opens the objects panel", async () => {
  await lineMenu();
  await click("Object tree");
  assert.equal(
    screen.getByRole("button", { name: "Object tree and Data window" }).getAttribute("aria-pressed"), "true",
    "the objects panel did not open");
});

test("W2A-10 — Visibility on intervals writes the drawing's own allow-list", async () => {
  const chart = await lineMenu();
  await click("Visibility on intervals");
  assert.equal(row("All intervals")?.getAttribute("aria-checked"), "true", "a new line is on every interval");
  await click("Current interval only");
  const visibleOn = drawingStore.get(SYMBOL)[0]!.visibleOn;
  assert.equal(visibleOn?.length, 1, `expected one interval, got ${JSON.stringify(visibleOn)}`);
  await openLineMenu(chart);
  await click("Visibility on intervals");
  assert.equal(row("Current interval only")?.getAttribute("aria-checked"), "true");
  await click("All intervals");
  assert.equal(drawingStore.get(SYMBOL)[0]!.visibleOn, undefined);
});

test("W2A-10 — Template › saves the style and applies it back", async () => {
  const chart = await lineMenu();
  // A look that is not the default, so applying it back is not Apply default.
  const line = drawingStore.get(SYMBOL)[0]!;
  drawingStore.set(SYMBOL, [{ ...line, style: { ...line.style, color: "#e91e63", width: 3 } }]);
  await settle();
  await openLineMenu(chart);
  await click("Template");
  await click("Save as…");
  fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), { target: { value: "Level" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  const saved = "#e91e63";

  // Restyle the line by hand, then put the template back on it.
  drawingStore.set(SYMBOL, [{ ...line, style: { ...line.style, color: "#ff9800", width: 4 } }]);
  await settle();
  await openLineMenu(chart);
  await click("Template");
  await click("Level");
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.color, saved);

  // And Apply default is the style a new drawing starts with.
  drawingStore.set(SYMBOL, [{ ...line, style: { ...line.style, color: "#ff9800", width: 4 } }]);
  await settle();
  await openLineMenu(chart);
  await click("Template");
  await click("Apply default");
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.width, 2);
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.color, "#4f8cff");
});
