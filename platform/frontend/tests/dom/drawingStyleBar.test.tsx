/**
 * The selected drawing's floating toolbar, on a rendered chart.
 *
 * A11/A12 and B-11, each measured against Premium:
 *
 *   - the bar sat 44px above the drawing's FIRST anchor, so a line rising to
 *     the right ran under it, and a click or right-click meant for the line hit
 *     a button — right-click gave no Drawing menu at all;
 *   - its controls were two heights (34px outlined, 28px icons) in a 46px bar;
 *   - colour, width and style each wore a caret and opened nothing: a click
 *     STEPPED the value (red → yellow → purple, 3 → 4, Solid → Dashed).
 *
 * Driven through the real workspace, as `drawings.test.tsx` is.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { drag, menuLabel, mountChart, press, selectTool, type MountedChart } from "./harness/chart";
import { drawingStore } from "@/lib/drawingStore";

const SYMBOL = "SOLUSDT";
/** A trend line that RISES to the right: the shape that ran under the old bar. */
const FROM = [300, 380] as const;
const TO = [520, 260] as const;

/*
 * The harness reports one 1280×800 box for every element (it has no layout
 * engine), which would make the bar as big as the chart. The bar is given the
 * size the reference's is measured at — 38px tall, and about as wide as this
 * one's ten controls — so the placement is asked the real question.
 */
const BAR = { width: 420, height: 38 };
const proto = window.HTMLElement.prototype;
const original = {
  width: Object.getOwnPropertyDescriptor(proto, "offsetWidth")!,
  height: Object.getOwnPropertyDescriptor(proto, "offsetHeight")!,
};
for (const [prop, key] of [["offsetWidth", "width"], ["offsetHeight", "height"]] as const) {
  Object.defineProperty(proto, prop, {
    configurable: true,
    get(this: HTMLElement): number {
      return this.hasAttribute?.("data-drawing-style-bar") ? BAR[key] : original[key].get!.call(this) as number;
    },
  });
}

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(() => {
  Object.defineProperty(proto, "offsetWidth", original.width);
  Object.defineProperty(proto, "offsetHeight", original.height);
  closeBrowser();
});

async function drawRisingLine(): Promise<{ chart: MountedChart; bar: HTMLElement }> {
  const chart = await mountChart();
  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [...FROM], [...TO]);
  assert.equal(drawingStore.get(SYMBOL).length, 1);
  const bar = chart.container.querySelector<HTMLElement>("[data-drawing-style-bar]");
  assert.ok(bar, "a freshly drawn line is selected and shows its toolbar");
  return { chart, bar };
}

function barBox(bar: HTMLElement): { left: number; top: number; right: number; bottom: number } {
  const left = parseFloat(bar.style.left);
  const top = parseFloat(bar.style.top);
  return { left, top, right: left + bar.offsetWidth, bottom: top + bar.offsetHeight };
}

test("A11 — the toolbar never covers the selected drawing", async () => {
  const { bar } = await drawRisingLine();
  const box = barBox(bar);
  assert.ok(Number.isFinite(box.left) && Number.isFinite(box.top), "the bar is positioned");
  // Every point along the line, and the handles at both ends, are outside it.
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const x = FROM[0] + (TO[0] - FROM[0]) * t;
    const y = FROM[1] + (TO[1] - FROM[1]) * t;
    const inside = x > box.left - 4 && x < box.right + 4 && y > box.top - 4 && y < box.bottom + 4;
    assert.equal(inside, false,
      `the line at (${x.toFixed(0)}, ${y.toFixed(0)}) is under the bar ${JSON.stringify(box)}`);
  }
});

test("A12 — every button on the bar is one height, 38px", async () => {
  const { bar } = await drawRisingLine();
  const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button")];
  assert.ok(buttons.length >= 8);
  for (const button of buttons) {
    assert.match(button.className, /\bh-\[38px\]/,
      `${button.getAttribute("aria-label")} is not a 38px control: ${button.className}`);
  }
  assert.doesNotMatch(bar.className, /\btvc-menu\b/,
    "the menu grammar's 6px padding made the bar 46px tall");
});

test("A12 — right-clicking the toolbar opens the Drawing menu, not the chart's", async () => {
  const { bar } = await drawRisingLine();
  fireEvent.contextMenu(bar.querySelector("button")!, { button: 2, clientX: 320, clientY: 200 });
  await settle();
  assert.equal(menuLabel(), "Drawing");
});

test("A12 — Delete removes the selection while focus sits on a toolbar button", async () => {
  const { bar } = await drawRisingLine();
  const lock = bar.querySelector<HTMLButtonElement>('button[aria-label="Clone this drawing"]')!;
  lock.focus();
  assert.equal(document.activeElement, lock);
  await press("Delete", {}, lock);
  assert.equal(drawingStore.get(SYMBOL).length, 0, "Delete was swallowed by a focused toolbar button");
});

test("A12 — Backspace does the same", async () => {
  const { bar } = await drawRisingLine();
  const width = bar.querySelector<HTMLButtonElement>('button[aria-label="Line width"]')!;
  width.focus();
  await press("Backspace", {}, width);
  assert.equal(drawingStore.get(SYMBOL).length, 0);
});

test("B-11 — Line color opens a palette; it does not step the colour", async () => {
  const { bar } = await drawRisingLine();
  const before = drawingStore.get(SYMBOL)[0]!.style.color;
  const trigger = bar.querySelector<HTMLButtonElement>('button[aria-label="Line color"]')!;
  assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  fireEvent.click(trigger);
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.color, before, "a click on the trigger changed the colour");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  const cell = bar.querySelector<HTMLButtonElement>('button[aria-label="#ff9800"]');
  assert.ok(cell, "no palette opened");
  fireEvent.click(cell);
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.color, "#ff9800");
});

test("B-11 — Line width opens the four widths; it does not step the width", async () => {
  const { bar } = await drawRisingLine();
  const before = drawingStore.get(SYMBOL)[0]!.style.width;
  const trigger = bar.querySelector<HTMLButtonElement>('button[aria-label="Line width"]')!;
  fireEvent.click(trigger);
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.width, before);
  const three = bar.querySelector<HTMLButtonElement>('button[aria-label="Width 3"]');
  assert.ok(three, "no width picker opened");
  fireEvent.click(three);
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.width, 3);
});

test("B-11 — Line style opens solid / dotted / dashed; it does not toggle", async () => {
  const { bar } = await drawRisingLine();
  const trigger = bar.querySelector<HTMLButtonElement>('button[aria-label="Line style"]')!;
  fireEvent.click(trigger);
  await settle();
  assert.notEqual(drawingStore.get(SYMBOL)[0]!.style.dashed, true, "a click on the trigger dashed the line");
  const dotted = bar.querySelector<HTMLButtonElement>('button[aria-label="Dotted"]');
  assert.ok(dotted, "no style picker opened");
  fireEvent.click(dotted);
  await settle();
  const style = drawingStore.get(SYMBOL)[0]!.style;
  assert.equal(style.lineStyle, "dotted");
  assert.equal(style.dashed, true, "the boolean every renderer reads is kept in step");
});
