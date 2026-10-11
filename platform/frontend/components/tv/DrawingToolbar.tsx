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
/**
 * Where the floating favourites bar sits, and whether it is showing (R2c-06).
 *
 * A device preference, like the favourites list itself: the bar is a thing you
 * position once on your own screen and expect to find there tomorrow, not
 * chart data to be synced or restored with a layout.
 */
const DRAWING_FAVOURITES_BAR_KEY = "tv.drawing-tools.favourites.bar.v1";
/**
 * The reference's own first position for the bar: over the chart, 38px below
 * the status-line row and clear of the price axis (measured at 1440×900 in
 * `measurements/tv-favourites-bar-20260914.md`). Clamped into the viewport on
 * mount, so a narrower window does not open it off-screen.
 */
const FAVOURITES_BAR_HOME = { x: 960, y: 99 };
/** 24px drag grip + one 38px cell per starred tool. */
const FAVOURITES_GRIP_WIDTH = 24;
const FAVOURITES_CELL = 38;

/*
 * ── A finger cannot hover (D-F9) ───────────────────────────────────────────
 *
 * The flyout strip is revealed by hover and the cell's other route to its
 * flyout is a right-click. A touch screen has neither: the strip stayed at
 * `opacity-0` under a fingertip, and iOS Safari never fires `contextmenu` for
 * a long press, so on a phone or a tablet the eight groups' other tools were
 * unreachable from the rail.
 *
 * Both repairs are scoped to a COARSE pointer, so the desktop rail — measured
 * against the reference and locked at 52×38 cells with an 11×34 hover strip —
 * is byte-for-byte what it was:
 *
 *   - the strip is always shown, and its hit area reaches 9px past the rail's
 *     edge, so the 34px-tall target is 20px wide rather than 11 without the
 *     cell's glyph giving up any of its own width;
 *   - holding a group cell for `LONG_PRESS_MS` opens its flyout, the gesture
 *     a touch user reaches for and the one the reference answers. Moving more
 *     than `LONG_PRESS_SLOP_PX` (a scroll) or lifting first cancels it, and
 *     the tap that ends a hold does not also arm the tool.
 */
/*
 * Spelled out in full, never built from a `${prefix}` template: Tailwind finds
 * classes by scanning the source text, and an interpolated variant is a class
 * it never sees and therefore never generates.
 */
const COARSE_STRIP =
  "[@media(pointer:coarse)]:opacity-100 "
  + "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-y-0 "
  + "[@media(pointer:coarse)]:after:left-0 [@media(pointer:coarse)]:after:-right-[9px] "
  + "[@media(pointer:coarse)]:after:content-['']";
/** No text selection or iOS callout sheet over a held cell. */
const COARSE_CELL =
  "[@media(pointer:coarse)]:select-none [@media(pointer:coarse)]:[-webkit-touch-callout:none]";
export const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 8;

/** A finger or a stylus; a pointer that does not say counts when the device's primary pointer is coarse. */
function isCoarsePress(e: { pointerType?: string }): boolean {
  if (e.pointerType === "touch" || e.pointerType === "pen") return true;
  if (e.pointerType === "mouse") return false;
  try { return window.matchMedia?.("(pointer: coarse)").matches === true; } catch { return false; }
}

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
  arrowCursor: <path d="M8.5 4l12.5 9.6-6 1.4 2.6 7.2-2.9 1.1-2.5-7.3-3.7 4.3z" strokeWidth={1.4} />,
  eraser: <><path d="M5 18.5l8.5-8.5 7 7-4.5 4.5H9.5z" strokeWidth={1.4} /><path d="M3.5 24.5h21" /></>,

  // ── trend: lines ──
  trend: <><circle cx="21.5" cy="5.5" r="2" strokeWidth={1.4} /><circle cx="6.5" cy="22.5" r="2" strokeWidth={1.4} /><path d="M8 21L20 7" strokeWidth={1.4} /></>,
  ray: <><circle cx="6.5" cy="21.5" r="2" strokeWidth={1.4} /><circle cx="14.5" cy="13.5" r="2" strokeWidth={1.4} /><path d="M8 20l5-5M16 12l8.5-8.5" strokeWidth={1.4} /></>,
  infoline: <><circle cx="22.5" cy="5.5" r="2" strokeWidth={1.4} /><circle cx="5.5" cy="22.5" r="2" strokeWidth={1.4} /><path d="M7 21L21 7" strokeWidth={1.4} /><rect x="16.5" y="17.5" width="9" height="7" rx="1" /></>,
  extended: <><circle cx="17.5" cy="10.5" r="2" strokeWidth={1.4} /><circle cx="10.5" cy="17.5" r="2" strokeWidth={1.4} /><path d="M3.5 24.5L9 19M12 16l4-4M19 9l5.5-5.5" strokeWidth={1.4} /></>,
  trendAngle: <><circle cx="22.5" cy="5.5" r="2" strokeWidth={1.4} /><circle cx="5.5" cy="22.5" r="2" strokeWidth={1.4} /><path d="M7 21L21 7" strokeWidth={1.4} /><path d="M7.5 22.5h16" /><path d="M13.5 22.5A8 8 0 0 0 11.2 16.8" strokeWidth={1.4} /></>,
  hline: <><path d="M3 14.5h9.5M16.5 14.5H25" /><circle cx="14.5" cy="14.5" r="2" strokeWidth={1.4} /></>,
  hray: <><circle cx="5.5" cy="14.5" r="2" strokeWidth={1.4} /><path d="M8 14.5h17" /></>,
  vline: <><path d="M14.5 3v9.5M14.5 16.5V25" /><circle cx="14.5" cy="14.5" r="2" strokeWidth={1.4} /></>,
  crossline: <><path d="M3 14.5h9.5M16.5 14.5H25M14.5 3v9.5M14.5 16.5V25" /><circle cx="14.5" cy="14.5" r="2" strokeWidth={1.4} /></>,

  // ── trend: channels ──
  // Two FULL-LENGTH parallels: the third anchor rides the second line, which
  // is the whole gesture. They used to be two 14px stubs.
  parallel: <><circle cx="19.5" cy="5.5" r="2" strokeWidth={1.4} /><circle cx="5.5" cy="19.5" r="2" strokeWidth={1.4} /><circle cx="17.5" cy="17.5" r="2" strokeWidth={1.4} /><path d="M7 18L18 7" strokeWidth={1.4} /><path d="M10 25l6-6M19 16l6-6" strokeWidth={1.4} /></>,
  // A slanted BAND with a median through it: what a regression channel is.
  // It was a line with five dots, which is a scatter plot.
  regression: <><path d="M5.5 10.5L21.5 2.5M5.5 24.5L21.5 16.5" strokeWidth={1.4} /><path d="M7.3 16.6L19.7 10.4" strokeWidth={1.4} /><path d="M5.5 10.5v14M21.5 2.5v14" /><circle cx="5.5" cy="17.5" r="2" strokeWidth={1.4} /><circle cx="21.5" cy="9.5" r="2" strokeWidth={1.4} /></>,
  // One sloped edge, one FLAT edge, four anchors — the difference from a
  // channel, stated in the silhouette.
  flatTopBottom: <><circle cx="22.5" cy="5.5" r="2" strokeWidth={1.4} /><circle cx="5.5" cy="13.5" r="2" strokeWidth={1.4} /><circle cx="5.5" cy="22.5" r="2" strokeWidth={1.4} /><circle cx="22.5" cy="22.5" r="2" strokeWidth={1.4} /><path d="M7.4 12.7L20.6 6.3" strokeWidth={1.4} /><path d="M7.5 22.5h13" /></>,
  disjointChannel: <><circle cx="22.5" cy="3.5" r="2" strokeWidth={1.4} /><circle cx="5.5" cy="10.5" r="2" strokeWidth={1.4} /><circle cx="5.5" cy="17.5" r="2" strokeWidth={1.4} /><circle cx="22.5" cy="24.5" r="2" strokeWidth={1.4} /><path d="M7.4 9.8L20.6 4.2M7.4 18.2L20.6 23.8" strokeWidth={1.4} /></>,

  // ── trend: pitchforks ──
  // Three tines on a base bar, as the reference draws all four. They were one
  // diagonal with a single prong, which is not a fork.
  pitchfork: <><path d="M6 12l10 10" strokeWidth={1.4} /><path d="M6 12l9-9M11 17l9-9M16 22l9-9" strokeWidth={1.4} /><path d="M11 17l-7 7" strokeWidth={1.4} /></>,
  // Schiff: the median springs from the FIRST anchor, not the bar's middle.
  schiffPitchfork: <><path d="M6 12l10 10" strokeWidth={1.4} /><path d="M6 12l9-9M11 17l9-9M16 22l9-9" strokeWidth={1.4} /><path d="M6 12l-2.5 11" strokeWidth={1.4} /><circle cx="6" cy="12" r="1.6" strokeWidth={1.4} /></>,
  modifiedSchiffPitchfork: <><path d="M6 12l10 10" strokeWidth={1.4} /><path d="M6 12l9-9M11 17l9-9M16 22l9-9" strokeWidth={1.4} /><path d="M8.5 14.5L4 19l1.5 5" strokeWidth={1.4} /><circle cx="8.5" cy="14.5" r="1.6" strokeWidth={1.4} /></>,
  insidePitchfork: <><path d="M8 13l8 8" strokeWidth={1.4} /><path d="M8 13l6-6M12 17l6-6M16 21l6-6" strokeWidth={1.4} /><path d="M12 17l-7.5 7.5" strokeWidth={1.4} /><circle cx="12" cy="17" r="1.6" strokeWidth={1.4} /></>,

  // ── fibonacci ──
  // Dots at the RIGHT end of an upper level and the LEFT end of a lower one,
  // which is the way the drag runs. They were mirrored.
  fib: <><path d="M1.5 4.5h24M1.5 16.5h24" /><path d="M1.5 10.5h20" /><circle cx="23.5" cy="10.5" r="2" strokeWidth={1.4} /><path d="M5.5 22.5h20" /><circle cx="3.5" cy="22.5" r="2" strokeWidth={1.4} /></>,
  fibext: <><path d="M3 21.5h22M3 14.5h22M3 7.5h22" /><path d="M7 25L15 3" strokeWidth={1.4} /></>,
  // Levels that run PARALLEL to a slope rather than flat.
  fibChannel: <><path d="M3.5 19.5L17.5 5.5M7.5 23.5L21.5 9.5M11.5 25.5L25.5 11.5" strokeWidth={1.4} /><circle cx="3.5" cy="19.5" r="1.6" strokeWidth={1.4} /></>,
  // Verticals at Fibonacci distances in TIME.
  fibTimeZone: <path d="M3.5 4v20M6.5 4v20M10.5 4v20M16.5 4v20M24.5 4v20" />,
  // Rays fanning from one corner.
  fibSpeedResistanceFan: <><path d="M4.5 23.5L23.5 4.5M4.5 23.5l19 7M4.5 23.5l19-15M4.5 23.5h20" strokeWidth={1.4} /><circle cx="4.5" cy="23.5" r="1.6" strokeWidth={1.4} /></>,
  // Verticals raised off a sloped base: time, measured along a trend.
  trendFibTime: <><path d="M3.5 23.5L24.5 9.5" strokeWidth={1.4} /><path d="M7.5 21v4M12.5 17.5v7.5M19.5 12.5v12.5" /></>,
  fibCircles: <><circle cx="14" cy="18.5" r="3.5" strokeWidth={1.4} /><circle cx="14" cy="18.5" r="7.5" strokeWidth={1.4} /><path d="M14 18.5L23 7" strokeWidth={1.4} /></>,
  fibSpiral: <path d="M15 15a2.3 2.3 0 1 0-2.3-2.3 4.6 4.6 0 1 0 7 3.5 8 8 0 1 1-10.4-5.8" strokeWidth={1.4} />,
  fibSpeedResistanceArcs: <><path d="M4.5 23.5a6 6 0 0 1 6-6M4.5 23.5a12 12 0 0 1 12-12M4.5 23.5a18 18 0 0 1 18-18" strokeWidth={1.4} /><circle cx="4.5" cy="23.5" r="1.6" strokeWidth={1.4} /></>,
  fibWedge: <><path d="M4.5 23.5L23.5 5.5" strokeWidth={1.4} /><path d="M4.5 23.5h19" /><path d="M4.5 23.5a12 12 0 0 0 8.4-3.5M4.5 23.5a18 18 0 0 0 13-6" strokeWidth={1.4} /></>,
  // A fan of medians, rather than one.
  pitchfan: <><path d="M4.5 23.5l19-16.5M4.5 23.5l17-2.5M4.5 23.5l12-12M4.5 23.5l7 1" strokeWidth={1.4} /><circle cx="4.5" cy="23.5" r="1.6" strokeWidth={1.4} /></>,

  // ── gann ──
  gannBox: <><rect x="4.5" y="5.5" width="19" height="17" /><path d="M4.5 22.5l19-17M4.5 5.5l19 17" strokeWidth={1.4} /></>,
  gannSquareFixed: <><rect x="5.5" y="5.5" width="17" height="17" /><path d="M5.5 22.5l17-17" strokeWidth={1.4} /><path d="M5.5 13.5h17M13.5 5.5v17" /></>,
  gannSquare: <><rect x="4.5" y="4.5" width="19" height="19" /><path d="M4.5 23.5l19-19" strokeWidth={1.4} /><path d="M4.5 23.5l19-9.5M4.5 23.5l9.5-19" strokeWidth={1.4} /></>,
  gannFan: <path d="M4.5 23.5L23.5 4.5M4.5 23.5l19 5M4.5 23.5l19-12M4.5 23.5l12-19M4.5 23.5l5-19" strokeWidth={1.4} />,

  // ── patterns: chart ──
  // Five nodes and the crossing X–B / A–C strokes: a closed bow-tie, not the
  // open "M" zigzag this used to draw.
  xabcd: <>
    <circle cx="8.5" cy="5.5" r="2" strokeWidth={1.4} /><circle cx="20.5" cy="6.5" r="2" strokeWidth={1.4} />
    <circle cx="11.5" cy="12.5" r="2" strokeWidth={1.4} /><circle cx="22.5" cy="19.5" r="2" strokeWidth={1.4} />
    <circle cx="5.5" cy="21.5" r="2" strokeWidth={1.4} />
    <path d="M8.1 7.5L5.9 19.5M20.8 8.5l1.4 9" strokeWidth={1.4} />
    <path d="M9.3 7.3l1.4 3.3M13.2 13.6l7.6 4.8" strokeWidth={1.4} />
    <path d="M18.8 7.6l-5.6 3.8M10.4 14.2L6.6 19.8" strokeWidth={1.4} />
  </>,
  cypher: <><path d="M4.5 22.5l6-13 4.5 10.5 4.5-7 4 6" strokeWidth={1.4} /><path d="M10.5 9.5l9.5 9.5" strokeWidth={1.4} /></>,
  headAndShoulders: <><path d="M3.5 21l3.5-6 3.5 3.5 3.5-10.5 3.5 10.5 3.5-3.5 3.5 6" strokeWidth={1.4} /><path d="M7 18.5h14" /></>,
  abcdPattern: <><circle cx="4.5" cy="21.5" r="1.8" strokeWidth={1.4} /><circle cx="10.5" cy="11.5" r="1.8" strokeWidth={1.4} /><circle cx="15.5" cy="17.5" r="1.8" strokeWidth={1.4} /><circle cx="22.5" cy="6.5" r="1.8" strokeWidth={1.4} /><path d="M5.5 19.8l4-6.6M11.6 13l2.8 3.4M16.7 15.9l4.6-7.3" strokeWidth={1.4} /></>,
  trianglePattern: <path d="M3.5 6.5l21 7-21 7z" strokeWidth={1.4} />,
  threeDrives: <path d="M3.5 22.5l3.5-4.5 2.5 3.5 3.5-7 2.5 4.5 3.5-8 2.5 4.5 3.5-7" strokeWidth={1.4} />,

  // ── patterns: elliott ──
  elliottImpulse: <><path d="M3.5 23.5l3.5-7 2.5 3.5 4.5-10.5 2.5 4.5 4.5-9.5" strokeWidth={1.4} /><path d="M10.5 6.5h.01M17 4.5h.01" /></>,
  elliottCorrection: <><path d="M4.5 6.5l4.5 9.5 4.5-6 4.5 9.5" strokeWidth={1.4} /><path d="M23.5 21V10" /></>,
  elliottTriangle: <><path d="M3.5 13.5l4.5 7 4.5-10.5 4.5 8 4.5-6" strokeWidth={1.4} /><path d="M3.5 13.5h19" /></>,
  elliottDoubleCombo: <path d="M3.5 8l4.5 9.5 3.5-6 3.5 8 3.5-7 5.5 7" strokeWidth={1.4} />,
  elliottTripleCombo: <path d="M2.5 8l3.5 8 2.5-4.5 3.5 7 2.5-6 3.5 7 2.5-4.5 5.5 7" strokeWidth={1.4} />,

  // ── patterns: cycles ──
  cyclicLines: <><path d="M7.5 4v20M16.5 4v20" /><path d="M7.5 14a4.5 4.5 0 0 1 9 0" strokeWidth={1.4} /></>,
  timeCycles: <><path d="M4.5 21a4.5 4.5 0 0 1 9 0 4.5 4.5 0 0 0 9 0" strokeWidth={1.4} /><path d="M3.5 24.5h21" /></>,
  sineLine: <path d="M3.5 14c3.5-10.5 7 10.5 10.5 0s7-10.5 10.5 0" strokeWidth={1.4} />,

  // ── forecasting ──
  // Two rails with a dot at each LEFT end and an L bracket between them: a
  // position seen edge-on. It used to be two stacked rectangles — a 2x2 table.
  long: <><circle cx="5.5" cy="6.5" r="2" strokeWidth={1.4} /><path d="M8 6.5h15.5" /><path d="M3.5 17.5h20" /><circle cx="5.5" cy="21.5" r="2" strokeWidth={1.4} /><path d="M8 21.5h15.5" /><path d="M13.5 9.5v5h4" /></>,
  short: <><circle cx="5.5" cy="6.5" r="2" strokeWidth={1.4} /><path d="M8 6.5h15.5" /><path d="M3.5 10.5h20" /><circle cx="5.5" cy="21.5" r="2" strokeWidth={1.4} /><path d="M8 21.5h15.5" /><path d="M13.5 18.5v-5h4" /></>,
  // A known leg, then a projected one, dashed-looking by its gap.
  positionForecast: <><path d="M3.5 21.5l7-7" strokeWidth={1.4} /><path d="M12.5 12.5h2.5M17.5 8.5h2.5M22.5 4.5h2" /><path d="M18.5 3.5h6v6" /></>,
  barsPattern: <><path d="M7.5 8v12M11.5 5v18M15.5 9.5v9M19.5 6.5v14" /><path d="M5 10.5h2.5M11.5 9.5H14M13 14.5h2.5M19.5 11.5H22" /></>,
  // A wedge of the plane swept between two rays.
  sector: <><path d="M5.5 22.5V6" /><path d="M5.5 22.5h18" /><path d="M5.5 22.5L22 8" strokeWidth={1.4} /><path d="M16.5 22.5a11 11 0 0 0-4.8-9" strokeWidth={1.4} /></>,

  // ── volume-based ──
  avwap: <><circle cx="6" cy="21" r="2.3" strokeWidth={1.4} /><path d="M8.3 20.5c4.3-.7 5.4-10.4 9.7-12.4s7 1 8.3 3.6" strokeWidth={1.4} /></>,
  vprange: <><path d="M5.5 4v20M23.5 4v20" /><path d="M23.5 8.5h-7M23.5 13.5h-10.5M23.5 18.5h-4.5" /></>,
  avprofile: <><circle cx="5.5" cy="20.5" r="2.3" strokeWidth={1.4} /><path d="M8 20.5h16.5" /><path d="M24.5 8.5h-7M24.5 13.5h-10.5M24.5 18.5h-4.5" /></>,

  // ── measurers ──
  pricerange: <><path d="M14.5 4v20" /><path d="M9.5 8.5l5-5 5 5M9.5 19.5l5 5 5-5" strokeWidth={1.4} /></>,
  daterange: <><path d="M4 14.5h20" /><path d="M8.5 9.5l-5 5 5 5M19.5 9.5l5 5-5 5" strokeWidth={1.4} /></>,
  datePriceRange: <><rect x="4.5" y="6.5" width="19" height="15" /><path d="M4.5 13.5h19M13.5 6.5v15" /></>,
  ruler: <><path d="M2.5 17.5L17.5 2.5l8 8-15 15z" strokeWidth={1.4} /><path d="M6.5 13.5l3.5 3.5M10.5 9.5l3.5 3.5M14.5 5.5l3.5 3.5" strokeWidth={1.4} /></>,
  zoomIn: <><circle cx="11.5" cy="11.5" r="7" strokeWidth={1.4} /><path d="M11.5 8v7M8 11.5h7" /><path d="M16.4 16.4L21.5 21" strokeWidth={1.4} /></>,

  // ── shapes: brushes ──
  // A brush HEAD with a paint stroke running off its tip. It was a sine wave
  // with a tick, 11px tall in a 28px box.
  brush: <path d="M18 6.5L16 11l-7.5 1.5L2.5 22.5 14 22l2.5-6-1.5-2.5L27 6" strokeWidth={1.4} />,
  highlighter: <><path d="M16.5 4.5l7 7-9.5 10H7.5l-3-3z" strokeWidth={1.4} /><path d="M4 24.5h20" /></>,

  // ── shapes: arrows ──
  arrowMarker: <><path d="M5.5 22.5L22.5 5.5" strokeWidth={1.4} /><path d="M15 5.5h7.5V13" /></>,
  arrow: <><path d="M4.5 22.5L21 7" strokeWidth={1.4} /><path d="M13.5 6.5h8v8" /></>,
  arrowUp: <path d="M14.5 24V6M7.5 13l7-7 7 7" strokeWidth={1.4} />,
  arrowDown: <path d="M14.5 4v18M7.5 15l7 7 7-7" strokeWidth={1.4} />,

  // ── shapes ──
  rect: <rect x="4.5" y="7.5" width="19" height="14" rx="1" />,
  rotatedRectangle: <path d="M3.5 16.5l8-9.5 13 5-8 9.5z" strokeWidth={1.4} />,
  path: <><path d="M4.5 21.5l6-8.5 4.5 4.5 6.5-9" strokeWidth={1.4} /><path d="M16.5 3.5h7v7" /><circle cx="4.5" cy="21.5" r="1.8" strokeWidth={1.4} /></>,
  circle: <circle cx="14" cy="14" r="8.5" strokeWidth={1.4} />,
  ellipse: <ellipse cx="14" cy="14" rx="10" ry="7" strokeWidth={1.4} />,
  polyline: <><path d="M4.5 21.5l6-8.5 4.5 4.5 8-10.5" strokeWidth={1.4} /><circle cx="4.5" cy="21.5" r="1.8" strokeWidth={1.4} /><circle cx="10.5" cy="13" r="1.8" strokeWidth={1.4} /><circle cx="15" cy="17.5" r="1.8" strokeWidth={1.4} /><circle cx="23" cy="7" r="1.8" strokeWidth={1.4} /></>,
  triangle: <path d="M14 5.5l10.5 17H3.5z" strokeWidth={1.4} />,
  arc: <path d="M4.5 21.5a9.5 9.5 0 0 1 19 0" strokeWidth={1.4} />,
  curve: <path d="M4.5 21.5c4.5-14 14 14 19-7" strokeWidth={1.4} />,
  doubleCurve: <><path d="M4.5 21.5c4.5-14 14 14 19-7" strokeWidth={1.4} /><path d="M4.5 16.5c4.5-9.5 14 9.5 19-4.5" strokeWidth={1.4} /></>,

  // ── annotation ──
  text: <><path d="M7.5 5.5h13M7.5 5.5v3M20.5 5.5v3" /><path d="M14.5 5.5v16" /><path d="M11.5 21.5h6" /></>,
  note: <path d="M4.5 4.5h19v14h-13l-6 5z" strokeWidth={1.4} />,
  priceNote: <><path d="M3.5 14.5h10l3.5-5h7.5v10h-7.5l-3.5-5" strokeWidth={1.4} /><path d="M17.5 12.5h5M17.5 16.5h3" /></>,
  pin: <><path d="M9.5 4.5h9l-2.5 7 3.5 4H7.5l3.5-4z" strokeWidth={1.4} /><path d="M13.5 15.5v9" /></>,
  table: <><rect x="3.5" y="5.5" width="21" height="17" /><path d="M3.5 11.5h21M3.5 17.5h21M10.5 5.5v17M17.5 5.5v17" /></>,
  callout: <path d="M4.5 5.5h19v12h-9l-4 4.5V17.5h-6z" strokeWidth={1.4} />,
  comment: <><path d="M4.5 5.5h19v13h-14l-5 4.5z" strokeWidth={1.4} /><path d="M9 10.5h10M9 14.5h6" /></>,
  pricelabel: <path d="M3.5 14.5h10l3.5-5h7.5v10h-7.5l-3.5-5z" strokeWidth={1.4} />,
  signpost: <><path d="M14.5 24.5V3.5" /><path d="M5.5 6.5h17l-3.5 4.5 3.5 4.5h-17l3.5-4.5z" strokeWidth={1.4} /></>,
  flagMark: <><path d="M7.5 24.5V3.5" /><path d="M7.5 5.5h13l-3.5 4.5 3.5 4.5h-13" strokeWidth={1.4} /></>,

  // ── icons ──
  iconSmiley: <><circle cx="13.5" cy="13.5" r="10" strokeWidth={1.4} /><path d="M10.5 11.5h.01M17.5 11.5h.01" /><path d="M9.5 16.5q4 4 8 0" strokeWidth={1.4} /></>,

  /*
   * ── The Icons picker's category row (R2c-11) ─────────────────────────────
   *
   * The row used to be eight COLOUR EMOJI at 18px — the platform's artwork,
   * at whatever size and hue the operating system felt like, inside a control
   * whose every other glyph is this product's own 28-unit outline set. The
   * reference draws monochrome outline category marks at ~20px and lets the
   * accent bar under the cell say which one is open. These are our own
   * geometry for our own categories, on the same grid as everything above.
   */
  catSmileys: <><circle cx="13.5" cy="13.5" r="9" strokeWidth={1.4} /><path d="M10.5 11.5h.01M16.5 11.5h.01" /><path d="M10 16.5q3.5 3.5 7 0" strokeWidth={1.4} /></>,
  catGestures: <>
    <rect x="4.5" y="12.5" width="4" height="10" rx="1" />
    <path d="M8.5 13l5-7.5a1.8 1.8 0 0 1 3 1.9l-1.3 4.1h5.4a2 2 0 0 1 1.9 2.5l-1.5 5.5a2 2 0 0 1-1.9 2H8.5z" strokeWidth={1.4} />
  </>,
  catMarks: <><circle cx="13.5" cy="13.5" r="9.5" strokeWidth={1.4} /><path d="M13.5 8.5v7" /><path d="M13.5 18.5h.01" /></>,
  catWeather: <>
    <path d="M9 21.5a5 5 0 0 1 .6-9.9 6.2 6.2 0 0 1 11.6 1.7 4.2 4.2 0 0 1-.9 8.2z" strokeWidth={1.4} />
    <path d="M12.5 8.5a4 4 0 0 1 6-2.6" strokeWidth={1.4} />
  </>,
  catMarkets: <><path d="M4.5 22.5h19" /><path d="M8.5 22.5v-6M13.5 22.5v-10M18.5 22.5v-15" /></>,
  catAnimals: <>
    <circle cx="8.5" cy="10.5" r="2.4" strokeWidth={1.4} /><circle cx="14" cy="7.5" r="2.4" strokeWidth={1.4} />
    <circle cx="19.5" cy="10.5" r="2.4" strokeWidth={1.4} />
    <path d="M14 13.5c4.1 0 6.5 2.7 6.5 5.3s-2.9 3.7-6.5 3.7-6.5-1.1-6.5-3.7 2.4-5.3 6.5-5.3z" strokeWidth={1.4} />
  </>,
  catTravel: <>
    <path d="M14 3.5c4.1 3.6 5.6 8.2 5.6 12l-3 3h-5.2l-3-3c0-4 1.5-8.4 5.6-12z" strokeWidth={1.4} />
    <path d="M11.4 19.2L8.5 23.5l3.7-1.1M16.6 19.2l2.9 4.3-3.7-1.1" strokeWidth={1.4} />
  </>,
  catObjects: <>
    <path d="M14 3.5a6.8 6.8 0 0 1 3.5 12.5v3.5h-7v-3.5A6.8 6.8 0 0 1 14 3.5z" strokeWidth={1.4} />
    <path d="M10.5 21.5h7M11.5 24.5h5" />
  </>,
  catArrows: <><path d="M4.5 14.5h17" /><path d="M16 9l5.5 5.5L16 20" strokeWidth={1.4} /></>,
  catShapes: <><rect x="4.5" y="4.5" width="12" height="12" /><circle cx="17.5" cy="17.5" r="6" strokeWidth={1.4} /></>,
  catSigns: <path d="M5 14l5.5 5.5L23 6.5" strokeWidth={1.4} />,
  /* The rail's own favourites cell — the same five-point outline the flyout
     rows star a tool with, at the rail's 28px. */
  starOutline: <path d="M14 3.5l3.1 6.5 7.1 1-5.2 5 1.3 7-6.3-3.4-6.3 3.4 1.3-7-5.2-5 7.1-1z" strokeWidth={1.4} />,
  catStars: <path d="M14 3.5l3.1 6.5 7.1 1-5.2 5 1.3 7-6.3-3.4-6.3 3.4 1.3-7-5.2-5 7.1-1z" strokeWidth={1.4} />,

  // ── options ──
  // A HORSESHOE with two rectangular pole caps. It was a "U" with two side
  // ticks, which reads as a cup.
  magnet: <>
    <path d="M6.5 11.5a7.5 7.5 0 0 1 15 0" strokeWidth={1.4} /><path d="M11.5 11.5a2.5 2.5 0 0 1 5 0" strokeWidth={1.4} />
    <path d="M6.5 11.5v11M11.5 11.5v11M16.5 11.5v11M21.5 11.5v11" />
    <path d="M6.5 18.5h5M16.5 18.5h5M6.5 22.5h5M16.5 22.5h5" />
  </>,
  // A pencil with a PADLOCK badge: the mode that keeps the tool armed. It was
  // a pencil on a baseline, which is the Text tool's grammar.
  stayInDrawingMode: <>
    <path d="M3.5 20.5L13 4l4.5 4.5L8 24.5z" strokeWidth={1.4} /><path d="M6.5 12.5l4.5 4.5" strokeWidth={1.4} />
    <rect x="15.5" y="18.5" width="8" height="6" rx="1" />
    <path d="M17.5 18.5v-2.5a2 2 0 0 1 4 0v2.5" strokeWidth={1.4} />
  </>,
  lock: <><rect x="6.5" y="11.5" width="14" height="10" rx="1.5" /><path d="M9.5 11.5V7.5a4 4 0 0 1 8 0v4" strokeWidth={1.4} /><path d="M13.5 15.5v3" /></>,
  unlock: <><rect x="6.5" y="11.5" width="14" height="10" rx="1.5" /><path d="M9.5 11.5V7.5a4 4 0 0 1 7.3-2.3" strokeWidth={1.4} /><path d="M13.5 15.5v3" /></>,
  // The eye carries a pencil badge at its lower right — the reference's "this
  // layer is hidden" mark. It was a plain eye, 16px tall in a 28px box.
  eye: <>
    <path d="M2.5 9.5C6 6 9.5 4.5 13 4.5s6.5 1.5 10 5c-3.5 3.5-6.5 5-10 5s-7-1.5-10.5-5z" strokeWidth={1.4} />
    <circle cx="13" cy="9.5" r="3.5" strokeWidth={1.4} />
    <path d="M14.5 24.5l1.5-6 7.5-2.5-1 7z" strokeWidth={1.4} />
  </>,
  eyeOff: <>
    <path d="M2.5 9.5C6 6 9.5 4.5 13 4.5s6.5 1.5 10 5c-3.5 3.5-6.5 5-10 5s-7-1.5-10.5-5z" strokeWidth={1.4} />
    <path d="M4 2.5l18 14" strokeWidth={1.4} />
    <path d="M14.5 24.5l1.5-6 7.5-2.5-1 7z" strokeWidth={1.4} />
  </>,
  trash: <><path d="M5.5 7.5h16" /><path d="M10.5 7.5V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" strokeWidth={1.4} /><path d="M7.5 7.5l1 15h10l1-15" strokeWidth={1.4} /></>,
};

/*
 * 28 units at 28px, so one unit is one device pixel and the half-unit
 * coordinates above land a stroke inside a single pixel.
 *
 * ── Two weights, because a pixel grid has two cases (R2c-10) ───────────────
 *
 * The whole set used to be stroked at 1.25. On an axis-aligned segment that
 * is 25% too much paint: a half-unit-aligned vertical covers its own pixel
 * column fully and then bleeds 0.125 into each neighbour, which samples as
 * `66,219,15` instead of the reference's `15,219,15` — a halo either side of
 * every horizontal and vertical in the rail, and roughly twice the reference's
 * lit-pixel count on fib, Long, Lock and Text for exactly the same silhouette.
 *
 * On a 45° diagonal it is not enough of the OTHER kind: a 1.0 stroke covers
 * only ~0.71 of a pixel and peaks near 160, and 1.25 peaks 189 asymmetric.
 * The reference's diagonals read `101,219,101` — a fully lit core with a
 * symmetric halo — which is what 1.4 gives.
 *
 * So the `<svg>` default is 1, for the axis-aligned strokes and the `rect`s,
 * and every path that contains a non-axis segment, every ring and the one
 * ellipse opt in to 1.4. `tests/drawingRail.test.ts` lints both halves of that
 * rule over the whole set, so a new glyph cannot quietly pick the wrong one.
 */
const Icon = ({ name, size = 28 }: { name: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor"
    strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
function Flyout({ className = "", menuLabel, children }: {
  className?: string;
  /**
   * The menu's accessible name.
   *
   * Present for the row lists and ABSENT for the Icons picker, which is a grid
   * of glyphs: `role="menu"` there would promise its cells were `menuitem`s,
   * and they are not. The role is written on the element below rather than
   * taken as a prop, so that `role="menu"` and the `.tvc-menu` material it
   * promises are the same tag — which is what `tests/uiContract.test.ts` reads
   * when it checks that nothing calls itself a menu and then paints its own
   * popover.
   */
  menuLabel?: string;
  children: React.ReactNode;
}) {
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
    /*
     * R2c-04: no margin under a clamped menu.
     *
     * The rule was `viewport - height - 8`, which left an 8px band of page
     * below a menu the reference rests flush on the viewport's bottom edge —
     * Shapes opened at y=148 where it opens at 150, Icons at 213 where it
     * opens at 221. The 8px was a guess at politeness; the reference simply
     * does not leave one. The taller-than-viewport branch above keeps its own
     * 8px, because there the menu is scrolling and the gap is a scroll
     * affordance rather than a margin.
     */
    setTop(Math.min(cell - 6, viewport - height) - cell);
  }, [children]);

  /*
   * The two branches carry the same class string rather than sharing a
   * variable, and that is deliberate: `tests/uiContract.test.ts` reads the
   * TAG that declares `role="menu"` to check it also paints `.tvc-menu`, and a
   * class reaching the element through a lowercase local is a class that rule
   * cannot see. The one thing this popover must never do is call itself a menu
   * while painting its own surface, so the assertion is worth the repetition.
   */
  const scroll = maxHeight === undefined ? "" : "overflow-y-auto ";
  return menuLabel === undefined ? (
    <div ref={ref} style={{ top, maxHeight }}
      className={`absolute left-[53px] z-50 w-max tvc-menu ${scroll}${className}`}
    >{children}</div>
  ) : (
    <div ref={ref} role="menu" aria-label={menuLabel} style={{ top, maxHeight }}
      className={`absolute left-[53px] z-50 w-max tvc-menu ${scroll}${className}`}
    >{children}</div>
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
      {/*
        Category cells: 38×38, the reference's own row above the grid.

        R2c-11: the open one is marked by a 38×4 accent bar along the cell's
        BOTTOM edge, not by a chip. This is the one place in the workstation
        where an accent mark is correct rather than a violation of the
        contract's neutral-chip rule: the bar is an INDICATOR under a row of
        tabs, the shape the reference uses here, and §7c records the exception.
      */}
      <div className="flex shrink-0 gap-0 px-[6px] pt-[6px]">
        {categories.map((c, i) => (
          <button
            key={c.id}
            onClick={() => { setCategory(i); if (gridRef.current) gridRef.current.scrollTop = 0; }}
            aria-label={c.label}
            aria-pressed={i === category}
            data-active={i === category ? "true" : undefined}
            className={
              "relative flex h-[38px] w-[38px] items-center justify-center "
              + "text-ink-muted hover:bg-state-hover data-[active=true]:text-ink"
            }
          >
            <Icon name={c.icon} size={20} />
            {i === category && (
              // accent-is-meaning: a TAB indicator, as the reference draws it.
              <span aria-hidden="true" className="absolute bottom-0 left-0 h-[4px] w-full bg-accent" />
            )}
          </button>
        ))}
      </div>
      {/*
        The section label's block is 34px: 16 above a 13px line box and 5
        below, so the grid's first row starts 78px down the popover
        (6 + 38 + 16 + 13 + 5). Ink 19px in from the popover's edge — x=72 at
        the reference's x=53 origin.
      */}
      <div className="shrink-0 px-[19px] pb-[5px] pt-[16px] text-[11px] leading-[13px] uppercase tracking-[0.04em] text-ink-muted">
        {current.label}
      </div>
      {/* The grid scrolls, the popover does not: the tab bar stays reachable. */}
      <div ref={gridRef} className="min-h-0 flex-1 overflow-y-auto px-[6px]">
        {/*
          R2c-11: a FIXED 37px pitch, not `grid-cols-8`.

          `grid-cols-8` divides whatever width is available into eighths, so
          the cells were 37px wide inside a 42.75px column and the glyph
          centres drifted from the reference's by up to 40px across the row —
          the picker looked sparse and nothing lined up with the category cells
          above it. The reference lays eight 37px columns from its left gutter
          and leaves the remaining ~45px as an empty lane on the right.
        */}
        <div className="grid justify-start" style={{ gridTemplateColumns: "repeat(8, 37px)" }}>
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
      {/*
        The tab bar is 47px under its hairline, and its labels are a CENTRED
        GROUP with 26px between them — not two `flex-1` halves, which put the
        two words at the quarter points of a 354px bar with an acre of nothing
        between them. The open tab is accent ink over a 4px accent underline
        its own width, flush to the bar's bottom edge; the closed one is full
        `text-ink`, not a faint grey (the reference's inactive tab samples 219).
      */}
      <div className="flex h-[47px] shrink-0 items-stretch justify-center gap-[26px] border-t"
        style={{ borderColor: "var(--ts-line-strong)" }}>
        {(["emojis", "icons"] as const).map((id) => (
          <button
            key={id}
            onClick={() => pickTab(id)}
            aria-pressed={tab === id}
            data-active={tab === id ? "true" : undefined}
            /* accent-is-meaning: a TAB, and the reference's picker tints its
               open tab's label and underline with its own accent. The owner's
               endgame addendum §1 settles this surface in TradingView's
               favour; contract §7c records the exception. */
            className="relative flex items-center text-[16px] text-ink data-[active=true]:text-accent"
          >
            <span>{id === "emojis" ? "Emojis" : "Icons"}</span>
            {tab === id && (
              // accent-is-meaning: the open tab's own underline.
              <span aria-hidden="true" className="absolute bottom-0 left-0 h-[4px] w-full bg-accent" />
            )}
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

  /*
   * The long press that opens a group's flyout on a touch screen — see the
   * note on `COARSE_STRIP`. `heldRef` remembers that a hold fired, so the
   * click the browser delivers when the finger lifts is swallowed rather than
   * arming the cell's tool underneath the menu it just opened.
   */
  const holdRef = useRef<{ timer: number; x: number; y: number } | null>(null);
  const heldRef = useRef(false);
  const cancelHold = useCallback(() => {
    if (holdRef.current) window.clearTimeout(holdRef.current.timer);
    holdRef.current = null;
  }, []);
  useEffect(() => cancelHold, [cancelHold]);
  const holdToOpen = (id: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      heldRef.current = false;
      cancelHold();
      if (!isCoarsePress(e)) return;
      holdRef.current = {
        x: e.clientX, y: e.clientY,
        timer: window.setTimeout(() => {
          holdRef.current = null;
          heldRef.current = true;
          setFlyout(id);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const hold = holdRef.current;
      if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > LONG_PRESS_SLOP_PX) cancelHold();
    },
    onPointerUp: cancelHold,
    onPointerCancel: cancelHold,
    onPointerLeave: cancelHold,
  });

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

  /*
   * ── The floating favourites bar (R2c-06) ─────────────────────────────────
   *
   * Starring a tool used to do exactly one thing: fill the star. The list was
   * written to storage, read back on the next mount, and painted nowhere — so
   * the control's whole promise ("keep this one within reach") was kept by no
   * part of the product. The reference answers a star with a small floating
   * toolbar over the chart: a drag grip and one 38px cell per starred tool,
   * each arming its tool on click, on a popover ground with the popover's own
   * radius and shadow. A cell at the FOOT of the rail shows and hides it.
   *
   * `fixed`, not absolute: the bar belongs over the CHART, and the rail is a
   * 52px column that the chart is beside rather than inside. Its position is
   * the user's and is persisted with the open flag under one key.
   */
  const [barOpen, setBarOpen] = useState(true);
  const [barPos, setBarPos] = useState(FAVOURITES_BAR_HOME);
  /** The pointer's offset inside the grip, kept out of state so a drag does not re-render on it. */
  const grabRef = useRef<{ dx: number; dy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const persistBar = useCallback((open: boolean, pos: { x: number; y: number }) => {
    try {
      window.localStorage.setItem(DRAWING_FAVOURITES_BAR_KEY, JSON.stringify({ open, ...pos }));
    } catch { /* best effort */ }
  }, []);

  useEffect(() => {
    let stored: { open?: unknown; x?: unknown; y?: unknown } | null = null;
    try {
      const raw = window.localStorage.getItem(DRAWING_FAVOURITES_BAR_KEY);
      stored = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    } catch { /* unavailable storage is a valid first-run state */ }
    const x = typeof stored?.x === "number" ? stored.x : FAVOURITES_BAR_HOME.x;
    const y = typeof stored?.y === "number" ? stored.y : FAVOURITES_BAR_HOME.y;
    if (stored?.open === false) setBarOpen(false);
    // Clamp: a position saved on a wide monitor must not open off a narrow one.
    setBarPos({
      x: Math.max(56, Math.min(x, Math.max(56, window.innerWidth - 120))),
      y: Math.max(48, Math.min(y, Math.max(48, window.innerHeight - FAVOURITES_CELL))),
    });
  }, []);

  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (e: MouseEvent) => {
      const grab = grabRef.current;
      if (!grab) return;
      setBarPos({ x: e.clientX - grab.dx, y: e.clientY - grab.dy });
    };
    const onUp = () => {
      grabRef.current = null;
      setDragging(false);
      setBarPos((p) => { persistBar(barOpen, p); return p; });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, barOpen, persistBar]);

  /** Every starred tool that still exists on the rail, with its glyph and name. */
  const favouriteTools = useMemo(() => {
    const byTool = new Map<DrawingTool, ToolDef>();
    for (const g of GROUPS) for (const s of g.sections) for (const t of s.tools) byTool.set(t.tool, t);
    return favourites.map((t) => byTool.get(t)).filter((t): t is ToolDef => t !== undefined);
  }, [favourites]);

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
    "tvc-control peer/cell flex h-[38px] w-[52px] items-center justify-center text-ink";

  /**
   * The rail's tooltip, in the product's own chrome (R2b-14, R2c-01, R2c-07).
   *
   * Every rail control used to name itself through the `title` attribute: the
   * OS draws that, half a second late, in a different font on a different
   * ground, and it is the ONE piece of chrome in this workstation that the
   * theme cannot reach. The reference draws a pill — 24px tall, #3d3d3d, 14px
   * WHITE ink, 4px radius, its left edge 1px past the rail — and at once.
   *
   * ── Why the cell's pill is a SIBLING of its button (R2c-01) ───────────────
   *
   * It used to be a CHILD, and it was therefore never painted for any of the
   * fifteen cells. `.tvc-control` carries `isolation: isolate` — load-bearing,
   * because the state chip is a `z-index: -1` pseudo-element that has to sit
   * behind bare text nodes — so a rail button is its own stacking context and
   * nothing inside it, at any `z-index`, can rise above the chart column that
   * comes later in the document. The STRIP's pill worked all along precisely
   * because a strip is not a `.tvc-control`.
   *
   * So the fix is structural rather than a CSS override: the cell's pill is
   * rendered after the button, inside the cell's own `div.group.relative`
   * wrapper, which has no `isolation` and no `z-index` of its own. `z-[60]`
   * then resolves in the root stacking context, as the strip's already did,
   * and `.tvc-control` keeps the isolation every other control depends on.
   *
   * `trigger` is which hover reveals it: `"peer"` for a cell (the button is
   * marked `peer/cell` and the pill follows it), `"group"` for the strip,
   * whose pill is still a child of a `group/tip` button. A cell hover must not
   * light the strip's pill and vice versa, which is exactly what the two
   * different mechanisms buy.
   *
   * `left-full` rather than a fixed offset so the same pill is correct from
   * the 52px cell and from the 11px strip: both are positioned boxes whose
   * right edge is the rail's, so "the rail's width plus 1" is `ml-[1px]` in
   * both. `aria-hidden`, because the control it belongs to already has a NAME
   * — a tooltip that also announced itself would say it twice.
   *
   * ── No pill while a flyout is open (A18) ──────────────────────────────────
   *
   * The flyout opens at the same `left-full`, so the pointer that just opened
   * it is still over the cell or its strip and the pill stayed lit ON TOP of
   * the flyout's header (`z-[60]` over the menu). The reference shows no
   * tooltip while a flyout is open: the flyout names itself. While any flyout
   * is open every pill loses its hover reveal — it stays in the tree, so the
   * structure above is unchanged — and comes back when the flyout closes.
   */
  const tip = (label: string, trigger: "peer" | "group" = "peer") => (
    <span aria-hidden="true" data-rail-tip
      data-suppressed={flyout !== null ? "true" : undefined}
      className={
        "pointer-events-none absolute left-full top-[7px] z-[60] ml-[1px] hidden h-[24px] "
        + "items-center whitespace-nowrap rounded-[4px] px-[7px] "
        + "bg-[var(--ts-tooltip-bg)] text-[14px] leading-none text-white "
        + (flyout !== null ? "" : trigger === "peer" ? "peer-hover/cell:flex" : "group-hover/tip:flex")
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
   *
   * On a coarse pointer it is always shown and its hit area is widened past
   * the rail's edge (`COARSE_STRIP`), because a finger cannot hover.
   */
  const strip = (id: string, title: string) => (
    <button
      onClick={() => setFlyout(flyout === id ? null : id)}
      /* Opening from the keyboard puts focus on the first row, which is what
         makes the arrow travel below reachable without a pointer. */
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        const opening = flyout !== id;
        setFlyout(opening ? id : null);
        setFocusFirstRow(opening);
      }}
      aria-label={`More ${id} tools`}
      aria-expanded={flyout === id}
      data-open={flyout === id ? "true" : undefined}
      className={
        "absolute right-0 top-[2px] flex h-[34px] w-[11px] items-center justify-center "
        + "group/tip rounded-[4px] text-ink opacity-0 transition-none group-hover:opacity-100 "
        + "focus-visible:opacity-100 data-[open=true]:opacity-100 "
        + "hover:bg-state-hover data-[open=true]:bg-state-hover "
        + COARSE_STRIP
      }
    >
      {tip(title, "group")}
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
          /*
           * R2c-13: a `title` only where there is a HINT.
           *
           * It was `t.hint ?? t.label`, so every row of every flyout grew an
           * OS tooltip repeating the label the row already prints — in the OS
           * font, on a ground the theme cannot reach, a second after the
           * pointer settles. The reference shows no native tooltip over a menu
           * row at all. Where a tool has a hint ("Click points, double-click
           * to finish") the tooltip carries information the row does not, and
           * that one stays.
           */
          title={t.hint}
          role="menuitem"
          className="flex min-w-0 flex-1 items-center gap-[5px] pl-[4px] text-left text-sm"
        >
          <Icon name={t.icon} size={28} />
          <span data-tool-label className="whitespace-nowrap">{t.label}</span>
        </button>
        {/*
          R2c-02: the reserved right column is 43px, not 18.
          The menu is sized by its widest row, so this reservation IS the
          menu's width: at 18 the Trend flyout came out 260px against the
          reference's 285, and the whole 25px shortfall was here. With 43 the
          cap's right edge lands 39px from the row's right edge — 45 from the
          panel's, which is where the reference prints it (ink ending x=293 on
          a 338 panel).
        */}
        <div className="ml-[43px] flex shrink-0 items-center">
          {binding && (
            /* 12px and #8c8c8c, the sampled cap: at 11px it read as a footnote
               rather than as the chord it is. See `keyCap` for the spacing.
               `mr-[5px]`: 6px row gutter + 28px star lane + 5 = 39. */
            <kbd className="mr-[5px] whitespace-nowrap font-sans text-[12px] leading-none text-ink-faint">
              {keyCap(binding, mac)}
            </kbd>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); toggleFavourite(t.tool); }}
            aria-label={starred ? "Remove from favourites" : "Add to favourites"}
            aria-pressed={starred}
            data-starred={starred ? "true" : undefined}
            title={starred ? "Remove from favourites" : "Add to favourites"}
            /* R2c-06: a starred row's star sits on the 28px active chip, as
               the reference's does, and the menu stays open so a second tool
               can be starred without reopening it. */
            className={
              "mr-[6px] flex h-7 w-7 shrink-0 items-center justify-center rounded text-[15px] "
              + "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 "
              + "data-[starred=true]:opacity-100 data-[starred=true]:bg-state-active "
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

  /**
   * A 32px option row — the reference's compact scope menus.
   *
   * R2c-12: `px-[8px]`, not `px-3`. The reference's Hide flyout is 193px wide
   * for "Hide positions and orders"; at 12px of row padding either side this
   * one came out 201.4 for the same string, and the whole 8px was the padding.
   */
  const optionRow = (key: string, label: string, on: boolean, run: () => void) => (
    <button
      key={key}
      onClick={() => { run(); setFlyout(null); }}
      aria-label={label}
      aria-pressed={on}
      role="menuitemradio"
      data-active={on ? "true" : undefined}
      className="tvc-menu-row whitespace-nowrap px-[8px] text-left text-sm text-ink"
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

  /*
   * ── R2c-05: the flyout takes the keyboard ────────────────────────────────
   *
   * Three things were missing and all three are the same omission: an open
   * flyout was a mouse-only object. Escape did nothing to it (worse, the
   * global `tool:cursor` binding fired and dropped the armed TOOL, so the one
   * key everybody presses to dismiss a menu dismissed something else and left
   * the menu standing); the arrow keys moved nothing; and opening a flyout
   * from the keyboard left focus on the strip behind it.
   *
   * `rows()` reads the DOM rather than an index kept in state on purpose. A
   * flyout's rows are assembled from sections, headings, separators and — in
   * three of them — a footer switch that is only rendered when the page wired
   * it; any count held in React would be a second model of that, and the one
   * that goes stale. What the user can reach is what is rendered.
   */
  const menuRows = useCallback((): HTMLElement[] => {
    const menu = railRef.current?.querySelector<HTMLElement>(".tvc-menu");
    if (!menu) return [];
    return [...menu.querySelectorAll<HTMLElement>(
      '[role="menuitem"], [role="menuitemradio"], [role="switch"]')];
  }, []);

  /** Set when a flyout is opened from the keyboard, so the first row takes focus. */
  const [focusFirstRow, setFocusFirstRow] = useState(false);
  useEffect(() => {
    if (!flyout || !focusFirstRow) return;
    menuRows()[0]?.focus();
    setFocusFirstRow(false);
  }, [flyout, focusFirstRow, menuRows]);

  const onRailKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!flyout) return;
    if (e.key === "Escape") {
      /*
       * Stopped, not merely handled. `useShortcuts` listens on `window` and
       * binds Escape to `tool:cursor`; React 18 dispatches from the root
       * container, which is inside `body`, so stopping propagation here is
       * what keeps one Escape from doing two things. The reference closes the
       * menu first and leaves the tool armed.
       */
      e.preventDefault();
      e.stopPropagation();
      const opener = railRef.current?.querySelector<HTMLElement>(
        `button[aria-label="More ${flyout} tools"]`);
      setFlyout(null);
      opener?.focus();
      return;
    }
    const rows = menuRows();
    if (rows.length === 0) return;
    const here = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      const next = e.key === "Home" ? 0
        : e.key === "End" ? rows.length - 1
          : e.key === "ArrowDown" ? (here < 0 ? 0 : (here + 1) % rows.length)
            : (here < 0 ? rows.length - 1 : (here - 1 + rows.length) % rows.length);
      rows[next]?.focus();
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && here >= 0) {
      e.preventDefault();
      e.stopPropagation();
      rows[here]!.click();
    }
  };

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
      onKeyDown={onRailKeyDown}
      /*
       * No `border-r`: the shell draws a 4px `--ts-bg` gutter to the right of
       * this column (R2b-13), so a hairline here would be a second boundary
       * inside it. And `pt-[6px]`, not 10 — the toolbar row above now ends in
       * that same 4px gutter rather than in a 1px hairline, so 6px of rail
       * padding is what still puts the first cell at y=48.
       */
      className="relative flex w-[52px] shrink-0 flex-col items-center bg-surface pt-[6px]"
    >
      {GROUPS.map((group) => {
        const tools = group.sections.flatMap((s) => s.tools);
        const current = tools.find((t) => t.tool === active[group.id]) ?? tools[0]!;
        const groupOn = tools.some((t) => t.tool === tool);
        const isIcons = group.id === "icons";
        return (
          <div key={group.id} className="group relative">
            <button
              onClick={() => {
                if (heldRef.current) { heldRef.current = false; return; }
                onTool(current.tool);
              }}
              onContextMenu={(e) => { e.preventDefault(); setFlyout(group.id); }}
              {...holdToOpen(group.id)}
              className={`${btn()} ${COARSE_CELL}`}
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
              <Icon name={current.icon} />
            </button>
            {tip(current.label)}
            {strip(group.id, group.title)}
            {flyout === group.id && (isIcons ? (
              <Flyout className="!p-0">
                <IconPicker onPick={(glyph) => {
                  armIconGlyph(glyph); onTool("icon"); setFlyout(null);
                }} />
              </Flyout>
            ) : (
              /*
               * R2c-03: 30px, not 24.
               *
               * `!pt-[24px]` REPLACES `.tvc-menu`'s own 6px of top padding
               * rather than adding to it — the `!` is there precisely because
               * the menu's rule outscores a utility — so the comment that
               * promised "24 on top of 6" was describing arithmetic the
               * cascade never performed, and every tool flyout opened with its
               * first row 6px too high and stood 6px short. The reference's
               * first row starts 30px below the panel's top edge (110 on an 80
               * panel), so the replacement value is the whole 30.
               */
              <Flyout menuLabel={group.title} className="!pt-[30px]">
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

      {/*
        R2c-01: Measure and Zoom in had no wrapper at all, so there was nowhere
        for their pill to be a sibling OF. They get the same `relative` cell
        wrapper the group and option cells have.
      */}
      {SINGLES.map((single) => (
        <div key={single.id} className="group relative">
          <button
            onClick={() => onTool(single.tool)}
            className={btn()}
            aria-pressed={tool === single.tool}
            aria-label={single.label}
          >
            <Icon name={single.icon} />
          </button>
          {tip(single.label)}
        </div>
      ))}

      {sep}

      <div className="group relative">
        <button
          onClick={() => (onMagnetMode
            ? onMagnetMode(magnetOn ? "off" : (magnetMode === "strong" ? "strong" : "weak"))
            : onMagnet(!magnet))}
          className={btn()} data-switch="" aria-pressed={magnetOn}
          aria-label={magnetOn ? "Turn the magnet off" : "Turn the magnet on"}>
          <Icon name="magnet" />
        </button>
        {tip(magnetOn ? "Magnet on — anchors snap to OHLC" : "Magnet off")}
        {strip("magnet", "Magnets")}
        {flyout === "magnet" && (
          <Flyout menuLabel="Magnets" className="tvc-menu--compact">
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
          className={btn()} data-switch="" aria-pressed={stayInDrawingMode}
          aria-label={stayInDrawingMode ? "Turn off keep drawing" : "Keep drawing"}>
          <Icon name="stayInDrawingMode" />
        </button>
        {tip(stayInDrawingMode
          ? "Keeping the tool armed after each drawing"
          : "Keep drawing")}
      </div>

      <div className="group relative">
        <button onClick={() => (onLockScope ? onLockScope("drawings") : onLocked(!locked))}
          className={btn()} data-switch="" aria-pressed={lockScope ? lockScope !== "none" : locked}
          aria-label={locked ? "Unlock all drawings" : "Lock drawings and indicators"}>
          <Icon name={(lockScope ? lockScope !== "none" : locked) ? "lock" : "unlock"} />
        </button>
        {tip(locked ? "Drawings locked" : "Lock drawings and indicators")}
        {strip("lock", "Lock options")}
        {flyout === "lock" && (
          <Flyout menuLabel="Lock options" className="tvc-menu--compact">
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
          className={btn()} data-switch="" aria-pressed={hideScope ? hideScope !== "none" : hidden}
          aria-label={hidden ? "Show all drawings" : "Hide all drawings"}>
          <Icon name={(hideScope ? hideScope !== "none" : hidden) ? "eyeOff" : "eye"} />
        </button>
        {tip(hidden ? "Drawings hidden" : "Hide all drawings")}
        {strip("hide", "Hide options")}
        {flyout === "hide" && (
          <Flyout menuLabel="Hide options" className="tvc-menu--compact">
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
          <Icon name="trash" />
        </button>
        {tip("Remove objects")}
        {strip("remove", "Remove options")}
        {flyout === "remove" && (
          <Flyout menuLabel="Remove options" className="tvc-menu--compact">
            {removeRows.map((row) => optionRow(row.key, row.label, false, row.run))}
            {footerSwitch("Always remove locked drawings", optionSwitches?.alwaysRemoveLocked)}
          </Flyout>
        )}
      </div>

      {/*
        ── The favourites cell, at the foot of the rail (R2c-06) ─────────────

        Present only while something is starred, which is the reference's rule
        and the honest one: a control that shows and hides an empty bar is a
        control with nothing to do.
      */}
      {favouriteTools.length > 0 && (
        <div className="group relative">
          <button
            onClick={() => { setBarOpen((v) => { persistBar(!v, barPos); return !v; }); }}
            className={btn()}
            aria-pressed={barOpen}
            aria-label={barOpen ? "Hide the favourite tools bar" : "Show the favourite tools bar"}
          >
            <Icon name="starOutline" />
          </button>
          {tip(barOpen ? "Hide the favourite tools bar" : "Show the favourite tools bar")}
        </div>
      )}

      {/*
        ── The floating favourites bar itself ───────────────────────────────

        `fixed` and outside the rail's own flow: it belongs over the chart.
        The grip is 24px, each cell 38 — the reference's 62px for one
        favourite — on the popover ground with the popover's radius and shadow,
        so it reads as the same material as a flyout rather than as a second
        rail.
      */}
      {barOpen && favouriteTools.length > 0 && (
        <div
          data-drawing-favourites="true"
          role="toolbar"
          aria-label="Favourite drawing tools"
          style={{
            left: barPos.x, top: barPos.y,
            background: "var(--ts-surface-2)", boxShadow: "var(--ts-popover-shadow)",
          }}
          className="fixed z-30 flex h-[38px] items-stretch overflow-hidden rounded-[6px]"
        >
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              grabRef.current = { dx: e.clientX - barPos.x, dy: e.clientY - barPos.y };
              setDragging(true);
            }}
            aria-label="Move the favourite tools bar"
            style={{ width: FAVOURITES_GRIP_WIDTH }}
            className="flex cursor-grab items-center justify-center text-ink-faint hover:text-ink"
          >
            {/* Six dots — the reference's grip, and the one mark in this
                product that means "drag me" rather than "press me". */}
            <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true">
              <circle cx="2" cy="3" r="1" /><circle cx="6" cy="3" r="1" />
              <circle cx="2" cy="7" r="1" /><circle cx="6" cy="7" r="1" />
              <circle cx="2" cy="11" r="1" /><circle cx="6" cy="11" r="1" />
            </svg>
          </button>
          {favouriteTools.map((t) => (
            <button
              key={t.tool}
              onClick={() => onTool(t.tool)}
              className="tvc-control flex items-center justify-center text-ink"
              style={{ width: FAVOURITES_CELL, height: FAVOURITES_CELL }}
              aria-pressed={tool === t.tool}
              aria-label={t.label}
            >
              <Icon name={t.icon} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
