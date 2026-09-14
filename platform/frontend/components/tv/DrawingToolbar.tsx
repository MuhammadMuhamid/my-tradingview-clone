"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { BINDINGS, isMacPlatform, type Binding, type ShortcutAction } from "@/lib/shortcuts";
import { armIconGlyph, ICON_GLYPHS, type DrawingTool } from "@/lib/drawings";

const DRAWING_FAVOURITES_KEY = "tv.drawing-tools.favourites.v1";

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  WIRING THIS COMPONENT STILL NEEDS FROM `app/chart/page.tsx`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything below is OPTIONAL. The rail compiles, renders and works with the
 * props the page passes today; each of these only widens a control that is
 * currently a two-state toggle into the scoped menu the reference has. Where a
 * scope has no handler, its row is NOT RENDERED — a row that cannot act is
 * worse than a missing one, because it costs the user the time to find out.
 *
 *   magnetMode?: "off" | "weak" | "strong"
 *   onMagnetMode?: (mode: "off" | "weak" | "strong") => void
 *       Replaces `magnet` / `onMagnet`. "weak" snaps only when the pointer is
 *       already within a few pixels of an OHLC level; "strong" always snaps to
 *       the nearest one. Until it is passed, the two rows fall back to
 *       `onMagnet(true)` and the cell toggles `onMagnet(!magnet)`.
 *
 *   lockScope?: "none" | "drawings" | "indicators" | "all"
 *   onLockScope?: (scope: "drawings" | "indicators" | "all") => void
 *       `drawings` is today's `drawLocked`. `indicators` must lock the study
 *       list the same way (no drag, no delete, no settings edit); `all` is
 *       both. Until it is passed, only the "Lock drawings" row renders and it
 *       calls `onLocked(!locked)`.
 *
 *   hideScope?: "none" | "drawings" | "indicators" | "positions" | "all"
 *   onHideScope?: (scope: "drawings" | "indicators" | "positions" | "all") => void
 *       `positions` is the trading-overlay layer (`TradingOverlays`). Until it
 *       is passed, only "Hide drawings" renders, calling `onHidden(!hidden)`.
 *
 *   indicatorCount?: number
 *   onRemove?: (scope: "drawings" | "indicators" | "all") => void
 *       The Remove flyout's rows read "Remove N drawings" / "Remove N
 *       indicators" / "Remove N drawings & M indicators". Until `onRemove` is
 *       passed, only the drawings row renders and it calls `onDeleteAll()`.
 *       The cell itself is NEVER disabled and carries no count label, which is
 *       what the reference does.
 *
 *   onZoomRange?: (from: number, to: number) => void
 *       Optional. The Zoom-in cell does not need it: it arms the `zoom` tool
 *       and `DrawingCanvas` drag-selects a span and calls the chart's own
 *       `setVisibleRange`. Pass it only if the page wants to observe or
 *       broadcast the resulting viewport (pane range sync).
 *
 *   optionSwitches?: { valuesTooltip?, snapToIndicators?, alwaysRemoveLocked? }
 *       Each is `{ on: boolean; onChange: (v: boolean) => void }` and renders
 *       the footer switch the matching reference flyout ends with. Omitted
 *       entries render no footer at all.
 *
 * Also still owned by the page, and deliberately NOT rendered here: the
 * account/product cell above the rail. MAIN's restructure makes the toolbar a
 * full-width first row `[52px account cell][toolbar]`, so this column starts
 * at y=38 and its own `pt-[10px]` puts the first tool at y=48.
 */

/*
 * Icon set — 24-unit stroked paths, drawn at 28px with a 0.9 stroke.
 *
 * ── Weight ─────────────────────────────────────────────────────────────────
 *
 * These were 1.8, which at 28px is a 2.1px effective line against the
 * reference's 1px hairlines: the same silhouettes carrying 1.6–1.8× the ink,
 * which is why the rail read as a bold grey secondary strip beside the chart
 * instead of the fine line-art the reference draws. Rest ink is full `text-ink`
 * for the same reason — the selected state is carried by the 34×34 chip, as it
 * is there, not by making everything else dimmer.
 *
 * ── One silhouette per tool ────────────────────────────────────────────────
 *
 * Thirty-five tools used to share a glyph with another tool: every Gann box
 * wore the rectangle, every harmonic pattern wore the polyline, three
 * Fibonacci variants wore the retracement. A rail is aimed at from muscle
 * memory, and muscle memory is shape memory — two tools with one shape are two
 * tools you have to read the label of. Each one below is our own geometry
 * describing what the tool DOES; none of it is traced from anybody's artwork.
 */
const ICONS: Record<string, JSX.Element> = {
  // ── cursors ──
  cursor: <><path d="M12 3v6M12 15v6M3 12h6M15 12h6" /></>,
  dot: <circle cx="12" cy="12" r="3" fill="currentColor" />,
  arrowCursor: <><path d="M7 4l11 8-5 1.2L15 20l-2.4 1-2.2-6.2L7 18z" /></>,
  eraser: <><path d="M4 16l7-7 6 6-4 4H7z" /><path d="M3 21h18" /></>,

  // ── trend: lines ──
  trend: <><circle cx="6" cy="18" r="1.6" /><circle cx="18" cy="6" r="1.6" /><path d="M7.3 16.7l9.4-9.4" /></>,
  ray: <><circle cx="6" cy="17" r="1.6" /><path d="M7.4 15.9L21 4" /><circle cx="13" cy="10" r="1.6" /></>,
  infoline: <><path d="M4 19L20 5" /><path d="M4 19h16M4 19V5" /></>,
  extended: <><path d="M3 20L21 4" /><circle cx="9" cy="15" r="1.6" /><circle cx="15" cy="9" r="1.6" /></>,
  trendAngle: <><path d="M4 19L20 5" /><path d="M8 19a8 8 0 018-8" /></>,
  hline: <><path d="M3 12h18" /><circle cx="12" cy="12" r="1.8" /></>,
  hray: <><path d="M8 12h13" /><circle cx="6" cy="12" r="1.8" /></>,
  vline: <><path d="M12 3v18" /><circle cx="12" cy="12" r="1.8" /></>,
  crossline: <><path d="M3 12h18M12 3v18" /><circle cx="12" cy="12" r="1.8" /></>,

  // ── trend: channels ──
  parallel: <><path d="M3 15L15 5" /><path d="M9 19l12-10" /><circle cx="9" cy="10" r="1.4" /><circle cx="15" cy="14" r="1.4" /></>,
  // A cloud of samples with the fitted line through it: what a regression IS.
  regression: <><path d="M4 18L20 7" /><circle cx="7" cy="17" r="1" /><circle cx="10" cy="13" r="1" /><circle cx="13" cy="14" r="1" /><circle cx="16" cy="9" r="1" /><circle cx="19" cy="10" r="1" /></>,
  // Two HORIZONTAL edges, which is the whole difference from a channel.
  flatTopBottom: <><path d="M4 7h16M4 17h16" /><path d="M8 7v10M16 7v10" /></>,
  disjointChannel: <><path d="M3 14L14 5" /><path d="M10 20l11-9" /><path d="M14 5l-1 2M10 20l1-2" /></>,

  // ── trend: pitchforks ──
  pitchfork: <><path d="M4 20L12 9M12 9L20 4M12 9v11" /><circle cx="4" cy="20" r="1.4" /><circle cx="20" cy="4" r="1.4" /></>,
  // The median line springs from the FIRST anchor, not the midpoint.
  schiffPitchfork: <><path d="M4 19l7-9M11 10l8-5M8 14v7" /><circle cx="4" cy="19" r="1.4" /><circle cx="8" cy="14" r="1.4" /></>,
  modifiedSchiffPitchfork: <><path d="M4 19l7-9M11 10l8-5M6 16v6" /><path d="M9 12.5v8" /><circle cx="4" cy="19" r="1.4" /></>,
  insidePitchfork: <><path d="M6 20l6-9 6-5" /><path d="M9 15.5v5M15 8.5v5" /><circle cx="12" cy="11" r="1.4" /></>,

  // ── fibonacci ──
  fib: <><path d="M3 5h18M3 10h18M3 15h18M3 20h18" /><circle cx="7" cy="5" r="1.3" /><circle cx="17" cy="20" r="1.3" /></>,
  fibext: <><path d="M3 19h18M3 13h18M3 7h18" /><path d="M6 21l6-16" /></>,
  // Levels that run PARALLEL to a slope rather than flat.
  fibChannel: <><path d="M3 17L15 6M6 20L18 9M9 21L21 10" /><circle cx="3" cy="17" r="1.2" /></>,
  // Verticals at Fibonacci distances in TIME.
  fibTimeZone: <><path d="M3 4v16M5 4v16M8 4v16M13 4v16M21 4v16" /></>,
  // Rays fanning from one corner.
  fibSpeedResistanceFan: <><path d="M4 20L20 4M4 20l16 6M4 20l16-13M4 20h17" /><circle cx="4" cy="20" r="1.3" /></>,
  // Verticals raised off a sloped base: time, measured along a trend.
  trendFibTime: <><path d="M3 20L21 8" /><path d="M6 18v4M10 15.5v6.5M16 11.5v10.5" /></>,
  fibCircles: <><circle cx="12" cy="16" r="3" /><circle cx="12" cy="16" r="6.5" /><path d="M12 16L20 6" /></>,
  fibSpiral: <><path d="M13 13a2 2 0 10-2-2 4 4 0 106 3 7 7 0 11-9-5" /></>,
  fibSpeedResistanceArcs: <><path d="M4 20a5 5 0 015-5M4 20a10 10 0 0110-10M4 20a15 15 0 0115-15" /><circle cx="4" cy="20" r="1.3" /></>,
  fibWedge: <><path d="M4 20L20 5" /><path d="M4 20h16" /><path d="M4 20a10 10 0 007-3M4 20a15 15 0 0011-5" /></>,
  // A fan of medians, rather than one.
  pitchfan: <><path d="M4 20l16-14M4 20l14-2M4 20l10-10M4 20l6 1" /><circle cx="4" cy="20" r="1.3" /></>,

  // ── gann ──
  gannBox: <><rect x="4" y="5" width="16" height="14" /><path d="M4 19L20 5M4 5l16 14" /></>,
  gannSquareFixed: <><rect x="5" y="5" width="14" height="14" /><path d="M5 19L19 5" /><path d="M5 12h14M12 5v14" /></>,
  gannSquare: <><rect x="4" y="4" width="16" height="16" /><path d="M4 20L20 4" /><path d="M4 20l16-8M4 20l8-16" /></>,
  gannFan: <><path d="M4 20L20 4M4 20l16 4M4 20l16-10M4 20l10-16M4 20l4-16" /></>,

  // ── patterns: chart ──
  xabcd: <><path d="M4 18l4-9 5 7 4-10 3 8" /><circle cx="4" cy="18" r="1.2" /><circle cx="13" cy="16" r="1.2" /><circle cx="20" cy="14" r="1.2" /></>,
  cypher: <><path d="M4 19l5-11 4 9 4-6 3 5" /><path d="M9 8l8 8" /></>,
  headAndShoulders: <><path d="M3 18l3-5 3 3 3-9 3 9 3-3 3 5" /><path d="M6 16h12" /></>,
  abcdPattern: <><path d="M4 18l5-8 4 5 6-9" /><circle cx="4" cy="18" r="1.2" /><circle cx="9" cy="10" r="1.2" /><circle cx="13" cy="15" r="1.2" /><circle cx="19" cy="6" r="1.2" /></>,
  trianglePattern: <><path d="M3 6l18 6-18 6z" /></>,
  threeDrives: <><path d="M3 19l3-4 2 3 3-6 2 4 3-7 2 4 3-6" /></>,

  // ── patterns: elliott ──
  elliottImpulse: <><path d="M3 20l3-6 2 3 4-9 2 4 4-8" /><path d="M9 6h.01M15 4h.01" /></>,
  elliottCorrection: <><path d="M4 6l4 8 4-5 4 8" /><path d="M20 18V9" /></>,
  elliottTriangle: <><path d="M3 12l4 6 4-9 4 7 4-5" /><path d="M3 12h16" /></>,
  elliottDoubleCombo: <><path d="M3 7l4 8 3-5 3 7 3-6 5 6" /></>,
  elliottTripleCombo: <><path d="M2 7l3 7 2-4 3 6 2-5 3 6 2-4 5 6" /></>,

  // ── patterns: cycles ──
  cyclicLines: <><path d="M6 4v16M14 4v16" /><path d="M6 12a4 4 0 018 0" /></>,
  timeCycles: <><path d="M4 18a4 4 0 018 0 4 4 0 008 0" /><path d="M4 21h16" /></>,
  sineLine: <><path d="M3 12c3-9 6 9 9 0s6-9 9 0" /></>,

  // ── forecasting ──
  long: <><rect x="4" y="5" width="16" height="6" /><rect x="4" y="13" width="16" height="6" /><path d="M12 19v-14" /></>,
  short: <><rect x="4" y="5" width="16" height="6" /><rect x="4" y="13" width="16" height="6" /><path d="M12 5v14" /></>,
  // A known leg, then a projected one, dashed-looking by its gap.
  positionForecast: <><path d="M3 18l6-6" /><path d="M11 10h2M15 8h2M19 6h2" /><path d="M16 4h5v5" /></>,
  barsPattern: <><path d="M6 7v10M10 5v14M14 8v8M18 6v12" /><path d="M4 9h2M10 8h2M12 12h2M16 10h2" /></>,
  // A wedge of the plane swept between two rays.
  sector: <><path d="M5 19V6" /><path d="M5 19h14" /><path d="M5 19L19 8" /><path d="M14 19a9 9 0 00-4-7.3" /></>,

  // ── volume-based ──
  avwap: <><circle cx="5" cy="18" r="2" /><path d="M5 18c4 0 5-9 9-11s6 1 7 3" /></>,
  vprange: <><path d="M5 4v16M19 4v16" /><path d="M19 7h-6M19 11h-9M19 15h-4" /></>,
  avprofile: <><circle cx="5" cy="18" r="2" /><path d="M5 18h15M20 7h-6M20 11h-9M20 15h-4" /></>,

  // ── measurers ──
  pricerange: <><path d="M12 4v16" /><path d="M8 7l4-3 4 3M8 17l4 3 4-3" /></>,
  daterange: <><path d="M4 12h16" /><path d="M7 8L4 12l3 4M17 8l3 4-3 4" /></>,
  datePriceRange: <><rect x="4" y="6" width="16" height="12" /><path d="M4 12h16M12 6v12" /></>,
  ruler: <><path d="M3 15l12-12 6 6-12 12z" /><path d="M7 11l2 2M10 8l2 2M13 5l2 2" /></>,
  zoomIn: <><circle cx="11" cy="11" r="6.5" /><path d="M11 8v6M8 11h6" /><path d="M16 16l5 5" /></>,

  // ── shapes: brushes ──
  brush: <><path d="M4 18c4 0 3-8 7-8s3 6 6 6" /><path d="M17 16l3-3" /></>,
  highlighter: <><path d="M4 18c4 0 3-8 7-8s3 6 6 6" /><path d="M5 20h14" /></>,

  // ── shapes: arrows ──
  arrowMarker: <><path d="M5 19L19 5" /><path d="M13 5h6v6" /></>,
  arrow: <><path d="M4 19L18 6" /><path d="M12 5h7v7" /></>,
  arrowUp: <><path d="M12 20V6M6 12l6-6 6 6" /></>,
  arrowDown: <><path d="M12 4v14M6 12l6 6 6-6" /></>,

  // ── shapes ──
  rect: <><rect x="4" y="6" width="16" height="12" rx="1" /></>,
  rotatedRectangle: <><path d="M3 14l7-8 11 4-7 8z" /></>,
  path: <><path d="M4 18l5-7 4 4 6-8" /><path d="M14 3h6v6" /><circle cx="4" cy="18" r="1.4" /></>,
  circle: <><circle cx="12" cy="12" r="7" /></>,
  ellipse: <><ellipse cx="12" cy="12" rx="8" ry="6" /></>,
  polyline: <><path d="M4 18l5-7 4 4 7-9" /><circle cx="4" cy="18" r="1.4" /><circle cx="9" cy="11" r="1.4" /><circle cx="13" cy="15" r="1.4" /><circle cx="20" cy="6" r="1.4" /></>,
  triangle: <><path d="M12 5l8 14H4z" /></>,
  arc: <><path d="M4 18a8 8 0 0116 0" /></>,
  curve: <><path d="M4 18c4-12 12 12 16-6" /></>,
  doubleCurve: <><path d="M4 18c4-12 12 12 16-6M4 14c4-8 12 8 16-4" /></>,

  // ── annotation ──
  text: <><path d="M5 6h14M12 6v13" /></>,
  note: <><path d="M4 4h16v12H9l-5 4z" /></>,
  priceNote: <><path d="M3 12h9l3-4h6v8h-6l-3-4" /><path d="M7 12h.01" /></>,
  pin: <><path d="M8 4h8l-2 6 3 3H7l3-3z" /><path d="M12 13v7" /></>,
  table: <><rect x="3" y="5" width="18" height="14" /><path d="M3 10h18M3 15h18M9 5v14M15 5v14" /></>,
  callout: <><path d="M4 5h16v10H12l-4 4v-4H4z" /></>,
  comment: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12h5" /></>,
  pricelabel: <><path d="M3 12h9l3-4h6v8h-6l-3-4" /></>,
  signpost: <><path d="M12 20V4M5 6h14l-3 4 3 4H5l3-4z" /></>,
  flagMark: <><path d="M6 21V4M6 5h11l-3 4 3 4H6" /></>,

  // ── icons ──
  iconSmiley: <><circle cx="12" cy="12" r="8.5" /><path d="M9 10h.01M15 10h.01" /><path d="M8.5 14a4.5 4.5 0 007 0" /></>,

  // ── options ──
  magnet: <><path d="M7 4v8a5 5 0 0010 0V4" /><path d="M7 8h4M13 8h4" /></>,
  stayInDrawingMode: <><path d="M4 16l9-9 3 3-9 9H4z" /><path d="M14 4l2-2 3 3-2 2" /><path d="M4 21h16" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 018 0v3" /></>,
  unlock: <><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 017-2.6" /></>,
  eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.5" /></>,
  eyeOff: <><path d="M2 12s3.5-6 10-6c2 0 3.7.6 5.1 1.4M22 12s-3.5 6-10 6c-2 0-3.7-.6-5.1-1.4" /><path d="M3 3l18 18" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /></>,
};

const Icon = ({ name, size = 28 }: { name: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[name] ?? ICONS.trend}
  </svg>
);

interface ToolDef {
  tool: DrawingTool;
  icon: string;
  /** The reference's own wording, sentence case. Never carries an instruction. */
  label: string;
  /** How to use it. Surfaced in `title`, never in the row's text. */
  hint?: string;
}

interface Section { heading?: string; tools: ToolDef[] }

interface GroupDef {
  id: string;
  /** The flyout's own name, and the strip's tooltip. */
  title: string;
  sections: Section[];
}

/**
 * The eight group cells, in the reference's rail order, with the reference's
 * own sections and member order inside each.
 *
 * ── What was wrong before ──────────────────────────────────────────────────
 *
 * The groups were right and almost everything inside them was not. The
 * flyouts were flat lists with no sections, ordered by nobody's logic; three
 * of the eight rail cells showed the wrong default tool (a ruler where the
 * reference has a position, a rectangle where it has a brush, an Anchored-VWAP
 * curve where it has a smiley); four tools were filed in the wrong family; and
 * six labels carried a trailing "— click points, double-click to finish" that
 * truncated with an ellipsis in a fixed-width menu. The first tool of each
 * group is its default AND its rail glyph, so a wrong first entry is a wrong
 * silhouette at rest — the thing rail muscle memory is entirely built on.
 *
 * ── Deliberately absent ────────────────────────────────────────────────────
 *
 * Six of the reference's rows are not here, because each is a feature of that
 * product rather than a drawing:
 *
 *   Demonstration cursor, Magic cursor  its presentation and pattern engines
 *   Ghost feed                          its synthetic-projection feature
 *   Image, Post, Idea                   its social/content uploads
 *
 * Everything else the reference offers in these flyouts is present.
 */
export const GROUPS: GroupDef[] = [
  {
    id: "cursors",
    title: "Cursors",
    sections: [{
      tools: [
        { tool: "cursor", icon: "cursor", label: "Cross" },
        { tool: "dot", icon: "dot", label: "Dot" },
        { tool: "arrowCursor", icon: "arrowCursor", label: "Arrow" },
        { tool: "eraser", icon: "eraser", label: "Eraser", hint: "Click a drawing to delete it" },
      ],
    }],
  },
  {
    id: "trend-line",
    title: "Trend tools",
    sections: [
      {
        tools: [
          { tool: "trend", icon: "trend", label: "Trendline" },
          { tool: "ray", icon: "ray", label: "Ray" },
          { tool: "infoline", icon: "infoline", label: "Info line" },
          { tool: "extended", icon: "extended", label: "Extended line" },
          { tool: "trendAngle", icon: "trendAngle", label: "Trend angle" },
          { tool: "hline", icon: "hline", label: "Horizontal line" },
          { tool: "hray", icon: "hray", label: "Horizontal ray" },
          { tool: "vline", icon: "vline", label: "Vertical line" },
          { tool: "crossline", icon: "crossline", label: "Crossline" },
        ],
      },
      {
        heading: "Channels",
        tools: [
          { tool: "parallel", icon: "parallel", label: "Parallel channel" },
          { tool: "regression", icon: "regression", label: "Regression trend" },
          { tool: "flatTopBottom", icon: "flatTopBottom", label: "Flat top/bottom" },
          { tool: "disjointChannel", icon: "disjointChannel", label: "Disjoint channel" },
        ],
      },
      {
        heading: "Pitchforks",
        tools: [
          { tool: "pitchfork", icon: "pitchfork", label: "Pitchfork" },
          { tool: "schiffPitchfork", icon: "schiffPitchfork", label: "Schiff pitchfork" },
          { tool: "modifiedSchiffPitchfork", icon: "modifiedSchiffPitchfork", label: "Modified Schiff pitchfork" },
          { tool: "insidePitchfork", icon: "insidePitchfork", label: "Inside pitchfork" },
        ],
      },
    ],
  },
  {
    id: "gann-and-fibonacci",
    title: "Gann and Fibonacci tools",
    sections: [
      {
        tools: [
          { tool: "fib", icon: "fib", label: "Fib retracement" },
          { tool: "fibext", icon: "fibext", label: "Trend-based fib extension" },
          { tool: "fibChannel", icon: "fibChannel", label: "Fib channel" },
          { tool: "fibTimeZone", icon: "fibTimeZone", label: "Fib time zone" },
          { tool: "fibSpeedResistanceFan", icon: "fibSpeedResistanceFan", label: "Fib speed resistance fan" },
          { tool: "trendFibTime", icon: "trendFibTime", label: "Trend-based fib time" },
          { tool: "fibCircles", icon: "fibCircles", label: "Fib circles" },
          { tool: "fibSpiral", icon: "fibSpiral", label: "Fib spiral" },
          { tool: "fibSpeedResistanceArcs", icon: "fibSpeedResistanceArcs", label: "Fib speed resistance arcs" },
          { tool: "fibWedge", icon: "fibWedge", label: "Fib wedge" },
          { tool: "pitchfan", icon: "pitchfan", label: "Pitchfan" },
        ],
      },
      {
        heading: "Gann",
        tools: [
          { tool: "gannBox", icon: "gannBox", label: "Gann box" },
          { tool: "gannSquareFixed", icon: "gannSquareFixed", label: "Gann square fixed" },
          { tool: "gannSquare", icon: "gannSquare", label: "Gann square" },
          { tool: "gannFan", icon: "gannFan", label: "Gann fan" },
        ],
      },
    ],
  },
  {
    id: "patterns",
    title: "Patterns",
    sections: [
      {
        tools: [
          { tool: "xabcd", icon: "xabcd", label: "XABCD pattern" },
          { tool: "cypher", icon: "cypher", label: "Cypher pattern" },
          { tool: "headAndShoulders", icon: "headAndShoulders", label: "Head and shoulders" },
          { tool: "abcdPattern", icon: "abcdPattern", label: "ABCD pattern" },
          { tool: "trianglePattern", icon: "trianglePattern", label: "Triangle pattern" },
          { tool: "threeDrives", icon: "threeDrives", label: "Three drives pattern" },
        ],
      },
      {
        heading: "Elliott waves",
        tools: [
          { tool: "elliottImpulse", icon: "elliottImpulse", label: "Elliott impulse wave (12345)" },
          { tool: "elliottCorrection", icon: "elliottCorrection", label: "Elliott correction wave (ABC)" },
          { tool: "elliottTriangle", icon: "elliottTriangle", label: "Elliott triangle wave (ABCDE)" },
          { tool: "elliottDoubleCombo", icon: "elliottDoubleCombo", label: "Elliott double combo wave (WXY)" },
          { tool: "elliottTripleCombo", icon: "elliottTripleCombo", label: "Elliott triple combo wave (WXYXZ)" },
        ],
      },
      {
        heading: "Cycles",
        tools: [
          { tool: "cyclicLines", icon: "cyclicLines", label: "Cyclic lines" },
          { tool: "timeCycles", icon: "timeCycles", label: "Time cycles" },
          { tool: "sineLine", icon: "sineLine", label: "Sine line" },
        ],
      },
    ],
  },
  {
    id: "prediction-and-measurement",
    title: "Forecasting and measurement tools",
    sections: [
      {
        tools: [
          { tool: "long", icon: "long", label: "Long position" },
          { tool: "short", icon: "short", label: "Short position" },
          { tool: "positionForecast", icon: "positionForecast", label: "Position forecast" },
          { tool: "barsPattern", icon: "barsPattern", label: "Bars pattern" },
          /*
           * `sector` sits under Forecasting because the live inventory read it
           * there, not because a sector is obviously a forecast. R2's own
           * correction flags this one row as the single place a mis-read would
           * move a shape into the wrong family; it is filed as measured and
           * should be re-read live before the next capture.
           */
          { tool: "sector", icon: "sector", label: "Sector" },
        ],
      },
      {
        heading: "Volume-based",
        tools: [
          { tool: "avwap", icon: "avwap", label: "Anchored VWAP", hint: "Click a bar to anchor" },
          {
            tool: "vprange", icon: "vprange", label: "Fixed range volume profile",
            hint: "Drag across the bars to profile",
          },
          {
            tool: "avprofile", icon: "avprofile", label: "Anchored volume profile",
            hint: "Click a bar to anchor",
          },
        ],
      },
      {
        heading: "Measurers",
        tools: [
          { tool: "pricerange", icon: "pricerange", label: "Price range" },
          { tool: "daterange", icon: "daterange", label: "Date range" },
          { tool: "datePriceRange", icon: "datePriceRange", label: "Date and price range" },
        ],
      },
    ],
  },
  {
    id: "geometric-shapes",
    title: "Geometric shapes",
    sections: [
      {
        tools: [
          { tool: "brush", icon: "brush", label: "Brush", hint: "Freehand" },
          { tool: "highlighter", icon: "highlighter", label: "Highlighter", hint: "Translucent freehand" },
        ],
      },
      {
        heading: "Arrows",
        tools: [
          { tool: "arrowMarker", icon: "arrowMarker", label: "Arrow marker" },
          { tool: "arrow", icon: "arrow", label: "Arrow" },
          { tool: "arrowUp", icon: "arrowUp", label: "Arrow mark up" },
          { tool: "arrowDown", icon: "arrowDown", label: "Arrow mark down" },
        ],
      },
      {
        heading: "Shapes",
        tools: [
          { tool: "rect", icon: "rect", label: "Rectangle" },
          { tool: "rotatedRectangle", icon: "rotatedRectangle", label: "Rotated rectangle" },
          { tool: "path", icon: "path", label: "Path", hint: "Click points, double-click to finish" },
          { tool: "circle", icon: "circle", label: "Circle" },
          { tool: "ellipse", icon: "ellipse", label: "Ellipse" },
          { tool: "polyline", icon: "polyline", label: "Polyline", hint: "Click points, double-click to finish" },
          { tool: "triangle", icon: "triangle", label: "Triangle" },
          { tool: "arc", icon: "arc", label: "Arc" },
          { tool: "curve", icon: "curve", label: "Curve" },
          { tool: "doubleCurve", icon: "doubleCurve", label: "Double curve" },
        ],
      },
    ],
  },
  {
    id: "annotation",
    title: "Annotation tools",
    sections: [{
      tools: [
        { tool: "text", icon: "text", label: "Text" },
        { tool: "note", icon: "note", label: "Note" },
        { tool: "priceNote", icon: "priceNote", label: "Price note" },
        { tool: "pin", icon: "pin", label: "Pin" },
        { tool: "table", icon: "table", label: "Table" },
        { tool: "callout", icon: "callout", label: "Callout" },
        { tool: "comment", icon: "comment", label: "Comment" },
        { tool: "pricelabel", icon: "pricelabel", label: "Price label" },
        { tool: "signpost", icon: "signpost", label: "Signpost" },
        { tool: "flagMark", icon: "flagMark", label: "Flag mark" },
      ],
    }],
  },
  {
    /*
     * The eighth cell is a picker, not a menu.
     *
     * Its one tool takes a single anchor and paints whatever glyph the grid
     * last armed, so the whole group is one `ToolDef` and the flyout is a
     * `.tvc-popover` grid rather than 200 rows nobody would scroll.
     */
    id: "icons",
    title: "Icons",
    sections: [{ tools: [{ tool: "icon", icon: "iconSmiley", label: "Icon" }] }],
  },
];

/**
 * The two cells that are one tool each, between the groups and the magnet.
 *
 * They are declared here rather than inline so the rail's taxonomy test can
 * still say "every declared tool is reachable exactly once" — `ruler` used to
 * be the first entry of the forecasting group, which is why that cell showed a
 * ruler where the reference shows a position.
 */
export const SINGLES: { id: string; tool: DrawingTool; icon: string; label: string }[] = [
  { id: "measure", tool: "ruler", icon: "ruler", label: "Measure" },
  { id: "zoom-in", tool: "zoom", icon: "zoomIn", label: "Zoom in" },
];


/** Which keyboard action arms which tool, for the flyout's key-cap column. */
const TOOL_ACTION: Partial<Record<DrawingTool, ShortcutAction>> = {
  cursor: "tool:cursor",
  trend: "tool:trend",
  hline: "tool:horizontal",
  vline: "tool:vertical",
  fib: "tool:fib",
  text: "tool:text",
};

/**
 * The chord the reference prints on a row, read off `BINDINGS`.
 *
 * The ⌥ variant only, because that is what the reference shows and because
 * the bare letters are already in the shortcuts sheet and the palette — a row
 * that printed both would be twice as wide for no extra information.
 */
function altBinding(tool: DrawingTool): Binding | undefined {
  const action = TOOL_ACTION[tool];
  if (!action) return undefined;
  return BINDINGS.find((b) => b.action === action && b.alt === true);
}

function keyCap(binding: Binding, mac: boolean): string {
  const parts: string[] = [];
  if (binding.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (binding.alt) parts.push(mac ? "⌥" : "Alt");
  if (binding.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join(mac ? "" : "+");
}

export type MagnetMode = "off" | "weak" | "strong";
export type LockScope = "drawings" | "indicators" | "all";
export type HideScope = "drawings" | "indicators" | "positions" | "all";
export type RemoveScope = "drawings" | "indicators" | "all";

interface OptionSwitch { on: boolean; onChange: (value: boolean) => void }

/**
 * The left icon rail. Each group remembers the variant you last used, so the
 * rail shows that icon and a hover-revealed edge strip opens the rest — the
 * reference's behaviour, and the reason the strip's `aria-label` is stable.
 */
export function DrawingToolbar({
  tool, onTool, magnet, onMagnet, stayInDrawingMode, onStayInDrawingMode,
  locked, onLocked, hidden, onHidden, onDeleteAll, count,
  magnetMode, onMagnetMode,
  lockScope, onLockScope, hideScope, onHideScope,
  indicatorCount = 0, onRemove, optionSwitches,
  floating = false, onClose,
}: {
  tool: DrawingTool;
  onTool: (t: DrawingTool) => void;
  magnet: boolean;
  onMagnet: (v: boolean) => void;
  /** Keep the armed tool after a drawing is finished, instead of dropping to the cursor. */
  stayInDrawingMode: boolean;
  onStayInDrawingMode: (v: boolean) => void;
  locked: boolean;
  onLocked: (v: boolean) => void;
  hidden: boolean;
  onHidden: (v: boolean) => void;
  onDeleteAll: () => void;
  count: number;
  /** See the wiring note at the top of this file. All optional. */
  magnetMode?: MagnetMode;
  onMagnetMode?: (mode: MagnetMode) => void;
  lockScope?: "none" | LockScope;
  onLockScope?: (scope: LockScope) => void;
  hideScope?: "none" | HideScope;
  onHideScope?: (scope: HideScope) => void;
  indicatorCount?: number;
  onRemove?: (scope: RemoveScope) => void;
  optionSwitches?: {
    valuesTooltip?: OptionSwitch;
    snapToIndicators?: OptionSwitch;
    alwaysRemoveLocked?: OptionSwitch;
  };
  /** Phone drawer: the rail floats over the chart instead of taking a column. */
  floating?: boolean;
  onClose?: () => void;
}) {
  const [active, setActive] = useState<Record<string, DrawingTool>>(() =>
    Object.fromEntries(GROUPS.map((g) => [g.id, g.sections[0]!.tools[0]!.tool]))
  );
  const [favourites, setFavourites] = useState<DrawingTool[]>([]);
  // After mount, so the server-rendered markup and the first client render
  // agree; the platform is only knowable in the browser.
  const [mac, setMac] = useState(false);
  useEffect(() => { setMac(isMacPlatform()); }, []);
  /*
   * The tool flyout, through the same registry as every other popover.
   *
   * It carries WHICH group is open rather than a boolean, so the registry
   * holds the open/closed half and this holds the identity — opening a
   * different group is still one state change, and opening any of them still
   * closes the chart-type and timeframe menus.
   */
  const [flyoutOpen, setFlyoutOpen] = useExclusivePopover("drawing-flyout");
  const [flyoutGroup, setFlyoutGroup] = useState<string | null>(null);
  const flyout = flyoutOpen ? flyoutGroup : null;
  const setFlyout = useCallback((id: string | null) => {
    setFlyoutGroup(id);
    setFlyoutOpen(id !== null);
  }, [setFlyoutOpen]);
  const railRef = useRef<HTMLDivElement>(null);

  const magnetOn = magnetMode ? magnetMode !== "off" : magnet;

  // TradingView keeps drawing-tool favourites across chart reloads. Keep the
  // same muscle-memory affordance locally without coupling it to drawings or
  // server state (favourites are a device preference, not chart data).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAWING_FAVOURITES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const known = new Set(GROUPS.flatMap((g) => g.sections.flatMap((s) => s.tools.map((t) => t.tool))));
        setFavourites(parsed.filter((v): v is DrawingTool => typeof v === "string" && known.has(v as DrawingTool)));
      }
    } catch { /* unavailable storage is a valid first-run state */ }
  }, []);

  const toggleFavourite = useCallback((candidate: DrawingTool) => {
    setFavourites((current) => {
      const next = current.includes(candidate)
        ? current.filter((t) => t !== candidate)
        : [...current, candidate];
      try { window.localStorage.setItem(DRAWING_FAVOURITES_KEY, JSON.stringify(next)); } catch { /* best effort */ }
      return next;
    });
  }, []);

  // Remember which variant of a group is in use, so the rail icon follows it.
  useEffect(() => {
    const group = GROUPS.find((g) => g.sections.some((s) => s.tools.some((t) => t.tool === tool)));
    if (group) setActive((a) => ({ ...a, [group.id]: tool }));
  }, [tool]);

  useEffect(() => {
    if (!flyout) return;
    const onDown = (e: MouseEvent) => {
      if (!railRef.current?.contains(e.target as Node)) setFlyout(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [flyout, setFlyout]);

  /*
   * A rail button is the full width of the rail (FC2-M1, FC2-L1).
   *
   * 52x38 and square-cornered, like TradingView's, rather than a 36px pill
   * inset in a 48px column: a drawing tool is aimed at from muscle memory
   * dozens of times an hour, and an inset pill throws away a third of the hit
   * area it could have had for the sake of looking like a web control. No
   * hover transition, for the reason given on the toolbar.
   *
   * Ink is full at rest in BOTH states: the reference draws every rail glyph
   * at #dbdbdb and lets the 34×34 chip say which one is armed. Dimming the
   * unselected ones made the whole column read as secondary chrome.
   */
  const btn = (): string =>
    "tvc-control flex h-[38px] w-[52px] items-center justify-center text-ink";

  /** The hover-revealed edge strip that opens a cell's flyout. */
  const strip = (id: string, title: string) => (
    <button
      onClick={() => setFlyout(flyout === id ? null : id)}
      title={title}
      aria-label={`More ${id} tools`}
      aria-expanded={flyout === id}
      data-open={flyout === id ? "true" : undefined}
      className={
        "absolute right-0 top-[2px] flex h-[34px] w-[11px] items-center justify-center "
        + "text-ink opacity-0 transition-none group-hover:opacity-100 focus-visible:opacity-100 "
        + "data-[open=true]:opacity-100"
      }
    >
      <svg viewBox="0 0 4 7" width="4" height="7" fill="none" stroke="currentColor"
        strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {flyout === id ? <path d="M3.2 0.8L0.8 3.5l2.4 2.7" /> : <path d="M0.8 0.8l2.4 2.7-2.4 2.7" />}
      </svg>
    </button>
  );

  const menuClass = "absolute left-[53px] -top-[6px] z-50 max-h-[calc(100vh-120px)] w-max overflow-y-auto tvc-menu";

  /** One 40px tool row: icon, name, the reference's ⌥ cap, a hover-only star. */
  const toolRow = (groupId: string, t: ToolDef) => {
    const starred = favourites.includes(t.tool);
    const binding = altBinding(t.tool);
    return (
      <div key={t.tool} data-active={t.tool === tool ? "true" : undefined}
        className="tvc-menu-row group/row text-ink">
        <button
          onClick={() => {
            onTool(t.tool);
            setActive((a) => ({ ...a, [groupId]: t.tool }));
            setFlyout(null);
          }}
          title={t.hint ?? t.label}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-sm"
        >
          <Icon name={t.icon} size={28} />
          <span data-tool-label className="whitespace-nowrap">{t.label}</span>
        </button>
        {binding && (
          <kbd className="mr-1 shrink-0 whitespace-nowrap px-1 text-[11px] text-ink-faint">
            {keyCap(binding, mac)}
          </kbd>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); toggleFavourite(t.tool); }}
          aria-label={starred ? "Remove from favourites" : "Add to favourites"}
          aria-pressed={starred}
          data-starred={starred ? "true" : undefined}
          title={starred ? "Remove from favourites" : "Add to favourites"}
          className={
            "mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded text-[15px] "
            + "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 "
            + "data-[starred=true]:opacity-100 "
            + (starred ? "text-warn" : "text-ink-faint hover:text-ink")
          }
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={starred ? "currentColor" : "none"}
            stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.8z" />
          </svg>
        </button>
      </div>
    );
  };

  /** A 32px option row — the reference's compact scope menus. */
  const optionRow = (key: string, label: string, on: boolean, run: () => void) => (
    <button
      key={key}
      onClick={() => { run(); setFlyout(null); }}
      aria-label={label}
      aria-pressed={on}
      data-active={on ? "true" : undefined}
      className="tvc-menu-row whitespace-nowrap px-3 text-left text-sm text-ink"
    >
      {label}
    </button>
  );

  /**
   * A footer switch, rendered only when the page passed a handler for it.
   *
   * The reference ends three of these flyouts with one. A switch with nothing
   * behind it would flip, persist nothing and change nothing — the failure
   * this campaign has spent its whole length removing — so an unwired one is
   * absent rather than decorative. See the wiring note at the top of the file.
   */
  const footerSwitch = (label: string, option?: OptionSwitch) => option ? (
    <button
      role="switch"
      aria-checked={option.on}
      onClick={() => option.onChange(!option.on)}
      className="tvc-menu-row justify-between gap-6 whitespace-nowrap px-3 text-left text-sm text-ink"
    >
      <span>{label}</span>
      {/* The same switch the sync menu and the study settings draw, so a
          continuing state looks the same wherever the product offers one. */}
      <span
        aria-hidden="true"
        // accent-is-meaning: a SWITCH track.
        className={`relative h-[18px] w-[32px] shrink-0 rounded-full ${
          option.on ? "bg-accent" : "bg-border"
        }`}
      >
        <span
          className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white ${
            option.on ? "left-[16px]" : "left-[2px]"
          }`}
        />
      </span>
    </button>
  ) : null;

  const sep = (
    <div className="my-[6px] h-px w-9 shrink-0" style={{ background: "var(--ts-rail-separator)" }} />
  );

  const removeRows = useMemo(() => {
    const rows: { key: string; label: string; run: () => void }[] = [];
    rows.push({
      key: "drawings",
      label: `Remove ${count} drawing${count === 1 ? "" : "s"}`,
      run: () => (onRemove ? onRemove("drawings") : onDeleteAll()),
    });
    if (onRemove) {
      rows.push({
        key: "indicators",
        label: `Remove ${indicatorCount} indicator${indicatorCount === 1 ? "" : "s"}`,
        run: () => onRemove("indicators"),
      });
      rows.push({
        key: "all",
        label: `Remove ${count} drawing${count === 1 ? "" : "s"} & ${indicatorCount} indicator${indicatorCount === 1 ? "" : "s"}`,
        run: () => onRemove("all"),
      });
    }
    return rows;
  }, [count, indicatorCount, onRemove, onDeleteAll]);

  return (
    <div
      ref={railRef}
      data-drawing-rail="true"
      className={`relative flex w-[52px] shrink-0 flex-col items-center border-r border-border bg-surface pt-[10px] ${
        // Floating: scrolls independently and casts a shadow so it reads as a
        // layer above the chart rather than part of it.
        floating ? "h-full overflow-y-auto shadow-2xl" : ""
      }`}
    >
      {floating && onClose && (
        <button
          onClick={onClose}
          aria-label="Close drawing tools"
          className="mb-1 flex h-[38px] w-[52px] items-center justify-center text-ink-faint hover:bg-state-hover hover:text-ink"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 4l16 16M20 4L4 20" />
          </svg>
        </button>
      )}
      {GROUPS.map((group) => {
        const tools = group.sections.flatMap((s) => s.tools);
        const current = tools.find((t) => t.tool === active[group.id]) ?? tools[0]!;
        const groupOn = tools.some((t) => t.tool === tool);
        const isIcons = group.id === "icons";
        return (
          <div key={group.id} className="group relative">
            <button
              onClick={() => onTool(current.tool)}
              onContextMenu={(e) => { e.preventDefault(); setFlyout(group.id); }}
              className={btn()}
              /*
               * A tool button is a toggle, and until now the only thing that
               * said which one was armed was a colour. That is invisible to a
               * screen reader and to anything that is not a human eye — the
               * timeframe strip has said `aria-pressed` all along, and this is
               * the same control in a different rail.
               */
              aria-pressed={groupOn}
              /*
               * And a NAME, not only a state. These are icon-only buttons with
               * no text, so their accessible name fell through to `title` —
               * the weakest source in the name algorithm, and the only control
               * family in this product relying on it.
               */
              aria-label={current.label}
              title={current.label}
            >
              <Icon name={current.icon} />
            </button>
            {strip(group.id, group.title)}
            {flyout === group.id && (isIcons ? (
              <div className="absolute left-[53px] -top-[6px] z-50 max-h-[calc(100vh-120px)] w-[354px] overflow-y-auto tvc-popover p-[6px]">
                <div className="grid grid-cols-8 gap-[2px]">
                  {ICON_GLYPHS.map((glyph) => (
                    <button
                      key={glyph}
                      onClick={() => { armIconGlyph(glyph); onTool("icon"); setFlyout(null); }}
                      aria-label={`Icon ${glyph}`}
                      /*
                        Not `.tvc-control`: the rail scopes that chip to
                        `inset: 2px 9px` so a 52px cell reads as a 34px square,
                        and a 40px picker cell inside the rail would inherit a
                        22px-wide chip. The grammar's own hover ground, at this
                        cell's own size.
                      */
                      className="flex h-[40px] w-[40px] items-center justify-center rounded text-[20px] leading-none hover:bg-state-hover"
                    >
                      <span aria-hidden="true">{glyph}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className={menuClass}>
                {group.sections.map((section, i) => (
                  <Fragment key={section.heading ?? `section-${i}`}>
                    {i > 0 && <div className="tvc-menu-sep" />}
                    {section.heading && <div className="tvc-menu-heading">{section.heading}</div>}
                    {section.tools.map((t) => toolRow(group.id, t))}
                  </Fragment>
                ))}
                {group.id === "cursors" && footerSwitch(
                  "Values tooltip on long press", optionSwitches?.valuesTooltip)}
              </div>
            ))}
          </div>
        );
      })}

      {sep}

      {SINGLES.map((single) => (
        <button
          key={single.id}
          onClick={() => onTool(single.tool)}
          className={btn()}
          aria-pressed={tool === single.tool}
          aria-label={single.label}
          title={single.label}
        >
          <Icon name={single.icon} />
        </button>
      ))}

      {sep}

      <div className="group relative">
        <button
          onClick={() => (onMagnetMode
            ? onMagnetMode(magnetOn ? "off" : (magnetMode === "strong" ? "strong" : "weak"))
            : onMagnet(!magnet))}
          className={btn()} aria-pressed={magnetOn}
          aria-label={magnetOn ? "Turn the magnet off" : "Turn the magnet on"}
          title={magnetOn ? "Magnet on — anchors snap to OHLC" : "Magnet off"}>
          <Icon name="magnet" />
        </button>
        {strip("magnet", "Magnets")}
        {flyout === "magnet" && (
          <div className={menuClass}>
            {/*
              Both rows act with or without `onMagnetMode`: without it they turn
              the one magnet this build has on, which is the weak one's
              behaviour, and the strong row is the same switch until the page
              owns the mode. Neither is inert.
            */}
            {optionRow("weak", "Weak magnet", magnetMode === "weak",
              () => (onMagnetMode ? onMagnetMode("weak") : onMagnet(true)))}
            {optionRow("strong", "Strong magnet", magnetMode === "strong",
              () => (onMagnetMode ? onMagnetMode("strong") : onMagnet(true)))}
            {footerSwitch("Snap to indicators", optionSwitches?.snapToIndicators)}
          </div>
        )}
      </div>

      <button onClick={() => onStayInDrawingMode(!stayInDrawingMode)}
        className={btn()} aria-pressed={stayInDrawingMode}
        aria-label={stayInDrawingMode ? "Turn off keep drawing" : "Keep drawing"}
        title={stayInDrawingMode
          ? "Keeping the tool armed after each drawing"
          : "Keep drawing"}>
        <Icon name="stayInDrawingMode" />
      </button>

      <div className="group relative">
        <button onClick={() => (onLockScope ? onLockScope("drawings") : onLocked(!locked))}
          className={btn()} aria-pressed={lockScope ? lockScope !== "none" : locked}
          aria-label={locked ? "Unlock all drawings" : "Lock drawings and indicators"}
          title={locked ? "Drawings locked" : "Lock drawings and indicators"}>
          <Icon name={(lockScope ? lockScope !== "none" : locked) ? "lock" : "unlock"} />
        </button>
        {strip("lock", "Lock options")}
        {flyout === "lock" && (
          <div className={`${menuClass} tvc-menu--compact`}>
            {optionRow("lock-drawings", "Lock drawings", lockScope === "drawings" || (!lockScope && locked),
              () => (onLockScope ? onLockScope("drawings") : onLocked(!locked)))}
            {/* Indicators and "all" need a lock the page does not own yet — see
                the wiring note. An unwired row would lock nothing, silently. */}
            {onLockScope && optionRow("lock-indicators", "Lock indicators",
              lockScope === "indicators", () => onLockScope("indicators"))}
            {onLockScope && optionRow("lock-all", "Lock all",
              lockScope === "all", () => onLockScope("all"))}
          </div>
        )}
      </div>

      <div className="group relative">
        <button onClick={() => (onHideScope ? onHideScope("drawings") : onHidden(!hidden))}
          className={btn()} aria-pressed={hideScope ? hideScope !== "none" : hidden}
          aria-label={hidden ? "Show all drawings" : "Hide all drawings"}
          title={hidden ? "Drawings hidden" : "Hide all drawings"}>
          <Icon name={(hideScope ? hideScope !== "none" : hidden) ? "eyeOff" : "eye"} />
        </button>
        {strip("hide", "Hide options")}
        {flyout === "hide" && (
          <div className={`${menuClass} tvc-menu--compact`}>
            {optionRow("hide-drawings", "Hide drawings", hideScope === "drawings" || (!hideScope && hidden),
              () => (onHideScope ? onHideScope("drawings") : onHidden(!hidden)))}
            {onHideScope && optionRow("hide-indicators", "Hide indicators",
              hideScope === "indicators", () => onHideScope("indicators"))}
            {onHideScope && optionRow("hide-positions", "Hide positions and orders",
              hideScope === "positions", () => onHideScope("positions"))}
            {onHideScope && optionRow("hide-all", "Hide all",
              hideScope === "all", () => onHideScope("all"))}
          </div>
        )}
      </div>

      {sep}

      <div className="group relative">
        {/*
          Never disabled, and no count label beneath it.
          The cell used to drop to 0.3 opacity on an empty chart — the only
          dimmed control in the column, and the reference dims nothing here —
          and grew a `12` under it that no other cell has.
        */}
        <button
          onClick={() => (onRemove ? onRemove("drawings") : onDeleteAll())}
          className={`${btn()} hover:!text-down`}
          aria-label="Remove objects"
          title="Remove objects"
        >
          <Icon name="trash" />
        </button>
        {strip("remove", "Remove options")}
        {flyout === "remove" && (
          <div className={`${menuClass} tvc-menu--compact`}>
            {removeRows.map((row) => optionRow(row.key, row.label, false, row.run))}
            {footerSwitch("Always remove locked drawings", optionSwitches?.alwaysRemoveLocked)}
          </div>
        )}
      </div>
    </div>
  );
}
