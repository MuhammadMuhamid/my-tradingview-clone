"use client";
import { useEffect, useMemo, useState } from "react";
import {
  formatPlotValue, labelDuplicateInstances, plotValueAt, type ChartOverlay,
} from "@/lib/chartSeries";

/**
 * Compact plot/value association for the active crosshair (latest off-chart).
 *
 * Collapsible, because the expanded form is not always affordable: ten moving
 * averages plus two studies is five wrapped rows, which on a phone is a fifth
 * of the screen laid opaquely over the candles it is describing. Collapsed it
 * keeps the one thing that is still useful at that size — what is on the chart
 * — and gives the pixels back. TradingView puts the same control in the same
 * place, for the same reason.
 */
export function IndicatorLegend({
  overlays, time, className = "", startCollapsed = false, collapsible = true,
  title,
}: {
  overlays: ChartOverlay[];
  time: number | null;
  className?: string;
  /** Open collapsed — the phone layout, where the chart cannot spare the rows. */
  startCollapsed?: boolean;
  /**
   * Offer the toggle at all. An indicator pane holds exactly one instance on
   * one row, so a control to hide that row would cost more space than it could
   * ever return.
   */
  collapsible?: boolean;
  /**
   * Name to show instead of the instance's own, for a legend that holds a
   * single instance. An indicator pane renders one instance, so it cannot see
   * that an identical one exists in another pane — the ordinal that tells the
   * two apart is worked out where all the panes are known, and handed down.
   */
  title?: string;
}) {
  const [collapsed, setCollapsed] = useState(startCollapsed && collapsible);
  // Follows the layout when the viewport crosses the phone breakpoint, but
  // never overrides a choice the user has already made at this size.
  useEffect(() => { setCollapsed(startCollapsed && collapsible); }, [startCollapsed, collapsible]);

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
    const list = labelDuplicateInstances([...byInstance.values()]);
    return title !== undefined && list.length === 1
      ? [{ ...list[0]!, title }]
      : list;
  }, [overlays, title]);

  if (groups.length === 0) return null;
  return (
    <div className={`flex items-start gap-1 text-[13px] leading-5 tabular ${className}`}>
      {collapsible && (
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        aria-label={collapsed
          ? `Show values for ${groups.length} indicator${groups.length === 1 ? "" : "s"}`
          : "Hide indicator values"}
        className="pointer-events-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
          {collapsed ? <path d="M6 9l6 6 6-6" /> : <path d="M6 15l6-6 6 6" />}
        </svg>
      </button>
      )}
      <div className={`pointer-events-none min-w-0 ${collapsible ? "pt-[3px]" : ""}`}>
        {collapsed ? (
          <div className="flex flex-wrap items-baseline gap-x-2 text-ink-muted">
            {groups.map((group, index) => (
              <span key={`${group.title}:${index}`} className="inline-flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: group.plots[0]?.color }}
                />
                <span className="font-semibold text-ink">{group.title}</span>
              </span>
            ))}
          </div>
        ) : (
          groups.map((group, index) => (
            /*
              One line per series, and it does not wrap.

              TradingView's legend is one compact row per study with the name
              truncated when it is long; this wrapped instead, so at 390px
              "Visible Range Volume Profile" alone took three lines over the
              candles and the legend grew downward into the price action every
              time a study was added. Overflow is hidden rather than wrapped —
              the values at the end of the row are what is being read, and the
              full title is on the row's own `title`.
            */
            <div key={`${group.title}:${index}`}
              title={group.params ? `${group.title} ${group.params}` : group.title}
              className="flex max-w-full items-baseline gap-x-2 overflow-hidden whitespace-nowrap">
              <span className="shrink-[3] truncate font-semibold text-ink">{group.title}</span>
              {group.params && <span className="shrink-[5] truncate text-ink-faint">{group.params}</span>}
              {group.plots.map((plot) => (
                <span key={plot.id} className="inline-flex shrink-0 items-center gap-1 text-ink-muted">
                  <span
                    aria-hidden="true"
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: plot.color }}
                  />
                  {plot.title}{" "}
                  {/* The value is the thing being read; the plot's name is context. */}
                  <span className="tabular text-ink">
                    {formatPlotValue(plotValueAt(plot.data, time), plot.precision)}
                  </span>
                </span>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
