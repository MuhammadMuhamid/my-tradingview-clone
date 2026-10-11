/**
 * M1 / F-01 and F-10: text is typed ON THE CHART, and the floating toolbar's
 * widgets are the tool's.
 *
 * ── What the reviewer measured on live Premium ─────────────────────────────
 *
 * Rail → Text, click the chart: an editor opens on the canvas AT THE CLICK and
 * the floating toolbar appears beside it (drag · Template · Text colour · `14`
 * · Settings · Lock · Delete · More). Trading Scene opened a 512×209 modal
 * `Text` dialog — one field, Cancel / Place — and drew nothing until Place.
 *
 * And the selected drawing's toolbar carried Clone and Hide, which the
 * reference's does not, and the same width/style widgets on a text as on a
 * line, where the reference shows a font size.
 *
 * Everything here is driven through the real workspace, the real drawing
 * layer and the real store, the way `drawingDoubleClick.test.tsx` is.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { armedTool, clickAt, drag, mountChart, press, selectTool, type MountedChart } from "./harness/chart";
import { drawingStore } from "@/lib/drawingStore";

const SYMBOL = "SOLUSDT";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

const editor = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>("textarea[data-drawing-text-editor]");
const bar = (chart: MountedChart): HTMLElement | null =>
  chart.container.querySelector<HTMLElement>("[data-drawing-style-bar]");
const stored = () => drawingStore.get(SYMBOL);

/** The bar's widgets, by accessible name, in order. */
function widgets(chart: MountedChart): string[] {
  const el = bar(chart);
  assert.ok(el, "no floating toolbar");
  return [...el.querySelectorAll<HTMLButtonElement>("button")]
    .map((button) => button.getAttribute("aria-label") ?? "");
}

/** Arm `tool`, click the chart once, and return the open editor. */
async function placeText(tool = "Text", at: [number, number] = [400, 300]): Promise<{
  chart: MountedChart; box: HTMLTextAreaElement;
}> {
  const chart = await mountChart();
  await selectTool(chart.container, tool);
  await clickAt(chart.plot, ...at);
  const box = editor();
  assert.ok(box, `clicking with ${tool} opened no inline editor`);
  return { chart, box };
}

async function type(box: HTMLTextAreaElement, value: string): Promise<void> {
  fireEvent.change(box, { target: { value } });
  await settle();
}

test("F-01 — a click with Text places the drawing there and opens an editor on the canvas, not a dialog", async () => {
  const { chart, box } = await placeText();
  assert.equal(screen.queryByRole("dialog"), null, "the modal Text dialog is back");

  const [drawing] = stored();
  assert.ok(drawing, "the click placed nothing: the drawing must exist at the click, before any text");
  assert.equal(drawing.tool, "text");
  assert.equal(drawing.style.fontSize, 14, "a new text is the reference's 14");

  // In the pane, at the anchor — not a fixed dialog at the top of the window.
  // Booleans, never elements: a failing `assert.equal` of two DOM nodes
  // inspects the whole jsdom tree and never finishes.
  assert.ok(box.parentElement?.contains(chart.plot) === true,
    "the editor is not positioned in the chart's own box");
  assert.match(box.className, /\babsolute\b/);
  const left = parseFloat(box.style.left);
  const top = parseFloat(box.style.top);
  assert.ok(Math.abs(left - 404) <= 20, `the editor's left ${left} is not at the click`);
  assert.ok(Math.abs(top - (300 - 14)) <= 30, `the editor's top ${top} is not at the click`);
  // Styled as the text it is typing.
  assert.match(box.style.font, /14px/);
  assert.ok(document.activeElement === box, "the editor is not focused, so typing goes nowhere");

  // The toolbar is up beside it while typing.
  assert.ok(bar(chart), "no floating toolbar while the text is being typed");

  await type(box, "Breakout");
  await press("Enter", {}, box);
  assert.equal(editor(), null, "Enter did not commit");
  assert.equal(stored()[0]?.style.text, "Breakout");
  assert.equal(armedTool(chart.container), "Cross", "the rail is not back on the cursor");
});

test("F-01 — the other text-carrying tools edit inline too (Note, Callout, Price note)", async () => {
  for (const tool of ["Note", "Callout", "Price note"]) {
    resetBrowser();
    server.setDefaultCandles(compactSeries(600));
    const { box } = await placeText(tool);
    assert.equal(screen.queryByRole("dialog"), null, `${tool} still opens a dialog`);
    await type(box, `${tool} caption`);
    await press("Enter", {}, box);
    assert.equal(stored()[0]?.style.text, `${tool} caption`, `${tool} did not keep its caption`);
  }
});

test("F-01 — one undo removes a freshly placed and typed text", async () => {
  const { box } = await placeText();
  await type(box, "One step");
  await press("Enter", {}, box);
  assert.equal(stored().length, 1);
  assert.deepEqual(drawingStore.undo(SYMBOL), [], "undo did not take the placed text away in one step");
  assert.equal(drawingStore.historyState(SYMBOL).canUndo, false,
    "placing and typing were recorded as two steps");
  assert.equal(drawingStore.redo(SYMBOL)?.[0]?.style.text, "One step", "redo does not bring the text back");
});

test("F-01 — Escape cancels a fresh text: nothing is left, and nothing to undo", async () => {
  const { box } = await placeText();
  await type(box, "never mind");
  await press("Escape", {}, box);
  assert.equal(editor(), null);
  assert.equal(stored().length, 0, "Escape left the drawing behind");
  assert.equal(drawingStore.historyState(SYMBOL).canUndo, false,
    "a placement that was cancelled left an undo step that does nothing");
});

test("F-01 — committing an empty text removes it", async () => {
  const { box } = await placeText();
  await press("Enter", {}, box);
  assert.equal(stored().length, 0, "an empty, invisible text drawing was kept");
  // Whitespace is empty too.
  const again = await placeText();
  await type(again.box, "   ");
  fireEvent.blur(again.box);
  await settle();
  assert.equal(stored().length, 0);
});

test("F-01 — Shift+Enter is a new line; clicking elsewhere on the chart commits", async () => {
  const { chart, box } = await placeText();
  await press("Enter", { shiftKey: true }, box);
  assert.ok(editor(), "Shift+Enter closed the editor instead of breaking the line");
  await type(box, "first\nsecond");
  // A press on the chart: the drawing layer prevents its default, so this is
  // the case a blur alone would never see.
  fireEvent.mouseDown(chart.plot, { button: 0, clientX: 900, clientY: 500, bubbles: true });
  fireEvent.mouseUp(chart.plot, { button: 0, clientX: 900, clientY: 500, bubbles: true });
  await settle();
  assert.equal(editor(), null, "clicking elsewhere did not close the editor");
  assert.equal(stored()[0]?.style.text, "first\nsecond");
});

test("F-01 — keystrokes in the editor never reach the chart's shortcuts", async () => {
  const { chart, box } = await placeText();
  const before = armedTool(chart.container);
  // A bare letter opens the symbol search; `h` arms a tool; Delete removes
  // the selection; a digit starts an interval.
  for (const key of ["b", "h", "Delete", "Backspace", "1", "/"]) {
    await press(key, {}, box);
    assert.equal(screen.queryByRole("dialog"), null, `typing ${key} in the editor opened a dialog`);
    assert.equal(stored().length, 1, `typing ${key} in the editor deleted the drawing`);
    assert.equal(armedTool(chart.container), before, `typing ${key} in the editor changed the tool`);
    assert.ok(editor(), `typing ${key} closed the editor`);
  }
  assert.ok(box.closest("[data-owns-keys]"), "the editor does not declare that it owns its keys");
});

test("F-01 — double-clicking an existing text edits it inline; one undo restores the old text", async () => {
  const { chart, box } = await placeText();
  await type(box, "Hello");
  await press("Enter", {}, box);

  fireEvent.dblClick(chart.plot, { clientX: 402, clientY: 300 });
  await settle(2);
  assert.equal(screen.queryByRole("dialog"), null, "double-clicking a text opened the settings dialog");
  const again = editor();
  assert.ok(again, "double-clicking a text did not open its inline editor");
  assert.equal(again.value, "Hello", "the editor does not start from the drawing's text");
  await type(again, "Hello world");
  await press("Enter", {}, again);
  assert.equal(stored()[0]?.style.text, "Hello world");
  assert.equal(drawingStore.undo(SYMBOL)?.[0]?.style.text, "Hello", "one undo does not restore the edit");
});

test("F-01 — Escape on an existing text keeps it as it was", async () => {
  const { chart, box } = await placeText();
  await type(box, "Keep me");
  await press("Enter", {}, box);
  fireEvent.dblClick(chart.plot, { clientX: 402, clientY: 300 });
  await settle(2);
  const again = editor()!;
  await type(again, "");
  await press("Escape", {}, again);
  assert.equal(stored().length, 1, "Escape on an edit deleted the drawing");
  assert.equal(stored()[0]?.style.text, "Keep me");
});

test("F-01 — a LOCKED text still opens its settings on double-click, and the gear reaches them", async () => {
  const { chart, box } = await placeText();
  await type(box, "Settings");
  await press("Enter", {}, box);
  // The gear, from the text's own toolbar.
  fireEvent.click(bar(chart)!.querySelector<HTMLButtonElement>('button[aria-label="Settings for this drawing"]')!);
  await settle(2);
  assert.ok(screen.queryByRole("dialog"), "Settings… on a text's toolbar opens nothing");
  assert.equal(editor(), null);
  fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
  await settle(2);

  drawingStore.set(SYMBOL, stored().map((d) => ({ ...d, locked: true })));
  await settle();
  fireEvent.dblClick(chart.plot, { clientX: 402, clientY: 300 });
  await settle(2);
  assert.equal(editor(), null, "a locked text was opened for editing");
  assert.ok(screen.queryByRole("dialog"), "a locked text's double-click opened nothing");
});

test("F-10 — a line's toolbar is Template · Colour · Width · Style · Settings · Lock · Delete · More", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [300, 260], [520, 380]);
  assert.deepEqual(widgets(chart), [
    "Drawing template", "Line color", "Line width", "Line style",
    "Settings for this drawing", "Lock this drawing", "Delete this drawing", "More drawing actions",
  ]);
  // Clone and Hide live in More, which is the drawing's menu.
  fireEvent.click(bar(chart)!.querySelector<HTMLButtonElement>('button[aria-label="More drawing actions"]')!);
  await settle();
  const menu = screen.getByRole("menu");
  assert.match(menu.textContent ?? "", /Clone/);
  assert.match(menu.textContent ?? "", /Hide/);
});

test("F-10 — a text's toolbar is Template · Text colour · font size · Settings · Lock · Delete · More", async () => {
  const { chart, box } = await placeText();
  await type(box, "Sized");
  await press("Enter", {}, box);
  assert.deepEqual(widgets(chart), [
    "Drawing template", "Text color", "Font size",
    "Settings for this drawing", "Lock this drawing", "Delete this drawing", "More drawing actions",
  ]);
  const size = bar(chart)!.querySelector<HTMLButtonElement>('button[aria-label="Font size"]')!;
  assert.equal((size.textContent ?? "").trim(), "14");
  fireEvent.click(size);
  await settle();
  const rows = [...bar(chart)!.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="Font size"] [role="option"]')];
  assert.deepEqual(rows.map((row) => (row.textContent ?? "").trim()),
    ["10", "11", "12", "14", "16", "20", "24", "28", "32", "40"]);
  assert.equal(rows.find((row) => row.getAttribute("aria-selected") === "true")?.textContent, "14");
  fireEvent.click(rows[5]!);
  await settle();
  assert.equal(stored()[0]?.style.fontSize, 20);
  assert.equal((bar(chart)!.querySelector('button[aria-label="Font size"]')?.textContent ?? "").trim(), "20");
  // And it is a step of its own.
  assert.equal(drawingStore.undo(SYMBOL)?.[0]?.style.fontSize, 14, "a font-size change is not undoable");
});

test("F-10 — a note keeps its line colour beside the text colour and size", async () => {
  const { chart, box } = await placeText("Note");
  await type(box, "boxed");
  await press("Enter", {}, box);
  assert.deepEqual(widgets(chart), [
    "Drawing template", "Line color", "Text color", "Font size",
    "Settings for this drawing", "Lock this drawing", "Delete this drawing", "More drawing actions",
  ]);
});

test("F-10 — changing the size from the toolbar while typing keeps the editor and the typed text", async () => {
  const { chart, box } = await placeText();
  await type(box, "mid-edit");
  const size = bar(chart)!.querySelector<HTMLButtonElement>('button[aria-label="Font size"]')!;
  fireEvent.mouseDown(size);
  fireEvent.click(size);
  await settle();
  assert.ok(editor(), "touching the toolbar closed the editor");
  const row = [...bar(chart)!.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((r) => (r.textContent ?? "").trim() === "24")!;
  fireEvent.mouseDown(row);
  fireEvent.click(row);
  await settle();
  assert.equal(stored()[0]?.style.fontSize, 24);
  const open = editor();
  assert.ok(open, "choosing a size closed the editor");
  assert.match(open.style.font, /24px/, "the editor does not follow the drawing's size");
  await press("Enter", {}, open);
  assert.equal(stored()[0]?.style.text, "mid-edit");
});
