/**
 * The 4px gutter is a drag handle.
 *
 * ── TVP8 R7b-21 ────────────────────────────────────────────────────────────
 *
 * The reference serves the SAME account a 300px panel at 1440 and a 346px one
 * at 1920, which is how the reviewer established that the width is a stored
 * preference rather than a constant: nothing else explains one account getting
 * two widths. Ours was a fixed 300 at both, and the gutter had `cursor: auto`.
 *
 * Device-local, like the compact toggle and the collapsed sections: how wide a
 * column is on THIS screen is not a fact about the list, and a width chosen on
 * a 27-inch monitor should not follow the list onto a phone.
 *
 * Run against the repair reverted, the first assertion fails — the panel is
 * still 300 after the drag — and so does the reload.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!]);
});
after(closeBrowser);

const WIDTH_KEY = "tv.watchlist.width.v1";

/**
 * The width the panel is actually laid out at.
 *
 * Read from the custom property the `aside` sets rather than from
 * `getBoundingClientRect`: jsdom does no layout at all, so a rect here would
 * be zero whatever the product did, and an assertion on it would pass for the
 * wrong reason. The property IS the width — the class is
 * `md:w-[var(--ts-watchlist-width)]` — so this reads the product's own answer.
 */
function width(container: HTMLElement): number {
  const panel = container.querySelector<HTMLElement>("[data-watchlist]");
  if (!panel) throw new Error("the watchlist panel is not open");
  return Number((panel.style.getPropertyValue("--ts-watchlist-width") || "0").replace("px", ""));
}

function handle(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>("[data-watchlist-resize]");
  if (!found) throw new Error("the gutter is not a handle — it has no resize element on it");
  return found;
}

/** Drag the gutter left by `by` pixels. The panel is on the right, so left is wider. */
async function dragBy(el: HTMLElement, by: number): Promise<void> {
  fireEvent.pointerDown(el, { clientX: 1090, bubbles: true });
  fireEvent.pointerMove(window, { clientX: 1090 - by, bubbles: true });
  fireEvent.pointerUp(window, { clientX: 1090 - by, bubbles: true });
  await settle();
}

test("R7b-21 — dragging the gutter resizes the panel, and the width is remembered", async () => {
  const chart = await mountChart();
  await settle();
  assert.equal(width(chart.container), 300, "the reference's own width at 1440");

  await dragBy(handle(chart.container), 40);
  assert.equal(width(chart.container), 340, "a 40px drag left must widen the panel by 40");
  assert.equal(window.localStorage.getItem(WIDTH_KEY), "340",
    "the width the user chose was not stored");

  cleanup();
  const second = await mountChart();
  await settle();
  assert.equal(width(second.container), 340,
    "a width that has to be re-dragged on every visit is not a preference");
});

test("R7b-21 — the panel cannot be dragged narrower than 260 or wider than 420", async () => {
  /*
   * Below 260 the five columns stop fitting and the ticker cell goes back to
   * the three glyphs R7b-03 was about; above 420 the panel is taking chart.
   * A handle with no bounds is a way to break the layout by accident and no
   * way to get back.
   */
  const chart = await mountChart();
  await settle();

  await dragBy(handle(chart.container), -400);
  assert.equal(width(chart.container), 260);

  await dragBy(handle(chart.container), 400);
  assert.equal(width(chart.container), 420);
});
