/**
 * The drawing-settings dialog, driven the way a person drives it.
 *
 * ── What R6b measured (R6b-28), and what each test holds ───────────────────
 *
 * Against `measurements/tv-drawing-settings-20260914.md` the dialog was a
 * different product: 750 wide with a 131px LEFT NAV of chip tabs against a
 * 380px content-sized box with four TEXT tabs; nine round 28px colour dots, a
 * native `Line width` `<select>` and a 13px native `Dashed` checkbox against
 * one 75×34 line-style button; no `Extend`, no `Middle point`, no `Price
 * labels`, no `Stats`; a Text tab DISABLED for the trendline the reference
 * gives a Text tab to; Coordinates as epoch SECONDS (`1788188400`) and a
 * fourteen-decimal price (`75163.90339372704`) in 245×30 boxes against
 * `#1 (price, bar)` in two 70×28 fields; Visibility as thirteen native
 * checkboxes under a sentence; and a `Cancel` / `Apply`(accent) footer behind
 * which NOTHING reached the chart until Apply.
 *
 * Every assertion below is made by clicking the real control in the real
 * dialog, opened from the real chart through the real drawing store.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { drag, mountChart, rightClickAt, chooseMenuItem, selectTool } from "./harness/chart";
import { drawingStore } from "@/lib/drawingStore";

const SYMBOL = "SOLUSDT";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** Draw a trendline and open its settings dialog through the product's route. */
async function openTrendSettings(): Promise<HTMLElement> {
  const chart = await mountChart();
  await selectTool(chart.container, "Trendline");
  await drag(chart.plot, [300, 260], [520, 380]);
  const [line] = drawingStore.get(SYMBOL);
  assert.ok(line, "the gesture created no drawing");

  // The gear's own route: the drawing menu's first row.
  await rightClickAt(chart.plot, 410, 320);
  await chooseMenuItem("Settings…");
  await settle();
  return screen.getByRole("dialog");
}

test("R6b-28 — the trendline dialog is the settings grammar, on four text tabs", async () => {
  const dialog = await openTrendSettings();

  assert.deepEqual(
    [...dialog.querySelectorAll('[role="tab"]')].map((t) => (t.textContent ?? "").trim()),
    ["Style", "Text", "Coordinates", "Visibility"],
    "four TEXT tabs, capitalised in the DOM — not a left nav of lower-case chips");

  /*
   * The width. `380` is the reference's own content size; the assertion is on
   * the class rather than a measured rect because jsdom lays nothing out, and
   * the class is what a browser reads.
   */
  const panel = dialog.className;
  assert.match(panel, /max-w-\[380px\]/, "the reference's dialog is 380 wide, not 750");
  assert.doesNotMatch(panel, /max-w-\[750px\]/);

  // The name field, where the reference puts one.
  const name = screen.getByRole("textbox", { name: "Drawing name" }) as HTMLInputElement;
  assert.equal(name.value, "Trendline");

  // R6b-28: one control for colour, width and pattern.
  const line = screen.getByRole("button", { name: "Line appearance" });
  assert.equal(line.getAttribute("aria-haspopup"), "dialog");
  assert.ok(line.querySelector("svg"), "the button previews the line it will draw");

  // The rows the dialog did not have at all.
  fireEvent.click(screen.getByRole("button", { name: "Extend" }));
  await settle();
  assert.deepEqual(
    within(screen.getByRole("listbox", { name: "Extend" }))
      .getAllByRole("option").map((o) => (o.textContent ?? "").trim()),
    ["Don't extend", "Left", "Right", "Both"]);
  fireEvent.keyDown(window, { key: "Escape" });
  await settle();

  assert.ok(screen.getByRole("checkbox", { name: "Middle point" }));
  assert.ok(screen.getByRole("checkbox", { name: "Price labels" }));
  assert.ok(screen.getByRole("button", { name: "Stats" }));
  assert.ok(screen.getByRole("checkbox", { name: "Always show stats" }));

  /*
   * No native `<select>` anywhere in it. The OS popup and the OS chevron are
   * the loudest "this is not that product" tell a dialog can carry, and this
   * one had two on Style alone.
   */
  assert.equal(dialog.querySelectorAll("select").length, 0);
});

test("R6b-28 — the Text tab is live for a trendline, as the reference's is", async () => {
  await openTrendSettings();
  const tab = screen.getByRole("tab", { name: "Text" }) as HTMLButtonElement;
  assert.equal(tab.disabled, false,
    "the previous dialog greyed this tab out for exactly the tool the reference gives one to");
  fireEvent.click(tab);
  await settle();

  assert.ok(screen.getByRole("button", { name: "Text colour" }));
  assert.ok(screen.getByRole("button", { name: "Text size" }));
  assert.ok(screen.getByRole("button", { name: "Bold" }));
  assert.ok(screen.getByRole("button", { name: "Italic" }));
  const area = screen.getByRole("textbox", { name: "Add text" }) as HTMLTextAreaElement;
  fireEvent.change(area, { target: { value: "resistance" } });
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.text, "resistance",
    "every control applies LIVE; there is no Apply button to wait for");
});

test("R6b-28 — Coordinates are a price and a BAR INDEX, never an epoch", async () => {
  await openTrendSettings();
  fireEvent.click(screen.getByRole("tab", { name: "Coordinates" }));
  await settle();

  const price = screen.getByRole("spinbutton", { name: "#1 price" }) as HTMLInputElement;
  const bar = screen.getByRole("spinbutton", { name: "#1 bar" }) as HTMLInputElement;

  /*
   * The whole finding in two assertions: the stored anchor is
   * `1788188400` / `75163.90339372704`, and neither of those is a thing a
   * trader can read or type.
   */
  assert.ok(Math.abs(Number(price.value)) < 1_000_000,
    `a price of ${price.value} is an epoch, not a price`);
  assert.ok((price.value.split(".")[1] ?? "").length <= 6,
    `fourteen decimals is the engine's storage printed at a user: ${price.value}`);
  assert.ok(Number.isInteger(Number(bar.value)) && Math.abs(Number(bar.value)) < 100_000,
    `the second field is a bar index, not an epoch: ${bar.value}`);

  const before = drawingStore.get(SYMBOL)[0]!.points[0]!.time;
  fireEvent.change(bar, { target: { value: String(Number(bar.value) - 5) } });
  await settle();
  const after = drawingStore.get(SYMBOL)[0]!.points[0]!.time;
  assert.ok(after < before, "moving the anchor five bars left moves it back in time");
});

test("R6b-28 — Cancel restores the drawing the dialog opened on", async () => {
  await openTrendSettings();
  const original = drawingStore.get(SYMBOL)[0]!.style.color;

  fireEvent.click(screen.getByRole("button", { name: "Line appearance" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "#ffeb3b" }));
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.color, "#ffeb3b",
    "live apply: the chart shows the colour before it is committed");

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await settle();
  assert.equal(drawingStore.get(SYMBOL)[0]!.style.color, original,
    "Cancel undoes the whole visit — that is what makes live apply safe");
});

test("R6b-28 — Visibility is per-unit rows with a from/to range", async () => {
  await openTrendSettings();
  fireEvent.click(screen.getByRole("tab", { name: "Visibility" }));
  await settle();

  for (const unit of ["Seconds", "Minutes", "Hours", "Days"]) {
    assert.ok(screen.getByRole("checkbox", { name: unit }), `${unit} has no row`);
    assert.ok(screen.getByRole("spinbutton", { name: `${unit} from` }));
    assert.ok(screen.getByRole("spinbutton", { name: `${unit} to` }));
  }
  /*
   * `Ticks`, `Ranges`, `Weeks` and `Months` are ABSENT rather than drawn dead:
   * `lib/resolution` publishes `1s … 1d` and refuses the calendar objects, so
   * none of those rows could ever be true.
   */
  assert.equal(screen.queryByRole("checkbox", { name: "Ticks" }), null);
  assert.equal(screen.queryByRole("checkbox", { name: "Weeks" }), null);

  // Turning one unit off writes the allow-list the canvas already honours.
  fireEvent.click(screen.getByRole("checkbox", { name: "Seconds" }));
  await settle();
  const visibleOn = drawingStore.get(SYMBOL)[0]!.visibleOn;
  assert.ok(visibleOn && visibleOn.length > 0, "a narrowed visibility must be stored");
  assert.ok(!visibleOn!.includes("1s"), "the unit that was switched off is not in the list");
  assert.ok(visibleOn!.includes("1h"), "the units left on are");
});
