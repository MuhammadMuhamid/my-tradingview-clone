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
  title, onAction, canAction, hidden = [],
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
  /**
   * Act on one study from its own legend row: hide it, open its settings,
   * remove it.
   *
   * A study in its OWN pane already had these — `IndicatorPane` puts them in
   * the pane header. A study overlaid on the PRICE pane had none of them
   * anywhere on the chart: hiding an EMA meant leaving the chart, finding it
   * in the Studies panel and clicking a gear there. The reference puts them on
   * the legend row for both kinds, which is the only place a user looks when
   * the thing they want to act on is the line in front of them.
   *
   * The key handed back is the instance's, and it is the same key
   * `ChartPane.paneAction` already resolves against the native and Pine study
   * lists — no second lookup, and no second definition of what a study is.
   */
  onAction?: (instanceId: string, action: "hide" | "settings" | "remove") => void;
  /**
   * Whether this instance is a study that `onAction` can actually move.
   *
   * Not every line on the price pane is a study. The moving-average panel, an
   * Anchored VWAP and a volume-profile drawing all publish overlays through
   * the same legend, and none of them lives in a study list — wiring a trash
   * can to them would put three dead controls on the most-used surface in the
   * product, which is the exact defect this campaign already fixed once on the
   * indicator panes. Without this predicate the row stays a label.
   */
  canAction?: (instanceId: string) => boolean;
  /**
   * Studies that are applied but switched off, so the eye is not a one-way door.
   *
   * A hidden instance emits no overlays anywhere in this product, so hiding one
   * removed it from the legend completely — the control that turned it off was
   * the same control that made it unreachable, and the only way back was the
   * Studies panel. The reference keeps a hidden study's row exactly where it
   * was, dimmed, with its eye closed.
   *
   * Panes are built from overlays too, so a hidden pane study has no pane left
   * to sit in either. Its row lands here, which is the one place still on
   * screen where a user can put it back.
   */
  hidden?: { id: string; title: string }[];
}) {
  const [collapsed, setCollapsed] = useState(startCollapsed && collapsible);
  // Follows the layout when the viewport crosses the phone breakpoint, but
  // never overrides a choice the user has already made at this size.
  useEffect(() => { setCollapsed(startCollapsed && collapsible); }, [startCollapsed, collapsible]);

  const groups = useMemo(() => {
    const byInstance = new Map<string,
      { id: string; title: string; params: string; plots: ChartOverlay[] }>();
    for (const overlay of overlays) {
      const id = overlay.instanceId ?? overlay.id;
      const existing = byInstance.get(id);
      if (existing) existing.plots.push(overlay);
      else byInstance.set(id, {
        id,
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

  if (groups.length === 0 && hidden.length === 0) return null;
  return (
    /*
      ── R3-10/R3-14: a legend is type over the plot, not a box on it ────────

      Every row used to sit in its own `rounded bg-surface/75` box and the
      action cluster in a second one, so the top-left of every pane carried two
      filled rectangles laid over the candles — chrome, because it WAS a
      container. The reference's legend has no background, no border and no
      radius at rest; the only thing hover adds is a hairline around the
      title/params group. Nothing here paints a surface.

      A column, not a row: the collapse control moved OUT of the left gutter
      and UNDER the last study row, which is where the reference puts it — as a
      26×20 bordered box — and where it stops costing every row 24px of
      indent.
    */
    <div className={`flex flex-col items-start text-[13px] leading-5 tabular ${className}`}>
      <div className="pointer-events-none min-w-0 max-w-full">
        {collapsed ? (
          /*
            Collapsed is the SAME rule as expanded below: one row, clipped.

            This branch kept `flex-wrap` after the expanded one was fixed, so
            collapsing a study to hide its values made the legend taller
            instead of shorter — at 390px "Relative Strength Index" alone
            wrapped to three stacked lines across the top of its own pane.
            Collapsing must never cost vertical space.
          */
          <div
            title={groups.map((group) => group.title).join(" · ")}
            className="flex max-w-full items-baseline gap-x-2 overflow-hidden whitespace-nowrap text-ink-muted">
            {groups.map((group, index) => (
              <span key={`${group.title}:${index}`} className="inline-flex min-w-0 items-center gap-1">
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: group.plots[0]?.color }}
                />
                <span className="truncate text-ink">{group.title}</span>
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
              className="group/study flex max-w-full items-baseline gap-x-2 overflow-hidden whitespace-nowrap">
              {/*
                ── R3-11: the title is not the loudest thing on the chart ─────

                `font-semibold` made every study title heavier than the price
                it was laid over. The reference's is 13px/400 ink with its
                parameters 13px/400 muted beside it, and the ONE thing hover
                adds is a hairline around this group — which is why the outline
                lives here and not on the row.

                `pointer-events-auto` on the span rather than the row: a legend
                that swallowed the pointer would break a trend line drawn from
                the top-left corner, which is where most of them start. Hover
                still reaches the row's `group/study` from here, because
                `:hover` applies to the ancestors of whatever was hit.
              */}
              <span
                title={group.params ? `${group.title} ${group.params}` : group.title}
                className="pointer-events-auto -mx-1 flex min-w-0 shrink items-baseline gap-x-2
                  overflow-hidden rounded-sm border border-transparent px-1
                  group-hover/study:border-border"
              >
                <span className="shrink-[3] truncate text-ink">{group.title}</span>
                {group.params && <span className="shrink-[5] truncate text-ink-faint">{group.params}</span>}
              </span>
              {/*
                The actions sit BETWEEN the parameters and the values, which is
                where the reference has them — not after the numbers, where a
                cluster appearing on hover pushes the values the user is
                reading sideways.
              */}
              {onAction && canAction?.(group.id) && (
                <span className="pointer-events-auto flex shrink-0 items-center gap-0.5
                  opacity-0 transition-opacity focus-within:opacity-100 group-hover/study:opacity-100">
                  <StudyButton label={`Hide ${group.title}`}
                    onClick={() => onAction(group.id, "hide")}>
                    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
                    <circle cx="12" cy="12" r="2.6" />
                  </StudyButton>
                  <StudyButton label={`${group.title} settings`}
                    onClick={() => onAction(group.id, "settings")}>
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" />
                  </StudyButton>
                  <StudyButton label={`Remove ${group.title}`}
                    onClick={() => onAction(group.id, "remove")}>
                    <path d="M4 6h16M9 6V4h6v2M6.5 6l1 14h9l1-14" />
                  </StudyButton>
                </span>
              )}
              {/*
                ── TVP8 round two: three values that could never have one ─────

                The value column is what the legend is FOR: the plot's reading
                at the crosshair. A constant level has no such reading, so RSI
                rendered

                    Relative Strength Index  Length 14 · Source close
                    RSI 45.28   70 —   50 —   30 —

                — three permanent em-dashes laid over the candles, on the row
                whose own comment says the values at its end are what is being
                read. The reference does not list reference levels in its
                status line either; they are lines on the pane with their own
                axis labels, which is where a constant belongs.

                `constantValue` is exactly the flag for this: `ChartSeries`
                sets it on an hline, which has two endpoints for the renderer
                and one value at every bar.
              */}
              {/*
                ── R3-11: the VALUE is the row, and it wears the plot's colour ─

                This printed `● RSI 45.91` — a 6px dot, the plot's NAME in
                muted, and the number in plain ink. Three studies made nine
                tokens of which three were numbers. The reference prints the
                numbers alone, each in its own plot's colour, so the colour
                that identifies the line is carried by the thing being read
                instead of by a bullet beside it. The name is the tooltip.

                `∅` rather than `—` for an absent reading: an em-dash beside
                other numbers reads as a value of zero-ish, and the reference
                uses the empty-set glyph precisely because it cannot.
              */}
              {group.plots.filter((plot) => plot.constantValue === undefined).map((plot) => {
                const value = plotValueAt(plot.data, time);
                return (
                  <span
                    key={plot.id}
                    title={plot.title}
                    className="pointer-events-auto shrink-0 tabular"
                    style={{ color: plot.color }}
                  >
                    {value === null || !Number.isFinite(value)
                      ? "∅"
                      : formatPlotValue(value, plot.precision)}
                    <span className="sr-only"> {plot.title}</span>
                  </span>
                );
              })}
            </div>
          ))
        )}
        {!collapsed && onAction && hidden.map((study) => (
          <div key={`hidden:${study.id}`}
            title={`${study.title} — applied, not drawn`}
            className="group/study flex max-w-full items-baseline gap-x-2 overflow-hidden whitespace-nowrap">
            <span className="shrink truncate text-ink-faint line-through
              decoration-1">{study.title}</span>
            <span className="pointer-events-auto flex shrink-0 items-center gap-0.5 opacity-60
              transition-opacity focus-within:opacity-100 group-hover/study:opacity-100">
              <StudyButton label={`Show ${study.title}`}
                onClick={() => onAction(study.id, "hide")}>
                {/* An eye with a stroke through it: the same glyph, switched off. */}
                <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
                <path d="M3 3l18 18" />
              </StudyButton>
              <StudyButton label={`Remove ${study.title}`}
                onClick={() => onAction(study.id, "remove")}>
                <path d="M5 5l14 14M19 5L5 19" />
              </StudyButton>
            </span>
          </div>
        ))}
      </div>
      {collapsible && (
        /*
          ── R3-14: the collapse control is a box UNDER the studies ───────────

          It was a chevron in the legend's left gutter, inline before the first
          title, which indented every row by 24px and put a control where the
          reference puts the study's own name. The reference's is a 26×20
          bordered box below the last study row — out of the reading order of
          the rows it hides, and the only bordered thing in the legend.
        */
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-label={collapsed
            ? `Show values for ${groups.length} indicator${groups.length === 1 ? "" : "s"}`
            : "Hide indicator values"}
          title={collapsed ? "Show indicator legend" : "Hide indicator legend"}
          className="pointer-events-auto mt-0.5 flex h-5 w-[26px] shrink-0 items-center
            justify-center rounded-sm border border-border text-ink-faint transition-colors
            hover:bg-state-hover hover:text-ink"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
            {collapsed ? <path d="M6 9l6 6 6-6" /> : <path d="M6 15l6-6 6 6" />}
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * One action on one study, at the reference's 28×24 legend-action size.
 *
 * A real `<button>` rather than a span with a handler, so the cluster is
 * reachable by keyboard — which is also what makes `focus-within` able to
 * reveal it for someone who never uses a pointer.
 */
function StudyButton(
  { label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }
) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      /*
        28×24 with a 16px glyph — the reference's legend-action size, measured.
        The 18×18 button with a 12px glyph it replaces was a sixth smaller than
        anything else a pointer aims at in this product.

        Hover is a hairline, not a fill: this sits on the candles, and a filled
        square there is the "bordered mini-toolbar" the owner vetoed.
      */
      className="flex h-6 w-7 items-center justify-center rounded-sm border border-transparent
        text-ink-faint transition-colors hover:border-border hover:text-ink"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
