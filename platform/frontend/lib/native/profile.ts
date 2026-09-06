"use client";
/**
 * Volume profiles that are STUDIES.
 *
 * ── Which of the two profiles belongs here ─────────────────────────────────
 *
 * The visible-range one. Its range is "whatever is on screen", which is not a
 * decision the user makes on the chart — it is a consequence of where they
 * scrolled — so it has no anchor to drag and nothing a drawing would give it.
 * It is applied from the Indicators browser, tuned in the generated settings
 * dialog, listed in the legend and persisted per pane, all of which it gets by
 * being an ordinary entry in this registry.
 *
 * The FIXED-range one is a drawing (`lib/volumeProfileDrawing`), for the same
 * reason Anchored VWAP is: its defining input is a span of the chart, chosen
 * by dragging across it.
 *
 * ── What makes this study unlike every other one ───────────────────────────
 *
 * Two things, both declared rather than special-cased:
 *
 *   `usesVisibleRange`  its answer depends on which bars are on screen, so it
 *                       is handed the exact range and its memo key follows it.
 *                       Every other study keeps the coarse 200-bar viewport
 *                       key that stops a pan from recomputing the pane.
 *
 *   `profiles`          its main output is not a series in time. The three
 *                       plots below — point of control, value-area high and
 *                       low — ARE series, which is why they exist: they put the
 *                       profile's conclusions on the price scale, in the
 *                       legend, and within reach of the style dialog, while
 *                       the histogram itself is painted against price.
 *
 * ── Honesty about resolution ───────────────────────────────────────────────
 *
 * This study profiles the bars the pane is drawing and says so. It does not
 * fetch a finer resolution behind the user's back, and it does not pretend a
 * daily bar's volume traded at its close. See `lib/volumeProfile` for what
 * each bar's volume is actually taken to mean.
 */
import {
  barsInRange, computeVolumeProfile, normalizeProfileSettings,
  MAX_ROWS, MAX_VALUE_AREA, MIN_ROWS, MIN_VALUE_AREA,
  type VolumeProfile,
} from "@/lib/volumeProfile";
import type { NativeStudyDef } from "./registry";
import { ACCENT, AMBER, DOWN, MUTED, UP, bool, num, str } from "./shared";
import type { Candle } from "@/lib/types";

/** Shared by the study and the drawing, so both draw the same profile. */
export const PROFILE_COLORS = {
  total: MUTED,
  up: UP,
  down: DOWN,
  valueArea: ACCENT,
  poc: AMBER,
} as const;

/** The presentation inputs both profiles offer, in one place. */
export const PROFILE_INPUTS = [
  {
    kind: "number", key: "rowSize", title: "Rows", defval: 24,
    min: 0.000001, max: 100000, integer: false,
  },
  {
    kind: "number", key: "valueArea", title: "Value area %", defval: 70,
    min: MIN_VALUE_AREA, max: MAX_VALUE_AREA, integer: true,
  },
  {
    kind: "number", key: "width", title: "Width %", defval: 30,
    min: 5, max: 90, integer: true,
  },
  {
    kind: "select", key: "layout", title: "Row layout", defval: "rows",
    options: [
      { value: "rows", label: `Number of rows (${MIN_ROWS}–${MAX_ROWS})` },
      { value: "height", label: "Row height, in price" },
    ],
  },
  {
    kind: "select", key: "allocation", title: "Volume placement", defval: "range",
    options: [
      { value: "range", label: "Spread across each bar's high–low" },
      { value: "close", label: "All of it at each bar's close" },
    ],
  },
  {
    kind: "select", key: "split", title: "Rows show", defval: "total",
    options: [
      { value: "total", label: "Total volume" },
      { value: "upDown", label: "Up and down volume" },
    ],
  },
  {
    kind: "select", key: "side", title: "Drawn from", defval: "right",
    options: [
      { value: "right", label: "The right of the range" },
      { value: "left", label: "The left of the range" },
    ],
  },
  { kind: "boolean", key: "showValueArea", title: "Highlight value area", defval: true },
  { kind: "boolean", key: "showPoc", title: "Point of control line", defval: true },
] as const;

/** Read the profile settings a parameter set describes. */
export function profileSettingsFrom(params: Record<string, unknown>) {
  const p = params as Parameters<typeof num>[0];
  return normalizeProfileSettings({
    layout: str(p, "layout", "rows") === "height" ? "height" : "rows",
    rowSize: num(p, "rowSize", 24),
    valueAreaPercent: num(p, "valueArea", 70),
    allocation: str(p, "allocation", "range") === "close" ? "close" : "range",
  });
}

/** How a parameter set says the profile should be drawn. */
export function profilePresentationFrom(params: Record<string, unknown>) {
  const p = params as Parameters<typeof num>[0];
  return {
    side: (str(p, "side", "right") === "left" ? "left" : "right") as "left" | "right",
    widthRatio: Math.max(0.05, Math.min(0.9, num(p, "width", 30) / 100)),
    split: (str(p, "split", "total") === "upDown" ? "upDown" : "total") as "total" | "upDown",
    showValueArea: bool(p, "showValueArea", true),
    showPoc: bool(p, "showPoc", true),
  };
}

/**
 * The point of control, value-area high and value-area low, as series.
 *
 * Defined only over the bars the profile actually covers and `NaN` elsewhere,
 * so the lines stop where the range does rather than running across a chart
 * they say nothing about. That is also what makes them readable as levels: a
 * value-area high drawn over bars outside the range would claim the area
 * describes those bars too.
 */
export function profileLevelPlots(
  candles: readonly Candle[], profile: VolumeProfile
): Record<string, number[]> {
  const poc: number[] = [];
  const vah: number[] = [];
  const val: number[] = [];
  const from = profile.from;
  const to = profile.to;
  for (const candle of candles) {
    const inside = from !== null && to !== null
      && candle.openTime >= from && candle.openTime <= to;
    poc.push(inside && profile.poc !== null ? profile.poc : Number.NaN);
    vah.push(inside && profile.valueAreaHigh !== null ? profile.valueAreaHigh : Number.NaN);
    val.push(inside && profile.valueAreaLow !== null ? profile.valueAreaLow : Number.NaN);
  }
  return { poc, vah, val };
}

export const PROFILE_PLOTS = [
  { id: "poc", title: "POC", style: "line", color: AMBER, width: 2 },
  { id: "vah", title: "VAH", style: "line", color: ACCENT, width: 1, dashed: true },
  { id: "val", title: "VAL", style: "line", color: ACCENT, width: 1, dashed: true },
] as const;

const visibleRangeProfile: NativeStudyDef = {
  id: "vrvp",
  name: "Visible Range Volume Profile",
  aliases: ["vrvp", "vpvr", "volume profile", "visible range", "market profile"],
  category: "volume",
  overlay: true,
  description:
    "Volume traded at each price across the bars currently on screen, with its "
    + "point of control and value area. Recomputed as you pan and zoom.",
  inputs: PROFILE_INPUTS,
  plots: PROFILE_PLOTS,
  precision: null,
  /*
   * Nothing. A profile is a summary of the bars it is given, so a lead-in
   * would only widen the range it summarises — which for THIS study is the
   * one thing that must stay exactly what the user can see.
   */
  warmup: () => 0,
  usesVisibleRange: true,
  compute: ({ candles, params, interval, visibleRange }) => {
    const settings = profileSettingsFrom(params);
    const presentation = profilePresentationFrom(params);
    const range = visibleRange
      ? barsInRange(candles, visibleRange.fromMs, visibleRange.toMs)
      : candles;
    const profile = computeVolumeProfile(range, settings, interval, "chart");
    return {
      plots: profileLevelPlots(candles, profile),
      profiles: profile.rows.length === 0 ? [] : [{
        id: "vp",
        profile,
        ...presentation,
        // A visible range has no edges worth outlining: they are the edges of
        // the pane, and a dashed line down each side of the chart is noise.
        showRange: false,
        colors: { ...PROFILE_COLORS },
      }],
    };
  },
};

export const PROFILE_STUDIES: readonly NativeStudyDef[] = [visibleRangeProfile];
