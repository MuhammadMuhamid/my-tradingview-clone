/**
 * One pane, one symbol control, one timeframe control.
 *
 * ── What is actually being measured ────────────────────────────────────────
 *
 * The owner's report was that a one-pane workspace "repeats symbol/timeframe
 * controls in more than one visual layer". That is a countable claim, and until
 * now nothing counted it: the source tests could see that both components
 * existed, and neither could see that both were on screen at once.
 *
 * These tests render the workspace and count the controls a person can click.
 * They also count the chrome ROWS above the plot, because the second half of
 * the report — "the chart should dominate more cleanly" — is about how much of
 * the window is not the chart.
 *
 * The benchmark, measured live and cached under `evidence/P1A_tv/`: TradingView
 * has exactly one symbol control and exactly one interval control in its header
 * toolbar, in one pane and in a two-chart layout alike, and each pane names its
 * own instrument and interval inside the chart canvas as a legend rather than
 * as a second bar.
 *
 * ── Multi-pane autonomy is the other half ──────────────────────────────────
 *
 * De-duplication that took a pane's own controls away would be a regression,
 * not a fix: a four-chart workspace needs four independent timeframes. So the
 * last tests here drive a second pane to a different resolution and assert that
 * the first one did not move.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, within } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** Every control that changes an instrument, anywhere on screen. */
function symbolControls(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("button")]
    .filter((b) => /change symbol/i.test(b.getAttribute("aria-label") ?? ""));
}

/** Every control that sets a timeframe by clicking it, anywhere on screen. */
function timeframeButtons(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("button")]
    .filter((b) => b.getAttribute("aria-pressed") !== null
      && /^\d+[smhd]$/.test((b.textContent ?? "").trim()))
    .map((b) => (b.textContent ?? "").trim());
}

/** Set the layout to `n` charts through the toolbar, as a user would. */
async function useLayout(container: HTMLElement, label: string): Promise<void> {
  const layout = container.querySelector<HTMLElement>('[data-toolbar-control="layout"]');
  assert.ok(layout, "the toolbar has no layout control");
  const button = layout.querySelector<HTMLElement>("button") ?? layout;
  fireEvent.click(button);
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>("button")]
    .find((b) => (b.getAttribute("aria-label") ?? b.getAttribute("title") ?? "").includes(label));
  assert.ok(option, `no layout option matching ${JSON.stringify(label)}`);
  fireEvent.click(option);
  await settle();
}

// ── one pane ────────────────────────────────────────────────────────────────

test("A ONE-PANE WORKSPACE HAS ONE SYMBOL CONTROL AND ONE INTERVAL STRIP", async () => {
  const chart = await mountChart();
  assert.equal(chart.container.querySelectorAll("[data-pane-id]").length, 1);

  /*
   * Two symbol buttons is the reported defect, exactly.
   *
   * The toolbar's is the interactive control; the pane's is its legend — a name
   * on the chart that happens to be clickable, the way TradingView's is. What
   * must never happen again is a bordered header row under the toolbar carrying
   * a second copy of the same cluster.
   */
  const symbols = symbolControls(chart.container);
  assert.equal(symbols.length, 2,
    "the toolbar control and the pane legend, and nothing else");
  const toolbarSymbol = symbols.find(
    (b) => b.closest('[data-toolbar-control="symbol"]') !== null);
  const legendSymbol = symbols.find((b) => b.closest("[data-pane-legend]") !== null);
  assert.ok(toolbarSymbol, "the toolbar's symbol control is missing");
  assert.ok(legendSymbol, "the pane does not name its own instrument");

  // The strip exists ONCE. Six favourite buttons, on the toolbar, and no
  // second run of them anywhere.
  const pressable = timeframeButtons(chart.container);
  assert.deepEqual(pressable, ["1m", "5m", "15m", "1h", "4h", "1d"],
    `a timeframe strip is rendered more than once: ${pressable.join(", ")}`);
  for (const button of [...chart.container.querySelectorAll<HTMLElement>("button")]) {
    if (button.closest("[data-pane-legend]") === null) continue;
    assert.ok(!/^\d+[smhd]$/.test((button.textContent ?? "").trim())
      || button.getAttribute("aria-haspopup") === "menu",
      "the pane legend must state one timeframe, not offer a strip of them");
  }
});

test("the pane's chrome is a legend over the plot, not a row above it", async () => {
  const chart = await mountChart();
  const pane = chart.pane(0);
  const legend = pane.querySelector<HTMLElement>("[data-pane-legend]");
  assert.ok(legend, "the pane has no legend");

  /*
   * The legend sits in the chart's OWN stacked overlay column.
   *
   * `CandleChart` positions that column absolutely at the plot's top-left and
   * says in a comment why there is only one of them: a second overlay pinned to
   * the same offset gets painted straight through the OHLC readout. This legend
   * was written as that second overlay once, and "SOLUSDT 15m" landed on top of
   * "SOLUSDT · 15m O … H … L …" in the live app. So what is asserted is
   * membership of the column, not a second set of coordinates.
   */
  const column = legend.parentElement;
  assert.ok(column !== null);
  assert.match(column.className, /absolute/);
  assert.match(column.className, /pointer-events-none/,
    "a legend that ate a drag would break every trend line started top-left");
  assert.match(column.className, /flex-col/, "one stacked column, not two overlays");
  assert.equal(column.firstElementChild, legend,
    "what the chart IS belongs above what is being read off it");

  // The legend itself is transparent to the pointer; only its controls are not.
  assert.match(legend.className, /pointer-events-none/);
  assert.ok(legend.querySelector(".pointer-events-auto"),
    "every legend control must opt back in individually");

  // It takes no row from the chart: the plot is its sibling's, not below it.
  const plotHost = pane.querySelector<HTMLElement>(".tv-lightweight-charts");
  assert.ok(plotHost, "the pane has no chart host");
  assert.ok(!legend.contains(plotHost) && !plotHost.contains(legend));
});

test("THE CHART NAMES ITS INSTRUMENT AND RESOLUTION EXACTLY ONCE", async () => {
  const chart = await mountChart();
  const pane = chart.pane(0);
  const column = pane.querySelector<HTMLElement>("[data-pane-legend]")!.parentElement!;

  /*
   * The readout under the legend used to open with "SOLUSDT · 15m ·" of its
   * own. With the pane's identity now directly above it, that was the same two
   * facts twice, forty pixels apart — the reported defect one layer down.
   */
  const text = column.textContent ?? "";
  const symbols = text.match(/SOLUSDT/g) ?? [];
  assert.equal(symbols.length, 1, `the instrument is named ${symbols.length} times: ${text}`);
  const intervals = text.match(/15m/g) ?? [];
  assert.equal(intervals.length, 1, `the resolution is named ${intervals.length} times: ${text}`);

  // The OHLC row is still there, and still says what it is reading.
  assert.match(text, /O\s/);
  assert.match(text, /C\s/);
});

test("neither maximise nor close exists when there is only one pane", async () => {
  const chart = await mountChart();
  const labels = [...chart.container.querySelectorAll<HTMLElement>("button")]
    .map((b) => b.getAttribute("aria-label") ?? "");
  // Not disabled — absent. There is nothing to maximise away from and nothing
  // left if it closes, so a greyed-out control would be chrome with no meaning.
  assert.ok(!labels.some((l) => /Maximize this pane/.test(l)));
  assert.ok(!labels.some((l) => /^Close the .* pane$/.test(l)));
});

test("a fresh chart draws one moving average, not a mesh of ten", async () => {
  const chart = await mountChart();
  /*
   * The overlay legend names every line the chart is drawing. Ten of them, in
   * five same-hue pairs, is the "duplicated spaghetti" a fresh chart opened
   * with; one is a deliberate default, and the MA panel's "show all" restores
   * the rest in a single click.
   */
  const text = chart.container.textContent ?? "";
  assert.match(text, /SMA 200/, "the strategy's own trend filter must be drawn");
  for (const hidden of ["EMA 200", "SMA 100", "EMA 100", "SMA 50", "EMA 50",
    "SMA 21", "EMA 21", "SMA 15", "EMA 15"]) {
    assert.doesNotMatch(text, new RegExp(`${hidden}[^a-z]`),
      `${hidden} is drawn on a fresh chart by default`);
  }
});

// ── multi-chart ─────────────────────────────────────────────────────────────

test("EVERY PANE KEEPS ITS OWN SYMBOL AND ITS OWN TIMEFRAME", async () => {
  const chart = await mountChart();
  await useLayout(chart.container, "2 charts");

  const panes = chart.container.querySelectorAll<HTMLElement>("[data-pane-id]");
  assert.equal(panes.length, 2, "the layout did not change");

  // One legend per pane, each with its own symbol and its own timeframe control.
  for (const pane of panes) {
    const legend = pane.querySelector<HTMLElement>("[data-pane-legend]");
    assert.ok(legend, "a pane has no legend of its own");
    assert.equal(symbolControls(legend).length, 1);
    assert.ok(within(legend).getByRole("button", { name: /Timeframe for this pane/ }));
  }

  // The toolbar is still ONE symbol control and ONE strip, exactly as in one
  // pane — it acts on the focused pane, which is what the benchmark does too.
  assert.deepEqual(timeframeButtons(chart.container), ["1m", "5m", "15m", "1h", "4h", "1d"]);
  assert.equal(
    symbolControls(chart.container).filter(
      (b) => b.closest('[data-toolbar-control="symbol"]') !== null).length, 1);
});

test("changing one pane's timeframe from its legend leaves the other where it was", async () => {
  const chart = await mountChart();
  await useLayout(chart.container, "2 charts");

  const paneInterval = (index: number): string => {
    const legend = chart.pane(index).querySelector<HTMLElement>("[data-pane-legend]")!;
    return within(legend).getByRole("button", { name: /Timeframe for this pane/ })
      .textContent!.trim();
  };
  assert.equal(paneInterval(0), "15m");
  assert.equal(paneInterval(1), "15m");

  // Drive the SECOND pane's own control, which is the whole point of a
  // multi-chart workspace.
  const second = chart.pane(1).querySelector<HTMLElement>("[data-pane-legend]")!;
  fireEvent.click(within(second).getByRole("button", { name: /Timeframe for this pane/ }));
  await settle();
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Pane timeframe"]');
  assert.ok(menu, "the pane's timeframe menu did not open");
  const row = [...menu.querySelectorAll<HTMLElement>('button[role="menuitemradio"]')]
    .find((b) => (b.querySelector("span")?.textContent ?? "").trim() === "1h");
  assert.ok(row);
  fireEvent.click(row);
  await settle();

  assert.equal(paneInterval(1), "1h");
  assert.equal(paneInterval(0), "15m", "one pane's timeframe reached another's");

  // And the second pane's own window was loaded, at its own resolution.
  const asked = server.callsTo("/candles").map((c) => c.path);
  assert.ok(asked.some((p) => /interval=1h/.test(p)));
  assert.ok(asked.some((p) => /interval=15m/.test(p)));
});

test("the pane menus are exclusive: two panes cannot both hold a menu open", async () => {
  const chart = await mountChart();
  await useLayout(chart.container, "2 charts");

  const open = (index: number): void => {
    const legend = chart.pane(index).querySelector<HTMLElement>("[data-pane-legend]")!;
    fireEvent.click(within(legend).getByRole("button", { name: /Timeframe for this pane/ }));
  };
  open(0);
  await settle();
  open(1);
  await settle();
  assert.equal(
    document.querySelectorAll('[role="menu"][aria-label="Pane timeframe"]').length, 1,
    "two menus open at once is two products");
});
