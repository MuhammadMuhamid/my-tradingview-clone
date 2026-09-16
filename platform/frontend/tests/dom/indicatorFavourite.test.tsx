/**
 * TVP8 F-04: the indicator browser's favourite star.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * Every row carried `-ml-[30px]` to bleed its hover fill and its star 30px
 * left of the list column, into the gap beside the library rail, which is
 * where the reference draws them. But the rows sit inside the list's SCROLL
 * container, and that container clips: measured live at 1440, the star
 * rendered at x 542–566 while the scroller's box began at 570, so
 * `elementFromPoint` at the star's own centre returned the dialog body. The
 * control existed, was named, had a handler — and could be neither seen nor
 * clicked.
 *
 * jsdom runs no layout engine, so a box test here would assert on zeros. What
 * it CAN prove is the structural fact underneath the clipping: the star's
 * scrolling ancestor is the element whose offset moved, and a click on the
 * star changes the real favourite state without applying the indicator.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
});
after(closeBrowser);

/**
 * Open the browser from ONE chart's toolbar.
 *
 * Scoped to the container rather than to `screen`, because a test that mounts
 * a second chart to stand in for a reload leaves the first one mounted — and
 * both toolbars carry a control named `Indicators`.
 */
async function openBrowser(container: HTMLElement): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-toolbar-control="indicators"]');
  assert.ok(button, "the toolbar has no Indicators control");
  fireEvent.click(button);
  await settle(4);
}

/** The dialog that is open now — the last one, when an earlier chart left one. */
const browser = (): HTMLElement => {
  const dialogs = screen.getAllByRole("dialog");
  return dialogs[dialogs.length - 1]!;
};

/** The element that would clip the star: its nearest scrolling ancestor. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;
  while (node) {
    if (node.className.includes("overflow-y-auto")) return node;
    node = node.parentElement;
  }
  return null;
}

test("F-04 — the star and the row it is on share the scroller's own left edge", async () => {
  const chart = await mountChart();
  await settle();
  await openBrowser(chart.container);

  const star = within(browser()).getByRole("button", { name: "Favourite Average True Range" });
  const scroller = scrollerOf(star);
  assert.ok(scroller, "the star has no scrolling ancestor, so nothing could clip it");

  /*
   * The 30px bleed belongs to the CLIPPING element, not to the rows inside it.
   * With it on the rows, the star was laid out 30px outside the box that
   * decides what is visible — which is the entire finding.
   */
  assert.ok(scroller.className.includes("-ml-[30px]"),
    "the list column's bleed must be on the scroller, or the star is outside it");
  const row = star.closest<HTMLElement>('[class*="group/row"]');
  assert.ok(row, "the star is not inside a row");
  assert.equal(row.className.includes("-ml-[30px]"), false,
    "a row that bleeds out of its own scroller is a row whose star is clipped");
});

test("F-04 — clicking the star favourites the script, and does not apply it", async () => {
  const chart = await mountChart();
  await settle();
  await openBrowser(chart.container);

  const star = within(browser()).getByRole("button", { name: "Favourite Average True Range" });
  assert.equal(star.getAttribute("aria-pressed"), "false");
  fireEvent.click(star);
  await settle(2);

  assert.equal(
    within(browser()).getByRole("button", { name: "Unfavourite Average True Range" })
      .getAttribute("aria-pressed"), "true",
    "the star did not take the favourite state");
  assert.ok(screen.queryByRole("dialog"), "favouriting must not close the browser");
  assert.doesNotMatch(chart.container.querySelector("[data-pane-legend]")?.textContent ?? "",
    /Average True Range/,
    "favouriting a script applied it to the chart, which is a different verb");
});

test("F-04 — a favourite is listed under Favorites, and survives a reload", async () => {
  const first = await mountChart();
  await settle();
  await openBrowser(first.container);
  fireEvent.click(within(browser())
    .getByRole("button", { name: "Favourite Average True Range" }));
  await settle(2);

  fireEvent.click(within(browser()).getByRole("button", { name: "Favorites" }));
  await settle(2);
  assert.ok(within(browser()).getByRole("button", { name: "Unfavourite Average True Range" }),
    "the Favorites view does not list the script that was just starred");

  // A remount, which is what a reload is to this dialog.
  const again = await mountChart();
  await settle();
  await openBrowser(again.container);
  fireEvent.click(within(browser()).getByRole("button", { name: "Favorites" }));
  await settle(2);
  assert.ok(within(browser()).getByRole("button", { name: "Unfavourite Average True Range" }),
    "the favourite did not persist");
});
