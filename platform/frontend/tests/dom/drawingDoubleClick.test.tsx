/**
 * TVP8 F-06: double-clicking a drawing opens ITS settings dialog.
 *
 * ── What was already true, and what was not ────────────────────────────────
 *
 * The native `dblclick` path works and was verified live at 1440 on this
 * build, for a freshly drawn trend line and for one restored after a reload:
 * two clicks on the stroke hit-test to the drawing and open the same dialog
 * the floating toolbar's gear opens.
 *
 * What it does NOT cover is the two cases where the browser sends no
 * `dblclick` at all — a touch screen, which has no such event, and a second
 * press that drifts a few pixels or lands on a selected drawing's handle and
 * starts a drag. `DrawingCanvas` grew a whole touch path so a phone can draw,
 * so a phone could draw a drawing it had no way to open. The repair
 * recognises the same intent from the PRESSES: two within 400ms and 4px.
 *
 * Both paths are driven here through the real canvas, the real hit test and
 * the real settings route.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { drag, mountChart, selectTool } from "./harness/chart";
import { drawingStore } from "@/lib/drawingStore";

const SYMBOL = "SOLUSDT";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** A trend line from (300,260) to (520,380); its midpoint is (410,320). */
async function drawTrendLine(): Promise<{ container: HTMLElement; plot: HTMLElement }> {
  const chart = await mountChart();
  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [300, 260], [520, 380]);
  assert.ok(drawingStore.get(SYMBOL)[0], "the gesture created no drawing");
  return chart;
}

const at = (x: number, y: number) => ({ clientX: x, clientY: y });

/** The open settings dialog, or null. */
const dialog = (): HTMLElement | null => screen.queryByRole("dialog");

test("F-06 — a native double-click on the stroke opens the drawing's settings", async () => {
  const chart = await drawTrendLine();
  assert.equal(dialog(), null, "a dialog was open before the gesture");

  fireEvent.dblClick(chart.plot, at(410, 320));
  await settle(2);

  const open = dialog();
  assert.ok(open, "double-clicking the line opened nothing");
  assert.match(open.textContent ?? "", /Trendline/,
    "the dialog that opened is not this drawing's");
});

test("F-06 — two presses within 400ms and 4px open it too, which is what a TAP is", async () => {
  const chart = await drawTrendLine();

  // No `dblclick` at all — the shape a touch screen produces, and the shape a
  // second press that starts a drag leaves behind.
  fireEvent.mouseDown(chart.plot, { button: 0, ...at(410, 320) });
  fireEvent.mouseUp(chart.plot, { button: 0, ...at(410, 320) });
  fireEvent.mouseDown(chart.plot, { button: 0, ...at(412, 321) });
  await settle(2);

  const open = dialog();
  assert.ok(open, "two presses on the stroke opened nothing — a phone cannot open a drawing");
  assert.match(open.textContent ?? "", /Trendline/);
});

test("F-06 — two presses FAR apart are two clicks, not a double", async () => {
  const chart = await drawTrendLine();
  fireEvent.mouseDown(chart.plot, { button: 0, ...at(410, 320) });
  fireEvent.mouseUp(chart.plot, { button: 0, ...at(410, 320) });
  // Still on the line, 40px along it: a second deliberate click, not a double.
  fireEvent.mouseDown(chart.plot, { button: 0, ...at(450, 342) });
  fireEvent.mouseUp(chart.plot, { button: 0, ...at(450, 342) });
  await settle(2);
  assert.equal(dialog(), null,
    "a drag that begins with a click would open the dialog under the pointer");
});

test("F-06 — double-clicking EMPTY chart space opens no drawing settings", async () => {
  const chart = await drawTrendLine();
  // Well off the stroke.
  fireEvent.dblClick(chart.plot, at(700, 140));
  await settle(2);
  assert.equal(dialog(), null,
    "the chart's own double-click must not be answered with a drawing dialog");
});

test("F-06 — a single click still only selects, and the drawing survives both gestures",
  async () => {
    const chart = await drawTrendLine();
    const before = drawingStore.get(SYMBOL)[0]!;

    fireEvent.mouseDown(chart.plot, { button: 0, ...at(410, 320) });
    fireEvent.mouseUp(chart.plot, { button: 0, ...at(410, 320) });
    await settle(2);
    assert.equal(dialog(), null, "one click is a selection, not a dialog");
    assert.ok(screen.queryByRole("button", { name: "Settings for this drawing" }),
      "and it still raises the floating toolbar");

    fireEvent.dblClick(chart.plot, at(410, 320));
    await settle(2);
    assert.ok(dialog());
    assert.deepEqual(drawingStore.get(SYMBOL)[0]?.points, before.points,
      "opening the settings moved the drawing");
  });

test("F-06 — it works on a drawing RESTORED from persistence, not only a fresh one", async () => {
  /*
   * The queue asks for both: "works for a freshly drawn drawing and for a
   * persisted one after reload". So the line is drawn once to get a real
   * record, and then the session is thrown away and the record is served as
   * another device's — which is what a reload restores.
   */
  await drawTrendLine();
  const [record] = drawingStore.get(SYMBOL);
  assert.ok(record, "nothing was stored to restore");

  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
  server.seedDrawings(SYMBOL, [record]);

  const restored = await mountChart();
  await settle(4);
  assert.equal(drawingStore.get(SYMBOL).length, 1,
    "the stored drawing never reached the chart");

  fireEvent.dblClick(restored.plot, at(410, 320));
  await settle(2);
  assert.ok(dialog(), "a persisted drawing could not be opened");
});
