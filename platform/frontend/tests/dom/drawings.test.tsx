/**
 * Drawings, as gestures on a rendered chart.
 *
 * ── What is new here ───────────────────────────────────────────────────────
 *
 * The drawing layer has always been tested through its pure parts: the
 * distance functions, the undo history, the clone offset. What could not be
 * tested was the layer itself — a mousedown reaching a canvas that is listening
 * in the capture phase, a price read back through the chart's own scale, a
 * store shared by two panes, and a debounced push carrying the version it last
 * read. Every one of those is a wire between two correct things, and the
 * previous campaign lost user data in three of them.
 *
 * These tests drive the real workspace: real `lightweight-charts`, real
 * coordinate arithmetic, the real store and the real sync module, against a
 * fixture origin that implements the server's version rule exactly.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { advance, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import {
  clickAt, drag, menuLabel, mountChart, press, rightClickRegion, selectTool,
} from "./harness/chart";
import { fireEvent } from "@testing-library/react";
import { drawingStore } from "@/lib/drawingStore";
import { loadDrawings } from "@/lib/drawings";

const SYMBOL = "SOLUSDT";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

test("a drag with the trend tool creates one drawing at the prices under the pointer", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Trendline");

  await drag(chart.plot, [300, 260], [520, 380]);

  const drawings = drawingStore.get(SYMBOL);
  assert.equal(drawings.length, 1, "one gesture must create exactly one drawing");
  const [line] = drawings;
  assert.equal(line!.tool, "trend");
  assert.equal(line!.points.length, 2);

  // The anchors came from the chart's own scales, so they are real prices and
  // real bar times — and the lower pixel is the lower price, because the
  // price axis runs upwards.
  for (const point of line!.points) {
    assert.ok(Number.isFinite(point.price) && point.price > 0,
      `an anchor priced ${point.price} means the chart's scale was never consulted`);
    assert.ok(Number.isFinite(point.time) && point.time > 0);
  }
  assert.ok(line!.points[0]!.price > line!.points[1]!.price,
    "y=260 is above y=380 on screen, so it must be the higher price");
  assert.ok(line!.points[1]!.time > line!.points[0]!.time,
    "x=520 is later than x=300");
});

test("the toolbar counts the drawings that are actually on the chart", async () => {
  /*
   * The count moved off the cell and into the flyout.
   *
   * It used to be `disabled={count === 0}` with `disabled:opacity-30` and a
   * number printed underneath — so on an empty chart the Remove cell was the
   * only dimmed control in the column, and on a busy one the only one wearing
   * a badge. The reference does neither: the cell is full ink and pressable
   * always, and its flyout carries one counted row per scope.
   */
  const chart = await mountChart();
  const removeCell = (): HTMLButtonElement => {
    const button = chart.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove objects"]');
    assert.ok(button, "the drawing toolbar has no remove control");
    return button;
  };
  const removeRow = (): HTMLElement | null => {
    // The strip toggles, and a drawing gesture stops its own events before
    // they reach the rail's outside-click listener — so the flyout may already
    // be open, and clicking blindly would close it.
    const strip = chart.container.querySelector<HTMLElement>(
      'button[aria-label="More remove tools"]')!;
    if (strip.getAttribute("data-open") !== "true") fireEvent.click(strip);
    return [...chart.container.querySelectorAll<HTMLElement>("button")]
      .find((b) => /^Remove \d+ drawings?$/.test((b.textContent ?? "").trim())) ?? null;
  };

  assert.equal(removeCell().disabled, false,
    "an empty chart still offers the control, as the reference does");
  assert.equal(removeRow()?.textContent?.trim(), "Remove 0 drawings");

  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [300, 260], [520, 380]);
  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [340, 300], [560, 420]);

  assert.equal(removeRow()?.textContent?.trim(), "Remove 2 drawings",
    "the toolbar must count what the store holds, not what it last rendered");
});

test("a drawing can be selected, moved as one gesture, and deleted", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [300, 260], [520, 380]);
  const created = drawingStore.get(SYMBOL)[0]!;

  // Back to the cursor, then grab the line by its body and move it down.
  await selectTool(chart.container, "Cross");
  await drag(chart.plot, [410, 320], [410, 360]);

  const moved = drawingStore.get(SYMBOL)[0]!;
  assert.equal(drawingStore.get(SYMBOL).length, 1, "a move must not create a second drawing");
  assert.equal(moved.id, created.id);
  for (const i of [0, 1]) {
    assert.ok(moved.points[i]!.price < created.points[i]!.price,
      "dragging downwards must lower every anchor, not just the one under the pointer");
  }
  // Both anchors moved by the same amount: this is a move, not a reshape.
  const shift0 = created.points[0]!.price - moved.points[0]!.price;
  const shift1 = created.points[1]!.price - moved.points[1]!.price;
  assert.ok(Math.abs(shift0 - shift1) < shift0 * 1e-6,
    "a body drag translates the whole drawing");

  // The whole drag is ONE undo step, which is the thing sixty pointer samples
  // would otherwise destroy.
  assert.equal(drawingStore.undo(SYMBOL)?.[0]?.points[0]?.price, created.points[0]!.price);
  drawingStore.redo(SYMBOL);

  await press("Delete");
  assert.equal(drawingStore.get(SYMBOL).length, 0, "Delete removes the selected drawing");
});

test("Delete is refused while the user is typing, and taken when they are not", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [300, 260], [520, 380]);

  // The watchlist's "add a pair" box is a real input on this page. It opens
  // from the `+` beside the list name, inside the panel the rail opens.
  const panel = chart.container.querySelector<HTMLElement>('button[aria-label="Watchlist"]');
  assert.ok(panel, "the right rail offers no watchlist");
  if (panel.getAttribute("aria-pressed") !== "true") { fireEvent.click(panel); await settle(); }
  const open = chart.container.querySelector<HTMLElement>('button[aria-label="Add a symbol to this list"]');
  assert.ok(open, "the watchlist offers no way to add a symbol");
  fireEvent.click(open);
  await settle();
  const input = chart.container.querySelector<HTMLInputElement>('input[type="text"], input:not([type])');
  assert.ok(input, "the workspace renders no text input to test the guard with");
  input.focus();
  await press("Delete", {}, input);
  assert.equal(drawingStore.get(SYMBOL).length, 1,
    "Delete inside a text field is a text edit, never a drawing deletion");

  input.blur();
  await press("Delete", {}, document.body);
  assert.equal(drawingStore.get(SYMBOL).length, 0);
});

test("an edit reaches the server once, carrying the version it read", async () => {
  const chart = await mountChart();
  assert.equal(server.callsTo("/api/chart-state/drawings").length, 1,
    "the workspace reads the server's drawings exactly once per instrument on load");

  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [300, 260], [520, 380]);

  assert.equal(
    server.calls.filter((c) => c.method === "PUT" && c.path.includes("drawings")).length, 0,
    "a save must be debounced: a drag emits a change per pointer sample");

  await advance(1_400);

  const writes = server.calls.filter((c) => c.method === "PUT" && c.path.includes("drawings"));
  assert.equal(writes.length, 1);
  assert.equal((writes[0]!.body as { baseVersion: number }).baseVersion, 0,
    "the first write says it believes nothing is stored");
  assert.equal(server.getDrawings(SYMBOL).version, 1);
  assert.equal(server.getDrawings(SYMBOL).drawings.length, 1);
});

test("a save refused as stale adopts the server's list rather than overwriting it", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [300, 260], [520, 380]);
  await advance(1_400);
  assert.equal(server.getDrawings(SYMBOL).version, 1);

  /*
   * Another device writes while this one is holding version 1: it deletes
   * everything. This device then edits again and saves against the version it
   * still believes in.
   */
  server.seedDrawings(SYMBOL, [], 7);

  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [340, 300], [560, 420]);
  await advance(1_400);

  assert.equal(drawingStore.get(SYMBOL).length, 0,
    "the refused write must adopt what the server actually holds — the other " +
    "device's deletion stays deleted");
  assert.equal(server.getDrawings(SYMBOL).version, 7,
    "a refused write must not have been applied");
});

test("a reload does not push a deletion back up from this device's own storage", async () => {
  // This device drew and saved.
  const first = await mountChart();
  await selectTool(first.container, "Trendline");
  await drag(first.plot, [300, 260], [520, 380]);
  await advance(1_400);
  assert.equal(loadDrawings(SYMBOL).length, 1, "the drawing is in this browser's storage");

  // The other device deleted everything and saved. This browser's own
  // localStorage still holds the drawing.
  server.seedDrawings(SYMBOL, [], 4);

  // Reload: a fresh page against the same browser storage.
  resetBrowserKeepingStorage();
  await mountChart();
  await advance(1_400);

  const writes = server.calls.filter(
    (c) => c.method === "PUT" && c.path.includes("drawings"));
  assert.equal(writes.length, 0,
    "a load must never write: an import that ran twice is how a deletion gets undone");
  assert.equal(server.getDrawings(SYMBOL).drawings.length, 0);
  assert.equal(server.getDrawings(SYMBOL).version, 4);

  /*
   * What this device still SHOWS, stated rather than assumed.
   *
   * `decideSync` adopts only a server list that has something in it, so an
   * emptied row leaves this device's local copy on screen and untouched. That
   * is deliberate — `lib/chartStateSync` refuses to clear local work on the
   * strength of an empty response, because an empty response is also what a
   * half-provisioned row looks like — and it is asserted here so that a change
   * to it is a decision somebody made rather than a surprise.
   *
   * The residual gap it leaves is recorded in this phase's evidence: the next
   * edit on this device writes against the version the sync handed back, so
   * the other device's deletion can be undone one gesture later. Closing that
   * changes what "adopt" means, which is a product decision for a product
   * phase, not a change to make while building the harness that found it.
   */
  assert.equal(drawingStore.get(SYMBOL).length, 1,
    "an emptied server row does not clear this device's local copy");
});

test("advanced families create their declared anchors through the real flyout", async () => {
  const chart = await mountChart();
  // These families used to share one `advanced` group; they are now spread
  // across trend-line, gann-and-fibonacci, patterns and, since the rail took
  // the reference's sections, "Cycles" inside patterns rather than the tail of
  // the forecasting group. `selectTool` opens whichever flyout holds the tool,
  // so this test asserts the anchors rather than the rail's taxonomy.
  const make = async (label: string, points: [number, number][]): Promise<void> => {
    await selectTool(chart.container, label);
    await advance(1);
    for (const [x, y] of points) await clickAt(chart.plot, x, y);
  };
  await make("Schiff pitchfork", [[220, 300], [360, 240], [360, 360]]);
  await make("Gann square", [[240, 280], [420, 420]]);
  await make("XABCD pattern", [[180, 260], [240, 320], [300, 240], [360, 320], [420, 260]]);
  await make("Cyclic lines", [[260, 300], [320, 300]]);
  const tools = drawingStore.get(SYMBOL);
  assert.deepEqual(tools.map((d) => d.tool), ["schiffPitchfork", "gannSquare", "xabcd", "cyclicLines"]);
  assert.deepEqual(tools.map((d) => d.points.length), [3, 2, 5, 2]);
});

/**
 * A reload, which is not the same thing as a new browser.
 *
 * `resetBrowser` empties local storage; the case this test needs is the
 * opposite one — the tab is gone and everything it wrote is still on disk. The
 * server keeps its rows and loses its request log, so what the reloaded page
 * asks for is all that is counted.
 */
function resetBrowserKeepingStorage(): void {
  const saved: Record<string, string> = {};
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)!;
    saved[key] = window.localStorage.getItem(key)!;
  }
  const drawings = new Map(server.drawings);
  const panes = new Map(server.panes);
  resetBrowser();
  for (const [key, value] of Object.entries(saved)) window.localStorage.setItem(key, value);
  for (const [key, value] of drawings) server.drawings.set(key, value);
  for (const [key, value] of panes) server.panes.set(key, value);
  server.setDefaultCandles(compactSeries(600));
}

/*
 * ── TVP8 R2c follow-up: a right-click is classified by WHAT IT HIT ─────────
 *
 * `DrawingCanvas` decided which of the chart's three strips a right-click
 * landed on with arithmetic over this pane's own scales —
 * `clientWidth − priceScale("right").width()` and
 * `clientHeight − timeScale().height()`. That is a model of the chart rather
 * than the chart, and where the model and the chart disagreed the user got the
 * wrong menu with nothing said about it.
 *
 * The worst case is not hypothetical: the time axis is drawn ONCE, under the
 * lowest pane on screen, so the moment a study pane is mounted this pane's own
 * time scale is hidden, `timeScale().height()` is 0, and no point in this pane
 * can be classified "time" at all — `Time scale` became unreachable for anyone
 * with an RSI open.
 */

test("a right-click on the price axis opens the Price scale menu", async () => {
  const chart = await mountChart();

  await rightClickRegion(chart.pane(0), "axis");
  assert.equal(menuLabel(), "Price scale");
});

test("the CELL decides the menu, not the pane's own scale arithmetic", async () => {
  /*
   * The same event on the same axis cell, carrying a pointer coordinate the
   * old rule would have called the plot. A real browser produces exactly this
   * disagreement whenever the scale object's reported width and the cell the
   * axis is painted in are not the same number.
   *
   * RED before the fix: the arithmetic wins and the plot's chart menu opens.
   */
  const chart = await mountChart();

  await rightClickRegion(chart.pane(0), "axis", { x: 300, y: 200 });
  assert.equal(menuLabel(), "Price scale");
});

test("a right-click in the time-axis row opens the Time scale menu, hidden scale or not", async () => {
  /*
   * RED before the fix: with this pane's own time scale reporting height 0 —
   * which is its state whenever a study pane below owns the visible axis — the
   * arithmetic classified every point in the pane as plot, so the row that IS
   * the time axis opened the chart menu.
   */
  const chart = await mountChart();

  await rightClickRegion(chart.pane(0), "time", { x: 300, y: 200 });
  assert.equal(menuLabel(), "Time scale");
});
