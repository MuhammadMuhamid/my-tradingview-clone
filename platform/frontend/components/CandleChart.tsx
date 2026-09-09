"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { resolutionMs, type Resolution } from "@/lib/resolution";
import {
  createChart, IChartApi, ISeriesApi, Time, UTCTimestamp,
  SeriesMarker, MouseEventParams, LineStyle, LineType, PriceScaleMode,
  type AreaData, type BarData, type CandlestickData, type HistogramData,
  type LineData, type WhitespaceData,
} from "lightweight-charts";
import { INTERVAL_MS, type Candle, type Trade } from "@/lib/types";
import { rangeChanged, snapToBarIndexBy } from "@/lib/paneSync";
import { marketFeed, WS_SILENCE_TIMEOUT_MS, type FeedState, type KlineTick } from "@/lib/marketFeed";
import { describeStreamState } from "@/lib/marketStream";
import { datasetKey as datasetKeyOf, LiveTickGate, type DatasetIdentity } from "@/lib/liveDataset";
import {
  baseChartOptions, CHART_ACCENT, CHART_CAUTION, CHART_DOWN, CHART_MUTED, CHART_UP, volumeColor,
  subscribeChartTheme,
} from "@/lib/chartTheme";
import {
  createDisposalGuard, useChartMeasuring, useDetachChartObserver,
} from "@/lib/chartLifecycle";
import { fmtPrice, fmtPriceDelta } from "@/lib/format";
import { DrawingCanvas } from "@/components/tv/DrawingCanvas";
import { PineDrawingLayer, PineTables } from "@/components/tv/PineDrawingLayer";
import { IndicatorLegend } from "@/components/tv/IndicatorLegend";
import { IndicatorPane, type PaneAction } from "@/components/tv/IndicatorPane";
import { PineVisualLayer } from "@/components/tv/PineVisualLayer";
import { VolumeProfileLayer } from "@/components/tv/VolumeProfileLayer";
import type { PineDrawings } from "@/lib/api";
import type { Drawing, DrawingTool } from "@/lib/drawings";
import {
  groupChartOverlays, planColoredCandleMutation, planOhlcMutation, planSeriesMutation,
  type ChartBarColor, type ChartDecoration, type ChartOverlay, type ChartPoint,
  type ChartProfileDecoration,
} from "@/lib/chartSeries";
import {
  chartTransform, legendSource, mainSeriesDatum, renderKind, renkoParams,
  syntheticDisclosure, timeAnchoredVisualsTruthful,
  RENKO_ALIGNMENT_NOTE, SYNTHETIC_DISCLOSURE_HINT,
  type ChartRenderKind, type ChartType, type LegendSource, type MainSeriesDatum,
  type OhlcBar,
} from "@/lib/chartType";
import {
  canonicalOpenTime, isRenkoBrick, transformAll, transformStep,
  DEFAULT_RENKO_ATR_PERIOD, type TransformCursor, type TransformKind,
} from "@/lib/chartTransforms";
import {
  DEFAULT_PRICE_SCALE, priceScaleLabel, priceScaleModeLabel, resetPriceScale,
  scaleShowsPrices, setPriceScaleAuto, togglePercentScale, togglePriceScaleAuto,
  togglePriceScaleMode, type PriceScaleState,
} from "@/lib/priceScale";
import {
  availableRangeShortcuts, loadedWindow, resolveRangeShortcut, sameViewport,
  type LoadedWindow, type RangeShortcutId,
} from "@/lib/rangeShortcuts";
import {
  canMovePane, COLLAPSED_PANE_HEIGHT, EMPTY_PANE_LAYOUT, isPaneCollapsed,
  isPaneMaximized, movePane, orderedPanes, paneHeight, reconcilePaneLayout,
  setPaneHeight, togglePaneCollapsed, togglePaneMaximized,
  type PaneLayoutState,
} from "@/lib/indicatorPaneLayout";
import { CHART_TIME_ZONE, CHART_TIME_ZONE_NOTE, fmtChartBarTime, fmtChartClock } from "@/lib/chartClock";

export type { ChartOverlay } from "@/lib/chartSeries";

/**
 * The legend readout for whatever bar the crosshair is on.
 *
 * ── What `kind` decides ────────────────────────────────────────────────────
 *
 * The legend used to print the canonical candle whatever the chart drew, which
 * was wrong in two different ways at once. On Heikin Ashi the four numbers
 * labelled O/H/L/C did not describe the body under the pointer — they
 * described a bar that is not on screen. On Renko they described a time candle
 * on a chart that has no time candles at all.
 *
 * So the readout says which bars it is reading, and the renderer says so on
 * screen too. `canonical` is the only kind whose numbers are exchange prices;
 * the other two are display values and are labelled as such wherever they are
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
}

type OverlaySeriesEntry =
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
type MainSeriesApi =
  | ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line">
  | ISeriesApi<"Area"> | ISeriesApi<"Baseline">;

function setMainSeriesData(api: MainSeriesApi, type: ChartType, rows: MainSeriesDatum[]): void {
  const data = rows as unknown;
  const kind = renderKind(type);
  if (kind === "candles") (api as ISeriesApi<"Candlestick">).setData(data as CandlestickData<Time>[]);
  else if (kind === "bars") (api as ISeriesApi<"Bar">).setData(data as BarData<Time>[]);
  else if (kind === "area") (api as ISeriesApi<"Area">).setData(data as AreaData<Time>[]);
  else if (kind === "baseline") (api as ISeriesApi<"Baseline">).setData(data as LineData<Time>[]);
  else (api as ISeriesApi<"Line">).setData(data as LineData<Time>[]);
}

function updateMainSeries(api: MainSeriesApi, type: ChartType, row: MainSeriesDatum): void {
  const datum = row as unknown;
  const kind = renderKind(type);
  if (kind === "candles") (api as ISeriesApi<"Candlestick">).update(datum as CandlestickData<Time>);
  else if (kind === "bars") (api as ISeriesApi<"Bar">).update(datum as BarData<Time>);
  else if (kind === "area") (api as ISeriesApi<"Area">).update(datum as AreaData<Time>);
  else if (kind === "baseline") (api as ISeriesApi<"Baseline">).update(datum as LineData<Time>);
  else (api as ISeriesApi<"Line">).update(datum as LineData<Time>);
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
    return chart.addCandlestickSeries({
      upColor: hollow ? "rgba(0,0,0,0)" : CHART_UP,
      downColor: CHART_DOWN,
      borderUpColor: CHART_UP, borderDownColor: CHART_DOWN,
      wickUpColor: CHART_UP, wickDownColor: CHART_DOWN,
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
    return chart.addBarSeries({ upColor: CHART_UP, downColor: CHART_DOWN, thinBars: false });
  }
  if (kind === "area") {
    return chart.addAreaSeries({
      lineColor: CHART_ACCENT, lineWidth: 2,
      topColor: "rgba(79,140,255,0.28)", bottomColor: "rgba(79,140,255,0.02)",
      priceLineVisible: false,
    });
  }
  return chart.addLineSeries({
    color: CHART_ACCENT, lineWidth: 2, priceLineVisible: false,
    // A step holds each close until the next one, which is what a close IS —
    // the price at one instant, not a path between two of them.
    lineType: type === "stepLine" ? LineType.WithSteps : LineType.Simple,
  });
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
  atrPeriod: number;
  /** Canonical bars already folded into `cursor`. */
  bars: number;
  cursor: TransformCursor;
  output: OhlcBar[];
}

/** The head's output plus whatever the forming bar currently produces. */
function withFormingBar(head: TransformHead, candles: readonly Candle[]): OhlcBar[] {
  const forming = candles[candles.length - 1];
  if (!forming || head.bars !== candles.length - 1) return [...head.output];
  return [...head.output, ...transformStep(head.cursor, forming).emitted];
}

/** Fold the whole canonical series from scratch. */
function rebuildTransform(
  kind: TransformKind, atrPeriod: number, candles: readonly Candle[]
): { head: TransformHead; display: OhlcBar[] } {
  const closed = candles.length > 0 ? candles.slice(0, -1) : [];
  const { cursor, output } = transformAll(kind, closed, { atrPeriod });
  const head: TransformHead = { kind, atrPeriod, bars: closed.length, cursor, output };
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
  head: TransformHead | null, kind: TransformKind, atrPeriod: number,
  candles: readonly Candle[]
): { head: TransformHead; display: OhlcBar[] } {
  const closedCount = candles.length - 1;
  if (!head || head.kind !== kind || head.atrPeriod !== atrPeriod
    || head.bars > closedCount || closedCount - head.bars > 1) {
    return rebuildTransform(kind, atrPeriod, candles);
  }
  let next = head;
  if (head.bars === closedCount - 1) {
    const stepped = transformStep(head.cursor, candles[head.bars]!);
    next = {
      ...head, bars: head.bars + 1, cursor: stepped.cursor,
      output: [...head.output, ...stepped.emitted],
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

function replaceOverlayData(entry: OverlaySeriesEntry, points: ChartPoint[]): void {
  if (entry.kind === "Line") entry.api.setData(points.map(lineDatum));
  else if (entry.kind === "Histogram") entry.api.setData(points.map(histogramDatum));
  else if (entry.kind === "Area") entry.api.setData(points.map(areaDatum));
  else if (entry.kind === "Candlestick") entry.api.setData(points.map(customCandleDatum));
  else entry.api.setData(points.map(customBarDatum));
  entry.data = points;
}

function updateOverlayData(entry: OverlaySeriesEntry, point: ChartPoint): void {
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
  symbol, interval, candles, dataset, trades, priceLines, overlays, decorations, barColors,
  markers, pineDrawings,
  live = true, fill = false,
  chartType = "candles",
  drawingTool = "cursor", onDrawingToolDone, drawings, onDrawingsChange,
  onDrawingSelection, onChartContextMenu,
  magnet = false, drawingsLocked = false, drawingsHidden = false,
  onPriceSelect,
  onAnnotationSelect,
  compact = false,
  identity,
  onLiveBarBoundary,
  onCrosshairMove, crosshairTime,
  onVisibleRangeChange, visibleRange, followEdgeTime,
  onIndicatorPaneAction,
  priceScale, onPriceScaleChange, resetSignal, drawingStyleFocusSignal, paneActive,
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
      /** Which strip was clicked: the plot, or the price axis. */
      region: "plot" | "axis";
    }
  ) => void;
  magnet?: boolean;
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
  /** Bumped to move focus into the selected drawing's style bar. */
  drawingStyleFocusSignal?: number;
  /** Whether this pane has the workspace's focus; gates Delete and Escape. */
  paneActive?: boolean;
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
  const [indicatorHoverTime, setIndicatorHoverTime] = useState<number | null>(null);
  /** FE-09: what the live feed is actually doing, so the UI can say so. */
  const [feedState, setFeedState] = useState<FeedState>(IDLE_FEED);
  /** bumped once the chart/series exist, so the drawing layer can attach */
  const [chartReady, setChartReady] = useState(0);
  /** bumped only when the chart itself is (re)created, so the series effect
   *  can depend on it without re-triggering itself through `chartReady`. */
  const [chartCreated, setChartCreated] = useState(0);
  const groupedOverlays = useMemo(
    () => groupChartOverlays(overlays ?? [], decorations ?? []),
    [overlays, decorations]
  );

  // ── the price scale ──────────────────────────────────────────────────────

  /** Controlled if a caller supplied one; this chart's own otherwise. */
  const scale = priceScale ?? ownPriceScale;
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
  const reconcileScaleRef = useRef<() => void>(() => {});
  reconcileScaleRef.current = () => {
    const chart = chartRef.current;
    if (!chart) return;
    let auto: boolean;
    try { auto = chart.priceScale("right").options().autoScale; }
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
    try {
      chart.priceScale("right").applyOptions({
        mode: LIBRARY_SCALE_MODE[scale.mode],
        autoScale: scale.autoScale,
        invertScale: scale.invert === true,
      });
    } catch { /* the chart went away between render and effect */ }
  }, [scale, chartReady]);

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
    if (legendSource(mainKindRef.current) === "renkoBrick") {
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
      color: CHART_MUTED,
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
      if (chartTransform(mainKindRef.current) === "renko") {
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

  // Load candles without rebuilding all 10,000 points for a last-bar update.
  useEffect(() => {
    const series = seriesRef.current;
    const vol = volRef.current;
    if (!series || !vol) return;
    // The identity of the bars on screen — not of the request. While a new
    // window loads these are still the previous window's bars, and every
    // decision below (refit, tick admission) is made about what is drawn.
    const datasetKey = datasetKeyOf({ symbol: heldSymbol, interval: heldInterval });
    const nextColors = new Map(
      (barColors ?? []).flatMap((point) => point.color === null ? [] : [[point.time, point.color] as const])
    );
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
    const candleDatum = (c: Candle) =>
      mainSeriesDatum(kind, c, nextColors.get(c.openTime / 1000) ?? null);
    const volumeDatum = (c: Candle) => ({
      time: (c.openTime / 1000) as UTCTimestamp,
      value: c.volume,
      color: volumeColor(c.open, c.close),
    });

    /*
     * Volume is canonical and stays canonical: it is the exchange's own figure
     * at the exchange's own bar times, whatever the price series is drawing.
     * Renko is the one exception, and it is an omission rather than a
     * reinterpretation — a brick is not a time bar, so there is no honest
     * volume to put under it and none is drawn.
     */
    if (transform === "renko") {
      if (volumeDrawnRef.current) {
        vol.setData([]);
        volumeDrawnRef.current = false;
      }
    } else if (mutation === "replace" || !volumeDrawnRef.current) {
      vol.setData(candles.map(volumeDatum));
      volumeDrawnRef.current = true;
    } else if (mutation === "update" && candles.length > 0) {
      vol.update(volumeDatum(candles[candles.length - 1]!));
    }

    if (transform === null) {
      transformHeadRef.current = null;
      displayRef.current = [];
      if (mutation === "replace") {
        setMainSeriesData(series, kind, candles.map(candleDatum));
        mainSeriesDirtyRef.current = false;
      } else if (mutation === "update" && candles.length > 0) {
        updateMainSeries(series, kind, candleDatum(candles[candles.length - 1]!));
      }
    } else {
      /*
       * A chart-only transform. The canonical candles above are untouched and
       * still drive the legend, the volume, the markers, the drawings and
       * everything downstream of this component; only the bars handed to the
       * price series are derived.
       */
      const atrPeriod = renkoParams(kind)?.atrPeriod ?? DEFAULT_RENKO_ATR_PERIOD;
      const rebuilt = rebuildTransform(transform, atrPeriod, candles);
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
        setMainSeriesData(series, kind, display.map(transformedDatum));
        mainSeriesDirtyRef.current = false;
      } else if (plan === "update" && display.length > 0) {
        updateMainSeries(series, kind, transformedDatum(display[display.length - 1]!));
      }
      displayRef.current = display;
    }
    // Refreshed only now: a transform's legend reads the bars it just drew,
    // so it cannot be computed before `displayRef` has been brought up to date.
    setLegend(latestLegend());
    if (datasetKeyRef.current !== datasetKey) {
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
  }, [candles, heldSymbol, heldInterval, latestLegend, barColors, chartReady]);


  /**
   * Whether anything anchored to a canonical timestamp can be drawn on this
   * presentation at all. False under Renko — see `lib/chartType`.
   */
  const timeAnchored = timeAnchoredVisualsTruthful(chartType);

  // Markers update independently: adding an indicator must not reset zoom.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    /*
     * Renko draws no markers at all.
     *
     * A marker is placed at a canonical bar time. The Renko axis is brick
     * positions, so the library would pin every marker to whichever brick
     * happens to sit nearest that number — a BUY arrow under a brick the trade
     * has no relationship with, which reads as evidence and is not. Nothing is
     * changed about the trades or the script output; they are simply not drawn
     * here. Every other presentation, Heikin Ashi included, keeps them.
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

    if (candles.length > 0 && ((trades?.length ?? 0) > 0 || (markers?.length ?? 0) > 0)) {
      const drawn: SeriesMarker<Time>[] = [];
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
      const labelled = tradeMarkerCount(trades, inWindow) <= TRADE_LABEL_LIMIT;
      for (const t of trades ?? []) {
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
      for (const m of markers ?? []) {
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
  }, [candles, trades, markers, chartReady, timeAnchored]);

  // Live stop / target / entry levels for a running position.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const drawn = (priceLines ?? [])
      .filter((l) => Number.isFinite(l.price))
      .map((l) => series.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 1,
        lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: l.title,
      }));
    return () => { for (const line of drawn) series.removePriceLine(line); };
  }, [priceLines, chartReady]);

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

  // lightweight-charts v4 does not expose a marker identity in click events.
  // Resolve only exact marker bar times, or a price line within an 8px hit
  // target; no nearest-bar shifting is used for trading evidence.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !onAnnotationSelect || onPriceSelect) return;
    const onClick = (param: MouseEventParams): void => {
      const time = typeof param.time === "number" ? param.time : null;
      const marker = time === null ? undefined : (markers ?? []).find((item) =>
        item.id && item.time === time);
      if (marker?.id) { onAnnotationSelect(marker.id); return; }
      if (!param.point) return;
      const line = (priceLines ?? []).find((item) => {
        if (!item.id) return false;
        const coordinate = series.priceToCoordinate(item.price);
        return coordinate !== null && Math.abs(coordinate - param.point!.y) <= 8;
      });
      if (line?.id) onAnnotationSelect(line.id);
    };
    chart.subscribeClick(onClick);
    return () => chart.unsubscribeClick(onClick);
  }, [markers, priceLines, onAnnotationSelect, onPriceSelect, chartReady]);

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
      const lastValueVisible = !compact && overlay.instanceId !== "moving-averages";
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
      });
      else if (entry.kind === "Histogram") entry.api.applyOptions({
        color: overlay.color, lastValueVisible, title: axisTitle,
      });
      else if (entry.kind === "Area") entry.api.applyOptions({
        lineColor: overlay.color, lastValueVisible, title: axisTitle,
      });
      else if (entry.kind === "Candlestick") entry.api.applyOptions({
        upColor: overlay.color, downColor: overlay.color,
        borderUpColor: overlay.color, borderDownColor: overlay.color,
        wickUpColor: overlay.color, wickDownColor: overlay.color,
        lastValueVisible, title: axisTitle,
      });
      else entry.api.applyOptions({
        upColor: overlay.color, downColor: overlay.color,
        lastValueVisible, title: axisTitle,
      });
      const points = overlay.data.filter((point) =>
        Number.isFinite(point.time) && point.time >= first && point.time <= lastTime);
      const plan = planSeriesMutation(entry.data, points);
      if (plan === "replace") replaceOverlayData(entry, points);
      else if (plan === "update") updateOverlayData(entry, points[points.length - 1]!);
    }
  }, [groupedOverlays.price, chartReady, candles, compact, timeAnchored]);

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
      if (transform === null) {
        updateMainSeries(series, kind, mainSeriesDatum(kind, {
          openTime: tick.openTime, open: tick.open, high: tick.high,
          low: tick.low, close: tick.close,
        }, override));
      } else {
        const atrPeriod = renkoParams(kind)?.atrPeriod ?? DEFAULT_RENKO_ATR_PERIOD;
        const advanced = advanceTransform(
          transformHeadRef.current, transform, atrPeriod, list
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
          setMainSeriesData(series, kind, display.map(transformedDatum));
        } else if (plan === "update" && display.length > 0) {
          updateMainSeries(series, kind, transformedDatum(display[display.length - 1]!));
        }
        displayRef.current = display;
      }
      if (transform !== "renko") {
        vol.update({
          time, value: tick.volume,
          color: volumeColor(tick.open, tick.close),
        });
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
      if (tickGateRef.current.decide(tick) === "hold") return;
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
  }, [symbol, interval, live, latestLegend, legendAtCanonical]);

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
    if (transform === "renko") {
      /*
       * The incoming time is canonical, because that is the only kind this
       * chart ever publishes. It is mapped onto the LAST brick that canonical
       * bar completed — through `canonicalOpenTime`, never by comparing the
       * brick's own rendering time with another pane's market timestamps. A
       * moment that completed no brick draws nothing, which is the same
       * "no bar here" answer a pane on another instrument gives.
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

  // ── the bottom range bar ─────────────────────────────────────────────────

  /**
   * The window this pane actually holds — under replay, already clipped to the
   * horizon, because `candles` is what the pane is drawing and nothing here
   * consults a clock.
   */
  const window_: LoadedWindow | null = useMemo(
    () => loadedWindow(candles, resolutionMs(interval)), [candles, interval]);
  const shortcuts = useMemo(
    () => (window_ ? availableRangeShortcuts(window_) : []), [window_]);
  /*
   * Ranges are a statement about a time axis, and Renko does not have one, so
   * the shortcuts go with the rest of the time-anchored layers. The price
   * scale is a different question — it is about price, which every
   * presentation has — so the bar itself stays.
   */
  const showRanges = timeAnchored && shortcuts.length > 0;
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

  /*
   * A clock, only while there is somewhere to put it. UTC, because that is
   * what the chart's own axis has always been — see `lib/chartClock`.
   */
  useEffect(() => {
    if (!showBottomBar) { setClock(null); return; }
    const tick = (): void => setClock(fmtChartClock(Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [showBottomBar]);

  const up = legend ? legend.close >= legend.open : true;
  const chgUp = legend ? legend.chg >= 0 : true;
  const px = up ? "text-up" : "text-down";
  const legendLabel = legend?.kind === "heikinAshi" ? "HA"
    : legend?.kind === "renkoBrick" ? "Brick" : null;

  return (
    <div className={`flex ${fill ? "h-full" : "h-[520px]"} w-full flex-col overflow-hidden`}>
      <div
        className={`relative bg-surface ${priceHidden ? "hidden" : "min-h-0 flex-1"}`}
        {...(priceHidden ? { "aria-hidden": true } : {})}
      >
      <div ref={containerRef} className="absolute inset-0 z-[1]" />
      {/*
        Everything below is anchored to a canonical bar time, and under Renko
        none of it is drawn — the bricks are not those bars. See
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
      {identity}
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
      {syntheticDisclosure(chartType) && (
        <div
          title={SYNTHETIC_DISCLOSURE_HINT}
          className="rounded-sm border border-warn/40 bg-surface/90 px-1.5 text-[11px] leading-[18px] text-warn"
        >
          <span aria-hidden="true">◆ </span>
          {syntheticDisclosure(chartType)}
          <span className="sr-only"> — {SYNTHETIC_DISCLOSURE_HINT}</span>
        </div>
      )}
      {legend && (
        <div className="flex flex-wrap items-baseline gap-x-2 rounded-sm bg-surface/75 px-1.5 text-[13px] leading-[20px] tabular text-ink-muted">
          {/*
            Named here only when nothing above named them. A pane passes an
            `identity` slot whose whole job is to say which instrument and which
            resolution this is — and to let them be changed — so repeating them
            one line below is the duplication, in miniature, that the workspace
            shell was just rebuilt to remove.
          */}
          {identity === undefined && (
            <>
              <span className="font-semibold text-ink">{symbol}</span>
              <span>· {interval} ·</span>
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
          {legend.kind === "renkoBrick" && legend.brick ? (
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
                size <span className="text-ink">{fmtPrice(legend.brick.size)}</span>
              </span>
              <span className="hidden lg:inline">
                from <span className="text-ink">
                  {fmtChartBarTime(legend.brick.sourceOpenTime, resolutionMs(interval))}
                </span> {CHART_TIME_ZONE}
              </span>
            </>
          ) : (
            <>
              {/* O/H/L and volume are the first things to go on a phone: the close
                  and the change are what the eye actually reads at a glance. */}
              <span className="hidden sm:inline">O <span className={px}>{fmtPrice(legend.open)}</span></span>
              <span className="hidden sm:inline">H <span className={px}>{fmtPrice(legend.high)}</span></span>
              <span className="hidden sm:inline">L <span className={px}>{fmtPrice(legend.low)}</span></span>
              <span>C <span className={px}>{fmtPrice(legend.close)}</span></span>
              <span className={chgUp ? "text-up" : "text-down"}>
                {fmtPriceDelta(legend.chg, legend.close)} ({chgUp ? "+" : ""}{legend.chgPct.toFixed(2)}%)
              </span>
              {legend.volume !== null && (
                <span className="hidden xl:inline">Vol <span className="text-ink">{legend.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></span>
              )}
            </>
          )}
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
        <IndicatorLegend
          overlays={groupedOverlays.price}
          time={indicatorHoverTime}
          startCollapsed={compact || groupedOverlays.price.length > 6}
          className="max-w-full rounded bg-surface/75 px-1 py-0.5"
        />
      ) : (groupedOverlays.price.length > 0 || groupedOverlays.panes.length > 0
        || (markers?.length ?? 0) > 0 || (trades?.length ?? 0) > 0
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
            ? "max-h-[38%] overflow-y-auto"
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
                compact={compact}
              />
            );
          })}
        </div>
      )}
      {showBottomBar && (
        /*
          The range bar, on the pane it acts on.

          Each shortcut is a VIEWPORT, never a timeframe — `1D` on a 5-minute
          chart shows one day of five-minute bars. Only the ranges this pane's
          loaded history can actually fill are offered, so a button never
          scrolls to an empty window and presents it as a quiet market; and the
          window always ends at the newest bar the pane holds, which under Bar
          Replay is the horizon, so no shortcut can reveal a hidden bar.
        */
        <div className="flex shrink-0 items-center gap-1 border-t border-border bg-surface px-1.5 py-0.5">
          {showRanges && (
          <div role="group" aria-label="Visible range" className="flex items-center gap-0.5">
            {shortcuts.map((shortcut) => (
              <button
                key={shortcut.id}
                type="button"
                onClick={() => applyRangeShortcut(shortcut.id)}
                aria-pressed={activeRange === shortcut.id}
                title={`${shortcut.hint} — the visible range only; the timeframe stays ${interval}`}
                className={`rounded-sm px-1.5 text-[12px] leading-5 ${
                  activeRange === shortcut.id
                    ? "bg-surface-2 font-semibold text-ink"
                    : "text-ink-muted hover:bg-surface-2 hover:text-ink"
                }`}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
          )}
          <span className="ml-auto flex items-center gap-1.5 text-[11px] leading-[18px] tabular text-ink-faint">
            {/*
              The clock names the zone the axis beside it is already in. It is
              a label on an existing authority, not a new one: lightweight-
              charts formats from the UTC fields of the timestamp and Binance
              stamps its klines in UTC. See `lib/chartClock`.
            */}
            {clock !== null && (
              <span className="hidden lg:inline" title={CHART_TIME_ZONE_NOTE}>
                {clock} {CHART_TIME_ZONE}
                <span className="sr-only"> — {CHART_TIME_ZONE_NOTE}</span>
              </span>
            )}
            {/*
              The price scale — the one control on this bar that is not about
              time. Its current mode is always identifiable: a chart on a
              logarithmic axis that does not say so is a chart whose shape is
              lying about the moves on it.
            */}
            <span
              role="group"
              aria-label={`Price scale — ${priceScaleLabel(scale)}`}
              /*
               * Under percent or indexed-to-100 the axis stops reading in the
               * instrument's currency, and a reader who did not switch it — a
               * second person at the same screen, or the same person an hour
               * later — has no other way to know that "−1.24" beside the last
               * candle is not a price. The drawings, the alerts and the
               * studies are all still on real prices; only the axis changed.
               */
              title={scaleShowsPrices(scale) ? undefined
                : `${priceScaleModeLabel(scale.mode)} axis — these numbers are movement `
                  + "since the first bar in view, not prices"}
              className="flex items-center gap-0.5"
            >
              {!scaleShowsPrices(scale) && (
                <span className="rounded bg-surface-2 px-1 py-0.5 font-semibold text-ink">
                  {priceScaleModeLabel(scale.mode)}
                </span>
              )}
              <button
                type="button"
                onClick={() => applyScale(togglePriceScaleMode(scale))}
                aria-pressed={scale.mode === "logarithmic"}
                title="Logarithmic price scale — equal percentage moves take equal vertical space"
                className={`rounded px-1.5 py-0.5 transition-colors ${
                  scale.mode === "logarithmic"
                    ? "bg-surface-2 font-semibold text-ink"
                    : "text-ink-muted hover:bg-surface-2 hover:text-ink"
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
                className={`rounded px-1.5 py-0.5 transition-colors ${
                  scale.mode === "percentage"
                    ? "bg-surface-2 font-semibold text-ink"
                    : "text-ink-muted hover:bg-surface-2 hover:text-ink"
                }`}
              >
                %
              </button>
              <button
                type="button"
                onClick={() => applyScale(togglePriceScaleAuto(scale))}
                aria-pressed={scale.autoScale}
                title="Auto-fit the price scale to the bars in view"
                className={`rounded px-1.5 py-0.5 transition-colors ${
                  scale.autoScale
                    ? "bg-surface-2 font-semibold text-ink"
                    : "text-ink-muted hover:bg-surface-2 hover:text-ink"
                }`}
              >
                auto
              </button>
              <button
                type="button"
                onClick={resetView}
                title="Reset — fit every loaded bar and return the price scale to linear auto"
                className="rounded px-1.5 py-0.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                reset
              </button>
            </span>
          </span>
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

export { INTERVAL_MS };
