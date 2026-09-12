"use client";

import { useCallback, useEffect, useRef } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { footprintBars, type AggregateTrade, type FootprintBar } from "@/lib/tradeChartTransforms";

type PriceSeries = ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line">
  | ISeriesApi<"Area"> | ISeriesApi<"Baseline"> | ISeriesApi<"Histogram">;

/** A truthful bid/ask-at-price rendering for ordered public executions. */
export function FootprintLayer({
  container, chart, series, trades, intervalMs, tickSize, unavailable,
}: {
  container: HTMLDivElement | null;
  chart: IChartApi | null;
  series: PriceSeries | null;
  trades: readonly AggregateTrade[];
  intervalMs: number;
  tickSize: number | null;
  unavailable?: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const barsRef = useRef<FootprintBar[]>([]);
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !container || !chart || !series || !container.isConnected
      || container.clientWidth === 0 || container.clientHeight === 0) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth, height = container.clientHeight;
    canvas.width = width * dpr; canvas.height = height * dpr;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    if (!(tickSize && tickSize > 0) || unavailable) return;
    const bars = (barsRef.current = footprintBars(trades, intervalMs, tickSize));
    if (bars.length === 0) return;
    const plotWidth = width - (chart.priceScale("right").width() ?? 0);
    const plotHeight = height - (chart.timeScale().height() ?? 0);
    if (plotWidth <= 0 || plotHeight <= 0) return;
    const timeScale = chart.timeScale();
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, plotWidth, plotHeight); ctx.clip();
    for (const bar of bars) {
      const x1 = timeScale.timeToCoordinate((bar.openTime / 1000) as UTCTimestamp) as number | null;
      const x2 = timeScale.timeToCoordinate((bar.closeTime / 1000) as UTCTimestamp) as number | null;
      if (x1 === null && x2 === null) continue;
      const left = Math.max(0, Math.min(plotWidth, x1 ?? 0));
      const right = Math.max(0, Math.min(plotWidth, x2 ?? plotWidth));
      const cellWidth = Math.max(3, Math.abs(right - left) - 1);
      for (const level of bar.levels) {
        const y = series.priceToCoordinate(level.price) as number | null;
        const yNext = series.priceToCoordinate(level.price + tickSize) as number | null;
        if (y === null) continue;
        const top = Math.min(y, yNext ?? y - 4);
        const cellHeight = Math.max(3, Math.abs((yNext ?? (y - 4)) - y) - 1);
        if (top + cellHeight < 0 || top > plotHeight) continue;
        const buyWidth = cellWidth * (level.buyVolume / Math.max(level.totalVolume, 1));
        const sellWidth = cellWidth - buyWidth;
        ctx.fillStyle = "rgba(32, 180, 120, 0.62)"; ctx.fillRect(left, top, buyWidth, cellHeight);
        ctx.fillStyle = "rgba(220, 75, 90, 0.62)"; ctx.fillRect(left + buyWidth, top, sellWidth, cellHeight);
        if (cellWidth >= 34 && cellHeight >= 11) {
          ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
          ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.textAlign = "center";
          ctx.fillText(`${format(level.buyVolume)}×${format(level.sellVolume)}`, left + cellWidth / 2, top + cellHeight - 2);
        }
      }
      if (cellWidth >= 48) {
        const y = series.priceToCoordinate(bar.levels[bar.levels.length - 1]?.price ?? 0) as number | null;
        if (y !== null) { ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace"; ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.textAlign = "left"; ctx.fillText(`Δ ${format(bar.delta)}`, left + 2, Math.max(10, y - 3)); }
      }
    }
    ctx.restore();
  }, [chart, container, intervalMs, series, tickSize, trades, unavailable]);

  useEffect(() => {
    redraw(); const frame = requestAnimationFrame(redraw);
    if (!chart) return () => cancelAnimationFrame(frame);
    const ts = chart.timeScale(); ts.subscribeVisibleLogicalRangeChange(redraw);
    const observer = new ResizeObserver(redraw); if (container) observer.observe(container);
    return () => { cancelAnimationFrame(frame); ts.unsubscribeVisibleLogicalRangeChange(redraw); observer.disconnect(); };
  }, [chart, container, redraw]);

  return <canvas ref={canvasRef} data-testid="footprint-layer" className="pointer-events-none absolute inset-0 z-[3]" aria-label={unavailable ?? "Volume footprint bid and ask levels"} />;
}

function format(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(2);
}
