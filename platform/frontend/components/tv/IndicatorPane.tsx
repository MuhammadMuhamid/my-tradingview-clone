"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart, LineStyle, LineType,
  type AreaData, type BarData, type CandlestickData, type HistogramData,
  type IChartApi, type ISeriesApi, type LineData, type Time, type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import {
  planSeriesMutation, plotValueAt, type ChartDecoration, type ChartOverlay, type ChartPoint,
} from "@/lib/chartSeries";
import { baseChartOptions } from "@/lib/chartTheme";
import { createDisposalGuard, useDetachChartObserver } from "@/lib/chartLifecycle";
import { clampPaneHeight, MAX_PANE_HEIGHT, MIN_PANE_HEIGHT } from "@/lib/indicatorPaneLayout";
import { IndicatorLegend } from "@/components/tv/IndicatorLegend";
import { PineVisualLayer } from "@/components/tv/PineVisualLayer";

type SeriesEntry =
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

function replaceData(entry: SeriesEntry, points: ChartPoint[]): void {
  if (entry.kind === "Line") entry.api.setData(points.map(lineDatum));
  else if (entry.kind === "Histogram") entry.api.setData(points.map(histogramDatum));
  else if (entry.kind === "Area") entry.api.setData(points.map(areaDatum));
  else if (entry.kind === "Candlestick") entry.api.setData(points.map(candlestickDatum));
  else entry.api.setData(points.map(barDatum));
  entry.data = points;
}

function updateData(entry: SeriesEntry, point: ChartPoint): void {
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
  collapsed = false, onToggleCollapsed,
  maximized = false, canMaximize = false, onToggleMaximized,
  canMoveUp = false, canMoveDown = false, onMove,
  height: controlledHeight, fill = false, onHeightChange,
  showTimeAxis = true,
  defaultHeight = 144,
  compact = false,
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

  useEffect(() => {
    if (!containerRef.current) return;
    const seriesEntries = seriesRef.current;
    const base = baseChartOptions();
    const chart = createChart(containerRef.current, {
      ...base,
      rightPriceScale: { ...base.rightPriceScale, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { ...base.timeScale, visible: showTimeAxisRef.current },
    });
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
      if (!entry) {
        if (kind === "Histogram") {
          entry = { kind, api: chart.addHistogramSeries({
            color: overlay.color, base: 0, priceLineVisible: false,
            lastValueVisible: true, ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else if (kind === "Area") {
          entry = { kind, api: chart.addAreaSeries({
            lineColor: overlay.color,
            topColor: alphaColor(overlay.color, "55"),
            bottomColor: alphaColor(overlay.color, "08"),
            priceLineVisible: false, lastValueVisible: true,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else if (kind === "Candlestick") {
          entry = { kind, api: chart.addCandlestickSeries({
            upColor: overlay.color, downColor: overlay.color,
            borderUpColor: overlay.color, borderDownColor: overlay.color,
            wickUpColor: overlay.color, wickDownColor: overlay.color,
            priceLineVisible: false, lastValueVisible: true,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else if (kind === "Bar") {
          entry = { kind, api: chart.addBarSeries({
            upColor: overlay.color, downColor: overlay.color,
            priceLineVisible: false, lastValueVisible: true,
            ...(priceFormat ? { priceFormat } : {}),
          }), data: [] };
        } else {
          entry = { kind, api: chart.addLineSeries({
            color: overlay.color, priceLineVisible: false, lastValueVisible: true,
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
      });
      else if (entry.kind === "Histogram") entry.api.applyOptions({ color: overlay.color });
      else if (entry.kind === "Area") entry.api.applyOptions({ lineColor: overlay.color });
      else if (entry.kind === "Candlestick") entry.api.applyOptions({
        upColor: overlay.color, downColor: overlay.color,
        borderUpColor: overlay.color, borderDownColor: overlay.color,
        wickUpColor: overlay.color, wickDownColor: overlay.color,
      });
      else entry.api.applyOptions({ upColor: overlay.color, downColor: overlay.color });

      const points = overlay.data.filter((point) => Number.isFinite(point.time) && point.time > 0);
      const plan = planSeriesMutation(entry.data, points);
      if (plan === "replace") replaceData(entry, points);
      else if (plan === "update") updateData(entry, points[points.length - 1]!);
    }
    onReady(id, chart);
  }, [id, onReady, overlays, ready]);

  // Keep the pane's crosshair aligned with price and sibling panes. Use the
  // first plot that has a value at this time only as the vertical anchor; all
  // plot values still come from the shared historical legend lookup.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (hoverTime === null) {
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
  }, [hoverTime, overlays, ready]);

  const priceToCoordinate = useCallback((overlayId: string, value: number): number | null => {
    const entry = seriesRef.current.get(overlayId);
    return entry ? entry.api.priceToCoordinate(value) as number | null : null;
  }, []);

  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({ visible: showTimeAxis });
  }, [showTimeAxis, ready]);

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
      className={`group/pane relative border-t border-border bg-surface ${
        fill ? "min-h-0 flex-1" : "shrink-0"
      }`}
      style={fill ? undefined : { height }}
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
          className="absolute -top-1 z-20 h-2 w-full cursor-row-resize touch-none bg-transparent hover:bg-accent/25 focus-visible:bg-accent/30"
        />
      )}
      <div ref={containerRef} className="absolute inset-0 z-[1]" />
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
        Legend and controls share one overlaid row, the way TradingView does it:
        the pane's identity and its actions are in the same place, and neither
        costs the pane any height.
      */}
      <div className="absolute left-2 top-1 z-[3] flex max-w-[calc(100%-16px)] items-start gap-1">
        <IndicatorLegend
          overlays={overlays}
          time={collapsed ? null : hoverTime}
          title={title}
          collapsible={compact || collapsed}
          startCollapsed={compact || collapsed}
          className="min-w-0 rounded bg-surface/80 px-1.5 py-0.5"
        />
        {/*
          Every control here does something to THIS pane, and each is a real
          button so the stack can be rearranged from the keyboard. They are
          revealed on hover or focus rather than reserving a row: a pane is
          94–144px tall by default and a permanent toolbar would be a tenth of
          the oscillator it sits on.
        */}
        <span className="flex shrink-0 items-center gap-0.5 rounded bg-surface/85 px-0.5 py-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/pane:opacity-100">
          {onToggleCollapsed && (
            <PaneButton
              label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
              pressed={collapsed}
              onClick={() => onToggleCollapsed(id)}
            >
              {collapsed
                ? <path d="M3.5 8.5L7 5l3.5 3.5" />
                : <path d="M3.5 5.5L7 9l3.5-3.5" />}
            </PaneButton>
          )}
          {onMove && (canMoveUp || canMoveDown) && (
            <>
              <PaneButton
                label={`Move ${title} up`}
                disabled={!canMoveUp}
                onClick={() => onMove(id, -1)}
              >
                <path d="M7 11V3M3.5 6.5L7 3l3.5 3.5" />
              </PaneButton>
              <PaneButton
                label={`Move ${title} down`}
                disabled={!canMoveDown}
                onClick={() => onMove(id, 1)}
              >
                <path d="M7 3v8M3.5 7.5L7 11l3.5-3.5" />
              </PaneButton>
            </>
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
          {onAction && (
            <>
              <PaneButton
                label={`Hide ${title} — it stays in the Indicators panel`}
                onClick={() => onAction(id, "hide")}
              >
                <path d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z" />
                <circle cx="7" cy="7" r="1.6" />
              </PaneButton>
              <PaneButton label={`${title} settings`} onClick={() => onAction(id, "settings")}>
                <circle cx="7" cy="7" r="2" />
                <path d="M7 1.5v1.8M7 10.7v1.8M1.5 7h1.8M10.7 7h1.8M3.1 3.1l1.3 1.3M9.6 9.6l1.3 1.3M10.9 3.1L9.6 4.4M4.4 9.6l-1.3 1.3" />
              </PaneButton>
              <PaneButton
                label={`Remove ${title} from the chart`}
                danger
                onClick={() => onAction(id, "remove")}
              >
                <path d="M3 3l8 8M11 3l-8 8" />
              </PaneButton>
            </>
          )}
        </span>
      </div>
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
  label, onClick, danger = false, pressed, disabled = false, children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** Set on the toggles, so their state is announced and not only drawn. */
  pressed?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      className={`flex h-5 w-5 items-center justify-center rounded transition-colors ${
        disabled ? "cursor-default text-ink-faint/30"
          : danger ? "text-ink-faint hover:bg-down/20 hover:text-down"
          : pressed ? "bg-surface-2 text-ink"
          : "text-ink-faint hover:bg-surface-2 hover:text-ink"
      }`}
    >
      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor"
        strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
