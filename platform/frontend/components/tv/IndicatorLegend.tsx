"use client";
import { useMemo } from "react";
import {
  formatPlotValue, plotValueAt, type ChartOverlay,
} from "@/lib/chartSeries";

/** Compact plot/value association for the active crosshair (latest off-chart). */
export function IndicatorLegend({
  overlays, time, className = "",
}: {
  overlays: ChartOverlay[];
  time: number | null;
  className?: string;
}) {
  const groups = useMemo(() => {
    const byInstance = new Map<string, { title: string; params: string; plots: ChartOverlay[] }>();
    for (const overlay of overlays) {
      const id = overlay.instanceId ?? overlay.id;
      const existing = byInstance.get(id);
      if (existing) existing.plots.push(overlay);
      else byInstance.set(id, {
        title: overlay.instanceTitle || overlay.title,
        params: overlay.instanceParams ?? "",
        plots: [overlay],
      });
    }
    return [...byInstance.values()];
  }, [overlays]);

  if (groups.length === 0) return null;
  return (
    <div className={`pointer-events-none font-mono text-[10px] leading-4 ${className}`}>
      {groups.map((group, index) => (
        <div key={`${group.title}:${index}`} className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-[#d1d4dc]">{group.title}</span>
          {group.params && <span className="text-[#6f7b8e]">{group.params}</span>}
          {group.plots.map((plot) => (
            <span key={plot.id} className="inline-flex items-center gap-1 text-[#9aa4b6]">
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: plot.color }}
              />
              {plot.title} {formatPlotValue(plotValueAt(plot.data, time), plot.precision)}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
