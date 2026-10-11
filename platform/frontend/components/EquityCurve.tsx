"use client";
import { useEffect, useRef } from "react";
import {
  createChart, IChartApi, ISeriesApi, UTCTimestamp, LineStyle, type SeriesMarker, type Time,
} from "lightweight-charts";
import {
  baseChartOptions, chartInkMuted, chartNegative, chartSurface, mixToward, subscribeChartTheme,
} from "@/lib/chartTheme";
import { equityWindowMarks } from "@/lib/backtestFigures";
import type { EquityPoint, SegmentWindow } from "@/lib/types";

export type EquityView = "equity" | "drawdown";

/**
 * Equity over time (single series → no legend needed; the title names it).
 * A dashed baseline marks the initial capital so profit/loss reads at a glance.
 * Series are created once and only their data is updated — never removed
 * individually — so an unmount that disposes the whole chart can't throw.
 *
 * ── Where the windows divide the curve ─────────────────────────────────────
 *
 * The curve was one unbroken area, so nothing on it said where development
 * ended and validation began — the reader had to carry the dates over from
 * the table above and find them on an axis. The validation window is shaded
 * (a neutral band on an overlay scale, behind the line) and the two
 * boundaries carry a marker. Neutral, because the band says "these dates",
 * not "good" or "bad".
 *
 * ── Drawdown ───────────────────────────────────────────────────────────────
 *
 * Every stored point already carries `drawdownPct` against the running peak,
 * and only the single worst value reached the page. `view="drawdown"` draws
 * the whole series, so a reader can see whether a drawdown was one event or a
 * long grind, and where it sat relative to the split. The two series share the
 * right scale and the hidden one is excluded from autoscale.
 */
export function EquityCurve({
  points, initialCapital, split = null, view = "equity", className = "h-[260px]",
}: {
  points: EquityPoint[];
  initialCapital: number;
  /** The run's window split, when it has one. */
  split?: { inSample: SegmentWindow; outOfSample: SegmentWindow; holdout: SegmentWindow } | null;
  view?: EquityView;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaRef = useRef<ISeriesApi<"Area"> | null>(null);
  const baseRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bandRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ddRef = useRef<ISeriesApi<"Area"> | null>(null);
  /*
   * The data pass, kept for the theme event. A histogram carries one colour
   * PER BAR and `applyOptions` cannot recolour bars already drawn (contract
   * §2), so a theme change has to re-run the data pass, not just the options.
   */
  const repaint = useRef<() => void>(() => {});

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, baseChartOptions());
    const unsubscribeTheme = subscribeChartTheme(chart);
    // Created first, so it sits behind the line.
    bandRef.current = chart.addHistogramSeries({
      priceScaleId: "windows", lastValueVisible: false, priceLineVisible: false,
    });
    chart.priceScale("windows").applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
    areaRef.current = chart.addAreaSeries({
      lineColor: "#4f8cff", topColor: "rgba(79,140,255,0.25)", bottomColor: "rgba(79,140,255,0.02)",
      lineWidth: 2,
    });
    baseRef.current = chart.addLineSeries({
      color: "#8c8c8c", lineWidth: 1, lineStyle: LineStyle.Dashed, crosshairMarkerVisible: false,
    });
    ddRef.current = chart.addAreaSeries({
      lineWidth: 2, visible: false,
      priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(1)}%`, minMove: 0.01 },
    });
    chartRef.current = chart;
    const onTheme = (): void => repaint.current();
    window.addEventListener("trading-scene-theme", onTheme);
    return () => {
      window.removeEventListener("trading-scene-theme", onTheme);
      unsubscribeTheme(); chart.remove();
      chartRef.current = null; areaRef.current = null; baseRef.current = null;
      bandRef.current = null; ddRef.current = null;
    };
  }, []);

  useEffect(() => {
    const paint = (): void => {
      const chart = chartRef.current;
      const area = areaRef.current;
      const base = baseRef.current;
      const band = bandRef.current;
      const dd = ddRef.current;
      if (!chart || !area || !base || !band || !dd || points.length === 0) return;
      const time = (t: number): UTCTimestamp => (t / 1000) as UTCTimestamp;
      area.setData(points.map((p) => ({ time: time(p.t), value: p.equity })));
      base.setData([
        { time: time(points[0].t), value: initialCapital },
        { time: time(points[points.length - 1].t), value: initialCapital },
      ]);
      const down = chartNegative();
      dd.applyOptions({
        lineColor: down, topColor: mixToward(down, chartSurface(), 0.05), bottomColor: mixToward(down, chartSurface(), 0.3),
      });
      dd.setData(points.map((p) => ({ time: time(p.t), value: -Math.abs(p.drawdownPct) })));

      const marks = equityWindowMarks(points, split);
      const muted = chartInkMuted();
      const tint = mixToward(muted, chartSurface(), 0.14);
      const from = marks.validationStart;
      band.setData(from === null ? [] : points.map((p) => ({
        time: time(p.t),
        value: 1,
        color: p.t >= from ? tint : "rgba(0,0,0,0)",
      })));
      const markers: SeriesMarker<Time>[] = [];
      if (marks.outOfSampleStart !== null) {
        markers.push({ time: time(marks.outOfSampleStart), position: "aboveBar", shape: "arrowDown", color: muted, text: "Out of sample" });
      }
      if (marks.validationStart !== null) {
        markers.push({ time: time(marks.validationStart), position: "aboveBar", shape: "arrowDown", color: muted, text: "Validation" });
      }
      (view === "equity" ? area : dd).setMarkers(markers);
      (view === "equity" ? dd : area).setMarkers([]);

      area.applyOptions({ visible: view === "equity" });
      base.applyOptions({ visible: view === "equity" });
      dd.applyOptions({ visible: view === "drawdown" });
      chart.timeScale().fitContent();
    };
    repaint.current = paint;
    paint();
  }, [points, initialCapital, split, view]);

  return (
    <div ref={ref} className={`${className} w-full`}
      data-view={view} data-validation-shaded={split ? "true" : "false"} />
  );
}
