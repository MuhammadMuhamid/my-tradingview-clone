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
import { fireEvent, screen, within } from "@testing-library/react";
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
/*
 * W2D-03: the legend column, at the size of a series row plus a study row —
 * the column `CandleChart` pins at the pane's top-left (`top-1.5`) holding
 * `[data-pane-legend]`. Without this it would be the harness's 1280×800 too.
 */
const LEGEND = { width: 360, height: 60 };
const isLegendColumn = (el: HTMLElement): boolean =>
  el.classList?.contains("top-1.5") === true && el.querySelector?.("[data-pane-legend]") !== null;
const proto = window.HTMLElement.prototype;
const original = {
  width: Object.getOwnPropertyDescriptor(proto, "offsetWidth")!,
  height: Object.getOwnPropertyDescriptor(proto, "offsetHeight")!,
};
for (const [prop, key] of [["offsetWidth", "width"], ["offsetHeight", "height"]] as const) {
  Object.defineProperty(proto, prop, {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.hasAttribute?.("data-drawing-style-bar")) return BAR[key];
      if (isLegendColumn(this)) return LEGEND[key];
      return original[key].get!.call(this) as number;
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
  const lock = bar.querySelector<HTMLButtonElement>('button[aria-label="Lock this drawing"]')!;
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

/** The open popover's option rows, as their visible text. */
function options(bar: HTMLElement): HTMLButtonElement[] {
  return [...bar.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}

test("B-11 / W2A-06 — Line width opens labelled 1px…4px rows, the current one marked", async () => {
  const { bar } = await drawRisingLine();
  const before = drawingStore.get(SYMBOL)[0]!.style.width;
  const trigger = bar.querySelector<HTMLButtonElement>('button[aria-label="Line width"]')!;
  assert.equal((trigger.textContent ?? "").trim(), `${before}px`, "the trigger names the width it is on");
  fireEvent.click(trigger);
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.width, before);
  const rows = options(bar);
  assert.deepEqual(rows.map((r) => (r.textContent ?? "").trim()), ["1px", "2px", "3px", "4px"],
    "four unlabelled samples said nothing about which number the trigger meant");
  assert.deepEqual(rows.map((r) => r.getAttribute("aria-selected")),
    [1, 2, 3, 4].map((w) => String(w === before)));
  assert.match(rows[0]!.className, /\btvc-menu-row\b/);
  assert.ok(rows[0]!.closest(".tvc-menu--compact"), "the rows are the 32px context-menu density");
  fireEvent.click(rows[2]!);
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.width, 3);
});

test("B-11 / W2A-06 — Line style opens Line / Dashed line / Dotted line; it does not toggle", async () => {
  const { bar } = await drawRisingLine();
  const trigger = bar.querySelector<HTMLButtonElement>('button[aria-label="Line style"]')!;
  fireEvent.click(trigger);
  await settle();
  assert.notEqual(drawingStore.get(SYMBOL)[0]!.style.dashed, true, "a click on the trigger dashed the line");
  const rows = options(bar);
  assert.deepEqual(rows.map((r) => (r.textContent ?? "").trim()), ["Line", "Dashed line", "Dotted line"]);
  assert.equal(rows[0]!.getAttribute("aria-selected"), "true", "a new line is solid, and says so");
  fireEvent.click(rows[2]!);
  await settle();
  const style = drawingStore.get(SYMBOL)[0]!.style;
  assert.equal(style.lineStyle, "dotted");
  assert.equal(style.dashed, true, "the boolean every renderer reads is kept in step");
});

test("W2A-05 — the bar is the reference's widget grammar: a drag handle, no carets, ink glyphs", async () => {
  const { bar } = await drawRisingLine();
  assert.ok(bar.querySelector("[data-drawing-bar-handle]"), "no drag handle");
  // CaretGlyph's path: a chevron on an 8×6 box. None of the triggers wears one.
  assert.equal(bar.querySelector('path[d="M1 1.5L4 4.5L7 1.5"]'), null, "a trigger still wears a caret");
  assert.doesNotMatch(bar.textContent ?? "", /Template/, "Template is an icon, as the reference's is");
  for (const button of bar.querySelectorAll<HTMLButtonElement>("button")) {
    assert.doesNotMatch(button.className, /\btext-ink-muted\b/,
      `${button.getAttribute("aria-label")} is drawn in the muted grey`);
  }
  const colour = bar.querySelector<HTMLButtonElement>('button[aria-label="Line color"]')!;
  const swatchBar = colour.querySelector("rect");
  assert.equal(swatchBar?.getAttribute("fill"), drawingStore.get(SYMBOL)[0]!.style.color,
    "the colour widget's bar is the line's colour");
});

test("W2D-03 — a drawing near the top does not put the bar on the legend", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Trendline");
  // Under the legend's 60px, so "above the drawing" does not fit and the old
  // fallbacks docked the bar at the top-left — on the series and study rows.
  await drag(chart.plot, [120, 90], [320, 70]);
  const bar = chart.container.querySelector<HTMLElement>("[data-drawing-style-bar]")!;
  const legend = [...bar.parentElement!.children].find((el) => isLegendColumn(el as HTMLElement));
  assert.ok(legend, "the bar and the legend column share a host");
  const box = barBox(bar);
  const overlapsLegend = box.left < LEGEND.width && box.top < LEGEND.height;
  assert.equal(overlapsLegend, false, `the bar ${JSON.stringify(box)} sits on the legend column`);
  // And it stacks above the column's `z-20`, so nothing the legend paints can
  // cover it or take its right-click.
  assert.match(bar.className, /\bz-30\b/);
  fireEvent.contextMenu(bar.querySelector("button")!, { button: 2, clientX: box.left + 10, clientY: box.top + 10 });
  await settle();
  assert.equal(menuLabel(), "Drawing", "a right-click on the bar opened something other than the drawing's menu");
});

test("W2A-05 — dragging the handle moves the bar, and the spot is kept for the session", async () => {
  const { chart, bar } = await drawRisingLine();
  const handle = bar.querySelector<HTMLElement>("[data-drawing-bar-handle]")!;
  const before = barBox(bar);
  fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(window, { clientX: 140, clientY: 160 });
  fireEvent.pointerUp(window, { clientX: 140, clientY: 160 });
  await settle();
  const moved = barBox(chart.container.querySelector<HTMLElement>("[data-drawing-style-bar]")!);
  assert.equal(moved.left, before.left + 40);
  assert.equal(moved.top, before.top + 60);
  const kept = JSON.parse(window.sessionStorage.getItem("tv.drawingToolbarPosition.v1") ?? "null");
  assert.deepEqual(kept, { left: moved.left, top: moved.top });
});

test("W2A-03 — Template opens the template menu, not the settings dialog", async () => {
  const { bar } = await drawRisingLine();
  fireEvent.click(bar.querySelector<HTMLButtonElement>('button[aria-label="Drawing template"]')!);
  await settle();
  assert.equal(screen.queryByRole("dialog"), null, "Template opened the whole settings dialog");
  const menu = bar.querySelector<HTMLElement>('[role="menu"][aria-label="Drawing template"]');
  assert.ok(menu, "no template menu opened");
  assert.deepEqual(
    [...menu.querySelectorAll('[role="menuitem"]')].map((el) => (el.textContent ?? "").trim()),
    ["Save Drawing Template As…", "Apply Default Drawing Template"]);
});

test("W2A-03 — a style saved as a template comes back, per tool, and Apply Default restores the default", async () => {
  const { chart, bar } = await drawRisingLine();
  const openTemplates = async (): Promise<HTMLElement> => {
    const current = chart.container.querySelector<HTMLElement>("[data-drawing-style-bar]")!;
    fireEvent.click(current.querySelector<HTMLButtonElement>('button[aria-label="Drawing template"]')!);
    await settle();
    return current.querySelector<HTMLElement>('[role="menu"][aria-label="Drawing template"]')!;
  };
  // Restyle: orange, 4px, dashed.
  fireEvent.click(bar.querySelector<HTMLButtonElement>('button[aria-label="Line color"]')!);
  await settle();
  fireEvent.click(bar.querySelector<HTMLButtonElement>('button[aria-label="#ff9800"]')!);
  await settle();
  const saved = { ...drawingStore.get(SYMBOL)[0]!.style };
  assert.equal(saved.color, "#ff9800");

  // Save it.
  let menu = await openTemplates();
  fireEvent.click(within(menu).getByText("Save Drawing Template As…"));
  await settle();
  fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), { target: { value: "Orange" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  const stored = JSON.parse(window.localStorage.getItem("tv.drawingTemplates.v1") ?? "[]");
  assert.deepEqual(stored.map((t: { name: string; tool: string }) => [t.name, t.tool]), [["Orange", "trend"]],
    "the template is saved for the tool it was saved from");

  // Apply Default: back to the style a new line starts with.
  menu = await openTemplates();
  fireEvent.click(within(menu).getByText("Apply Default Drawing Template"));
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.color, "#4f8cff");
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.width, 2);

  // The saved one is offered, and restores the saved look.
  menu = await openTemplates();
  fireEvent.click(within(menu).getByText("Orange"));
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.color, saved.color);
});

test("W2A-06 — Opacity writes an alpha into the colour, and a swatch keeps it", async () => {
  const { bar } = await drawRisingLine();
  fireEvent.click(bar.querySelector<HTMLButtonElement>('button[aria-label="Line color"]')!);
  await settle();
  const opacity = bar.querySelector<HTMLInputElement>('input[aria-label="Opacity"]');
  assert.ok(opacity, "the drawing colour picker has no Opacity control");
  assert.equal(opacity.value, "100");
  fireEvent.change(opacity, { target: { value: "50" } });
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.color, "#4f8cff80");
  // The tint grid is there too: the reference's six rows of ten under the hues.
  assert.ok(bar.querySelector('button[aria-label="#bbd9fb"]'), "no tint rows");
  fireEvent.click(bar.querySelector<HTMLButtonElement>('button[aria-label="#ff9800"]')!);
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.color, "#ff980080",
    "picking a hue threw away the opacity the user had chosen");
});
