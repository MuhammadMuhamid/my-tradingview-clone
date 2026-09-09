"use client";
/**
 * Where a volume profile is actually drawn.
 *
 * ── Why a canvas and not a series ──────────────────────────────────────────
 *
 * Every other thing on this chart is a function of time: lightweight-charts
 * owns the time axis, so a study becomes a series and the library places it. A
 * profile is a function of PRICE. Its rows are horizontal, its extent is a
 * volume rather than a time, and the only thing the time axis contributes is
 * where the histogram is anchored. There is no series shape that expresses
 * that, so the rows are painted directly — through the chart's own scales, so
 * they track pan, zoom and a price-scale drag exactly like everything else.
 *
 * ── One layer, both profiles ───────────────────────────────────────────────
 *
 * A visible-range profile and a fixed-range profile differ in how their range
 * is chosen and in nothing else. By the time either reaches here it is a
 * `ChartProfileDecoration` with two times and a list of rows, so this file has
 * no idea which kind it is drawing and cannot drift between them.
 */
import { useCallback, useEffect, useRef } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import type { ChartProfileDecoration } from "@/lib/chartSeries";

/** Any main-series presentation: only `priceToCoordinate` is used. */
type PriceSeries =
  | ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line">
  | ISeriesApi<"Area"> | ISeriesApi<"Baseline">;

/** A row thinner than this is drawn without its separating gap. */
const GAP_THRESHOLD_PX = 3;

/**
 * How solidly a profile row is painted.
 *
 * The value-area rows were 0.8 — an almost-opaque accent slab laid across the
 * candles for the whole of the visible range, which is the part of the chart a
 * trader is actually reading. A volume profile is context for price, not a
 * subject in front of it, and TradingView draws its own at roughly this
 * weight for the same reason: the shape of the distribution stays completely
 * legible at 0.45, and the candles stay legible THROUGH it, which they did not
 * before. The rows outside the value area drop in step so the two bands keep
 * the same relative emphasis.
 */
const IN_AREA_ALPHA = 0.45;
const OUT_AREA_ALPHA = 0.2;

export function VolumeProfileLayer({
  container, chart, series, profiles,
}: {
  container: HTMLDivElement | null;
  chart: IChartApi | null;
  series: PriceSeries | null;
  profiles: readonly ChartProfileDecoration[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !container || !chart || !series) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    /*
     * A container that has left the document belongs to a pane that is closing.
     * Measuring it throws inside lightweight-charts, and there is nothing to
     * paint on a canvas nobody can see.
     */
    if (!container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (profilesRef.current.length === 0) return;

    const plotWidth = width - (chart.priceScale("right").width() ?? 0);
    const plotHeight = height - (chart.timeScale().height() ?? 0);
    if (plotWidth <= 0 || plotHeight <= 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotWidth, plotHeight);
    ctx.clip();

    const timeScale = chart.timeScale();
    const visible = timeScale.getVisibleRange();
    const visibleFrom = typeof visible?.from === "number" ? visible.from : null;
    const visibleTo = typeof visible?.to === "number" ? visible.to : null;

    /*
     * A range edge that is off screen has no coordinate, and the profile still
     * has to be anchored somewhere. Clamping to the plot edge on the correct
     * side is the honest answer — the range genuinely continues past what is
     * drawn — where falling back to `null` would make a half-scrolled fixed
     * range vanish entirely.
     */
    const xOf = (time: number, fallback: number): number => {
      const x = timeScale.timeToCoordinate(time as UTCTimestamp) as number | null;
      if (x !== null && Number.isFinite(x)) return x;
      if (visibleFrom !== null && time < visibleFrom) return 0;
      if (visibleTo !== null && time > visibleTo) return plotWidth;
      return fallback;
    };

    for (const profile of profilesRef.current) {
      if (profile.rows.length === 0 || !(profile.peakVolume > 0)) continue;
      const xFrom = Math.max(0, Math.min(plotWidth, xOf(profile.from, 0)));
      const xTo = Math.max(0, Math.min(plotWidth, xOf(profile.to, plotWidth)));
      const left = Math.min(xFrom, xTo);
      const right = Math.max(xFrom, xTo);

      if (profile.showRange) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = profile.colors.poc;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 1;
        for (const x of [left, right]) {
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, plotHeight);
          ctx.stroke();
        }
        ctx.restore();
      }

      const maxWidth = Math.max(8, plotWidth * clamp(profile.widthRatio, 0.05, 1));
      const anchor = profile.side === "left" ? left : right;
      const direction = profile.side === "left" ? 1 : -1;
      const valueArea = new Set(profile.valueAreaRows);

      for (let i = 0; i < profile.rows.length; i++) {
        const row = profile.rows[i]!;
        if (!(row.total > 0)) continue;
        const yHigh = series.priceToCoordinate(row.high) as number | null;
        const yLow = series.priceToCoordinate(row.low) as number | null;
        if (yHigh === null || yLow === null) continue;
        const top = Math.min(yHigh, yLow);
        const raw = Math.abs(yLow - yHigh);
        // Sub-pixel rows still have to be visible: a 400-row profile on a short
        // pane would otherwise draw nothing at all.
        const thickness = Math.max(1, raw);
        const gap = thickness > GAP_THRESHOLD_PX ? 1 : 0;
        const barHeight = Math.max(1, thickness - gap);
        if (top + barHeight < 0 || top > plotHeight) continue;

        const inArea = valueArea.has(i);
        const full = (row.total / profile.peakVolume) * maxWidth;

        if (profile.split === "upDown") {
          const upWidth = (row.up / profile.peakVolume) * maxWidth;
          const downWidth = (row.down / profile.peakVolume) * maxWidth;
          paint(ctx, anchor, direction, upWidth, top, barHeight,
            profile.colors.up, inArea ? IN_AREA_ALPHA : OUT_AREA_ALPHA);
          paint(ctx, anchor + direction * upWidth, direction, downWidth, top, barHeight,
            profile.colors.down, inArea ? IN_AREA_ALPHA : OUT_AREA_ALPHA);
        } else {
          paint(ctx, anchor, direction, full, top, barHeight,
            inArea ? profile.colors.valueArea : profile.colors.total,
            inArea ? IN_AREA_ALPHA : OUT_AREA_ALPHA);
        }
      }

      if (profile.showPoc && profile.pocIndex >= 0) {
        const poc = profile.rows[profile.pocIndex]!;
        const yHigh = series.priceToCoordinate(poc.high) as number | null;
        const yLow = series.priceToCoordinate(poc.low) as number | null;
        if (yHigh !== null && yLow !== null) {
          const y = Math.round((yHigh + yLow) / 2) + 0.5;
          const span = maxWidth;
          ctx.save();
          ctx.strokeStyle = profile.colors.poc;
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.95;
          ctx.beginPath();
          ctx.moveTo(anchor, y);
          ctx.lineTo(anchor + direction * span, y);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    ctx.restore();
  }, [chart, container, series]);

  useEffect(() => {
    redraw();
    /*
     * A second paint on the next frame. The first runs before
     * lightweight-charts has laid out a freshly created pane, so the price
     * scale reports a width of zero and every row would be drawn against the
     * wrong plot width.
     */
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
  }, [chart, container, redraw, profiles]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="volume-profile-layer"
      className="pointer-events-none absolute inset-0 z-[2]"
      aria-hidden
    />
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : hi;
}

/** One row segment, from `x` for `width` pixels in `direction`. */
function paint(
  ctx: CanvasRenderingContext2D, x: number, direction: number, width: number,
  top: number, height: number, color: string, alpha: number
): void {
  if (!(width > 0)) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(direction < 0 ? x - width : x, top, width, height);
  ctx.restore();
}
