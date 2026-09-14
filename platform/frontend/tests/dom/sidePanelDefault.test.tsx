/**
 * What the workstation looks like before the user has said anything.
 *
 * ── FG-01 ─────────────────────────────────────────────────────────────────
 *
 * Measured live at 1440×900 against a signed-in TradingView: its right side is
 * 346 pixels — a 302px watchlist panel plus a 45px icon rail — and its chart is
 * 1034. Trading Scene gave the right side 52px of bare icon rail and the chart
 * 1336: a slab 29% wider than the reference with nothing beside it, which is
 * the loudest single thing about a first glance at this product.
 *
 * The panel was not missing. `ChartSidePanel` has had a 300px watchlist the
 * whole time; it opened closed, and the comment saying so asserted both that
 * TradingView "opens on a narrow icon rail" — it does not — and that the
 * closed default "preserves the user's last explicit choice", which
 * `useState(null)` cannot do, because it remembers nothing.
 *
 * So there are two rules here and they pull against each other, which is why
 * both are tested: the product must open the way the reference does, AND it
 * must never overrule a preference the user has expressed — including the
 * preference to have nothing there.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { closeBrowser, resetBrowser, settle } from "./harness/env";
import { mountChart } from "./harness/chart";

beforeEach(() => { resetBrowser(); });
after(closeBrowser);

/**
 * Which panel is open, read off the rail's own accessible state.
 *
 * `aria-pressed` on the rail buttons is what a screen reader is told and what
 * the product already maintains — so this asks the same question the user's
 * assistive technology asks, rather than a question invented for the test.
 */
function openPanel(container: HTMLElement): string | null {
  const pressed = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")]
    .filter((b) => b.getAttribute("aria-pressed") === "true"
      && RAIL.has(b.getAttribute("aria-label") ?? ""));
  return pressed[0]?.getAttribute("aria-label") ?? null;
}

/** The rail's own controls, by the names it gives them. */
const RAIL = new Set([
  "Watchlist", "Automations", "Indicators", "Moving averages", "Correlation",
  "Paper / demo / testnet order ticket",
]);

function rail(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.getAttribute("aria-label") === label
      && b.hasAttribute("aria-pressed"));
  if (!found) throw new Error(`the rail has no ${label} control`);
  return found;
}

/**
 * A reload, as a browser does one: the document goes, the storage stays.
 * `resetBrowser` clears local storage, which is the opposite of what a test
 * about a remembered preference needs.
 */
function reload(): void { cleanup(); }

test("FG-01 — a first visit opens with the watchlist docked, as the reference does", async () => {
  const chart = await mountChart();
  await settle();

  assert.equal(openPanel(chart.container), "Watchlist",
    "the workstation opens with 52px of bare rail where the reference has a 302px column");
});

test("FG-01 — closing it is remembered, and the default does not overrule it", async () => {
  const first = await mountChart();
  await settle();

  const close = [...first.container.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.getAttribute("aria-label") === "Close panel");
  assert.ok(close, "no control closes the panel");
  fireEvent.click(close);
  await settle();
  assert.equal(openPanel(first.container), null, "the panel did not close");

  reload();
  const second = await mountChart();
  await settle();
  assert.equal(openPanel(second.container), null,
    "a user who closed the panel got it reopened — a default overruled a preference");
});

test("FG-01 — and a panel the user chose comes back, not the default one", async () => {
  const first = await mountChart();
  await settle();

  fireEvent.click(rail(first.container, "Moving averages"));
  await settle();
  assert.equal(openPanel(first.container), "Moving averages", "the rail did not switch panels");

  reload();
  const second = await mountChart();
  await settle();
  assert.equal(openPanel(second.container), "Moving averages",
    "the workstation forgot which panel the user was working in");
});

/**
 * ── TVP8 R1c-06 / R7b-05: the two seams on the right of the workspace ──────
 *
 * Counted from the right edge of `tradingview/tv-shell-1920x1080-dark.png`:
 * the rail is 45px (1875–1919), a 1px rgb(46) line separates it from the
 * watchlist (1874), the watchlist is 300 (1574–1873) and the chart→watchlist
 * gutter is 4px (1570–1573). At 1440 the same runs are 1395–1439 / 1394 /
 * 1094–1393 / 1090–1093.
 *
 * Ours measured 46 / 4px gap / 296 / 9px: the rail was a pixel wide, the
 * panel→rail seam was a band of page ground rather than a hairline, and the
 * chart→panel gutter was painted TWICE — once by the workspace row's own
 * `gap`, once by a `w-[4px] bg-border` strip the panel drew as its own first
 * column, which is also where the panel's missing four pixels of content went.
 *
 * A class assertion because jsdom does no layout: what is real here is which
 * elements exist and what they declare. The pixels are verified in the capture
 * set at the browser.
 */
test("R1c-06 — the rail is 45px of paint behind a 1px seam, and the gutter is drawn once", async () => {
  const chart = await mountChart();
  await settle();

  const railColumn = chart.container.querySelector<HTMLElement>('[data-side-rail="true"]');
  assert.ok(railColumn, "the workspace has no right rail");
  assert.equal(railColumn.className.includes("w-[46px]"), true,
    "46px of layout — 45 of paint plus the 1px hairline");
  assert.equal(railColumn.className.includes("border-l"), true,
    "the panel→rail seam is a hairline on the reference, not a 4px gutter");
  assert.equal(railColumn.className.includes("pt-[1px]"), true,
    "R7b-12: 6px of padding put the first chip at y=52 where the reference has it at 47");

  const cell = railColumn.querySelector<HTMLElement>('button[aria-label="Watchlist"]');
  assert.ok(cell, "the rail has no watchlist cell");
  assert.equal(cell.className.includes("w-[45px]"), true,
    "the rail's painted cells are 45 wide (1395–1439 at 1440)");

  const panel = chart.container.querySelector<HTMLElement>("[data-watchlist]");
  assert.ok(panel, "the watchlist is not open");
  const strip = [...panel.children].some((el) =>
    el.className.toString().includes("w-[4px]") && el.className.toString().includes("bg-border"));
  assert.equal(strip, false,
    "the gutter is the workspace row's gap; a second one inside the panel costs the panel 4px");
});
