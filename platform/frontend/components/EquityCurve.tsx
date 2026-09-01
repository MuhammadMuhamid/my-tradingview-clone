"use client";
import { useEffect, useRef } from "react";
import {
  createChart, IChartApi, ISeriesApi, UTCTimestamp, LineStyle,
} from "lightweight-charts";
import { baseChartOptions } from "@/lib/chartTheme";
import type { EquityPoint } from "@/lib/types";

/**
 * Equity over time (single series → no legend needed; the title names it).
 * A dashed baseline marks the initial capital so profit/loss reads at a glance.
 * Series are created once and only their data is updated — never removed
 * individually — so an unmount that disposes the whole chart can't throw.
 */
export function EquityCurve({ points, initialCapital, className = "h-[260px]" }: { points: EquityPoint[]; initialCapital: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaRef = useRef<ISeriesApi<"Area"> | null>(null);
  const baseRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, baseChartOptions());
    areaRef.current = chart.addAreaSeries({
      lineColor: "#4f8cff", topColor: "rgba(79,140,255,0.25)", bottomColor: "rgba(79,140,255,0.02)",
      lineWidth: 2,
    });
    baseRef.current = chart.addLineSeries({
      color: "#6b7486", lineWidth: 1, lineStyle: LineStyle.Dashed, crosshairMarkerVisible: false,
    });
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; areaRef.current = null; baseRef.current = null; };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const area = areaRef.current;
    const base = baseRef.current;
    if (!chart || !area || !base || points.length === 0) return;
    area.setData(points.map((p) => ({ time: (p.t / 1000) as UTCTimestamp, value: p.equity })));
    base.setData([
      { time: (points[0].t / 1000) as UTCTimestamp, value: initialCapital },
      { time: (points[points.length - 1].t / 1000) as UTCTimestamp, value: initialCapital },
    ]);
    chart.timeScale().fitContent();
  }, [points, initialCapital]);

  return <div ref={ref} className={`${className} w-full`} />;
}
