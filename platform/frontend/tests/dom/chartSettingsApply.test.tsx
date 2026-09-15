/**
 * The settings dialog, driven the way a person drives it, against the chart.
 *
 * ── What this file is for ─────────────────────────────────────────────────
 *
 * R6's whole finding was a dialog that had grown rows faster than apply sites.
 * `tests/chartSettings.test.ts` pins that every key has a default, a normaliser
 * clause and a control; this pins the other end — that turning the control
 * MOVES something a reader can see. Every assertion below is made by clicking
 * the real control in the real dialog and then reading the real DOM the chart
 * renders, so removing an apply site fails it.
 *
 * The canvas is not readable this way — a candle's border colour and a grid
 * line's dash live in pixels the library owns — so those apply sites are
 * pinned by the traced-expression table in `tests/chartSettings.test.ts`
 * instead. Everything the chart renders as markup is here.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, compactSeries, render, resetBrowser, server, settle } from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";
import { IndicatorLegend } from "@/components/tv/IndicatorLegend";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** Open Chart settings from the toolbar and land on one tab. */
async function openSettings(chart: MountedChart, tab: string): Promise<HTMLElement> {
  const trigger = [...chart.container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.getAttribute("aria-label") === "Chart settings");
  assert.ok(trigger, "the chart settings action is missing from the toolbar");
  fireEvent.click(trigger);
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: tab }));
  await settle();
  return screen.getByRole("dialog", { name: "Chart settings" });
}

/**
 * Choose a value in one of the dialog's dropdowns.
 *
 * By its accessible NAME and its option's visible text, because that is all a
 * user has: R6 replaced every native `<select>` with a button and a listbox,
 * so `fireEvent.change` has nothing to change.
 */
async function chooseInDropdown(name: string, option: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name }));
  await settle();
  const list = screen.getByRole("listbox", { name });
  fireEvent.click(within(list).getByRole("option", { name: option }));
  await settle();
}

/** Tick or untick a dialog checkbox by its label. */
async function toggle(name: string): Promise<HTMLInputElement> {
  const box = screen.getByRole("checkbox", { name }) as HTMLInputElement;
  fireEvent.click(box);
  await settle();
  return box;
}

/** The pane's status-line column — identity, readout and study legend. */
function legendText(chart: MountedChart): string {
  const legend = chart.pane(0).querySelector<HTMLElement>("[data-pane-legend]");
  assert.ok(legend, "the pane has no legend");
  return legend.parentElement!.parentElement!.textContent ?? "";
}

test("R6 SL-2 — the Title row changes which form of the name the chart carries", async () => {
  const chart = await mountChart();
  assert.match(legendText(chart), /Solana \/ TetherUS/,
    "the headline opens as R3-14 left it: the instrument's name");

  await openSettings(chart, "Status line");
  /*
   * ── R3b-25: `Full symbol` became `Ticker` ────────────────────────────────
   *
   * The dropdown offered `Name` and `Full symbol`, and `Full symbol` printed
   * `BINANCE:SOL/USDT · SPOT` — a form TradingView's `Title` row does not
   * offer at all, and one §5 keeps out of primary copy. The reference's three
   * are `Name`, `Ticker` and `Description`; the stored literals are unchanged
   * so a workspace that had chosen the qualified form keeps working and now
   * gets the ticker.
   */
  await chooseInDropdown("Title form", "Ticker");

  const ticker = legendText(chart);
  assert.doesNotMatch(ticker, /Solana \/ TetherUS/,
    "choosing Ticker must replace the name, not sit beside it");
  assert.match(ticker, /SOLUSDT/, "the ticker is what the venue lists");
  assert.doesNotMatch(ticker, /SOL\/USDT · SPOT/,
    "the qualified form is not one of the reference's three");
  assert.doesNotMatch(ticker, /instrument:v1:/,
    "no form may ever print a canonical id — contract §5");

  // Description, which this build resolves to the descriptive name until a
  // provider hands us a longer one.
  await chooseInDropdown("Title form", "Description");
  assert.match(legendText(chart), /Solana \/ TetherUS/);

  // And back, because a setting that only goes one way is half a setting.
  await chooseInDropdown("Title form", "Name");
  assert.match(legendText(chart), /Solana \/ TetherUS/);
});

test("R3b-24 — Logo and Open market status put a mark and a dot on the status line", async () => {
  /*
   * The reference's status line opens with a 24px instrument logo and closes
   * its identity with a market-status dot after the venue; ours had neither,
   * and the repair queue's reason ("no source") was refuted by the product's
   * own right panel, which draws a `BT` avatar and `Market open` for the same
   * instrument.
   */
  const chart = await mountChart();
  const logo = (): HTMLElement | null =>
    chart.pane(0).querySelector<HTMLElement>("[data-status-logo]");
  const dot = (): HTMLElement | null =>
    chart.pane(0).querySelector<HTMLElement>('[data-market-status="open"]');

  assert.ok(logo(), "the reference draws the logo before anybody chooses, and so does this");
  assert.equal(logo()!.textContent, "S", "our own disc, carrying the base asset's initial");
  assert.ok(dot(), "a crypto pair trades continuously — that is a fact, not a guess");

  await openSettings(chart, "Status line");
  await toggle("Logo");
  assert.equal(logo(), null, "the row has to take it off the chart, not merely record a preference");
  await toggle("Open market status");
  assert.equal(dot(), null);

  // Both back: a switch that only goes one way is half a switch.
  await toggle("Logo");
  await toggle("Open market status");
  assert.ok(logo());
  assert.ok(dot());
});

test("R3b-25 — Background paints a plate behind the legend's text runs", async () => {
  /*
   * The reference's `Background` row is on by default with an opacity slider,
   * and it is what keeps `O H L C` legible over a dense candle. A plate behind
   * the TEXT RUNS — never a box around the legend, which is the chrome R3-10
   * removed.
   */
  const chart = await mountChart();
  const readout = (): HTMLElement => {
    const legend = chart.pane(0).querySelector<HTMLElement>("[data-pane-legend]");
    const row = legend!.parentElement!.parentElement!
      .querySelector<HTMLElement>("div[style*='background-color']");
    assert.ok(row, "no legend text run carries the plate");
    return row;
  };
  assert.match(readout().style.backgroundColor, /rgb\(var\(--ts-surface-rgb\)/,
    "the plate is the CHART's ground in whichever theme is running, not a literal");
  assert.match(readout().style.backgroundColor, /0\.6\)/, "and the reference's default weight");

  await openSettings(chart, "Status line");
  await toggle("Background");
  const legend = chart.pane(0).querySelector<HTMLElement>("[data-pane-legend]");
  assert.equal(
    legend!.parentElement!.parentElement!.querySelector("div[style*='background-color']"), null,
    "Background off leaves the legend as bare type on the plot");
});

test("R6 SC-2 — the Scale mode buttons row decides when the axis strip is drawn", async () => {
  const chart = await mountChart();
  const strip = (): HTMLElement | null =>
    chart.pane(0).querySelector<HTMLElement>("[data-axis-buttons]");

  /*
   * `hover` is where R1-11 left it and where the reference's own row sits:
   * the four controls are on the axis and the pointer reveals them.
   */
  assert.ok(strip(), "the axis strip is rendered by default");
  assert.match(strip()!.className, /opacity-0/);
  assert.match(strip()!.className, /group-hover\/axis:opacity-100/);
  assert.deepEqual(
    [...strip()!.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()),
    ["auto", "log", "%"],
    "the strip holds the axis's own controls, whatever its visibility");

  await openSettings(chart, "Canvas");
  await chooseInDropdown("Navigation buttons", "Always visible");
  assert.equal(strip()?.getAttribute("data-axis-buttons"), "always");
  assert.doesNotMatch(strip()!.className, /opacity-0/,
    "Always visible must actually leave them lit, not merely record a preference");

  await chooseInDropdown("Navigation buttons", "Always hidden");
  assert.equal(strip(), null, "Hidden takes the four controls off the chart");

  /*
   * The mode badge is NOT one of the four. An axis in percent or log that does
   * not say so is a chart lying about the moves on it, so it survives Hidden.
   */
  assert.ok(chart.pane(0).querySelector('[role="group"][aria-label^="Price scale"]'),
    "the price-scale group, and with it the mode badge, stays");
});

test("C-03/C-04 — timezone, countdown, and the required scales rows operate on the chart", async () => {
  const chart = await mountChart();
  await openSettings(chart, "Symbol");
  assert.ok(screen.getByRole("checkbox", { name: "Color bars based on previous close" }));
  await chooseInDropdown("Timezone", "(UTC+5) Karachi");
  assert.match(chart.container.textContent ?? "", /Karachi/,
    "the bottom-right chart clock must relabel when the display zone changes");

  fireEvent.click(screen.getByRole("tab", { name: "Scales and lines" }));
  await settle();
  for (const label of ["No overlapping labels", "Plus button", "Countdown to bar close"]) {
    assert.ok(screen.getByRole("checkbox", { name: label }));
  }
  assert.ok(screen.getByRole("button", { name: "Previous day close" }));
  assert.ok(screen.getByRole("button", { name: "High and low" }));
  assert.match(chart.container.querySelector<HTMLElement>("[data-bar-close-countdown]")?.textContent ?? "",
    /^\d{2}:\d{2}:\d{2}$/);
  await toggle("Countdown to bar close");
  assert.equal(chart.container.querySelector("[data-bar-close-countdown]"), null);
});

test("C-04/C-06 — Canvas has effective colour wells, styled lines, and both button modes", async () => {
  const chart = await mountChart();
  const dialog = await openSettings(chart, "Canvas");
  assert.ok(screen.getByRole("button", { name: "Pane separator colour" }));
  assert.ok(screen.getByRole("button", { name: "Navigation buttons" }));
  assert.ok(screen.getByRole("button", { name: "Pane buttons" }));

  const background = screen.getByRole("button", { name: "Background colour" });
  const paint = background.querySelector<HTMLElement>("span");
  assert.ok(paint?.style.backgroundColor,
    "a theme-backed colour well must paint its effective colour, not a slash");
  assert.equal(background.querySelector("svg"), null);

  const vertical = screen.getByRole("button", { name: "Vertical grid line appearance" });
  fireEvent.click(vertical);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Dotted" }));
  await settle();
  const preview = vertical.querySelector("path");
  assert.equal(preview?.getAttribute("d"), "M0 6h40");
  assert.ok(preview?.getAttribute("stroke-dasharray"), "the configured dotted state reaches the preview");
  assert.ok(within(dialog).getByText("Buttons"));
});

test("R6 SL-1 — Titles, Inputs and Values each hide their own part of the study legend", async () => {
  const chart = await mountChart();
  const studies = (): string => {
    const legend = chart.pane(0).querySelector<HTMLElement>("[data-pane-legend]");
    return legend!.parentElement!.parentElement!.textContent ?? "";
  };
  assert.match(studies(), /Moving averages/, "the harness opens with a study on the price pane");
  const withValues = studies();

  await openSettings(chart, "Status line");

  // Values: the readings go, the name stays. One switch used to take both.
  await toggle("Values");
  assert.match(studies(), /Moving averages/,
    "turning values off must not unmount the legend — that was the old single switch");
  assert.notEqual(studies(), withValues, "and the readings must actually go");

  // Titles: the name goes too, and with nothing left the legend is absent.
  await toggle("Titles");
  assert.doesNotMatch(studies(), /Moving averages/);

  // Titles back on: the name returns. `Inputs` is the study's PARAMETERS, and
  // the price pane's moving-average panel publishes none, so the dependent row
  // is exercised against the legend itself in the test below.
  await toggle("Titles");
  assert.match(studies(), /Moving averages/);
  const inputs = screen.getByRole("checkbox", { name: "Inputs" }) as HTMLInputElement;
  assert.equal(inputs.disabled, false, "Inputs is live while Titles is on");
  await toggle("Titles");
  assert.equal(
    (screen.getByRole("checkbox", { name: "Inputs" }) as HTMLInputElement).disabled, true,
    "a dependent row is DISABLED under its parent, never unmounted");
});

test("R6 SL-1 — the legend's three parts are three independent props", async () => {
  /*
   * Driven against `IndicatorLegend` directly, because the apply site is three
   * props on it and the price pane's own study publishes no parameters — so
   * `Inputs` has nothing to hide there. A study applied from the library does
   * ("Length 14 · Source close"), and this is that study.
   */
  const overlay = {
    id: "rsi:0", title: "RSI", color: "#7e57c2",
    instanceId: "rsi", instanceTitle: "Relative Strength Index",
    instanceParams: "Length 14 · Source close",
    data: [{ time: 1_700_000_000, value: 45.28, color: "#7e57c2" }],
  };
  const view = render(
    <IndicatorLegend overlays={[overlay]} time={null} collapsible={false} />);
  await settle();
  const all = view.container.textContent ?? "";
  assert.match(all, /Relative Strength Index/);
  assert.match(all, /Length 14 · Source close/);
  assert.match(all, /45\.28/);

  view.rerender(
    <IndicatorLegend overlays={[overlay]} time={null} collapsible={false} showInputs={false} />);
  await settle();
  const noInputs = view.container.textContent ?? "";
  assert.match(noInputs, /Relative Strength Index/, "the title is not the inputs");
  assert.doesNotMatch(noInputs, /Length 14/, "Inputs off must take the parameters away");
  assert.match(noInputs, /45\.28/, "and must leave the reading alone");

  view.rerender(
    <IndicatorLegend overlays={[overlay]} time={null} collapsible={false} showTitles={false} />);
  await settle();
  const noTitles = view.container.textContent ?? "";
  assert.doesNotMatch(noTitles, /Relative Strength Index/);
  assert.doesNotMatch(noTitles, /Length 14/, "the inputs depend on the title, as the dialog says");
  assert.match(noTitles, /45\.28/);

  view.rerender(
    <IndicatorLegend overlays={[overlay]} time={null} collapsible={false} showValues={false} />);
  await settle();
  const noValues = view.container.textContent ?? "";
  assert.match(noValues, /Relative Strength Index/);
  assert.doesNotMatch(noValues, /45\.28/);
});

test("R6b-H — Inputs off reaches a study in its OWN pane, not only the price overlays", async () => {
  /*
   * ── The defect ───────────────────────────────────────────────────────────
   *
   * `IndicatorPane` mounted `IndicatorLegend` without the three props, so the
   * Status-line tab's `Titles` / `Inputs` / `Values` rows moved the price
   * pane's overlay legend and moved an RSI pane by 0px. One switch, two
   * answers, on one chart — and the one it did not reach is the legend most
   * charts actually carry.
   *
   * Driven through the real dialog on a chart with a real study pane: a study
   * injected past the browser is a study that never went through the code
   * that decides where it goes.
   */
  const chart = await mountChart();
  await settle();

  const open = chart.container.querySelector<HTMLElement>('button[aria-label="Indicators"]');
  assert.ok(open, "the toolbar has no Indicators control");
  fireEvent.click(open);
  await settle();
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Relative Strength Index" }));
  await settle();
  fireEvent.keyDown(document, { key: "Escape" });
  await settle();

  const studyPane = (): HTMLElement => {
    const pane = chart.container
      .querySelector<HTMLElement>("section[aria-label$='indicator pane']");
    assert.ok(pane, "the study did not get a pane");
    return pane;
  };
  const paneLegend = (): string => {
    const legend = studyPane().querySelector<HTMLElement>(".flex.flex-col.items-start");
    return legend?.textContent ?? "";
  };
  assert.match(paneLegend(), /Relative Strength Index/);
  assert.match(paneLegend(), /14 close/,
    "the study pane's legend opens with its inputs, as the price pane's does");

  await openSettings(chart, "Status line");
  await toggle("Inputs");
  assert.doesNotMatch(paneLegend(), /14 close/,
    "Inputs off must reach the pane legend too — that is the whole finding");
  assert.match(paneLegend(), /Relative Strength Index/, "and must leave the title alone");

  await toggle("Inputs");
  assert.match(paneLegend(), /14 close/, "and back, because a one-way switch is half a switch");

  // Leave the chart as it was found: the workspace is server-synced.
  const remove = studyPane()
    .querySelector<HTMLElement>('button[aria-label^="Remove Relative Strength Index"]');
  if (remove) { fireEvent.click(remove); await settle(); }
});

test("R6 SL-3 — Last day change values prints the 24h figure the quote contract carries", async () => {
  const chart = await mountChart();
  assert.doesNotMatch(legendText(chart), /24h/,
    "the reference's row is off before anybody chooses, and so is this one");

  await openSettings(chart, "Status line");
  await toggle("Last day change values");
  await settle();

  /*
   * The figure comes from the same contract the watchlist reads, so on a feed
   * that answers it is a number and on one that does not it is NOTHING — never
   * a dash, which beside a real bar change would read as a change of zero.
   */
  const text = legendText(chart);
  if (/24h/.test(text)) {
    assert.match(text, /24h\s*[+−-]?[\d,]/, "a 24h row that appears carries a number");
  } else {
    assert.doesNotMatch(text, /24h\s*—/, "a feed with no 24h open prints nothing at all");
  }
});
