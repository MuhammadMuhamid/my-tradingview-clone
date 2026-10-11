/**
 * The drawing rail, as a rendered thing rather than as source text.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * `tests/drawingRail.test.ts` pins the rail's taxonomy, its glyph geometry and
 * its class strings, and all of that is worth pinning. None of it could catch
 * the defect that opened round three: the tooltip pill was in the DOM, was
 * styled correctly, had a `z-index` above the chart — and was painted for none
 * of the fifteen cells, because it lived inside a button that `globals.css`
 * makes its own stacking context. A regular expression over the source said
 * "every cell names itself in the product's chrome" about a pill nobody could
 * see. The only assertion that could have failed is one about the rendered
 * TREE: where the pill is, relative to the element whose stacking context it
 * could not leave.
 *
 * So these tests render the real workspace and ask the DOM the questions a
 * capture would ask the pixels: is the pill outside `.tvc-control`, does
 * Escape close the flyout and give the strip its focus back, do the arrows
 * travel, does starring a tool put it anywhere a user can reach.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { advance, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { GROUPS, LONG_PRESS_MS } from "@/components/tv/DrawingToolbar";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(400));
});
after(closeBrowser);

const railOf = (container: HTMLElement): HTMLElement => {
  const rail = container.querySelector<HTMLElement>('[data-drawing-rail="true"]');
  assert.ok(rail, "the workspace rendered no drawing rail");
  return rail;
};

/** The rail's own fifteen cells — not the floating favourites bar's. */
const cellsOf = (rail: HTMLElement): HTMLElement[] =>
  [...rail.querySelectorAll<HTMLElement>("button.tvc-control")]
    .filter((b) => !b.closest("[data-drawing-favourites]"));

const openFlyout = async (rail: HTMLElement, id: string): Promise<HTMLElement> => {
  const strip = rail.querySelector<HTMLElement>(`button[aria-label="More ${id} tools"]`);
  assert.ok(strip, `no flyout strip for ${id}`);
  fireEvent.click(strip);
  await settle();
  return strip;
};

const menuOf = (rail: HTMLElement): HTMLElement | null =>
  rail.querySelector<HTMLElement>(".tvc-menu");

test("R2c-01 — a cell's tooltip pill is a SIBLING of its button, never a child", async () => {
  /*
   * The pill's `z-[60]` is meaningless inside `.tvc-control`, which carries
   * `isolation: isolate` so its `z-index: -1` state chip can sit behind bare
   * text nodes. Anything inside such a button is trapped in that button's
   * stacking context and cannot rise above the chart column, which comes later
   * in the document and carries positioned legends of its own. The strip's
   * pill painted all along precisely because a strip is not a `.tvc-control`.
   *
   * RED before the fix: fifteen pills, all of them children.
   */
  const chart = await mountChart();
  const rail = railOf(chart.container);

  assert.equal(
    rail.querySelectorAll(".tvc-control [data-rail-tip]").length, 0,
    "a pill inside `.tvc-control` is a pill inside an `isolation: isolate` box, "
    + "and will never paint over the chart however high its z-index is"
  );

  const cells = cellsOf(rail);
  assert.ok(cells.length >= 15, `only ${cells.length} rail cells rendered`);
  for (const cell of cells) {
    const next = cell.nextElementSibling;
    const name = cell.getAttribute("aria-label") ?? "(unnamed)";
    assert.ok(next?.hasAttribute("data-rail-tip"),
      `${name} has no tooltip pill beside it`);
    assert.ok(((next?.textContent ?? "").trim()).length > 0,
      `${name}'s pill is empty`);
  }

  /*
   * And on the cells whose pill IS the control's name — the eight groups, the
   * two singles, Remove and Keep drawing — the two agree. The magnet's pill
   * says what the magnet is DOING ("Magnet off") where its label says what
   * pressing it would do, which is correct for both and is why this list is
   * explicit rather than "every cell".
   */
  for (const label of [
    "Cross", "Trendline", "Fib retracement", "XABCD pattern", "Long position",
    "Brush", "Text", "Icon", "Measure", "Zoom in", "Keep drawing", "Remove objects",
  ]) {
    const cell = rail.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
    assert.ok(cell, `no rail cell named ${label}`);
    assert.equal((cell.nextElementSibling?.textContent ?? "").trim(), label,
      `${label}'s pill does not say its name`);
  }
});

test("A18 — no tooltip pill is revealed over an open flyout", async () => {
  /*
   * The flyout opens at the pill's own `left-full`, and the pointer that
   * opened it is still over the cell, so the `z-[60]` pill stayed lit over the
   * flyout's header. While a flyout is open no pill has a hover reveal; it
   * stays in the tree (R2c-01's structure) and gets it back on close.
   */
  const chart = await mountChart();
  const rail = railOf(chart.container);
  const pills = (): HTMLElement[] => [...rail.querySelectorAll<HTMLElement>("[data-rail-tip]")];
  const revealable = (pill: HTMLElement): boolean => /(peer-hover\/cell|group-hover\/tip):flex/.test(pill.className);
  assert.ok(pills().length >= 15 && pills().every(revealable), "at rest every pill reveals on hover");

  const strip = await openFlyout(rail, "trend-line");
  assert.ok(menuOf(rail), "the flyout opened");
  assert.equal(pills().filter(revealable).length, 0,
    "with a flyout open, no pill may reveal itself over it");
  assert.ok(pills().length >= 15, "and the pills are still in the tree beside their cells");

  strip.focus();
  fireEvent.keyDown(strip, { key: "Escape", bubbles: true });
  await settle();
  assert.equal(menuOf(rail), null);
  assert.ok(pills().every(revealable), "closing the flyout gives every pill its hover back");
});

test("R2c-05 — Escape closes an open flyout and hands focus back to its strip", async () => {
  /*
   * Escape used to reach `useShortcuts` untouched, where it is bound to
   * `tool:cursor`: the one key everybody presses to dismiss a menu dropped the
   * armed TOOL and left the menu standing. The reference closes the menu first
   * and leaves the tool alone.
   *
   * RED before the fix: `.tvc-menu` is still present after the keystroke.
   */
  const chart = await mountChart();
  const rail = railOf(chart.container);

  const strip = await openFlyout(rail, "trend-line");
  assert.ok(menuOf(rail), "the trend flyout did not open");

  strip.focus();
  fireEvent.keyDown(strip, { key: "Escape", bubbles: true });
  await settle();

  assert.equal(menuOf(rail), null, "Escape left the flyout open");
  assert.equal(document.activeElement === strip, true,
    "focus was dropped on the floor instead of going back to the strip that opened the menu");
});

test("R2c-05 — the arrow keys travel the open flyout and Enter arms the row", async () => {
  const chart = await mountChart();
  const rail = railOf(chart.container);

  const strip = await openFlyout(rail, "trend-line");
  fireEvent.keyDown(strip, { key: "ArrowDown", bubbles: true });
  await settle();
  assert.match((document.activeElement?.textContent ?? "").trim(), /^Trendline/,
    "ArrowDown from the strip did not land on the first row");

  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", bubbles: true });
  await settle();
  assert.match((document.activeElement?.textContent ?? "").trim(), /^Ray/,
    "ArrowDown did not move to the second row");

  fireEvent.keyDown(document.activeElement!, { key: "Enter", bubbles: true });
  await settle();

  assert.ok(rail.querySelector('button[aria-label="Ray"][aria-pressed="true"]'),
    "Enter on the focused row did not arm its tool");
  assert.equal(menuOf(rail), null, "the flyout stayed open after a row was activated");
});

test("R2c-06 — starring a tool puts it on a floating favourites bar", async () => {
  /*
   * The star wrote `tv.drawing-tools.favourites.v1` and filled itself, and
   * nothing else in the product ever read it: the control's whole promise —
   * keep this one within reach — was kept by no part of the page. The
   * reference answers a star with a small floating toolbar over the chart.
   *
   * RED before the fix: no `[data-drawing-favourites]` exists at any point.
   */
  const chart = await mountChart();
  const rail = railOf(chart.container);

  await openFlyout(rail, "trend-line");
  const rayRow = [...rail.querySelectorAll<HTMLElement>(".tvc-menu-row")]
    .find((r) => (r.textContent ?? "").trim().startsWith("Ray"));
  assert.ok(rayRow, "the trend flyout has no Ray row");

  fireEvent.click(rayRow.querySelector<HTMLElement>('button[aria-label="Add to favourites"]')!);
  await settle();

  const bar = document.querySelector<HTMLElement>('[data-drawing-favourites="true"]');
  assert.ok(bar, "starring a tool produced no favourites bar");
  assert.ok(bar.querySelector('button[aria-label="Ray"]'),
    "the favourites bar does not carry the tool that was starred");
  // The reference leaves the menu open, so a second tool can be starred.
  assert.ok(menuOf(rail), "starring a row closed the flyout");

  fireEvent.click(rayRow.querySelector<HTMLElement>('button[aria-label="Remove from favourites"]')!);
  await settle();
  assert.equal(document.querySelector('[data-drawing-favourites="true"]') === null, true,
    "un-starring the last favourite left an empty bar behind");
});

test("R2c-06 — a favourite stored from a previous session is on the bar at mount", async () => {
  window.localStorage.setItem("tv.drawing-tools.favourites.v1", JSON.stringify(["ray"]));
  const chart = await mountChart();
  const rail = railOf(chart.container);

  assert.ok(document.querySelector('[data-drawing-favourites="true"] button[aria-label="Ray"]'),
    "a persisted favourite paints nothing on mount");
  // And the rail grows the cell that shows and hides it, as the reference does.
  assert.ok(rail.querySelector('button[aria-label="Hide the favourite tools bar"]'),
    "the rail has no favourites cell at its foot");
});

test("R2c-13 — only a row with a HINT carries a native tooltip", async () => {
  /*
   * `title={t.hint ?? t.label}` put an OS tooltip on every row of every
   * flyout, repeating in the OS font, a second late, the label the row already
   * prints. The reference shows none over a menu row. Where a tool has a hint
   * the tooltip carries something the row does not, and that one stays.
   *
   * RED before the fix: seventeen titles in the trend flyout, not zero.
   */
  const chart = await mountChart();
  const rail = railOf(chart.container);

  for (const group of GROUPS) {
    if (group.id === "icons") continue; // a picker, not a list of rows
    await openFlyout(rail, group.id);
    const expected = group.sections
      .flatMap((s) => s.tools).filter((t) => t.hint !== undefined).length;
    const found = rail.querySelectorAll(".tvc-menu-row > button[title]").length;
    assert.equal(found, expected,
      `${group.id}: ${found} rows carry a native tooltip, ${expected} have a hint`);
    await openFlyout(rail, group.id); // close it again
  }
});

test("R2c-14 — phone drawing tools use the Draw sheet, not a permanent rail", async () => {
  /*
   * The current responsive contract gives the chart the phone's full width
   * and exposes the same wired DrawingToolbar from the bottom Draw action.
   * The Premium closure audit records that bottom action as the intended phone
   * route. A permanent 52px desktop column here would contradict both.
   */
  const desktopMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 767px)", media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    const chart = await mountChart();
    await settle();
    assert.equal(chart.container.querySelector('[data-drawing-rail="true"]') === null, true,
      "the desktop rail consumes chart width on a phone");

    const draw = chart.container.querySelector<HTMLElement>('button[aria-label="Draw"]');
    assert.ok(draw, "the phone action bar has no Draw route");
    fireEvent.click(draw);
    await settle();

    const rails = chart.container.querySelectorAll('[data-drawing-rail="true"]');
    assert.equal(rails.length, 1, "Draw must open exactly one wired toolbar");
    assert.ok(rails[0]?.closest('[role="dialog"][aria-label="Drawing tools"]'),
      "the toolbar is not inside the phone drawing-tools sheet");

    fireEvent.click(draw);
    await settle();
    assert.equal(chart.container.querySelector('[data-drawing-rail="true"]') === null, true,
      "tapping Draw again must close the sheet");
  } finally {
    window.matchMedia = desktopMatchMedia;
  }
});

/*
 * D-F9 — a finger cannot hover, and iOS Safari never fires `contextmenu` for a
 * long press, so on a touch screen a group's other tools were reachable only
 * through a strip nobody could see. A hold on the group cell opens its flyout.
 */
const trendCell = (rail: HTMLElement): HTMLElement => {
  const cell = rail.querySelector<HTMLElement>('button[aria-label="Trendline"]');
  assert.ok(cell, "no Trendline cell");
  return cell;
};

test("D-F9 — holding a group cell with a finger opens its flyout and arms nothing", async () => {
  const chart = await mountChart();
  const rail = railOf(chart.container);
  const cell = trendCell(rail);
  assert.equal(cell.getAttribute("aria-pressed"), "false");

  fireEvent.pointerDown(cell, { pointerType: "touch", clientX: 26, clientY: 60 });
  await advance(LONG_PRESS_MS + 50);
  assert.equal(menuOf(rail) !== null, true, "a held finger did not open the trend flyout");

  // The lift ends in a click; it must not arm the tool under the open menu.
  fireEvent.pointerUp(cell, { pointerType: "touch", clientX: 26, clientY: 60 });
  fireEvent.click(cell);
  await settle();
  assert.equal(menuOf(rail) !== null, true, "the click that ended the hold closed the menu");
  assert.equal(trendCell(rail).getAttribute("aria-pressed"), "false",
    "the click that ended the hold armed the trendline");
});

test("D-F9 — a short tap still arms the tool, and a drag is a scroll, not a hold", async () => {
  const chart = await mountChart();
  const rail = railOf(chart.container);

  // A tap: down and up well inside the hold time.
  fireEvent.pointerDown(trendCell(rail), { pointerType: "touch", clientX: 26, clientY: 60 });
  fireEvent.pointerUp(trendCell(rail), { pointerType: "touch", clientX: 26, clientY: 60 });
  fireEvent.click(trendCell(rail));
  await advance(LONG_PRESS_MS + 50);
  assert.equal(menuOf(rail) === null, true, "a tap opened the flyout");
  assert.equal(trendCell(rail).getAttribute("aria-pressed"), "true", "a tap no longer arms the tool");

  // A finger that moves is scrolling the sheet.
  fireEvent.pointerDown(trendCell(rail), { pointerType: "touch", clientX: 26, clientY: 60 });
  fireEvent.pointerMove(trendCell(rail), { pointerType: "touch", clientX: 26, clientY: 80 });
  await advance(LONG_PRESS_MS + 50);
  assert.equal(menuOf(rail) === null, true, "a drag across the cell opened the flyout");
});

test("D-F9 — a mouse held on a cell does nothing new: desktop keeps right-click and the strip", async () => {
  const chart = await mountChart();
  const rail = railOf(chart.container);
  fireEvent.pointerDown(trendCell(rail), { pointerType: "mouse", clientX: 26, clientY: 60 });
  await advance(LONG_PRESS_MS + 50);
  assert.equal(menuOf(rail) === null, true, "a held mouse button opened the flyout");
  fireEvent.pointerUp(trendCell(rail), { pointerType: "mouse", clientX: 26, clientY: 60 });
});
