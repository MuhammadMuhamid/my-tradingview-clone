/**
 * Right-click, and what the menu is actually about.
 *
 * ── The defect class ───────────────────────────────────────────────────────
 *
 * A context menu has a TARGET, and every item in it acts on that target. The
 * chart menu acts on the price under the pointer; the drawing menu acts on the
 * drawing under it; the price-axis menu acts on the axis and has no price at
 * all. Those three are one gesture apart and the difference is invisible: the
 * previous campaign shipped a build where a horizontal line's "Add alert on
 * this level" armed at the PIXEL price under the cursor instead of the line's
 * own level — off by however far the click landed from the line, plausible,
 * and wrong.
 *
 * The suite could only check that assertion by reading the page's source for
 * two `case` labels in the right order. Here the menus are opened by real
 * right-clicks at real coordinates, and the alert dialog is read for the level
 * it was actually pre-filled with.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import {
  chooseMenuItem, clickAt, menuItems, menuLabel, mountChart, openMenu, press,
  rightClickAt, selectTool,
} from "./harness/chart";
import { drawingStore } from "@/lib/drawingStore";
import { fmtPrice } from "@/lib/format";

const SYMBOL = "SOLUSDT";

/** The chart is 1280×800; the price axis is the strip on its right. */
const PLOT = { x: 600, y: 300 };
const AXIS_X = 1_260;
const TIME_Y = 790;

let copied: string[] = [];

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } },
  });
});
after(closeBrowser);

/** The level the price-alert dialog opened pre-filled with. */
function prefilledLevel(): number {
  const dialog = screen.getByRole("dialog");
  const input = dialog.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="number"], input');
  assert.ok(input, "the price-alert dialog has no level field");
  return Number(input.value);
}

test("each strip of the chart opens its own menu, and the time axis opens none", async () => {
  const chart = await mountChart();

  await rightClickAt(chart.plot, PLOT.x, PLOT.y);
  assert.equal(menuLabel(), "SOLUSDT chart");
  await press("Escape");

  await rightClickAt(chart.plot, AXIS_X, PLOT.y);
  assert.equal(menuLabel(), "Price scale",
    "the price axis has its own short menu; it used to show the browser's own");
  assert.deepEqual(
    menuItems().map((i) => i.label.replace(/\s+/g, " ").trim()),
    ["Auto scale", "Logarithmic scale", "Reset scale"]);
  await press("Escape");

  await rightClickAt(chart.plot, PLOT.x, TIME_Y);
  assert.equal(openMenu(), null,
    "the time scale has nothing to offer, so it keeps the browser's own menu");
});

test("the chart menu names the price it opened at, and copies that same price", async () => {
  const chart = await mountChart();
  await rightClickAt(chart.plot, PLOT.x, PLOT.y);

  const copyItem = menuItems().find((i) => i.label.startsWith("Copy price"));
  assert.ok(copyItem, "the chart menu must offer the price under the pointer");
  const named = copyItem.label.replace("Copy price", "").trim();
  assert.match(named, /^[\d.,]+$/, `"${copyItem.label}" does not name a price`);

  await chooseMenuItem("Copy price");
  await settle();
  assert.deepEqual(copied, [named],
    "the item's label and the item's action must be the same number");
});

test("a drawing's add-alert reads the drawing's own level, not the pointer's price", async () => {
  const chart = await mountChart();

  // Place a horizontal line with one click, so its level is exactly the price
  // at y=300 — whatever the chart's scale says that is.
  await selectTool(chart.container, "Horizontal line");
  await clickAt(chart.plot, 400, 300);
  const line = drawingStore.get(SYMBOL)[0]!;
  assert.equal(line.tool, "hline");
  const level = line.points[0]!.price;

  await selectTool(chart.container, "Cross");

  // Right-click four pixels off the line: inside the seven-pixel hit radius,
  // so the drawing is the target — and at a MEASURABLY different price.
  await rightClickAt(chart.plot, 700, 304);
  assert.equal(menuLabel(), "Drawing", "four pixels off a line is still on it");

  assert.equal(menuItems().find((i) => i.label.startsWith("Copy price")), undefined,
    "the drawing menu is about the drawing; it offers no pointer price at all");

  await chooseMenuItem("Add alert on this level");
  await settle();
  assert.equal(prefilledLevel(), Number(level.toPrecision(8)),
    "the alert must be armed on the LINE, not on wherever the click landed");

  // And the same gesture on empty chart arms at the pointer's price instead —
  // which is the distinction, stated as a comparison rather than as a claim.
  await press("Escape");
  await settle();
  await rightClickAt(chart.plot, 700, 200);
  assert.equal(menuLabel(), "SOLUSDT chart");
  const labelled = (menuItems().find((i) => i.label.startsWith("Add alert at"))?.label ?? "")
    .replace("Add alert at", "").trim();
  await chooseMenuItem("Add alert at");
  await settle();
  const armed = prefilledLevel();
  assert.equal(fmtPrice(armed), labelled, "the item named the price it armed");
  assert.notEqual(armed, Number(level.toPrecision(8)),
    "a click 100 pixels from the line must not arm at the line's level");
});

test("right-clicking empty chart clears a selection rather than opening over it", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Horizontal line");
  await clickAt(chart.plot, 400, 300);
  await selectTool(chart.container, "Cross");

  await rightClickAt(chart.plot, 700, 304);
  assert.equal(menuLabel(), "Drawing");
  await press("Escape");

  await rightClickAt(chart.plot, 700, 120);
  assert.equal(menuLabel(), "SOLUSDT chart",
    "the chart menu used to open over a drawing still wearing its handles");
});

test("the axis menu changes the axis it was opened on", async () => {
  const chart = await mountChart();

  await rightClickAt(chart.plot, AXIS_X, PLOT.y);
  const autoBefore = menuItems().find((i) => i.label.includes("Auto scale"));
  assert.ok(autoBefore);
  const checkedBefore = screen.getByRole("menuitemcheckbox", { name: /Auto scale/ })
    .getAttribute("aria-checked");

  await chooseMenuItem("Auto scale");
  await settle();

  await rightClickAt(chart.plot, AXIS_X, PLOT.y);
  const checkedAfter = screen.getByRole("menuitemcheckbox", { name: /Auto scale/ })
    .getAttribute("aria-checked");
  assert.notEqual(checkedAfter, checkedBefore,
    "the menu must both report the axis's state and change it; it was once built from literals");
});

test("every enabled item in the chart menu is answered by a handler", async () => {
  /*
   * The old form of this test read the page's source for a `case` label per
   * menu id. It could not see whether the handler did anything, and it could
   * not see an item whose id had been renamed in one place only. This activates
   * each item on a real menu and requires the workspace to visibly respond —
   * a dialog, a panel, a toast, a changed control — rather than close silently.
   */
  const chart = await mountChart();
  await selectTool(chart.container, "Horizontal line");
  await clickAt(chart.plot, 400, 300);
  await selectTool(chart.container, "Cross");

  // Well clear of the line, so this is the CHART's menu rather than the
  // drawing's — the two overlap on screen and are different targets.
  const EMPTY = { x: 600, y: 150 };

  /*
   * Put the price scale somewhere other than its default first.
   *
   * "Reset view" restores the default, so on a chart that is ALREADY at the
   * default it correctly does nothing — and an item that correctly does
   * nothing cannot be told apart from one that is not wired up. Moving the
   * scale first gives it something to undo.
   */
  await rightClickAt(chart.plot, AXIS_X, PLOT.y);
  await chooseMenuItem("Logarithmic scale");
  await settle();
  await rightClickAt(chart.plot, EMPTY.x, EMPTY.y);
  assert.equal(menuLabel(), "SOLUSDT chart");
  const labels = menuItems().filter((i) => !i.disabled).map((i) => i.label);
  await press("Escape");
  // Seven on this fixture: manual trading is off, so "Prepare an order" is
  // correctly disabled and is therefore not activated below.
  assert.ok(labels.length >= 7, `only ${labels.length} items were enabled`);

  for (const label of labels) {
    const before = observableState(chart.container);
    await rightClickAt(chart.plot, EMPTY.x, EMPTY.y);
    await chooseMenuItem(label);
    await settle();
    const after = observableState(chart.container);
    const dialog = screen.queryByRole("dialog") ?? screen.queryByRole("alertdialog");
    assert.ok(dialog !== null || after !== before,
      `"${label}" closed the menu and changed nothing at all — no markup, no ` +
      "stored preference, no request, no dialog");
    if (dialog) {
      await press("Escape", {}, dialog);
      await settle();
    }
  }
});

/**
 * Everything an item is allowed to have done.
 *
 * Not just the words on screen: "Candlestick patterns" toggles an overlay that
 * is painted on a canvas and remembered in local storage, and "Reset view"
 * changes an `aria-checked`. An item is answered if it changed the markup, a
 * stored preference, or what the page asked the server for.
 */
function observableState(container: HTMLElement): string {
  const stored: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)!;
    stored.push(`${key}=${window.localStorage.getItem(key)}`);
  }
  stored.sort();
  return `${container.innerHTML}\n${stored.join("\n")}\n${server.calls.length}`;
}
