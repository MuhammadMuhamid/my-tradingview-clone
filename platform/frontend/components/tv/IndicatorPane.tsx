"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart, ColorType, CrosshairMode, LineStyle, LineType,
  type AreaData, type BarData, type CandlestickData, type HistogramData,
  type IChartApi, type ISeriesApi, type LineData, type Time, type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import {
  planSeriesMutation, plotValueAt, type ChartDecoration, type ChartOverlay, type ChartPoint,
} from "@/lib/chartSeries";
import { IndicatorLegend } from "@/components/tv/IndicatorLegend";
import { PineVisualLayer } from "@/components/tv/PineVisualLayer";

type SeriesEntry =
  | { kind: "Line"; api: ISeriesApi<"Line">; data: ChartPoint[] }
  | { kind: "Histogram"; api: ISeriesApi<"Histogram">; data: ChartPoint[] }
  | { kind: "Area"; api: ISeriesApi<"Area">; data: ChartPoint[] }
  | { kind: "Candlestick"; api: ISeriesApi<"Candlestick">; data: ChartPoint[] }
  | { kind: "Bar"; api: ISeriesApi<"Bar">; data: ChartPoint[] };

const MIN_HEIGHT = 96;
const MAX_HEIGHT = 360;

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

export function IndicatorPane({
  id, title, params, overlays, decorations, hoverTime, onHover, onReady, onRangeChange,
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
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef(new Map<string, SeriesEntry>());
  const [height, setHeight] = useState(144);
  const [ready, setReady] = useState(0);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const onRangeRef = useRef(onRangeChange);
  onRangeRef.current = onRangeChange;

  useEffect(() => {
    if (!containerRef.current) return;
    const seriesEntries = seriesRef.current;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "rgba(0,0,0,0)" },
        textColor: "#9aa4b6", fontFamily: "ui-monospace, monospace",
      },
      grid: { vertLines: { color: "#1a2030" }, horzLines: { color: "#1a2030" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: "#232b3a", scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: { borderColor: "#232b3a", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    const crosshair = (param: { time?: Time }): void =>
      onHoverRef.current(typeof param.time === "number" ? param.time : null);
    const range = (next: { from: Time; to: Time } | null): void => {
      if (!next || typeof next.from !== "number" || typeof next.to !== "number") return;
      onRangeRef.current(id, { from: next.from, to: next.to });
    };
    chart.subscribeCrosshairMove(crosshair);
    chart.timeScale().subscribeVisibleTimeRangeChange(range);
    chartRef.current = chart;
    onReady(id, chart);
    setReady((value) => value + 1);
    return () => {
      onReady(id, null);
      chart.unsubscribeCrosshairMove(crosshair);
      chart.timeScale().unsubscribeVisibleTimeRangeChange(range);
      chart.remove();
      chartRef.current = null;
      seriesEntries.clear();
    };
  }, [id, onReady]);

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
        title: overlay.title,
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

  const beginResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const move = (next: PointerEvent): void =>
      setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight - (next.clientY - startY))));
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }, [height]);

  return (
    <section className="relative shrink-0 border-t border-border bg-[#121722]" style={{ height }} aria-label={`${title} indicator pane`}>
      <button
        type="button"
        aria-label={`Resize ${title} pane`}
        title="Drag to resize pane"
        onPointerDown={beginResize}
        className="absolute -top-1 z-20 h-2 w-full cursor-row-resize touch-none bg-transparent focus-visible:bg-accent/30"
      />
      <div ref={containerRef} className="absolute inset-0 z-[1]" />
      <PineVisualLayer
        container={containerRef.current}
        chart={chartRef.current}
        overlays={overlays}
        decorations={decorations}
        priceToCoordinate={priceToCoordinate}
      />
      <IndicatorLegend
        overlays={overlays}
        time={hoverTime}
        className="absolute left-2 top-1 z-10 max-w-[calc(100%-72px)] rounded bg-[#121722]/80 px-1.5 py-0.5"
      />
      {params && <span className="sr-only">{params}</span>}
    </section>
  );
}
