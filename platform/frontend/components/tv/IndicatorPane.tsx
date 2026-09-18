"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ColorType, createChart, CrosshairMode, LineStyle, LineType,
  type AreaData, type BarData, type CandlestickData, type HistogramData,
  type IChartApi, type ISeriesApi, type LineData, type Time, type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import {
  canUpdateTail, planSeriesMutation, plotValueAt,
  type ChartDecoration, type ChartOverlay, type ChartPoint,
} from "@/lib/chartSeries";
import { baseChartOptions, subscribeChartTheme } from "@/lib/chartTheme";
import {
  resolveBackgroundGradient, type ChartTimeZone, type DateFormatName, type LineStyleName,
  type ScaleButtonsMode,
} from "@/lib/chartSettings";
import { axisTickFormatter, hoursFormatter } from "@/lib/chartClock";
import { createDisposalGuard, useDetachChartObserver } from "@/lib/chartLifecycle";
import { clampPaneHeight, MAX_PANE_HEIGHT, MIN_PANE_HEIGHT } from "@/lib/indicatorPaneLayout";
import { IndicatorLegend } from "@/components/tv/IndicatorLegend";
import { PineVisualLayer } from "@/components/tv/PineVisualLayer";

export type SeriesEntry =
  | { kind: "Line"; api: ISeriesApi<"Line">; data: ChartPoint[] }
  | { kind: "Histogram"; api: ISeriesApi<"Histogram">; data: ChartPoint[] }
  | { kind: "Area"; api: ISeriesApi<"Area">; data: ChartPoint[] }
  | { kind: "Candlestick"; api: ISeriesApi<"Candlestick">; data: ChartPoint[] }
  | { kind: "Bar"; api: ISeriesApi<"Bar">; data: ChartPoint[] };

function seriesKind(overlay: ChartOverlay): SeriesEntry["kind"] {
  if (overlay.style === "histogram" || overlay.style === "columns") return "Histogram";
  if (overlay.style === "area") return "Area";
  if (overlay.style === "candles") return "Candlestick";
  if (overlay.style === "bars") return "Bar";
  return "Line";
}

/** A settings dash pattern as the library's own enum — the price chart's rule. */
function paneLineStyle(style: LineStyleName): LineStyle {
  return style === "dotted" ? LineStyle.Dotted
    : style === "dashed" ? LineStyle.Dashed : LineStyle.Solid;
}

function visible(point: ChartPoint): boolean {
  return point.value !== null && Number.isFinite(point.value) && point.color !== null;
}

function alphaColor(color: string, alpha: string): string {
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)
    ? `${color.slice(0, 7)}${alpha}` : color;
}

function lineDatum(point: ChartPoint): LineData<Time> | WhitespaceData<Time> {
  return visible(point)
    ? { time: point.time as UTCTimestamp, value: point.value!, ...(point.color ? { color: point.color } : {}) }
    : { time: point.time as UTCTimestamp };
}

function histogramDatum(point: ChartPoint): HistogramData<Time> | WhitespaceData<Time> {
  return visible(point)
    ? { time: point.time as UTCTimestamp, value: point.value!, ...(point.color ? { color: point.color } : {}) }
    : { time: point.time as UTCTimestamp };
}

function areaDatum(point: ChartPoint): AreaData<Time> | WhitespaceData<Time> {
  return visible(point)
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

function candlestickDatum(point: ChartPoint): CandlestickData<Time> | WhitespaceData<Time> {
  return visible(point) && [point.open, point.high, point.low, point.close].every(Number.isFinite)
    ? {
        time: point.time as UTCTimestamp,
        open: point.open!, high: point.high!, low: point.low!, close: point.close!,
        ...(point.color ? { color: point.color } : {}),
        ...(point.wickColor ? { wickColor: point.wickColor } : {}),
        ...(point.borderColor ? { borderColor: point.borderColor } : {}),
      }
    : { time: point.time as UTCTimestamp };
}

function barDatum(point: ChartPoint): BarData<Time> | WhitespaceData<Time> {
  return visible(point) && [point.open, point.high, point.low, point.close].every(Number.isFinite)
    ? {
        time: point.time as UTCTimestamp,
        open: point.open!, high: point.high!, low: point.low!, close: point.close!,
        ...(point.color ? { color: point.color } : {}),
      }
    : { time: point.time as UTCTimestamp };
}

export function replaceData(entry: SeriesEntry, points: ChartPoint[]): void {
  if (entry.kind === "Line") entry.api.setData(points.map(lineDatum));
  else if (entry.kind === "Histogram") entry.api.setData(points.map(histogramDatum));
  else if (entry.kind === "Area") entry.api.setData(points.map(areaDatum));
  else if (entry.kind === "Candlestick") entry.api.setData(points.map(candlestickDatum));
  else entry.api.setData(points.map(barDatum));
  entry.data = points;
}

/**
 * The same seam as `updateOverlayData` in `CandleChart`, for the plots that
 * live in their own pane — which is where the owner-found P0 was actually
 * thrown, because a study's reference levels are pane series.
 *
 * A point behind the series' own tail is applied as the replacement it is.
 * `update()` cannot move a bar backwards; it throws, and the throw reaches the
 * route's error boundary from inside this effect.
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
export function updateData(entry: SeriesEntry, points: ChartPoint[]): void {
  const point = points[points.length - 1]!;
  if (!canUpdateTail(entry.data, point.time)) { replaceData(entry, points); return; }
  if (entry.kind === "Line") entry.api.update(lineDatum(point));
  else if (entry.kind === "Histogram") entry.api.update(histogramDatum(point));
  else if (entry.kind === "Area") entry.api.update(areaDatum(point));
  else if (entry.kind === "Candlestick") entry.api.update(candlestickDatum(point));
  else entry.api.update(barDatum(point));
  entry.data = entry.data.length > 0 && entry.data[entry.data.length - 1]!.time === point.time
    ? [...entry.data.slice(0, -1), point]
    : [...entry.data, point];
}

/** What a pane header control asks the owner of the indicator list to do. */
export type PaneAction = "hide" | "settings" | "remove";

export function IndicatorPane({
  id, title, params, overlays, decorations, hoverTime, onHover, onReady, onRangeChange,
  onAction,
  onOpenObjectTree,
  collapsed = false, onToggleCollapsed,
  maximized = false, canMaximize = false, onToggleMaximized,
  canMoveUp = false, canMoveDown = false, onMove,
  height: controlledHeight, fill = false, onHeightChange,
  showTimeAxis = true,
  defaultHeight = 144,
  compact = false,
  lastValue = true,
  dayOfWeekOnLabels = true,
  dateFormat,
  timeFormat24h = true,
  timeZone = "UTC",
  backgroundColor = "",
  backgroundColor2 = "",
  backgroundGradient = false,
  gridVertical = true,
  gridVertColor = "",
  gridVertStyle = "solid",
  gridHorizontal = true,
  gridHorzColor = "",
  gridHorzStyle = "solid",
  showCrosshair = true,
  crosshairColor = "",
  crosshairWidth = 1,
  crosshairStyle = "dashed",
  scaleTextColor = "",
  scaleLineColor = "",
  scaleFontSize,
  noOverlappingLabels = true,
  paneSeparatorColor = "",
  paneButtons = "hover",
  showTitles = true, showInputs = true, showValues = true,
  legendBackground = true, legendBackgroundOpacity = 60,
  onContextMenu,
}: {
  id: string;
  title: string;
  params: string;
  overlays: ChartOverlay[];
  decorations: ChartDecoration[];
  hoverTime: number | null;
  onHover: (time: number | null) => void;
  onReady: (id: string, chart: IChartApi | null) => void;
  onRangeChange: (id: string, range: { from: number; to: number }) => void;
  /**
   * Hide/settings/remove for the instance that owns this pane. Omit to render
   * the pane with no controls, which is what the strategy tester and the
   * split-view panes want.
   */
  onAction?: (paneId: string, action: PaneAction) => void;
  /** The legend menu's `Object tree` row. */
  onOpenObjectTree?: () => void;
  /**
   * Show only the header, keeping the pane in the stack.
   *
   * The chart is NOT torn down — the section keeps a small non-zero height and
   * the header is painted over it. A collapsed pane whose container went to
   * 0 x 0 would take the library's own resize path down with it; see
   * `lib/chartLifecycle`.
   */
  collapsed?: boolean;
  onToggleCollapsed?: (paneId: string) => void;
  /** This pane currently has the whole chart column. */
  maximized?: boolean;
  /** False when maximising would mean nothing — a single, uncollapsed pane. */
  canMaximize?: boolean;
  onToggleMaximized?: (paneId: string) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMove?: (paneId: string, direction: -1 | 1) => void;
  /**
   * The pane's height in pixels. Owned by the chart rather than by this
   * component so that a pane which unmounts — a presentation change, a study
   * removed and re-added — comes back the size the user left it.
   */
  height?: number;
  /** Take the remaining column height instead of a fixed one (maximised). */
  fill?: boolean;
  onHeightChange?: (paneId: string, height: number) => void;
  /**
   * Draw the time axis under this pane. Only the bottom-most pane does: the
   * panes are horizontally locked to the price chart, so repeating the same
   * axis under each one spent a row of pixels per pane to say the same thing
   * three times over. TradingView draws it once, at the bottom.
   */
  showTimeAxis?: boolean;
  /**
   * Whether this pane's series carry their last value on the axis.
   *
   * R6 SC-3: the settings dialog's `Indicators` row is one answer for every
   * study on the chart, and a study in its own pane is still a study. The
   * price-pane overlays take the same flag in `CandleChart`.
   */
  lastValue?: boolean;
  /**
   * `Mon 29` on this pane's day labels (R6 SC-5(d)).
   *
   * The visible time axis is not always the price chart's: it is drawn once,
   * under the LOWEST pane on screen, which is this component whenever a study
   * has a pane. So the setting has to reach here too, or a user with an RSI
   * open would find the row moves nothing.
   */
  dayOfWeekOnLabels?: boolean;
  /*
   * ── R6b-14/19: the Canvas and Time-scale rows reach EVERY pane ───────────
   *
   * Measured: `Background colour #2a2e39` moved 470,512 pixels of the price
   * pane and 27 of the RSI pane (noise); `Text`/`Lines` colour moved the panes
   * 0 px; the study panes drew no grid at all; `Crosshair` off left the synced
   * vertical line drawn in them; and at the 1D range `12-hours` and
   * `yyyy-MM-dd` changed nothing on the ONE time axis a user can see, because
   * that axis is drawn under the lowest pane by THIS chart and not by the
   * price chart.
   *
   * None of these is a new capability: every one is a lightweight-charts
   * option this component's own `applyOptions` could always have carried. Each
   * defaults to the library or theme answer, so a pane mounted without them —
   * the strategy tester's, a preview — looks exactly as it did.
   */
  /** The axis's date pattern; omitted leaves the library's own. */
  dateFormat?: DateFormatName;
  /** 24-hour axis labels; false is 12-hour with am/pm. */
  timeFormat24h?: boolean;
  /** IANA display zone shared with the price chart's axis. */
  timeZone?: ChartTimeZone;
  backgroundColor?: string;
  backgroundColor2?: string;
  backgroundGradient?: boolean;
  gridVertical?: boolean;
  gridVertColor?: string;
  gridVertStyle?: LineStyleName;
  gridHorizontal?: boolean;
  gridHorzColor?: string;
  gridHorzStyle?: LineStyleName;
  showCrosshair?: boolean;
  crosshairColor?: string;
  crosshairWidth?: number;
  crosshairStyle?: LineStyleName;
  scaleTextColor?: string;
  scaleLineColor?: string;
  /** Axis label size in px; omitted leaves the theme's own. */
  scaleFontSize?: number;
  noOverlappingLabels?: boolean;
  paneSeparatorColor?: string;
  paneButtons?: ScaleButtonsMode;
  /**
   * ── R8: a study pane had NO product menu at all ──────────────────────────
   *
   * Right-clicking an RSI or MACD pane — its plot, its price axis, the time
   * axis under it — left `defaultPrevented` false and opened CHROME's menu
   * (Back, Reload, Save as, Inspect) over a trading chart. The price pane has
   * had its own handler since TVP8; the panes below it never got one, so the
   * product's `timeAxisMenu()` and `priceAxisMenu()` were unreachable for any
   * user with a study open — and the time axis is drawn under the LOWEST pane,
   * which means the time-scale menu was unreachable at all.
   *
   * The payload is the price chart's own, so the pane's owner routes it
   * through the one `openChartMenu` that already exists.
   */
  onContextMenu?: (event: {
    x: number; y: number; drawingId: string | null; price: number | null;
    region: "plot" | "axis" | "time";
  }) => void;
  /**
   * ── R6b-H: the Status-line tab's three indicator rows reach HERE too ─────
   *
   * `Titles`, `Inputs` and `Values` were threaded into the price pane's
   * overlay legend and stopped there, so turning `Inputs` off dropped
   * `Length 14 · Source close` from a moving average on the candles and moved
   * an RSI pane's own legend by nothing at all — the same switch, two answers,
   * on one chart. `IndicatorLegend` has carried the three props since R6 SL-1;
   * this mount simply never passed them.
   */
  showTitles?: boolean;
  showInputs?: boolean;
  showValues?: boolean;
  /** R3b-25: the legend's `Background` plate and its opacity. */
  legendBackground?: boolean;
  legendBackgroundOpacity?: number;
  /**
   * Opening height. Shrinks as panes are added so a third oscillator does not
   * push the stack past the space it is allowed and get clipped mid-body.
   * A pane the user has resized keeps its own height.
   */
  defaultHeight?: number;
  /**
   * Phone layout. A pane is ~106px tall there, and the desktop presentation
   * spends three wrapped legend rows and a column of `Overbought 70.00`-width
   * axis badges on top of it — most of the oscillator the pane exists to show.
   * Compact starts the legend collapsed and drops the series names from the
   * scale, keeping the values.
   */
  compact?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef(new Map<string, SeriesEntry>());
  /**
   * The chart normally supplies the height. The local fallback keeps this
   * component usable on its own, and stops the pane count moving a height the
   * user has dragged.
   */
  const [ownHeight, setOwnHeight] = useState(defaultHeight);
  const resizedRef = useRef(false);
  useEffect(() => {
    if (!resizedRef.current) setOwnHeight(defaultHeight);
  }, [defaultHeight]);
  const height = controlledHeight ?? ownHeight;
  const [ready, setReady] = useState(0);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const onRangeRef = useRef(onRangeChange);
  onRangeRef.current = onRangeChange;
  /** Read at creation; kept in sync by its own effect so the chart is not
   *  rebuilt when a pane is added below this one. */
  const showTimeAxisRef = useRef(showTimeAxis);
  showTimeAxisRef.current = showTimeAxis;
  const dayOfWeekRef = useRef(dayOfWeekOnLabels);
  dayOfWeekRef.current = dayOfWeekOnLabels;
  const timeFormatRef = useRef(timeFormat24h);
  timeFormatRef.current = timeFormat24h;
  const timeZoneRef = useRef(timeZone);
  timeZoneRef.current = timeZone;
  /** Read in an event handler, so the pane is not rebuilt when it changes. */
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;

  useEffect(() => {
    if (!containerRef.current) return;
    const seriesEntries = seriesRef.current;
    const base = baseChartOptions();
    const chart = createChart(containerRef.current, {
      ...base,
      rightPriceScale: { ...base.rightPriceScale, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: {
        ...base.timeScale,
        visible: showTimeAxisRef.current,
        tickMarkFormatter: axisTickFormatter(
          dayOfWeekRef.current, timeFormatRef.current, timeZoneRef.current),
      },
    });
    const unsubscribeTheme = subscribeChartTheme(chart);
    const guard = createDisposalGuard();
    const crosshair = (param: { time?: Time }): void => {
      if (guard.disposed) return;
      onHoverRef.current(typeof param.time === "number" ? param.time : null);
    };
    const range = (next: { from: Time; to: Time } | null): void => {
      if (guard.disposed) return;
      if (!next || typeof next.from !== "number" || typeof next.to !== "number") return;
      /*
       * A pane that holds no points yet must not move anybody else.
       *
       * lightweight-charts emits a visible-range change as soon as a chart is
       * created, from the default logical range of an empty series — a span of
       * a few bars around the epoch. That range was broadcast to the price
       * chart, which obediently zoomed to it: with three studies on screen the
       * chart opened showing about three candles across the full width, and
       * the only way back was to scroll out by hand. It is a race, so it did
       * not always fire; it fired every time once the panes changed size.
       *
       * The pane's own data is the test. Once a series has points, its range
       * is real and syncs as before.
       */
      let hasPoints = false;
      for (const entry of seriesRef.current.values()) {
        if (entry.data.length > 0) { hasPoints = true; break; }
      }
      if (!hasPoints) return;
      onRangeRef.current(id, { from: next.from, to: next.to });
    };
    chart.subscribeCrosshairMove(crosshair);
    chart.timeScale().subscribeVisibleTimeRangeChange(range);
    chartRef.current = chart;
    onReady(id, chart);
    setReady((value) => value + 1);
    return () => {
      // Nothing already in flight may reach the workspace after this point.
      guard.dispose();
      onReady(id, null);
      chart.unsubscribeCrosshairMove(crosshair);
      chart.timeScale().unsubscribeVisibleTimeRangeChange(range);
      unsubscribeTheme();
      chart.remove();
      chartRef.current = null;
      seriesEntries.clear();
    };
  }, [id, onReady]);

  // Oscillator panes come and go with their studies and with the chart that
  // hosts them, so they need the same detach as the price chart.
  useDetachChartObserver(chartRef);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const wanted = new Map(overlays.map((overlay) => [overlay.id, overlay]));
    for (const [overlayId, entry] of seriesRef.current) {
      const overlay = wanted.get(overlayId);
      if (!overlay || seriesKind(overlay) !== entry.kind) {
        chart.removeSeries(entry.api);
        seriesRef.current.delete(overlayId);
      }
    }
    for (const overlay of overlays) {
      const kind = seriesKind(overlay);
      let entry = seriesRef.current.get(overlay.id);
      const precision = overlay.precision;
      const priceFormat = precision === null || precision === undefined ? undefined : {
        type: "price" as const, precision, minMove: 10 ** -precision,
      };
      const overlayLastValue = lastValue && overlay.priceScaleLabelVisible !== false;
      if (!entry) {
        if (kind === "Histogram") {
          entry = { kind, api: chart.addHistogramSeries({
            color: overlay.color, base: 0, priceLineVisible: false,
            lastValueVisible: overlayLastValue, ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else if (kind === "Area") {
          entry = { kind, api: chart.addAreaSeries({
            lineColor: overlay.color,
            topColor: alphaColor(overlay.color, "55"),
            bottomColor: alphaColor(overlay.color, "08"),
            priceLineVisible: false, lastValueVisible: overlayLastValue,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else if (kind === "Candlestick") {
          entry = { kind, api: chart.addCandlestickSeries({
            upColor: overlay.color, downColor: overlay.color,
            borderUpColor: overlay.color, borderDownColor: overlay.color,
            wickUpColor: overlay.color, wickDownColor: overlay.color,
            priceLineVisible: false, lastValueVisible: overlayLastValue,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else if (kind === "Bar") {
          entry = { kind, api: chart.addBarSeries({
            upColor: overlay.color, downColor: overlay.color,
            priceLineVisible: false, lastValueVisible: overlayLastValue,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else {
          entry = { kind, api: chart.addLineSeries({
            color: overlay.color, priceLineVisible: false, lastValueVisible: overlayLastValue,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        }
        seriesRef.current.set(overlay.id, entry);
      }
      if (entry.kind === "Line") entry.api.applyOptions({
        color: overlay.color,
        lineWidth: Math.max(1, Math.min(4, overlay.width ?? 2)) as 1 | 2 | 3 | 4,
        lineStyle: overlay.lineStyle === "dotted" ? LineStyle.Dotted
          : overlay.dashed || overlay.lineStyle === "dashed" ? LineStyle.Dashed : LineStyle.Solid,
        lineType: overlay.style === "stepline" ? LineType.WithSteps : LineType.Simple,
        lineVisible: overlay.style !== "circles" && overlay.style !== "cross",
        pointMarkersVisible: overlay.style === "circles",
        // Values on the axis, names in the legend — see CandleChart. An
        // oscillator's reference levels otherwise printed "70" beside
        // "70.0000" on every line.
        title: "",
        ...(priceFormat ? { priceFormat } : {}),
      });
      else if (entry.kind === "Histogram") entry.api.applyOptions({
        color: overlay.color, ...(priceFormat ? { priceFormat } : {}),
      });
      else if (entry.kind === "Area") entry.api.applyOptions({
        lineColor: overlay.color, ...(priceFormat ? { priceFormat } : {}),
      });
      else if (entry.kind === "Candlestick") entry.api.applyOptions({
        upColor: overlay.color, downColor: overlay.color,
        borderUpColor: overlay.color, borderDownColor: overlay.color,
        wickUpColor: overlay.color, wickDownColor: overlay.color,
        ...(priceFormat ? { priceFormat } : {}),
      });
      else entry.api.applyOptions({
        upColor: overlay.color, downColor: overlay.color,
        ...(priceFormat ? { priceFormat } : {}),
      });

      const points = overlay.data.filter((point) => Number.isFinite(point.time) && point.time > 0);
      const plan = planSeriesMutation(entry.data, points);
      if (plan === "replace") replaceData(entry, points);
      else if (plan === "update") updateData(entry, points);
    }
    onReady(id, chart);
    // `lastValue` is read when a series is CREATED; the effect below re-applies
    // it to series that already exist.
  }, [id, onReady, overlays, ready, lastValue]);

  // Keep the pane's crosshair aligned with price and sibling panes. Use the
  // first plot that has a value at this time only as the vertical anchor; all
  // plot values still come from the shared historical legend lookup.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    /*
     * R6b-19: the SYNCED crosshair follows the Canvas switch too.
     *
     * `setCrosshairPosition` draws the line whatever `crosshair.mode` says, so
     * with `Crosshair` off the price pane lost its rule and every study pane
     * below it went on drawing one under the pointer.
     */
    if (hoverTime === null || !showCrosshair) {
      chart.clearCrosshairPosition();
      return;
    }
    for (const overlay of overlays) {
      const value = plotValueAt(overlay.data, hoverTime);
      const entry = seriesRef.current.get(overlay.id);
      if (value !== null && entry) {
        chart.setCrosshairPosition(value, hoverTime as UTCTimestamp, entry.api);
        return;
      }
    }
    chart.clearCrosshairPosition();
  }, [hoverTime, overlays, ready, showCrosshair]);

  const priceToCoordinate = useCallback((overlayId: string, value: number): number | null => {
    const entry = seriesRef.current.get(overlayId);
    return entry ? entry.api.priceToCoordinate(value) as number | null : null;
  }, []);

  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({ visible: showTimeAxis });
  }, [showTimeAxis, ready]);

  /*
   * ── R6b-13: OFF is a FUNCTION, never `undefined` ──────────────────────────
   *
   * lightweight-charts merges options with a spread, so a key whose value is
   * `undefined` overwrites nothing: the formatter installed when the row was ON
   * stayed installed for ever and `Day of week` OFF moved nothing, anywhere.
   * `axisTickFormatter(false, …, "UTC")` returns every tick as `null`, which is the
   * library's own "you did not format it".
   */
  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: {
        tickMarkFormatter: axisTickFormatter(dayOfWeekOnLabels, timeFormat24h, timeZone),
      },
    });
  }, [dayOfWeekOnLabels, timeFormat24h, timeZone, ready]);

  /*
   * ── R6b-14/19: the pane takes the whole Canvas tab ───────────────────────
   *
   * One `applyOptions`, for the same reason the price chart has one: these are
   * all chart-level options, and applying them from six effects would mean six
   * races against the theme subscription. `subscribeChartTheme` rewrites the
   * base options whenever the root theme flips, so the values and `ready` are
   * the deps and the user's answers go back on top of the theme's.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const gradient = resolveBackgroundGradient(backgroundColor, backgroundColor2);
    try {
      chart.applyOptions({
        layout: {
          background: backgroundGradient
            ? {
                type: ColorType.VerticalGradient,
                topColor: gradient.top,
                bottomColor: gradient.bottom,
              }
            : { type: ColorType.Solid, color: backgroundColor || "rgba(0,0,0,0)" },
          ...(scaleFontSize === undefined ? {} : { fontSize: scaleFontSize }),
          ...(scaleTextColor ? { textColor: scaleTextColor } : {}),
        },
        grid: {
          vertLines: {
            visible: gridVertical,
            ...(gridVertColor ? { color: gridVertColor } : {}),
            style: paneLineStyle(gridVertStyle),
          },
          horzLines: {
            visible: gridHorizontal,
            ...(gridHorzColor ? { color: gridHorzColor } : {}),
            style: paneLineStyle(gridHorzStyle),
          },
        },
        crosshair: {
          mode: showCrosshair ? CrosshairMode.Normal : CrosshairMode.Hidden,
          vertLine: {
            width: Math.max(1, Math.min(4, crosshairWidth)) as 1 | 2 | 3 | 4,
            style: paneLineStyle(crosshairStyle),
            ...(crosshairColor ? { color: crosshairColor } : {}),
          },
          horzLine: {
            width: Math.max(1, Math.min(4, crosshairWidth)) as 1 | 2 | 3 | 4,
            style: paneLineStyle(crosshairStyle),
            ...(crosshairColor ? { color: crosshairColor } : {}),
          },
        },
        ...(scaleLineColor
          ? {
              rightPriceScale: { borderColor: scaleLineColor, alignLabels: noOverlappingLabels },
              leftPriceScale: { borderColor: scaleLineColor, alignLabels: noOverlappingLabels },
              timeScale: { borderColor: scaleLineColor },
            }
          : {
              rightPriceScale: { alignLabels: noOverlappingLabels },
              leftPriceScale: { alignLabels: noOverlappingLabels },
            }),
        localization: {
          /*
           * The same pair the price chart uses, from `lib/chartClock`: two
           * functions, so 12-hours and 24-hours are both reachable. With a
           * study open this is the axis a user is actually reading.
           */
          timeFormatter: hoursFormatter(timeFormat24h, timeZone),
          ...(dateFormat === undefined ? {} : { dateFormat }),
        },
      });
    } catch { /* the chart went away between render and effect */ }
  }, [
    backgroundColor, backgroundColor2, backgroundGradient,
    gridVertical, gridVertColor, gridVertStyle,
    gridHorizontal, gridHorzColor, gridHorzStyle,
    showCrosshair, crosshairColor, crosshairWidth, crosshairStyle,
    scaleTextColor, scaleLineColor, scaleFontSize,
    dateFormat, timeFormat24h, timeZone, noOverlappingLabels, ready,
  ]);

  /*
   * R6 SC-3: the axis badge, re-applied when the SETTING changes.
   *
   * The series above take `lastValueVisible` at creation and are created once;
   * without this the dialog's `Indicators` row would move the price pane's
   * studies and leave every oscillator pane exactly as it was.
   */
  useEffect(() => {
    for (const entry of seriesRef.current.values()) {
      const overlay = overlays.find((candidate) => seriesRef.current.get(candidate.id) === entry);
      try { entry.api.applyOptions({
        lastValueVisible: lastValue && overlay?.priceScaleLabelVisible !== false,
      }); }
      catch { /* the series went away between render and effect */ }
    }
  }, [lastValue, overlays, ready]);

  const beginResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resizedRef.current = true;
    const startY = event.clientY;
    const startHeight = height;
    const move = (next: PointerEvent): void => {
      const value = clampPaneHeight(startHeight - (next.clientY - startY));
      setOwnHeight(value);
      onHeightChange?.(id, value);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }, [height, id, onHeightChange]);

  const resizable = !collapsed && !fill;

  return (
    <section
      /*
        ── FG-02/FG-03: `shrink-0` is what cut the stack in half ─────────────
        
        The stack is capped at a share of the chart column. With `shrink-0`
        every pane insisted on its full height, the total ran past the cap, and
        the container's `overflow-y-auto` scrolled the remainder out of sight —
        so the FOURTH pane showed 30 of its 94 pixels, and the time axis, which
        is drawn once under the LOWEST pane showing a plot, was scrolled out of
        the chart entirely. The product had no dates under it at all.
        
        The pane's own height is its preferred size now, not its minimum: it
        keeps that height while the stack fits and gives ground when it does
        not. `min-h-0` is what makes that possible at all — a flex item's
        default `min-height: auto` refuses to shrink below its content, which
        is the same clipping wearing a different name.
      */
      /*
        ── R3-13: the group is the PANE, not the column ──────────────────────

        This was `group/pane`, and so is `ChartPane`'s outer container — the
        whole chart column, every study pane included. Tailwind's named-group
        variant compiles to a DESCENDANT selector, so `group-hover/pane:` on a
        cluster inside pane B matched a hover anywhere in the column, and
        putting the pointer on the RSI pane lit up the MACD pane's controls
        too. The reference reveals the actions of the pane under the pointer
        and nothing else.

        A distinct name is the whole fix: `group/studypane` has exactly one
        ancestor that can match — this section.
      */
      className={`group/studypane relative border-t border-border bg-surface ${
        fill ? "min-h-0 flex-1" : "min-h-0 shrink"
      }`}
      style={{
        ...(fill ? {} : { height }),
        ...(paneSeparatorColor ? { borderTopColor: paneSeparatorColor } : {}),
      }}
      aria-label={`${title} indicator pane`}
    >
      {/*
        The grab area sits ON the border rather than in a header row of its own.
        A pane is 96–360px tall; spending 20 of them on a bar whose only job is
        to be draggable is 20 pixels of oscillator the user came here to read.
      */}
      {resizable && (
        <button
          type="button"
          aria-label={`Resize ${title} pane`}
          title={`Drag to resize pane (${MIN_PANE_HEIGHT}–${MAX_PANE_HEIGHT}px)`}
          onPointerDown={beginResize}
          /*
            R3-15: neutral, never accent. The separator is a shared control
            state, and the contract reserves accent for meaning — an 8px band
            of accent blue across the chart on every accidental hover was the
            loudest thing on the workstation and said only "you can drag this".
          */
          className="absolute -top-1 z-20 h-2 w-full cursor-row-resize touch-none bg-transparent hover:bg-state-hover focus-visible:bg-state-hover"
        />
      )}
      <div
        ref={containerRef}
        className="absolute inset-0 z-[1]"
        /*
         * R8: the same three regions the price pane reports, measured from
         * this pane's own axes — the price scale on the right, and the time
         * scale only when this is the pane that draws it.
         */
        onContextMenu={(e) => {
          const handler = onContextMenuRef.current;
          if (!handler) return;
          e.preventDefault();
          const host = containerRef.current;
          if (!host) return;
          const rect = host.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const chart = chartRef.current;
          let scaleWidth = 0;
          let timeHeight = 0;
          try {
            scaleWidth = chart?.priceScale("right").width() ?? 0;
            timeHeight = showTimeAxisRef.current ? chart?.timeScale().height() ?? 0 : 0;
          } catch { /* the chart went away between render and event */ }
          const region = x > host.clientWidth - scaleWidth ? "axis"
            : y > host.clientHeight - timeHeight ? "time" : "plot";
          handler({ x: e.clientX, y: e.clientY, drawingId: null, price: null, region });
        }}
      />
      {/*
        Collapsed panes keep their chart: it is squashed to the header's own
        height, which is small but never zero, and covered. Unmounting it here
        would take the container out from under a live chart mid-commit — the
        crash `lib/chartLifecycle` exists to prevent — and recreating it on
        expand would lose the series the study has already drawn.
      */}
      {collapsed && <div className="absolute inset-0 z-[2] bg-surface" />}
      {!collapsed && (
        <PineVisualLayer
          container={containerRef.current}
          chart={chartRef.current}
          overlays={overlays}
          decorations={decorations}
          priceToCoordinate={priceToCoordinate}
        />
      )}
      {/*
        ── R3-10/R3-12: one transparent legend row, two clusters ─────────────

        The legend was a `rounded bg-surface/80` box and the controls a second
        `rounded bg-surface/85` box beside it — two filled rectangles laid on
        the oscillator, which is what made the header read as chrome. The
        reference's legend row is 24px of transparent type 4px below the
        pane's top, and its actions are in TWO places: the ones that act on the
        STUDY (hide, settings, remove) inside the legend row between the
        parameters and the values, and the ones that act on the PANE (order,
        collapse, maximize) at the pane's own top-right edge.

        The study half is `IndicatorLegend`'s own cluster now, so a study in
        its own pane and a study overlaid on price get the identical row.
      */}
      <div className="absolute left-2 top-1 z-[3] flex h-6 max-w-[calc(100%-96px)] items-start">
        <IndicatorLegend
          overlays={overlays}
          time={collapsed ? null : hoverTime}
          title={title}
          collapsible={compact || collapsed}
          startCollapsed={compact || collapsed}
          className="min-w-0"
          /* R6b-H: a study in its own pane obeys the same three rows. */
          showTitles={showTitles}
          showInputs={showInputs}
          showValues={showValues}
          background={legendBackground}
          backgroundOpacity={legendBackgroundOpacity}
          onAction={onAction && ((_instanceId, action) => onAction(id, action))}
          onOpenObjectTree={onOpenObjectTree}
          canAction={onAction ? () => true : undefined}
        />
      </div>
      {/*
        The pane's own controls, at the pane's top-right edge.

        Revealed on hover or focus rather than reserving a row: a pane is
        94–144px tall by default and a permanent toolbar would be a tenth of
        the oscillator it sits on. Each is a real button so the stack can be
        rearranged from the keyboard.
      */}
      {/*
        R3b-21: 4px gaps, and the last box 4px from the pane's content edge.

        The cluster ran at `gap-0.5` (2px) inset `right-2` (8px); the
        reference's four boxes sit at a 28px pitch with 4px between them and
        the right-most one ends 4px before the axis.
      */}
      {paneButtons !== "hidden" && <span
        data-pane-buttons={paneButtons}
        className={`absolute right-1 top-1 z-[3] flex shrink-0 items-center gap-1 transition-opacity focus-within:opacity-100 ${
          paneButtons === "always" ? "opacity-100" : "opacity-0 group-hover/studypane:opacity-100"
        }`}
      >
        {/*
          ── R3-12: only the direction that is possible ──────────────────────

          Both arrows were always drawn and the impossible one was rendered
          `disabled` at 30% opacity — a permanently dead control on the top
          pane and another on the bottom one. The reference draws the one that
          works. A control that cannot act is not a state; it is absence.
        */}
        {onMove && canMoveUp && (
          <PaneButton label={`Move ${title} up`} onClick={() => onMove(id, -1)}>
            <path d="M7 11V3M3.5 6.5L7 3l3.5 3.5" />
          </PaneButton>
        )}
        {onMove && canMoveDown && (
          <PaneButton label={`Move ${title} down`} onClick={() => onMove(id, 1)}>
            <path d="M7 3v8M3.5 7.5L7 11l3.5-3.5" />
          </PaneButton>
        )}
        {onAction && (
          <PaneButton
            label={`Remove ${title} from the chart`}
            danger
            onClick={() => onAction(id, "remove")}
          >
            <path d="M2.5 3.5h9M5 3.5V2h4v1.5M3.5 3.5l.6 8h5.8l.6-8" />
          </PaneButton>
        )}
        {onToggleCollapsed && (
          <PaneButton
            label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            pressed={collapsed}
            onClick={() => onToggleCollapsed(id)}
          >
            {/*
              R3b-21: collapse is TWO chevrons pointing inward, expand is two
              pointing outward — the reference's ⤡ / ⤢ pair. One chevron is
              the "open this dropdown" glyph the whole product uses, and on a
              pane-height control it said nothing about which way the pane was
              about to move.
            */}
            {collapsed
              ? <><path d="M3.5 3L7 6.5L10.5 3" /><path d="M3.5 12L7 8.5L10.5 12" /></>
              : <><path d="M3.5 6.5L7 3l3.5 3.5" /><path d="M3.5 8.5L7 12l3.5-3.5" /></>}
          </PaneButton>
        )}
        {onToggleMaximized && canMaximize && (
          <PaneButton
            label={maximized ? `Restore ${title} to the pane stack` : `Maximize ${title}`}
            pressed={maximized}
            onClick={() => onToggleMaximized(id)}
          >
            {maximized
              ? <path d="M5.5 2.5v3h-3M8.5 11.5v-3h3" />
              : <path d="M2.5 5.5v-3h3M11.5 8.5v3h-3" />}
          </PaneButton>
        )}
      </span>}
      {params && <span className="sr-only">{params}</span>}
    </section>
  );
}

/**
 * One pane control.
 *
 * Icon-only, so each carries a real accessible name rather than relying on the
 * tooltip — an icon button with no name is announced as "button" and nothing
 * else, which on a control that removes an indicator is not acceptable.
 */
function PaneButton({
  label, onClick, danger = false, pressed, children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** Set on the toggles, so their state is announced and not only drawn. */
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      /*
        24×24 with a 14px glyph, hairline on hover — the reference's pane-action
        size, measured. It was 20×20 with an 11px glyph inside a filled pill;
        the pill is gone (R3-10) and hover is now an outline, so nothing here
        paints a surface over the plot.
      */
      /*
        No `disabled` state, by construction (R3-12). Both arrows used to be
        drawn always and the impossible one greyed to 30% — a permanently dead
        control on the top pane and another on the bottom one. A control that
        cannot act is absent; there is therefore nothing here to style.
      */
      /*
        ── R3b-21: revealed means DRAWN AS A BOX ──────────────────────────────

        Each button was transparent until it was itself hovered, so a pane
        whose cluster had appeared showed four floating glyphs and no targets;
        the reference draws four bordered 24×24 boxes — border rgb(74,74,74)
        over the chart's own ground — the moment the cluster is revealed, and
        spends hover on the INK rather than on discovering the button.
      */
      className={`flex h-6 w-6 items-center justify-center rounded-sm border bg-surface transition-colors ${
        danger ? "border-border-strong text-ink-faint hover:border-down/60 hover:text-down"
          : pressed ? "border-border-strong bg-state-active text-ink"
          : "border-border-strong text-ink-faint hover:text-ink"
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
        strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
