"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, ColorType, CrosshairMode, IChartApi, ISeriesApi, Time, UTCTimestamp,
  SeriesMarker, MouseEventParams, LineStyle, LineType,
  type AreaData, type BarData, type CandlestickData, type HistogramData,
  type LineData, type WhitespaceData,
} from "lightweight-charts";
import type { Candle, Interval, Trade } from "@/lib/types";
import { snapToBarIndex } from "@/lib/paneSync";
import { fmtPrice } from "@/lib/format";
import { DrawingCanvas } from "@/components/tv/DrawingCanvas";
import { PineDrawingLayer, PineTables } from "@/components/tv/PineDrawingLayer";
import { IndicatorLegend } from "@/components/tv/IndicatorLegend";
import { IndicatorPane, type PaneAction } from "@/components/tv/IndicatorPane";
import { PineVisualLayer } from "@/components/tv/PineVisualLayer";
import type { PineDrawings } from "@/lib/api";
import type { Drawing, DrawingTool } from "@/lib/drawings";
import {
  groupChartOverlays, planColoredCandleMutation, planSeriesMutation,
  type ChartBarColor, type ChartDecoration, type ChartOverlay, type ChartPoint,
} from "@/lib/chartSeries";
import {
  mainSeriesDatum, type ChartType, type MainSeriesDatum,
} from "@/lib/chartType";

export type { ChartOverlay } from "@/lib/chartSeries";

/** TradingView-style legend readout for the candle under the crosshair. */
interface LegendBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  /** change vs the previous candle's close (falls back to the bar's open) */
  chg: number;
  chgPct: number;
}

const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000,
  "1h": 3600000, "2h": 7200000, "4h": 14400000, "6h": 21600000, "12h": 43200000, "1d": 86400000,
};

/**
 * The states the live feed can be in. `stale` and `unknown` exist so the chart
 * never presents a frozen price as current — which is precisely what FE-09
 * described.
 */
export type ChartFeedState = "idle" | "connecting" | "live" | "reconnecting" | "stale";

/**
 * Silence after which an open socket is treated as dead and rebuilt. An active
 * kline stream updates about once a second; 45 s of nothing is not a lull.
 */
export const WS_SILENCE_TIMEOUT_MS = 45_000;
const WS_WATCHDOG_INTERVAL_MS = 5_000;

/** Binance combined stream for one symbol/interval; updates the forming candle live. */
function streamUrl(symbol: string, interval: Interval): string {
  return `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`;
}

/** A horizontal level drawn across the chart (live stop / target / entry). */
export interface ChartPriceLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

/** A bar marker plotted by a script (plotshape / plotchar). */
export interface ChartMarker {
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
 */
function defaultPaneHeight(paneCount: number): number {
  if (paneCount <= 1) return 160;
  if (paneCount === 2) return 144;
  if (paneCount === 3) return 124;
  return 106;
}

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
 */
type MainSeriesApi =
  | ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line"> | ISeriesApi<"Area">;

function setMainSeriesData(api: MainSeriesApi, kind: ChartType, rows: MainSeriesDatum[]): void {
  const data = rows as unknown;
  if (kind === "candles") (api as ISeriesApi<"Candlestick">).setData(data as CandlestickData<Time>[]);
  else if (kind === "bars") (api as ISeriesApi<"Bar">).setData(data as BarData<Time>[]);
  else if (kind === "area") (api as ISeriesApi<"Area">).setData(data as AreaData<Time>[]);
  else (api as ISeriesApi<"Line">).setData(data as LineData<Time>[]);
}

function updateMainSeries(api: MainSeriesApi, kind: ChartType, row: MainSeriesDatum): void {
  const datum = row as unknown;
  if (kind === "candles") (api as ISeriesApi<"Candlestick">).update(datum as CandlestickData<Time>);
  else if (kind === "bars") (api as ISeriesApi<"Bar">).update(datum as BarData<Time>);
  else if (kind === "area") (api as ISeriesApi<"Area">).update(datum as AreaData<Time>);
  else (api as ISeriesApi<"Line">).update(datum as LineData<Time>);
}

/** Create the main series for a presentation, in the shared price palette. */
function addMainSeries(chart: IChartApi, kind: ChartType): MainSeriesApi {
  if (kind === "candles") {
    return chart.addCandlestickSeries({
      upColor: "#2ebd85", downColor: "#f6465d",
      borderUpColor: "#2ebd85", borderDownColor: "#f6465d",
      wickUpColor: "#2ebd85", wickDownColor: "#f6465d",
    });
  }
  if (kind === "bars") {
    return chart.addBarSeries({ upColor: "#2ebd85", downColor: "#f6465d", thinBars: false });
  }
  if (kind === "area") {
    return chart.addAreaSeries({
      lineColor: "#4f8cff", lineWidth: 2,
      topColor: "rgba(79,140,255,0.28)", bottomColor: "rgba(79,140,255,0.02)",
      priceLineVisible: false,
    });
  }
  return chart.addLineSeries({ color: "#4f8cff", lineWidth: 2, priceLineVisible: false });
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
  symbol, interval, candles, trades, priceLines, overlays, decorations, barColors,
  markers, pineDrawings,
  live = true, fill = false,
  chartType = "candles",
  drawingTool = "cursor", onDrawingToolDone, drawings, onDrawingsChange,
  magnet = false, drawingsLocked = false, drawingsHidden = false,
  onPriceSelect,
  compact = false,
  onLiveBarBoundary,
  onCrosshairMove, crosshairTime,
  onVisibleRangeChange, visibleRange, followEdgeTime,
  onIndicatorPaneAction,
}: {
  symbol: string;
  interval: Interval;
  candles: Candle[];
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
  onDrawingsChange?: (next: Drawing[]) => void;
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
   * Phone layout: drop the per-series price-axis badges and shorten the
   * legend. Ten moving averages each stamp a label on the scale, which on a
   * 390px screen covers most of the price column.
   */
  compact?: boolean;
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
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const overlayRefs = useRef<Map<string, OverlaySeriesEntry>>(new Map());
  const paneChartRefs = useRef<Map<string, IChartApi>>(new Map());
  const datasetKeyRef = useRef<string | null>(null);
  const candlesRef = useRef<Candle[]>([]);
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
  /** Internal price/indicator-pane range propagation, throttled to one frame. */
  const syncingPaneRangeRef = useRef(false);
  const syncPaneRangesRef = useRef<(source: string, range: { from: number; to: number }) => void>(() => {});
  const [legend, setLegend] = useState<LegendBar | null>(null);
  const [indicatorHoverTime, setIndicatorHoverTime] = useState<number | null>(null);
  /** FE-09: what the live feed is actually doing, so the UI can say so. */
  const [feedState, setFeedState] = useState<ChartFeedState>("idle");
  /** bumped once the chart/series exist, so the drawing layer can attach */
  const [chartReady, setChartReady] = useState(0);
  /** bumped only when the chart itself is (re)created, so the series effect
   *  can depend on it without re-triggering itself through `chartReady`. */
  const [chartCreated, setChartCreated] = useState(0);
  const groupedOverlays = useMemo(
    () => groupChartOverlays(overlays ?? [], decorations ?? []),
    [overlays, decorations]
  );

  syncPaneRangesRef.current = (source, range) => {
    if (syncingPaneRangeRef.current) return;
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
    const index = snapToBarIndex(list.map((bar) => bar.openTime / 1000), time);
    if (index < 0) {
      chart.clearCrosshairPosition();
      return;
    }
    const bar = list[index]!;
    chart.setCrosshairPosition(bar.close, (bar.openTime / 1000) as UTCTimestamp, series);
  }, []);

  const legendFromIndex = useCallback((i: number): LegendBar | null => {
    const list = candlesRef.current;
    const c = list[i];
    if (!c) return null;
    const prevClose = i > 0 ? list[i - 1]!.close : c.open;
    const chg = c.close - prevClose;
    return {
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      chg, chgPct: prevClose !== 0 ? (chg / prevClose) * 100 : 0,
    };
  }, []);

  // Create the chart once.
  useEffect(() => {
    if (!containerRef.current) return;
    const overlayEntries = overlayRefs.current;
    const paneCharts = paneChartRefs.current;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "rgba(0,0,0,0)" },
        textColor: "#9aa4b6",
        fontFamily: "ui-monospace, monospace",
      },
      grid: {
        vertLines: { color: "#1a2030" },
        horzLines: { color: "#1a2030" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#232b3a" },
      timeScale: { borderColor: "#232b3a", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    const vol = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: "#2a3346",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    // OHLC legend follows the crosshair; off-chart it shows the latest bar.
    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      const t = param.time as number | undefined;
      hoverTimeRef.current = t ?? null;
      setIndicatorHoverTime((current) => current === (t ?? null) ? current : (t ?? null));
      // Tell the other pane where the pointer is. Guarded by a ref so the
      // subscription does not have to be torn down when the callback changes.
      onCrosshairRef.current?.(t ?? null);
      if (t != null) {
        const i = timeIndexRef.current.get(t);
        if (i !== undefined) {
          setLegend(legendFromIndex(i));
          return;
        }
      }
      const n = candlesRef.current.length;
      setLegend(n > 0 ? legendFromIndex(n - 1) : null);
    });

    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      // A range we just applied ourselves would otherwise bounce back to the
      // pane that sent it, and the two would chase each other.
      if (applyingRangeRef.current || syncingPaneRangeRef.current || !range) return;
      const from = range.from as number;
      const to = range.to as number;
      if (Number.isFinite(from) && Number.isFinite(to)) {
        onRangeRef.current?.({ from, to });
        syncPaneRangesRef.current("price", { from, to });
      }
    });

    chartRef.current = chart;
    volRef.current = vol;
    setChartCreated((n) => n + 1);
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      overlayEntries.clear();
      paneCharts.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const series = addMainSeries(chart, chartType);
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
    const datasetKey = `${symbol}|${interval}`;
    const nextColors = new Map(
      (barColors ?? []).flatMap((point) => point.color === null ? [] : [[point.time, point.color] as const])
    );
    // A freshly created series holds nothing, so it must be filled from
    // scratch — but that is not a reason to refit the time scale, which is
    // what makes a presentation change viewport-preserving.
    const mutation = mainSeriesDirtyRef.current || datasetKeyRef.current !== datasetKey
      ? "replace"
      : planColoredCandleMutation(candlesRef.current, candles, barColorRef.current, nextColors);
    candlesRef.current = [...candles];
    barColorRef.current = nextColors;
    timeIndexRef.current = new Map(candles.map((c, i) => [c.openTime / 1000, i]));
    setLegend(candles.length > 0 ? legendFromIndex(candles.length - 1) : null);
    const kind = mainKindRef.current;
    const candleDatum = (c: Candle) =>
      mainSeriesDatum(kind, c, nextColors.get(c.openTime / 1000) ?? null);
    const volumeDatum = (c: Candle) => ({
      time: (c.openTime / 1000) as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? "#1c3a30" : "#3a1c24",
    });
    if (mutation === "replace") {
      setMainSeriesData(series, kind, candles.map(candleDatum));
      vol.setData(candles.map(volumeDatum));
      mainSeriesDirtyRef.current = false;
    } else if (mutation === "update" && candles.length > 0) {
      updateMainSeries(series, kind, candleDatum(candles[candles.length - 1]!));
      vol.update(volumeDatum(candles[candles.length - 1]!));
    }
    if (datasetKeyRef.current !== datasetKey) {
      datasetKeyRef.current = datasetKey;
      chartRef.current?.timeScale().fitContent();
    }
  }, [candles, symbol, interval, legendFromIndex, barColors, chartReady]);

  // Markers update independently: adding an indicator must not reset zoom.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

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
      for (const t of trades ?? []) {
        const open = t.exitTime === null;
        if (inWindow(t.entryTime / 1000)) {
          drawn.push({
            time: (t.entryTime / 1000) as UTCTimestamp,
            position: "belowBar",
            color: open ? "#f0b90b" : "#2ebd85",
            shape: "arrowUp",
            text: `BUY ${fmtPrice(t.entryPrice)}${open ? " ●" : ""}`,
          });
        }
        if (t.exitTime !== null && inWindow(t.exitTime / 1000)) {
          const win = (t.pnl ?? 0) >= 0;
          const reason = (t.exitReason ?? "EXIT").toUpperCase();
          drawn.push({
            time: (t.exitTime / 1000) as UTCTimestamp,
            position: "aboveBar", color: win ? "#2ebd85" : "#f6465d", shape: "arrowDown",
            text: t.exitPrice !== null ? `${reason} ${fmtPrice(t.exitPrice)}` : reason,
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
  }, [candles, trades, markers, chartReady]);

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

  // Pine/MA series are stable by plot id. Gaps stay as whitespace and a
  // last-point change uses update() instead of replaying the full history.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
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
       * lightweight-charts draws the series `title` on the price scale even
       * when the last value is hidden, so ten moving averages stamped ten
       * name-only badges down the axis and buried the price ticks under them.
       * The scale is for prices: a label earns its place there only when it
       * carries a value. Every series is still named in the legend.
       */
      const axisTitle = lastValueVisible ? overlay.title : "";
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
  }, [groupedOverlays.price, chartReady, candles, compact]);

  const pinePriceToCoordinate = useCallback((overlayId: string, value: number): number | null => {
    const entry = overlayRefs.current.get(overlayId);
    return entry ? entry.api.priceToCoordinate(value) as number | null : null;
  }, []);

  /*
   * Live: update the forming candle from the Binance kline websocket.
   *
   * FE-09: this had `onmessage` and nothing else — no `onerror`, no `onclose`,
   * no reconnect and no watchdog. When the socket dropped, or stayed open while
   * delivering nothing (a half-open TCP connection, or a server that has
   * stopped sending), the last price simply froze on screen and kept being
   * displayed as if it were current. There was no way for a user to tell.
   *
   * Now: exponential-backoff reconnect, a silence watchdog, and a feed state
   * the caller can render. `unknown` and `stale` are real answers — nothing
   * here reports "live" without a recent message to justify it.
   */
  useEffect(() => {
    if (!live) { setFeedState("idle"); return; }

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let attempt = 0;
    let lastMessageAt = 0;
    let previousStreamBar: Candle | null = null;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      setFeedState(attempt === 0 ? "connecting" : "reconnecting");
      const ws = new WebSocket(streamUrl(symbol, interval));
      socket = ws;
      wireHandlers(ws);
    };

    const scheduleReconnect = (): void => {
      if (closed) return;
      attempt += 1;
      setFeedState("reconnecting");
      // Capped exponential backoff: a Binance outage must not become a
      // reconnect storm from every open chart tab.
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
      reconnectTimer = setTimeout(connect, delay);
    };

    const wireHandlers = (ws: WebSocket): void => {
    ws.onopen = () => {
      attempt = 0;
      lastMessageAt = Date.now();
      setFeedState("live");
    };
    ws.onerror = () => {
      // `onerror` is always followed by `onclose`, which does the reconnecting.
      setFeedState("reconnecting");
    };
    ws.onclose = () => {
      if (closed || socket !== ws) return;
      socket = null;
      scheduleReconnect();
    };
    ws.onmessage = (ev) => {
      lastMessageAt = Date.now();
      setFeedState("live");
      try {
        const msg = JSON.parse(ev.data as string) as {
          k?: { t: number; o: string; h: string; l: string; c: string; v: string };
        };
        if (!msg.k) return;
        const k = msg.k;
        const time = (k.t / 1000) as UTCTimestamp;
        // Read through the refs: the main series is replaced when the user
        // changes presentation, and capturing it here would leave the feed
        // writing into a series that is no longer on the chart.
        const series = seriesRef.current;
        const vol = volRef.current;
        if (!series || !vol) return;
        const override = barColorRef.current.get(k.t / 1000) ?? null;
        updateMainSeries(series, mainKindRef.current, mainSeriesDatum(mainKindRef.current, {
          openTime: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c,
        }, override));
        vol.update({ time, value: +k.v, color: +k.c >= +k.o ? "#1c3a30" : "#3a1c24" });

        // Mirror the forming candle into the legend source so the readout
        // stays live; only refresh the display when the user isn't pointing
        // at an older candle.
        const list = candlesRef.current;
        const liveBar: Candle = {
          symbol, interval, openTime: k.t, closeTime: k.t + INTERVAL_MS[interval] - 1,
          open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
        };
        const idx = timeIndexRef.current.get(k.t / 1000);
        if (idx !== undefined) list[idx] = liveBar;
        else if (list.length === 0 || k.t > list[list.length - 1]!.openTime) {
          list.push(liveBar);
          timeIndexRef.current.set(k.t / 1000, list.length - 1);
          onLiveBoundaryRef.current?.(previousStreamBar, liveBar);
        }
        previousStreamBar = liveBar;
        const hover = hoverTimeRef.current;
        if (hover === null || hover === k.t / 1000) {
          const i = timeIndexRef.current.get(k.t / 1000);
          if (i !== undefined) setLegend(legendFromIndex(i));
        }
      } catch { /* ignore malformed frames */ }
    };
    };

    connect();

    /*
     * The watchdog is the half of this that `isConnected()`-style checks miss:
     * a socket can sit in readyState OPEN and deliver nothing at all. An active
     * kline stream updates roughly once a second, so 45 seconds of complete
     * silence means the connection is not carrying data whatever its state
     * says.
     */
    watchdog = setInterval(() => {
      if (closed || lastMessageAt === 0) return;
      const silentFor = Date.now() - lastMessageAt;
      if (silentFor <= WS_SILENCE_TIMEOUT_MS) return;
      setFeedState("stale");
      // Rebuild rather than wait: the socket is not going to recover on its own.
      const dead = socket;
      socket = null;
      try { dead?.close(); } catch { /* already gone */ }
      lastMessageAt = Date.now();
      scheduleReconnect();
    }, WS_WATCHDOG_INTERVAL_MS);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdog) clearInterval(watchdog);
      const open = socket;
      socket = null;
      try { open?.close(); } catch { /* already gone */ }
      setFeedState("idle");
    };
  }, [symbol, interval, live, legendFromIndex]);

  /**
   * Mirror the other pane's crosshair.
   *
   * The panes are usually on different resolutions, so an exact time match is
   * the exception: 14:07 on a 15m chart has to land on the 14:00 bar of a 1h
   * one. We take the newest bar at or before the incoming time, which is the
   * bar that was actually forming at that moment.
   */
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    if (crosshairTime == null) {
      chart.clearCrosshairPosition();
      return;
    }
    const list = candlesRef.current;
    if (list.length === 0) return;

    const found = snapToBarIndex(
      list.map((c) => Math.floor(c.openTime / 1000)), crosshairTime
    );
    if (found < 0) { chart.clearCrosshairPosition(); return; }

    const bar = list[found]!;
    chart.setCrosshairPosition(bar.close, Math.floor(bar.openTime / 1000) as UTCTimestamp, series);
  }, [crosshairTime, chartReady]);

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
      setTimeout(() => { applyingRangeRef.current = false; }, 0);
    }
  }, [visibleRange, chartReady]);

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
      setTimeout(() => { applyingRangeRef.current = false; }, 0);
    }
  }, [followEdgeTime, visibleRange, chartReady]);

  /*
   * The panes are horizontally locked to the price chart, so only the bottom
   * one needs an axis. Repeating it under every pane cost a row of pixels each
   * and drew the same numbers three times; TradingView draws it once.
   */
  const hasPanes = groupedOverlays.panes.length > 0;
  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({ visible: !hasPanes });
  }, [hasPanes, chartCreated]);

  const up = legend ? legend.close >= legend.open : true;
  const chgUp = legend ? legend.chg >= 0 : true;
  const px = up ? "text-[#2ebd85]" : "text-[#f6465d]";

  return (
    <div className={`flex ${fill ? "h-full" : "h-[520px]"} w-full flex-col overflow-hidden`}>
      <div className="relative min-h-0 flex-1 bg-[#121722]">
      <div ref={containerRef} className="absolute inset-0 z-[1]" />
      <PineVisualLayer
        container={containerRef.current}
        chart={chartRef.current}
        overlays={groupedOverlays.price}
        decorations={groupedOverlays.priceDecorations}
        priceToCoordinate={pinePriceToCoordinate}
      />
      {/* Script drawings sit under the user's own drawing layer, so the
          user's tools keep priority for clicks and hit-testing. */}
      <PineDrawingLayer
        key={chartReady}
        container={containerRef.current}
        chart={chartRef.current}
        series={seriesRef.current}
        candles={candles}
        drawings={pineDrawings ?? null}
      />
      <PineTables drawings={pineDrawings ?? null} />
      {drawings && onDrawingsChange && (
        <DrawingCanvas
          key={chartReady}
          container={containerRef.current}
          chart={chartRef.current}
          series={seriesRef.current}
          candles={candles}
          interval={interval}
          tool={drawingTool}
          onToolDone={onDrawingToolDone ?? (() => {})}
          drawings={drawings}
          onChange={onDrawingsChange}
          magnet={magnet}
          locked={drawingsLocked}
          hidden={drawingsHidden}
        />
      )}
      {/*
        One stacked column, not two independently positioned overlays. The OHLC
        readout is width-capped so it cannot run underneath the feed-state badge
        opposite — "feed stalled — price is not current" is the one message on
        this chart that must never be half-covered — and capping it means it can
        wrap, which is exactly when a second overlay pinned to a fixed offset
        would have been drawn straight through it.
      */}
      <div className="pointer-events-none absolute left-2 top-1.5 z-10 flex max-w-[calc(100%-130px)] flex-col items-start gap-0.5">
      {legend && (
        <div className="flex flex-wrap items-baseline gap-x-2 rounded bg-[#121722]/75 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-[#9aa4b6] sm:text-[11px]">
          <span className="font-semibold text-[#e5e9f0]">{symbol}</span>
          <span>· {interval} ·</span>
          {/* O/H/L and volume are the first things to go on a phone: the close
              and the change are what the eye actually reads at a glance. */}
          <span className="hidden sm:inline">O <span className={px}>{fmtPrice(legend.open)}</span></span>
          <span className="hidden sm:inline">H <span className={px}>{fmtPrice(legend.high)}</span></span>
          <span className="hidden sm:inline">L <span className={px}>{fmtPrice(legend.low)}</span></span>
          <span>C <span className={px}>{fmtPrice(legend.close)}</span></span>
          <span className={chgUp ? "text-[#2ebd85]" : "text-[#f6465d]"}>
            {chgUp ? "+" : ""}{fmtPrice(legend.chg)} ({chgUp ? "+" : ""}{legend.chgPct.toFixed(2)}%)
          </span>
          {legend.volume !== null && (
            <span className="hidden sm:inline">Vol <span className="text-[#e5e9f0]">{legend.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></span>
          )}
        </div>
      )}
      <IndicatorLegend
        overlays={groupedOverlays.price}
        time={indicatorHoverTime}
        startCollapsed={compact}
        className="max-w-full rounded bg-[#121722]/75 px-1 py-0.5"
      />
      </div>
      {/*
        FE-09: the feed's real state, next to the price it is supposed to be
        updating. A frozen price used to look exactly like a live one.
        `live` is not rendered — a green dot beside every chart is noise, and
        the states worth interrupting for are the ones where the number on
        screen is NOT current.
      */}
      {live && feedState !== "live" && (
        <div
          role="status"
          aria-live="polite"
          className={`pointer-events-none absolute right-2 top-1.5 z-10 flex max-w-[60%] items-center gap-1.5 rounded px-2 py-0.5 text-right font-mono text-[10px] leading-4 sm:text-[11px] ${FEED_BADGE[feedState].className}`}
        >
          <span aria-hidden="true">●</span>
          {FEED_BADGE[feedState].label}
        </div>
      )}
      </div>
      {groupedOverlays.panes.length > 0 && (
        <div className="max-h-[56%] shrink-0 overflow-y-auto bg-[#121722]">
          {groupedOverlays.panes.map((pane, index) => (
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
              defaultHeight={defaultPaneHeight(groupedOverlays.panes.length)}
              showTimeAxis={index === groupedOverlays.panes.length - 1}
              compact={compact}
            />
          ))}
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
const FEED_BADGE: Record<ChartFeedState, { label: string; className: string }> = {
  idle: { label: "not live", className: "bg-[#121722]/75 text-[#9aa4b6]" },
  connecting: { label: "connecting…", className: "bg-[#121722]/75 text-[#9aa4b6]" },
  live: { label: "live", className: "bg-[#121722]/75 text-[#2ebd85]" },
  reconnecting: { label: "reconnecting…", className: "bg-[#3a2a12]/85 text-[#f0b90b]" },
  stale: { label: "feed stalled — price is not current", className: "bg-[#3a1c24]/85 text-[#f6465d]" },
};

export { INTERVAL_MS };
