/**
 * The chart-core interaction layer: price scale, crosshair, visible range,
 * range shortcuts and the indicator pane stack.
 *
 * ── What is and is not asserted here ───────────────────────────────────────
 *
 * There is no DOM in this runner and no chart, so nothing below claims to have
 * observed a rendered pixel. What each test proves is one of two things:
 *
 *   a decision, taken by a pure function that the renderer calls — which mode
 *   the scale is in, which ranges may be offered, which bar a crosshair time
 *   resolves to, what the legend is reading;
 *
 *   a wiring fact, read out of the source — that the renderer calls that
 *   function, in that place, with the library API it claims to be using.
 *
 * The second kind is deliberately narrow. A source scan cannot prove a chart
 * behaves; it can prove that the one line which would silently undo a decision
 * is not there, which is what most of these regressions actually were.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PriceScaleMode } from "lightweight-charts";
import {
  DEFAULT_PRICE_SCALE, isDefaultPriceScale, isPriceScaleMode, normalizePriceScale,
  PRICE_SCALE_MODES, priceScaleAfterManualScale, priceScaleLabel, resetPriceScale,
  scaleShowsPrices, setPriceScaleAuto, setPriceScaleMode, togglePercentScale,
  togglePriceScaleAuto, togglePriceScaleInvert, togglePriceScaleMode,
} from "../lib/priceScale";
import {
  availableRangeShortcuts, loadedWindow, MIN_BARS_IN_RANGE, RANGE_SHORTCUTS,
  rangeShortcut, rangeShortcutAvailable, resolveRangeShortcut, sameViewport, startOfYearSec,
  type LoadedWindow, type RangeShortcutId,
} from "../lib/rangeShortcuts";
import {
  canMovePane, clampPaneHeight, COLLAPSED_PANE_HEIGHT, EMPTY_PANE_LAYOUT,
  isPaneCollapsed, isPaneMaximized, MAX_PANE_HEIGHT, MIN_PANE_HEIGHT, movePane,
  orderedPanes, paneHeight, reconcilePaneLayout, restorePaneLayout, setPaneHeight,
  togglePaneCollapsed, togglePaneMaximized, type PaneLayoutState,
} from "../lib/indicatorPaneLayout";
import { createDisposalGuard, setChartMeasuring } from "../lib/chartLifecycle";
import { rangeChanged, RANGE_EPSILON_SEC, snapToBarIndexBy } from "../lib/paneSync";
import {
  canonicalOpenTime, isRenkoBrick, renkoBricks, transformAll,
  type OhlcBar, type RenkoBrick,
} from "../lib/chartTransforms";
import { legendSource, timeAnchoredVisualsTruthful, RENKO_ALIGNMENT_NOTE } from "../lib/chartType";
import { fmtChartBarTime, fmtChartClock, fmtChartDate, CHART_TIME_ZONE } from "../lib/chartClock";
import { replayCandles, startReplay, type ReplaySession } from "../lib/replay";
import { INTERVAL_MS, type Candle, type Interval } from "../lib/types";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const CHART = read("components/CandleChart.tsx");
const PANE = read("components/tv/IndicatorPane.tsx");

/** Prose about a call is not a call: several checks below are about code. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

const HOUR = 3_600_000;

/**
 * A fixed date well inside a year, so "year to date" is a real span rather
 * than an artefact of history that happens to start at the epoch.
 */
const START = Date.UTC(2026, 2, 1);

/** `count` hourly candles from `startMs`, walking up by one. */
function candles(count: number, startMs = START, stepMs = HOUR): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: "SOLUSDT", interval: "1h" as Interval,
    openTime: startMs + i * stepMs,
    closeTime: startMs + i * stepMs + stepMs - 1,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10 + i,
  }));
}

// ══ 1–5  PRICE SCALE ═══════════════════════════════════════════════════════

test("PRICE SCALE — the default is linear, auto-fitting and the right way up", () => {
  assert.deepEqual(DEFAULT_PRICE_SCALE, { mode: "normal", autoScale: true, invert: false });
  assert.ok(isDefaultPriceScale(DEFAULT_PRICE_SCALE));
  assert.equal(priceScaleLabel(DEFAULT_PRICE_SCALE), "Linear · Auto");
});

test("PRICE SCALE — four modes, and each is one the library implements", () => {
  /*
   * Percentage and indexed-to-100 were deliberately withheld until something
   * asked for them. Comparison did: a pair, a benchmark overlay and a ratio
   * pane are all questions about relative movement, and on a currency axis the
   * answer to each is dominated by whichever instrument has the larger number.
   */
  assert.deepEqual(PRICE_SCALE_MODES.map((m) => m.value),
    ["normal", "logarithmic", "percentage", "indexedTo100"]);
  for (const mode of PRICE_SCALE_MODES) assert.ok(isPriceScaleMode(mode.value));
  assert.equal(isPriceScaleMode("nonsense"), false);
  // Every mode reads differently on the control and in the label.
  assert.equal(new Set(PRICE_SCALE_MODES.map((m) => m.short)).size, PRICE_SCALE_MODES.length);
  assert.equal(new Set(PRICE_SCALE_MODES.map((m) => m.label)).size, PRICE_SCALE_MODES.length);
});

test("PRICE SCALE — every mode maps onto the library's own enum, exhaustively", () => {
  // The chart must use the library's modes, not a lookalike of its own — and
  // the mapping must be a total record, so a mode added to `lib/priceScale`
  // fails the build rather than silently drawing a linear axis.
  assert.equal(PriceScaleMode.Normal, 0);
  assert.equal(PriceScaleMode.Logarithmic, 1);
  assert.equal(PriceScaleMode.Percentage, 2);
  assert.equal(PriceScaleMode.IndexedTo100, 3);
  assert.match(CHART, /const LIBRARY_SCALE_MODE: Record<PriceScaleState\["mode"\], PriceScaleMode>/);
  assert.match(CHART, /mode: LIBRARY_SCALE_MODE\[scale\.mode\]/);
  for (const mode of PRICE_SCALE_MODES) {
    assert.match(CHART, new RegExp(`\\b${mode.value}: PriceScaleMode\\.`),
      `${mode.value} has no entry in the chart's mapping`);
  }
});

test("PRICE SCALE — switching mapping leaves auto-fit alone, and vice versa", () => {
  const log = togglePriceScaleMode(DEFAULT_PRICE_SCALE);
  assert.deepEqual(log, { mode: "logarithmic", autoScale: true, invert: false });
  const manual = togglePriceScaleAuto(log);
  assert.deepEqual(manual, { mode: "logarithmic", autoScale: false, invert: false });
  // …and back, without either having disturbed the other on the way.
  assert.deepEqual(togglePriceScaleMode(manual),
    { mode: "normal", autoScale: false, invert: false });
});

test("PRICE SCALE — percent and log are alternatives to linear, not to each other", () => {
  /*
   * Two independent questions — how the axis is SPACED, and what it MEANS —
   * so each toggle returns to linear rather than cycling through the other.
   * A single stepping control would make choosing percent mean passing
   * through log.
   */
  const percent = togglePercentScale(DEFAULT_PRICE_SCALE);
  assert.equal(percent.mode, "percentage");
  assert.equal(togglePercentScale(percent).mode, "normal");
  assert.equal(togglePriceScaleMode(percent).mode, "logarithmic");
  assert.equal(togglePercentScale(togglePriceScaleMode(DEFAULT_PRICE_SCALE)).mode, "percentage");
});

test("PRICE SCALE — an inverted axis says so, and is not the default", () => {
  const inverted = togglePriceScaleInvert(DEFAULT_PRICE_SCALE);
  assert.equal(inverted.invert, true);
  assert.equal(isDefaultPriceScale(inverted), false);
  assert.match(priceScaleLabel(inverted), /Inverted/);
  assert.equal(togglePriceScaleInvert(inverted).invert, false);
  assert.match(CHART, /invertScale: scale\.invert === true/);
});

test("PRICE SCALE — only the axis reads in prices under two of the four modes", () => {
  assert.ok(scaleShowsPrices({ mode: "normal", autoScale: true }));
  assert.ok(scaleShowsPrices({ mode: "logarithmic", autoScale: true }));
  assert.equal(scaleShowsPrices({ mode: "percentage", autoScale: true }), false);
  assert.equal(scaleShowsPrices({ mode: "indexedTo100", autoScale: true }), false);
});

test("PRICE SCALE — a stored scale is coerced, never trusted", () => {
  assert.deepEqual(normalizePriceScale(undefined), DEFAULT_PRICE_SCALE);
  assert.deepEqual(normalizePriceScale("log"), DEFAULT_PRICE_SCALE);
  assert.deepEqual(
    normalizePriceScale({ mode: "sideways", autoScale: "yes", invert: 1 }),
    DEFAULT_PRICE_SCALE);
  assert.deepEqual(
    normalizePriceScale({ mode: "percentage", autoScale: false, invert: true }),
    { mode: "percentage", autoScale: false, invert: true });
});

test("PRICE SCALE — an unchanged set returns the identical object", () => {
  // Identity is what keeps the applying effect from re-running, which is what
  // keeps a re-render from re-fitting a scale the user has dragged.
  const state = DEFAULT_PRICE_SCALE;
  assert.equal(setPriceScaleMode(state, "normal"), state);
  assert.equal(setPriceScaleAuto(state, true), state);
});

test("PRICE SCALE — reset restores the default as a fresh object", () => {
  const reset = resetPriceScale();
  assert.deepEqual(reset, DEFAULT_PRICE_SCALE);
  assert.notEqual(reset, DEFAULT_PRICE_SCALE, "must not hand out the shared constant");
});

test("PRICE SCALE — a manual axis drag is recorded as manual", () => {
  const dragged = priceScaleAfterManualScale(DEFAULT_PRICE_SCALE);
  assert.equal(dragged.autoScale, false);
  assert.equal(priceScaleLabel(dragged), "Linear · Manual");
  assert.equal(isDefaultPriceScale(dragged), false);
});

test("PRICE SCALE — the mode is always identifiable", () => {
  const seen = new Set<string>();
  for (const mode of PRICE_SCALE_MODES) {
    for (const autoScale of [true, false]) {
      for (const invert of [true, false]) {
        seen.add(priceScaleLabel({ mode: mode.value, autoScale, invert }));
      }
    }
  }
  assert.equal(seen.size, PRICE_SCALE_MODES.length * 4,
    "every combination must read differently");
});

test("PRICE SCALE — it is per pane, persisted, and a candle update cannot reset it", () => {
  // A chart with no owner above it still holds its own.
  assert.match(CHART, /useState<PriceScaleState>\(DEFAULT_PRICE_SCALE\)/);
  /*
   * And the workspace now carries it, which it deliberately did not: the scale
   * lived beside the workspace, so a chart put on a logarithmic axis came back
   * linear after a reload and a saved layout did not carry the way its axis
   * was read. Per pane and never synced across panes, exactly like `compare`.
   */
  const workspace = read("lib/workspace.ts");
  assert.match(workspace, /priceScale\?: PriceScaleState/);
  assert.match(workspace, /export function setPanePriceScale/);
  assert.equal(
    /syncTargets\([^)]*priceScale/.test(workspace), false,
    "a price scale is a statement about ONE chart and must never be synced"
  );
  // The applying effect is keyed on the scale and on chart/series recreation —
  // NOT on `candles`, so a tick cannot re-apply (or reset) anything.
  const effect = CHART.slice(CHART.indexOf("chart.priceScale(\"right\").applyOptions"));
  const deps = effect.slice(0, effect.indexOf("]);") + 3);
  assert.ok(deps.includes("}, [scale, chartReady]);"), deps.slice(-120));
  assert.equal(deps.includes("candles"), false, "the scale must not depend on the data");
});

test("PRICE SCALE — drag and double-click reset are the library's, not ours", () => {
  // lightweight-charts enables `handleScale.axisPressedMouseMove.price` and
  // `axisDoubleClickReset.price` by default. Nothing may turn them off, and
  // nothing may reimplement them.
  const theme = code(read("lib/chartTheme.ts"));
  assert.equal(theme.includes("handleScale"), false);
  assert.equal(theme.includes("axisPressedMouseMove"), false);
  assert.equal(code(CHART).includes("handleScale"), false);
  // The chart reads the library's own autoScale back instead of guessing.
  assert.match(CHART, /chart\.priceScale\("right"\)\.options\(\)\.autoScale/);
});

test("PRICE SCALE — changing the mode does not destroy the chart", () => {
  // `createChart` is called in exactly one effect, and that effect has no
  // dependencies at all — so no scale, type or data change can recreate it.
  assert.equal((CHART.match(/createChart\(/g) ?? []).length, 1);
  const created = CHART.slice(CHART.indexOf("const chart = createChart("));
  assert.ok(created.slice(0, created.indexOf("}, []);") + 7).trimEnd().endsWith("}, []);"),
    "the chart-creating effect gained a dependency");
});

// ══ 6–11  CROSSHAIR ════════════════════════════════════════════════════════

test("CROSSHAIR — price and time come from the library's own labels", () => {
  // The crosshair labels on both axes are drawn by lightweight-charts. Nothing
  // here may paint a second set over them; the only thing this chart adds is
  // the OHLC legend, which is a different statement in a different place.
  const theme = read("lib/chartTheme.ts");
  assert.match(theme, /crosshair:/);
  assert.equal(theme.includes("labelVisible: false"), false);
  assert.equal(CHART.includes("crosshairLabel"), false);
});

test("CROSSHAIR — the time axis is drawn once, wherever the stack ends", () => {
  // Under the lowest pane that is actually showing a plot — and back on the
  // price chart when every pane is collapsed and none of them can carry it.
  assert.match(CHART, /timeScale\(\)\.applyOptions\(\{ visible: axisPaneId === null \}\)/);
  assert.match(CHART, /showTimeAxis=\{pane\.id === axisPaneId\}/);
  assert.match(CHART, /\[\.\.\.stackPanes\]\.reverse\(\)\.find\(\(pane\) => !paneCollapsed\(pane\.id\)\)/);
  assert.match(PANE, /timeScale\(\)\.applyOptions\(\{ visible: showTimeAxis \}\)/);
});

test("CROSSHAIR — arbitrary panes mirror, and a source never sees itself", () => {
  // Wave 1's rule, re-checked because this wave rewrote what is published.
  const times = candles(48).map((c) => c.openTime / 1000);
  for (let i = 0; i < times.length; i++) {
    assert.equal(snapToBarIndexBy(times, times[i]!, (t) => t), i);
  }
  // 14:07 on a fine chart lands on the 14:00 bar of a coarse one.
  assert.equal(snapToBarIndexBy(times, times[9]! + 420, (t) => t), 9);
});

test("CROSSHAIR — a pane with no bar at that moment draws nothing", () => {
  const times = candles(10, 10 * HOUR).map((c) => c.openTime / 1000);
  assert.equal(snapToBarIndexBy(times, 0, (t) => t), -1, "no clamp to bar zero");
});

test("CROSSHAIR — nothing is published after the chart is disposed", () => {
  const guard = createDisposalGuard();
  let calls = 0;
  const emit = (): number => ++calls;
  guard.run(emit);
  assert.equal(calls, 1);
  guard.dispose();
  assert.equal(guard.run(emit), undefined);
  assert.equal(calls, 1, "a disposed guard must not run anything");
  assert.ok(guard.disposed);

  // …and the chart actually installs one on every subscription it owns.
  for (const handler of ["subscribeCrosshairMove", "subscribeVisibleTimeRangeChange"]) {
    const at = CHART.indexOf(handler);
    assert.ok(at > 0, `${handler} is missing`);
    assert.ok(
      CHART.slice(at, at + 400).includes("if (guard.disposed) return;"),
      `${handler} must bail out once the chart has gone`
    );
  }
  assert.match(CHART, /guard\.dispose\(\);/);
  assert.match(PANE, /guard\.dispose\(\);/);
});

test("CROSSHAIR — pending release timers are cancelled with the chart", () => {
  // A `setTimeout` that clears the "applying a range" flag must not outlive
  // the pane: it would clear a flag belonging to a chart that no longer exists.
  assert.match(CHART, /for \(const timer of rangeReleaseRef\.current\) window\.clearTimeout\(timer\);/);
});

test("RENKO — a brick's display time never leaves the chart as a market time", () => {
  /*
   * Forty quiet bars set a small ATR, then one bar leaps twenty of them: that
   * single canonical bar completes a run of bricks, which is exactly the case
   * where a brick's own time stops being its source bar's time.
   */
  const source: OhlcBar[] = candles(60).map((c, i) => {
    const close = i === 45 ? 220 : 100 + (i % 3);
    return {
      openTime: c.openTime,
      open: 100, high: Math.max(102, close), low: Math.min(99, close), close,
    };
  });
  const bricks = renkoBricks(source, { atrPeriod: 14 });
  assert.ok(bricks.length > 3, "the fixture must actually produce bricks");

  // Several bricks from one bar share a source time and are stepped forward a
  // second each — so their own `openTime` is NOT a bar time on any chart.
  const stepped = bricks.filter((b) => b.openTime !== b.sourceOpenTime);
  assert.ok(stepped.length > 0, "the fixture must contain a multi-brick bar");
  for (const brick of bricks) {
    assert.equal(canonicalOpenTime(brick), brick.sourceOpenTime);
    assert.ok(isRenkoBrick(brick));
    // Every canonical time a brick reports is a real source bar's open time.
    assert.ok(source.some((bar) => bar.openTime === brick.sourceOpenTime));
  }
  // A plain candle and a Heikin-Ashi bar are their own canonical time.
  assert.equal(canonicalOpenTime(source[3]!), source[3]!.openTime);
  const ha = transformAll("heikinAshi", source).output;
  assert.equal(ha.length, source.length);
  ha.forEach((bar, i) => {
    assert.equal(isRenkoBrick(bar), false);
    assert.equal(canonicalOpenTime(bar), source[i]!.openTime);
  });

  // The renderer publishes the canonical time, not the brick position.
  const at = CHART.indexOf("chart.subscribeCrosshairMove");
  const body = CHART.slice(at, CHART.indexOf("chart.timeScale().subscribeVisibleTimeRangeChange"));
  assert.match(body, /canonical = brick \? Math\.floor\(canonicalOpenTime\(brick\) \/ 1000\) : null/);
  assert.match(body, /publish\(canonical\)/);
});

test("RENKO — an incoming canonical time is mapped through the brick's source", () => {
  const source: OhlcBar[] = candles(120).map((c, i) => ({
    openTime: c.openTime,
    open: 100 + i, high: 102 + i, low: 98 + i, close: 100 + i * 2,
  }));
  const bricks: RenkoBrick[] = renkoBricks(source, { atrPeriod: 14 });
  const probe = bricks[Math.floor(bricks.length / 2)]!.sourceOpenTime;
  const index = snapToBarIndexBy(
    bricks, Math.floor(probe / 1000), (b) => Math.floor(canonicalOpenTime(b) / 1000));
  assert.ok(index >= 0);
  assert.equal(bricks[index]!.sourceOpenTime, probe);
  // The LAST brick that bar completed, so a bar that made three lights the third.
  assert.ok(
    index + 1 >= bricks.length || bricks[index + 1]!.sourceOpenTime > probe,
    "the mapping must land on the last brick of that canonical bar"
  );
  // A moment before any brick exists draws nothing rather than guessing one.
  assert.equal(snapToBarIndexBy(
    bricks, 0, (b) => Math.floor(canonicalOpenTime(b) / 1000)), -1);

  assert.match(CHART, /snapToBarIndexBy\(\s*display, crosshairTime, \(bar\) => Math\.floor\(canonicalOpenTime\(bar\) \/ 1000\)\)/);
});

// ══ 12–16  VISIBLE RANGE ═══════════════════════════════════════════════════

test("RANGE — an unchanged span is not republished", () => {
  assert.ok(rangeChanged(null, { from: 1, to: 2 }), "the first span always publishes");
  assert.equal(rangeChanged({ from: 100, to: 200 }, { from: 100, to: 200 }), false);
  // Float noise from the library's own coordinate round-trip is not a change…
  assert.equal(
    rangeChanged({ from: 100, to: 200 }, { from: 100.2, to: 199.8 }), false);
  // …but a real pan is.
  assert.ok(rangeChanged({ from: 100, to: 200 }, { from: 101, to: 201 }));
  assert.equal(RANGE_EPSILON_SEC, 0.5);
});

test("RANGE — the publisher and the loop-breakers are actually wired in", () => {
  assert.match(CHART, /const publishRange = useCallback\(/);
  assert.match(CHART, /if \(!rangeChanged\(publishedRangeRef\.current, range\)\) return;/);
  // A range this pane applied itself is never re-emitted.
  assert.match(CHART, /if \(applyingRangeRef\.current \|\| syncingPaneRangeRef\.current \|\| !range\) return;/);
});

test("RANGE — an unmounted pane stops receiving and stops emitting", () => {
  // Wave 1 unmounts hidden panes rather than hiding them, and this wave adds
  // the guard that stops anything in flight from landing after that.
  assert.match(read("components/tv/ChartWorkspace.tsx"), /renderPane\(maximized, \{ maximized: true \}\)/);
  assert.match(PANE, /onReady\(id, null\);/);
  const cleanup = PANE.slice(PANE.indexOf("      guard.dispose();"));
  assert.ok(cleanup.includes("chart.unsubscribeCrosshairMove(crosshair);"));
  assert.ok(cleanup.includes("chart.timeScale().unsubscribeVisibleTimeRangeChange(range);"));
});

test("RANGE — a pane holding no points moves nobody", () => {
  // The empty-series range lightweight-charts emits on creation must not be
  // broadcast; Wave 1 fixed it and this wave must not have undone it.
  assert.match(PANE, /if \(!hasPoints\) return;/);
});

// ══ 17–20  RANGE SHORTCUTS ═════════════════════════════════════════════════

const window1h = (bars: number): LoadedWindow => {
  const list = candles(bars);
  const w = loadedWindow(list, INTERVAL_MS["1h"]);
  assert.ok(w);
  return w;
};

test("SHORTCUTS — a range is a viewport, never a timeframe", () => {
  for (const shortcut of RANGE_SHORTCUTS) {
    assert.equal("interval" in shortcut, false);
    assert.equal("intervalMs" in shortcut, false);
  }
  const resolved = resolveRangeShortcut("1D", window1h(24 * 40));
  assert.ok(resolved);
  assert.deepEqual(Object.keys(resolved).sort(), ["from", "to"]);
});

test("SHORTCUTS — only ranges the loaded history can fill are offered", () => {
  // Forty days of hourly bars: everything up to 1M, nothing beyond it — and
  // not the two months of year-to-date this window does not reach back to.
  const offered = availableRangeShortcuts(window1h(24 * 40)).map((s) => s.id);
  assert.deepEqual(offered, ["1D", "5D", "1M", "ALL"]);

  // Two days of hourly bars cannot honour 5D, and says so.
  assert.deepEqual(
    availableRangeShortcuts(window1h(48)).map((s) => s.id), ["1D", "ALL"]);

  // A day and a half of one-minute bars: 1D fits, 5D does not exist here.
  const minute = loadedWindow(candles(2000, START, 60_000), INTERVAL_MS["1m"])!;
  assert.deepEqual(availableRangeShortcuts(minute).map((s) => s.id), ["1D", "ALL"]);
});

test("SHORTCUTS — a range too coarse for the timeframe is not offered", () => {
  // Three years of DAILY bars can reach back a day, but one day is one bar.
  const daily = loadedWindow(candles(1100, START, 24 * HOUR), INTERVAL_MS["1d"])!;
  const offered = availableRangeShortcuts(daily).map((s) => s.id);
  assert.equal(offered.includes("1D"), false, "one bar is not a range");
  assert.equal(rangeShortcutAvailable(rangeShortcut("1D")!, daily), false);
  // Five daily bars is thin but readable, and is what "the last five days"
  // honestly means on this timeframe.
  assert.ok(offered.includes("5D"));
  assert.ok(offered.includes("1M"), "thirty daily bars is a readable month");
  assert.ok(offered.includes("1Y"));
  assert.equal(MIN_BARS_IN_RANGE, 4);

  // A four-hour chart cannot resolve one day into fewer than four bars, and
  // that is the boundary: six bars a day passes, one day of daily does not.
  const h4 = loadedWindow(candles(400, START, 4 * HOUR), INTERVAL_MS["4h"])!;
  assert.ok(availableRangeShortcuts(h4).map((s) => s.id).includes("1D"));
});

test("SHORTCUTS — every offered range resolves inside the loaded window", () => {
  const w = window1h(24 * 400);
  for (const shortcut of availableRangeShortcuts(w)) {
    const resolved = resolveRangeShortcut(shortcut.id, w);
    assert.ok(resolved, `${shortcut.id} is offered and must resolve`);
    assert.ok(resolved.from >= w.firstOpenSec, `${shortcut.id} starts before the data`);
    assert.equal(resolved.to, w.lastOpenSec, `${shortcut.id} must end at the newest bar`);
    assert.ok(resolved.from < resolved.to);
  }
  // A range that is not offered is not resolvable either.
  assert.equal(resolveRangeShortcut("1Y", window1h(48)), null);
});

test("SHORTCUTS — spans are the ones the labels claim", () => {
  const w = window1h(24 * 400);
  const span = (id: RangeShortcutId): number => {
    const r = resolveRangeShortcut(id, w)!;
    return (r.to - r.from) / 86_400;
  };
  assert.equal(span("1D"), 1);
  assert.equal(span("5D"), 5);
  assert.equal(span("1M"), 30);
  assert.equal(span("3M"), 90);
  assert.equal(span("6M"), 180);
  assert.equal(span("1Y"), 365);
  assert.equal(resolveRangeShortcut("ALL", w)!.from, w.firstOpenSec);
});

test("SHORTCUTS — YTD starts at the UTC new year", () => {
  const march = Date.UTC(2026, 2, 15, 9, 30) / 1000;
  assert.equal(startOfYearSec(march), Date.UTC(2026, 0, 1) / 1000);
  const w: LoadedWindow = {
    firstOpenSec: Date.UTC(2024, 0, 1) / 1000,
    lastOpenSec: march,
    intervalMs: INTERVAL_MS["1h"],
  };
  assert.deepEqual(resolveRangeShortcut("YTD", w), {
    from: Date.UTC(2026, 0, 1) / 1000, to: march,
  });
  // History that starts after the new year clamps to the data it has.
  const short: LoadedWindow = { ...w, firstOpenSec: Date.UTC(2026, 1, 1) / 1000 };
  assert.equal(
    availableRangeShortcuts(short).some((s) => s.id === "YTD"), false,
    "a window shorter than the year to date must not offer YTD"
  );
});

test("SHORTCUTS — the replay horizon is the newest bar a shortcut can reach", () => {
  const all = candles(24 * 60);
  const session = startReplay(all, all[600]!.closeTime, all[all.length - 1]!.closeTime + 1);
  assert.ok(session);
  const visible = replayCandles(all, session);
  assert.equal(visible.length, 601);

  // The window is built from what the pane DRAWS, which replay has clipped.
  const w = loadedWindow(visible, INTERVAL_MS["1h"])!;
  assert.equal(w.lastOpenSec, visible[visible.length - 1]!.openTime / 1000);
  for (const shortcut of availableRangeShortcuts(w)) {
    const resolved = resolveRangeShortcut(shortcut.id, w)!;
    assert.ok(
      resolved.to <= session.horizonCloseTime / 1000,
      `${shortcut.id} must not reach past the replay horizon`
    );
    assert.ok(resolved.to < all[all.length - 1]!.openTime / 1000, "no future bar");
  }
  // Nothing in the module consults a clock, which is why the above holds.
  assert.equal(code(read("lib/rangeShortcuts.ts")).includes("Date.now("), false);

  // …and the chart builds the window from the candles it was handed.
  assert.match(CHART, /loadedWindow\(candles, resolutionMs\(interval\)\)/);
});

test("SHORTCUTS — the library's snap-to-bars does not un-press the button", () => {
  // `setVisibleRange` is a request: the library lands on whole bars near it.
  // A viewport that is still substantially the requested one keeps the badge.
  const target = { from: 1_000_000, to: 1_086_400 };
  assert.ok(sameViewport(target, target));
  assert.ok(sameViewport(target, { from: 1_000_900, to: 1_086_000 }), "snapped, not panned");
  assert.equal(sameViewport(target, { from: 1_040_000, to: 1_126_400 }), false, "panned");
  assert.equal(sameViewport(null, target), false);
  assert.equal(sameViewport({ from: 5, to: 5 }, { from: 5, to: 5 }), false);
  // Proportional, so the same relative error reads the same on any span.
  const year = { from: 0, to: 365 * 86_400 };
  assert.ok(sameViewport(year, { from: 86_400, to: 365 * 86_400 }));
  assert.equal(sameViewport({ from: 0, to: 86_400 }, { from: 86_400, to: 86_400 }), false);
});

test("SHORTCUTS — the price scale stays available where the ranges cannot", () => {
  // Renko has no time axis, so it has no ranges — but it has prices, so the
  // scale controls remain. The two are gated separately and deliberately.
  assert.match(CHART, /const showRanges = timeAnchored && shortcuts\.length > 0;/);
  assert.match(CHART, /const showBottomBar = !compact;/);
  assert.match(CHART, /\{showRanges && \(\s*\n\s*<div role="group" aria-label="Visible range"/);
});

test("SHORTCUTS — a degenerate window offers nothing at all", () => {
  assert.equal(loadedWindow([], INTERVAL_MS["1h"]), null);
  assert.equal(loadedWindow(candles(1), INTERVAL_MS["1h"]), null);
  assert.deepEqual(availableRangeShortcuts(
    { firstOpenSec: 10, lastOpenSec: 10, intervalMs: INTERVAL_MS["1h"] }), []);
});

test("SHORTCUTS — the bar acts on its own pane and cooperates with range sync", () => {
  // The button sets this pane's visible range; the library's own change event
  // then carries it into the workspace signal like any pan or zoom would.
  assert.match(CHART, /const applyRangeShortcut = useCallback\(/);
  assert.match(CHART, /chart\.timeScale\(\)\.setVisibleRange\(\{\s*from: resolved\.from as UTCTimestamp, to: resolved\.to as UTCTimestamp,/);
  // It never touches the interval.
  const fn = CHART.slice(CHART.indexOf("const applyRangeShortcut"));
  assert.equal(fn.slice(0, fn.indexOf("}, [window_]);")).includes("interval"), false);
});

// ══ 21–25  INDICATOR PANE ══════════════════════════════════════════════════

const layoutOf = (ids: string[]): PaneLayoutState =>
  reconcilePaneLayout(EMPTY_PANE_LAYOUT, ids);
const panes = (ids: string[]) => ids.map((id) => ({ id }));

test("PANES — the stack learns the panes it is given, in order", () => {
  const state = layoutOf(["rsi", "macd", "atr"]);
  assert.deepEqual(state.order, ["rsi", "macd", "atr"]);
  // A study added later lands at the bottom, where the user just put it.
  const grown = reconcilePaneLayout(state, ["rsi", "macd", "atr", "adx"]);
  assert.deepEqual(grown.order, ["rsi", "macd", "atr", "adx"]);
  // Nothing changed → the same object, so this cannot loop a React effect.
  assert.equal(reconcilePaneLayout(grown, ["rsi", "macd", "atr", "adx"]), grown);
});

test("PANES — collapse and expand", () => {
  let state = layoutOf(["rsi", "macd"]);
  assert.equal(isPaneCollapsed(state, "rsi"), false);
  state = togglePaneCollapsed(state, "rsi");
  assert.ok(isPaneCollapsed(state, "rsi"));
  assert.equal(paneHeight(state, "rsi", 120), COLLAPSED_PANE_HEIGHT);
  // Its neighbour is untouched.
  assert.equal(isPaneCollapsed(state, "macd"), false);
  assert.equal(paneHeight(state, "macd", 120), 120);
  state = togglePaneCollapsed(state, "rsi");
  assert.equal(isPaneCollapsed(state, "rsi"), false);
  assert.equal(paneHeight(state, "rsi", 120), 120);
});

test("PANES — removing a study takes only its own layout with it", () => {
  let state = layoutOf(["rsi", "macd", "atr"]);
  state = setPaneHeight(togglePaneCollapsed(state, "macd"), "rsi", 200);
  state = reconcilePaneLayout(state, ["rsi", "atr"]);
  assert.deepEqual(state.order, ["rsi", "atr"]);
  assert.deepEqual(Object.keys(state.collapsed), []);
  assert.deepEqual(Object.keys(state.heights), ["rsi"]);
  assert.equal(paneHeight(state, "rsi", 120), 200, "the survivor keeps its height");
});

test("PANES — move up and down, and the edges refuse", () => {
  let state = layoutOf(["rsi", "macd", "atr"]);
  assert.equal(canMovePane(state, "rsi", -1), false);
  assert.equal(movePane(state, "rsi", -1), state, "a no-op returns the same state");
  assert.equal(canMovePane(state, "atr", 1), false);

  state = movePane(state, "atr", -1);
  assert.deepEqual(state.order, ["rsi", "atr", "macd"]);
  assert.deepEqual(orderedPanes(state, panes(["rsi", "macd", "atr"])).map((p) => p.id),
    ["rsi", "atr", "macd"]);
  state = movePane(state, "rsi", 1);
  assert.deepEqual(state.order, ["atr", "rsi", "macd"]);
  assert.equal(canMovePane(state, "ghost", 1), false);
});

test("PANES — a pane the layout has not seen still renders", () => {
  // Ordering must be additive, never a filter: an id missing from `order`
  // appears at the end rather than vanishing.
  const state = layoutOf(["rsi"]);
  assert.deepEqual(
    orderedPanes(state, panes(["rsi", "macd"])).map((p) => p.id), ["rsi", "macd"]);
  assert.deepEqual(
    orderedPanes(EMPTY_PANE_LAYOUT, panes(["a", "b"])).map((p) => p.id), ["a", "b"]);
});

test("PANES — maximise and restore preserve the whole stack exactly", () => {
  let state = layoutOf(["rsi", "macd", "atr"]);
  state = setPaneHeight(state, "rsi", 210);
  state = togglePaneCollapsed(state, "atr");
  state = movePane(state, "macd", -1);
  const before = JSON.parse(JSON.stringify(state)) as PaneLayoutState;

  state = togglePaneMaximized(state, "rsi");
  assert.ok(isPaneMaximized(state, "rsi"));
  assert.equal(isPaneMaximized(state, "macd"), false);
  // Order, heights and collapse are untouched while maximised.
  assert.deepEqual(state.order, before.order);
  assert.deepEqual(state.heights, before.heights);
  assert.deepEqual(state.collapsed, before.collapsed);

  state = restorePaneLayout(state);
  assert.deepEqual(state, before, "restore must return the exact previous structure");
  assert.equal(restorePaneLayout(state), state, "restoring twice is a no-op");
});

test("PANES — maximising a collapsed pane expands it; collapsing a maximised one restores", () => {
  let state = togglePaneCollapsed(layoutOf(["rsi", "macd"]), "rsi");
  state = togglePaneMaximized(state, "rsi");
  assert.ok(isPaneMaximized(state, "rsi"));
  assert.equal(isPaneCollapsed(state, "rsi"), false, "a full-height header is not a state");

  state = togglePaneCollapsed(state, "rsi");
  assert.equal(state.maximizedId, null, "the column is handed back");
});

test("PANES — a study that vanishes while maximised gives the column back", () => {
  const state = reconcilePaneLayout(
    togglePaneMaximized(layoutOf(["rsi", "macd"]), "rsi"), ["macd"]);
  assert.equal(state.maximizedId, null);
  assert.deepEqual(state.order, ["macd"]);
});

test("PANES — heights are clamped to the range the drag allows", () => {
  assert.equal(clampPaneHeight(10), MIN_PANE_HEIGHT);
  assert.equal(clampPaneHeight(10_000), MAX_PANE_HEIGHT);
  assert.equal(clampPaneHeight(Number.NaN), MIN_PANE_HEIGHT);
  assert.equal(clampPaneHeight(150.4), 150);
  assert.equal(paneHeight(setPaneHeight(layoutOf(["rsi"]), "rsi", 5), "rsi", 120),
    MIN_PANE_HEIGHT);
});

test("PANES — every control is a real button with a name, and none is inert", () => {
  for (const label of [
    "Collapse ${title}", "Expand ${title}", "Move ${title} up", "Move ${title} down",
    "Maximize ${title}", "Restore ${title} to the pane stack",
  ]) {
    assert.ok(PANE.includes(label), `missing control: ${label}`);
  }
  // Each is wired to a handler rather than being decoration.
  for (const call of [
    "onToggleCollapsed(id)", "onMove(id, -1)", "onMove(id, 1)", "onToggleMaximized(id)",
    'onAction(id, "hide")', 'onAction(id, "settings")', 'onAction(id, "remove")',
  ]) {
    assert.ok(PANE.includes(call), `control not wired: ${call}`);
  }
  // Toggles announce their state; the stack is reachable from the keyboard
  // because the controls are buttons revealed on focus, not only on hover.
  assert.match(PANE, /"aria-pressed": pressed/);
  assert.match(PANE, /focus-within:opacity-100 group-hover\/pane:opacity-100/);
});

test("PANES — a maximised study never destroys a chart to take the column", () => {
  // The price chart is hidden, not unmounted, and the library is told to stop
  // measuring it in the same commit — see lib/chartLifecycle.
  assert.match(CHART, /useChartMeasuring\(chartRef, !priceHidden\)/);
  assert.match(CHART, /priceHidden \? "hidden" : "min-h-0 flex-1"/);
  // The other studies collapse to their header; none of them is unmounted.
  assert.match(CHART, /\|\| \(maximizedPaneId !== null && paneId !== maximizedPaneId\)/);
  assert.match(CHART, /const collapsed = paneCollapsed\(pane\.id\);/);
  // A collapsed pane keeps its chart at a small but non-zero height.
  assert.ok(COLLAPSED_PANE_HEIGHT > 0);
  assert.match(PANE, /\{collapsed && <div className="absolute inset-0 z-\[2\] bg-surface" \/>\}/);
});

test("PANES — measurement is switched off through one shared helper", () => {
  // A structural check on the helper itself: it must swallow a dead chart.
  let applied: boolean | null = null;
  setChartMeasuring({ applyOptions: (o) => { applied = o.autoSize; } }, false);
  assert.equal(applied, false);
  setChartMeasuring(null, true);
  setChartMeasuring({ applyOptions: () => { throw new Error("disposed"); } }, true);
});

// ══ 26–30  HEIKIN ASHI / RENKO ═════════════════════════════════════════════

test("LEGEND — each chart type says which bars its readout describes", () => {
  assert.equal(legendSource("candles"), "canonical");
  assert.equal(legendSource("bars"), "canonical");
  assert.equal(legendSource("line"), "canonical");
  assert.equal(legendSource("area"), "canonical");
  assert.equal(legendSource("heikinAshi"), "heikinAshi");
  assert.equal(legendSource("renko"), "renkoBrick");
});

test("LEGEND — Heikin Ashi reads the bar that is drawn, not the one that is not", () => {
  const source: OhlcBar[] = [
    { openTime: 0, open: 100, high: 110, low: 90, close: 105 },
    { openTime: HOUR, open: 105, high: 120, low: 100, close: 118 },
  ];
  const ha = transformAll("heikinAshi", source).output;
  // The second HA bar's open and close are both unlike its canonical bar's, so
  // a legend reading the wrong bar cannot pass by coincidence. (Its high and
  // low legitimately coincide here: HA takes the source extremes unless its
  // own open or close is wider.)
  const bar = ha[1]!;
  assert.equal(bar.close, (105 + 120 + 100 + 118) / 4);
  assert.equal(bar.open, (ha[0]!.open + ha[0]!.close) / 2);
  assert.notEqual(bar.open, source[1]!.open);
  assert.notEqual(bar.close, source[1]!.close);
  // One drawn bar per canonical bar, at the canonical timestamp.
  assert.equal(ha.length, source.length);
  assert.equal(bar.openTime, source[1]!.openTime);

  // The renderer takes O/H/L/C from `displayRef` for a transform, and the
  // volume from the canonical candle, which the transform has not touched.
  const build = CHART.slice(CHART.indexOf("const buildLegend = useCallback("));
  const body = build.slice(0, build.indexOf("}, []);"));
  assert.match(body, /if \(kind === "heikinAshi"\)/);
  assert.match(body, /volume: canonical \? canonical\.volume : null/);
  assert.match(body, /const bar = display\[displayIndex\];/);
});

test("LEGEND — a transformed readout is labelled as one", () => {
  assert.match(CHART, /legend\?\.kind === "heikinAshi" \? "HA"/);
  assert.match(CHART, /legend\?\.kind === "renkoBrick" \? "Brick"/);
  assert.match(CHART, /displayed values, not exchange prices/);
  // …and a canonical chart carries no such label, or it would stop meaning
  // anything. `legendLabel` is null for every canonical kind.
  assert.match(CHART, /: null;\n/);
});

test("LEGEND — the canonical chart stays canonical", () => {
  // The canonical branch reads `candlesRef`, which holds exchange candles and
  // is written only from the history load and the exchange kline feed.
  const build = CHART.slice(CHART.indexOf("const buildLegend = useCallback("));
  const canonicalBranch = build.slice(build.indexOf('if (kind === "canonical")'));
  const body = canonicalBranch.slice(0, canonicalBranch.indexOf("const display ="));
  assert.match(body, /const c = list\[canonicalIndex\];/);
  assert.equal(body.includes("displayRef"), false, "canonical must not read the transform");
  assert.match(body, /volume: c\.volume/);
});

test("LEGEND — Renko prints a brick, not a fabricated time candle", () => {
  const source: OhlcBar[] = candles(120).map((c, i) => ({
    openTime: c.openTime, open: 100 + i, high: 102 + i, low: 98 + i, close: 100 + i * 2,
  }));
  const bricks = renkoBricks(source, { atrPeriod: 14 });
  assert.ok(bricks.length > 0);
  for (const brick of bricks) {
    // A brick's high and low ARE its open and close; there is no fifth number
    // to report and no period over which a high or low was made.
    assert.equal(brick.high, Math.max(brick.open, brick.close));
    assert.equal(brick.low, Math.min(brick.open, brick.close));
    assert.ok(brick.size > 0);
  }
  // So the readout is direction, open → close, size, and the canonical time.
  assert.match(CHART, /legend\.kind === "renkoBrick" && legend\.brick \?/);
  assert.match(CHART, /fmtChartBarTime\(legend\.brick\.sourceOpenTime, resolutionMs\(interval\)\)/);
  // And it carries no volume: a brick is not a bar and has no traded size.
  const build = CHART.slice(CHART.indexOf("if (!isRenkoBrick(bar)) return null;"));
  assert.match(build.slice(0, 400), /volume: null/);
});

test("RENKO — misleading canonical-time layers are suppressed, not redrawn", () => {
  assert.equal(timeAnchoredVisualsTruthful("renko"), false);
  for (const type of ["candles", "bars", "line", "area", "heikinAshi"] as const) {
    assert.ok(timeAnchoredVisualsTruthful(type), `${type} keeps its overlays`);
  }
  assert.ok(RENKO_ALIGNMENT_NOTE.length > 40);

  // Markers, script plots, script drawings, user drawings and the indicator
  // stack are all gated on the same decision.
  assert.match(CHART, /const timeAnchored = timeAnchoredVisualsTruthful\(chartType\)/);
  assert.match(CHART, /if \(!timeAnchored\) \{ series\.setMarkers\(\[\]\); return; \}/);
  assert.match(CHART, /\{timeAnchored && !priceHidden && \(/);
  assert.match(CHART, /const stackAvailable = timeAnchored;/);
  // The suppression is disclosed rather than silent.
  assert.match(CHART, /Time-anchored layers hidden/);
});

test("RENKO — suppression hides drawings without touching what is stored", () => {
  // The drawing store is per symbol and is not consulted by the chart type.
  const store = read("lib/drawingStore.ts");
  assert.equal(store.includes("chartType"), false);
  assert.equal(store.includes("renko"), false);
  // The chart passes drawings straight through; only the layer is conditional.
  assert.match(CHART, /drawings=\{drawings\}/);
});

test("HEIKIN ASHI — keeps every truthful overlay", () => {
  // One bar per canonical timestamp is exactly what makes canonical-time
  // plots, markers and drawings land where they belong.
  const source: OhlcBar[] = candles(50).map((c, i) => ({
    openTime: c.openTime, open: 100 + i, high: 103 + i, low: 97 + i, close: 101 + i,
  }));
  const ha = transformAll("heikinAshi", source).output;
  assert.deepEqual(ha.map((b) => b.openTime), source.map((b) => b.openTime));
  assert.ok(timeAnchoredVisualsTruthful("heikinAshi"));
});

test("PRICE LINES survive every transform: they are prices, not times", () => {
  // Order, stop, target and alert levels are horizontal. They carry no bar
  // time, so no transform can misplace them — and they are drawn on every
  // chart type, Renko included.
  const at = CHART.indexOf("// Live stop / target / entry levels");
  const effect = CHART.slice(at, at + 900);
  assert.match(effect, /series\.createPriceLine\(\{/);
  assert.equal(effect.includes("timeAnchored"), false, "levels are never suppressed");
  assert.match(effect, /price: l\.price,/);
});

// ══ TIME AXIS / CLOCK ══════════════════════════════════════════════════════

test("CLOCK — chart time is stated as UTC, which is what it has always been", () => {
  // lightweight-charts formats its axis from the UTC fields of the timestamp,
  // and Binance klines are UTC. This names that authority; it does not create
  // a timezone system, and there is no setting to be wrong about.
  assert.equal(CHART_TIME_ZONE, "UTC");
  const at = Date.UTC(2026, 8, 3, 14, 7, 32);
  assert.equal(fmtChartClock(at), "14:07:32");
  assert.equal(fmtChartDate(at), "2026-09-03");
  assert.equal(fmtChartBarTime(at, INTERVAL_MS["15m"]), "2026-09-03 14:07");
  // A daily bar prints no time of day: the zeros would not mean anything.
  assert.equal(fmtChartBarTime(at, INTERVAL_MS["1d"]), "2026-09-03");
  assert.equal(fmtChartClock(Number.NaN), "--:--:--");
  const clock = code(read("lib/chartClock.ts"));
  assert.equal(clock.includes("toLocale"), false, "no reader-local formatting here");
  // Every field is read in UTC, which is what makes the values above hold
  // whatever zone the reader (or this test runner) happens to be in.
  assert.match(clock, /getUTCHours\(\)/);
  assert.match(clock, /getUTCFullYear\(\)/);
});

test("CLOCK — the ticker only runs while it is on screen", () => {
  assert.match(CHART, /if \(!showBottomBar\) \{ setClock\(null\); return; \}/);
  assert.match(CHART, /return \(\) => window\.clearInterval\(timer\);/);
});

// ══ 31–37  REGRESSION ══════════════════════════════════════════════════════

test("REGRESSION — one shared feed and one shared history, unchanged", () => {
  // This wave added interaction, not data paths. The chart still subscribes to
  // the shared feed once per pane and loads history through the shared cache.
  assert.equal((CHART.match(/marketFeed\.subscribe\(/g) ?? []).length, 1);
  assert.equal(CHART.includes("new WebSocket"), false);
  assert.equal(CHART.includes("api.candles"), false);
});

test("REGRESSION — the chart is created once and destroyed once", () => {
  assert.equal((CHART.match(/createChart\(/g) ?? []).length, 1);
  assert.equal((CHART.match(/chart\.remove\(\)/g) ?? []).length, 1);
  assert.equal((PANE.match(/createChart\(/g) ?? []).length, 1);
  assert.equal((PANE.match(/chart\.remove\(\)/g) ?? []).length, 1);
  // The unmount detach that keeps a 16-pane close from throwing is still there.
  assert.match(CHART, /useDetachChartObserver\(chartRef\)/);
  assert.match(PANE, /useDetachChartObserver\(chartRef\)/);
});

test("REGRESSION — replay clipping still decides what the chart can see", () => {
  const all = candles(50);
  const session: ReplaySession = {
    horizonCloseTime: all[20]!.closeTime,
    availableThroughCloseTime: all[40]!.closeTime,
    playing: false, speed: 1,
  };
  const visible = replayCandles(all, session);
  assert.equal(visible.length, 21);
  // Every interaction added by this wave reads `candles`, which is what the
  // pane draws — so none of them can see bar 21.
  const w = loadedWindow(visible, INTERVAL_MS["1h"])!;
  assert.equal(w.lastOpenSec, all[20]!.openTime / 1000);
  assert.ok(resolveRangeShortcut("ALL", w)!.to < all[21]!.openTime / 1000);
});

test("REGRESSION — the transform still reads only replay-visible input", () => {
  // A prefix of the canonical series transforms to a prefix of the output,
  // which is what makes clipping the input sufficient.
  const source: OhlcBar[] = candles(80).map((c, i) => ({
    openTime: c.openTime, open: 100 + i, high: 102 + i, low: 98 + i, close: 100 + i * 1.7,
  }));
  const whole = transformAll("renko", source.slice(0, 40)).output;
  const prefix = transformAll("renko", source.slice(0, 40)).output;
  assert.deepEqual(whole, prefix);
  const longer = transformAll("renko", source).output;
  assert.deepEqual(longer.slice(0, whole.length), whole);
});
