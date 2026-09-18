"use client";
import { useEffect, useMemo, useState } from "react";
import {
  formatPlotValue, labelDuplicateInstances, plotValueAt, type ChartOverlay,
} from "@/lib/chartSeries";
import { ContextMenu } from "@/components/tv/ContextMenu";
import { legendStudyMenu, type LegendStudyMenuId } from "@/lib/menuPayloads";

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
  title, onAction, onOpenObjectTree, canAction, hidden = [],
  showTitles = true, showInputs = true, showValues = true,
  background = true, backgroundOpacity = 60,
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
   * Open the objects panel, for the menu's `Object tree` row.
   *
   * Separate from `onAction` because it is not an action ON a study — it is the
   * same destination the chart menu's own `Object tree` row resolves to, and
   * routing it through the per-study verb would have meant inventing a fourth
   * verb that acts on the pane instead.
   */
  onOpenObjectTree?: () => void;
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
  /**
   * ── R6 SL-1: three rows in the reference, one switch here ────────────────
   *
   * This legend has always drawn three separable things — a study's title, its
   * inputs (`Length 14 · Source close`) and the reading of each plot at the
   * crosshair — and the Status-line tab had ONE checkbox that mounted or
   * unmounted the lot. The reference has `Titles`, `Inputs` (dependent on
   * titles) and `Values`, so these are those three.
   *
   * True by default so every other caller — the indicator panes, the strategy
   * tester — is unchanged, and so a legend used without the chart's settings
   * still draws everything it has.
   */
  showTitles?: boolean;
  /** Dependent on `showTitles`: the parameters printed after the name. */
  showInputs?: boolean;
  /** The plot readings at the crosshair. */
  showValues?: boolean;
  /**
   * R3b-25: the reference's `Background` row.
   *
   * A translucent plate of the chart's own ground behind each text run, so a
   * legend laid over a dense candle stays readable. On by default, because it
   * is on in the reference and because every caller that does not carry the
   * chart's settings — an indicator pane, the strategy tester — wants the
   * readable form.
   */
  background?: boolean;
  /** 0–100. The reference's default plate reads about 60 %. */
  backgroundOpacity?: number;
}) {
  /**
   * The plate, as a colour or nothing at all.
   *
   * `--ts-surface-rgb` rather than a literal: this is the CHART's ground in
   * whichever theme is running, which is what makes the plate disappear
   * against the plot instead of becoming the grey box R3-10 removed.
   */
  const plate = background && backgroundOpacity > 0
    ? `rgb(var(--ts-surface-rgb) / ${Math.min(100, Math.max(0, backgroundOpacity)) / 100})`
    : undefined;
  /** Which study's `⋯` menu is open, and where it was opened from. */
  const [moreMenu, setMoreMenu] = useState<
    null | { id: string; title: string; at: { x: number; y: number } }>(null);
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
                {showTitles && <span className="truncate text-ink">{group.title}</span>}
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
              className="group/study flex max-w-full items-center gap-x-2 overflow-hidden whitespace-nowrap">
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
              {/*
                ── R3b-20: hover is ONE box around the title, the params AND
                the action cluster ──────────────────────────────────────────

                The hairline used to wrap the title/params span alone, so the
                cluster that appeared beside it on the same hover sat OUTSIDE
                the outline — two things reacting to one pointer, one of them
                enclosed and one of them not. The reference draws a single
                24px box, border rgb(61,61,61) over a fill of the chart's own
                ground, enclosing everything that is about the STUDY; the
                values stay outside it, because they are about the crosshair.

                The fill is what makes it readable: this sits on the candles,
                and rgb(15,15,15) is the plot's own background — so the box
                knocks the bars back without becoming the `bg-surface/75`
                container R3-10 removed from the resting state.
              */}
              <span
                className="pointer-events-auto -mx-1 flex h-6 min-w-0 shrink items-center gap-x-2
                  overflow-hidden rounded-sm border border-transparent px-1
                  group-hover/study:border-state-active group-hover/study:bg-surface"
              >
                <span
                  title={group.params ? `${group.title} ${group.params}` : group.title}
                  className="flex min-w-0 shrink items-baseline gap-x-2 overflow-hidden whitespace-nowrap"
                  style={plate ? { backgroundColor: plate } : undefined}
                >
                  {showTitles && <span className="shrink-[3] truncate text-ink">{group.title}</span>}
                  {showTitles && showInputs && group.plots[0]?.statusInputVisible !== false && group.params
                    && <span className="shrink-[5] truncate text-ink-faint">{group.params}</span>}
                </span>
                {/*
                  The actions sit BETWEEN the parameters and the values, which
                  is where the reference has them — not after the numbers,
                  where a cluster appearing on hover pushes the values the user
                  is reading sideways.

                  ── R3b-19: a 28px pitch, with no gap ───────────────────────

                  The buttons are 28×24 and carried a `gap-0.5` on top, so the
                  cluster ran at a 30px pitch against the reference's 28. The
                  button IS the pitch; the space belongs inside it.
                */}
                {onAction && canAction?.(group.id) && (
                  <span className="flex shrink-0 items-center
                    opacity-0 transition-opacity focus-within:opacity-100 group-hover/study:opacity-100">
                    <StudyButton label={`Hide ${group.title}`}
                      onClick={() => onAction(group.id, "hide")}>
                      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
                      <circle cx="12" cy="12" r="2.6" />
                    </StudyButton>
                    <StudyButton label={`${group.title} settings`}
                      onClick={() => onAction(group.id, "settings")}>
                      <path d="M18.06 10.26L20.96 10.42L20.96 13.58L18.06 13.74L17.51 15.05L19.45 17.22L17.22 19.45L15.05 17.51L13.74 18.06L13.58 20.96L10.42 20.96L10.26 18.06L8.95 17.51L6.78 19.45L4.55 17.22L6.49 15.05L5.94 13.74L3.04 13.58L3.04 10.42L5.94 10.26L6.49 8.95L4.55 6.78L6.78 4.55L8.95 6.49L10.26 5.94L10.42 3.04L13.58 3.04L13.74 5.94L15.05 6.49L17.22 4.55L19.45 6.78L17.51 8.95Z" />
                      <circle cx="12" cy="12" r="2.9" />
                    </StudyButton>
                    <StudyButton label={`Remove ${group.title}`}
                      onClick={() => onAction(group.id, "remove")}>
                      <path d="M4 6h16M9 6V4h6v2M6.5 6l1 14h9l1-14" />
                    </StudyButton>
                    {/*
                      ── R3b-19: `⋯`, the study's own menu ──────────────────

                      The reference's cluster ends in a More button opening the
                      indicator menu. Ours carries the three things a legend
                      row can actually resolve — the same three
                      `ChartPane.paneAction` owns — because a menu row that
                      cannot act is the defect this campaign has removed twice
                      already. `Move to`, `Pin to scale`, `Visual order`,
                      `Copy` and `Add alert on …` are the reference's other
                      rows and are NOT invented here: each needs a resolver the
                      legend cannot reach yet (see `lib/menuPayloads`).
                    */}
                    <StudyButton
                      label={`More for ${group.title}`}
                      /*
                        Anchored to the button box, not the pointer. Opening at
                        `clientX/clientY` moved the menu by up to 23x18px
                        depending on where inside the same 28x22 glyph the click
                        landed; the reference opens at a constant offset from
                        the control. `ContextMenu` still flips it upward when it
                        will not fit below.
                      */
                      onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        setMoreMenu({
                          id: group.id,
                          title: group.title,
                          at: { x: Math.round(box.left), y: Math.round(box.bottom + 4) },
                        });
                      }}
                    >
                      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
                      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
                      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
                    </StudyButton>
                  </span>
                )}
              </span>
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
              {showValues && group.plots.filter((plot) =>
                plot.constantValue === undefined && plot.statusValueVisible !== false).map((plot) => {
                const value = plotValueAt(plot.data, time);
                /*
                  ── R3b-22: an ABSENT reading wears no plot colour ─────────

                  `∅` was drawn in the plot's own colour, so a purple `∅`
                  read as a purple value — the colour on this row means "this
                  is that line's number", and there is no number. The
                  reference draws its empty marker in a neutral light grey for
                  exactly that reason. The plot's name stays on the tooltip
                  and in the screen-reader text, so which line is silent is
                  still answerable.
                */
                const absent = value === null || !Number.isFinite(value);
                return (
                  <span
                    key={plot.id}
                    title={plot.title}
                    className={`pointer-events-auto shrink-0 tabular ${absent ? "text-ink-muted" : ""}`}
                    style={{
                      ...(absent ? {} : { color: plot.color }),
                      ...(plate ? { backgroundColor: plate } : {}),
                    }}
                  >
                    {absent ? "∅" : formatPlotValue(value, plot.precision)}
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
            <span className="pointer-events-auto flex shrink-0 items-center opacity-60
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
          /*
            R3b-20: 28×20 inside a rgb(61,61,61) border — the reference's box,
            measured at 29×21 outer. It was 26×20 inside `border-border`
            (rgb 46), which is the hairline the legend uses for nothing else
            and reads as absent over the plot.
          */
          className="pointer-events-auto mt-0.5 flex h-5 w-7 shrink-0 items-center
            justify-center rounded-sm border border-state-active text-ink-faint transition-colors
            hover:bg-state-hover hover:text-ink"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
            {collapsed ? <path d="M6 9l6 6 6-6" /> : <path d="M6 15l6-6 6 6" />}
          </svg>
        </button>
      )}
      {/*
        R3b-19: the `⋯` menu, through the product's ONE context menu.

        Escape, the outside click, the arrow keys that skip a separator and the
        focus that goes back to the glyph are `ContextMenu`'s, not a second
        implementation of them — the same component the chart, a drawing, the
        price axis and a watchlist row open.
      */}
      <ContextMenu
        at={moreMenu?.at ?? null}
        label={moreMenu?.title ?? ""}
        entries={moreMenu ? legendStudyMenu({ title: moreMenu.title }) : []}
        onSelect={(id) => {
          if (!moreMenu) return;
          if (id === "study-legend:object-tree") { onOpenObjectTree?.(); return; }
          if (!onAction) return;
          const action: Record<
            Exclude<LegendStudyMenuId, "study-legend:object-tree">,
            "hide" | "settings" | "remove"
          > = {
            "study-legend:settings": "settings",
            "study-legend:toggle-visible": "hide",
            "study-legend:remove": "remove",
          };
          const verb = action[id as Exclude<LegendStudyMenuId, "study-legend:object-tree">];
          if (verb) onAction(moreMenu.id, verb);
        }}
        onClose={() => setMoreMenu(null)}
      />
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
  { label, onClick, children }: {
    label: string;
    /** The event, because `⋯` opens a menu at the pointer. */
    onClick: (event: React.MouseEvent) => void;
    children: React.ReactNode;
  }
) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => { event.stopPropagation(); onClick(event); }}
      /*
        28×22 with an 18px glyph. The pitch (28) was right; the cell was 2px too
        tall and the glyph a ninth too small, which is why this cluster read
        lighter than the reference's at the same zoom. Re-measured live on
        2026-09-18 — the earlier comment claimed 28×24/16 as "measured", and it
        was not.

        Hover is a hairline, not a fill: this sits on the candles, and a filled
        square there is the "bordered mini-toolbar" the owner vetoed.
      */
      className="flex h-[22px] w-7 items-center justify-center rounded-sm border border-transparent
        text-ink-faint transition-colors hover:border-border hover:text-ink"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
