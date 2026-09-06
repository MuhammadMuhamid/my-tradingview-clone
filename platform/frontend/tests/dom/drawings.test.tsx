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
import { advance, closeBrowser, compactSeries, resetBrowser, server } from "./harness/env";
import { drag, mountChart, press, selectTool } from "./harness/chart";
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
  await selectTool(chart.container, "Trend line");

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
  const chart = await mountChart();
  const removeAll = (): HTMLButtonElement => {
    const button = chart.container.querySelector<HTMLButtonElement>(
      'button[title^="Remove all"], button[title="No drawings"]');
    assert.ok(button, "the drawing toolbar has no remove-all control");
    return button;
  };
  assert.equal(removeAll().disabled, true, "an empty chart cannot remove all drawings");

  await selectTool(chart.container, "Trend line");
  await drag(chart.plot, [300, 260], [520, 380]);
  await selectTool(chart.container, "Trend line");
  await drag(chart.plot, [340, 300], [560, 420]);

  assert.equal(removeAll().disabled, false);
  assert.match(removeAll().title, /Remove all 2 drawings/,
    "the toolbar must count what the store holds, not what it last rendered");
});

test("a drawing can be selected, moved as one gesture, and deleted", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Trend line");
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
  await selectTool(chart.container, "Trend line");
  await drag(chart.plot, [300, 260], [520, 380]);

  // The watchlist's "add a pair" box is a real input on this page.
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

  await selectTool(chart.container, "Trend line");
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
  await selectTool(chart.container, "Trend line");
  await drag(chart.plot, [300, 260], [520, 380]);
  await advance(1_400);
  assert.equal(server.getDrawings(SYMBOL).version, 1);

  /*
   * Another device writes while this one is holding version 1: it deletes
   * everything. This device then edits again and saves against the version it
   * still believes in.
   */
  server.seedDrawings(SYMBOL, [], 7);

  await selectTool(chart.container, "Trend line");
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
  await selectTool(first.container, "Trend line");
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
