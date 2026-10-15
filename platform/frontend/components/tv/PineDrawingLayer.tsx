"use client";
import { useCallback, useEffect, useRef } from "react";
import type { IChartApi, ISeriesApi, Logical } from "lightweight-charts";
import type { PineDrawings } from "@/lib/api";
import type { Candle } from "@/lib/types";
import { coordinateAtLogical } from "@/lib/drawingTimeMap";

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
  /**
   * Any main-series presentation: only price/coordinate conversion is used.
   *
   * `Baseline` joined the union when the baseline chart type arrived. Nothing
   * here reads a series OPTION — only `priceToCoordinate` and its inverse,
   * which every series kind has — so widening it costs nothing.
   */
  series: ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line">
    | ISeriesApi<"Area"> | ISeriesApi<"Baseline"> | ISeriesApi<"Histogram"> | null;
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

    // A time between two bars is a fractional index, which the library maps to 0.
    const xOf = (t: number): number =>
      coordinateAtLogical((l) => chart.timeScale().logicalToCoordinate(l as Logical), timeToLogical(t)) ?? -1e5;
    const yOf = (p: number): number => (series.priceToCoordinate(p) as number | null) ?? -1e5;

    const dash = (style: string): number[] =>
      style.includes("dashed") ? [6, 4] : style.includes("dotted") ? [2, 3] : [];

    // ── boxes (drawn first, so lines and labels sit above the fills) ──
    for (const b of d.boxes) {
      let x1 = xOf(b.left);
      let x2 = xOf(b.right);
      const y1 = yOf(b.top);
      const y2 = yOf(b.bottom);
      if (![x1, x2, y1, y2].every(Number.isFinite)) continue;
      if (x2 < x1) [x1, x2] = [x2, x1];
      // `extend` runs the box out to the edge of the plot, as Pine draws it.
      const ext = b.extend ?? "none";
      if (ext === "right" || ext === "both") x2 = plotW;
      if (ext === "left" || ext === "both") x1 = 0;
      const left = x1;
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
        /*
         * Pine centres box text both ways unless the script says otherwise;
         * drawing it from the top-left corner put "Vol: …" in a different
         * place from TradingView on every box.
         */
        const h = b.textHalign ?? "center";
        const v = b.textValign ?? "center";
        const px = TEXT_PX[b.textSize ?? "auto"] ?? 12;
        ctx.font = `${px}px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`;
        ctx.fillStyle = b.textColor;
        const pad = 4;
        // Text in an extended box stays on screen: it aligns to what is visible.
        const visL = Math.max(left, 0);
        const visR = Math.min(left + bw, plotW);
        ctx.textAlign = h.includes("left") ? "left" : h.includes("right") ? "right" : "center";
        const tx = h.includes("left") ? visL + pad : h.includes("right") ? visR - pad : (visL + visR) / 2;
        ctx.textBaseline = v.includes("top") ? "top" : v.includes("bottom") ? "bottom" : "middle";
        const ty = v.includes("top") ? top + pad : v.includes("bottom") ? top + bh - pad : top + bh / 2;
        ctx.fillText(b.text, tx, ty);
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
    for (const lb of d.labels) {
      const x = xOf(lb.x);
      const y = yOf(lb.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      drawLabel(ctx, lb, x, y);
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

/** Pine's `size.*` as pixel font sizes, as TradingView renders them. */
const TEXT_PX: Record<string, number> = {
  auto: 12, tiny: 9, small: 11, normal: 13, large: 18, huge: 24,
};

const FONT = `-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`;

/**
 * One Pine label, in TradingView's shapes.
 *
 * `label_down` is a rounded box ABOVE its point with a small triangle pointing
 * down at it; `label_up` is the mirror image. `style_none` is the text alone,
 * centred on the point. A glyph (`plotchar`'s "◆") is the character alone,
 * just off the bar. Everything else falls back to the box with a pointer.
 */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  lb: PineDrawings["labels"][number],
  x: number,
  y: number,
): void {
  const text = lb.text ?? "";
  const px = TEXT_PX[lb.size] ?? 12;
  ctx.font = `${px}px ${FONT}`;
  const style = lb.style ?? "";

  if (style.startsWith("glyph")) {
    ctx.fillStyle = lb.textColor || lb.color;
    ctx.textAlign = "center";
    const above = style.includes("above");
    ctx.textBaseline = above ? "bottom" : "top";
    ctx.fillText(text, x, above ? y - 4 : y + 4);
    return;
  }
  if (style.includes("none")) {
    if (!text) return;
    ctx.fillStyle = lb.textColor || "#d1d4dc";
    const align = lb.textAlign ?? "center";
    ctx.textAlign = align.includes("left") ? "left" : align.includes("right") ? "right" : "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
    return;
  }

  const up = style.includes("up");
  // `label_right` points RIGHT at its price, so it sits to the LEFT of it;
  // `label_left` is the mirror image.
  const sideways = style.includes("label_left") || style.includes("label_right");
  const down = style.includes("down") || (!up && !sideways && !style.includes("center"));
  const lines = text.split("\n");
  const tw = Math.max(0, ...lines.map((t) => ctx.measureText(t).width));
  const padX = 6;
  const lineH = Math.round(px * 1.3);
  const boxW = Math.max(tw + padX * 2, text ? 0 : 12);
  const boxH = Math.max(lineH * lines.length + 4, text ? 0 : 12);
  const tip = 5;
  // On a bar label TradingView keeps a small gap between the bar and the tip.
  const gap = lb.yloc && lb.yloc !== "price" ? 3 : 0;
  if (sideways) {
    const pointsRight = style.includes("label_right");
    const sx = pointsRight ? x - tip - boxW : x + tip;
    const sy = y - boxH / 2;
    // A label with no colour is its text alone — Pivot Points' "R1 (5.282)".
    if (lb.color) {
      ctx.fillStyle = lb.color;
      ctx.beginPath();
      ctx.roundRect(sx, sy, boxW, boxH, 3);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(pointsRight ? x - tip : x + tip, y - tip);
      ctx.lineTo(pointsRight ? x - tip : x + tip, y + tip);
      ctx.closePath();
      ctx.fill();
    }
    if (text) {
      ctx.fillStyle = lb.textColor || "#ffffff";
      ctx.textBaseline = "middle";
      ctx.textAlign = pointsRight ? "right" : "left";
      const tx = pointsRight ? sx + boxW - padX : sx + padX;
      lines.forEach((t, k) => ctx.fillText(t, tx, sy + 2 + lineH * k + lineH / 2));
    }
    return;
  }

  const bx = x - boxW / 2;
  const by = up ? y + gap + tip : y - gap - tip - boxH;

  ctx.fillStyle = lb.color || "#2962ff";
  ctx.beginPath();
  ctx.roundRect(bx, by, boxW, boxH, 3);
  ctx.fill();
  // The pointer triangle tying the label to its price.
  ctx.beginPath();
  if (up) {
    ctx.moveTo(x, y + gap);
    ctx.lineTo(x - tip, by + 0.5);
    ctx.lineTo(x + tip, by + 0.5);
  } else if (down) {
    ctx.moveTo(x, y - gap);
    ctx.lineTo(x - tip, by + boxH - 0.5);
    ctx.lineTo(x + tip, by + boxH - 0.5);
  }
  ctx.closePath();
  ctx.fill();

  if (text) {
    ctx.fillStyle = lb.textColor || "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    lines.forEach((t, k) => ctx.fillText(t, x, by + 2 + lineH * k + lineH / 2));
  }
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
            className={`pointer-events-none absolute z-[6] max-w-[min(90%,32rem)] overflow-hidden rounded border border-border bg-surface/85 p-1 text-[11px] ${corner(t.position)}`}
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
                          color: cell?.textColor || "#d1d1d1",
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
