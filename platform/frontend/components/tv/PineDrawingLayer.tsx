"use client";
import { useCallback, useEffect, useRef } from "react";
import type { IChartApi, ISeriesApi, Logical } from "lightweight-charts";
import type { PineDrawings } from "@/lib/api";
import type { Candle } from "@/lib/types";

/**
 * Renders the line/box/label objects a Pine script created, on a canvas above
 * the chart.
 *
 * lightweight-charts has no primitive for arbitrary shapes, so these are drawn
 * manually and re-drawn whenever the chart's visible range changes — that
 * subscription is what keeps drawings glued to their bars while panning and
 * zooming. The canvas is `pointer-events: none` throughout: these are script
 * output, not user drawings, so nothing here should intercept a click meant
 * for the chart or the user's own drawing layer.
 *
 * Tables are not drawn here; they are DOM, positioned by the parent.
 */
export function PineDrawingLayer({
  container, chart, series, candles, drawings,
}: {
  container: HTMLDivElement | null;
  chart: IChartApi | null;
  /** Any main-series presentation: only price/coordinate conversion is used. */
  series: ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line"> | ISeriesApi<"Area"> | null;
  candles: Candle[];
  drawings: PineDrawings | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingsRef = useRef<PineDrawings | null>(drawings);
  drawingsRef.current = drawings;

  /** Bar open times in seconds, for time → logical-index conversion. */
  const timesRef = useRef<number[]>([]);
  timesRef.current = candles.map((c) => c.openTime / 1000);

  const stepSec = (() => {
    const t = timesRef.current;
    return t.length > 1 ? t[1]! - t[0]! : 60;
  })();

  /**
   * Chart time (seconds) → logical bar index. Times beyond the loaded candles
   * extrapolate at the bar spacing, so a script that projects a line into the
   * future keeps its slope instead of collapsing onto the last candle.
   */
  const timeToLogical = useCallback((t: number): number => {
    const times = timesRef.current;
    const n = times.length;
    if (n === 0) return 0;
    if (t <= times[0]!) return (t - times[0]!) / stepSec;
    if (t >= times[n - 1]!) return n - 1 + (t - times[n - 1]!) / stepSec;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) lo = mid; else hi = mid;
    }
    const span = times[hi]! - times[lo]!;
    return span > 0 ? lo + (t - times[lo]!) / span : lo;
  }, [stepSec]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !chart || !series || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    /*
     * A chart whose container has left the document has been torn down, or is
     * about to be: measuring it throws inside lightweight-charts. The observer
     * below fires on exactly that transition — a pane closing reports 0 × 0 —
     * and with sixteen panes closing at once it fired sixteen times. There is
     * also nothing to paint on a canvas nobody can see.
     */
    if (!container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const d = drawingsRef.current;
    if (!d) return;

    // Clip to the plot area so nothing bleeds over the axes.
    const plotW = w - (chart.priceScale("right").width() ?? 0);
    const plotH = h - (chart.timeScale().height() ?? 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();

    const xOf = (t: number): number =>
      chart.timeScale().logicalToCoordinate(timeToLogical(t) as Logical) ?? -1e5;
    const yOf = (p: number): number => (series.priceToCoordinate(p) as number | null) ?? -1e5;

    const dash = (style: string): number[] =>
      style.includes("dashed") ? [6, 4] : style.includes("dotted") ? [2, 3] : [];

    // ── boxes (drawn first, so lines and labels sit above the fills) ──
    for (const b of d.boxes) {
      const x1 = xOf(b.left);
      const x2 = xOf(b.right);
      const y1 = yOf(b.top);
      const y2 = yOf(b.bottom);
      if (![x1, x2, y1, y2].every(Number.isFinite)) continue;
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const bw = Math.abs(x2 - x1);
      const bh = Math.abs(y2 - y1);
      if (b.bgColor) {
        ctx.fillStyle = b.bgColor;
        ctx.fillRect(left, top, bw, bh);
      }
      if (b.borderColor && b.borderWidth > 0) {
        ctx.strokeStyle = b.borderColor;
        ctx.lineWidth = b.borderWidth;
        ctx.setLineDash(dash(b.borderStyle));
        ctx.strokeRect(left, top, bw, bh);
        ctx.setLineDash([]);
      }
      if (b.text) {
        ctx.fillStyle = b.textColor;
        ctx.font = "11px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(b.text, left + 4, top + 3);
      }
    }

    // ── lines ──
    for (const l of d.lines) {
      let x1 = xOf(l.x1);
      let x2 = xOf(l.x2);
      const y1 = yOf(l.y1);
      const y2 = yOf(l.y2);
      if (![x1, x2, y1, y2].every(Number.isFinite)) continue;
      // `extend` runs the segment out to the edge of the plot.
      if (l.extend === "right" || l.extend === "both") x2 = plotW;
      if (l.extend === "left" || l.extend === "both") x1 = 0;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.width || 1;
      ctx.setLineDash(dash(l.style));
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── labels ──
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    for (const lb of d.labels) {
      const x = xOf(lb.x);
      const y = yOf(lb.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const text = lb.text ?? "";
      const tw = text ? ctx.measureText(text).width : 0;
      // `label_up` points at the price from below, so the box sits under it.
      const below = lb.style.includes("up");
      const padX = 5;
      const padY = 3;
      const boxH = 16;
      const boxW = tw + padX * 2;
      const bx = x - boxW / 2;
      const by = below ? y + 8 : y - 8 - boxH;

      if (text) {
        ctx.fillStyle = lb.color || "#2962ff";
        ctx.beginPath();
        ctx.roundRect(bx, by, boxW, boxH, 3);
        ctx.fill();
        ctx.fillStyle = lb.textColor || "#ffffff";
        ctx.textAlign = "center";
        ctx.fillText(text, x, by + boxH / 2);
      }
      // The pointer stub tying the label to its price.
      ctx.strokeStyle = lb.color || "#2962ff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, below ? by : by + boxH);
      ctx.stroke();
      void padY;
    }

    ctx.restore();
  }, [chart, series, container, timeToLogical]);

  // Redraw on new data, and follow pan/zoom.
  useEffect(() => {
    redraw();
    if (!chart) return;
    const ts = chart.timeScale();
    const onRange = (): void => redraw();
    ts.subscribeVisibleLogicalRangeChange(onRange);
    const ro = new ResizeObserver(() => redraw());
    if (container) ro.observe(container);
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(onRange);
      ro.disconnect();
    };
  }, [chart, container, redraw, drawings, candles]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-[5]"
      aria-hidden
    />
  );
}

/** Script tables, rendered as DOM in the chart's corners. */
export function PineTables({ drawings }: { drawings: PineDrawings | null }) {
  const tables = drawings?.tables ?? [];
  if (tables.length === 0) return null;

  const corner = (position: string): string => {
    const top = position.includes("top") ? "top-6" : position.includes("middle") ? "top-1/2" : "bottom-8";
    const side = position.includes("left") ? "left-2" : position.includes("center") ? "left-1/2" : "right-16";
    return `${top} ${side}`;
  };

  return (
    <>
      {tables.map((t, i) => {
        const cols = Math.max(...t.cells.map((c) => c.col)) + 1;
        const rows = Math.max(...t.cells.map((c) => c.row)) + 1;
        const grid: (typeof t.cells[number] | undefined)[][] =
          Array.from({ length: rows }, () => new Array(cols).fill(undefined));
        for (const c of t.cells) {
          if (grid[c.row]) grid[c.row]![c.col] = c;
        }
        return (
          <div
            key={i}
            /*
             * A script chooses how many columns its table has, and the chart
             * does not get a say. Capped so a wide one cannot cover the price
             * action on a phone — clipping the far columns is recoverable by
             * rotating or widening; hiding the chart is not.
             */
            className={`pointer-events-none absolute z-[6] max-w-[min(90%,32rem)] overflow-hidden rounded border border-border bg-surface/85 p-1 font-mono text-[10px] ${corner(t.position)}`}
          >
            <table className="border-collapse">
              <tbody>
                {grid.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        className="whitespace-nowrap px-1.5 py-0.5"
                        style={{
                          color: cell?.textColor || "#d1d4dc",
                          background: cell?.bgColor || "transparent",
                        }}
                      >
                        {cell?.text ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}
