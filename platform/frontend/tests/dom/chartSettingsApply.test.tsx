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
  await chooseInDropdown("Title form", "Full symbol");

  const qualified = legendText(chart);
  assert.doesNotMatch(qualified, /Solana \/ TetherUS/,
    "choosing Full symbol must replace the name, not sit beside it");
  assert.match(qualified, /SOLUSDT/,
    "the qualified identity names the instrument the venue lists");
  assert.doesNotMatch(qualified, /instrument:v1:/,
    "neither form may ever print a canonical id — contract §5");

  // And back, because a setting that only goes one way is half a setting.
  await chooseInDropdown("Title form", "Name");
  assert.match(legendText(chart), /Solana \/ TetherUS/);
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

  await openSettings(chart, "Scales and lines");
  await chooseInDropdown("Scale mode buttons", "Always visible");
  assert.equal(strip()?.getAttribute("data-axis-buttons"), "always");
  assert.doesNotMatch(strip()!.className, /opacity-0/,
    "Always visible must actually leave them lit, not merely record a preference");

  await chooseInDropdown("Scale mode buttons", "Hidden");
  assert.equal(strip(), null, "Hidden takes the four controls off the chart");

  /*
   * The mode badge is NOT one of the four. An axis in percent or log that does
   * not say so is a chart lying about the moves on it, so it survives Hidden.
   */
  assert.ok(chart.pane(0).querySelector('[role="group"][aria-label^="Price scale"]'),
    "the price-scale group, and with it the mode badge, stays");
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
