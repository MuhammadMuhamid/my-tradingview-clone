/**
 * The Canvas and Time-scale rows, read off a STUDY PANE's own chart.
 *
 * ── What R6b measured, and why this file exists ────────────────────────────
 *
 * Six chart-settings rows moved the price pane and left every study pane
 * untouched, and three time-scale rows moved nothing a user could see at all:
 *
 *   `Background colour #2a2e39`  price pane 470,512 px · RSI/MACD 27/68 (noise)
 *   `Text` colour                panes 0 px
 *   `Lines` colour               panes noise
 *   `Vertical/Horizontal grid`   the study panes drew no grid at all
 *   `Crosshair` off              the synced vertical line stayed drawn in them
 *   `Day of week` off            the time axis did not change, anywhere
 *   `Date format` / `12-hours`   no change on the ONE visible axis with a pane
 *
 * The last four are one bug: `tickMarkFormatter: undefined` and
 * `timeFormatter: undefined` were how "off" was expressed, and
 * lightweight-charts merges options with a spread — a key whose value is
 * `undefined` overwrites nothing, so the ON formatter was never uninstalled.
 *
 * ── Why this drives `IndicatorPane` directly ───────────────────────────────
 *
 * The assertion has to be the study chart's OWN options, and a real
 * lightweight-charts chart is only reachable through the `onReady` callback
 * the component already hands its owner. Nothing is mocked: this is the real
 * component, the real library and the real options object, driven through the
 * props `CandleChart` passes it. `tests/chartSettings.test.ts` pins that
 * `CandleChart` passes them; this pins that the pane honours them.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { IChartApi } from "lightweight-charts";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { IndicatorPane } from "@/components/tv/IndicatorPane";
import type { ChartOverlay } from "@/lib/chartSeries";

beforeEach(resetBrowser);
after(closeBrowser);

/** One plot, so the pane has a series and a real axis. */
const overlay: ChartOverlay = {
  id: "rsi:0",
  title: "RSI",
  color: "#7e57c2",
  data: [
    { time: 1_788_144_000, value: 44 },
    { time: 1_788_147_600, value: 51 },
    { time: 1_788_151_200, value: 48 },
  ],
} as unknown as ChartOverlay;

/** Mount the pane and hand back the chart it created. */
async function mountPane(
  props: Partial<React.ComponentProps<typeof IndicatorPane>> = {},
): Promise<IChartApi> {
  let chart: IChartApi | null = null;
  render(
    <IndicatorPane
      id="rsi"
      title="RSI"
      params="Length 14"
      overlays={[overlay]}
      decorations={[]}
      hoverTime={null}
      onHover={() => {}}
      onReady={(_id, api) => { if (api) chart = api; }}
      onRangeChange={() => {}}
      {...props}
    />);
  await settle();
  assert.ok(chart, "the pane never reported a chart");
  return chart as unknown as IChartApi;
}

test("R6b-13 — `Day of week` OFF installs a formatter, never `undefined`", async () => {
  const on = await mountPane({ dayOfWeekOnLabels: true });
  const onFormatter = (on.options().timeScale as { tickMarkFormatter?: unknown }).tickMarkFormatter;
  assert.equal(typeof onFormatter, "function");
  assert.equal(
    (onFormatter as (t: number, k: number) => string | null)(1_788_144_000, 2),
    "Mon 31",
    "ON writes the weekday before the day of the month");

  resetBrowser();
  const off = await mountPane({ dayOfWeekOnLabels: false });
  const offFormatter = (off.options().timeScale as { tickMarkFormatter?: unknown }).tickMarkFormatter;
  /*
   * The whole defect in one assertion: `undefined` here is not "off", it is
   * "leave whatever is installed alone", and the default being ON meant the
   * row could only ever be inert.
   */
  assert.equal(typeof offFormatter, "function",
    "OFF must be a FUNCTION — the library's option merge ignores `undefined`");
  assert.equal(
    (offFormatter as (t: number, k: number) => string | null)(1_788_144_000, 2),
    null,
    "and it must return null, which is the library's own `you format it`");
});

test("R6b-14 — the pane's axis takes the date and hour formats", async () => {
  const pane = await mountPane({ timeFormat24h: false, dateFormat: "yyyy-MM-dd" });
  const options = pane.options();
  assert.equal(options.localization.dateFormat, "yyyy-MM-dd",
    "the visible axis is drawn by the LOWEST pane, so the date format has to reach it");
  const formatter = options.localization.timeFormatter;
  assert.equal(typeof formatter, "function");
  // 2026-08-31 15:00 UTC.
  assert.equal((formatter as (t: number) => string)(1_788_188_400), "3:00 pm");

  resetBrowser();
  const back = await mountPane({ timeFormat24h: true });
  const twentyFour = back.options().localization.timeFormatter;
  assert.equal(typeof twentyFour, "function",
    "24-hours must be a function too, or the row moves once and never back");
  assert.equal((twentyFour as (t: number) => string)(1_788_188_400), "15:00");
});

test("R6b-19 — the Canvas tab reaches the study pane's ground, grid, axes and crosshair", async () => {
  const pane = await mountPane({
    backgroundColor: "#2a2e39",
    gridVertical: false,
    gridHorizontal: true,
    gridHorzColor: "#333333",
    scaleTextColor: "#ffeb3b",
    scaleLineColor: "#ffeb3b",
    showCrosshair: false,
  });
  const options = pane.options();
  assert.equal((options.layout.background as { color?: string }).color, "#2a2e39",
    "`Background colour` moved 470,512 px of the price pane and 27 of the RSI pane");
  assert.equal(options.grid.vertLines.visible, false);
  assert.equal(options.grid.horzLines.visible, true);
  assert.equal(options.grid.horzLines.color, "#333333",
    "the study panes drew no grid at all; the reference's oscillator pane carries one");
  assert.equal(options.layout.textColor, "#ffeb3b", "`Text` colour measured 0 px on the panes");
  assert.equal(options.rightPriceScale.borderColor, "#ffeb3b");
  assert.equal(options.timeScale.borderColor, "#ffeb3b");
  /*
   * `CrosshairMode.Hidden` is 2 in lightweight-charts 4.2. The enum is
   * compared by value rather than imported so this asserts the OPTION the
   * chart is actually holding.
   */
  assert.equal(options.crosshair.mode, 2, "`Crosshair` off must reach every pane");
});

test("R6b-18 — a gradient on the theme's own colours is a visible gradient", async () => {
  const pane = await mountPane({ backgroundGradient: true });
  const background = pane.options().layout.background as
    { topColor?: string; bottomColor?: string };
  assert.ok(background.topColor && background.bottomColor,
    "Gradient must resolve two ends, not one colour over transparent");
  assert.notEqual(background.topColor, background.bottomColor,
    "6% of accent blue over transparent measured three points of luminance — "
    + "a dropdown option that moved nothing");
});
