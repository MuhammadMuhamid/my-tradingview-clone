"use client";
import {
  Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { BINDINGS, isMacPlatform, type Binding, type ShortcutAction } from "@/lib/shortcuts";
import {
  armIconGlyph, EMOJI_CATEGORIES, OUTLINE_CATEGORIES, type DrawingTool,
} from "@/lib/drawings";

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
 * Icon set — 28-unit stroked paths, drawn at 28px.
 *
 * ── Weight and alignment (R2b-02) ──────────────────────────────────────────
 *
 * These were a 24-unit box rendered at 28px with `strokeWidth="0.9"`: a 1.05px
 * line on a fractional grid, so every horizontal and vertical straddled two
 * device pixels and landed as two half-lit greys instead of one lit pixel. The
 * rail sampled at a peak luminance of 140 where the reference peaks at 219 —
 * the armed Cross was the DIMMEST glyph in the column, inverting the emphasis
 * the selected chip exists to carry.
 *
 * The box is now 28 units at 28px (1 unit = 1 px) and every axis-aligned
 * stroke sits on a half-unit, so a 1px-wide stroke fills exactly one pixel
 * column or row. The stroke is 1.25 rather than 1.0 — the allowance R2b-02
 * gives "where a 1px hairline reads too light" — because a 1.0 stroke on a 45°
 * diagonal covers only ~0.71 of a pixel and tops out near 190; at 1.25 the
 * diagonal core is fully covered and reaches 219, which is what the reference
 * shows (a `.#.` core with a faint halo, not `+++`).
 *
 * Rest ink is full `text-ink` for the same reason — the selected state is
 * carried by the 34×34 chip, as it is there, not by making everything else
 * dimmer.
 *
 * ── Silhouettes (R2b-01) ───────────────────────────────────────────────────
 *
 * Sampled from the reference at 1440×900 dark and redrawn here on the 28-unit
 * grid, in our own geometry: the fib dots sit at the top-right and bottom-left
 * ENDS (they were mirrored); XABCD is a closed five-node bow-tie with the X–B
 * and A–C crossing strokes (it was an open zigzag); Long/Short are two rails
 * with end dots and an L bracket (they were a 2×2 table); Brush is a brush
 * head with a paint stroke (it was a sine squiggle); Magnet is a horseshoe
 * with two rectangular pole caps (it was a cup); Keep-drawing is a pencil with
 * a padlock badge (it was a pencil on a baseline); Hide is an eye with a
 * pencil badge at its lower right (it was a plain eye); and the flyout rows —
 * Info line, Trend angle, Parallel channel, Regression trend, Flat top/bottom,
 * Disjoint channel and the four pitchforks — carry the reference's nodal
 * silhouettes rather than the simplified line-and-dot versions.
 *
 * ── One silhouette per tool ────────────────────────────────────────────────
 *
 * Thirty-five tools used to share a glyph with another tool: every Gann box
 * wore the rectangle, every harmonic pattern wore the polyline, three
 * Fibonacci variants wore the retracement. A rail is aimed at from muscle
 * memory, and muscle memory is shape memory — two tools with one shape are two
 * tools you have to read the label of. Each one below is our own geometry
 * describing what the tool DOES; none of it is traced from anybody's artwork.
 *
 * A node RING is `r="2"` — the reference's anchors sample 5px across — and a
 * line that ends at an anchor stops at the ring's edge rather than running
 * through it.
 */
const ICONS: Record<string, JSX.Element> = {
  // ── cursors ──
  cursor: <path d="M14.5 3v7.5M14.5 18.5V26M3 14.5h7.5M18.5 14.5H26" />,
  dot: <circle cx="14" cy="14" r="3.5" fill="currentColor" stroke="none" />,
  arrowCursor: <path d="M8.5 4l12.5 9.6-6 1.4 2.6 7.2-2.9 1.1-2.5-7.3-3.7 4.3z" />,
  eraser: <><path d="M5 18.5l8.5-8.5 7 7-4.5 4.5H9.5z" /><path d="M3.5 24.5h21" /></>,

  // ── trend: lines ──
  trend: <><circle cx="21.5" cy="5.5" r="2" /><circle cx="6.5" cy="22.5" r="2" /><path d="M8 21L20 7" /></>,
  ray: <><circle cx="6.5" cy="21.5" r="2" /><circle cx="14.5" cy="13.5" r="2" /><path d="M8 20l5-5M16 12l8.5-8.5" /></>,
  infoline: <><circle cx="22.5" cy="5.5" r="2" /><circle cx="5.5" cy="22.5" r="2" /><path d="M7 21L21 7" /><rect x="16.5" y="17.5" width="9" height="7" rx="1" /></>,
  extended: <><circle cx="17.5" cy="10.5" r="2" /><circle cx="10.5" cy="17.5" r="2" /><path d="M3.5 24.5L9 19M12 16l4-4M19 9l5.5-5.5" /></>,
  trendAngle: <><circle cx="22.5" cy="5.5" r="2" /><circle cx="5.5" cy="22.5" r="2" /><path d="M7 21L21 7" /><path d="M7.5 22.5h16" /><path d="M13.5 22.5A8 8 0 0 0 11.2 16.8" /></>,
  hline: <><path d="M3 14.5h9.5M16.5 14.5H25" /><circle cx="14.5" cy="14.5" r="2" /></>,
  hray: <><circle cx="5.5" cy="14.5" r="2" /><path d="M8 14.5h17" /></>,
  vline: <><path d="M14.5 3v9.5M14.5 16.5V25" /><circle cx="14.5" cy="14.5" r="2" /></>,
  crossline: <><path d="M3 14.5h9.5M16.5 14.5H25M14.5 3v9.5M14.5 16.5V25" /><circle cx="14.5" cy="14.5" r="2" /></>,

  // ── trend: channels ──
  // Two FULL-LENGTH parallels: the third anchor rides the second line, which
  // is the whole gesture. They used to be two 14px stubs.
  parallel: <><circle cx="19.5" cy="5.5" r="2" /><circle cx="5.5" cy="19.5" r="2" /><circle cx="17.5" cy="17.5" r="2" /><path d="M7 18L18 7" /><path d="M10 25l6-6M19 16l6-6" /></>,
  // A slanted BAND with a median through it: what a regression channel is.
  // It was a line with five dots, which is a scatter plot.
  regression: <><path d="M5.5 10.5L21.5 2.5M5.5 24.5L21.5 16.5" /><path d="M7.3 16.6L19.7 10.4" /><path d="M5.5 10.5v14M21.5 2.5v14" /><circle cx="5.5" cy="17.5" r="2" /><circle cx="21.5" cy="9.5" r="2" /></>,
  // One sloped edge, one FLAT edge, four anchors — the difference from a
  // channel, stated in the silhouette.
  flatTopBottom: <><circle cx="22.5" cy="5.5" r="2" /><circle cx="5.5" cy="13.5" r="2" /><circle cx="5.5" cy="22.5" r="2" /><circle cx="22.5" cy="22.5" r="2" /><path d="M7.4 12.7L20.6 6.3" /><path d="M7.5 22.5h13" /></>,
  disjointChannel: <><circle cx="22.5" cy="3.5" r="2" /><circle cx="5.5" cy="10.5" r="2" /><circle cx="5.5" cy="17.5" r="2" /><circle cx="22.5" cy="24.5" r="2" /><path d="M7.4 9.8L20.6 4.2M7.4 18.2L20.6 23.8" /></>,

  // ── trend: pitchforks ──
  // Three tines on a base bar, as the reference draws all four. They were one
  // diagonal with a single prong, which is not a fork.
  pitchfork: <><path d="M6 12l10 10" /><path d="M6 12l9-9M11 17l9-9M16 22l9-9" /><path d="M11 17l-7 7" /></>,
  // Schiff: the median springs from the FIRST anchor, not the bar's middle.
  schiffPitchfork: <><path d="M6 12l10 10" /><path d="M6 12l9-9M11 17l9-9M16 22l9-9" /><path d="M6 12l-2.5 11" /><circle cx="6" cy="12" r="1.6" /></>,
  modifiedSchiffPitchfork: <><path d="M6 12l10 10" /><path d="M6 12l9-9M11 17l9-9M16 22l9-9" /><path d="M8.5 14.5L4 19l1.5 5" /><circle cx="8.5" cy="14.5" r="1.6" /></>,
  insidePitchfork: <><path d="M8 13l8 8" /><path d="M8 13l6-6M12 17l6-6M16 21l6-6" /><path d="M12 17l-7.5 7.5" /><circle cx="12" cy="17" r="1.6" /></>,

  // ── fibonacci ──
  // Dots at the RIGHT end of an upper level and the LEFT end of a lower one,
  // which is the way the drag runs. They were mirrored.
  fib: <><path d="M3 4.5h22M3 16.5h22" /><path d="M3 10.5h17.5" /><circle cx="22.5" cy="10.5" r="2" /><path d="M7.5 22.5h17.5" /><circle cx="5.5" cy="22.5" r="2" /></>,
  fibext: <><path d="M3 21.5h22M3 14.5h22M3 7.5h22" /><path d="M7 25L15 3" /></>,
  // Levels that run PARALLEL to a slope rather than flat.
  fibChannel: <><path d="M3.5 19.5L17.5 5.5M7.5 23.5L21.5 9.5M11.5 25.5L25.5 11.5" /><circle cx="3.5" cy="19.5" r="1.6" /></>,
  // Verticals at Fibonacci distances in TIME.
  fibTimeZone: <path d="M3.5 4v20M6.5 4v20M10.5 4v20M16.5 4v20M24.5 4v20" />,
  // Rays fanning from one corner.
  fibSpeedResistanceFan: <><path d="M4.5 23.5L23.5 4.5M4.5 23.5l19 7M4.5 23.5l19-15M4.5 23.5h20" /><circle cx="4.5" cy="23.5" r="1.6" /></>,
  // Verticals raised off a sloped base: time, measured along a trend.
  trendFibTime: <><path d="M3.5 23.5L24.5 9.5" /><path d="M7.5 21v4M12.5 17.5v7.5M19.5 12.5v12.5" /></>,
  fibCircles: <><circle cx="14" cy="18.5" r="3.5" /><circle cx="14" cy="18.5" r="7.5" /><path d="M14 18.5L23 7" /></>,
  fibSpiral: <path d="M15 15a2.3 2.3 0 1 0-2.3-2.3 4.6 4.6 0 1 0 7 3.5 8 8 0 1 1-10.4-5.8" />,
  fibSpeedResistanceArcs: <><path d="M4.5 23.5a6 6 0 0 1 6-6M4.5 23.5a12 12 0 0 1 12-12M4.5 23.5a18 18 0 0 1 18-18" /><circle cx="4.5" cy="23.5" r="1.6" /></>,
  fibWedge: <><path d="M4.5 23.5L23.5 5.5" /><path d="M4.5 23.5h19" /><path d="M4.5 23.5a12 12 0 0 0 8.4-3.5M4.5 23.5a18 18 0 0 0 13-6" /></>,
  // A fan of medians, rather than one.
  pitchfan: <><path d="M4.5 23.5l19-16.5M4.5 23.5l17-2.5M4.5 23.5l12-12M4.5 23.5l7 1" /><circle cx="4.5" cy="23.5" r="1.6" /></>,

  // ── gann ──
  gannBox: <><rect x="4.5" y="5.5" width="19" height="17" /><path d="M4.5 22.5l19-17M4.5 5.5l19 17" /></>,
  gannSquareFixed: <><rect x="5.5" y="5.5" width="17" height="17" /><path d="M5.5 22.5l17-17" /><path d="M5.5 13.5h17M13.5 5.5v17" /></>,
  gannSquare: <><rect x="4.5" y="4.5" width="19" height="19" /><path d="M4.5 23.5l19-19" /><path d="M4.5 23.5l19-9.5M4.5 23.5l9.5-19" /></>,
  gannFan: <path d="M4.5 23.5L23.5 4.5M4.5 23.5l19 5M4.5 23.5l19-12M4.5 23.5l12-19M4.5 23.5l5-19" />,

  // ── patterns: chart ──
  // Five nodes and the crossing X–B / A–C strokes: a closed bow-tie, not the
  // open "M" zigzag this used to draw.
  xabcd: <>
    <circle cx="8.5" cy="5.5" r="2" /><circle cx="20.5" cy="6.5" r="2" />
    <circle cx="11.5" cy="12.5" r="2" /><circle cx="22.5" cy="19.5" r="2" />
    <circle cx="4.5" cy="22.5" r="2" />
    <path d="M8 7.5L5 20.5M20.8 8.5l1.4 9" />
    <path d="M9.3 7.4l1.4 3.2M13.3 13.6l7.4 4.8" />
    <path d="M18.8 7.6l-5.6 3.8M10.1 14.2L5.9 20.8" />
  </>,
  cypher: <><path d="M4.5 22.5l6-13 4.5 10.5 4.5-7 4 6" /><path d="M10.5 9.5l9.5 9.5" /></>,
  headAndShoulders: <><path d="M3.5 21l3.5-6 3.5 3.5 3.5-10.5 3.5 10.5 3.5-3.5 3.5 6" /><path d="M7 18.5h14" /></>,
  abcdPattern: <><circle cx="4.5" cy="21.5" r="1.8" /><circle cx="10.5" cy="11.5" r="1.8" /><circle cx="15.5" cy="17.5" r="1.8" /><circle cx="22.5" cy="6.5" r="1.8" /><path d="M5.5 19.8l4-6.6M11.6 13l2.8 3.4M16.7 15.9l4.6-7.3" /></>,
  trianglePattern: <path d="M3.5 6.5l21 7-21 7z" />,
  threeDrives: <path d="M3.5 22.5l3.5-4.5 2.5 3.5 3.5-7 2.5 4.5 3.5-8 2.5 4.5 3.5-7" />,

  // ── patterns: elliott ──
  elliottImpulse: <><path d="M3.5 23.5l3.5-7 2.5 3.5 4.5-10.5 2.5 4.5 4.5-9.5" /><path d="M10.5 6.5h.01M17 4.5h.01" /></>,
  elliottCorrection: <><path d="M4.5 6.5l4.5 9.5 4.5-6 4.5 9.5" /><path d="M23.5 21V10" /></>,
  elliottTriangle: <><path d="M3.5 13.5l4.5 7 4.5-10.5 4.5 8 4.5-6" /><path d="M3.5 13.5h19" /></>,
  elliottDoubleCombo: <path d="M3.5 8l4.5 9.5 3.5-6 3.5 8 3.5-7 5.5 7" />,
  elliottTripleCombo: <path d="M2.5 8l3.5 8 2.5-4.5 3.5 7 2.5-6 3.5 7 2.5-4.5 5.5 7" />,

  // ── patterns: cycles ──
  cyclicLines: <><path d="M7.5 4v20M16.5 4v20" /><path d="M7.5 14a4.5 4.5 0 0 1 9 0" /></>,
  timeCycles: <><path d="M4.5 21a4.5 4.5 0 0 1 9 0 4.5 4.5 0 0 0 9 0" /><path d="M3.5 24.5h21" /></>,
  sineLine: <path d="M3.5 14c3.5-10.5 7 10.5 10.5 0s7-10.5 10.5 0" />,

  // ── forecasting ──
  // Two rails with a dot at each LEFT end and an L bracket between them: a
  // position seen edge-on. It used to be two stacked rectangles — a 2x2 table.
  long: <><circle cx="5.5" cy="6.5" r="2" /><path d="M8 6.5h17" /><path d="M5 17.5h20" /><circle cx="5.5" cy="22.5" r="2" /><path d="M8 22.5h17" /><path d="M13.5 9v5.5h4" /></>,
  short: <><circle cx="5.5" cy="6.5" r="2" /><path d="M8 6.5h17" /><path d="M5 11.5h20" /><circle cx="5.5" cy="22.5" r="2" /><path d="M8 22.5h17" /><path d="M13.5 20v-5.5h4" /></>,
  // A known leg, then a projected one, dashed-looking by its gap.
  positionForecast: <><path d="M3.5 21.5l7-7" /><path d="M12.5 12.5h2.5M17.5 8.5h2.5M22.5 4.5h2" /><path d="M18.5 3.5h6v6" /></>,
  barsPattern: <><path d="M7.5 8v12M11.5 5v18M15.5 9.5v9M19.5 6.5v14" /><path d="M5 10.5h2.5M11.5 9.5H14M13 14.5h2.5M19.5 11.5H22" /></>,
  // A wedge of the plane swept between two rays.
  sector: <><path d="M5.5 22.5V6" /><path d="M5.5 22.5h18" /><path d="M5.5 22.5L22 8" /><path d="M16.5 22.5a11 11 0 0 0-4.8-9" /></>,

  // ── volume-based ──
  avwap: <><circle cx="6" cy="21" r="2.3" /><path d="M8.3 20.5c4.3-.7 5.4-10.4 9.7-12.4s7 1 8.3 3.6" /></>,
  vprange: <><path d="M5.5 4v20M23.5 4v20" /><path d="M23.5 8.5h-7M23.5 13.5h-10.5M23.5 18.5h-4.5" /></>,
  avprofile: <><circle cx="5.5" cy="20.5" r="2.3" /><path d="M8 20.5h16.5" /><path d="M24.5 8.5h-7M24.5 13.5h-10.5M24.5 18.5h-4.5" /></>,

  // ── measurers ──
  pricerange: <><path d="M14.5 4v20" /><path d="M9.5 8.5l5-5 5 5M9.5 19.5l5 5 5-5" /></>,
  daterange: <><path d="M4 14.5h20" /><path d="M8.5 9.5l-5 5 5 5M19.5 9.5l5 5-5 5" /></>,
  datePriceRange: <><rect x="4.5" y="6.5" width="19" height="15" /><path d="M4.5 13.5h19M13.5 6.5v15" /></>,
  ruler: <><path d="M2.5 17.5L17.5 2.5l8 8-15 15z" /><path d="M6.5 13.5l3.5 3.5M10.5 9.5l3.5 3.5M14.5 5.5l3.5 3.5" /></>,
  zoomIn: <><circle cx="12.5" cy="12.5" r="8" /><path d="M12.5 8.5v8M8.5 12.5h8" /><path d="M18.5 18.5l6 6" /></>,

  // ── shapes: brushes ──
  // A brush HEAD with a paint stroke running off its tip. It was a sine wave
  // with a tick, 11px tall in a 28px box.
  brush: <path d="M18 6.5L16 11l-7.5 1.5L2.5 22.5 14 22l2.5-6-1.5-2.5L27 6" />,
  highlighter: <><path d="M16.5 4.5l7 7-9.5 9.5H7l-2.5-2.5z" /><path d="M4 24.5h20" /></>,

  // ── shapes: arrows ──
  arrowMarker: <><path d="M5.5 22.5L22.5 5.5" /><path d="M15 5.5h7.5V13" /></>,
  arrow: <><path d="M4.5 22.5L21 7" /><path d="M14 6.5h8v8" /></>,
  arrowUp: <path d="M14.5 24V6M7.5 13l7-7 7 7" />,
  arrowDown: <path d="M14.5 4v18M7.5 15l7 7 7-7" />,

  // ── shapes ──
  rect: <rect x="4.5" y="7.5" width="19" height="14" rx="1" />,
  rotatedRectangle: <path d="M3.5 16.5l8-9.5 13 5-8 9.5z" />,
  path: <><path d="M4.5 21.5l6-8.5 4.5 4.5 6.5-9" /><path d="M16.5 3.5h7v7" /><circle cx="4.5" cy="21.5" r="1.8" /></>,
  circle: <circle cx="14" cy="14" r="8.5" />,
  ellipse: <ellipse cx="14" cy="14" rx="10" ry="7" />,
  polyline: <><path d="M4.5 21.5l6-8.5 4.5 4.5 8-10.5" /><circle cx="4.5" cy="21.5" r="1.8" /><circle cx="10.5" cy="13" r="1.8" /><circle cx="15" cy="17.5" r="1.8" /><circle cx="23" cy="7" r="1.8" /></>,
  triangle: <path d="M14 5.5l10.5 17H3.5z" />,
  arc: <path d="M4.5 21.5a9.5 9.5 0 0 1 19 0" />,
  curve: <path d="M4.5 21.5c4.5-14 14 14 19-7" />,
  doubleCurve: <><path d="M4.5 21.5c4.5-14 14 14 19-7" /><path d="M4.5 16.5c4.5-9.5 14 9.5 19-4.5" /></>,

  // ── annotation ──
  text: <><path d="M6.5 5.5h15M6.5 5.5v3M21.5 5.5v3" /><path d="M14.5 5.5v17" /><path d="M11.5 22.5h6" /></>,
  note: <path d="M4.5 4.5h19v14h-13l-6 5z" />,
  priceNote: <><path d="M3.5 14.5h10l3.5-5h7v10h-7l-3.5-5" /><path d="M17.5 12.5h5M17.5 16.5h3" /></>,
  pin: <><path d="M9.5 4.5h9l-2.5 7 3.5 3.5H8l3.5-3.5z" /><path d="M14 15v9.5" /></>,
  table: <><rect x="3.5" y="5.5" width="21" height="17" /><path d="M3.5 11.5h21M3.5 17.5h21M10.5 5.5v17M17.5 5.5v17" /></>,
  callout: <path d="M4.5 5.5h19v12h-9l-4.5 4.5V17.5h-5.5z" />,
  comment: <><path d="M4.5 5.5h19v13h-14l-5 4.5z" /><path d="M9 10.5h10M9 14.5h6" /></>,
  pricelabel: <path d="M3.5 14.5h10l3.5-5h7v10h-7l-3.5-5z" />,
  signpost: <><path d="M14.5 24.5V3.5" /><path d="M5.5 6.5h17l-3.5 4.5 3.5 4.5h-17l3.5-4.5z" /></>,
  flagMark: <><path d="M7.5 24.5V3.5" /><path d="M7.5 5.5h13l-3.5 4.5 3.5 4.5h-13" /></>,

  // ── icons ──
  iconSmiley: <><circle cx="14" cy="14" r="10.5" /><path d="M10.5 11.5h.01M17.5 11.5h.01" /><path d="M9.5 16.5q4.5 4.5 9 0" /></>,

  // ── options ──
  // A HORSESHOE with two rectangular pole caps. It was a "U" with two side
  // ticks, which reads as a cup.
  magnet: <>
    <path d="M6.5 11.5a7.5 7.5 0 0 1 15 0" /><path d="M11.5 11.5a2.5 2.5 0 0 1 5 0" />
    <path d="M6.5 11.5v11M11.5 11.5v11M16.5 11.5v11M21.5 11.5v11" />
    <path d="M6.5 18.5h5M16.5 18.5h5M6.5 22.5h5M16.5 22.5h5" />
  </>,
  // A pencil with a PADLOCK badge: the mode that keeps the tool armed. It was
  // a pencil on a baseline, which is the Text tool's grammar.
  stayInDrawingMode: <>
    <path d="M3.5 20.5L13 4l4.5 4.5L8 24.5z" /><path d="M6.5 12.5l4.5 4.5" />
    <rect x="15.5" y="18.5" width="7" height="6" rx="1" />
    <path d="M17 18.5v-2.5a2 2 0 0 1 4 0v2.5" />
  </>,
  lock: <><rect x="6.5" y="11.5" width="15" height="11" rx="1.5" /><path d="M9.5 11.5V8a4.5 4.5 0 0 1 9 0v3.5" /><path d="M14 15.5v3" /></>,
  unlock: <><rect x="6.5" y="11.5" width="15" height="11" rx="1.5" /><path d="M9.5 11.5V8a4.5 4.5 0 0 1 8.2-2.6" /><path d="M14 15.5v3" /></>,
  // The eye carries a pencil badge at its lower right — the reference's "this
  // layer is hidden" mark. It was a plain eye, 16px tall in a 28px box.
  eye: <>
    <path d="M2.5 9.5C6 6 9.5 4.5 13 4.5s6.5 1.5 10 5c-3.5 3.5-6.5 5-10 5s-7-1.5-10.5-5z" />
    <circle cx="13" cy="9.5" r="3.5" />
    <path d="M14.5 24.5l1.5-6 7.5-2.5-1 7z" />
  </>,
  eyeOff: <>
    <path d="M2.5 9.5C6 6 9.5 4.5 13 4.5s6.5 1.5 10 5c-3.5 3.5-6.5 5-10 5s-7-1.5-10.5-5z" />
    <path d="M4 2.5l18 14" />
    <path d="M14.5 24.5l1.5-6 7.5-2.5-1 7z" />
  </>,
  trash: <><path d="M5.5 7.5h17" /><path d="M10.5 7.5V5.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v2" /><path d="M7.5 7.5l1 16h11l1-16" /></>,
};

/*
 * 28 units at 28px, so one unit is one device pixel and the half-unit
 * coordinates above land a stroke inside a single pixel. See the note on the
 * set for why the weight is 1.25 rather than 1.
 */
const Icon = ({ name, size = 28 }: { name: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor"
    strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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


/**
 * Which keyboard action arms which tool, for the flyout's key-cap column.
 *
 * R2b-05: `BINDINGS` has declared ⌥J, ⌥C and ⌥⇧R since TVP7, but this lookup
 * knew only six tools — so the very first flyout a user opens printed three of
 * the reference's five caps, and the Rectangle row printed none at all. Every
 * `tool:` action that has an `alt` binding is listed here; a new one that is
 * not will silently print nothing, which is how the last three went missing.
 */
const TOOL_ACTION: Partial<Record<DrawingTool, ShortcutAction>> = {
  cursor: "tool:cursor",
  trend: "tool:trend",
  hline: "tool:horizontal",
  hray: "tool:horizontal-ray",
  vline: "tool:vertical",
  crossline: "tool:crossline",
  fib: "tool:fib",
  rect: "tool:rectangle",
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

/**
 * `⌥ T`, with a space — the reference's own cap typography (R2b-12).
 *
 * This printed `⌥T` tight. The modifiers stay joined to each other (`⌥⇧`), so
 * a two-modifier chord does not sprawl, and the KEY is separated by a thin
 * space: at 12px on a dark menu, `⌥T` reads as one unfamiliar glyph while
 * `⌥ T` reads as "option, then T", which is the instruction.
 */
function keyCap(binding: Binding, mac: boolean): string {
  const mods: string[] = [];
  if (binding.mod) mods.push(mac ? "⌘" : "Ctrl");
  if (binding.alt) mods.push(mac ? "⌥" : "Alt");
  if (binding.shift) mods.push(mac ? "⇧" : "Shift");
  const key = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  if (!mac) return [...mods, key].join("+");
  // U+2009 THIN SPACE, escaped: a literal one here is invisible in a diff.
  return `${mods.join("")}\u2009${key}`;
}

export type MagnetMode = "off" | "weak" | "strong";
export type LockScope = "drawings" | "indicators" | "all";
export type HideScope = "drawings" | "indicators" | "positions" | "all";
export type RemoveScope = "drawings" | "indicators" | "all";

interface OptionSwitch { on: boolean; onChange: (value: boolean) => void }

/**
 * A rail flyout, clamped to the viewport (R2b-04).
 *
 * The menu opens at `cell − 6` and used to stop there, with
 * `max-h-[calc(100vh-120px)] overflow-y-auto` as the only safety net. Two
 * things came of that. The Geometric-shapes flyout is 750px tall opening from
 * a cell at y=238, so its last two rows — Curve and Double curve — rendered
 * below the 900px viewport; and every menu that DID fit still carried a scroll
 * container, so a sixteen-row list that has nothing hidden behaved as though
 * it had.
 *
 * The reference's rule is the one below: the top is `min(cell − 6, viewport −
 * height − 8)`, so a tall menu slides UP until its bottom is flush and the
 * cell it belongs to is still beside it. Scrolling is kept only for the case
 * the rule cannot solve — a menu taller than the whole window.
 *
 * Measured in a layout effect rather than guessed from a row count: the row
 * count is not the height (headings, separators and padding are not rows), and
 * a font or density change would silently invalidate any number written here.
 */
function Flyout({ className = "", children }: { className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(-6);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.offsetParent as HTMLElement | null;
    if (!el || !host) return;
    const viewport = window.innerHeight;
    // `offsetParent` is the cell's own wrapper, so its top IS the cell's top.
    const cell = host.getBoundingClientRect().top;
    const height = el.scrollHeight;
    if (height > viewport - 16) {
      setMaxHeight(viewport - 16);
      setTop(8 - cell);
      return;
    }
    setMaxHeight(undefined);
    setTop(Math.min(cell - 6, viewport - height - 8) - cell);
  }, [children]);

  return (
    <div
      ref={ref}
      style={{ top, maxHeight }}
      className={`absolute left-[53px] z-50 w-max tvc-menu ${
        maxHeight === undefined ? "" : "overflow-y-auto "
      }${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The Icons picker (R2b-07).
 *
 * The reference's is 354×679 with its bottom flush to the viewport: a row of
 * eight 38×38 category cells, an 8-column grid of 37×38 cells carrying 24px
 * glyphs that scrolls INSIDE the popover, and a bottom tab bar reading
 * `Emojis · Stickers · Icons`. This one was 354×292, seven rows of colour
 * emoji, no categories, no tabs and nothing to scroll — a favourites bar
 * wearing a picker's position.
 *
 * `Stickers` is that product's own licensed artwork; there is no counterpart
 * here and an empty third tab would be a promise the product cannot keep, so
 * the bar carries the two tabs that mean something. `Icons` is our own
 * monochrome outline set (Unicode symbol glyphs, so a placed icon paints
 * through the same text path and takes the drawing's own colour).
 */
function IconPicker({ onPick }: { onPick: (glyph: string) => void }) {
  const [tab, setTab] = useState<"emojis" | "icons">("emojis");
  const categories = tab === "emojis" ? EMOJI_CATEGORIES : OUTLINE_CATEGORIES;
  const [category, setCategory] = useState(0);
  const current = categories[Math.min(category, categories.length - 1)]!;
  const gridRef = useRef<HTMLDivElement>(null);

  const pickTab = (next: "emojis" | "icons") => {
    setTab(next);
    setCategory(0);
    if (gridRef.current) gridRef.current.scrollTop = 0;
  };

  return (
    <div className="flex h-[679px] w-[354px] flex-col">
      {/* Category cells: 38×38, the reference's own row above the grid. */}
      <div className="flex shrink-0 gap-0 px-[6px] pt-[6px]">
        {categories.map((c, i) => (
          <button
            key={c.id}
            onClick={() => { setCategory(i); if (gridRef.current) gridRef.current.scrollTop = 0; }}
            aria-label={c.label}
            aria-pressed={i === category}
            data-active={i === category ? "true" : undefined}
            className={
              "flex h-[38px] w-[38px] items-center justify-center rounded text-[18px] "
              + "leading-none hover:bg-state-hover data-[active=true]:bg-state-active"
            }
          >
            <span aria-hidden="true">{c.icon}</span>
          </button>
        ))}
      </div>
      <div className="shrink-0 px-[15px] pb-[6px] pt-[10px] text-[11px] uppercase tracking-[0.04em] text-ink-faint">
        {current.label}
      </div>
      {/* The grid scrolls, the popover does not: the tab bar stays reachable. */}
      <div ref={gridRef} className="min-h-0 flex-1 overflow-y-auto px-[6px]">
        <div className="grid grid-cols-8">
          {current.glyphs.map((glyph) => (
            <button
              key={glyph}
              onClick={() => onPick(glyph)}
              aria-label={`Icon ${glyph}`}
              /*
                Not `.tvc-control`: the rail scopes that chip to
                `inset: 2px 9px` so a 52px cell reads as a 34px square, and a
                37px picker cell inside the rail would inherit a 19px-wide
                chip. The grammar's own hover ground, at this cell's own size.
              */
              className="flex h-[38px] w-[37px] items-center justify-center rounded text-[24px] leading-none hover:bg-state-hover"
            >
              <span aria-hidden="true">{glyph}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex h-[37px] shrink-0 items-stretch border-t" style={{ borderColor: "var(--ts-line-strong)" }}>
        {(["emojis", "icons"] as const).map((id) => (
          <button
            key={id}
            onClick={() => pickTab(id)}
            aria-pressed={tab === id}
            data-active={tab === id ? "true" : undefined}
            className="flex flex-1 items-center justify-center text-[16px] text-ink-faint data-[active=true]:text-ink"
          >
            <span>{id === "emojis" ? "Emojis" : "Icons"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

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
    "tvc-control group/tip flex h-[38px] w-[52px] items-center justify-center text-ink";

  /**
   * The rail's tooltip, in the product's own chrome (R2b-14).
   *
   * Every rail control used to name itself through the `title` attribute: the
   * OS draws that, half a second late, in a different font on a different
   * ground, and it is the ONE piece of chrome in this workstation that the
   * theme cannot reach. The reference draws a pill — 26px tall, #3d3d3d, 14px
   * ink, 4px radius, its left edge 4px past the rail — and draws it at once.
   *
   * `left-full` rather than a fixed offset so the same pill is correct from
   * the 52px cell and from the 11px strip: both are positioned elements whose
   * right edge is the rail's, so "the rail's width plus 4" is `ml-[4px]` in
   * both. `aria-hidden`, because the control it belongs to already has a NAME
   * — a tooltip that also announced itself would say it twice.
   */
  const tip = (label: string) => (
    <span aria-hidden="true" data-rail-tip
      className={
        "pointer-events-none absolute left-full top-[6px] z-[60] ml-[4px] hidden h-[26px] "
        + "items-center whitespace-nowrap rounded-[4px] bg-state-active px-[8px] "
        + "text-[14px] leading-none text-ink group-hover/tip:flex"
      }
    >{label}</span>
  );

  /**
   * The hover-revealed edge strip that opens a cell's flyout.
   *
   * R2b-08: the strip used to be an invisible hit-zone that revealed a glyph —
   * with the flyout open, the cell showed a bare chevron on black and nothing
   * said which control was holding the menu open. The reference lights the
   * strip as its own 11×34 rounded chip while it is hovered and while its menu
   * is open, and leaves the icon area untinted; the icon's own 34×34 chip
   * stays with the icon. `.tvc-control` cannot be used here because the rail
   * scopes its chip to `inset: 2px 9px` — on an 11px strip that is a negative
   * width — so the state grammar is spelled out at this control's own size.
   */
  const strip = (id: string, title: string) => (
    <button
      onClick={() => setFlyout(flyout === id ? null : id)}
      aria-label={`More ${id} tools`}
      aria-expanded={flyout === id}
      data-open={flyout === id ? "true" : undefined}
      className={
        "absolute right-0 top-[2px] flex h-[34px] w-[11px] items-center justify-center "
        + "group/tip rounded-[4px] text-ink opacity-0 transition-none group-hover:opacity-100 "
        + "focus-visible:opacity-100 data-[open=true]:opacity-100 "
        + "hover:bg-state-hover data-[open=true]:bg-state-hover"
      }
    >
      {tip(title)}
      <svg viewBox="0 0 4 7" width="4" height="7" fill="none" stroke="currentColor"
        strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {flyout === id ? <path d="M3.2 0.8L0.8 3.5l2.4 2.7" /> : <path d="M0.8 0.8l2.4 2.7-2.4 2.7" />}
      </svg>
    </button>
  );

  /**
   * One 40px tool row: icon, name, the reference's ⌥ cap, a hover-only star.
   *
   * ── Geometry (R2b-09) ────────────────────────────────────────────────────
   *
   * Measured against the reference's Trend flyout at 1440×900 dark, the row
   * was indented and the menu was 18px too narrow. The row's own gutter is
   * 6px (`.tvc-menu-row`), so `px-3` put the icon box at 10px INSIDE that —
   * 16px from the menu's edge instead of 10 — and `gap-2` pushed the label to
   * 107 instead of 96. `pl-[4px]` and `gap-[5px]` put the 28px icon box at
   * x=63..91 and the label at x=96, which is where the reference has them.
   *
   * `ml-[18px]` is the reference's reserved right column, and it is the whole
   * of the missing 18px of width: the menu is sized by its widest row, and
   * without a reservation the hotkey and the hover star sat hard against the
   * longest label. With it, the cap ends 44px from the menu's right edge and
   * the star has its own lane instead of borrowing the label's.
   */
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
          className="flex min-w-0 flex-1 items-center gap-[5px] pl-[4px] text-left text-sm"
        >
          <Icon name={t.icon} size={28} />
          <span data-tool-label className="whitespace-nowrap">{t.label}</span>
        </button>
        <div className="ml-[18px] flex shrink-0 items-center">
          {binding && (
            /* 12px and #8c8c8c, the sampled cap: at 11px it read as a footnote
               rather than as the chord it is. See `keyCap` for the spacing. */
            <kbd className="mr-[10px] whitespace-nowrap font-sans text-[12px] leading-none text-ink-faint">
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
              "mr-[6px] flex h-7 w-7 shrink-0 items-center justify-center rounded text-[15px] "
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
      /*
       * No `border-r`: the shell draws a 4px `--ts-bg` gutter to the right of
       * this column (R2b-13), so a hairline here would be a second boundary
       * inside it. And `pt-[6px]`, not 10 — the toolbar row above now ends in
       * that same 4px gutter rather than in a 1px hairline, so 6px of rail
       * padding is what still puts the first cell at y=48.
       */
      className={`relative flex w-[52px] shrink-0 flex-col items-center bg-surface pt-[6px] ${
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
            >
              {tip(current.label)}
              <Icon name={current.icon} />
            </button>
            {strip(group.id, group.title)}
            {flyout === group.id && (isIcons ? (
              <Flyout className="!p-0">
                <IconPicker onPick={(glyph) => {
                  armIconGlyph(glyph); onTool("icon"); setFlyout(null);
                }} />
              </Flyout>
            ) : (
              /*
               * 24px of popover padding above the first row, on top of the
               * menu's own 6px: the reference leaves 30px of blank surface
               * before the first row of every tool flyout, and the same 24px
               * surplus appears in all seven of its measured heights.
               */
              /* `!` because `.tvc-menu` sets `padding: 6px 0` at a higher
                 specificity than a utility class can reach. */
              <Flyout className="!pt-[24px]">
                {group.sections.map((section, i) => (
                  <Fragment key={section.heading ?? `section-${i}`}>
                    {/* A heading brings its own 6px of air, so the separator
                        above it drops its bottom margin: 6 + 1 + 30 = 37px,
                        the reference's section block. It was 43. */}
                    {i > 0 && <div className={`tvc-menu-sep${section.heading ? " !mb-0" : ""}`} />}
                    {section.heading && <div className="tvc-menu-heading">{section.heading}</div>}
                    {section.tools.map((t) => toolRow(group.id, t))}
                  </Fragment>
                ))}
                {group.id === "cursors" && footerSwitch(
                  "Values tooltip on long press", optionSwitches?.valuesTooltip)}
              </Flyout>
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
        >
          {tip(single.label)}
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
          aria-label={magnetOn ? "Turn the magnet off" : "Turn the magnet on"}>
          {tip(magnetOn ? "Magnet on — anchors snap to OHLC" : "Magnet off")}
          <Icon name="magnet" />
        </button>
        {strip("magnet", "Magnets")}
        {flyout === "magnet" && (
          <Flyout className="tvc-menu--compact">
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
          </Flyout>
        )}
      </div>

      <div className="group relative">
        <button onClick={() => onStayInDrawingMode(!stayInDrawingMode)}
          className={btn()} aria-pressed={stayInDrawingMode}
          aria-label={stayInDrawingMode ? "Turn off keep drawing" : "Keep drawing"}>
          {tip(stayInDrawingMode
            ? "Keeping the tool armed after each drawing"
            : "Keep drawing")}
          <Icon name="stayInDrawingMode" />
        </button>
      </div>

      <div className="group relative">
        <button onClick={() => (onLockScope ? onLockScope("drawings") : onLocked(!locked))}
          className={btn()} aria-pressed={lockScope ? lockScope !== "none" : locked}
          aria-label={locked ? "Unlock all drawings" : "Lock drawings and indicators"}>
          {tip(locked ? "Drawings locked" : "Lock drawings and indicators")}
          <Icon name={(lockScope ? lockScope !== "none" : locked) ? "lock" : "unlock"} />
        </button>
        {strip("lock", "Lock options")}
        {flyout === "lock" && (
          <Flyout className="tvc-menu--compact">
            {optionRow("lock-drawings", "Lock drawings", lockScope === "drawings" || (!lockScope && locked),
              () => (onLockScope ? onLockScope("drawings") : onLocked(!locked)))}
            {/* Indicators and "all" need a lock the page does not own yet — see
                the wiring note. An unwired row would lock nothing, silently. */}
            {onLockScope && optionRow("lock-indicators", "Lock indicators",
              lockScope === "indicators", () => onLockScope("indicators"))}
            {onLockScope && optionRow("lock-all", "Lock all",
              lockScope === "all", () => onLockScope("all"))}
          </Flyout>
        )}
      </div>

      <div className="group relative">
        <button onClick={() => (onHideScope ? onHideScope("drawings") : onHidden(!hidden))}
          className={btn()} aria-pressed={hideScope ? hideScope !== "none" : hidden}
          aria-label={hidden ? "Show all drawings" : "Hide all drawings"}>
          {tip(hidden ? "Drawings hidden" : "Hide all drawings")}
          <Icon name={(hideScope ? hideScope !== "none" : hidden) ? "eyeOff" : "eye"} />
        </button>
        {strip("hide", "Hide options")}
        {flyout === "hide" && (
          <Flyout className="tvc-menu--compact">
            {optionRow("hide-drawings", "Hide drawings", hideScope === "drawings" || (!hideScope && hidden),
              () => (onHideScope ? onHideScope("drawings") : onHidden(!hidden)))}
            {onHideScope && optionRow("hide-indicators", "Hide indicators",
              hideScope === "indicators", () => onHideScope("indicators"))}
            {onHideScope && optionRow("hide-positions", "Hide positions and orders",
              hideScope === "positions", () => onHideScope("positions"))}
            {onHideScope && optionRow("hide-all", "Hide all",
              hideScope === "all", () => onHideScope("all"))}
          </Flyout>
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
          /* R2b-11, verified on `tradingview/rail-remove-hover-1440-dark.png`:
             the reference's trash hover is the ordinary grey chip with the
             ordinary ink — no red tint. */
          className={btn()}
          aria-label="Remove objects"
        >
          {tip("Remove objects")}
          <Icon name="trash" />
        </button>
        {strip("remove", "Remove options")}
        {flyout === "remove" && (
          <Flyout className="tvc-menu--compact">
            {removeRows.map((row) => optionRow(row.key, row.label, false, row.run))}
            {footerSwitch("Always remove locked drawings", optionSwitches?.alwaysRemoveLocked)}
          </Flyout>
        )}
      </div>
    </div>
  );
}
