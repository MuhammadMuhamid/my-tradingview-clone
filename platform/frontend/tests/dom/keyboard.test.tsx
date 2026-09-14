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
/*
 * The watchlist's add-a-symbol box is a real text input on this page, and it
 * is what the typing guards are tested against. Reaching it is now two
 * deliberate clicks — open the panel, open the field — because the field is a
 * disclosure that starts closed, and because the rail button that opens the
 * panel no longer borrows the field's own accessible name to be findable.
 */
async function textInput(container: HTMLElement): Promise<HTMLInputElement> {
  const panel = container.querySelector<HTMLElement>('button[aria-label="Watchlist"]');
  assert.ok(panel, "the right rail offers no watchlist");
  if (panel.getAttribute("aria-pressed") !== "true") { fireEvent.click(panel); await settle(); }
  const open = container.querySelector<HTMLElement>('button[aria-label="Add a symbol to this list"]');
  assert.ok(open, "the watchlist offers no way to add a symbol");
  fireEvent.click(open);
  await settle();
  const input = container.querySelector<HTMLInputElement>("input:not([type='checkbox'])");
  assert.ok(input, "the workspace renders no text input");
  return input;
}

/*
 * TVP8 R4b-05 rewrote this test rather than deleting it.
 *
 * It used to read "a bare letter arms its tool", which was this product's own
 * decision and the reference's opposite: TradingView spends every bare letter
 * on "Change symbol: any letter" and puts the tools on ⌥-chords. The claim
 * the test protects — the workspace's one listener is what makes a keystroke
 * arm a tool at all — is unchanged; the chord is the reference's now, and the
 * bare letter is asserted to do the reference's thing instead.
 */
test("an ⌥ chord arms its tool, and the bare letter opens the symbol search", async () => {
  const chart = await mountChart();
  assert.equal(armedTool(chart.container), "Cross");

  await press("t", { altKey: true }, document.body);
  assert.equal(armedTool(chart.container), "Trendline",
    "⌥T is the trend tool, and the workspace listener is what makes it so");

  await press("h", { altKey: true }, document.body);
  assert.equal(armedTool(chart.container), "Horizontal line");

  // And the bare letter is the SYMBOL, with the letter already in the box.
  await press("e", {}, document.body);
  const dialog = screen.queryByRole("dialog");
  assert.ok(dialog, "a bare letter over the chart must open the symbol search");
  assert.equal(dialog.getAttribute("aria-label"), "Symbol search");
  const box = dialog.querySelector<HTMLInputElement>("input");
  assert.ok(box, "the search has no box");
  assert.equal(box.value, "e", "the letter that opened it is what it is searching for");
  assert.equal(box.selectionStart, 1, "the seed is a starting point, not a selection to overwrite");
  assert.equal(box.selectionEnd, 1);
  assert.equal(armedTool(chart.container), "Horizontal line",
    "and no tool changed underneath it");

  await press("Escape", {}, dialog);
  await settle();
});

test("no shortcut fires while the user is typing, and the field keeps the key", async () => {
  const chart = await mountChart();
  const input = await textInput(chart.container);
  input.focus();

  fireEvent.change(input, { target: { value: "BT" } });
  await press("t", {}, input);

  assert.equal(armedTool(chart.container), "Cross",
    "a `t` taken from the middle of a symbol is a keystroke the user must notice is missing");
  assert.equal(input.value, "BT");

  input.blur();
  await press("t", { altKey: true }, document.body);
  assert.equal(armedTool(chart.container), "Trendline");

  // Nor does a bare letter typed into a field escape it as a symbol search.
  input.focus();
  await press("e", {}, input);
  assert.equal(screen.queryByRole("dialog"), null,
    "an `e` taken from the middle of a symbol to open a SEARCH for symbols is the same defect");
});

test("a surface that owns its keys keeps Cmd+Z, so undo cannot reach the chart", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Trendline");
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

  // A bare letter opens the symbol search, which is a real dialog (R4b-05;
  // `/` is the reference's Indicators, and opens a different one).
  await press("b", {}, document.body);
  const dialog = screen.queryByRole("dialog");
  assert.ok(dialog, "a bare letter must open the symbol search");

  // A chord must not reach the chart behind it, wherever focus landed.
  await press("t", { altKey: true }, dialog);
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

/*
 * Rewritten with R4b-05: `h` on its own is a search for `h`, not the
 * horizontal line — which is exactly why the interval buffer has to win over
 * it while one is open, and that is what the test above this one pins. The
 * tool's chord is ⌥H.
 */
test("a bare unit letter with no interval open is the symbol, not the tool", async () => {
  const chart = await mountChart();
  await press("h", {}, document.body);
  const dialog = screen.queryByRole("dialog");
  assert.ok(dialog, "a bare `h` opens the symbol search");
  assert.equal(dialog.querySelector<HTMLInputElement>("input")?.value, "h");
  assert.equal(armedTool(chart.container), "Cross", "no tool was armed");
  assert.equal(armedInterval(chart.container), "15m", "no interval was typed");
  await press("Escape", {}, dialog);
  await settle();

  await press("h", { altKey: true }, document.body);
  assert.equal(armedTool(chart.container), "Horizontal line");
});

test("a letter that cannot continue an interval clears the half-typed buffer", async () => {
  const chart = await mountChart();
  /*
   * R4b-05 rewrote what the letter DOES — `t` opens the symbol search rather
   * than arming the trendline — and left the rule this test exists for
   * exactly where it was: the `15` must not still be waiting behind whatever
   * the letter did, or the next Enter is a silent timeframe change.
   */
  await pressAll(["1", "5", "t"]);
  const dialog = screen.queryByRole("dialog");
  assert.ok(dialog, "`t` is not an interval key, so it is a symbol search");
  assert.equal(dialog.querySelector<HTMLInputElement>("input")?.value, "t");
  await press("Escape", {}, dialog);
  await settle();

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
