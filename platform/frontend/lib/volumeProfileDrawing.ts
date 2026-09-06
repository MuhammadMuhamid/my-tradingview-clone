"use client";
/**
 * Fixed Range Volume Profile: a drawing that computes.
 *
 * ── Why a drawing ──────────────────────────────────────────────────────────
 *
 * Because its defining input is a SPAN of the chart. "Profile from here to
 * here" is chosen by dragging across the plot and adjusted by moving the two
 * edges; there is no number in a dialog that says it. Making it a drawing
 * gives it the anchors, the drag, the selection, the per-instrument scoping,
 * the undo history and the persistence that drawings already have — the same
 * argument that made Anchored VWAP one.
 *
 * Its sibling, the visible-range profile, is a STUDY (`lib/native/profile`),
 * because "whatever is on screen" is not a decision the user makes on the
 * chart; it is a consequence of where they scrolled.
 *
 * ── What it does not take from the drawing layer ───────────────────────────
 *
 * Its rendering. The canvas draws the range's edges and its handles, because
 * those are the grabbable part; the histogram is a `ChartProfileDecoration`
 * painted by the same layer that paints the study's, so the two profiles
 * cannot drift apart in appearance or in arithmetic.
 *
 * ── No lookahead, in Replay or out of it ───────────────────────────────────
 *
 * The profile is computed over exactly the bars it is handed, and the pane
 * hands it the REPLAY-CLIPPED bars. A range whose right edge is past the
 * replay horizon profiles the bars up to the horizon and nothing after it,
 * because those bars are not in the array.
 */
import { PRICE_PANE_ID, type ChartOverlay, type ChartProfileDecoration } from "@/lib/chartSeries";
import type { Drawing } from "@/lib/drawings";
import { PROFILE_COLORS } from "@/lib/native/profile";
import { resolutionMs, type Resolution } from "@/lib/resolution";
import type { Candle } from "@/lib/types";
import {
  barsInRange, computeVolumeProfile, normalizeProfileSettings,
  type VolumeProfile,
} from "@/lib/volumeProfile";

/** The tool id. Two anchors: the edges of the range. */
export const VP_RANGE_TOOL = "vprange";

/** What a fixed range profiles when its style says nothing. */
export const DEFAULT_VP_RANGE_STYLE = {
  layout: "rows" as const,
  rowSize: 24,
  valueAreaPercent: 70,
  allocation: "range" as const,
  split: "total" as const,
  side: "right" as const,
  widthPercent: 30,
  showValueArea: true,
  showPoc: true,
};

/** One fixed range, resolved: which bars, and the profile of them. */
export interface FixedRangeProfile {
  drawingId: string;
  fromMs: number;
  toMs: number;
  profile: VolumeProfile;
}

/**
 * The profile of every fixed range on this instrument.
 *
 * Returned as a list rather than folded straight into decorations because the
 * pane needs the profiles themselves too — for the levels, and for the readout
 * that says which bars each one covers and at what resolution they were taken.
 */
export function fixedRangeProfiles(
  drawings: readonly Drawing[], candles: readonly Candle[], interval: Resolution
): FixedRangeProfile[] {
  if (candles.length === 0) return [];
  const out: FixedRangeProfile[] = [];
  for (const drawing of drawings) {
    if (drawing.tool !== VP_RANGE_TOOL) continue;
    if (drawing.hidden) continue;
    const a = drawing.points[0]?.time;
    const b = drawing.points[1]?.time ?? a;
    if (a === undefined || b === undefined) continue;
    const fromMs = Math.min(a, b) * 1000;
    const toMs = Math.max(a, b) * 1000;
    const bars = barsInRange(candles, fromMs, toMs);
    const settings = normalizeProfileSettings({
      layout: drawing.style.profile?.layout,
      rowSize: drawing.style.profile?.rowSize ?? DEFAULT_VP_RANGE_STYLE.rowSize,
      valueAreaPercent:
        drawing.style.profile?.valueAreaPercent ?? DEFAULT_VP_RANGE_STYLE.valueAreaPercent,
      allocation: drawing.style.profile?.allocation,
    });
    out.push({
      drawingId: drawing.id,
      fromMs, toMs,
      profile: computeVolumeProfile(bars, settings, interval, "chart"),
    });
  }
  return out;
}

/** Presentation for one fixed range, defaulted from its own style. */
function presentation(drawing: Drawing) {
  const p = drawing.style.profile ?? {};
  return {
    side: p.side === "left" ? ("left" as const) : ("right" as const),
    widthRatio: Math.max(0.05, Math.min(0.9,
      (typeof p.widthPercent === "number" && Number.isFinite(p.widthPercent)
        ? p.widthPercent : DEFAULT_VP_RANGE_STYLE.widthPercent) / 100)),
    split: p.split === "upDown" ? ("upDown" as const) : ("total" as const),
    showValueArea: p.showValueArea !== false,
    showPoc: p.showPoc !== false,
  };
}

/**
 * The histogram for every fixed range, as chart decorations.
 *
 * The range is drawn to the CLOSE of its last bar rather than to that bar's
 * open, because a profile that stopped a bar short of the span it summarises
 * would be visibly wrong at the right edge and, on a two-bar range, wrong by
 * half.
 */
export function fixedRangeDecorations(
  drawings: readonly Drawing[], candles: readonly Candle[], interval: Resolution
): ChartProfileDecoration[] {
  const byId = new Map(drawings.map((d) => [d.id, d]));
  const step = resolutionMs(interval);
  const out: ChartProfileDecoration[] = [];
  for (const found of fixedRangeProfiles(drawings, candles, interval)) {
    const drawing = byId.get(found.drawingId);
    if (!drawing) continue;
    const { profile } = found;
    if (profile.rows.length === 0 || profile.from === null || profile.to === null) continue;
    out.push({
      kind: "profile",
      id: `vprange:${drawing.id}`,
      paneId: PRICE_PANE_ID,
      title: "Fixed Range Volume Profile",
      from: Math.floor(profile.from / 1000),
      to: Math.floor((profile.to + step) / 1000),
      rows: profile.rows,
      pocIndex: profile.pocIndex,
      valueAreaRows: profile.valueAreaRows,
      peakVolume: profile.peakVolume,
      // A fixed range HAS edges the reader chose, so it shows them. A visible
      // range's edges are the edges of the pane, and outlining those is noise.
      showRange: true,
      colors: {
        ...PROFILE_COLORS,
        // The drawing's own colour, so the palette swatches on the style bar
        // change something the reader can see.
        valueArea: drawing.style.color,
      },
      ...presentation(drawing),
    });
  }
  return out;
}

/**
 * The point of control and value-area edges of each fixed range, as overlays.
 *
 * Series rather than canvas strokes, so they land on the price scale, in the
 * legend and at the instrument's precision — the same reason Anchored VWAP's
 * line is an overlay rather than something the drawing layer paints. Defined
 * only over the bars the range covers, so a level never claims to describe a
 * bar its profile never saw.
 */
export function fixedRangeOverlays(
  drawings: readonly Drawing[], candles: readonly Candle[], interval: Resolution,
  precision: number
): ChartOverlay[] {
  if (candles.length === 0) return [];
  const times = candles.map((c) => Math.floor(c.openTime / 1000));
  const out: ChartOverlay[] = [];
  for (const found of fixedRangeProfiles(drawings, candles, interval)) {
    const { profile } = found;
    if (profile.poc === null) continue;
    const label = `${profile.bars} bar${profile.bars === 1 ? "" : "s"}`;
    const levels: [string, string, number | null, string, boolean][] = [
      ["poc", "POC", profile.poc, PROFILE_COLORS.poc, false],
      ["vah", "VAH", profile.valueAreaHigh, PROFILE_COLORS.valueArea, true],
      ["val", "VAL", profile.valueAreaLow, PROFILE_COLORS.valueArea, true],
    ];
    for (const [id, title, value, color, dashed] of levels) {
      if (value === null) continue;
      out.push({
        id: `vprange:${found.drawingId}:${id}`,
        title,
        color,
        width: id === "poc" ? 2 : 1,
        dashed,
        style: "line",
        paneId: PRICE_PANE_ID,
        instanceId: `vprange:${found.drawingId}`,
        instanceTitle: "Fixed Range Volume Profile",
        instanceParams: label,
        precision,
        data: times.map((time, i) => ({
          time,
          value: candles[i]!.openTime >= found.fromMs && candles[i]!.openTime <= found.toMs
            ? value : null,
        })),
      });
    }
  }
  return out;
}
