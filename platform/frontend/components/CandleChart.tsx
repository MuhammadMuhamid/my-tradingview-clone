"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { resolutionMs, type Resolution } from "@/lib/resolution";
import {
  BarCountdownPrimitive, chipBackColor, chipTextColor, countdownText,
} from "@/lib/barCountdown";
import {
  createChart, IChartApi, ISeriesApi, Time, UTCTimestamp,
  SeriesMarker, MouseEventParams, ColorType, LineStyle, LineType, PriceScaleMode,
  CrosshairMode,
  type AreaData, type BarData, type CandlestickData, type HistogramData,
  type LineData, type WhitespaceData,
} from "lightweight-charts";
import { INTERVAL_MS, type Candle, type Trade } from "@/lib/types";
import { rangeChanged, snapToBarIndexBy } from "@/lib/paneSync";
import { marketFeed, WS_SILENCE_TIMEOUT_MS, type FeedState, type KlineTick } from "@/lib/marketFeed";
import { describeStreamState } from "@/lib/marketStream";
import {
  displayDescription, displayName, displayTicker, instrumentMark, isCanonicalInstrumentId,
  marketOpen,
} from "@/lib/instrument";
import { useBookQuote } from "@/lib/useBookQuote";
import { useWatchlistTickers } from "@/lib/useWatchlistTickers";
import { datasetKey as datasetKeyOf, LiveTickGate, type DatasetIdentity } from "@/lib/liveDataset";
import {
  baseChartOptions, CHART_ACCENT, CHART_CAUTION, CHART_DOWN, CHART_UP, chartMuted, volumePalette,
  chartWatermarkColor, subscribeChartTheme,
} from "@/lib/chartTheme";
import {
  createDisposalGuard, useChartMeasuring, useDetachChartObserver,
} from "@/lib/chartLifecycle";
import { autoPriceDigits, fmtPrice, fmtPriceAt, fmtPriceDelta } from "@/lib/format";
import { DrawingCanvas } from "@/components/tv/DrawingCanvas";
import type { MagnetMode } from "@/components/tv/DrawingToolbar";
import { PineDrawingLayer, PineTables } from "@/components/tv/PineDrawingLayer";
import { IndicatorLegend } from "@/components/tv/IndicatorLegend";
import { IndicatorPane, type PaneAction } from "@/components/tv/IndicatorPane";
import { PineVisualLayer } from "@/components/tv/PineVisualLayer";
import { VolumeProfileLayer } from "@/components/tv/VolumeProfileLayer";
import { FootprintLayer } from "@/components/tv/FootprintLayer";
import type { PineDrawings } from "@/lib/api";
import type { Drawing, DrawingTool } from "@/lib/drawings";
import {
  canUpdateTail, groupChartOverlays, planColoredCandleMutation, planOhlcMutation,
  planSeriesMutation,
  type ChartBarColor, type ChartDecoration, type ChartOverlay, type ChartPoint,
  type ChartProfileDecoration,
} from "@/lib/chartSeries";
import {
  chartTransform, isSyntheticTimeBase, legendSource, mainSeriesDatum, renderKind, transformParams,
  syntheticDisclosure, timeAnchoredVisualsTruthful,
  RENKO_ALIGNMENT_NOTE, SYNTHETIC_DISCLOSURE_HINT,
  type ChartRenderKind, type ChartType, type LegendSource, type MainSeriesDatum,
  type OhlcBar,
} from "@/lib/chartType";
import { hasLineMarkers, isVolumeCandle } from "@/lib/chartType";
import {
  canonicalOpenTime, isRenkoBrick, isPointFigureColumn, transformAll, transformStep,
  type TransformCursor, type TransformKind, type TransformParams,
} from "@/lib/chartTransforms";
import { rangeBarsAsOhlc, rangeBarSize, footprintBarsAsOhlc, footprintCoveredTimes, type AggregateTrade } from "@/lib/tradeChartTransforms";

/*
 * The body a footprint cell is read OVER.
 *
 * A cell is the direction colour at 0.62 alpha, so a solid candle underneath
 * muddies the pair of numerals the whole presentation exists to show. A
 * neutral ghost keeps the bar's geometry — and its wick, which reaches past
 * the traded levels — without competing with the cells. Neutral rather than a
 * theme token on purpose: it must not read as a direction on either theme.
 */
const FOOTPRINT_GHOST = "rgba(128,128,128,0.32)";

/** Said once, in full, where a reader can reach it from the chip. */
const FOOTPRINT_COVERAGE_HINT = "Bid/ask cells are drawn only from the public execution tape, which the provider serves for a recent window. The remaining bars are shown as ordinary exchange OHLC; no order flow is inferred for them.";
import {
  DEFAULT_PRICE_SCALE, priceScaleLabel, priceScaleModeLabel, resetPriceScale,
  scaleShowsPrices, setPriceScaleAuto, togglePercentScale, togglePriceScaleAuto,
  togglePriceScaleMode, type PriceScaleState,
} from "@/lib/priceScale";
import {
  DEFAULT_CHART_SETTINGS, resolveBackgroundGradient, scaleMarginsFor, type ChartSettings,
} from "@/lib/chartSettings";
import {
  loadedWindow, rangeShortcutChoices, resolveRangeShortcut, sameViewport,
  type LoadedWindow, type RangeShortcutId,
} from "@/lib/rangeShortcuts";
import { SEPARATOR } from "@/components/tv/toolbarChrome";
import {
  canMovePane, COLLAPSED_PANE_HEIGHT, EMPTY_PANE_LAYOUT, isPaneCollapsed,
  isPaneMaximized, movePane, orderedPanes, paneHeight, reconcilePaneLayout,
  setPaneHeight, togglePaneCollapsed, togglePaneMaximized,
  type PaneLayoutState,
} from "@/lib/indicatorPaneLayout";
import {
  axisTickFormatter, chartTimeZoneLabel, fmtChartBarTime, fmtChartClock, hoursFormatter,
} from "@/lib/chartClock";

export type { ChartOverlay } from "@/lib/chartSeries";

/**
 * The legend readout for whatever bar the crosshair is on.
 *
 * ── What `kind` decides ────────────────────────────────────────────────────
 *
 * The legend used to print the canonical candle whatever the chart drew, which
 * was wrong in two different ways at once. On Heikin Ashi the four numbers
 * labelled O/H/L/C did not describe the body under the pointer — they
 * described a bar that is not on screen. On sparse transforms they described
 * a time candle on a chart that has no time candles at all.
 *
 * So the readout says which bars it is reading, and the renderer says so on
 * screen too. `canonical` is the only kind whose numbers are exchange prices;
 * the synthetic kinds are display values and are labelled as such wherever they are
 * shown. NOTHING downstream of this component reads a `LegendBar`.
 */
interface LegendBar {
  kind: LegendSource;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * Exchange traded volume for the canonical bar, or null when there is no
   * honest figure — a Renko brick is not a bar and has no volume of its own.
   * Heikin Ashi keeps the canonical figure: the transform reshapes price and
   * says nothing whatever about size.
   */
  volume: number | null;
  /** change vs the previous drawn bar's close (falls back to this bar's open) */
  chg: number;
  chgPct: number;
  /** Present only for `renkoBrick`: what the brick itself is. */
  brick?: { direction: 1 | -1; size: number; sourceOpenTime: number };
}

/**
 * The states the live feed can be in. `stale` and `unknown` exist so the chart
 * never presents a frozen price as current — which is precisely what FE-09
 * described.
 */
export type ChartFeedState = FeedState["status"];

const IDLE_FEED: FeedState = { status: "idle", origin: null, attempt: 0, everLive: false, refused: [] };

/**
 * Silence after which an open socket is treated as dead and rebuilt.
 *
 * The socket itself — and the reconnect ladder and watchdog that enforce this
 * — moved to `lib/marketFeed`, so sixteen panes on one instrument share one
 * connection instead of opening sixteen. Re-exported here because callers and
 * tests have always read this constant from the chart.
 */
export { WS_SILENCE_TIMEOUT_MS };

/** A horizontal level drawn across the chart (live stop / target / entry). */
export interface ChartPriceLine {
  id?: string;
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
  /**
   * What KIND of level this is, so the two settings that hide levels can hide
   * the right ones (R6 T-1 / A-1).
   *
   * `Positions and orders` on the Trading tab and `Alert lines` on the Alerts
   * tab are two rows in two tabs, and both used to be one switch —
   * `showTrading` emptied the whole `priceLines` array, so turning off the
   * position lines also took away every armed alert level. Omitted means
   * `trading`, because every producer that predates this is one.
   */
  kind?: "trading" | "alert";
  /**
   * Unrealised profit and loss on this level, already formatted, or absent
   * when the contract behind it does not prove one (R6 T-2).
   *
   * Only the explicit `ManualPosition` snapshot carries a P&L; the deployment
   * and paper position contracts carry a price and a quantity and nothing
   * else. So this is present on a manual position's line and absent on the
   * others, and the `Profit and loss value` switch appends it where it exists
   * rather than printing a zero where it does not.
   */
  pnl?: string;
}

/** A bar marker plotted by a script (plotshape / plotchar). */
export interface ChartMarker {
  id?: string;
  /** bar open time in seconds */
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  text: string;
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  category?: "alert" | "event";
}

export type OverlaySeriesEntry =
  | { kind: "Line"; api: ISeriesApi<"Line">; data: ChartPoint[] }
  | { kind: "Histogram"; api: ISeriesApi<"Histogram">; data: ChartPoint[] }
  | { kind: "Area"; api: ISeriesApi<"Area">; data: ChartPoint[] }
  | { kind: "Candlestick"; api: ISeriesApi<"Candlestick">; data: ChartPoint[] }
  | { kind: "Bar"; api: ISeriesApi<"Bar">; data: ChartPoint[] };

/**
 * Opening height for each indicator pane, given how many there are.
 *
 * The stack is capped at a share of the chart column, and a fixed per-pane
 * height meant a third oscillator overflowed that cap and was drawn cut in
 * half. Shrinking as panes are added keeps the common cases whole; the user's
 * own resize always wins over this.
 *
 * These were 160/144/124/106 against a 56% cap, which on a 1000px workspace
 * with an overlay study, an oscillator and MACD left the price chart 44% —
 * measured at 230px, shorter than the two oscillators under it put together.
 * The candles are the subject of this screen; the studies annotate them. The
 * cap is now 38% and the panes open smaller, so price keeps the majority of
 * the column in every case a user actually reaches.
 */
function defaultPaneHeight(paneCount: number): number {
  if (paneCount <= 1) return 132;
  if (paneCount === 2) return 118;
  if (paneCount === 3) return 104;
  return 94;
}

/**
 * This product's scale modes, in the library's own enum.
 *
 * A record rather than a chain of ternaries so the compiler requires an entry
 * for every mode: a fifth mode added to `lib/priceScale` fails the build here
 * rather than silently falling through to a linear axis at runtime.
 */
const LIBRARY_SCALE_MODE: Record<PriceScaleState["mode"], PriceScaleMode> = {
  normal: PriceScaleMode.Normal,
  logarithmic: PriceScaleMode.Logarithmic,
  percentage: PriceScaleMode.Percentage,
  indexedTo100: PriceScaleMode.IndexedTo100,
};

function overlaySeriesKind(overlay: ChartOverlay): OverlaySeriesEntry["kind"] {
  if (overlay.style === "histogram" || overlay.style === "columns") return "Histogram";
  if (overlay.style === "area") return "Area";
  if (overlay.style === "candles") return "Candlestick";
  if (overlay.style === "bars") return "Bar";
  return "Line";
}

function visiblePoint(point: ChartPoint): boolean {
  return point.value !== null && Number.isFinite(point.value) && point.color !== null;
}

function alphaColor(color: string, alpha: string): string {
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)
    ? `${color.slice(0, 7)}${alpha}` : color;
}

function lineDatum(point: ChartPoint): LineData<Time> | WhitespaceData<Time> {
  return visiblePoint(point)
    ? { time: point.time as UTCTimestamp, value: point.value!, ...(point.color ? { color: point.color } : {}) }
    : { time: point.time as UTCTimestamp };
}

function histogramDatum(point: ChartPoint): HistogramData<Time> | WhitespaceData<Time> {
  return visiblePoint(point)
    ? { time: point.time as UTCTimestamp, value: point.value!, ...(point.color ? { color: point.color } : {}) }
    : { time: point.time as UTCTimestamp };
}

function areaDatum(point: ChartPoint): AreaData<Time> | WhitespaceData<Time> {
  return visiblePoint(point)
    ? {
        time: point.time as UTCTimestamp, value: point.value!,
        ...(point.color ? {
          lineColor: point.color,
          topColor: alphaColor(point.color, "55"),
          bottomColor: alphaColor(point.color, "08"),
        } : {}),
      }
    : { time: point.time as UTCTimestamp };
}

function customCandleDatum(point: ChartPoint): CandlestickData<Time> | WhitespaceData<Time> {
  return visiblePoint(point) && [point.open, point.high, point.low, point.close].every(Number.isFinite)
    ? {
        time: point.time as UTCTimestamp,
        open: point.open!, high: point.high!, low: point.low!, close: point.close!,
        ...(point.color ? { color: point.color } : {}),
        ...(point.wickColor ? { wickColor: point.wickColor } : {}),
        ...(point.borderColor ? { borderColor: point.borderColor } : {}),
      }
    : { time: point.time as UTCTimestamp };
}

/**
 * The main price series, in whichever presentation is selected.
 *
 * lightweight-charts types `setData`/`update` per series kind, so the two
 * helpers below are the single place the datum shape is reconciled with the
 * series that receives it. Everything else — markers, price lines, the
 * crosshair, the drawing layers — uses only methods every series kind shares.
 *
 * They switch on the RENDER kind rather than the chart type, because Heikin
 * Ashi and Renko are both drawn by a candlestick series; what differs about
 * them is the bars they are handed, not the series that receives them.
 */
export type MainSeriesApi =
  | ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line">
  | ISeriesApi<"Area"> | ISeriesApi<"Baseline"> | ISeriesApi<"Histogram">;

/*
 * TVP8: a PRICE histogram cannot be based at zero.
 *
 * `base: 0` is what makes a histogram read as a column rather than a floating
 * block, and for volume — which starts at zero — it is simply right. Columns
 * plots price. The library folds the base into autoscale, so on anything that
 * does not trade near zero the axis ran 0 to 77,000 and every column collapsed
 * into a stripe across the top of the pane: the price axis was unreadable and
 * the columns had no shape at all.
 *
 * The reference scales its Columns chart to the prices in view like every
 * other type. So the base moves to just under the lowest value drawn, which
 * keeps the columns grounded AND the axis describing the price range. It is
 * applied where the data is, because it is a property of the data.
 */
function applyColumnBase(api: MainSeriesApi, rows: MainSeriesDatum[]): void {
  const values = rows
    .map((row) => (row as { value?: number }).value)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (values.length === 0) return;
  const low = Math.min(...values);
  const high = Math.max(...values);
  // A flat series would otherwise base exactly on its own value and draw
  // nothing; one percent of the price is a visible column with no axis cost.
  const span = high - low;
  const base = low - (span > 0 ? span * 0.08 : Math.abs(low) * 0.01 || 1);
  try {
    (api as ISeriesApi<"Histogram">).applyOptions({ base });
  } catch { /* the series went away between render and effect */ }
}

/**
 * The newest bar time a main series has actually been given.
 *
 * ── TVP8 round two, found live on the production build ─────────────────────
 *
 * lightweight-charts refuses an `update()` older than the series' last bar:
 *
 *   Error: Cannot update oldest data, last time=… new time=…
 *
 * The throw is not caught at the call and reaches the route's error boundary,
 * so the whole chart page becomes "This page stopped working".
 *
 * `planOhlcMutation` is sound and cannot produce that on its own — it only
 * answers "update" when the new bars match the old up to the last one. The
 * flaw is what it compares AGAINST: `displayRef`, this component's record of
 * what IT last drew. The series has two writers. The live-tick path advances
 * it to a new bar, and in the untransformed case does not touch `displayRef`;
 * the data effect then runs before the history has caught up, plans an
 * "update" against a record that is one bar behind, and replays a bar the
 * series has already moved past.
 *
 * So the guard lives at the one place every writer goes through, rather than
 * in each of the six call sites, and it is a REFUSAL rather than a repair: a
 * bar the series is already past has nothing to say that the bar after it will
 * not say a moment later.
 */
export type SeriesHead = { current: number | null };

export function setMainSeriesData(
  api: MainSeriesApi, type: ChartType, rows: MainSeriesDatum[], head?: SeriesHead,
): void {
  /*
   * ── The assertion the production bundle does not make ────────────────────
   *
   * `lightweight-charts` requires data ascending and unique by time, and its
   * DEVELOPMENT build says so — "data must be asc ordered by time". The
   * production build carries no such assertion. Given two rows at one time
   * point it accepts them, indexes all but one of them to 0, and the series'
   * plot list is then no longer sorted by index: its binary search returns
   * null for rows that are physically present, and `SeriesBarColorer` hands
   * that null to `ensureNotNull` on the next paint. That is `Value is null`,
   * thrown from an animation frame, which is why it repeats rather than
   * settling.
   *
   * Range produced exactly that and was repaired at the source. This is the
   * one seam every writer passes through, so the invariant is stated here too
   * — in development, where a violation is a defect to fix, and never as a
   * silent repair, because a chart quietly dropping bars is the failure this
   * whole file exists to avoid.
   */
  if (process.env.NODE_ENV !== "production") {
    for (let i = 1; i < rows.length; i += 1) {
      if ((rows[i]!.time as number) <= (rows[i - 1]!.time as number)) {
        throw new Error(
          `${type}: main series data must ascend strictly by time — row ${i} `
          + `(${String(rows[i]!.time)}) does not follow row ${i - 1} (${String(rows[i - 1]!.time)})`,
        );
      }
    }
  }
  const data = rows as unknown;
  const kind = renderKind(type);
  if (kind === "histogram" && type === "columns") applyColumnBase(api, rows);
  if (kind === "candles") (api as ISeriesApi<"Candlestick">).setData(data as CandlestickData<Time>[]);
  else if (kind === "bars") (api as ISeriesApi<"Bar">).setData(data as BarData<Time>[]);
  else if (kind === "area") (api as ISeriesApi<"Area">).setData(data as AreaData<Time>[]);
  else if (kind === "histogram") (api as ISeriesApi<"Histogram">).setData(data as HistogramData<Time>[]);
  else if (kind === "baseline") (api as ISeriesApi<"Baseline">).setData(data as LineData<Time>[]);
  else (api as ISeriesApi<"Line">).setData(data as LineData<Time>[]);
  // `setData` REPLACES, so the head is whatever was just written — including
  // backwards, which is the whole point of a repaint.
  if (head) head.current = rows.length > 0 ? rows[rows.length - 1]!.time : null;
}

/**
 * Write one row to the main series, repainting instead when it is behind.
 *
 * ── TVP8 round three ──────────────────────────────────────────────────────
 *
 * The refusal used to be a DROP: this returned `false` and every one of its
 * four callers ignored it. Two of them then set `displayRef.current = display`,
 * so the component's record claimed a bar the series had never been given — and
 * the next plan, computed from that record, could answer "update" for a bar
 * that was never drawn, leaving the series permanently one short.
 *
 * `repaint` is the caller's own full-replacement for the same content, and it
 * is a thunk rather than an array because building one is the ten-thousand-row
 * map the planner exists to avoid. So the cheap path stays cheap and the
 * refusal draws the bars rather than silently losing them.
 */
export function updateMainSeries(
  api: MainSeriesApi, type: ChartType, row: MainSeriesDatum, head?: SeriesHead,
  repaint?: () => void,
): boolean {
  if (head && head.current !== null && row.time < head.current) {
    repaint?.();
    return false;
  }
  const datum = row as unknown;
  const kind = renderKind(type);
  if (kind === "candles") (api as ISeriesApi<"Candlestick">).update(datum as CandlestickData<Time>);
  else if (kind === "bars") (api as ISeriesApi<"Bar">).update(datum as BarData<Time>);
  else if (kind === "area") (api as ISeriesApi<"Area">).update(datum as AreaData<Time>);
  else if (kind === "histogram") (api as ISeriesApi<"Histogram">).update(datum as HistogramData<Time>);
  else if (kind === "baseline") (api as ISeriesApi<"Baseline">).update(datum as LineData<Time>);
  else (api as ISeriesApi<"Line">).update(datum as LineData<Time>);
  if (head) head.current = head.current === null ? row.time : Math.max(head.current, row.time);
  return true;
}

/** One bar of the volume histogram. */
export type VolumeRow = HistogramData<Time>;

/**
 * Replace the volume histogram, moving its head to whatever was written.
 *
 * The histogram has the same two writers the price series has — the data
 * effect and the live-tick handler — and until TVP8 round three it had no head
 * at all, which is the one thing that makes a backwards `update()` detectable.
 * These two functions exist so that the rule is written once and so a test can
 * drive it; the writes used to be inline in two effects, where nothing could.
 */
export function setVolumeData(
  api: ISeriesApi<"Histogram">, rows: VolumeRow[], head: SeriesHead,
): void {
  api.setData(rows);
  head.current = rows.length > 0 ? (rows[rows.length - 1]!.time as number) : null;
}

/**
 * Extend the volume histogram, or refuse a bar it is already past.
 *
 * `repaint` is the data effect's full replacement, for the case where the
 * window itself moved back. The LIVE path passes none deliberately: a frame
 * behind the drawn bar has nothing to say that the next frame will not, which
 * is the rule `lib/liveDataset` states for the price series.
 *
 * ── Why this guard exists rather than trusting `LiveTickGate` ─────────────
 *
 * On the ordinary path the two watermarks are kept together only by ORDER:
 * `LiveTickGate.adopt` re-anchors its `newest` from the history in the same
 * effect run that `setVolumeData` re-anchors this one, so the gate refuses a
 * stale frame before it can reach here. Reorder those and the gap opens.
 *
 * But the gate could not stand in for this guard even then, because the two
 * do not move alike. On the SAME dataset `adopt` never moves `newest`
 * backwards — `Math.max(this.newest ?? lastOpenTime, lastOpenTime)` — while
 * `setVolumeData` moves this one backwards deliberately, which is the whole
 * point of a repaint. A same-dataset window that shrinks (Replay, a shorter
 * backfill) genuinely separates them. It happens to separate them in the safe
 * direction, but that is the direction's luck, not the ordering's.
 *
 * ── Why this one DROPS and the price series REPAINTS ──────────────────────
 *
 * Not two answers to the same fact. `applyTick` writes the bar into
 * `candlesRef.current` before the price write, so a drop there would leave a
 * RECORD claiming a bar the series does not have, and the next plan is
 * computed from that record. Volume keeps no record — only this watermark —
 * so dropping leaves it consistent with what is drawn.
 */
export function updateVolumeSeries(
  api: ISeriesApi<"Histogram">, row: VolumeRow, head: SeriesHead, repaint?: () => void,
): boolean {
  const time = row.time as number;
  if (head.current !== null && time < head.current) {
    repaint?.();
    return false;
  }
  api.update(row);
  head.current = head.current === null ? time : Math.max(head.current, time);
  return true;
}

/** Create the main series for a presentation, in the shared price palette. */
function addMainSeries(
  chart: IChartApi, type: ChartType, baselineValue = 0
): MainSeriesApi {
  const kind: ChartRenderKind = renderKind(type);
  if (kind === "candles") {
    /*
     * Hollow candles are the same series with a transparent up body.
     *
     * The border and the wick stay in the direction's own colour, so an up bar
     * still reads as up: the body being empty is the whole distinction, and
     * making the outline neutral would remove it.
     */
    const hollow = type === "hollowCandles";
    const highLow = type === "highLow";
    return chart.addCandlestickSeries({
      upColor: highLow ? "rgba(0,0,0,0)" : hollow ? "rgba(0,0,0,0)" : CHART_UP,
      downColor: highLow ? "rgba(0,0,0,0)" : CHART_DOWN,
      borderUpColor: highLow ? "rgba(0,0,0,0)" : CHART_UP,
      borderDownColor: highLow ? "rgba(0,0,0,0)" : CHART_DOWN,
      wickUpColor: highLow ? CHART_ACCENT : CHART_UP,
      wickDownColor: highLow ? CHART_ACCENT : CHART_DOWN,
    });
  }
  if (kind === "baseline") {
    /*
     * Filled above and below one reference price, in two colours.
     *
     * The reference is the first close in view, passed in rather than fixed,
     * so the chart reads as "up or down since the start of what I am looking
     * at" rather than as a second invisible input the user has to set.
     */
    return chart.addBaselineSeries({
      baseValue: { type: "price", price: baselineValue },
      topLineColor: CHART_UP,
      topFillColor1: "rgba(46,189,133,0.28)",
      topFillColor2: "rgba(46,189,133,0.02)",
      bottomLineColor: CHART_DOWN,
      bottomFillColor1: "rgba(246,70,93,0.02)",
      bottomFillColor2: "rgba(246,70,93,0.28)",
      lineWidth: 2,
      priceLineVisible: false,
    });
  }
  if (kind === "bars") {
    /*
     * `thinBars` is applied by its own effect below, from the setting. It was
     * hard-coded `false` here, which is why the setting could not exist: the
     * creation path is the only place it was ever set.
     */
    return chart.addBarSeries({ upColor: CHART_UP, downColor: CHART_DOWN });
  }
  if (kind === "area") {
    return chart.addAreaSeries({
      lineColor: CHART_ACCENT, lineWidth: 2,
      topColor: "rgba(79,140,255,0.28)", bottomColor: "rgba(79,140,255,0.02)",
      priceLineVisible: false,
    });
  }
  if (kind === "histogram") {
    return chart.addHistogramSeries({
      color: CHART_ACCENT, base: 0, priceLineVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
  }
  return chart.addLineSeries({
    color: CHART_ACCENT, lineWidth: 2, priceLineVisible: false,
    // A step holds each close until the next one, which is what a close IS —
    // the price at one instant, not a path between two of them.
    lineType: type === "stepLine" ? LineType.WithSteps : LineType.Simple,
  });
}

/** A style NAME from the settings model into the library's enum. */
function lineStyleOf(style: "solid" | "dotted" | "dashed"): LineStyle {
  return style === "solid" ? LineStyle.Solid
    : style === "dotted" ? LineStyle.Dotted : LineStyle.Dashed;
}

function volumeCandleColor(candle: Candle, max: number): string {
  const ratio = max > 0 ? Math.max(0.18, Math.min(1, candle.volume / max)) : 0.5;
  const alpha = Math.round((0.35 + ratio * 0.6) * 255).toString(16).padStart(2, "0");
  return candle.close >= candle.open ? `${CHART_UP}${alpha}` : `${CHART_DOWN}${alpha}`;
}

/**
 * A transform's position part-way through the canonical series.
 *
 * `cursor` has folded every bar EXCEPT the last one the chart holds, because
 * the last one is still forming: a tick rewrites it several times a second,
 * and Heikin Ashi and Renko are both recursive, so re-stepping just that bar
 * from a fixed cursor is the only way the drawn history stays identical to a
 * clean recomputation while the live bar keeps changing. `output` is what the
 * folded bars produced — one bar each for Heikin Ashi, zero or more bricks for
 * Renko.
 */
interface TransformHead {
  kind: TransformKind;
  params: TransformParams;
  /** Canonical bars already folded into `cursor`. */
  bars: number;
  cursor: TransformCursor;
  output: OhlcBar[];
}

/** The head's output plus whatever the forming bar currently produces. */
function withFormingBar(head: TransformHead, candles: readonly Candle[]): OhlcBar[] {
  const forming = candles[candles.length - 1];
  if (!forming || head.bars !== candles.length - 1) return [...head.output];
  return mergeSyntheticOutput(head.output, transformStep(head.cursor, forming).emitted);
}

/** P&F extensions update the active X/O column at its existing display time. */
function mergeSyntheticOutput(output: readonly OhlcBar[], emitted: readonly OhlcBar[]): OhlcBar[] {
  const next = [...output];
  for (const bar of emitted) {
    const last = next[next.length - 1];
    if (last && last.openTime === bar.openTime) next[next.length - 1] = bar;
    else next.push(bar);
  }
  return next;
}

/** Fold the whole canonical series from scratch. */
function rebuildTransform(
  kind: TransformKind, params: TransformParams, candles: readonly Candle[]
): { head: TransformHead; display: OhlcBar[] } {
  const closed = candles.length > 0 ? candles.slice(0, -1) : [];
  const { cursor, output } = transformAll(kind, closed, params);
  const head: TransformHead = { kind, params, bars: closed.length, cursor, output };
  return { head, display: withFormingBar(head, candles) };
}

/**
 * The live path: fold the bar that just closed, if one did, and re-step the
 * forming bar.
 *
 * Anything it cannot reconcile — a different transform, a head from another
 * dataset, more than one new closed bar — falls back to a full rebuild, so the
 * fast path can only ever be taken when it is exactly equal to the slow one.
 */
function advanceTransform(
  head: TransformHead | null, kind: TransformKind, params: TransformParams,
  candles: readonly Candle[]
): { head: TransformHead; display: OhlcBar[] } {
  const closedCount = candles.length - 1;
  // Percentage (LTP) Kagi/P&F sizing is defined by the latest close. When the
  // forming close changes, every earlier synthetic threshold changes with it,
  // so the documented repaint is a full deterministic rebuild.
  if (params.latestCloseSizing) return rebuildTransform(kind, params, candles);
  if (!head || head.kind !== kind || JSON.stringify(head.params) !== JSON.stringify(params)
    || head.bars > closedCount || closedCount - head.bars > 1) {
    return rebuildTransform(kind, params, candles);
  }
  let next = head;
  if (head.bars === closedCount - 1) {
    const stepped = transformStep(head.cursor, candles[head.bars]!);
    next = {
      ...head, bars: head.bars + 1, cursor: stepped.cursor,
      output: mergeSyntheticOutput(head.output, stepped.emitted),
    };
  }
  return { head: next, display: withFormingBar(next, candles) };
}

function customBarDatum(point: ChartPoint): BarData<Time> | WhitespaceData<Time> {
  return visiblePoint(point) && [point.open, point.high, point.low, point.close].every(Number.isFinite)
    ? {
        time: point.time as UTCTimestamp,
        open: point.open!, high: point.high!, low: point.low!, close: point.close!,
        ...(point.color ? { color: point.color } : {}),
      }
    : { time: point.time as UTCTimestamp };
}

export function replaceOverlayData(entry: OverlaySeriesEntry, points: ChartPoint[]): void {
  if (entry.kind === "Line") entry.api.setData(points.map(lineDatum));
  else if (entry.kind === "Histogram") entry.api.setData(points.map(histogramDatum));
  else if (entry.kind === "Area") entry.api.setData(points.map(areaDatum));
  else if (entry.kind === "Candlestick") entry.api.setData(points.map(customCandleDatum));
  else entry.api.setData(points.map(customBarDatum));
  entry.data = points;
}

/**
 * Extend or rewrite an overlay's tail — or repaint it, when that is what the
 * incoming points actually are.
 *
 * ── TVP8, owner-found P0 ──────────────────────────────────────────────────
 *
 * `planSeriesMutation` is the authority and now refuses to answer "update" for
 * a tail that moved backwards. This is the seam that makes the rule a property
 * of the CHART rather than of one planner: the last point the series was given
 * is compared with the point about to be written, and a point behind it is
 * applied as the replacement it is instead of being handed to `update()`,
 * which throws and takes the whole route down with it.
 *
 * `entry.data` is an exact mirror of the series' own head — `setData` sets it,
 * `update` advances it, and lightweight-charts keeps `_seriesLastTimePoint` by
 * the same two rules — so no separate watermark is needed here.
 */
/*
 * Exported for `tests/dom/studyWindowZoom.test.tsx`, which drives THIS function
 * against a real lightweight-charts series.
 *
 * The first version of that test re-implemented the seam instead of calling it,
 * and a review proved the point by deleting the guard from this file and
 * watching all 106 DOM tests stay green. A regression test that re-implements
 * the code it is protecting protects nothing.
 */
export function updateOverlayData(entry: OverlaySeriesEntry, points: ChartPoint[]): void {
  const point = points[points.length - 1]!;
  if (!canUpdateTail(entry.data, point.time)) { replaceOverlayData(entry, points); return; }
  if (entry.kind === "Line") entry.api.update(lineDatum(point));
  else if (entry.kind === "Histogram") entry.api.update(histogramDatum(point));
  else if (entry.kind === "Area") entry.api.update(areaDatum(point));
  else if (entry.kind === "Candlestick") entry.api.update(customCandleDatum(point));
  else entry.api.update(customBarDatum(point));
  entry.data = entry.data.length > 0 && entry.data[entry.data.length - 1]!.time === point.time
    ? [...entry.data.slice(0, -1), point]
    : [...entry.data, point];
}

export function CandleChart({
  symbol, interval, candles, dataset, trades, marketTrades, marketTradesError, priceTick, priceLines, overlays, decorations, barColors,
  markers, pineDrawings,
  live = true, fill = false, replaying = false,
  chartType = "candles",
  drawingTool = "cursor", onDrawingToolDone, drawings, onDrawingsChange,
  onDrawingSelection, onChartContextMenu, onGoToDate,
  magnet = "off", drawingsLocked = false, drawingsHidden = false,
  onPriceSelect,
  onBarSelect,
  onAxisAlert,
  replayStrip,
  onAnnotationSelect,
  compact = false,
  identity,
  onLiveBarBoundary,
  onCrosshairMove, crosshairTime,
  onVisibleRangeChange, visibleRange, followEdgeTime,
  onIndicatorPaneAction,
  canIndicatorAction,
  hiddenStudies,
  priceScale, onPriceScaleChange, resetSignal, goTo, drawingStyleFocusSignal, onDrawingSettings, paneActive,
  chartSettings,
}: {
  symbol: string;
  interval: Resolution;
  candles: Candle[];
  /**
   * What `candles` actually are, when that can differ from `symbol` and
   * `interval`: a pane keeps the previous window on screen while the next one
   * loads. Live ticks are applied only to bars of this identity, never to the
   * requested one — see `lib/liveDataset`. Omitted, the candles are taken to
   * be the requested instrument's.
   */
  dataset?: DatasetIdentity;
  trades?: Trade[];
  /** Ordered public executions used by the range/footprint presentations. */
  marketTrades?: AggregateTrade[];
  marketTradesError?: string | null;
  /** Provider-reported minimum price increment for percentage sizing. */
  priceTick?: number | null;
  /** Live SL/TP/entry levels for a running position. */
  priceLines?: ChartPriceLine[];
  /** Line series plotted by a compiled Pine script. */
  overlays?: ChartOverlay[];
  decorations?: ChartDecoration[];
  barColors?: ChartBarColor[];
  /** Bar markers plotted by compiled scripts, merged with the trade markers. */
  markers?: ChartMarker[];
  /** line/box/label/table objects created by compiled Pine scripts */
  pineDrawings?: PineDrawings | null;
  live?: boolean;
  /**
   * This pane is showing a replay rather than the market (R6 C-2).
   *
   * The only thing it drives is the `replay` watermark mode: a screenshot
   * taken during a replay has to say that it is one, and nothing else on the
   * canvas knows the difference. `live` is not the same fact — it is also
   * false for a canonical instrument that has no browser socket.
   */
  replaying?: boolean;
  /** fill the parent container instead of the fixed 520px height */
  fill?: boolean;
  // ── drawing layer (omit to disable it entirely) ──
  drawingTool?: DrawingTool;
  onDrawingToolDone?: () => void;
  drawings?: Drawing[];
  onDrawingsChange?: (next: Drawing[], gesture?: string | null) => void;
  /** Reports the drawing selection so the workspace's keyboard can act on it. */
  onDrawingSelection?: (id: string | null) => void;
  /** A right-click landed on the plot, with what it hit and the price under it. */
  onChartContextMenu?: (
    event: {
      x: number; y: number; drawingId: string | null; price: number | null;
      /** Which strip was clicked: the plot, the price axis, or the time axis. */
      region: "plot" | "axis" | "time";
    }
  ) => void;
  magnet?: MagnetMode;
  drawingsLocked?: boolean;
  drawingsHidden?: boolean;
  /**
   * Pick a price by clicking the chart.
   *
   * Only subscribed while a handler is supplied, so the chart behaves exactly
   * as it always has unless the caller has deliberately entered a
   * pick-a-level mode. Arming a price alert is the one thing that needs this,
   * and it needs it to be the price under the pointer rather than a number
   * typed from memory.
   */
  onPriceSelect?: (price: number) => void;
  /**
   * Pick a BAR by clicking it — Bar Replay's own arming gesture (R8-02).
   *
   * ── Why this is a second selection prop and not `onPriceSelect` ──────────
   *
   * They are different questions with different answers and different marks.
   * `onPriceSelect` asks "which price?", is answered by a y coordinate, and
   * draws nothing; this asks "which bar?", is answered by that bar's close
   * time, and draws a vertical guide down the whole plot at the bar under the
   * pointer — which is the affordance the reference uses to say the chart is
   * waiting for a bar, and which this product had no equivalent of at all. A
   * replay armed from a calendar alone is a replay nobody can start by looking
   * at the chart.
   */
  onBarSelect?: ((closeTime: number) => void) | null;
  /**
   * Arm an alert from the PRICE AXIS's own `⊕` (R8-08).
   *
   * The reference draws a 22×22 plus at the inner edge of the price scale, at
   * the crosshair's price, whenever the pointer is on the plot: the axis route
   * to an alert, and the one a user looking at a level reaches for. Passing
   * null (or omitting it) leaves the axis bare, which is what Replay does —
   * the price under the pointer is not the market.
   */
  onAxisAlert?: ((price: number) => void) | null;
  /**
   * Chrome drawn BETWEEN the time axis and the range row (R8-01).
   *
   * Bar Replay's strip, and nothing else so far. It is a slot rather than a
   * component because the replay clock is one per WORKSPACE — `app/chart/page`
   * owns the session, the speed and the horizon — while the row it has to sit
   * in belongs to this chart, under its axis and above its ranges. Rendered as
   * a sibling of the pane stack (which is where it used to live) it landed
   * BELOW the range row and took its height out of the page rather than out of
   * the panes, which is the whole of R8-01.
   */
  replayStrip?: ReactNode;
  /** Select a read-only marker or price line by its stable evidence identity. */
  onAnnotationSelect?: (id: string) => void;
  // ── pane synchronisation (split view) ──
  /** Bar time under this chart's crosshair, or null when the pointer leaves. */
  onCrosshairMove?: (time: number | null) => void;
  /**
   * Draw a crosshair at this bar time, sourced from the other pane. The panes
   * can be on different resolutions, so the time is snapped to the newest bar
   * at or before it rather than requiring an exact match.
   */
  crosshairTime?: number | null;
  /** Visible time span, emitted on scroll and zoom. */
  onVisibleRangeChange?: (range: { from: number; to: number }) => void;
  /** Adopt this exact visible span (date-range sync). */
  visibleRange?: { from: number; to: number } | null;
  /**
   * Align only the right edge to this time, keeping this pane's own zoom
   * (time sync). Ignored when `visibleRange` is driving the whole span.
   */
  followEdgeTime?: number | null;
  /**
   * Hide/settings/remove for the instance owning a non-overlay pane.
   *
   * Optional, so a chart rendered without an indicator list — the strategy
   * tester's, the split view's second pane — shows the panes with no controls
   * rather than controls that would act on somebody else's list.
   */
  onIndicatorPaneAction?: (paneId: string, action: PaneAction) => void;
  /**
   * Whether a price-pane overlay is a study the action above can move.
   *
   * The price pane's legend also carries the moving-average panel, Anchored
   * VWAPs and volume-profile drawings, none of which is in a study list. The
   * owner of those lists answers this; without an answer the legend renders
   * no actions at all rather than three that do nothing.
   */
  canIndicatorAction?: (key: string) => boolean;
  /** Applied but switched off — see `IndicatorLegend`'s `hidden`. */
  hiddenStudies?: { id: string; title: string }[];
  /**
   * The price scale's mode, if a surface outside this chart owns it.
   *
   * Omitted, the chart keeps its own — which is the normal case, because the
   * scale is a per-pane reading choice and a sixteen-pane workspace has
   * sixteen of them. The pair exists as a seam: a settings popover elsewhere
   * can drive and observe the scale without this component learning anything
   * about that popover. See `lib/priceScale`.
   */
  priceScale?: PriceScaleState;
  onPriceScaleChange?: (next: PriceScaleState) => void;
  /**
   * Bumped to reset the view from outside — the chart's context menu.
   *
   * A signal rather than a callback prop because "reset" is not a state the
   * owner can hold: fitting the time scale to the loaded bars is something the
   * chart does once, and the owner has no handle on the library's time scale.
   * Any change of value performs one reset; the initial value never does.
   */
  resetSignal?: number;
  /**
   * Scroll the view so a moment is on screen, without changing the zoom.
   *
   * TVP8: the time axis's "Go to…". `signal` is a counter rather than the time
   * itself, so asking for the same date twice still moves the chart back to it
   * — which is exactly what a user who has since panned away expects.
   */
  goTo?: { time: number; signal: number } | null;
  /**
   * Open the go-to-date dialog directly. The reference's calendar button is
   * one click; without this the button falls back to the time-axis menu,
   * which is the same dialog two clicks away.
   */
  onGoToDate?: () => void;
  /** Bumped to move focus into the selected drawing's style bar. */
  drawingStyleFocusSignal?: number;
  onDrawingSettings?: (id: string) => void;
  /** Whether this pane has the workspace's focus; gates Delete and Escape. */
  paneActive?: boolean;
  /** Per-pane visibility switches from Chart Settings. */
  chartSettings?: ChartSettings;
  /**
   * Phone layout: drop the per-series price-axis badges and shorten the
   * legend. Ten moving averages each stamp a label on the scale, which on a
   * 390px screen covers most of the price column.
   */
  compact?: boolean;
  /**
   * What this chart IS, rendered at the top of the chart's own legend column.
   *
   * A slot rather than more props because the pane owns both the state and the
   * controls — its symbol dialog, its timeframe picker, its comparison — and
   * this component owns only where they sit relative to the readouts it stacks
   * beneath them. Supplying it also suppresses the symbol and interval in the
   * OHLC row, so they are named once.
   */
  identity?: ReactNode;
  /** Completed + newly-forming bars, emitted once per live bar boundary. */
  onLiveBarBoundary?: (closed: Candle | null, current: Candle) => void;
  /**
   * How the main price series is drawn. Presentation only — the candles, the
   * indicators, the drawings and the alerts are untouched by it.
   */
  chartType?: ChartType;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<MainSeriesApi | null>(null);
  /** Which presentation `seriesRef` currently holds, for the typed writes. */
  const mainKindRef = useRef<ChartType>(chartType);
  /**
   * Set when the main series has just been recreated, so the data effect
   * repaints the whole history into it instead of taking the `update()` path
   * that assumes the previous series is still on screen.
   */
  const mainSeriesDirtyRef = useRef(true);
  /*
   * TVP8: which TRANSFORM the chart last drew, so a change of time base can
   * refit and a change of presentation cannot.
   *
   * Preserving the viewport across a presentation change is the right
   * behaviour and is why candles → bars → line does not jump: they are the
   * same bars drawn differently. Renko, Line break, Kagi and Point & figure
   * are not. Their series has a different length and a synthetic time base, so
   * the preserved range landed somewhere that series does not occupy — the
   * first thing a user saw on choosing Line break was four fifths of an empty
   * pane, with the chart perfectly correct off to the right. `reset` fixed it,
   * which is not an answer; the reference refits and so does this.
   *
   * Heikin Ashi keeps the canonical times, so it is deliberately NOT in this
   * set — switching to it holds the viewport, which is what makes it readable
   * as the same chart smoothed.
   */
  const drawnTypeRef = useRef<ChartType | null>(null);
  /**
   * Chart-only transform state. `headRef` is the fold over every closed bar;
   * `displayRef` is what is currently drawn, so the next update can be planned
   * against it. Both are null/empty whenever the canonical candles are being
   * drawn directly.
   */
  const transformHeadRef = useRef<TransformHead | null>(null);
  const displayRef = useRef<OhlcBar[]>([]);
  /**
   * Whether the volume histogram currently holds data. Renko has no time axis
   * of its own, so per-bar volume cannot be drawn under it truthfully and is
   * omitted; this remembers to put it back on the way out.
   */
  const volumeDrawnRef = useRef(false);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  /**
   * The newest bar time the VOLUME series has been given.
   *
   * The price series has had `mainHeadRef` since the first half of this crash
   * family was repaired; volume had nothing, and it has the same two writers —
   * the data effect and the live-tick path — so it has the same way of being
   * handed a bar it is already past. Tracked here rather than inferred, because
   * `setData` moves the head backwards on purpose and `update` may not.
   */
  const volHeadRef = useRef<number | null>(null);
  const overlayRefs = useRef<Map<string, OverlaySeriesEntry>>(new Map());
  const paneChartRefs = useRef<Map<string, IChartApi>>(new Map());
  const datasetKeyRef = useRef<string | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  /** Which dataset a tick may touch; holds a foreign tick until its data lands. */
  const tickGateRef = useRef(new LiveTickGate<KlineTick>());
  /** The live tick writer, so a held tick can be applied once its dataset lands. */
  const applyTickRef = useRef<((tick: KlineTick) => void) | null>(null);
  const heldSymbol = dataset?.symbol ?? symbol;
  const heldInterval = dataset?.interval ?? interval;
  const barColorRef = useRef<Map<number, string>>(new Map());
  const timeIndexRef = useRef<Map<number, number>>(new Map());
  const hoverTimeRef = useRef<number | null>(null);
  /**
   * Callback refs. The chart is created once in an effect that must not
   * re-run when a parent re-renders with a new closure, so the subscriptions
   * read through these instead of capturing the props directly.
   */
  const onCrosshairRef = useRef(onCrosshairMove);
  onCrosshairRef.current = onCrosshairMove;
  const onRangeRef = useRef(onVisibleRangeChange);
  onRangeRef.current = onVisibleRangeChange;
  const onLiveBoundaryRef = useRef(onLiveBarBoundary);
  onLiveBoundaryRef.current = onLiveBarBoundary;
  /** Set while applying a range from the other pane, to break the feedback loop. */
  const applyingRangeRef = useRef(false);
  /** Timers that clear `applyingRangeRef`, cancelled if the pane goes first. */
  const rangeReleaseRef = useRef<number[]>([]);
  /** The last span published upwards, so an unchanged one is not republished. */
  const publishedRangeRef = useRef<{ from: number; to: number } | null>(null);
  /** Live once the chart exists; false again the moment it is destroyed. */
  const disposalRef = useRef<{ disposed: boolean }>({ disposed: true });
  /** Internal price/indicator-pane range propagation, throttled to one frame. */
  const syncingPaneRangeRef = useRef(false);
  const syncPaneRangesRef = useRef<(source: string, range: { from: number; to: number }) => void>(() => {});
  const [legend, setLegend] = useState<LegendBar | null>(null);
  /**
   * The price scale, when nothing outside owns it.
   *
   * An ordinary workspace passes a controlled value that is persisted per
   * pane. The internal value remains for standalone chart consumers such as
   * previews and test fixtures. In either case it survives candle updates and
   * series recreation because the applying effect re-runs on `chartReady`.
   */
  const [ownPriceScale, setOwnPriceScale] = useState<PriceScaleState>(DEFAULT_PRICE_SCALE);
  /** Which range shortcut produced the current viewport, if one did. */
  const [activeRange, setActiveRange] = useState<RangeShortcutId | null>(null);
  /** The window a shortcut asked for, so a pan away from it clears the badge. */
  const shortcutRangeRef = useRef<{ from: number; to: number } | null>(null);
  /** Layout of the indicator stack: order, collapse, heights, maximise. */
  const [paneLayout, setPaneLayout] = useState<PaneLayoutState>(EMPTY_PANE_LAYOUT);
  /** A live UTC clock beside the time axis; only mounted when it is shown. */
  const [clock, setClock] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [indicatorHoverTime, setIndicatorHoverTime] = useState<number | null>(null);
  /** FE-09: what the live feed is actually doing, so the UI can say so. */
  const [feedState, setFeedState] = useState<FeedState>(IDLE_FEED);
  /** bumped once the chart/series exist, so the drawing layer can attach */
  const [chartReady, setChartReady] = useState(0);
  /** bumped only when the chart itself is (re)created, so the series effect
   *  can depend on it without re-triggering itself through `chartReady`. */
  const [chartCreated, setChartCreated] = useState(0);
  /**
   * Bumped on a theme change, so the canvas can repaint what CSS cannot reach.
   *
   * `subscribeChartTheme` re-applies the chart-level options (grid, crosshair,
   * axis text), but a series' colours are baked into its data: the volume
   * histogram carries one colour PER BAR, and no amount of `applyOptions` will
   * change bars that are already drawn. So the theme also marks the main
   * series dirty, which makes the data effect below take its `replace` path
   * and hand the histogram a freshly coloured set.
   */
  /**
   * The newest bar time the MAIN SERIES holds — see `updateMainSeries`.
   *
   * A ref rather than state: it is written from an effect and from a websocket
   * frame, and nothing renders from it.
   */
  const mainHeadRef = useRef<number | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const onTheme = (): void => {
      mainSeriesDirtyRef.current = true;
      setThemeTick((tick) => tick + 1);
    };
    window.addEventListener("trading-scene-theme", onTheme);
    return () => window.removeEventListener("trading-scene-theme", onTheme);
  }, []);
  const groupedOverlays = useMemo(
    () => groupChartOverlays(overlays ?? [], decorations ?? []),
    [overlays, decorations]
  );

  // ── the price scale ──────────────────────────────────────────────────────

  /** Controlled if a caller supplied one; this chart's own otherwise. */
  const scale = priceScale ?? ownPriceScale;
  /*
   * The fallback is the model's own default rather than an object literal
   * repeated here. The literal it replaces had already drifted once and would
   * have drifted again the moment a field was added.
   */
  const settings = chartSettings ?? DEFAULT_CHART_SETTINGS;
  /* Read out so the precision effect can depend on the value rather than on
     the whole settings object, which changes identity on every keystroke. */
  const precision = settings.precision;
  /*
   * ── TVP8 F-03-R ───────────────────────────────────────────────────────────
   *
   * While the countdown is on, the last-price plate is drawn by ONE object —
   * `BarCountdownPrimitive`, which owns both rows — and the series' own chip
   * stands down. Two labels the library colours and sizes independently can
   * never be one plate: the chip takes `priceLineColor`, the countdown took
   * the bar's direction, and each sized itself to its own text, so the
   * countdown overhung the price by 19px.
   *
   * In EVERY scale mode (F-03-R2). The price row's text is not the
   * primitive's to decide: it formats through `lib/priceAxisText`, which
   * derives what the axis itself would print — grouped through this chart's
   * `localization.priceFormatter` in Regular and Logarithmic, the percentage
   * of the first visible close in Percentage, the indexed value in
   * Indexed-to-100 — from the same public state the axis formats from. So no
   * mode is excepted, and no mode leaves the library's chip on the price
   * coordinate under a row of ours.
   */
  const countdownOwnsChip = settings.countdownToBarClose;
  /*
   * The decimals the price AXIS labels with.
   *
   * A ref because the chart — and with it the `localization.priceFormatter`
   * closure below — is created once, while the precision behind it changes
   * with the setting and with the instrument's tick. The effect that applies
   * `priceFormat` to the series writes this at the same time, so the axis and
   * the series are formatted from one decision instead of two.
   */
  const axisDigitsRef = useRef(2);
  /*
   * Just the five numbers the display transforms read.
   *
   * The data effects must re-run when a Renko period changes and must NOT
   * re-run when a grid line is toggled — depending on the whole settings
   * object would rebuild every bar on any edit, and depending on nothing was
   * how these parameters stayed unreachable in the first place.
   */
  const transformSettings = useMemo(() => ({
    renkoAtrPeriod: settings.renkoAtrPeriod,
    lineBreakLines: settings.lineBreakLines,
    kagiReversalPercent: settings.kagiReversalPercent,
    pnfBoxPercent: settings.pnfBoxPercent,
    pnfReversalBoxes: settings.pnfReversalBoxes,
  }), [settings.renkoAtrPeriod, settings.lineBreakLines, settings.kagiReversalPercent,
    settings.pnfBoxPercent, settings.pnfReversalBoxes]);
  /*
   * TVP8: the live path reads these through a ref.
   *
   * `transformSettings` was in the market-feed effect's dependency array, so
   * nudging the Renko ATR period or the P&F box size tore down the websocket
   * and opened a new one — the exact churn the rule beside that array forbids,
   * and it survived because the guard in `tests/uiContract.test.ts` matched the
   * lowercase word `settings` against `transformSettings` and found nothing.
   *
   * The value is presentation: it changes how a tick is DRAWN, never which
   * stream it comes from.
   */
  const transformSettingsRef = useRef(transformSettings);
  useEffect(() => { transformSettingsRef.current = transformSettings; }, [transformSettings]);
  /**
   * Why this presentation is drawing nothing, or null when it is fine.
   *
   * One function rather than a condition per type, so a presentation added
   * later cannot quietly join the set that fails in silence.
   */
  const chartUnavailable = useMemo((): string | null => {
    const tickKnown = priceTick !== null && priceTick !== undefined && priceTick > 0;
    const trades = marketTrades?.length ?? 0;
    if (chartType === "footprint") {
      if (marketTradesError) return marketTradesError;
      if (!tickKnown) return "Volume footprint unavailable: provider tick size is not known.";
      if (trades === 0) return "Volume footprint has no executions in the requested window.";
      return null;
    }
    if (chartType === "range") {
      if (marketTradesError) return marketTradesError;
      if (!tickKnown) return "Range bars unavailable: provider tick size is not known.";
      if (trades === 0) return "Range bars have no executions in the requested window.";
      return null;
    }
    if (chartType === "kagi" && !tickKnown) {
      return "Kagi unavailable: provider tick size is not known.";
    }
    if (chartType === "pointAndFigure" && !tickKnown) {
      return "Point & Figure unavailable: provider tick size is not known.";
    }
    return null;
  }, [chartType, priceTick, marketTrades, marketTradesError]);

  /*
   * ── What a footprint chart owes the reader about its own coverage ────────
   *
   * The cells come from the public execution tape, which reaches back only as
   * far as the provider will page: about two hours of BTC at the 50,000-row
   * ceiling, and the window is requested as the last thirty minutes. Older
   * bars are drawn as ordinary exchange OHLC — truthfully, and never with an
   * inferred cell — but a reader cannot tell a bar with no order flow from a
   * bar whose order flow is simply out of reach unless the pane says which.
   *
   * So it says which, in bars rather than in prose about windows, because the
   * bar count is what the reader is looking at. It is not routed through
   * `syntheticDisclosure`: nothing here is a synthetic PRICE, and that chip
   * means something else.
   */
  const footprintCoverage = useMemo((): { withTape: number; total: number } | null => {
    if (chartType !== "footprint" || chartUnavailable) return null;
    if (!(priceTick !== null && priceTick !== undefined && priceTick > 0)) return null;
    if (candles.length === 0) return null;
    const covered = footprintCoveredTimes(marketTrades ?? [], Math.max(60_000, resolutionMs(interval)));
    if (covered.size === 0) return null;
    const withTape = candles.reduce((n, c) => covered.has(c.openTime) ? n + 1 : n, 0);
    return withTape >= candles.length ? null : { withTape, total: candles.length };
  }, [chartType, chartUnavailable, priceTick, candles, marketTrades, interval]);

  /*
   * ── R6 T-1 / A-1: three things that were one switch ──────────────────────
   *
   * `showTrading` gated the position and order LINES, the execution ARROWS and
   * their labels together, and it also emptied the alert levels that travel in
   * the same array. They are three rows in two tabs of the reference, because
   * they are three different things on the chart: a level you are managing, a
   * mark saying a trade happened, and a level you are waiting for.
   */
  const visiblePriceLines = useMemo(() => (priceLines ?? []).filter((line) =>
    line.kind === "alert" ? settings.showAlertLines : settings.showTrading
  ), [settings.showTrading, settings.showAlertLines, priceLines]);
  const visibleTrades = useMemo(() => settings.showExecutionMarks ? (trades ?? []) : [],
    [settings.showExecutionMarks, trades]);
  const visibleMarkers = useMemo(() => (markers ?? []).filter((marker) =>
    marker.category === "alert" ? settings.showAlerts : settings.showEvents
  ), [settings.showAlerts, settings.showEvents, markers]);
  /*
   * R6 SC-4: the best bid and the best ask, as two levels on the plot.
   *
   * The socket is `lib/useBookQuote`'s — the same one the manual ticket reads,
   * shared through `lib/marketStream`'s registry, so a pane showing the levels
   * costs no second connection. It is opened ONLY while the setting asks for
   * them: a quote feed nobody is looking at is a socket nobody asked for, and
   * the row that turns this on is itself only offered once the feed has
   * answered. A canonical instrument has no browser book stream, and a pane
   * under replay is not showing the market, so neither subscribes.
   */
  const bookQuote = useBookQuote(
    settings.bidAskLines === "line" && live && !isCanonicalInstrumentId(symbol) ? symbol : "");
  /*
   * R6 SL-3: the instrument's 24h change, for the status line's last row.
   *
   * The same contract the watchlist reads — a seed through this app's own
   * server and then the mini-ticker stream — so the number beside the bar
   * change is the same number the watchlist row prints, not a second
   * derivation of it. Off by default, as the reference's `Last day change
   * values` is, and subscribed only when it is on: an empty symbol list makes
   * `useWatchlistTickers` open nothing and ask for nothing.
   */
  const dayChangeSymbols = useMemo(
    () => settings.showStatusLine && settings.statusDayChange ? [symbol] : [],
    [settings.showStatusLine, settings.statusDayChange, symbol]);
  const { tickers: dayTickers } = useWatchlistTickers(dayChangeSymbols);
  /**
   * The 24h figure, or null when this feed does not supply one.
   *
   * `changeKnown` is the contract's own flag for "a last price arrived but no
   * open did" — a provider snapshot without a 24h open. The legend renders
   * NOTHING in that case: a dash beside a real bar change reads as a change of
   * zero, which is a number the feed never said.
   */
  const dayChange = useMemo(() => {
    const row = dayTickers[symbol] ?? dayTickers[symbol.toUpperCase()];
    return row && row.changeKnown !== false && Number.isFinite(row.chgPct)
      ? { chg: row.chg, chgPct: row.chgPct, last: row.last } : null;
  }, [dayTickers, symbol]);
  const applyScale = useCallback((next: PriceScaleState) => {
    setOwnPriceScale(next);
    onPriceScaleChange?.(next);
  }, [onPriceScaleChange]);
  /**
   * First close in view, for the baseline presentation.
   *
   * `baselineRef` seeds the series at creation; `baselineAppliedRef` records
   * what has actually been applied, so the data effect can re-anchor when the
   * dataset changes and skip the call when it has not.
   */
  const baselineRef = useRef(0);
  baselineRef.current = candles[0]?.close ?? baselineRef.current;
  const baselineAppliedRef = useRef<number | null>(null);

  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const applyScaleRef = useRef(applyScale);
  applyScaleRef.current = applyScale;

  /**
   * Bring our record of the scale back into line with the library's.
   *
   * Dragging the price axis and double-clicking it are the library's own
   * behaviours — `handleScale.axisPressedMouseMove.price` and
   * `axisDoubleClickReset.price`, both on by default and both deliberately
   * left alone rather than reimplemented. Neither raises an event, and the
   * first of them switches `autoScale` off. Without this the badge would keep
   * claiming "Auto" over a scale the user had dragged, and the next time the
   * state was re-applied the drag would be silently thrown away.
   */
  /** Which axis the series is on, for the callbacks that run outside render. */
  const scalePlacementRef = useRef(settings.scalePlacement);
  scalePlacementRef.current = settings.scalePlacement;

  const reconcileScaleRef = useRef<() => void>(() => {});
  reconcileScaleRef.current = () => {
    const chart = chartRef.current;
    if (!chart) return;
    let auto: boolean;
    // The same axis the effect below writes to — see `scalePlacement` there.
    const side = scalePlacementRef.current === "left" ? "left" : "right";
    try { auto = chart.priceScale(side).options().autoScale; }
    catch { return; }
    if (auto !== scaleRef.current.autoScale) {
      applyScaleRef.current(setPriceScaleAuto(scaleRef.current, auto));
    }
  };

  /*
   * Apply the scale to the chart.
   *
   * Keyed on `chartReady`, which is bumped when the chart is created AND when
   * the main series is swapped for a presentation change — the two moments a
   * price scale can lose what it was told. A candle arriving is neither, so a
   * live update cannot reset the scale; and nothing here recreates a chart to
   * change a mode.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    /*
     * TVP8 round two: the axis the SERIES is bound to.
     *
     * This always wrote to `"right"`. With "Scales placement: left" the series
     * is bound to the left axis (see the effect below), so Logarithmic,
     * Percent, Auto scale and Invert were being applied to an axis nothing was
     * on: three switches in the settings dialog and four items in the axis
     * context menu, all silently inert, in one of the dialog's own modes.
     */
    const side = settings.scalePlacement === "left" ? "left" : "right";
    try {
      chart.priceScale(side).applyOptions({
        mode: LIBRARY_SCALE_MODE[scale.mode],
        autoScale: scale.autoScale,
        invertScale: scale.invert === true,
      });
    } catch { /* the chart went away between render and effect */ }
  }, [scale, settings.scalePlacement, chartReady]);

  /**
   * Chart-level settings, applied to the engine.
   *
   * TVP7 widened this from two switches to the set the reference's Canvas and
   * Scales tabs actually offer. Every option below is one lightweight-charts
   * already supports; the ones it does not — locking the price-to-bar ratio,
   * suppressing overlapping axis labels — are deliberately not in the model,
   * because a switch that moves nothing is worse than an absent one.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const placement = settings.scalePlacement;
    chart.applyOptions({
      /*
       * R6 C-4: the axis's own type, as the reference's `Scales / Text` row
       * offers it. An empty colour is the theme's own, which is what every
       * chart had before the control existed — so the token keeps deciding
       * unless the user has said otherwise.
       */
      layout: {
        fontSize: settings.scaleFontSize,
        ...(settings.scaleTextColor ? { textColor: settings.scaleTextColor } : {}),
      },
      /*
       * TVP8: the grid and the crosshair had one on/off switch each and no
       * appearance at all, while the tab they live under is the one the
       * reference gives colour, width and style for. An empty colour means
       * "the theme's own", which is what every chart had before these existed
       * and what Reset returns them to — so the theme keeps deciding unless
       * the user has said otherwise.
       */
      /*
       * R6 C-1: one appearance for two directions was one too few.
       *
       * `gridColor` / `gridStyle` were applied to BOTH sets, so a chart could
       * not have a faint horizontal grid and no vertical one — which is the
       * ordinary way to read a price chart and what the reference's two
       * line-style buttons are for. The shared pair stays in the model as the
       * seed these four migrate from (`normalizeChartSettings`); nothing
       * writes it any more, and nothing reads it here.
       */
      grid: {
        vertLines: {
          visible: settings.gridVertical,
          ...(settings.gridVertColor ? { color: settings.gridVertColor } : {}),
          style: lineStyleOf(settings.gridVertStyle),
        },
        horzLines: {
          visible: settings.gridHorizontal,
          ...(settings.gridHorzColor ? { color: settings.gridHorzColor } : {}),
          style: lineStyleOf(settings.gridHorzStyle),
        },
      },
      crosshair: {
        mode: settings.showCrosshair ? CrosshairMode.Normal : CrosshairMode.Hidden,
        vertLine: {
          width: settings.crosshairWidth as 1 | 2 | 3 | 4,
          style: lineStyleOf(settings.crosshairStyle),
          ...(settings.crosshairColor ? { color: settings.crosshairColor } : {}),
        },
        horzLine: {
          width: settings.crosshairWidth as 1 | 2 | 3 | 4,
          style: lineStyleOf(settings.crosshairStyle),
          ...(settings.crosshairColor ? { color: settings.crosshairColor } : {}),
        },
      },
      /*
       * TVP8: the instrument's name behind the bars, as the reference draws
       * it. Off by default — it is the one canvas control that changes what a
       * screenshot of this chart SAYS it is, which is most of what it is for.
       */
      /*
       * R6 C-2: a MODE, not a switch.
       *
       * `replay` is the one the reference has and this product had no way to
       * express: the watermark appears only while the pane is replaying, so a
       * screenshot taken during a replay says that it is one and an ordinary
       * chart carries nothing. `hidden` and `symbol` are the old boolean's two
       * states, and `normalizeChartSettings` migrates it into them.
       */
      watermark: {
        visible: settings.watermarkMode === "replay" ? replaying : settings.watermark,
        text: displayTicker(symbol),
        color: settings.watermarkColor || chartWatermarkColor(),
        fontSize: 64,
        horzAlign: "center",
        vertAlign: "center",
      },
      /*
       * R6 C-4: the axis's own hairline. `borderColor` is per-scale, so the
       * one control writes the price scale on both sides and the time scale —
       * which is what the reference's single `Scales / Lines` swatch does.
       */
      rightPriceScale: {
        visible: placement === "right" || placement === "both",
        alignLabels: settings.noOverlappingLabels,
        ...(settings.scaleLineColor ? { borderColor: settings.scaleLineColor } : {}),
      },
      leftPriceScale: {
        visible: placement === "left" || placement === "both",
        alignLabels: settings.noOverlappingLabels,
        ...(settings.scaleLineColor ? { borderColor: settings.scaleLineColor } : {}),
      },
      // `both` shows the axis on both sides; which side the SERIES is bound to
      // is the effect below, because hiding an axis does not move anything.

      timeScale: {
        rightOffset: settings.rightOffsetBars,
        timeVisible: true,
        ...(settings.scaleLineColor ? { borderColor: settings.scaleLineColor } : {}),
        /*
         * R6 SC-5(d): `Mon 29`, not `29`.
         *
         * Only the DAY-boundary tick is touched; every other weight — the
         * year, the month, the intraday times — returns `null`, which is the
         * library's own "you format it" and keeps `localization.dateFormat`
         * and the 12/24-hour choice above authoritative over the rest of the
         * axis.
         *
         * R6b-13: OFF is a FUNCTION, never `undefined`. The library merges
         * options with a spread, so `tickMarkFormatter: undefined` overwrote
         * nothing and the ON formatter stayed installed for ever — the row
         * was inert on every chart that had ever had it on, which (the
         * default being ON) is every chart.
         */
        tickMarkFormatter: axisTickFormatter(
          settings.dayOfWeekOnLabels, settings.timeFormat24h, settings.timeZone),
      },
      localization: {
        /*
         * TVP8 round two: the axis groups its thousands, like the legend does.
         *
         * The scale printed `80400.00` while the OHLC readout two inches away
         * printed `77,991.22` and every menu printed `76,845.50` — the same
         * number in two typographies on one screen, and the reference groups
         * its axis too. The library's default formatter is `toFixed`; this is
         * the product's own `fmtPrice`, so there is one answer to "how is a
         * price written here".
         *
         * TVP8 continuation: this formatter REPLACES the series `priceFormat`
         * on the axis rather than post-processing it, which the comment here
         * used to claim it did. `fmtPrice` reads the magnitude of each NUMBER
         * it is handed — `abs >= 100 ? 2 : abs >= 1 ? 4 : 6` — so a SOL scale
         * spanning 60 to 170 printed `170.00` four rows above `90.0000`: two
         * precisions on one axis, on one instrument, against a real feed.
         *
         * The decimals are a property of the INSTRUMENT, so the axis is told
         * them. `axisDigitsRef` is written by the effect that applies
         * `priceFormat` to the series, which is what keeps the two in step and
         * keeps the Symbol tab's control authoritative over both.
         */
        priceFormatter: (price: number) => fmtPriceAt(price, axisDigitsRef.current),
        /*
         * 12-hour labels are built here rather than left to the library: its
         * `timeVisible` formatter is 24-hour and takes no locale. The date
         * half is left alone so the axis keeps the library's own density
         * decisions about when to show a day, a month or a year.
         *
         * R6b-14: BOTH states are a function. `timeFormatter: undefined` was
         * ignored by the same option merge as the tick formatter above, so
         * going back to 24-hours left the 12-hour formatter installed — the
         * row moved once, in one direction, and never again. `lib/chartClock`
         * owns the pair, because the visible axis is not always this chart's.
         */
        timeFormatter: hoursFormatter(settings.timeFormat24h, settings.timeZone),
        // TVP8: the reference offers five, and a reader who writes dates
        // day-first should not have to read an axis that writes them
        // month-first. `dateFormat` is a library option, so this is one line.
        dateFormat: settings.dateFormat,
      },
    });
  }, [
    settings.gridVertical, settings.gridHorizontal, settings.showCrosshair,
    settings.scaleFontSize, settings.scalePlacement, settings.rightOffsetBars,
    settings.timeFormat24h, settings.gridVertColor, settings.gridVertStyle,
    settings.gridHorzColor, settings.gridHorzStyle,
    settings.crosshairColor, settings.crosshairWidth, settings.crosshairStyle,
    settings.watermark, settings.watermarkMode, settings.watermarkColor, replaying,
    settings.scaleTextColor, settings.scaleLineColor, settings.dayOfWeekOnLabels,
    settings.noOverlappingLabels,
    settings.dateFormat, settings.timeZone, symbol, chartReady,
    /*
     * TVP8 round two: and on a theme change.
     *
     * `subscribeChartTheme` re-applies the whole of `baseChartOptions()` when
     * the root theme flips, which silently reverted seven of the controls
     * above — grid colour and style, all three crosshair fields, the axis font
     * size and the watermark — while the settings dialog went on showing the
     * user's values. Re-running here puts the user's choices back on top of
     * the theme's, which is the order they were always meant to be in.
     */
    themeTick,
  ]);

  /**
   * Which SIDE the price series is bound to.
   *
   * The effect above turns the axes on and off, and that is all it ever did:
   * `leftPriceScale.visible` draws an axis, it does not move anything onto it.
   * The main series never declared a `priceScaleId`, so it stayed on the
   * library's default `"right"` — and choosing Left therefore hid the only
   * scale the candles were attached to and revealed an empty one on the other
   * side. A control that does the opposite of its label is worse than one that
   * does nothing, and this dialog's own header forbids both.
   *
   * `priceScaleId` is in `SeriesOptionsCommon`, so it can be re-applied to a
   * live series; the library's own wording ("bind NEW series") describes the
   * default, not a restriction.
   *
   * `both` binds to the right and shows both axes. The left one then labels
   * the same visible range, which is what the reference shows; the engine
   * cannot attach one series to two scales, so it is the axis that is
   * duplicated rather than the data.
   */
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const side = settings.scalePlacement === "left" ? "left" : "right";
    try { series.applyOptions({ priceScaleId: side }); }
    catch { /* the series went away between render and effect */ }
  }, [settings.scalePlacement, chartType, chartReady]);

  /**
   * Plot margins, in percent of pane height.
   *
   * Separate from the effect above because `scaleMargins` lives on the price
   * SCALE rather than on the chart, and because the scale this applies to
   * depends on which side the axis is currently drawn.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    /*
     * IO-A8: clamped as a PAIR, because that is what the library requires.
     *
     * Each was clamped to 0.9 on its own here. The dialog allows 50 in each
     * box; fifty and fifty is 1.0; lightweight-charts refuses a sum of one or
     * more by throwing, and the `catch` below — which is there for a chart
     * that has gone away between render and effect — swallowed it. Both
     * `applyOptions` calls were skipped, so BOTH controls became inert with no
     * message, which is the one thing the settings contract forbids outright.
     */
    const margins = scaleMarginsFor(settings.marginTopPct, settings.marginBottomPct);
    try {
      // The margins belong to the axis the series is on, for the same reason.
      chart.priceScale(settings.scalePlacement === "left" ? "left" : "right")
        .applyOptions({ scaleMargins: margins });
      chart.priceScale("left").applyOptions({ scaleMargins: margins });
    } catch { /* the chart went away between render and effect */ }
  }, [settings.marginTopPct, settings.marginBottomPct, settings.scalePlacement, chartReady]);

  /** Auto-fit both axes and return the scale to its default. */
  const resetView = useCallback(() => {
    applyScale(resetPriceScale());
    shortcutRangeRef.current = null;
    setActiveRange(null);
    try { chartRef.current?.timeScale().fitContent(); }
    catch { /* nothing loaded yet */ }
  }, [applyScale]);

  /*
   * The reset signal, honoured once per change.
   *
   * The first render is not a reset: a pane that has just been restored with a
   * saved range must keep it. `useRef` seeded from the prop is what makes the
   * initial value inert.
   */
  const goToSignalRef = useRef(goTo?.signal ?? 0);
  useEffect(() => {
    const signal = goTo?.signal ?? 0;
    if (signal === goToSignalRef.current || !goTo) return;
    goToSignalRef.current = signal;
    const chart = chartRef.current;
    if (!chart) return;
    try {
      // Keep the span the user is on and move it, rather than framing an
      // arbitrary window around the date: "go to" is a scroll, not a zoom.
      const current = chart.timeScale().getVisibleRange();
      const span = current ? Number(current.to) - Number(current.from) : 0;
      const centre = Math.floor(goTo.time / 1000);
      if (span > 0) {
        chart.timeScale().setVisibleRange({
          from: (centre - span / 2) as UTCTimestamp,
          to: (centre + span / 2) as UTCTimestamp,
        });
      }
    } catch { /* the range is not loaded; the view stays where it is */ }
  }, [goTo]);

  const onChartContextMenuRef = useRef(onChartContextMenu);
  onChartContextMenuRef.current = onChartContextMenu;

  /*
   * ── TVP8: the lines the "Scales and lines" tab is named for ──────────────
   *
   * That tab had seven controls and every one of them was a SCALE. The
   * reference's equivalent is mostly about lines: the dashed last-price line
   * running back across the plot, the price tag on the scale, and the colour,
   * width and style of each. All three are series options here, so the
   * controls are real rather than decorative — which is the standard
   * `lib/chartSettings.ts` sets for adding one at all.
   *
   * Applied in an effect rather than at creation because a settings change
   * must not rebuild the series: rebuilding is a remount, and a remount is the
   * flicker this chart is built to avoid.
   */
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    try {
      series.applyOptions({
        priceLineVisible: settings.lastValueLine,
        priceLineColor: settings.lastValueLineColor,
        priceLineWidth: settings.lastValueLineWidth as 1 | 2 | 3 | 4,
        priceLineStyle: lineStyleOf(settings.lastValueLineStyle),
        // F-03-R: off while `BarCountdownPrimitive` draws the price row, so
        // the plate has one colour and one width instead of the chip's and
        // the countdown's.
        lastValueVisible: settings.lastValueLabel && !countdownOwnsChip,
      });
    } catch { /* the series went away between render and effect */ }
  }, [
    settings.lastValueLine, settings.lastValueLineColor, settings.lastValueLineWidth,
    settings.lastValueLineStyle, settings.lastValueLabel, countdownOwnsChip,
    chartType, chartReady,
  ]);

  /*
   * TVP8: the canvas ground.
   *
   * Transparent by default, so the pane's own surface shows through and the
   * theme keeps deciding — that is what every chart had and it is the right
   * default. The gradient is the reference's, and it is the one canvas choice
   * that changes how a chart reads in a screenshot.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      /*
       * R6 C-2: the ground has a colour of its own.
       *
       * `""` is transparent — the pane's own surface shows through and the
       * theme keeps deciding, which is what every chart had and is still the
       * default. A chosen colour is the solid ground, or the TOP of the
       * gradient with the pane showing through beneath it, so the two
       * controls in that row compose instead of one cancelling the other.
       */
      const ground = settings.backgroundColor || "rgba(0,0,0,0)";
      /*
       * R6b-18: the gradient has two wells and both ends are real.
       *
       * It used to be 6% of accent blue over transparent — three points of
       * luminance across the whole plot, i.e. a dropdown option that moved
       * nothing a user could see. `resolveBackgroundGradient` derives the
       * theme pair from the surface and the ink instead, and the second well
       * is the reference's own second well.
       */
      const gradient = resolveBackgroundGradient(
        settings.backgroundColor, settings.backgroundColor2);
      chart.applyOptions({
        layout: settings.backgroundGradient
          ? {
              background: {
                type: ColorType.VerticalGradient,
                topColor: gradient.top,
                bottomColor: gradient.bottom,
              },
            }
          : { background: { type: ColorType.Solid, color: ground } },
      });
    } catch { /* disposed */ }
    // The theme rewrites `layout.background`; the user's choice goes back on top.
  }, [
    settings.backgroundGradient, settings.backgroundColor, settings.backgroundColor2,
    chartReady, themeTick,
  ]);

  const resetSignalRef = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === resetSignalRef.current) return;
    resetSignalRef.current = resetSignal;
    resetView();
  }, [resetSignal, resetView]);

  syncPaneRangesRef.current = (source, range) => {
    if (syncingPaneRangeRef.current || disposalRef.current.disposed) return;
    syncingPaneRangeRef.current = true;
    const targets: Array<[string, IChartApi]> = [
      ...(chartRef.current ? [["price", chartRef.current] as [string, IChartApi]] : []),
      ...paneChartRefs.current,
    ];
    for (const [id, chart] of targets) {
      if (id === source) continue;
      try {
        chart.timeScale().setVisibleRange({
          from: range.from as UTCTimestamp, to: range.to as UTCTimestamp,
        });
      } catch { /* the target has not loaded this range yet */ }
    }
    requestAnimationFrame(() => { syncingPaneRangeRef.current = false; });
  };

  /** Publish a span upwards, unless it is the one already published. */
  const publishRange = useCallback((range: { from: number; to: number }) => {
    if (!rangeChanged(publishedRangeRef.current, range)) return;
    publishedRangeRef.current = range;
    onRangeRef.current?.(range);
  }, []);

  /**
   * Release `applyingRangeRef` after the library has emitted its own change
   * event, and remember the timer so a pane that closes first can cancel it.
   */
  const releaseAppliedRange = useCallback(() => {
    const timer = window.setTimeout(() => {
      applyingRangeRef.current = false;
      rangeReleaseRef.current = rangeReleaseRef.current.filter((t) => t !== timer);
    }, 0);
    rangeReleaseRef.current.push(timer);
  }, []);

  const registerIndicatorPane = useCallback((id: string, chart: IChartApi | null) => {
    if (!chart) {
      paneChartRefs.current.delete(id);
      return;
    }
    paneChartRefs.current.set(id, chart);
    const current = chartRef.current?.timeScale().getVisibleRange();
    if (current && typeof current.from === "number" && typeof current.to === "number") {
      try { chart.timeScale().setVisibleRange(current); } catch { /* data is landing */ }
    }
  }, []);

  const indicatorPaneRange = useCallback((id: string, range: { from: number; to: number }) => {
    if (!syncingPaneRangeRef.current) syncPaneRangesRef.current(id, range);
  }, []);

  const indicatorPaneHover = useCallback((time: number | null) => {
    setIndicatorHoverTime((current) => current === time ? current : time);
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    if (time === null) {
      chart.clearCrosshairPosition();
      return;
    }
    const list = candlesRef.current;
    const index = snapToBarIndexBy(list, time, (bar) => bar.openTime / 1000);
    if (index < 0) {
      chart.clearCrosshairPosition();
      return;
    }
    const bar = list[index]!;
    chart.setCrosshairPosition(bar.close, (bar.openTime / 1000) as UTCTimestamp, series);
  }, []);

  /**
   * The readout for one bar, taken from whichever series is actually drawn.
   *
   * `canonicalIndex` indexes the exchange candles and `displayIndex` the
   * transform output; a caller supplies whichever it knows and this resolves
   * the rest. The two are the same number for Heikin Ashi, which emits one bar
   * per canonical bar, and unrelated for Renko, which emits bricks.
   */
  const buildLegend = useCallback(
    (canonicalIndex: number, displayIndex: number): LegendBar | null => {
      const kind = legendSource(mainKindRef.current);
      const list = candlesRef.current;
      if (kind === "tradeBar") {
        const trade = displayRef.current[displayIndex];
        if (!trade) return null;
        const prev = displayIndex > 0 ? displayRef.current[displayIndex - 1]!.close : trade.open;
        const chg = trade.close - prev;
        return { kind, open: trade.open, high: trade.high, low: trade.low, close: trade.close,
          volume: (trade as OhlcBar & { volume?: number }).volume ?? null, chg,
          chgPct: prev !== 0 ? chg / prev * 100 : 0 };
      }
      if (kind === "canonical") {
        const c = list[canonicalIndex];
        if (!c) return null;
        const prevClose = canonicalIndex > 0 ? list[canonicalIndex - 1]!.close : c.open;
        const chg = c.close - prevClose;
        return {
          kind, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
          chg, chgPct: prevClose !== 0 ? (chg / prevClose) * 100 : 0,
        };
      }
      const display = displayRef.current;
      const bar = display[displayIndex];
      if (!bar) return null;
      const prevClose = displayIndex > 0 ? display[displayIndex - 1]!.close : bar.open;
      const chg = bar.close - prevClose;
      const chgPct = prevClose !== 0 ? (chg / prevClose) * 100 : 0;
      if (kind === "heikinAshi") {
        // The body on screen, described by its own numbers — and the canonical
        // traded volume, which the transform has not touched and must not
        // pretend to have.
        const canonical = list[canonicalIndex];
        return {
          kind, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          volume: canonical ? canonical.volume : null, chg, chgPct,
        };
      }
      if (kind === "pointFigureColumn") {
        if (!isPointFigureColumn(bar)) return null;
        return {
          kind, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          volume: null, chg, chgPct,
          brick: { direction: bar.direction, size: bar.boxSize, sourceOpenTime: bar.sourceOpenTime },
        };
      }
      if (kind === "kagiPoint" || kind === "lineBreakLine") {
        return {
          kind, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          volume: null, chg, chgPct,
        };
      }
      // Renko. A brick has an open and a close and nothing else that a candle
      // readout would name: its "high" and "low" are the same two numbers, it
      // spans no period, and it has no volume. So the renderer is given the
      // brick itself and prints a brick, not a fabricated OHLC row.
      if (!isRenkoBrick(bar)) return null;
      return {
        kind, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: null, chg, chgPct,
        brick: { direction: bar.direction, size: bar.size, sourceOpenTime: bar.sourceOpenTime },
      };
    }, []);

  /** The drawn bar standing for a canonical bar, or -1 when there is none. */
  const displayIndexFor = useCallback((canonicalIndex: number): number => {
    const kind = legendSource(mainKindRef.current);
    if (kind === "canonical") return -1;
    if (kind === "tradeBar") {
      const candle = candlesRef.current[canonicalIndex];
      return candle ? snapToBarIndexBy(displayRef.current, Math.floor(candle.openTime / 1000),
        (bar) => Math.floor(bar.openTime / 1000)) : -1;
    }
    if (kind === "heikinAshi") return canonicalIndex;
    const candle = candlesRef.current[canonicalIndex];
    if (!candle) return -1;
    return snapToBarIndexBy(
      displayRef.current, Math.floor(candle.openTime / 1000),
      (bar) => Math.floor(canonicalOpenTime(bar) / 1000)
    );
  }, []);

  const legendAtCanonical = useCallback((i: number): LegendBar | null =>
    buildLegend(i, displayIndexFor(i)), [buildLegend, displayIndexFor]);

  /** The readout shown when the pointer is not on the plot: the newest bar. */
  const latestLegend = useCallback((): LegendBar | null => {
    const n = candlesRef.current.length;
    if (n === 0) return null;
    if (legendSource(mainKindRef.current) !== "canonical" && legendSource(mainKindRef.current) !== "heikinAshi") {
      const last = displayRef.current.length - 1;
      return last < 0 ? null : buildLegend(n - 1, last);
    }
    return legendAtCanonical(n - 1);
  }, [buildLegend, legendAtCanonical]);

  // Create the chart once.
  useEffect(() => {
    if (!containerRef.current) return;
    const overlayEntries = overlayRefs.current;
    const paneCharts = paneChartRefs.current;
    const guard = createDisposalGuard();
    disposalRef.current = guard;
    const chart = createChart(containerRef.current, baseChartOptions());
    const unsubscribeTheme = subscribeChartTheme(chart);
    const vol = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: chartMuted(),
      // Volume has its own hidden scale, so its last-value badge landed in the
      // price column on top of whatever level sat nearest the low — "4.47K"
      // was printed over the S1 support label. The figure is in the legend.
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    /*
     * The crosshair, and the one place a synthetic time could escape.
     *
     * `param.time` is a position on the axis the chart is currently drawing.
     * For every presentation and for Heikin Ashi that axis is canonical
     * exchange time and the value can be published as-is. For Renko it is a
     * RENDERING time: bricks are anchored to the bar that completed them and
     * stepped forward a second at a time when one bar completes several, so
     * the number under the pointer is not a market timestamp and must never
     * reach another pane, an indicator pane, or anything else that will treat
     * it as one. What leaves here is `sourceOpenTime` — the canonical bar —
     * or nothing at all.
     */
    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      if (guard.disposed) return;
      // The library's own axis drag turns auto-fit off without telling anyone.
      // Reading it back on pointer activity keeps the badge honest about what
      // the scale is actually doing, rather than about what was last asked for.
      reconcileScaleRef.current();
      const raw = param.time as number | undefined;
      const publish = (canonical: number | null): void => {
        hoverTimeRef.current = canonical;
        setIndicatorHoverTime((current) => current === canonical ? current : canonical);
        // Guarded by a ref so the subscription does not have to be torn down
        // when the callback changes.
        onCrosshairRef.current?.(canonical);
      };
      if (raw == null) {
        publish(null);
        setLegend(latestLegend());
        return;
      }
      const transform = chartTransform(mainKindRef.current);
      if (transform !== null && transform !== "heikinAshi") {
        const display = displayRef.current;
        const brickIndex = snapToBarIndexBy(
          display, raw, (bar) => Math.floor(bar.openTime / 1000));
        const brick = brickIndex >= 0 ? display[brickIndex] : undefined;
        const canonical = brick ? Math.floor(canonicalOpenTime(brick) / 1000) : null;
        publish(canonical);
        setLegend(brickIndex < 0 ? latestLegend() : buildLegend(
          canonical === null ? -1
            : snapToBarIndexBy(candlesRef.current, canonical,
              (c) => Math.floor(c.openTime / 1000)),
          brickIndex
        ));
        return;
      }
      publish(raw);
      const i = timeIndexRef.current.get(raw);
      setLegend(i === undefined ? latestLegend() : legendAtCanonical(i));
    });

    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      // A range we just applied ourselves would otherwise bounce back to the
      // pane that sent it, and the two would chase each other.
      if (guard.disposed) return;
      if (applyingRangeRef.current || syncingPaneRangeRef.current || !range) return;
      const from = range.from as number;
      const to = range.to as number;
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      // A viewport the user has panned away from is no longer the shortcut's —
      // but the library's own snap-to-bars on the way in is not a pan.
      if (shortcutRangeRef.current !== null
        && !sameViewport(shortcutRangeRef.current, { from, to })) {
        shortcutRangeRef.current = null;
        setActiveRange((current) => current === null ? current : null);
      }
      publishRange({ from, to });
      syncPaneRangesRef.current("price", { from, to });
    });

    chartRef.current = chart;
    volRef.current = vol;
    setChartCreated((n) => n + 1);
    return () => {
      // Nothing that was already in flight — a queued frame, a pending
      // release timer, a crosshair event mid-delivery — may run against the
      // chart after this line.
      guard.dispose();
      for (const timer of rangeReleaseRef.current) window.clearTimeout(timer);
      rangeReleaseRef.current = [];
      applyingRangeRef.current = false;
      publishedRangeRef.current = null;
      unsubscribeTheme();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      overlayEntries.clear();
      paneCharts.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The container is detached before the cleanup above runs; stop the library
  // measuring it in between. See `lib/chartLifecycle`.
  useDetachChartObserver(chartRef);

  /*
   * The main price series lives in its own effect so the presentation can be
   * changed without recreating the chart. Swapping the series keeps the time
   * scale — and therefore the viewport — exactly where the user left it; only
   * the series is torn down, and the data effect below repaints into the new
   * one. `chartReady` is bumped so the drawing layers, which hold a reference
   * to the series for price/coordinate conversion, remount against it.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    /*
     * The baseline's reference: the first close the chart currently holds.
     *
     * Read from a ref rather than a dependency so a new candle does not
     * recreate the series — the reference is meant to be the start of what the
     * user is looking at, and re-anchoring it on every tick would make the
     * whole chart change colour as bars arrive.
     */
    const series = addMainSeries(chart, chartType, baselineRef.current);
    seriesRef.current = series;
    mainKindRef.current = chartType;
    mainSeriesDirtyRef.current = true;
    setChartReady((n) => n + 1);
    return () => {
      // When the whole chart went away the series went with it, and asking a
      // disposed chart to remove it throws.
      if (chartRef.current !== chart) return;
      chart.removeSeries(series);
      if (seriesRef.current === series) seriesRef.current = null;
    };
  }, [chartType, chartCreated]);

  /**
   * Series appearance, from the reference's "Symbol" tab.
   *
   * Body / borders / wicks and the two direction colours were fixed literals
   * in `addMainSeries`, so the one tab the reference gives the most controls to
   * gave this product none. They are applied here rather than at creation
   * because changing a colour must not rebuild the series and lose the view.
   *
   * Hollow candles and High-low already express themselves through those same
   * four colour slots (an empty up body, transparent bodies), so this leaves
   * them alone: a user's up colour is theirs to choose, but a hollow candle
   * that fills itself in is no longer a hollow candle.
   */
  const { upColor, downColor, candleBody, candleBorders, candleWicks } = settings;
  /*
   * R6 S-2: a border and a wick have their own pair.
   *
   * They were drawn in the BODY's colours, so `Borders` and `Wick` could be
   * switched off and never coloured, while the series has carried
   * `borderUpColor` / `borderDownColor` / `wickUpColor` / `wickDownColor`
   * since lightweight-charts 4. `normalizeChartSettings` seeds all four from
   * the body, so a workspace that predates the split draws exactly what it
   * drew before — and a user who sets one gets the one they set.
   */
  const {
    borderUpColor, borderDownColor, wickUpColor, wickDownColor,
  } = settings;

  /**
   * The volume histogram's colours, resolved once rather than once per bar.
   *
   * They follow the user's own candle colours toward the chart surface, so
   * recolouring the series recolours the volume under it, and a theme change
   * re-mixes against the new surface instead of leaving dark-theme literals on
   * a white chart. `themeTick` is the dependency that makes the second half of
   * that true — the tokens it reads live on the document, not in React.
   */
  const volumeBarColor = useMemo(
    () => volumePalette(upColor, downColor),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- themeTick IS the input
    [upColor, downColor, themeTick]
  );
  /*
   * The live tick path reads the palette through a ref, not a closure.
   *
   * Putting `volumeBarColor` in the market-feed effect's dependencies would
   * tear down and re-open the websocket subscription every time the user
   * changed a candle colour or flipped the theme. The feed's identity depends
   * on the symbol and the interval; the colour of the bar it paints does not.
   */
  const volumeBarColorRef = useRef(volumeBarColor);
  volumeBarColorRef.current = volumeBarColor;
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || renderKind(chartType) !== "candles") return;
    if (chartType === "hollowCandles" || chartType === "highLow") return;
    const clear = "rgba(0,0,0,0)";
    try {
      (series as ISeriesApi<"Candlestick">).applyOptions({
        upColor: candleBody ? upColor : clear,
        downColor: candleBody ? downColor : clear,
        borderVisible: candleBorders,
        borderUpColor: candleBorders ? borderUpColor : clear,
        borderDownColor: candleBorders ? borderDownColor : clear,
        wickVisible: candleWicks,
        wickUpColor: candleWicks ? wickUpColor : clear,
        wickDownColor: candleWicks ? wickDownColor : clear,
      });
    } catch { /* the series went away between render and effect */ }
  }, [chartType, chartReady, upColor, downColor, candleBody, candleBorders, candleWicks,
    borderUpColor, borderDownColor, wickUpColor, wickDownColor]);

  /**
   * Bars: hairline, or as wide as the bar spacing allows.
   *
   * Separate from the candle effect above because it reaches a different
   * SERIES TYPE — `applyOptions({ thinBars })` on a candlestick series is an
   * option the series does not have, and lightweight-charts does not complain,
   * it simply ignores it. An effect that silently does nothing on 20 of the 21
   * chart types is worse than one that says which one it is for.
   */
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || renderKind(chartType) !== "bars") return;
    try {
      (series as ISeriesApi<"Bar">).applyOptions({
        thinBars: settings.thinBars,
        upColor, downColor,
      });
    } catch { /* the series went away between render and effect */ }
  }, [chartType, chartReady, settings.thinBars, upColor, downColor]);

  /**
   * Price precision.
   *
   * `auto` leaves the series formatting the library derives from the data,
   * which is the right default and is what every chart had before. An explicit
   * choice pins the digits, the way the reference's Data-modification section
   * does, and `minMove` follows from it so the axis does not offer steps it
   * cannot label.
   */
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    try {
      if (precision === "auto") {
        /*
         * TVP8: this used to `return` here, so Default was one-way. Pinning 5
         * digits and then choosing Default again left the series formatted to
         * 5 until something else happened to rebuild it — the control moved
         * back and the chart did not, which is the worst kind of setting.
         *
         * Default means the instrument's own tick, which is exactly what the
         * series would have derived for itself from the data.
         */
        const tick = priceTick && priceTick > 0 ? priceTick : null;
        const digits = autoPriceDigits(tick);
        axisDigitsRef.current = digits;
        series.applyOptions({
          priceFormat: { type: "price", precision: digits, minMove: tick ?? 0.01 },
        });
        return;
      }
      const digits = precision;
      axisDigitsRef.current = digits;
      series.applyOptions({
        priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits },
      });
    } catch { /* the series went away between render and effect */ }
  }, [precision, chartType, chartReady, priceTick]);

  // Load candles without rebuilding all 10,000 points for a last-bar update.
  useEffect(() => {
    const series = seriesRef.current;
    const vol = volRef.current;
    if (!series || !vol) return;
    // The identity of the bars on screen — not of the request. While a new
    // window loads these are still the previous window's bars, and every
    // decision below (refit, tick admission) is made about what is drawn.
    const datasetKey = datasetKeyOf({ symbol: heldSymbol, interval: heldInterval });
    const nextColors = new Map<number, string>();
    if (settings.colorBarsBasedOnPreviousClose && ["candles", "bars"].includes(renderKind(chartType))) {
      candles.forEach((candle, index) => {
        const previous = candles[index - 1];
        nextColors.set(candle.openTime / 1000,
          candle.close >= (previous?.close ?? candle.open) ? settings.upColor : settings.downColor);
      });
    }
    for (const point of barColors ?? []) {
      if (point.color !== null) nextColors.set(point.time, point.color);
    }
    // A freshly created series holds nothing, so it must be filled from
    // scratch — but that is not a reason to refit the time scale, which is
    // what makes a presentation change viewport-preserving.
    const forced = mainSeriesDirtyRef.current || datasetKeyRef.current !== datasetKey;

    /*
     * The baseline's reference price, re-anchored whenever the data changes.
     *
     * It is applied HERE rather than only at creation, because the series is
     * created before any bars exist: `useCandleHistory` is async, so on mount
     * `candles` is empty and the reference was 0 — every price above it, and
     * the whole chart rendered as a plain single-colour area with none of the
     * two-colour split the type exists for. The other half of the same bug was
     * a symbol change, which does not recreate the series: switching from an
     * instrument near 60,000 to one under a dollar left the reference at
     * 60,000 and painted everything below the line.
     *
     * `applyOptions` rather than a recreate, so re-anchoring costs nothing and
     * cannot disturb the viewport.
     */
    if (renderKind(mainKindRef.current) === "baseline" && candles.length > 0) {
      const reference = candles[0]!.close;
      if (baselineAppliedRef.current !== reference) {
        baselineAppliedRef.current = reference;
        try {
          (series as ISeriesApi<"Baseline">).applyOptions({
            baseValue: { type: "price", price: reference },
          });
        } catch { /* the series went away between render and effect */ }
      }
    }
    const canonicalPlan =
      planColoredCandleMutation(candlesRef.current, candles, barColorRef.current, nextColors);
    const mutation = forced ? "replace" : canonicalPlan;
    candlesRef.current = [...candles];
    barColorRef.current = nextColors;
    timeIndexRef.current = new Map(candles.map((c, i) => [c.openTime / 1000, i]));
    const kind = mainKindRef.current;
    const transform = chartTransform(kind);
    const tick = Number.isFinite(priceTick) && (priceTick ?? 0) > 0 ? priceTick! : null;
    const maxVolume = candles.reduce((max, candle) => Number.isFinite(candle.volume)
      ? Math.max(max, candle.volume) : max, 0);
    const candleDatum = (c: Candle) =>
      mainSeriesDatum(kind, c, nextColors.get(c.openTime / 1000)
        ?? (isVolumeCandle(kind) ? volumeCandleColor(c, maxVolume) : null));
    const volumeDatum = (c: Candle) => ({
      time: (c.openTime / 1000) as UTCTimestamp,
      value: c.volume,
      color: volumeBarColor(c.open, c.close),
    });

    /*
     * Volume is canonical and stays canonical: it is the exchange's own figure
     * at the exchange's own bar times, whatever the price series is drawing.
     * Renko is the one exception, and it is an omission rather than a
     * reinterpretation — a brick is not a time bar, so there is no honest
     * volume to put under it and none is drawn.
     */
    if (transform !== null && transform !== "heikinAshi") {
      if (volumeDrawnRef.current) {
        vol.setData([]);
        volumeDrawnRef.current = false;
        volHeadRef.current = null;
      }
    } else if (mutation === "replace" || !volumeDrawnRef.current) {
      setVolumeData(vol, candles.map(volumeDatum), volHeadRef);
      volumeDrawnRef.current = true;
    } else if (mutation === "update" && candles.length > 0) {
      // A bar behind what volume already holds is a repaint of the window, not
      // an increment of it — the same rule the price series follows, applied to
      // the one series that had no head of its own.
      updateVolumeSeries(vol, volumeDatum(candles[candles.length - 1]!), volHeadRef,
        () => setVolumeData(vol, candles.map(volumeDatum), volHeadRef));
    }

    if (transform === null && (kind === "range" || kind === "footprint")) {
      // These presentations have a stricter input contract than ordinary
      // candles: only ordered executions may produce their bars. Empty trade
      // data therefore means an empty price series, never an OHLC estimate.
      const source = marketTrades ?? [];
      const tradeDisplay = kind === "range"
        ? (tick ? rangeBarsAsOhlc(source, rangeBarSize(
            tick, settings.rangeTicks, settings.rangeAuto,
            candles[candles.length - 1]?.close ?? null,
          ), tick) : [])
        : (tick ? footprintBarsAsOhlc(source, Math.max(60_000, resolutionMs(interval)), tick) : []);
      transformHeadRef.current = null;
      /*
       * ── Footprint draws EVERY bar; only the cells are tape-bound ──────────
       *
       * This branch used to hand the series a transparent anchor built from
       * the tape alone, and store that same array for the legend. The tape is
       * a recent window — measured on this provider, 50,000 executions is
       * about two hours of BTC and the page walks FORWARD from the window
       * start, so deep backfill is not available at any limit. On a 1D chart
       * that anchor is one or two bars. Every other bar was therefore absent
       * from the series, not merely invisible: no body, no wick, nothing. The
       * price scale, shared with the MA overlay, then fitted the MA, and a
       * reader who chose Footprint saw an empty pane with two decorated bars.
       *
       * It was recorded once as an honest limitation. It was not honest: the
       * chart said nothing, and a chart that draws nothing while claiming a
       * presentation is the one outcome the disclosure work exists to prevent.
       *
       * So the series now holds the canonical candles — the exchange's own
       * OHLCV, already under the volume histogram on this very pane — and the
       * cells stay strictly tape-derived. Nothing is synthesised: no cell, no
       * delta, no bid/ask split is ever inferred from a candle. The bars the
       * tape does cover are drawn as a ghost body so the cells read over them
       * rather than fighting a solid candle at 0.62 alpha, and the pane says
       * how many bars those are.
       *
       * The legend follows the series: it reads the canonical candle, so
       * `legendSource("footprint")` is `"canonical"` and this array is the
       * range bars' alone.
       */
      displayRef.current = kind === "range" ? tradeDisplay : [];
      if (kind === "footprint") {
        const covered = tick
          ? footprintCoveredTimes(source, Math.max(60_000, resolutionMs(interval)))
          : new Set<number>();
        setMainSeriesData(series, kind, candles.map((c) => covered.has(c.openTime)
          ? {
              ...mainSeriesDatum(kind, c), color: FOOTPRINT_GHOST,
              wickColor: FOOTPRINT_GHOST, borderColor: FOOTPRINT_GHOST,
            }
          : candleDatum(c)), mainHeadRef);
      } else {
        setMainSeriesData(series, kind, tradeDisplay.map((bar) => mainSeriesDatum(kind, bar)), mainHeadRef);
      }
      mainSeriesDirtyRef.current = false;
    } else if (transform === null) {
      transformHeadRef.current = null;
      displayRef.current = [];
      if (mutation === "replace") {
        const rows = kind === "columns"
          ? candles.map((c) => ({ time: c.openTime / 1000, value: c.close }))
          : candles.map(candleDatum);
        setMainSeriesData(series, kind, rows, mainHeadRef);
        mainSeriesDirtyRef.current = false;
      } else if (mutation === "update" && candles.length > 0) {
        const last = candles[candles.length - 1]!;
        updateMainSeries(series, kind, kind === "columns"
          ? { time: last.openTime / 1000, value: last.close } : candleDatum(last), mainHeadRef,
          () => setMainSeriesData(series, kind, kind === "columns"
            ? candles.map((c) => ({ time: c.openTime / 1000, value: c.close }))
            : candles.map(candleDatum), mainHeadRef));
      }
    } else if ((transform === "kagi" || transform === "pointAndFigure") && !tick) {
      transformHeadRef.current = null;
      displayRef.current = [];
      setMainSeriesData(series, kind, [], mainHeadRef);
    } else {
      /*
       * A chart-only transform. The canonical candles above are untouched and
       * still drive the legend, the volume, the markers, the drawings and
       * everything downstream of this component; only the bars handed to the
       * price series are derived.
       */
      const params = transformParams(kind, tick ?? 0, transformSettings);
      const rebuilt = rebuildTransform(transform, params, candles);
      transformHeadRef.current = rebuilt.head;
      const display = rebuilt.display;
      // A `barcolor()` override describes one canonical bar. Heikin Ashi keeps
      // that bar's identity and its timestamp, so the override still applies;
      // a Renko brick is not a bar and does not inherit one.
      const transformedDatum = (b: OhlcBar) => mainSeriesDatum(
        kind, b, transform === "heikinAshi" ? nextColors.get(b.openTime / 1000) ?? null : null
      );
      const plan = forced ? "replace" : planOhlcMutation(displayRef.current, display);
      if (plan === "replace") {
        setMainSeriesData(series, kind, display.map(transformedDatum), mainHeadRef);
        mainSeriesDirtyRef.current = false;
      } else if (plan === "update" && display.length > 0) {
        updateMainSeries(series, kind, transformedDatum(display[display.length - 1]!), mainHeadRef,
          () => setMainSeriesData(series, kind, display.map(transformedDatum), mainHeadRef));
      }
      displayRef.current = display;
    }
    // Refreshed only now: a transform's legend reads the bars it just drew,
    // so it cannot be computed before `displayRef` has been brought up to date.
    setLegend(latestLegend());
    // `mainKindRef` is the type the SERIES was built from, which is how the
    // rest of this effect reads it — the effect re-runs on `chartReady`, which
    // the series-creating effect bumps.
    /*
     * The refit is keyed on the TYPE's time base, not on its transform.
     *
     * Both `candles` and `range` have `transform === null`, so this compared
     * null with null across a total time-base swap and concluded nothing had
     * changed: no `fitContent` fired, and the viewport that framed nine months
     * of hourly candles was kept over a handful of trade-driven bars spanning
     * half an hour. That is the two-or-three-bars-wide window, and why ⌥R —
     * which fits unconditionally — was the only way back.
     */
    const drawnType = mainKindRef.current;
    const timeBaseChanged = drawnType !== drawnTypeRef.current
      && (isSyntheticTimeBase(drawnType)
        || (drawnTypeRef.current !== null && isSyntheticTimeBase(drawnTypeRef.current)));
    drawnTypeRef.current = drawnType;
    if (datasetKeyRef.current !== datasetKey || timeBaseChanged) {
      datasetKeyRef.current = datasetKey;
      chartRef.current?.timeScale().fitContent();
      shortcutRangeRef.current = null;
      setActiveRange(null);
    }
    // The dataset on screen is settled. A tick that arrived for it before its
    // history did is applied now; one for any other dataset stays held.
    const last = candles[candles.length - 1];
    const pending = tickGateRef.current.adopt(
      { symbol: heldSymbol, interval: heldInterval }, last ? last.openTime : null);
    if (pending) applyTickRef.current?.(pending);
  }, [candles, heldSymbol, heldInterval, latestLegend, barColors, chartReady,
    marketTrades, priceTick, interval, settings.rangeTicks, settings.rangeAuto, transformSettings,
    volumeBarColor, settings.colorBarsBasedOnPreviousClose, settings.upColor, settings.downColor,
    chartType]);


  /**
   * Whether anything anchored to a canonical timestamp can be drawn on this
   * presentation at all. False under sparse transforms — see `lib/chartType`.
   */
  const timeAnchored = timeAnchoredVisualsTruthful(chartType);

  // Markers update independently: adding an indicator must not reset zoom.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    /*
     * Sparse transforms draw no time-anchored markers at all.
     *
     * A marker is placed at a canonical bar time. A sparse-transform axis is
     * synthetic positions, so the library would pin every marker to whichever point
     * happens to sit nearest that number — a BUY arrow under a brick the trade
     * has no relationship with, which reads as evidence and is not. Nothing is
     * changed about the trades or the script output; they are simply not drawn
     * here. Every canonical presentation and Heikin Ashi keep them.
     */
    if (!timeAnchored) { series.setMarkers([]); return; }

    // Entry/exit markers only: BUY at the fill, and the exit reason (TP / SL /
    // whatever the strategy named it) at the close. Nothing else is marked.
    //
    // A backtest usually spans more history than the chart currently holds.
    // lightweight-charts pins a marker whose time predates the loaded bars to
    // the first bar, which stacks old trades on the left edge at prices that
    // never occurred there — so drop anything outside the loaded window.
    const firstT = candles[0] ? candles[0].openTime / 1000 : 0;
    const lastT = candles[candles.length - 1]
      ? candles[candles.length - 1]!.openTime / 1000 : 0;
    const inWindow = (t: number): boolean => t >= firstT && t <= lastT;

    if (candles.length > 0 && (hasLineMarkers(chartType)
      || (visibleTrades?.length ?? 0) > 0 || (visibleMarkers?.length ?? 0) > 0)) {
      const drawn: SeriesMarker<Time>[] = [];
      if (hasLineMarkers(chartType)) {
        for (const candle of candles) {
          drawn.push({
            time: (candle.openTime / 1000) as UTCTimestamp,
            position: "inBar",
            color: candle.close >= candle.open ? CHART_UP : CHART_DOWN,
            shape: "circle",
            text: "",
          });
        }
      }
      /*
       * Past a point, a label stops being a label.
       *
       * Every trade printed `BUY 100.35` / `TP 96.39` beside its arrow. On a
       * real 321-trade backtest that is 600+ text runs across one plot: a solid
       * overlapping block of red and green in which no individual price can be
       * read and the price action itself is hidden — on the panel whose stated
       * job is "inspect every trade it took".
       *
       * Above the limit the arrows stay (position, direction and win/loss
       * colour are what the eye actually uses at that density) and the text is
       * dropped. The prices were never only here: the Trades tab lists all of
       * them, and a handful of trades — the chart page's own strategy tester,
       * which is the case the labels were designed for — is still labelled.
       */
      // The public trade input remains `trades`; visibility is a chart-setting
      // projection so callers keep the same first-class pane contract.
      /*
       * R6 T-1: the setting AND the density rule, not one or the other.
       *
       * Off, no mark is labelled at any density. On, the limit below still
       * governs — a 321-trade backtest is an unreadable block of text with or
       * without a preference saying labels are wanted.
       */
      const labelled = settings.showExecutionLabels
        && tradeMarkerCount(visibleTrades, inWindow) <= TRADE_LABEL_LIMIT;
      // const labelled = tradeMarkerCount(trades, inWindow) <= TRADE_LABEL_LIMIT;
      for (const t of visibleTrades ?? []) {
        const open = t.exitTime === null;
        if (inWindow(t.entryTime / 1000)) {
          drawn.push({
            time: (t.entryTime / 1000) as UTCTimestamp,
            position: "belowBar",
            color: open ? CHART_CAUTION : CHART_UP,
            shape: "arrowUp",
            ...(labelled ? { text: `BUY ${fmtPrice(t.entryPrice)}${open ? " ●" : ""}` } : {}),
          });
        }
        if (t.exitTime !== null && inWindow(t.exitTime / 1000)) {
          const win = (t.pnl ?? 0) >= 0;
          const reason = (t.exitReason ?? "EXIT").toUpperCase();
          drawn.push({
            time: (t.exitTime / 1000) as UTCTimestamp,
            position: "aboveBar", color: win ? CHART_UP : CHART_DOWN, shape: "arrowDown",
            ...(labelled
              ? { text: t.exitPrice !== null ? `${reason} ${fmtPrice(t.exitPrice)}` : reason }
              : {}),
          });
        }
      }
      for (const m of visibleMarkers ?? []) {
        if (!inWindow(m.time)) continue;
        drawn.push({
          time: m.time as UTCTimestamp,
          position: m.position,
          color: m.color,
          shape: m.shape,
          text: m.text,
        });
      }
      drawn.sort((a, b) => (a.time as number) - (b.time as number));
      series.setMarkers(drawn);
    } else {
      series.setMarkers([]);
    }
  }, [candles, visibleTrades, visibleMarkers, chartReady, timeAnchored, chartType,
    settings.showExecutionLabels]);

  // Live stop / target / entry levels for a running position.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const drawn = (visiblePriceLines ?? [])
      .filter((l) => Number.isFinite(l.price))
      .map((l) => series.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 1,
        lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        // R6 T-2: the number goes on the line that is making it, when the
        // level's own contract proves one.
        title: settings.showPnlValue && l.pnl ? `${l.title} ${l.pnl}` : l.title,
      }));
    return () => { for (const line of drawn) series.removePriceLine(line); };
  }, [visiblePriceLines, settings.showPnlValue, chartReady]);

  /*
   * The quote itself, drawn where the price scale can label it.
   *
   * Dotted rather than dashed so a bid and an ask cannot be mistaken for the
   * dashed alert and protection levels above, and drawn only when the feed has
   * actually answered — a fabricated spread would be the one thing worse than
   * no spread at all (`lib/useBookQuote` says the same about its own null).
   */
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !bookQuote) return;
    const drawn = [
      { price: bookQuote.bid, color: settings.bidColor, title: "Bid" },
      { price: bookQuote.ask, color: settings.askColor, title: "Ask" },
    ].map((level) => series.createPriceLine({
      price: level.price,
      color: level.color,
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: level.title,
    }));
    return () => { for (const line of drawn) series.removePriceLine(line); };
  }, [bookQuote, settings.bidColor, settings.askColor, chartReady]);

  /** Auxiliary levels backed by the loaded candles, never fabricated values. */
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || candles.length === 0) return;
    const latest = candles[candles.length - 1]!;
    const currentDay = Math.floor(latest.openTime / 86_400_000);
    const previous = [...candles].reverse().find((bar) =>
      Math.floor(bar.openTime / 86_400_000) < currentDay);
    const levels: Array<{
      price: number; color: string; title: string; mode: ChartSettings["previousDayClose"];
    }> = [];
    if (previous && settings.previousDayClose !== "hidden") {
      levels.push({ price: previous.close, color: settings.previousDayCloseColor,
        title: "Previous day close", mode: settings.previousDayClose });
    }
    if (settings.highLow !== "hidden") {
      levels.push(
        { price: Math.max(...candles.map((bar) => bar.high)), color: settings.highLowColor,
          title: "High", mode: settings.highLow },
        { price: Math.min(...candles.map((bar) => bar.low)), color: settings.highLowColor,
          title: "Low", mode: settings.highLow },
      );
    }
    const drawn = levels.map((level) => series.createPriceLine({
      price: level.price,
      color: level.color,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineVisible: level.mode === "line",
      axisLabelVisible: true,
      title: level.title,
    }));
    return () => { for (const line of drawn) series.removePriceLine(line); };
  }, [candles, settings.previousDayClose, settings.previousDayCloseColor,
    settings.highLow, settings.highLowColor, chartReady]);

  // Pick a price level by clicking the chart. Subscribed only while a handler
  // exists — see `onPriceSelect`.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !onPriceSelect) return;
    const onClick = (param: MouseEventParams): void => {
      if (!param.point) return;
      const price = series.coordinateToPrice(param.point.y);
      // A click outside the price range returns null rather than throwing, and
      // reporting a null level would silently arm an alert at zero.
      if (price === null || !Number.isFinite(price)) return;
      onPriceSelect(Number(price));
    };
    chart.subscribeClick(onClick);
    return () => chart.unsubscribeClick(onClick);
  }, [onPriceSelect, chartReady]);

  /*
   * ── R8-02: arming a Replay by clicking a bar ──────────────────────────────
   *
   * While `onBarSelect` is set the chart is asking "which bar?". Two things
   * follow, and both are this component's because both are about the plot's
   * own coordinate system: a 1px vertical guide at the bar under the pointer,
   * so the chart LOOKS like it is waiting, and a left-click that answers with
   * that bar's close time.
   *
   * The guide is a DOM line rather than a series: lightweight-charts 4.2 draws
   * horizontal price lines and nothing vertical, and a one-bar series would be
   * a fake candle in the data the study layer reads.
   */
  const [barPickX, setBarPickX] = useState<number | null>(null);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onBarSelect) { setBarPickX(null); return; }
    const barAt = (time: unknown): Candle | undefined => {
      if (typeof time !== "number") return undefined;
      return candles.find((bar) => Math.floor(canonicalOpenTime(bar) / 1000) === time);
    };
    const onMove = (param: MouseEventParams): void => {
      setBarPickX(param.point && barAt(param.time) ? param.point.x : null);
    };
    const onClick = (param: MouseEventParams): void => {
      const bar = barAt(param.time);
      // A click in the margin past the newest bar has no bar to stand on, and
      // starting a session "at nothing" is what the calendar route already
      // guards against with `min`/`max`.
      if (bar) onBarSelect(bar.closeTime);
    };
    chart.subscribeCrosshairMove(onMove);
    chart.subscribeClick(onClick);
    return () => {
      try {
        chart.unsubscribeCrosshairMove(onMove);
        chart.unsubscribeClick(onClick);
      } catch { /* the chart was disposed with its handlers */ }
      setBarPickX(null);
    };
  }, [onBarSelect, candles, chartReady]);

  /*
   * ── R8-08: the price axis's own `⊕` ──────────────────────────────────────
   *
   * The reference draws it at the crosshair's price, at the inner edge of the
   * scale, whenever the pointer is on the plot. It is the axis route to an
   * alert, and this product had none: the only way in from the chart was a
   * right-click, which is a gesture a user has to already know about.
   */
  const [axisAlert, setAxisAlert] = useState<{ y: number; price: number } | null>(null);
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !onAxisAlert) { setAxisAlert(null); return; }
    const onMove = (param: MouseEventParams): void => {
      if (!param.point) { setAxisAlert(null); return; }
      const price = series.coordinateToPrice(param.point.y);
      if (price === null || !Number.isFinite(price)) { setAxisAlert(null); return; }
      setAxisAlert({ y: Math.round(param.point.y), price: Number(price) });
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      try { chart.unsubscribeCrosshairMove(onMove); }
      catch { /* the chart was disposed with its handlers */ }
      setAxisAlert(null);
    };
  }, [onAxisAlert, chartReady]);

  // lightweight-charts v4 does not expose a marker identity in click events.
  // Resolve only exact marker bar times, or a price line within an 8px hit
  // target; no nearest-bar shifting is used for trading evidence.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !onAnnotationSelect || onPriceSelect) return;
    const onClick = (param: MouseEventParams): void => {
      const time = typeof param.time === "number" ? param.time : null;
      const marker = time === null ? undefined : (visibleMarkers ?? []).find((item) =>
        item.id && item.time === time);
      if (marker?.id) { onAnnotationSelect(marker.id); return; }
      if (!param.point) return;
      const line = (visiblePriceLines ?? []).find((item) => {
        if (!item.id) return false;
        const coordinate = series.priceToCoordinate(item.price);
        return coordinate !== null && Math.abs(coordinate - param.point!.y) <= 8;
      });
      if (line?.id) onAnnotationSelect(line.id);
    };
    chart.subscribeClick(onClick);
    return () => chart.unsubscribeClick(onClick);
  }, [visibleMarkers, visiblePriceLines, onAnnotationSelect, onPriceSelect, chartReady]);

  // Pine/MA series are stable by plot id. Gaps stay as whitespace and a
  // last-point change uses update() instead of replaying the full history.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    /*
     * Script plots are time series and Renko has no time axis, so under Renko
     * the price overlays are removed rather than redrawn at brick positions.
     * The scripts still run and their output is untouched; this is a decision
     * about what may be drawn on top of bricks.
     */
    if (!timeAnchored) {
      for (const [id, entry] of overlayRefs.current) {
        chart.removeSeries(entry.api);
        overlayRefs.current.delete(id);
      }
      return;
    }
    // Clip to the loaded candle window, so a script run over more history than
    // the chart holds doesn't stretch the time scale past the candles.
    const first = candles[0] ? candles[0].openTime / 1000 : -Infinity;
    const lastBar = candles[candles.length - 1];
    const lastTime = lastBar ? lastBar.openTime / 1000 : Infinity;
    const want = new Map(groupedOverlays.price.map((overlay) => [overlay.id, overlay]));
    for (const [id, entry] of overlayRefs.current) {
      const overlay = want.get(id);
      if (!overlay || overlaySeriesKind(overlay) !== entry.kind) {
        chart.removeSeries(entry.api);
        overlayRefs.current.delete(id);
      }
    }
    for (const overlay of want.values()) {
      const kind = overlaySeriesKind(overlay);
      let entry = overlayRefs.current.get(overlay.id);
      const precision = overlay.precision;
      const priceFormat = precision === null || precision === undefined ? undefined : {
        type: "price" as const, precision, minMove: 10 ** -precision,
      };
      /*
       * R6 SC-3: the study's price tag on the scale, as a setting.
       *
       * ANDed rather than substituted: the density rule above it stays in
       * force, so switching the setting ON cannot put ten moving-average
       * badges back on a crowded axis, and switching it OFF is absolute.
       */
      const lastValueVisible = settings.indicatorLastValue
        && overlay.priceScaleLabelVisible !== false
        && !compact && overlay.instanceId !== "moving-averages";
      /*
       * The price scale carries values, never names.
       *
       * lightweight-charts draws the series `title` as its own badge on the
       * axis, beside the value badge — so every level plotted two labels, "R1"
       * and "843.49", down a column already crowded by the last price, the
       * open orders and each moving average. Ten moving averages stamped ten
       * name-only badges and buried the price ticks under them, which is why
       * they were suppressed here first; the same argument applies to all of
       * them. Every series is still named, with its colour, in the legend.
       */
      const axisTitle = "";
      if (!entry) {
        if (kind === "Histogram") {
          entry = { kind, api: chart.addHistogramSeries({
            color: overlay.color, base: 0, priceLineVisible: false, lastValueVisible,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else if (kind === "Area") {
          entry = { kind, api: chart.addAreaSeries({
            lineColor: overlay.color,
            topColor: alphaColor(overlay.color, "55"),
            bottomColor: alphaColor(overlay.color, "08"),
            priceLineVisible: false, lastValueVisible,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else if (kind === "Candlestick") {
          entry = { kind, api: chart.addCandlestickSeries({
            upColor: overlay.color, downColor: overlay.color,
            borderUpColor: overlay.color, borderDownColor: overlay.color,
            wickUpColor: overlay.color, wickDownColor: overlay.color,
            priceLineVisible: false, lastValueVisible,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else if (kind === "Bar") {
          entry = { kind, api: chart.addBarSeries({
            upColor: overlay.color, downColor: overlay.color,
            priceLineVisible: false, lastValueVisible,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else {
          entry = { kind, api: chart.addLineSeries({
            color: overlay.color, priceLineVisible: false, lastValueVisible,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        }
        overlayRefs.current.set(overlay.id, entry);
      }
      if (entry.kind === "Line") entry.api.applyOptions({
        color: overlay.color,
        lineWidth: Math.max(1, Math.min(4, overlay.width ?? 2)) as 1 | 2 | 3 | 4,
        lineStyle: overlay.lineStyle === "dotted" ? LineStyle.Dotted
          : overlay.dashed || overlay.lineStyle === "dashed" ? LineStyle.Dashed : LineStyle.Solid,
        lineType: overlay.style === "stepline" ? LineType.WithSteps : LineType.Simple,
        lineVisible: overlay.style !== "circles" && overlay.style !== "cross",
        pointMarkersVisible: overlay.style === "circles",
        lastValueVisible,
        title: axisTitle,
        ...(priceFormat ? { priceFormat } : {}),
      });
      else if (entry.kind === "Histogram") entry.api.applyOptions({
        color: overlay.color, lastValueVisible, title: axisTitle,
        ...(priceFormat ? { priceFormat } : {}),
      });
      /*
       * TVP8 round two: Width reaches the plots that HAVE a line.
       *
       * `lineWidth` was applied in the `Line` branch only, so a study's Width
       * control was inert on every Area plot — an Elder Force Index or a
       * Bollinger fill could be recoloured and not rewidened. A histogram,
       * candlestick or bar plot has no line at all, which is why those
       * branches still do not take it.
       */
      else if (entry.kind === "Area") entry.api.applyOptions({
        lineColor: overlay.color,
        lineWidth: Math.max(1, Math.min(4, overlay.width ?? 2)) as 1 | 2 | 3 | 4,
        lastValueVisible, title: axisTitle,
        ...(priceFormat ? { priceFormat } : {}),
      });
      else if (entry.kind === "Candlestick") entry.api.applyOptions({
        upColor: overlay.color, downColor: overlay.color,
        borderUpColor: overlay.color, borderDownColor: overlay.color,
        wickUpColor: overlay.color, wickDownColor: overlay.color,
        lastValueVisible, title: axisTitle,
        ...(priceFormat ? { priceFormat } : {}),
      });
      else entry.api.applyOptions({
        upColor: overlay.color, downColor: overlay.color,
        lastValueVisible, title: axisTitle,
        ...(priceFormat ? { priceFormat } : {}),
      });
      const points = overlay.data.filter((point) =>
        Number.isFinite(point.time) && point.time >= first && point.time <= lastTime);
      const plan = planSeriesMutation(entry.data, points);
      if (plan === "replace") replaceOverlayData(entry, points);
      else if (plan === "update") updateOverlayData(entry, points);
    }
  }, [groupedOverlays.price, chartReady, candles, compact, timeAnchored,
    settings.indicatorLastValue]);

  /*
   * The profiles on the price pane, separated from the decorations the Pine
   * layer draws.
   *
   * They travel with the other decorations because that is the seam a pane
   * already has for "something on this chart that is not a series" — but they
   * are painted by a different layer, against price rather than against time,
   * so they are split out here rather than branched on inside a loop.
   */
  const priceProfiles = useMemo(
    () => groupedOverlays.priceDecorations.filter(
      (d): d is ChartProfileDecoration => d.kind === "profile"),
    [groupedOverlays.priceDecorations]);
  const profileNotices = useMemo(() => {
    const seen = new Set<string>();
    return priceProfiles.flatMap((profile) => {
      const key = `${profile.title}|${profile.basisNotice}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [profile];
    });
  }, [priceProfiles]);

  const pinePriceToCoordinate = useCallback((overlayId: string, value: number): number | null => {
    const entry = overlayRefs.current.get(overlayId);
    return entry ? entry.api.priceToCoordinate(value) as number | null : null;
  }, []);

  /*
   * Live: update the forming candle from the shared Binance kline feed.
   *
   * FE-09 gave this an exponential-backoff reconnect, a silence watchdog and a
   * reportable feed state, because the original had `onmessage` and nothing
   * else: a dropped or half-open socket simply froze the last price on screen
   * and kept presenting it as current. All of that behaviour is unchanged — it
   * moved to `lib/marketFeed`, where it runs once per distinct feed instead of
   * once per chart, and `onStatus` still delivers the same honest answers.
   */
  useEffect(() => {
    if (!live) { setFeedState(IDLE_FEED); return; }
    // Canonical instruments are updated by useCandleHistory's provider-aware
    // stream. Opening this legacy Binance-only feed as well can both waste a
    // socket and report/apply Binance data on a different venue's chart.
    if (isCanonicalInstrumentId(symbol)) { setFeedState(IDLE_FEED); return; }

    // One tick handler per pane, attached to a feed that is shared by every
    // pane on this instrument and resolution. The parse, the reconnect ladder
    // and the watchdog all happen once upstream, in `lib/marketFeed`.
    let previousStreamBar: Candle | null = null;

    const applyTick = (tick: KlineTick): void => {
      // Read through the refs: the main series is replaced when the user
      // changes presentation, and capturing it here would leave the feed
      // writing into a series that is no longer on the chart.
      const series = seriesRef.current;
      const vol = volRef.current;
      if (!series || !vol) return;
      const timeSec = tick.openTime / 1000;
      const time = timeSec as UTCTimestamp;
      const override = barColorRef.current.get(timeSec) ?? null;

      // Mirror the forming candle into the legend source so the readout stays
      // live; only refresh the display when the user isn't pointing at an
      // older candle.
      //
      // This happens BEFORE the series is written, because a transform draws
      // from the canonical series rather than from the tick: Heikin Ashi and
      // Renko both need the forming bar in its place among the closed ones
      // before they can say what it looks like.
      const list = candlesRef.current;
      const liveBar: Candle = {
        symbol: tick.symbol, interval: tick.interval,
        openTime: tick.openTime, closeTime: tick.closeTime,
        open: tick.open, high: tick.high, low: tick.low, close: tick.close,
        volume: tick.volume,
      };
      const idx = timeIndexRef.current.get(timeSec);
      if (idx !== undefined) list[idx] = liveBar;
      else if (list.length === 0 || tick.openTime > list[list.length - 1]!.openTime) {
        list.push(liveBar);
        timeIndexRef.current.set(timeSec, list.length - 1);
        onLiveBoundaryRef.current?.(previousStreamBar, liveBar);
      }
      previousStreamBar = liveBar;

      const kind = mainKindRef.current;
      const transform = chartTransform(kind);
      const maxVolume = list.reduce((max, candle) => Number.isFinite(candle.volume)
        ? Math.max(max, candle.volume) : max, 0);
      /*
       * Footprint joins the live path now that its series holds canonical
       * candles: the forming bar is an ordinary candle like any other, and it
       * always has tape — it is the bar the stream is filling — so it takes
       * the ghost body the replace path gives its covered bars. Range stays
       * out: its bars are built from executions, not from this tick.
       */
      if (transform === null && kind !== "range") {
        const liveOhlc = {
          openTime: tick.openTime, open: tick.open, high: tick.high,
          low: tick.low, close: tick.close,
        };
        const liveDatum = (c: Candle) => kind === "columns"
          ? { time: c.openTime / 1000, value: c.close }
          : kind === "footprint"
            ? {
                ...mainSeriesDatum(kind, c), color: FOOTPRINT_GHOST,
                wickColor: FOOTPRINT_GHOST, borderColor: FOOTPRINT_GHOST,
              }
            : mainSeriesDatum(kind, c, barColorRef.current.get(c.openTime / 1000)
              ?? (isVolumeCandle(kind) ? volumeCandleColor(c, maxVolume) : null));
        /*
         * The repaint is not optional here either.
         *
         * `applyTick` has ALREADY written this bar into `candlesRef.current`,
         * above, so a refusal that only dropped the row would leave the
         * canonical record claiming a bar the series was never given — the
         * exact defect the transform branch below was repaired for. The two
         * live branches therefore take the same answer, and `list` is the
         * record that was just updated, so the repaint draws what the chart
         * believes it holds.
         */
        updateMainSeries(series, kind, kind === "columns"
          ? { time: timeSec, value: tick.close }
          : mainSeriesDatum(kind, liveOhlc, override
            ?? (isVolumeCandle(kind) ? volumeCandleColor(liveBar, maxVolume) : null)), mainHeadRef,
          () => setMainSeriesData(series, kind, list.map(liveDatum), mainHeadRef));
      } else if (transform !== null) {
        if ((transform === "kagi" || transform === "pointAndFigure")
          && !(priceTick && priceTick > 0)) return;
        const params = transformParams(kind, priceTick ?? undefined, transformSettingsRef.current);
        const advanced = advanceTransform(
          transformHeadRef.current, transform, params, list
        );
        transformHeadRef.current = advanced.head;
        const display = advanced.display;
        const transformedDatum = (b: OhlcBar) => mainSeriesDatum(
          kind, b,
          transform === "heikinAshi" ? barColorRef.current.get(b.openTime / 1000) ?? null : null
        );
        // A retrace that un-completes a Renko brick, or a bar that completes
        // two at once, cannot be expressed as one `update()`; both fail the
        // prefix test and get a full repaint instead of a wrong one.
        const plan = planOhlcMutation(displayRef.current, display);
        if (plan === "replace") {
          setMainSeriesData(series, kind, display.map(transformedDatum), mainHeadRef);
        } else if (plan === "update" && display.length > 0) {
          updateMainSeries(series, kind, transformedDatum(display[display.length - 1]!), mainHeadRef,
            () => setMainSeriesData(series, kind, display.map(transformedDatum), mainHeadRef));
        }
        displayRef.current = display;
      }
      /*
       * Volume, under the same two rules.
       *
       * DROPPED when the frame is behind the histogram's own head — and dropped
       * rather than repainted, because this is the live path: a frame for a bar
       * the chart is already past has nothing to say that the current bar will
       * not say a moment later, which is the rule `lib/liveDataset` states for
       * the price series. Handing it to `update()` throws out of this handler
       * into the route's error boundary.
       *
       * SKIPPED entirely when the histogram is deliberately empty. Kagi, Point
       * & Figure and Line Break are not drawn on a time axis, so the data
       * effect clears volume under them (`vol.setData([])`); writing a tick
       * into it here put one stray bar back on a chart that is showing none.
       * Renko is the same omission and was the only one this branch knew about.
       */
      if (transform !== "renko" && volumeDrawnRef.current) {
        updateVolumeSeries(vol, {
          time, value: tick.volume,
          color: volumeBarColorRef.current(tick.open, tick.close),
        }, volHeadRef);
      }

      const hover = hoverTimeRef.current;
      if (hover === null) setLegend(latestLegend());
      else if (hover === timeSec) {
        const i = timeIndexRef.current.get(timeSec);
        if (i !== undefined) setLegend(legendAtCanonical(i));
      }
    };
    applyTickRef.current = applyTick;

    /*
     * The one rule of the live path: a tick touches only the dataset on
     * screen. After a symbol change the new feed's first frame arrives before
     * the new history; it is held here — not drawn on the old bars — and
     * applied by the data effect the moment that history lands.
     */
    const onTick = (tick: KlineTick): void => {
      /*
       * `hold` and `stale` are both "do not draw this", for opposite reasons:
       * one is waiting for its dataset, the other is behind the bar already
       * drawn. Applying the second throws inside lightweight-charts and the
       * throw escapes to the route's error boundary — one out-of-order frame
       * replaced the whole chart page with "This page stopped working".
       */
      if (tickGateRef.current.decide(tick) !== "apply") return;
      applyTick(tick);
    };

    const release = marketFeed.subscribe(symbol, interval, {
      onTick,
      onStatus: (_status, state) => setFeedState(state),
    });
    return () => {
      release();
      if (applyTickRef.current === applyTick) applyTickRef.current = null;
      setFeedState(IDLE_FEED);
    };
  }, [symbol, interval, live, latestLegend, legendAtCanonical, priceTick]);

  /**
   * Mirror another pane's crosshair.
   *
   * Panes are usually on different resolutions, so an exact time match is the
   * exception: 14:07 on a 15m chart has to land on the 14:00 bar of a 1h one.
   * We take the newest bar at or before the incoming time, which is the bar
   * that was actually forming at that moment. When this pane has no such bar —
   * a different instrument, or history that starts later — the crosshair is
   * cleared rather than clamped to a bar the moment does not belong to.
   */
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    if (crosshairTime == null) {
      chart.clearCrosshairPosition();
      return;
    }
    const transform = chartTransform(chartType);
    if (transform !== null && transform !== "heikinAshi") {
      /*
       * Synthetic columns/lines carry their source bar timestamp separately
       * from the strictly increasing display timestamp. Mapping through that
       * source keeps replay and cross-pane interaction on canonical market time.
       */
      const display = displayRef.current;
      const brickIndex = snapToBarIndexBy(
        display, crosshairTime, (bar) => Math.floor(canonicalOpenTime(bar) / 1000));
      if (brickIndex < 0) { chart.clearCrosshairPosition(); return; }
      const brick = display[brickIndex]!;
      chart.setCrosshairPosition(
        brick.close, Math.floor(brick.openTime / 1000) as UTCTimestamp, series);
      return;
    }
    const list = candlesRef.current;
    if (list.length === 0) return;

    const found = snapToBarIndexBy(list, crosshairTime, (c) => Math.floor(c.openTime / 1000));
    if (found < 0) { chart.clearCrosshairPosition(); return; }

    const bar = list[found]!;
    // Heikin Ashi keeps one bar per canonical timestamp, so the time is the
    // canonical one; the PRICE the crosshair is anchored at is the drawn bar's,
    // so the readout describes the body on screen rather than one that is not.
    const drawn = transform === "heikinAshi" ? displayRef.current[found] : undefined;
    chart.setCrosshairPosition(
      drawn ? drawn.close : bar.close,
      Math.floor(bar.openTime / 1000) as UTCTimestamp,
      series
    );
  }, [crosshairTime, chartReady, chartType]);

  /*
   * ── TVP8 R1c-20 / R1b-08: no time label without a crosshair ──────────────
   *
   * `25 Aug '26 09:00` was parked on the time axis at x 87–198 on EVERY fresh
   * load, with no pointer on the chart and no crosshair drawn — and it stayed
   * there through the replay and compare captures. A time-axis label is the
   * chart saying "this is the moment you are pointing at"; one that is there
   * when the user is pointing at nothing is a reading of a bar they never
   * asked about, and on arrival it names a bar in the middle of history.
   *
   * It comes from a PROGRAMMATIC `setCrosshairPosition` — the initial fit and
   * the cross-pane mirror both call it, and lightweight-charts keeps the
   * label until something clears it. Nothing did: the mirror clears only when
   * the incoming time is null, and on a first load it never arrives at all.
   *
   * So two things clear it, and between them they cover every way the pointer
   * can end up off the plot: this effect, once the chart exists and nothing is
   * being hovered, and `pointerleave` on the host below.
   */
  useEffect(() => {
    if (chartReady === 0) return;
    if (crosshairTime != null || indicatorHoverTime !== null) return;
    chartRef.current?.clearCrosshairPosition();
  }, [chartReady, crosshairTime, indicatorHoverTime, candles]);

  /*
   * And the pointer leaving the plot (R1c-20).
   *
   * `subscribeCrosshairMove` fires with `param.time === undefined` on the way
   * out, which clears the LEGEND but not a crosshair that was positioned
   * programmatically. Attached to the host element rather than to the library
   * so it fires even when the pointer leaves across the axis.
   */
  useEffect(() => {
    const host = containerRef.current;
    if (!host || chartReady === 0) return;
    const clear = (): void => { chartRef.current?.clearCrosshairPosition(); };
    host.addEventListener("pointerleave", clear);
    return () => host.removeEventListener("pointerleave", clear);
  }, [chartReady]);

  /** Adopt the other pane's exact visible span (date-range sync). */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !visibleRange) return;
    applyingRangeRef.current = true;
    try {
      chart.timeScale().setVisibleRange({
        from: visibleRange.from as UTCTimestamp,
        to: visibleRange.to as UTCTimestamp,
      });
    } catch {
      // Outside this pane's loaded history — leave the range where it is.
    } finally {
      // Cleared after the library has emitted its own change event.
      releaseAppliedRange();
    }
  }, [visibleRange, chartReady, releaseAppliedRange]);

  /**
   * Time sync: keep this pane's right edge at the other's latest visible bar
   * while preserving its own zoom, so a 15m and a 1h chart stay on the same
   * moment without being forced to show the same number of bars.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || followEdgeTime == null || visibleRange) return;
    const ts = chart.timeScale();
    const cur = ts.getVisibleRange();
    if (!cur) return;
    const span = (cur.to as number) - (cur.from as number);
    if (!Number.isFinite(span) || span <= 0) return;
    applyingRangeRef.current = true;
    try {
      ts.setVisibleRange({
        from: (followEdgeTime - span) as UTCTimestamp,
        to: followEdgeTime as UTCTimestamp,
      });
    } catch {
      // Ignore ranges this pane cannot show.
    } finally {
      releaseAppliedRange();
    }
  }, [followEdgeTime, visibleRange, chartReady, releaseAppliedRange]);

  /*
   * The panes are horizontally locked to the price chart, so only the bottom
   * one needs an axis. Repeating it under every pane cost a row of pixels each
   * and drew the same numbers three times; TradingView draws it once.
   */
  // ── the indicator pane stack ─────────────────────────────────────────────

  /*
   * Renko takes the stack down with the rest of the time-anchored layers.
   *
   * An oscillator pane is a second chart on canonical time, locked to this
   * one's viewport. Under a brick axis the two are not the same axis, and a
   * stack of studies drawn beneath bricks they were not computed from is the
   * clearest possible statement of an alignment that does not exist. The
   * studies are untouched and return on any other presentation.
   */
  const stackAvailable = timeAnchored;
  const paneIds = useMemo(
    () => groupedOverlays.panes.map((pane) => pane.id), [groupedOverlays.panes]);
  useEffect(() => {
    // Returns the same object when nothing moved, so this cannot loop.
    setPaneLayout((current) => reconcilePaneLayout(current, paneIds));
  }, [paneIds]);
  const stackPanes = useMemo(
    () => orderedPanes(paneLayout, groupedOverlays.panes),
    [paneLayout, groupedOverlays.panes]);
  const maximizedPaneId = stackAvailable ? paneLayout.maximizedId : null;
  const hasPanes = stackAvailable && stackPanes.length > 0;
  /** The price chart gives up the column while a study is maximised. */
  const priceHidden = hasPanes && maximizedPaneId !== null;
  /** Collapsed here means "showing only its header", for whichever reason. */
  const paneCollapsed = useCallback((paneId: string): boolean =>
    isPaneCollapsed(paneLayout, paneId)
    || (maximizedPaneId !== null && paneId !== maximizedPaneId),
    [paneLayout, maximizedPaneId]);
  /*
   * The time axis is drawn exactly once, under the lowest pane that is
   * actually showing a plot. A collapsed pane cannot carry it — the axis would
   * be behind the header — and when every pane is collapsed the axis goes back
   * to the price chart, which is the only thing left with a plot.
   */
  const axisPaneId = hasPanes
    ? (maximizedPaneId
      ?? [...stackPanes].reverse().find((pane) => !paneCollapsed(pane.id))?.id
      ?? null)
    : null;

  const togglePaneCollapse = useCallback((paneId: string) => {
    setPaneLayout((current) => togglePaneCollapsed(current, paneId));
  }, []);
  const togglePaneMaximize = useCallback((paneId: string) => {
    setPaneLayout((current) => togglePaneMaximized(current, paneId));
  }, []);
  const moveIndicatorPane = useCallback((paneId: string, direction: -1 | 1) => {
    setPaneLayout((current) => movePane(current, paneId, direction));
  }, []);
  const resizeIndicatorPane = useCallback((paneId: string, height: number) => {
    setPaneLayout((current) => setPaneHeight(current, paneId, height));
  }, []);

  /*
   * A hidden container measures 0 x 0, and a live chart that is told so throws
   * inside the library's own resize path. Measurement is switched off in the
   * same commit that hides the price chart, which is strictly before the
   * browser delivers the resize — see `lib/chartLifecycle`.
   */
  useChartMeasuring(chartRef, !priceHidden);

  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({ visible: axisPaneId === null });
  }, [axisPaneId, chartCreated]);

  // ── the price axis's own controls ────────────────────────────────────────

  /**
   * Where the price axis actually is, so its controls can sit at its foot.
   *
   * Both numbers belong to the library and neither can be a constant here: the
   * scale's width grows with the number of digits in the price (a 7-figure
   * instrument and a 5-decimal one differ by ~30px) and the time axis's height
   * follows the font size in chart settings — and is zero on a pane that is not
   * the one drawing the axis. A guessed offset would put the buttons over the
   * prices on one chart and under the time labels on another.
   */
  const [axisFoot, setAxisFoot] = useState<{ width: number; bottom: number }>(
    { width: 0, bottom: 0 });
  const axisSide = settings.scalePlacement === "left" ? "left" : "right";
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || priceHidden) return;
    const measure = (): void => {
      try {
        const next = {
          width: Math.round(chart.priceScale(axisSide).width()),
          bottom: Math.round(chart.timeScale().height()),
        };
        setAxisFoot((current) =>
          current.width === next.width && current.bottom === next.bottom ? current : next);
      } catch { /* the chart went away between render and effect */ }
    };
    measure();
    try { chart.timeScale().subscribeSizeChange(measure); }
    catch { return undefined; }
    return () => {
      try { chart.timeScale().unsubscribeSizeChange(measure); }
      catch { /* the chart is already disposed; the handler went with it */ }
    };
  }, [chartReady, priceHidden, axisSide, axisPaneId, candles, scale, settings.scaleFontSize]);

  // ── the bottom range bar ─────────────────────────────────────────────────

  /**
   * The window this pane actually holds — under replay, already clipped to the
   * horizon, because `candles` is what the pane is drawing and nothing here
   * consults a clock.
   */
  const window_: LoadedWindow | null = useMemo(
    () => loadedWindow(candles, resolutionMs(interval)), [candles, interval]);
  /*
   * All nine, every time — the ones this pane cannot fill come back
   * `enabled: false` and are rendered disabled rather than dropped, so the row
   * does not change width or lose a target as the timeframe changes. See
   * `rangeShortcutChoices`.
   */
  const shortcuts = useMemo(() => rangeShortcutChoices(window_), [window_]);
  /*
   * Ranges are a statement about a time axis, and Renko does not have one, so
   * the shortcuts go with the rest of the time-anchored layers. The price
   * scale is a different question — it is about price, which every
   * presentation has — so it stays, on the axis it acts on.
   */
  const showRanges = timeAnchored;
  /*
   * Below `large` density there is no room: a pane at 480x250 in a 4x4
   * workspace would spend a tenth of its height on chrome. The library's own
   * axis drag and double-click-to-reset still work on those panes, and
   * maximising one brings the bar back.
   */
  const showBottomBar = !compact;

  const applyRangeShortcut = useCallback((id: RangeShortcutId) => {
    const chart = chartRef.current;
    if (!chart || !window_) return;
    const resolved = resolveRangeShortcut(id, window_);
    if (!resolved) return;
    setActiveRange(id);
    shortcutRangeRef.current = resolved;
    try {
      chart.timeScale().setVisibleRange({
        from: resolved.from as UTCTimestamp, to: resolved.to as UTCTimestamp,
      });
    } catch {
      // The pane cannot show this window after all; leave the viewport alone.
      shortcutRangeRef.current = null;
      setActiveRange(null);
    }
  }, [window_]);
  /** A range the pane cannot fill shows every bar it has — see the chip. */
  const showAllHistory = useCallback((id: RangeShortcutId) => {
    const chart = chartRef.current;
    if (!chart) return;
    setActiveRange(id);
    shortcutRangeRef.current = null;
    try { chart.timeScale().fitContent(); } catch { setActiveRange(null); }
  }, []);

  /*
   * A clock, only while there is somewhere to put it. UTC, because that is
   * what the chart's own axis has always been — see `lib/chartClock`.
   */
  useEffect(() => {
    if (!showBottomBar && !settings.countdownToBarClose) { setClock(null); return; }
    const tick = (): void => {
      const now = Date.now();
      setNowMs(now);
      setClock(showBottomBar ? fmtChartClock(now, settings.timeZone) : null);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [showBottomBar, settings.countdownToBarClose, settings.timeZone]);

  /*
   * ── TVP8 F-03: the countdown is drawn ON THE PRICE AXIS ───────────────────
   *
   * It was a DOM span placed from a `priceToCoordinate` read taken during
   * React's render, which is a second, slower answer to the question the
   * library answers when it paints the chip — and after a pane insert shrank
   * the container the two disagreed by about 18px and stayed that way, so the
   * countdown's own plate covered the price.
   *
   * Attached once per series and updated in place. The primitive draws the
   * price and the countdown as ONE plate, inside the library's own paint, off
   * one reading of the coordinate — so there is no second copy of the geometry
   * to fall behind, and no second label to disagree about a colour or a width.
   * See `lib/barCountdown` for why one plate and not two labels.
   */
  const countdownRef = useRef<BarCountdownPrimitive | null>(null);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const primitive = new BarCountdownPrimitive();
    countdownRef.current = primitive;
    try { series.attachPrimitive(primitive); }
    catch { countdownRef.current = null; return; }
    return () => {
      countdownRef.current = null;
      try { series.detachPrimitive(primitive); }
      catch { /* the series went away first; the primitive went with it */ }
    };
  }, [chartReady, chartType]);
  useEffect(() => {
    const primitive = countdownRef.current;
    if (!primitive) return;
    const last = candles[candles.length - 1];
    const on = settings.countdownToBarClose && !priceHidden && last !== undefined;
    /*
     * F-03-R: the chip's OWN ground, read the way `SeriesPriceAxisView` reads
     * it — `priceLineColor || lastBarColor` — rather than from the bar's
     * direction. The bar-direction colour is what made the countdown red under
     * a slate price; one value here is what makes the two rows one plate.
     */
    const backColor = chipBackColor(
      settings.lastValueLineColor,
      last && last.close >= last.open ? upColor : downColor,
    );
    primitive.update({
      /*
       * The last CANDLE's close, the anchor the primitive falls back to when
       * it cannot read the visible range — one price, one coordinate, so the
       * two rows cannot describe different rows of the axis.
       */
      price: on ? last.close : null,
      text: on ? countdownText(last.closeTime - nowMs) : null,
      backColor,
      textColor: chipTextColor(backColor),
      ownsPriceRow: on && countdownOwnsChip && settings.lastValueLabel,
    });
  }, [
    nowMs, candles, settings.countdownToBarClose, settings.lastValueLineColor,
    settings.lastValueLabel, countdownOwnsChip, priceHidden, upColor, downColor,
    // Re-stated after a re-attach: a rebuilt primitive starts empty, and
    // waiting for the next second to fill it is a second with no plate.
    chartReady, chartType,
  ]);

  const up = legend ? legend.close >= legend.open : true;
  const chgUp = legend ? legend.chg >= 0 : true;
  const px = up ? "text-up" : "text-down";
  /*
   * R3b-25: the status line's own plate.
   *
   * The reference's `Background` row paints the chart's ground behind the
   * legend's TEXT RUNS at about 60 %, which is what keeps `O H L C` legible
   * over a dense candle. Behind the runs, never around the column: the box
   * around the whole legend is the chrome R3-10 removed and this must not
   * quietly bring back. `--ts-surface-rgb` is the plot's own ground in
   * whichever theme is running.
   */
  const legendPlate = settings.statusLegendBackground
    && settings.statusLegendBackgroundOpacity > 0
    ? `rgb(var(--ts-surface-rgb) / ${settings.statusLegendBackgroundOpacity / 100})`
    : undefined;
  const legendLabel = legend?.kind === "heikinAshi" ? "HA"
    : legend?.kind === "renkoBrick" ? "Brick"
      : legend?.kind === "pointFigureColumn" ? "P&F"
        : legend?.kind === "kagiPoint" ? "Kagi"
          : legend?.kind === "lineBreakLine" ? "Line break" : null;

  return (
    <div className={`flex ${fill ? "h-full" : "h-[520px]"} w-full flex-col overflow-hidden`}>
      <div
        className={`relative bg-surface ${priceHidden ? "hidden" : "min-h-0 flex-1"}`}
        {...(priceHidden ? { "aria-hidden": true } : {})}
      >
      <div
        ref={containerRef}
        className="absolute inset-0 z-[1]"
        /*
         * TVP8: the chart's own right-click menu, wherever the drawing layer
         * is not.
         *
         * The ONLY `onContextMenu` on this chart used to be `DrawingCanvas`'s,
         * and that layer mounts inside `timeAnchored && !priceHidden &&
         * drawings && onDrawingsChange`. So on Renko, Line break, Kagi and
         * Point & figure — every transform, because none of them is
         * time-anchored — right-clicking the chart opened Chrome's menu:
         * Back, Reload, Save as, Inspect, over a trading chart. Four of the
         * twenty-one chart types had no product menu at all.
         *
         * This handler sits on the plot itself and runs only when nothing
         * above it claimed the event — `DrawingCanvas` listens in the capture
         * phase and stops propagation, so on an ordinary candle chart the
         * drawing-aware menu still wins and this never fires.
         */
        onContextMenu={(e) => {
          const handler = onChartContextMenuRef.current;
          if (!handler) return;
          e.preventDefault();
          const host = containerRef.current;
          if (!host) return;
          const rect = host.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const chart = chartRef.current;
          const scaleWidth = chart?.priceScale("right").width() ?? 0;
          const timeHeight = chart?.timeScale().height() ?? 0;
          const region = x > host.clientWidth - scaleWidth ? "axis"
            : y > host.clientHeight - timeHeight ? "time" : "plot";
          const price = region === "plot" && seriesRef.current
            ? seriesRef.current.coordinateToPrice(y) ?? null
            : null;
          handler({ x: e.clientX, y: e.clientY, drawingId: null, price, region });
        }}
      />
      {/*
        F-03: the countdown's TEXT, for a reader who cannot see the axis.

        The label itself is painted onto the price axis by the library (see
        `lib/barCountdown`), and a canvas says nothing to assistive technology.
        This carries the same string, is never positioned, and therefore cannot
        be the thing that overlaps the price chip — which is exactly what the
        element it replaces did.
      */}
      {settings.countdownToBarClose && candles.length > 0 && !priceHidden && (
        <span data-bar-close-countdown className="sr-only">
          {countdownText(candles[candles.length - 1]!.closeTime - nowMs)}
        </span>
      )}
      {barPickX !== null && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 z-10 w-px bg-accent"
          style={{ left: barPickX, bottom: axisFoot.bottom }}
        />
      )}
      {settings.plusButton && axisAlert !== null && onAxisAlert && (
        <button
          type="button"
          aria-label={`Create price alert at ${fmtPrice(axisAlert.price)}`}
          title="Create price alert at this price"
          onClick={() => onAxisAlert(axisAlert.price)}
          className={`absolute z-30 flex h-5 w-5 items-center justify-center rounded-sm bg-surface text-ink shadow-sm hover:bg-state-hover ${
            axisSide === "left" ? "left-0" : "right-0"
          }`}
          style={{ top: Math.max(0, axisAlert.y - 10), transform: axisSide === "left" ? "translateX(50%)" : "translateX(-50%)" }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
            strokeWidth="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" />
            <path d="M7 4v6M4 7h6" />
          </svg>
        </button>
      )}
      {/*
        Everything below is anchored to a canonical bar time, and under sparse
        transforms none of it is drawn — synthetic points are not those bars. See
        `timeAnchoredVisualsTruthful` in `lib/chartType`. Nothing is deleted or
        recomputed: the drawings stay in their per-symbol store, the scripts
        keep their output, and all of it returns on any other chart type.
      */}
      {timeAnchored && !priceHidden && (
        <>
          <PineVisualLayer
            container={containerRef.current}
            chart={chartRef.current}
            overlays={groupedOverlays.price}
            decorations={groupedOverlays.priceDecorations}
            priceToCoordinate={pinePriceToCoordinate}
          />
          {/*
            Volume profiles, over the candles rather than under them.

            Translucent, so the bars they annotate stay readable, and above the
            price series because a profile is read AGAINST the candles — a
            histogram hidden behind them would be a decoration nobody could
            use. It sits below the drawing layer, which keeps the pointer.
          */}
          <VolumeProfileLayer
            container={containerRef.current}
            chart={chartRef.current}
            series={seriesRef.current}
            profiles={priceProfiles}
          />
          {chartType === "footprint" && (
            <FootprintLayer
              container={containerRef.current}
              chart={chartRef.current}
              series={seriesRef.current}
              trades={marketTrades ?? []}
              intervalMs={Math.max(60_000, resolutionMs(interval))}
              tickSize={priceTick && priceTick > 0 ? priceTick : null}
              unavailable={marketTradesError || (priceTick && priceTick > 0 ? null : "Footprint unavailable: provider tick size is not known")}
            />
          )}
          {/* Script drawings sit under the user's own drawing layer, so the
              user's tools keep priority for clicks and hit-testing. */}
          <PineDrawingLayer
            /*
             * Namespaced, because both this layer and the user's drawing
             * canvas remount when the chart is rebuilt and both used the bare
             * `chartReady` counter. Two siblings with the same key is
             * explicitly unsupported by React, which warned about it on every
             * render and reserved the right to duplicate or omit either one.
             */
            key={`pine-${chartReady}`}
            container={containerRef.current}
            chart={chartRef.current}
            series={seriesRef.current}
            candles={candles}
            drawings={pineDrawings ?? null}
          />
          <PineTables drawings={pineDrawings ?? null} />
          {drawings && onDrawingsChange && (
            <DrawingCanvas
              key={`draw-${chartReady}`}
              container={containerRef.current}
              chart={chartRef.current}
              series={seriesRef.current}
              candles={candles}
              interval={interval}
              tool={drawingTool}
              onToolDone={onDrawingToolDone ?? (() => {})}
              drawings={drawings}
              onChange={onDrawingsChange}
              onSelectionChange={onDrawingSelection}
              onContextMenu={onChartContextMenu}
              onOpenSettings={onDrawingSettings}
              magnet={magnet}
              locked={drawingsLocked}
              hidden={drawingsHidden}
              styleFocusSignal={drawingStyleFocusSignal}
              active={paneActive}
            />
          )}
        </>
      )}
      {/*
        One stacked column, not two independently positioned overlays. The OHLC
        readout is width-capped so it cannot run underneath the feed-state badge
        opposite — "feed stalled — price is not current" is the one message on
        this chart that must never be half-covered — and capping it means it can
        wrap, which is exactly when a second overlay pinned to a fixed offset
        would have been drawn straight through it.
      */}
      <div className="pointer-events-none absolute left-2 top-1.5 z-20 flex max-w-[min(68%,880px)] flex-col items-start gap-0.5">
      {/*
        The pane's identity and its own controls, when a pane supplied them.

        First in the column, above the disclosure and the readout, because it is
        what the chart IS rather than something about how it is drawn. A pane
        that supplies it also takes the symbol and the interval OUT of the OHLC
        row below — see `identity` in the props.
      */}
      {/*
        ── R3-14: the identity and the readout are ONE line ──────────────────

        The reference's status line is a single row — name, interval, venue,
        then `O H L C` and the change, all at the same baseline. This product
        stacked them: the identity on line one, the OHLC readout on line two,
        each inside its own `bg-surface/75` box, so the top-left of the chart
        was two filled bars where the reference has one line of type.

        They are a row now, and neither paints a surface. It still wraps — the
        column is width-capped so it cannot run under the feed badge opposite
        — which at a narrow pane puts the readout back on its own line, which
        is the right answer there and was never the defect.
      */}
      <div className="flex max-w-full flex-wrap items-baseline gap-x-2">
        {/*
          ── R3b-24: the logo, the identity and the market dot, in one run ────

          The reference's status line opens with a 24px instrument logo at
          x=65 and closes the identity with a market-status dot after the
          venue. Both are drawn HERE rather than inside `PaneLegend` because
          this is the component that holds the chart's settings — the `Logo`
          and `Open market status` rows have to reach something, and a pane
          legend that had to be told about them would be a third place that
          decides what the status line says.

          The disc is the product's own (`instrumentMark`), not a licensed
          mark: OV-K, and the same disc the symbol dialog and the watchlist
          already draw for this instrument. The dot is absent — not grey —
          for an instrument whose session calendar this build does not hold.
        */}
        {/*
          The three are SIBLINGS in this row, not a wrapper around the
          identity: the legend's column is read by depth in several places —
          `[data-pane-legend]`'s parent chain is how the chart's own tests
          reach the study rows — and a decorative box around it would move
          every one of them.
        */}
        {settings.showStatusLine && settings.statusSymbol && settings.statusLogo && (
          <InstrumentLogo symbol={symbol} />
        )}
        {settings.showStatusLine && settings.statusSymbol ? <>{identity}</> : null}
        {settings.showStatusLine && settings.statusSymbol && settings.statusMarketStatus
          && marketOpen(symbol) === true && (
          <span
            data-market-status="open"
            title="This market is open"
            className="flex h-4 w-4 shrink-0 items-center justify-center self-center"
          >
            <span aria-hidden="true"
              className="h-2 w-2 rounded-full bg-[var(--ts-positive-strong)]" />
            <span className="sr-only">Market open</span>
          </span>
        )}
        {settings.showStatusLine && legend && (
          <div
            style={legendPlate ? { backgroundColor: legendPlate } : undefined}
            className="flex flex-wrap items-baseline gap-x-2 text-[13px] leading-[20px] tabular text-ink-muted">
            {/*
              Named here only when nothing above named them. A pane passes an
              `identity` slot whose whole job is to say which instrument and
              which resolution this is — and to let them be changed — so
              repeating them one line below is the duplication, in miniature,
              that the workspace shell was just rebuilt to remove.
            */}
            {identity === undefined && settings.statusSymbol && (
              <>
                {/* R6 SL-2: the Status-line tab's `Title` dropdown, for a
                    chart rendered without a pane legend of its own. `Name` is
                    R3-14's headline; `Full symbol` is the qualified identity. */}
                {/* R6 SL-2 / R3b-25: `Name`, `Ticker` or `Description` —
                    never the qualified `BINANCE:BTC/USDT · SPOT` form, which
                    the reference does not offer and §5 keeps out of primary
                    copy. R3b-16: one ink for the whole line. */}
                <span className="text-[16px] text-ink">{
                  settings.statusTitle === "symbol" ? displayTicker(symbol)
                    : settings.statusTitle === "description" ? displayDescription(symbol)
                      : displayName(symbol)
                }</span>
                <span className="text-[16px] text-ink">· {interval} ·</span>
              </>
            )}
            {/*
              The readout names its own source whenever it is not the exchange's
              candles. Without it "O 843.11" beside a Heikin-Ashi body is a
              price the instrument never traded, presented in the place a user
              reads traded prices from.
            */}
            {legendLabel && (
              <span
                className="rounded border border-warn/40 px-1 text-warn"
                title={SYNTHETIC_DISCLOSURE_HINT}
              >
                {legendLabel}
                <span className="sr-only"> — displayed values, not exchange prices</span>
              </span>
            )}
            {(legend.kind === "renkoBrick" || legend.kind === "pointFigureColumn") && legend.brick ? (
              <>
                {/*
                  A brick, described as a brick. It has an open and a close and a
                  size, it spans no period, and it has neither a high and a low
                  that differ from those two nor a volume — so no O/H/L/C row is
                  printed. The time shown is the CANONICAL bar whose close
                  completed it, which is the only timestamp a brick has that
                  means anything off this chart.
                */}
                <span className={legend.brick.direction > 0 ? "text-up" : "text-down"}>
                  {legend.brick.direction > 0 ? "▲" : "▼"} {fmtPrice(legend.open)} → {fmtPrice(legend.close)}
                </span>
                <span className="hidden sm:inline">
                  {legend.kind === "pointFigureColumn" ? "box" : "size"} <span className="text-ink">{fmtPrice(legend.brick.size)}</span>
                </span>
                <span className="hidden lg:inline">
                  from <span className="text-ink">
                    {fmtChartBarTime(legend.brick.sourceOpenTime, resolutionMs(interval), settings.timeZone)}
                  </span> {chartTimeZoneLabel(settings.timeZone)}
                </span>
              </>
            ) : (
              <>
                {/* O/H/L and volume are the first things to go on a phone: the close
                    and the change are what the eye actually reads at a glance.
                    Each group is also a Status-line switch of its own. */}
                {/*
                  ── R3b-17: the LETTERS are ink, the values are the bar ──────

                  `O`, `H`, `L` and `C` inherited `text-ink-muted` from the
                  readout row, so the four labels sat a step below the numbers
                  they name; the reference draws them at the same rgb(219) as
                  the headline and spends colour only on the values. The
                  letters are the row's only labels — making them the faintest
                  thing in it is the one place this line could afford to lose
                  contrast and did.
                */}
                {settings.statusOhlc && (
                  <>
                    <span className="hidden sm:inline text-ink">O<span className={px}>{fmtPrice(legend.open)}</span></span>
                    <span className="hidden sm:inline text-ink">H<span className={px}>{fmtPrice(legend.high)}</span></span>
                    <span className="hidden sm:inline text-ink">L<span className={px}>{fmtPrice(legend.low)}</span></span>
                    <span className="text-ink">C<span className={px}>{fmtPrice(legend.close)}</span></span>
                  </>
                )}
                {settings.statusBarChange && (
                  <span className={chgUp ? "text-up" : "text-down"}>
                    {fmtPriceDelta(legend.chg, legend.close)} ({chgUp ? "+" : ""}{legend.chgPct.toFixed(2)}%)
                  </span>
                )}
                {/*
                  R6 SL-3: the day's change, after the BAR's change.

                  Labelled `24h` because the two are side by side and a second
                  unlabelled pair of numbers in the same colours would be read
                  as one. Absent entirely when the feed has no 24h open for
                  this instrument — see `dayChange`.
                */}
                {settings.statusDayChange && dayChange !== null && (
                  <span
                    className={`hidden sm:inline ${dayChange.chgPct >= 0 ? "text-up" : "text-down"}`}
                    title="Change over the last 24 hours"
                  >
                    24h {fmtPriceDelta(dayChange.chg, dayChange.last)}
                    {" "}({dayChange.chgPct >= 0 ? "+" : ""}{dayChange.chgPct.toFixed(2)}%)
                  </span>
                )}
                {legend.volume !== null && settings.statusVolume && (
                  <span className="hidden xl:inline">Vol <span className="text-ink">{legend.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></span>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {/*
        FC2-M4: one line per series, with the explanation behind it.

        This used to render the whole basis sentence — "Built from 1m bars
        loaded for this range, each bar's volume spread across the rows its
        high-low covers" — as a 624 x 38px block laid over the candles at the
        top-left of the canvas, growing to three lines at 390px. That is the
        most-read corner of a chart and it was being spent on prose the reader
        needs once. TradingView's legend is one compact line per series with
        the explanation on hover, and that is what this is now: the series
        name, a marker saying whether the basis is refined or approximate, and
        the sentence itself in the tooltip and for a screen reader.

        The information is not lost and is not hidden behind a click. What
        changed is that it stops covering price by default. A `caution` basis
        still gets the amber treatment, because "these numbers are approximate"
        is a warning and a warning may take the room it needs.
      */}
      {profileNotices.map((profile) => (
        <div
          key={`${profile.title}:${profile.basisNotice}`}
          data-volume-profile-basis={profile.basis}
          role="status"
          title={profile.basisNotice}
          className={`flex max-w-full items-center gap-1 rounded-sm border bg-surface/90 px-1.5 text-[11px] leading-[18px] ${
            profile.basis === "refined"
              ? "border-border/70 text-ink-muted"
              : "border-warn/40 text-warn"
          }`}
        >
          <span className="truncate">{profile.title.replace("Volume Profile", "VP")}</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" className="shrink-0 opacity-70" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.6h.01" />
          </svg>
          <span className="sr-only"> — {profile.basisNotice}</span>
        </div>
      ))}
      {/*
        The synthetic disclosure, on the chart itself rather than only in the
        toolbar. The toolbar describes the ACTIVE pane; in a sixteen-pane
        workspace fifteen charts would otherwise be drawing derived bars with
        nothing on them to say so. Absent for every canonical presentation —
        a label that appears on ordinary candles stops carrying a warning.
      */}
      {syntheticDisclosure(chartType, settings) && !chartUnavailable && (
        <div
          title={SYNTHETIC_DISCLOSURE_HINT}
          className="rounded-sm border border-warn/40 bg-surface/90 px-1.5 text-[11px] leading-[18px] text-warn"
        >
          <span aria-hidden="true">◆ </span>
          {syntheticDisclosure(chartType, settings)}
          <span className="sr-only"> — {SYNTHETIC_DISCLOSURE_HINT}</span>
        </div>
      )}
      {/*
        ── Why a chart type that draws nothing has to SAY so ──────────────────
        Four of the five trade- and profile-driven presentations cleared their
        series and returned when their input was missing: Range and Kagi and
        Point & Figure when the instrument's tick size is unknown, Range again
        when the execution feed returns nothing. Only Volume footprint said
        anything. The rest rendered an empty plot under an amber chip reading
        "Kagi · 1% reversal" — a label asserting a presentation that is not
        there, which is worse than silence.

        The data behaviour was already right and is untouched: none of these
        manufactures a tick or a trade it does not have. What was missing was
        the sentence.
      */}
      {chartUnavailable && (
        <div role="status" className="rounded-sm border border-warn/40 bg-surface/90 px-1.5 text-[11px] leading-[18px] text-warn">
          {chartUnavailable}
        </div>
      )}
      {footprintCoverage && (
        <div
          role="status"
          data-footprint-coverage={footprintCoverage.withTape}
          title={FOOTPRINT_COVERAGE_HINT}
          className="rounded-sm border border-border/70 bg-surface/90 px-1.5 text-[11px] leading-[18px] text-ink-muted"
        >
          Footprint cells on {footprintCoverage.withTape} of {footprintCoverage.total} bars
          <span className="sr-only"> — {FOOTPRINT_COVERAGE_HINT}</span>
        </div>
      )}
      {/*
        Ten moving averages, an overlay study and its levels expand to four
        wrapped rows of numbers laid opaquely across the candles they describe.
        Past a handful of plots the legend opens collapsed — the names and
        their colours, which is what identifies what is on the chart — and the
        chevron brings the values back. The moving-average panel carries the
        same numbers in a form built to be read.
      */}
      {timeAnchored ? (
        /*
          R6 SL-1: three switches, because the legend draws three things.

          One switch used to mount or unmount the whole legend. It is rendered
          now whenever ANY of the three is on, and each of them hides its own
          part; with all three off there is nothing left to draw, which is the
          state the single switch used to be the only way to reach.
        */
        (settings.statusIndicatorTitles || settings.statusIndicatorValues) && <IndicatorLegend
          showTitles={settings.statusIndicatorTitles}
          showInputs={settings.statusIndicatorInputs}
          showValues={settings.statusIndicatorValues}
          /* R3b-25: the reference's `Background` plate, behind the text runs. */
          background={settings.statusLegendBackground}
          backgroundOpacity={settings.statusLegendBackgroundOpacity}
          overlays={groupedOverlays.price}
          time={indicatorHoverTime}
          startCollapsed={compact || groupedOverlays.price.length > 6}
          /* R3-10: no fill. The study rows are type on the plot, like the
             reference's — the `bg-surface/75` box made them a second bar. */
          className="max-w-full"
          /* The same key and the same resolver the indicator panes use. */
          onAction={onIndicatorPaneAction
            && ((key, action) => onIndicatorPaneAction(`indicator:${key}`, action))}
          canAction={canIndicatorAction}
          hidden={hiddenStudies}
        />
      ) : (groupedOverlays.price.length > 0 || groupedOverlays.panes.length > 0
        || (visibleMarkers?.length ?? 0) > 0 || (visibleTrades?.length ?? 0) > 0
        || (drawings?.length ?? 0) > 0) && (
        /*
          Said out loud, not silently done. A user who has applied three
          studies and then switched to Renko must be able to see that the
          studies are still applied and are deliberately not drawn, rather
          than conclude the chart lost them.
        */
        <div className="max-w-full rounded-sm border border-warn/30 bg-surface/90 px-1.5 text-[11px] leading-[18px] text-ink-muted">
          Time-anchored layers hidden
          <span className="hidden md:inline"> — {RENKO_ALIGNMENT_NOTE}</span>
          <span className="sr-only md:hidden"> — {RENKO_ALIGNMENT_NOTE}</span>
        </div>
      )}
      {/*
        FE-09: the feed's real state, next to the price it is supposed to be
        updating. A frozen price used to look exactly like a live one.
        `live` is not rendered — a green dot beside every chart is noise, and
        the states worth interrupting for are the ones where the number on
        screen is NOT current.

        It sits at the FOOT of this column rather than opposite it. Pinned to
        `right-2` it was drawn on top of the price scale — the one strip of the
        chart whose whole job is to say what the numbers are — and at four- and
        eight-pane widths a 60%-capped badge covered the scale outright. Last in
        the column keeps the symbol/OHLC readout where it was (no jitter when a
        socket drops) while putting the badge somewhere it can never obscure a
        price.
      */}
      {live && feedState.status !== "live" && (
        <div
          role="status"
          aria-live="polite"
          title={describeStreamState(feedState).detail}
          className={`flex max-w-full items-center gap-1.5 rounded-sm px-2 text-[11px] leading-[18px] ${FEED_BADGE[feedState.status].className}`}
        >
          <span aria-hidden="true">●</span>
          {describeStreamState(feedState).label}
        </div>
      )}
      </div>
      {/*
        The price axis's own controls, at the foot of the axis they act on.

        TVP8 R1-11. These four were a permanent `log % auto reset` group in the
        bottom row, where the reference has nothing at all: they are statements
        about PRICE sitting on a row that is otherwise entirely about time, and
        they were on screen at full strength on every chart whether or not the
        scale was in a state anyone needed to change. TradingView keeps them on
        the axis and reveals them when the pointer is on it, which is also the
        only place a user looking for them would think to look.

        What is NOT hover-revealed is the mode badge. A logarithmic or percent
        axis that does not say so is a chart whose shape is lying about the
        moves on it, and a disclosure you have to hover to find is not a
        disclosure — so the badge stays lit whenever the axis is not showing
        prices, and only the controls fade.
      */}
      {!priceHidden && (
        <div
          className={`group/axis absolute z-20 flex flex-col items-center justify-end ${
            axisSide === "left" ? "left-0" : "right-0"
          }`}
          style={{ bottom: axisFoot.bottom, width: axisFoot.width > 0 ? axisFoot.width : undefined }}
        >
          <span
            role="group"
            aria-label={`Price scale — ${priceScaleLabel(scale)}`}
            /*
             * Under percent or indexed-to-100 the axis stops reading in the
             * instrument's currency, and a reader who did not switch it — a
             * second person at the same screen, or the same person an hour
             * later — has no other way to know that "−1.24" beside the last
             * candle is not a price. The drawings, the alerts and the studies
             * are all still on real prices; only the axis changed.
             */
            title={scaleShowsPrices(scale) ? undefined
              : `${priceScaleModeLabel(scale.mode)} axis — these numbers are movement `
                + "since the first bar in view, not prices"}
            className="flex flex-col items-center gap-px pb-1"
          >
            {!scaleShowsPrices(scale) && (
              <span className="rounded bg-surface-2 px-1 text-[13px] font-semibold leading-[18px] text-ink">
                {priceScaleModeLabel(scale.mode)}
              </span>
            )}
            {/*
              R6 SC-2: WHEN the four are on screen is the setting.

              `hover` is the reference's own default and what R1-11 left this
              strip at; `always` is for a reader who wants them lit; `hidden`
              takes them off a chart that is only ever read. The mode badge
              above is never any of the three — an axis that is not showing
              prices has to say so whatever this is set to.
            */}
            {settings.scaleButtons !== "hidden" && (
            <span
              data-axis-buttons={settings.scaleButtons}
              className={`flex flex-col items-center gap-px transition-opacity duration-75 ${
                settings.scaleButtons === "always"
                  ? "opacity-100"
                  : "opacity-0 focus-within:opacity-100 group-hover/axis:opacity-100"
              }`}
            >
              <button
                type="button"
                onClick={() => applyScale(togglePriceScaleAuto(scale))}
                aria-pressed={scale.autoScale}
                title="Auto-fit the price scale to the bars in view"
                className={`tvc-control flex h-5 items-center rounded px-1 text-[11px] leading-none ${
                  scale.autoScale ? "font-semibold text-ink" : "text-ink-muted hover:text-ink"
                }`}
              >
                auto
              </button>
              <button
                type="button"
                onClick={() => applyScale(togglePriceScaleMode(scale))}
                aria-pressed={scale.mode === "logarithmic"}
                title="Logarithmic price scale — equal percentage moves take equal vertical space"
                className={`tvc-control flex h-5 items-center rounded px-1 text-[11px] leading-none ${
                  scale.mode === "logarithmic" ? "font-semibold text-ink" : "text-ink-muted hover:text-ink"
                }`}
              >
                log
              </button>
              {/*
                Percent, beside log rather than inside a cycle through four.
                Linear-or-log and currency-or-percent are two independent
                questions, and a single stepping button would make answering
                one of them mean passing through the other.
              */}
              <button
                type="button"
                onClick={() => applyScale(togglePercentScale(scale))}
                aria-pressed={scale.mode === "percentage"}
                title="Percent price scale — movement since the first bar in view"
                className={`tvc-control flex h-5 items-center rounded px-1 text-[11px] leading-none ${
                  scale.mode === "percentage" ? "font-semibold text-ink" : "text-ink-muted hover:text-ink"
                }`}
              >
                %
              </button>
              {/*
                Only while there is something to undo. `reset` on an axis that
                is already linear and auto-fitting is a button whose whole
                effect is to refit a view that is already fitted.
              */}
              {!scale.autoScale && (
                <button
                  type="button"
                  onClick={resetView}
                  title="Reset — fit every loaded bar and return the price scale to linear auto"
                  className="flex h-5 items-center rounded px-1 text-[11px] leading-none text-ink-muted hover:bg-state-hover hover:text-ink"
                >
                  reset
                </button>
              )}
            </span>
            )}
          </span>
        </div>
      )}
      </div>
      {hasPanes && (
        /*
          Normally a capped strip under the chart; while one study is maximised
          it takes the column, and the panes that are not maximised drop to
          their header. Nothing is unmounted either way, so every study keeps
          its configuration, its series and its place in the stack, and
          restoring is one field back.
        */
        <div className={`shrink-0 bg-surface ${
          maximizedPaneId === null
            /*
              FG-02/FG-03: a COLUMN that clips, not a box that scrolls.
              
              This was `max-h-[38%] overflow-y-auto`, and the panes inside it
              were `shrink-0`, so four studies asked for 376px of a 314px box
              and the extra 62 went into a scroll region nobody scrolls. The
              fourth pane was sliced mid-histogram and the time axis — drawn
              once, under the lowest pane showing a plot — went with it.
              
              A scrollbar is the wrong answer here in a way it is not elsewhere:
              the thing at the bottom of this stack is the chart's own axis, and
              an axis you have to scroll to is an axis the chart does not have.
            */
            ? "flex max-h-[38%] flex-col overflow-hidden"
            : "flex min-h-0 flex-1 flex-col overflow-hidden"
        }`}>
          {stackPanes.map((pane) => {
            const maximized = isPaneMaximized(paneLayout, pane.id);
            // While a study is maximised, the rest of the stack is its header
            // row: still there, still ordered, still one click from coming back.
            const collapsed = paneCollapsed(pane.id);
            return (
              <IndicatorPane
                key={pane.id}
                id={pane.id}
                title={pane.title}
                params={pane.params}
                overlays={pane.overlays}
                decorations={pane.decorations}
                hoverTime={indicatorHoverTime}
                onHover={indicatorPaneHover}
                onReady={registerIndicatorPane}
                onRangeChange={indicatorPaneRange}
                onAction={onIndicatorPaneAction}
                /* R6 SC-3: one answer for every study on this chart. */
                lastValue={settings.indicatorLastValue}
                /* R6 SC-5(d): and the axis under the lowest pane is THE axis. */
                dayOfWeekOnLabels={settings.dayOfWeekOnLabels}
                /*
                  R6b-H: the Status-line tab's three indicator rows move a
                  study in its OWN pane too. They were threaded into the price
                  pane's overlay legend below and stopped there, so `Inputs`
                  off dropped `Length 14 · Source close` from a moving average
                  and left the RSI pane's legend untouched — one switch, two
                  answers, on one chart.
                */
                showTitles={settings.statusIndicatorTitles}
                showInputs={settings.statusIndicatorInputs}
                showValues={settings.statusIndicatorValues}
                legendBackground={settings.statusLegendBackground}
                legendBackgroundOpacity={settings.statusLegendBackgroundOpacity}
                /*
                  R6b-14/19: the Canvas and Time-scale rows reach EVERY pane.
                  
                  The reference's oscillator pane carries the chart's grid, its
                  ground, its crosshair and its axis colours; ours carried none
                  of them, so `Background colour` moved 470,512 pixels of the
                  price pane and 27 of the RSI pane — and the date and hour
                  formats moved nothing at all for anybody with a study open,
                  because the visible time axis is drawn by the LOWEST pane.
                */
                dateFormat={settings.dateFormat}
                timeFormat24h={settings.timeFormat24h}
                timeZone={settings.timeZone}
                backgroundColor={settings.backgroundColor}
                backgroundColor2={settings.backgroundColor2}
                backgroundGradient={settings.backgroundGradient}
                gridVertical={settings.gridVertical}
                gridVertColor={settings.gridVertColor}
                gridVertStyle={settings.gridVertStyle}
                gridHorizontal={settings.gridHorizontal}
                gridHorzColor={settings.gridHorzColor}
                gridHorzStyle={settings.gridHorzStyle}
                showCrosshair={settings.showCrosshair}
                crosshairColor={settings.crosshairColor}
                crosshairWidth={settings.crosshairWidth}
                crosshairStyle={settings.crosshairStyle}
                scaleTextColor={settings.scaleTextColor}
                scaleLineColor={settings.scaleLineColor}
                scaleFontSize={settings.scaleFontSize}
                noOverlappingLabels={settings.noOverlappingLabels}
                paneSeparatorColor={settings.paneSeparatorColor}
                paneButtons={settings.paneButtons}
                collapsed={collapsed}
                onToggleCollapsed={togglePaneCollapse}
                maximized={maximized}
                canMaximize
                onToggleMaximized={togglePaneMaximize}
                canMoveUp={canMovePane(paneLayout, pane.id, -1)}
                canMoveDown={canMovePane(paneLayout, pane.id, 1)}
                onMove={moveIndicatorPane}
                height={collapsed
                  ? COLLAPSED_PANE_HEIGHT
                  : paneHeight(paneLayout, pane.id, defaultPaneHeight(stackPanes.length))}
                fill={maximized}
                onHeightChange={resizeIndicatorPane}
                defaultHeight={defaultPaneHeight(stackPanes.length)}
                showTimeAxis={pane.id === axisPaneId}
                /*
                  R8: the study panes had no product menu at all — right-click
                  opened Chrome's. The payload is this chart's own, so it lands
                  in the same `openChartMenu` the price pane's does.
                */
                onContextMenu={onChartContextMenu}
                compact={compact}
              />
            );
          })}
        </div>
      )}
      {replayStrip}
      {showBottomBar && (
        /*
          The range bar, on the pane it acts on.

          Each shortcut is a VIEWPORT, never a timeframe — `1D` on a 5-minute
          chart shows one day of five-minute bars. All nine are always here;
          the ones this pane's loaded history cannot fill are DISABLED rather
          than absent, so a button never scrolls to an empty window and
          presents it as a quiet market, and the row never changes width under
          the pointer. The window always ends at the newest bar the pane holds,
          which under Bar Replay is the horizon, so no shortcut can reveal a
          hidden bar.

          TVP8 R1-11: `log / % / auto / reset` no longer live here. They are
          about PRICE, not time, and the reference puts them at the foot of the
          price axis, revealed on hover of that axis — which is where they now
          are, below the plot.
        */
        /*
          ── TVP8 R1c-07: the row is 38px, and the chips have no gaps ────────

          Measured on the reference at 1440x900: the hairline is at y=861 and
          the row runs 862–899 — 38px, the same height as the toolbar at the
          top of the window. Ours was 33px with a 1px frame under it, so the
          bottom of the screen was five pixels shorter than the reference's and
          the chart above it five pixels taller.

          The chips are `px-[7px]` with NOTHING between them: the reference's
          pitch is the label's own width plus 14, and ours was width plus 16
          (`px-1.5` plus a 2px gap). Two pixels per chip over nine chips put
          `All` fifteen pixels right of where the reference has it, which is
          what moved the separator and the go-to-date button off their marks.
        */
        <div className="flex h-[38px] shrink-0 items-center border-t border-border bg-surface pl-[9px] pr-1.5">
          {showRanges && (
          <div role="group" aria-label="Visible range" className="flex items-center">
            {shortcuts.map(({ shortcut, enabled }) => (
              <button
                key={shortcut.id}
                type="button"
                /*
                 * R1b-08: never dimmed. The reference paints every range chip at
                 * full ink whatever the pane holds; a range the loaded history
                 * cannot fill shows everything the pane has instead, which is
                 * what the reference does when it runs out of bars. The chip
                 * always moves the chart, so it is never disabled.
                 */
                onClick={() => enabled ? applyRangeShortcut(shortcut.id) : showAllHistory(shortcut.id)}
                aria-pressed={activeRange === shortcut.id}
                title={enabled
                  ? `${shortcut.hint} — the visible range only; the timeframe stays ${interval}`
                  : `${shortcut.hint} — shows all the ${interval} history this pane has loaded`}
                /* R1c-07/R1c-19: pitch = label + 14, and the 18px line box
                   the toolbar's own chips use — ours inked a pixel high. */
                className={`tvc-control flex h-[28px] items-center px-[7px] text-[13px] leading-[18px] text-ink ${
                  activeRange === shortcut.id ? "font-semibold" : ""
                }`}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
          )}
          {/*
            Go to a date, from the row rather than only from a right-click.

            It raises the pane's OWN time-axis menu — the one that already
            carries `time:go-to`, which opens `GoToDateModal`, which sets the
            `goTo` signal this chart already honours. There is deliberately no
            second path to the same dialog: the workstation owns the modal, and
            a chart that opened its own copy would be a second mechanism to
            keep in step with the first.
          */}
          {showRanges && (onGoToDate || onChartContextMenu) && (
            <>
              {/*
                R1c-07: the rule lands at x=355 and the go-to-date cell starts
                8px after it, which is what puts that button's 19px glyph at
                x=369. `mx-2` either side would push the rule eight pixels past
                the last chip and take the button with it.
              */}
              <span className={`${SEPARATOR} !ml-px !mr-2`} aria-hidden="true" />
              <button
                type="button"
                aria-label="Go to date"
                title="Go to a date — scroll the chart to a moment in its loaded history"
                onClick={(e) => {
                  if (onGoToDate) { onGoToDate(); return; }
                  const box = e.currentTarget.getBoundingClientRect();
                  onChartContextMenu?.({
                    x: box.left, y: box.top, drawingId: null, price: null, region: "time",
                  });
                }}
                className="tvc-control flex h-[28px] w-[28px] items-center justify-center text-ink"
              >
                {/*
                  R1c-07/R1c-02: a 19×19 ink box at 1px, one unit to one pixel
                  — a 17×15 calendar with an arrow running into it. Ours drew
                  the same silhouette three pixels small at 1.5px of stroke, on
                  a 24-unit box scaled to 22px, so every edge was two half-lit
                  columns rather than one lit one.
                */}
                <svg width="19" height="19" viewBox="0 0 19 19" fill="none" stroke="currentColor"
                  strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke" aria-hidden="true">
                  <path d="M8.5 3.5h9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-2.5" />
                  <path d="M10.5 1.5v3M16.5 1.5v3M7.5 7.5h11" />
                  <path d="M0.5 10.5h6M4 8l2.5 2.5L4 13" />
                </svg>
              </button>
            </>
          )}
          {/*
            The clock names the zone the axis beside it is already in. It is a
            label on an existing authority, not a new one: lightweight-charts
            formats from the UTC fields of the timestamp and Binance stamps its
            klines in UTC. See `lib/chartClock`.
          */}
          {clock !== null && (
            <span
              className="ml-auto hidden pr-1 text-[13px] leading-[18px] tabular text-ink lg:inline"
              title={`Chart times are displayed in ${chartTimeZoneLabel(settings.timeZone)}; candle timestamps stay unchanged.`}
            >
              {clock} {chartTimeZoneLabel(settings.timeZone)}
              <span className="sr-only"> — chart display timezone</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * How each non-live feed state is presented.
 *
 * `stale` is the loudest: the socket is open and the price on screen is not
 * moving, which is the state a user is most likely to misread as calm.
 */
/**
 * The tint per state. The words come from `describeStreamState`, which also
 * names the cause — a refused host, a silent socket — so the chip and its
 * tooltip say why prices are not moving, not merely that they are not.
 */
const FEED_BADGE: Record<ChartFeedState, { className: string }> = {
  idle: { className: "bg-surface/75 text-ink-muted" },
  connecting: { className: "bg-surface/75 text-ink-muted" },
  open: { className: "bg-surface/75 text-ink-muted" },
  live: { className: "bg-surface/75 text-up" },
  /*
    The two loud states keep an opaque plate under the tint. They are read
    against whatever candle happens to be behind them, and a translucent
    coloured wash alone is not reliably legible over a bright green bar.
  */
  reconnecting: { className: "border border-warn/40 bg-surface/90 text-warn" },
  stale: { className: "border border-down/40 bg-surface/90 text-down" },
};

/**
 * How many trade arrows may still carry a price label.
 *
 * Counted in MARKERS, not trades: a closed trade draws two. Forty is roughly
 * where lightweight-charts stops being able to place the text without
 * collisions on a typical desktop plot.
 */
export const TRADE_LABEL_LIMIT = 40;

/** Entry and exit markers a trade list will actually draw on the loaded bars. */
export function tradeMarkerCount(
  trades: readonly Trade[] | undefined, inWindow: (t: number) => boolean
): number {
  let n = 0;
  for (const t of trades ?? []) {
    if (inWindow(t.entryTime / 1000)) n += 1;
    if (t.exitTime !== null && inWindow(t.exitTime / 1000)) n += 1;
  }
  return n;
}

/**
 * The instrument's own mark, before the status line's name (R3b-24).
 *
 * 24px, because that is what the reference's logo measures at 1440×900, and a
 * disc rather than a licensed logo because this installation ships none — see
 * `instrumentMark`, which is also what the symbol dialog and the watchlist
 * row draw. `aria-hidden`: the name it stands for is the very next thing in
 * the row, and a screen reader reading "B" before "Bitcoin / TetherUS" would
 * be reading the decoration twice.
 */
function InstrumentLogo({ symbol }: { symbol: string }) {
  const mark = instrumentMark(symbol);
  return (
    <span
      data-status-logo=""
      aria-hidden="true"
      title={displayName(symbol)}
      className={`flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-full
        text-[12px] font-semibold ${mark.className}`}
    >
      {mark.initial}
    </span>
  );
}

export { INTERVAL_MS };
