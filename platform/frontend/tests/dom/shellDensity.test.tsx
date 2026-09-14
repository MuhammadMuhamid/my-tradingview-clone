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
import fs from "node:fs";
import path from "node:path";

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
  /*
   * Found by `data-resolution`, not by the shape of the printed text.
   *
   * A chip prints day-and-longer resolutions as a bare uppercase letter (`D`)
   * and sub-day with its count (`4h`), which is close to how the bottom row's
   * RANGE shortcuts are written — `1D 5D 1M 3M 6M`, a different control
   * setting a different thing, and one that a text-shaped match swept up the
   * moment the strip started printing days. Only a chip that sets a resolution
   * carries the resolution.
   */
  return [...container.querySelectorAll<HTMLElement>("button[data-resolution]")]
    .filter((b) => b.getAttribute("aria-pressed") !== null)
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
  // `D`, not `1D`: the shared grammar prints the count only for a multiple
  // (`2D`), and a blind reviewer picked our bar out of a pair on that one
  // character. See `lib/timeframes.chipLabel`.
  assert.deepEqual(pressable, ["1m", "5m", "15m", "1h", "4h", "D"],
    `a timeframe strip is rendered more than once: ${pressable.join(", ")}`);
  for (const button of [...chart.container.querySelectorAll<HTMLElement>("button")]) {
    if (button.closest("[data-pane-legend]") === null) continue;
    assert.ok(!/^\d+[smhd]$/i.test((button.textContent ?? "").trim())
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
  /*
   * TVP8 R3-14: the identity and the OHLC readout share ONE line.
   *
   * They used to be two rows of the column, each in its own `bg-surface/75`
   * box, where the reference has a single line of type — name, interval,
   * venue, then `O H L C` at the same baseline. So the legend's parent is now
   * that status ROW, and the row is the column's first child.
   */
  const row = legend.parentElement;
  assert.ok(row !== null);
  assert.match(row.className, /items-baseline/, "the identity and the readout share a baseline");
  assert.equal(row.firstElementChild, legend,
    "what the chart IS comes before what is being read off it");

  const column = row.parentElement;
  assert.ok(column !== null);
  assert.match(column.className, /absolute/);
  assert.match(column.className, /pointer-events-none/,
    "a legend that ate a drag would break every trend line started top-left");
  assert.match(column.className, /flex-col/, "one stacked column, not two overlays");
  assert.equal(column.firstElementChild, row,
    "what the chart IS belongs above every notice about how it is drawn");
  // R3-10/R3-14: no row of this legend paints a surface over the candles.
  for (const el of [row, legend, column]) {
    assert.doesNotMatch(el.className, /bg-surface\//,
      "a filled box under the status line is chrome, not a legend");
  }

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
  const column = pane.querySelector<HTMLElement>("[data-pane-legend]")!
    .parentElement!.parentElement!;

  /*
   * The readout used to open with "SOLUSDT · 15m ·" of its own. With the
   * pane's identity beside it, that was the same two facts twice — the
   * reported defect one layer down.
   *
   * TVP8 R3-14: the identity is the instrument's NAME rather than its listing
   * code. `Bitcoin / TetherUS · 1h · Binance` is what the reference's status
   * line says; `BTCUSDT` in 14px bold is the CONTROL grammar and stays on the
   * toolbar pill. What may never appear is the canonical id, which is the rule
   * the symbol policy exists for — so that is asserted directly rather than
   * inferred from the absence of a ticker.
   */
  const text = column.textContent ?? "";
  const names = text.match(/Solana \/ TetherUS/g) ?? [];
  assert.equal(names.length, 1, `the instrument is named ${names.length} times: ${text}`);
  const intervals = text.match(/15m/g) ?? [];
  assert.equal(intervals.length, 1, `the resolution is named ${intervals.length} times: ${text}`);
  assert.doesNotMatch(text, /instrument:v1:/,
    "a canonical id is never user-facing copy — contract §5");
  assert.doesNotMatch(text, /SOLUSDT/,
    "the ticker is the control's own spelling, not the chart's headline");

  // The OHLC readout is still there, on that same line, still saying what it
  // is reading. The reference sets it tight — `O77,600.00`, no space.
  assert.match(text, /O\d/);
  assert.match(text, /C\d/);

  /*
   * R3-14: `Vol` is off by default, because the reference's status line does
   * not carry it. It stays a Status-line switch for anyone who wants it.
   */
  assert.doesNotMatch(text, /Vol\s/, "volume is not part of the default status line");
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
  assert.deepEqual(timeframeButtons(chart.container), ["1m", "5m", "15m", "1h", "4h", "D"]);
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
  /*
    Found by `data-resolution`, not by the printed label. The menu prints the
    interval in FULL WORDS — `1 hour` — as the reference's does
    (`measurements/tv-timeframe-menu-20260914.md`); the canonical id is the
    attribute, and the attribute is what a test has any business reading.
  */
  const row = menu.querySelector<HTMLElement>(
    'button[role="menuitemradio"][data-resolution="1h"]');
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

// ── TVP8 round 3 (R1c): the density steps, measured ─────────────────────────

test("R1c-01 — the whole product is grayscale-antialiased", () => {
  /*
   * A stylesheet assertion, deliberately: jsdom does not render glyphs, so the
   * only honest thing a DOM test can pin here is the RULE. The pixels are the
   * capture's job (`tradingscene/a5-wave3/`), and the numbers to beat are the
   * reference's own: the `1m` chip at (78 ink px, mean 127), `5m` (86, 139),
   * `15m` (111, 136), `4h` (72, 140), the bottom row's `1D` (70, 137).
   *
   * Chrome's default is SUBPIXEL rendering, which lights the three colour
   * elements of a pixel separately and so fattens and brightens every glyph:
   * ours measured 8-25% more ink and 15-30 luminance levels above the
   * reference's on every label on the bar. Injecting this one declaration into
   * the reviewed build reproduced TradingView's numbers exactly, which is what
   * identifies it as the whole of the difference.
   */
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "app", "globals.css"), "utf8");
  const html = /(?:^|\n)html\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.ok(html, "globals.css has no bare `html` block");
  assert.match(html, /-webkit-font-smoothing:\s*antialiased/);
  assert.match(html, /-moz-osx-font-smoothing:\s*grayscale/);
  // Repeated on `body` so the smoke check can sample the element it samples.
  const body = /(?:^|\n)body\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.match(body, /-webkit-font-smoothing:\s*antialiased/);
});

test("R1c-17 — at 1920 the bar grows exactly three words", async () => {
  const chart = await mountChart();
  /*
   * Measured on `tradingview/tv-shell-1920x1080-dark.png`: the reference
   * labels `Indicators` (x 654-715), `Alert` (811-840) and `Replay` (889-930)
   * at 1920 and nothing else, at 1440 it labels none of them, and every other
   * number on the shell — toolbar 38, rail 52, right rail, bottom row — is
   * unchanged by the extra width. It is a density step, not a layout.
   *
   * jsdom has no media queries, so what is asserted is the gate: each of the
   * three carries a label that is `hidden` until `2xl` (1536, the only stop
   * between the two widths), and its cell gives up its fixed 38px there too.
   */
  const labelled = ["Indicators", "Create alert", "Bar replay"].map((name) => {
    const button = [...chart.container.querySelectorAll<HTMLElement>("button")]
      .find((b) => (b.getAttribute("aria-label") ?? "").startsWith(name));
    assert.ok(button, `${name} is not on the bar`);
    return button;
  });
  for (const button of labelled) {
    const label = [...button.querySelectorAll<HTMLElement>("span")]
      .find((s) => /2xl:inline/.test(s.className));
    assert.ok(label, `${button.getAttribute("aria-label")} has no wide-viewport label`);
    assert.match(label.className, /(^|\s)hidden(\s|$)/,
      "the word must not be on the bar at 1440, where the reference has none");
    assert.match(button.className, /2xl:w-auto/,
      "a 38px-wide cell cannot hold a word");
  }
  // And nothing else on the row grows one.
  const wide = [...chart.container.querySelectorAll<HTMLElement>(
    '[data-toolbar-row="primary"] span')].filter((s) => /2xl:inline/.test(s.className));
  assert.equal(wide.length, 3, `${wide.length} controls are labelled at 2xl, not 3`);
});

test("R1c-07 — the bottom range row is 38px, and its chips have no gaps", async () => {
  const chart = await mountChart();
  const group = chart.container.querySelector<HTMLElement>(
    '[role="group"][aria-label="Visible range"]');
  assert.ok(group, "the bottom row has no range group");

  /*
   * Measured: the hairline at y=861 and the row 862-899 — 38px, the toolbar's
   * own height. Ours was 33 with a 1px frame under it.
   */
  const row = group.parentElement;
  assert.ok(row);
  assert.match(row.className, /h-\[38px\]/);
  assert.match(row.className, /border-t border-border/, "the hairline is inside the row");

  /*
   * And the pitch: the reference's chips are the label plus 14, ours were the
   * label plus 16 (`px-1.5` and a 2px gap), so `All` sat fifteen pixels right
   * of where the reference has it and took the separator and the go-to-date
   * cell with it.
   */
  assert.doesNotMatch(group.className, /gap-/, "a gap between chips is 2px of extra pitch each");
  for (const chip of group.querySelectorAll<HTMLElement>("button")) {
    assert.match(chip.className, /px-\[7px\]/);
  }
  // The go-to-date glyph is a 19x19 ink box at one unit to one pixel.
  const goTo = chart.container.querySelector<HTMLElement>('button[aria-label="Go to date"]');
  assert.ok(goTo, "the go-to-date control is missing");
  const glyph = goTo.querySelector("svg");
  assert.equal(glyph?.getAttribute("viewBox"), "0 0 19 19");
  assert.equal(glyph?.getAttribute("width"), "19");
  assert.equal(glyph?.getAttribute("stroke-width"), "1");
});
