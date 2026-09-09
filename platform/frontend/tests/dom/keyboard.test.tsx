/**
 * The keyboard, on a real document.
 *
 * ── Why this could not be tested before ────────────────────────────────────
 *
 * `lib/shortcuts` is pure and thoroughly tested: a described key event goes
 * in, an action name comes out. `useShortcuts` is the part that decides WHICH
 * events get described — it reads `event.target`, it asks the document whether
 * a dialog is open, and it holds the interval buffer across keystrokes. None
 * of that exists without a document, so the suite had a hand-written mirror of
 * the hook's decision order beside the pure table, which is a test of the
 * mirror.
 *
 * These press keys at the real page. The guard is exercised by focusing a real
 * input; the dialog rule by opening a real dialog; the interval buffer by
 * typing `4`, `h`, Enter and watching the chart change timeframe.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import {
  armedInterval, armedTool, drag, mountChart, press, pressAll, selectTool,
} from "./harness/chart";
import { drawingStore } from "@/lib/drawingStore";

const SYMBOL = "SOLUSDT";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/**
 * The workspace's own text input: the watchlist's "add a pair" box.
 *
 * Opened first, because FC2-L3 took it out of the permanently-reserved header
 * row — the header stacked 139px deep before the first symbol against
 * TradingView's 118px — and put it behind the `+` affordance beside the list
 * name. Clicking that is what a user does, so it is what this does.
 */
function textInput(container: HTMLElement): HTMLInputElement {
  const open = container.querySelector<HTMLElement>('button[aria-label="Add a symbol to this list"]');
  assert.ok(open, "the watchlist offers no way to add a symbol");
  fireEvent.click(open);
  const input = container.querySelector<HTMLInputElement>("input:not([type='checkbox'])");
  assert.ok(input, "the workspace renders no text input");
  return input;
}

test("a bare letter arms its tool when nothing is focused", async () => {
  const chart = await mountChart();
  assert.equal(armedTool(chart.container), "Cross");

  await press("t", {}, document.body);
  assert.equal(armedTool(chart.container), "Trend line",
    "t is the trend tool, and the workspace listener is what makes it so");

  await press("h", {}, document.body);
  assert.equal(armedTool(chart.container), "Horizontal line");
});

test("no shortcut fires while the user is typing, and the field keeps the key", async () => {
  const chart = await mountChart();
  const input = textInput(chart.container);
  input.focus();

  fireEvent.change(input, { target: { value: "BT" } });
  await press("t", {}, input);

  assert.equal(armedTool(chart.container), "Cross",
    "a `t` taken from the middle of a symbol is a keystroke the user must notice is missing");
  assert.equal(input.value, "BT");

  input.blur();
  await press("t", {}, document.body);
  assert.equal(armedTool(chart.container), "Trend line");
});

test("a surface that owns its keys keeps Cmd+Z, so undo cannot reach the chart", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Trend line");
  await drag(chart.plot, [300, 260], [520, 380]);
  assert.equal(drawingStore.get(SYMBOL).length, 1);

  // The Pine editor marks itself `data-owns-keys`; anything inside it owns
  // every key aimed at it, Cmd+Z included.
  const editor = document.createElement("div");
  editor.setAttribute("data-owns-keys", "");
  const inner = document.createElement("div");
  inner.tabIndex = 0;
  editor.appendChild(inner);
  document.body.appendChild(editor);
  inner.focus();

  await press("z", { metaKey: true }, inner);
  assert.equal(drawingStore.get(SYMBOL).length, 1,
    "Cmd+Z inside the editor must undo the editor, not a drawing on a chart " +
    "the user is not looking at");

  editor.remove();
  await press("z", { metaKey: true }, document.body);
  assert.equal(drawingStore.get(SYMBOL).length, 0, "and outside it, undo is the chart's");
});

test("an open dialog is modal to the keyboard layer", async () => {
  const chart = await mountChart();

  // `/` opens the symbol search, which is a real dialog.
  await press("/", {}, document.body);
  const dialog = screen.queryByRole("dialog");
  assert.ok(dialog, "/ must open the symbol search");

  // A bare letter must not reach the chart behind it, wherever focus landed.
  await press("t", {}, dialog);
  assert.equal(armedTool(chart.container), "Cross",
    "a shortcut that acts on the chart behind an open dialog is how `/` came " +
    "to stack a second search on top of the first");

  await press("Escape", {}, dialog);
  await settle();
});

test("an interval with a unit letter can actually be typed", async () => {
  const chart = await mountChart();
  assert.equal(armedInterval(chart.container), "15m");

  // `h` is the horizontal-line tool and `m` is the magnet. While a buffer is
  // open they belong to the interval instead — which is what makes `4h` and
  // `15m`, the two most-used timeframes on the product, typable at all.
  await pressAll(["4", "h", "Enter"]);
  assert.equal(armedInterval(chart.container), "4h");
  assert.equal(armedTool(chart.container), "Cross",
    "the `h` was part of the interval, so no tool was armed");

  await pressAll(["1", "5", "m", "Enter"]);
  assert.equal(armedInterval(chart.container), "15m");

  await pressAll(["1", "d", "Enter"]);
  assert.equal(armedInterval(chart.container), "1d");

  // A bare number is still minutes, and 60 is still an hour.
  await pressAll(["6", "0", "Enter"]);
  assert.equal(armedInterval(chart.container), "1h");
});

test("a bare unit letter is still its tool, because no interval is being typed", async () => {
  const chart = await mountChart();
  await press("h", {}, document.body);
  assert.equal(armedTool(chart.container), "Horizontal line");
  assert.equal(armedInterval(chart.container), "15m", "no interval was typed");
});

test("a tool key that cannot continue an interval clears the half-typed buffer", async () => {
  const chart = await mountChart();
  await pressAll(["1", "5", "t"]);
  assert.equal(armedTool(chart.container), "Trend line");

  // The `15` must not still be waiting behind the tool change: pressing Enter
  // now would otherwise silently change timeframe.
  await press("Enter", {}, document.body);
  assert.equal(armedInterval(chart.container), "15m", "the chart's own default, unchanged");

  // And an interval that the backend does not serve resolves to nothing at all
  // rather than to the nearest one.
  await pressAll(["7", "m", "Enter"]);
  assert.equal(armedInterval(chart.container), "15m");
});

test("a typed interval loads that timeframe's candles", async () => {
  const chart = await mountChart();
  const before = server.callsTo("interval=1h").length;

  await pressAll(["1", "h", "Enter"]);
  await settle();

  assert.equal(armedInterval(chart.container), "1h");
  assert.ok(server.callsTo("interval=1h").length > before,
    "changing timeframe must actually reload the bars, not just repaint the strip");
});

test("? opens the shortcuts sheet, on a layout where ? is shifted", async () => {
  const chart = await mountChart();
  await press("?", { shiftKey: true }, document.body);
  assert.ok(
    screen.queryByRole("dialog") ?? screen.queryByRole("alertdialog"),
    "the discovery surface for the whole keyboard layer must be reachable from it");
  assert.ok(chart.container);
});
