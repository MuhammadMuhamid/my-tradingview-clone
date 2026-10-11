/**
 * M2: the rendered halves of the reviewer's findings against live Premium
 * (2026-10-11). Geometry that needs a layout engine is held by
 * `qa/premiumLock.mjs`; what is held here is the structure that produces it
 * and the behaviour behind each control.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { clickAt, menuItems, mountChart, rightClickAt, selectTool } from "./harness/chart";
import { chartsIn } from "./harness/timeScales";
import { drawingStore } from "@/lib/drawingStore";
import { createWorkspace, WORKSPACE_STORAGE_KEY } from "@/lib/workspace";
import { defaultTemplates, saveTemplates } from "@/lib/indicatorTemplates";

const SYMBOL = "SOLUSDT";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

function seedCompare(): void {
  const ws = createWorkspace({ symbol: SYMBOL, interval: "1h" });
  ws.panes[0] = { ...ws.panes[0]!, compare: { symbol: "BTCUSDT", mode: "percent", length: 60 } };
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws));
}

/** Every mark in a menu: its box class and its glyph's drawn width. */
function marks(menu: HTMLElement): { box: string; glyph: string | null }[] {
  return [...menu.querySelectorAll<HTMLElement>("[data-menu-mark]")].map((mark) => ({
    box: mark.className,
    glyph: mark.querySelector("svg[data-menu-glyph]")?.getAttribute("width") ?? null,
  }));
}

/* ── F-02 ────────────────────────────────────────────────────────────────── */

test("F-02 — the series cluster takes room AFTER the identity, never over a value", async () => {
  seedCompare();
  const chart = await mountChart();
  await settle();
  const legend = chart.pane(0).querySelector<HTMLElement>("[data-pane-legend]");
  assert.ok(legend, "no pane legend");
  const cluster = legend.querySelector<HTMLElement>("[data-series-actions]");
  assert.ok(cluster, "the series legend has no hover cluster");
  // The last thing in the identity row, after the `vs` chip: so the title, the
  // interval, the venue and the chip never move, and whatever follows the
  // identity — the values — is pushed along by it rather than painted under it.
  assert.equal(legend.lastElementChild, cluster);
  const chip = within(legend).getByRole("button", { name: /^Comparing with BTCUSDT/ });
  assert.ok(chip.compareDocumentPosition(cluster) & Node.DOCUMENT_POSITION_FOLLOWING);
  // In flow: no absolutely-positioned overlay, no zero-width wrapper around it.
  assert.doesNotMatch(cluster.className, /\babsolute\b/);
  assert.equal(cluster.parentElement, legend);
  // Zero-width at rest, its own width on hover or focus.
  assert.match(cluster.className, /\bw-0\b/);
  assert.match(cluster.className, /group-hover\/series:w-auto/);
  assert.match(cluster.className, /focus-within:w-auto/);
  // The values are the NEXT sibling group of the identity, in the same row.
  const values = legend.parentElement?.querySelector<HTMLElement>(".tabular");
  assert.ok(values && (legend.compareDocumentPosition(values) & Node.DOCUMENT_POSITION_FOLLOWING),
    "the readout no longer follows the identity");
  assert.equal(cluster.querySelectorAll("button").length, 2, "Flag and More");
});

/* ── F-03 ────────────────────────────────────────────────────────────────── */

test("F-03 — the price chart's crosshair time label carries the weekday and the date", async () => {
  const chart = await mountChart();
  await settle();
  const price = chartsIn(chart.container).get("price");
  assert.ok(price, "no price chart");
  const format = price.options().localization.timeFormatter as ((t: number) => string) | undefined;
  assert.equal(typeof format, "function");
  // The harness's chart is intraday; 2026-10-04 20:00 UTC is a Sunday.
  assert.equal(format!(Date.UTC(2026, 9, 4, 20, 0) / 1000), "Sun 04 Oct '26 20:00");
});

/* ── F-05 ────────────────────────────────────────────────────────────────── */

test("F-05 — Manage layouts draws every mark as an 18px glyph in a 28px box", async () => {
  const chart = await mountChart();
  fireEvent.click(chart.container.querySelector<HTMLElement>('button[aria-label="Manage layouts"]')!);
  await settle();
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Saved layouts"]');
  assert.ok(menu, "the layouts menu did not open");
  const found = marks(menu);
  assert.ok(found.length >= 5, `expected a mark column on every verb row, saw ${found.length}`);
  for (const mark of found) assert.match(mark.box, /\bh-7 w-7\b/);
  const glyphs = found.map((m) => m.glyph).filter(Boolean);
  assert.ok(glyphs.length >= 3, "the copy, rename, new and open glyphs are gone");
  assert.ok(glyphs.every((w) => w === "18"), JSON.stringify(glyphs));
});

test("F-05 — the interval and chart-type stars are 18px in a 24px box", async () => {
  const chart = await mountChart();
  fireEvent.click(chart.container.querySelector<HTMLElement>('button[aria-label^="Chart interval"]')!);
  await settle();
  const intervals = document.querySelector<HTMLElement>('[role="menu"][aria-label="All timeframes"]');
  assert.ok(intervals);
  const stars = [...intervals.querySelectorAll<SVGElement>("svg[data-menu-star]")];
  assert.ok(stars.length > 10, "the interval rows have no star");
  for (const star of stars) {
    assert.equal(star.getAttribute("width"), "18");
    assert.match(star.parentElement?.className ?? "", /\bh-6 w-6\b/);
  }
  fireEvent.keyDown(document, { key: "Escape" });
  await settle();

  fireEvent.click(chart.container.querySelector<HTMLElement>('button[aria-label="Chart style"]')!);
  await settle();
  const styles = document.querySelector<HTMLElement>('[role="menu"][aria-label="Chart style"]');
  assert.ok(styles);
  const styleStars = [...styles.querySelectorAll<SVGElement>("svg[data-menu-star]")];
  assert.ok(styleStars.length > 10, "the chart-type rows have no star");
  for (const star of styleStars) {
    assert.equal(star.getAttribute("width"), "18");
    assert.match(star.parentElement?.className ?? "", /\bh-6 w-6\b/);
  }
});

/* ── F-12 ────────────────────────────────────────────────────────────────── */

test("F-12 — the chart-type menu is Premium's full-height column from the viewport top", async () => {
  const chart = await mountChart();
  fireEvent.click(chart.container.querySelector<HTMLElement>('button[aria-label="Chart style"]')!);
  await settle();
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Chart style"]');
  assert.ok(menu);
  const classes = menu.className.split(/\s+/);
  assert.ok(classes.includes("top-0"), "the menu no longer starts at the viewport's top");
  assert.ok(classes.includes("max-h-[100vh]"), "the menu is not the viewport's height");
  assert.ok(classes.includes("overflow-y-auto"), "the last row must stay reachable");
  assert.ok(!classes.includes("top-full"), "the menu is hung under the caret again");
});

/* ── F-06 ────────────────────────────────────────────────────────────────── */

test("F-06 — Indicator templates: two 32px verbs with marks; saved templates behind Open template…", async () => {
  saveTemplates([{ ...defaultTemplates()[0]!, name: "My momentum set" }]);
  const chart = await mountChart();
  fireEvent.click(chart.container.querySelector<HTMLElement>('[data-toolbar-control="indicator-templates"]')!);
  await settle();
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Indicator templates"]');
  assert.ok(menu, "the templates menu did not open");
  assert.match(menu.className, /w-\[219px\]/);
  assert.match(menu.className, /tvc-menu--compact/, "32px rows, not 40");
  const rows = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  assert.deepEqual(rows.map((r) => r.textContent?.trim()),
    ["Save indicator template…", "Open template…"]);
  const found = marks(menu);
  assert.equal(found.length, 2);
  for (const mark of found) {
    assert.match(mark.box, /\bh-7 w-7\b/);
    assert.equal(mark.glyph, "18");
  }
  assert.doesNotMatch(menu.textContent ?? "", /My momentum set/, "the library is not in the dropdown");

  fireEvent.click(rows[1]!);
  await settle();
  const dialog = screen.getByRole("dialog", { name: "Indicator templates" });
  assert.ok(within(dialog).getByText("My momentum set"), "a saved template is not offered");
  assert.ok(dialog.querySelector(`[data-template-row="${defaultTemplates()[0]!.name}"]`),
    "the default sets are not offered");
  assert.ok(within(dialog).getByRole("button", { name: "Delete the template My momentum set" }));
});

/* ── F-08 ────────────────────────────────────────────────────────────────── */

test("F-08 — `Remove N drawings` clears the pane's drawings without asking, and Undo brings them back", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Horizontal line");
  await clickAt(chart.plot, 400, 300);
  await selectTool(chart.container, "Horizontal line");
  await clickAt(chart.plot, 400, 200);
  await selectTool(chart.container, "Cross");
  assert.equal(drawingStore.get(SYMBOL).length, 2);

  await rightClickAt(chart.plot, 600, 500);
  const labels = menuItems().map((i) => i.label);
  const at = labels.indexOf("Remove 2 drawings");
  assert.ok(at >= 0, JSON.stringify(labels));
  // (A disabled row's label carries its reason for a screen reader.)
  assert.match(labels[at + 1] ?? "", /^Remove \d+ indicators?/, "beside Remove N indicators");
  const row = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .find((el) => el.textContent?.trim() === "Remove 2 drawings")!;
  fireEvent.click(row);
  await settle();
  assert.equal(screen.queryByRole("dialog"), null, "Premium asks nothing first");
  assert.equal(drawingStore.get(SYMBOL).length, 0);
  assert.equal(drawingStore.undo(SYMBOL)?.length, 2, "one undo step returns both");
});

/* ── F-09 ────────────────────────────────────────────────────────────────── */

test("F-09 — with a comparison on, the toolbar ＋ still opens the Compare dialog", async () => {
  seedCompare();
  const chart = await mountChart();
  await settle();
  fireEvent.click(chart.container.querySelector<HTMLElement>(
    'button[aria-label="Compare with another instrument"]')!);
  await settle();
  assert.ok(document.querySelector('[role="dialog"][data-symbol-search="compare"]'),
    "＋ opened something other than the Compare dialog");
  assert.equal(document.querySelector('[role="menu"][aria-label^="Comparing with"]'), null,
    "the mode menu belongs to the legend's vs chip");
});

/* ── F-11 ────────────────────────────────────────────────────────────────── */

test("F-11 — the axis A / L / % chips are 20×22 at weight 400", async () => {
  const chart = await mountChart();
  const chips = [...chart.pane(0).querySelectorAll<HTMLElement>("button[data-axis-chip]")];
  assert.equal(chips.length, 3);
  for (const chip of chips) {
    assert.match(chip.className, /\bh-\[22px\]/);
    assert.match(chip.className, /\bw-5\b/);
    assert.match(chip.className, /\bfont-normal\b/);
    assert.doesNotMatch(chip.className, /font-semibold|font-bold/);
  }
});
