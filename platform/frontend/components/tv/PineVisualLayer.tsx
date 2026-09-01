"use client";
import { useCallback, useEffect, useRef } from "react";
import type { IChartApi, UTCTimestamp } from "lightweight-charts";
import type { ChartDecoration, ChartOverlay } from "@/lib/chartSeries";

function valueAt(overlay: ChartOverlay, time: number): number | null {
  if (overlay.constantValue !== undefined) return overlay.constantValue;
  let lo = 0;
  let hi = overlay.data.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = overlay.data[mid]!;
    if (point.time === time) return point.value !== null && Number.isFinite(point.value)
      ? point.value : null;
    if (point.time < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/**
 * Pine visuals lightweight-charts 4.x cannot express as native series.
 * Backgrounds/fills are painted below the chart's transparent canvases;
 * crosses are painted above them. Both canvases are pointer-transparent and
 * clipped to the plot area, so axes, controls and indicator legends are never
 * coloured.
 */
export function PineVisualLayer({
  container, chart, overlays, decorations, priceToCoordinate,
}: {
  container: HTMLDivElement | null;
  chart: IChartApi | null;
  overlays: ChartOverlay[];
  decorations: ChartDecoration[];
  priceToCoordinate: (overlayId: string, value: number) => number | null;
}) {
  const underRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const overlaysRef = useRef(overlays);
  const decorationsRef = useRef(decorations);
  overlaysRef.current = overlays;
  decorationsRef.current = decorations;

  const redraw = useCallback(() => {
    const under = underRef.current;
    const over = overRef.current;
    if (!under || !over || !container || !chart) return;
    const underCtx = under.getContext("2d");
    const overCtx = over.getContext("2d");
    if (!underCtx || !overCtx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    for (const [canvas, ctx] of [[under, underCtx], [over, overCtx]] as const) {
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
    }

    const plotWidth = width - (chart.priceScale("right").width() ?? 0);
    const plotHeight = height - (chart.timeScale().height() ?? 0);
    const clip = (ctx: CanvasRenderingContext2D): void => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotWidth, plotHeight);
      ctx.clip();
    };
    clip(underCtx);
    clip(overCtx);
    const xOf = (time: number): number | null =>
      chart.timeScale().timeToCoordinate(time as UTCTimestamp) as number | null;
    const visible = chart.timeScale().getVisibleRange();
    const from = typeof visible?.from === "number" ? visible.from : -Infinity;
    const to = typeof visible?.to === "number" ? visible.to : Infinity;
    const byId = new Map(overlaysRef.current.map((overlay) => [overlay.id, overlay]));

    // bgcolor() first: it is pane background, below fills and every chart series.
    for (const decoration of decorationsRef.current) {
      if (decoration.kind !== "background") continue;
      const points = decoration.data;
      for (let i = 0; i < points.length; i++) {
        const point = points[i]!;
        if (point.color === null || point.time < from - 86_400 || point.time > to + 86_400) continue;
        const x = xOf(point.time);
        if (x === null) continue;
        const previousX = i > 0 ? xOf(points[i - 1]!.time) : null;
        const nextX = i + 1 < points.length ? xOf(points[i + 1]!.time) : null;
        const halfLeft = previousX === null ? Math.abs((nextX ?? x + 6) - x) / 2 : Math.abs(x - previousX) / 2;
        const halfRight = nextX === null ? halfLeft : Math.abs(nextX - x) / 2;
        underCtx.fillStyle = point.color;
        underCtx.fillRect(x - halfLeft, 0, halfLeft + halfRight, plotHeight);
      }
    }

    // fill() quadrilaterals. Dynamic colours and na are resolved per bar.
    for (const decoration of decorationsRef.current) {
      if (decoration.kind !== "fill") continue;
      const first = byId.get(decoration.firstId);
      const second = byId.get(decoration.secondId);
      if (!first || !second) continue;
      let previous: { index: number; x: number; y1: number; y2: number } | null = null;
      for (let i = 0; i < decoration.data.length; i++) {
        const point = decoration.data[i]!;
        if (point.color === null) { previous = null; continue; }
        const firstValue = valueAt(first, point.time);
        const secondValue = valueAt(second, point.time);
        if (firstValue === null || secondValue === null) {
          if (!decoration.fillgaps) previous = null;
          continue;
        }
        const x = xOf(point.time);
        const y1 = priceToCoordinate(first.id, firstValue);
        const y2 = priceToCoordinate(second.id, secondValue);
        if (x === null || y1 === null || y2 === null) {
          if (!decoration.fillgaps) previous = null;
          continue;
        }
        if (previous && (decoration.fillgaps || previous.index === i - 1)) {
          underCtx.fillStyle = point.color;
          underCtx.beginPath();
          underCtx.moveTo(previous.x, previous.y1);
          underCtx.lineTo(x, y1);
          underCtx.lineTo(x, y2);
          underCtx.lineTo(previous.x, previous.y2);
          underCtx.closePath();
          underCtx.fill();
        }
        previous = { index: i, x, y1, y2 };
      }
    }

    // plot.style_cross: isolated marks with no connecting line.
    for (const overlay of overlaysRef.current) {
      if (overlay.style !== "cross") continue;
      const arm = Math.max(3, Math.min(8, (overlay.width ?? 1) * 2));
      overCtx.lineWidth = Math.max(1, Math.min(4, overlay.width ?? 1));
      for (const point of overlay.data) {
        if (point.value === null || point.color === null ||
            point.time < from || point.time > to) continue;
        const x = xOf(point.time);
        const y = priceToCoordinate(overlay.id, point.value);
        if (x === null || y === null) continue;
        overCtx.strokeStyle = point.color ?? overlay.color;
        overCtx.beginPath();
        overCtx.moveTo(x - arm, y);
        overCtx.lineTo(x + arm, y);
        overCtx.moveTo(x, y - arm);
        overCtx.lineTo(x, y + arm);
        overCtx.stroke();
      }
    }

    underCtx.restore();
    overCtx.restore();
  }, [chart, container, priceToCoordinate]);

  useEffect(() => {
    redraw();
    const frame = requestAnimationFrame(redraw);
    if (!chart) return () => cancelAnimationFrame(frame);
    const timeScale = chart.timeScale();
    const onRange = (): void => redraw();
    timeScale.subscribeVisibleLogicalRangeChange(onRange);
    const observer = new ResizeObserver(redraw);
    if (container) observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      timeScale.unsubscribeVisibleLogicalRangeChange(onRange);
      observer.disconnect();
    };
  }, [chart, container, redraw, overlays, decorations]);

  return (
    <>
      <canvas ref={underRef} className="pointer-events-none absolute inset-0 z-0" aria-hidden />
      <canvas ref={overRef} className="pointer-events-none absolute inset-0 z-[4]" aria-hidden />
    </>
  );
}
