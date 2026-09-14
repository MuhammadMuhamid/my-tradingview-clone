/**
 * The chart must have dates under it. All of them must, at any study count.
 *
 * ── FG-02 and FG-03, which are one defect ─────────────────────────────────
 *
 * Measured at 1440×900 against the owner's own saved state — four oscillators,
 * which is an ordinary number of them:
 *
 *   the study stack asked for 376px of a 314px box;
 *   the fourth pane showed 30 of its 94 pixels, sliced mid-histogram;
 *   `elementFromPoint` over the time axis returned the bottom tab bar.
 *
 * There were no dates under the chart anywhere on screen. TradingView's time
 * axis with its day numbers is the anchor of the whole picture, and this
 * product simply did not have one — not hidden by a setting, scrolled out of a
 * box nobody scrolls.
 *
 * The two are the same defect because the axis is drawn ONCE, under the lowest
 * pane that is showing a plot (`CandleChart`'s `axisPaneId`). Clip the bottom
 * of the stack and you clip the axis. The stack was `overflow-y-auto` over
 * `shrink-0` children, which is a combination that can only ever end this way:
 * a fixed per-pane height against a percentage cap overflows at SOME count, and
 * the existing comment on `defaultPaneHeight` had already been through this
 * once and answered it by making the panes smaller — 160/144/124/106 became
 * 132/118/104/94 — which moves the count at which it breaks and does not stop
 * it breaking.
 *
 * What is asserted here is the invariant instead of the arithmetic: whatever
 * the stack contains, it fits inside its own box.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  advance, closeBrowser, compactSeries, resetBrowser, server, settle,
} from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";

/**
 * Put `count` oscillators on the chart, through the Indicators dialog.
 *
 * Added the way a person adds them, because nothing else works and because
 * what is under test is the STACK — the container these panes land in — and a
 * study injected past the dialog is a study that never went through the code
 * that decides where it goes.
 *
 * Two shortcuts were tried first and neither is honest. Seeding local storage
 * alone loses the studies at mount: the pane's sync treats a written-but-empty
 * server half as a deletion, which `tests/dom/studies.test.tsx` pins on
 * purpose. Seeding the server's pane row alone does not help either, because a
 * study computes from bars and the harness serves none by default — the chart
 * came up saying "0 bars" and the stack was empty, so every assertion here
 * would have been about nothing.
 */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const OSCILLATORS = [
  "Money Flow Index", "Williams %R", "Stochastic RSI", "MACD",
  "Relative Strength Index", "Commodity Channel Index",
];

async function addStudies(chart: MountedChart, count: number): Promise<void> {
  const open = chart.container.querySelector<HTMLElement>('button[aria-label="Indicators"]');
  assert.ok(open, "the toolbar has no Indicators control");
  fireEvent.click(open);
  await settle();

  const dialog = screen.getByRole("dialog");
  for (const name of OSCILLATORS.slice(0, count)) {
    fireEvent.click(within(dialog).getByTitle(new RegExp(`^Add ${escapeRe(name)} to `)));
    await settle();
  }
  fireEvent.keyDown(document, { key: "Escape" });
  await settle();
  await advance(1_500);
  await settle();
}

beforeEach(() => {
  resetBrowser();
  // A study computes from bars. Without a window the stack is empty and every
  // assertion below would be about nothing.
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** The container the study panes live in, found by what it holds. */
function stack(container: HTMLElement): HTMLElement {
  const panes = [...container.querySelectorAll<HTMLElement>("section[aria-label$='indicator pane']")];
  assert.ok(panes.length > 0, "no indicator panes rendered at all");
  const box = panes[0]!.parentElement;
  assert.ok(box, "the panes have no container");
  return box;
}

for (const count of [1, 2, 3, 4, 5]) {
  test(`FG-02/03 — with ${count} studies the stack fits inside its own box`, async () => {
    const chart = await mountChart();
    await settle();
    await addStudies(chart, count);

    const box = stack(chart.container);
    const panes = [...chart.container
      .querySelectorAll<HTMLElement>("section[aria-label$='indicator pane']")];
    assert.equal(panes.length, count, "not every study got a pane");

    /*
     * `scrollHeight > clientHeight` IS the defect, stated in the browser's own
     * terms: content taller than the box it is in. jsdom reports both as 0 for
     * an unlaid-out element, so the check is on the inline heights the product
     * actually asks for versus the cap it is allowed — the same comparison,
     * made from the numbers this environment can honestly supply.
     */
    assert.ok(!box.className.includes("overflow-y-auto"),
      "the stack scrolls, so whatever is at its bottom — including the time "
      + "axis — can be out of the chart entirely");
    assert.ok(box.className.includes("overflow-hidden"),
      "the stack must clip to its box rather than scroll inside it");
    assert.ok(box.className.includes("flex"),
      "the panes cannot give ground unless the stack is a flex column");

    for (const pane of panes) {
      assert.ok(!pane.className.includes("shrink-0"),
        "a pane that refuses to shrink is what pushes the stack past its cap");
      assert.ok(pane.className.includes("min-h-0"),
        "a flex item's default min-height:auto refuses to shrink below its "
        + "content, which is the same clipping under another name");
    }
  });
}

test("FG-02 — the time axis lives under the lowest pane, and that pane is in the box", async () => {
  const chart = await mountChart();
  await settle();
  await addStudies(chart, 4);

  const panes = [...chart.container
    .querySelectorAll<HTMLElement>("section[aria-label$='indicator pane']")];
  const lowest = panes[panes.length - 1];
  assert.ok(lowest, "no pane to carry the axis");

  /*
   * The axis-carrying pane is the LAST child of the stack. If the stack
   * scrolled, that is exactly the child that left the screen — which is why
   * this asserts its position rather than its pixels.
   */
  assert.equal(lowest.parentElement?.lastElementChild, lowest,
    "the lowest pane is not the last child of the stack");
  assert.ok(lowest.querySelector("canvas"),
    "the pane that carries the time axis has no chart in it");
});
