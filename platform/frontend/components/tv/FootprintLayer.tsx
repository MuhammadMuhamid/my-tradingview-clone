"use client";

import { useCallback, useEffect, useRef } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { footprintBars, type AggregateTrade, type FootprintBar } from "@/lib/tradeChartTransforms";
import { chartSurface, mixToward, readableOn } from "@/lib/chartTheme";

/**
 * The bid and ask halves of a cell, and how much of them survives the pane.
 *
 * Held as an opaque hex plus an alpha rather than as one `rgba()` string so
 * the numerals' ink can be measured against the colour the cell ACTUALLY
 * composites to — which is the whole difference between a readable footprint
 * and a grid of coloured blocks.
 */
const BUY = "#20b478";
const SELL = "#dc4b5a";
const CELL_ALPHA = 0.62;
const BUY_FILL = `rgba(32, 180, 120, ${CELL_ALPHA})`;
const SELL_FILL = `rgba(220, 75, 90, ${CELL_ALPHA})`;

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
    /*
     * TVP8 round two: these numbers were `rgba(255,255,255,0.9)`.
     *
     * A cell is the direction colour at 0.62 over the pane. On the light theme
     * that composites to `#75d0ab`, and white numerals on it are 1.85:1 — the
     * whole point of a footprint chart is the per-level pair, so on a light
     * chart the chart type read as coloured blocks with nothing in them.
     *
     * The ink is picked from the CELL rather than from the surface, because
     * that is what the text actually sits on. It resolves to black over the
     * light cell (10.4:1) and white over the dark one (5.7:1) — the dark case
     * being what the literal already did, kept rather than traded away for a
     * theme token that would have taken it down to 4.1:1.
     */
    const ground = chartSurface();
    const buyInk = readableOn(mixToward(BUY, ground, CELL_ALPHA));
    const sellInk = readableOn(mixToward(SELL, ground, CELL_ALPHA));
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
        ctx.fillStyle = BUY_FILL; ctx.fillRect(left, top, buyWidth, cellHeight);
        ctx.fillStyle = SELL_FILL; ctx.fillRect(left + buyWidth, top, sellWidth, cellHeight);
        if (cellWidth >= 34 && cellHeight >= 11) {
          ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
          ctx.fillStyle = buyWidth >= sellWidth ? buyInk : sellInk;
          ctx.globalAlpha = 0.9; ctx.textAlign = "center";
          ctx.fillText(`${format(level.buyVolume)}×${format(level.sellVolume)}`, left + cellWidth / 2, top + cellHeight - 2);
          ctx.globalAlpha = 1;
        }
      }
      if (cellWidth >= 48) {
        const y = series.priceToCoordinate(bar.levels[bar.levels.length - 1]?.price ?? 0) as number | null;
        if (y !== null) { ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace"; ctx.fillStyle = bar.delta >= 0 ? buyInk : sellInk; ctx.globalAlpha = 0.8; ctx.textAlign = "left"; ctx.fillText(`Δ ${format(bar.delta)}`, left + 2, Math.max(10, y - 3)); ctx.globalAlpha = 1; }
      }
    }
    ctx.restore();
  }, [chart, container, intervalMs, series, tickSize, trades, unavailable]);

  useEffect(() => {
    redraw(); const frame = requestAnimationFrame(redraw);
    if (!chart) return () => cancelAnimationFrame(frame);
    const ts = chart.timeScale(); ts.subscribeVisibleLogicalRangeChange(redraw);
    const observer = new ResizeObserver(redraw); if (container) observer.observe(container);
    // The cells' numerals are the theme's ink, so a theme flip has to repaint
    // them — nothing else on this canvas would ask it to until the next pan.
    window.addEventListener("trading-scene-theme", redraw);
    return () => {
      cancelAnimationFrame(frame); ts.unsubscribeVisibleLogicalRangeChange(redraw);
      observer.disconnect(); window.removeEventListener("trading-scene-theme", redraw);
    };
  }, [chart, container, redraw]);

  return <canvas ref={canvasRef} data-testid="footprint-layer" className="pointer-events-none absolute inset-0 z-[3]" aria-label={unavailable ?? "Volume footprint bid and ask levels"} />;
}

function format(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(2);
}
