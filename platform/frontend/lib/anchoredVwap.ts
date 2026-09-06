"use client";
/**
 * Anchored VWAP: a drawing that computes.
 *
 * ── Why it is a drawing and not a study ────────────────────────────────────
 *
 * Because its defining input is a POINT ON THE CHART. A study's inputs are
 * numbers in a dialog; an anchored VWAP's input is "from here", chosen by
 * clicking a bar and moved by dragging it. Making it a drawing gives it the
 * anchor, the drag, the selection, the per-instrument scoping and the
 * persistence that drawings already have, instead of inventing a parallel
 * mechanism for one indicator.
 *
 * What it does NOT take from the drawing layer is its rendering. The canvas
 * draws the anchor; the line itself is a chart overlay, so it sits on the
 * price scale, joins the legend, respects precision, and is drawn by the same
 * renderer as every other series rather than by hand onto a canvas.
 *
 * ── No lookahead, in Replay or out of it ───────────────────────────────────
 *
 * The accumulation runs over exactly the bars it is given, and the pane gives
 * it the REPLAY-CLIPPED bars. So at a replay horizon the anchored VWAP is the
 * value it would have had at that moment — it cannot see a bar the session has
 * not reached, because that bar is not in the array.
 *
 * ── The bands ──────────────────────────────────────────────────────────────
 *
 * Volume-weighted standard deviation of price around the running VWAP, which
 * is the deviation that belongs to a volume-weighted mean. Using an unweighted
 * `stdev` of price would produce bands that ignore the weighting the centre
 * line is built from, and that disagree with it most exactly where volume was
 * most concentrated.
 */
import { anchoredVwap, anchoredVwapDeviation } from "@/lib/ta/core";
import type { ChartOverlay } from "@/lib/chartSeries";
import { PRICE_PANE_ID } from "@/lib/chartSeries";
import type { Drawing } from "@/lib/drawings";
import type { Candle } from "@/lib/types";

/** The tool id. One anchor, chosen by clicking a bar. */
export const AVWAP_TOOL = "avwap";

/** How many standard-deviation bands an anchored VWAP draws. */
export type AvwapBands = 0 | 1 | 2;

export function avwapBands(drawing: Drawing): AvwapBands {
  const bands = drawing.style.bands;
  return bands === 1 ? 1 : bands === 2 ? 2 : 0;
}

/**
 * The bar an anchor sits on.
 *
 * The anchor is stored as a chart time in seconds, like every drawing anchor,
 * so it survives pan, zoom, a timeframe change and a history reload. Resolving
 * it to an index is therefore a search rather than a lookup — and the answer
 * is the LAST bar at or before the anchor, so an anchor dropped between two
 * bars belongs to the one that had already opened.
 */
export function anchorBarIndex(candles: readonly Candle[], anchorTimeSeconds: number): number {
  const target = anchorTimeSeconds * 1000;
  let low = 0;
  let high = candles.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (candles[mid]!.openTime <= target) { found = mid; low = mid + 1; }
    else high = mid - 1;
  }
  // An anchor before the loaded window anchors at the first bar the chart has,
  // which is the honest answer: the series starts where the data does.
  return found < 0 ? (candles.length > 0 ? 0 : -1) : found;
}

/**
 * Chart overlays for every anchored VWAP on this instrument.
 *
 * One overlay per line, namespaced by the drawing's own id, so two anchored
 * VWAPs never collide in the chart's series map and removing one removes
 * exactly its own lines.
 */
export function anchoredVwapOverlays(
  drawings: readonly Drawing[], candles: readonly Candle[], precision: number
): ChartOverlay[] {
  if (candles.length === 0) return [];
  const times = candles.map((c) => Math.floor(c.openTime / 1000));
  const typical = candles.map((c) => (c.high + c.low + c.close) / 3);
  const volume = candles.map((c) => c.volume);
  const out: ChartOverlay[] = [];

  for (const drawing of drawings) {
    if (drawing.tool !== AVWAP_TOOL) continue;
    const anchorTime = drawing.points[0]?.time;
    if (anchorTime === undefined) continue;
    const index = anchorBarIndex(candles, anchorTime);
    if (index < 0) continue;

    const line = anchoredVwap(typical, volume, index);
    const color = drawing.style.color;
    const width = drawing.style.width;
    /*
     * An anchor older than the loaded window resolves to the first bar there
     * is, which is the honest answer — the series starts where the data does —
     * but it is not where the user put it, and the line MOVES when more
     * history loads. So the legend says so rather than presenting a resolved
     * anchor as the chosen one.
     */
    const beforeHistory = anchorTime * 1000 < candles[0]!.openTime;
    const label = anchorLabel(candles[index]!.openTime)
      + (beforeHistory ? " (from the oldest loaded bar)" : "");

    out.push({
      id: `avwap:${drawing.id}`,
      title: `AVWAP ${label}`,
      color,
      width,
      style: "line",
      paneId: PRICE_PANE_ID,
      instanceId: `avwap:${drawing.id}`,
      instanceTitle: "Anchored VWAP",
      instanceParams: label,
      precision,
      data: times.map((time, i) => ({
        time, value: Number.isFinite(line[i]!) ? line[i]! : null,
      })),
    });

    const bands = avwapBands(drawing);
    if (bands === 0) continue;
    const dev = anchoredVwapDeviation(typical, volume, index);
    for (let k = 1; k <= bands; k++) {
      for (const sign of [1, -1] as const) {
        out.push({
          id: `avwap:${drawing.id}:${sign > 0 ? "u" : "l"}${k}`,
          title: `${sign > 0 ? "+" : "-"}${k}σ`,
          color,
          width: 1,
          dashed: true,
          style: "line",
          paneId: PRICE_PANE_ID,
          instanceId: `avwap:${drawing.id}`,
          instanceTitle: "Anchored VWAP",
          instanceParams: label,
          precision,
          data: times.map((time, i) => {
            const centre = line[i]!;
            const spread = dev[i]!;
            return {
              time,
              value: Number.isFinite(centre) && Number.isFinite(spread)
                ? centre + sign * k * spread : null,
            };
          }),
        });
      }
    }
  }
  return out;
}

/** `2026-09-05 14:30` in UTC, the same clock the chart's axis uses. */
function anchorLabel(openTime: number): string {
  const d = new Date(openTime);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * The current value of each anchored VWAP, for the legend and a readout.
 *
 * `null` where the accumulation has no volume to weight by — an anchor on a
 * bar with zero traded volume, which does happen on thin pairs.
 */
export function anchoredVwapValues(
  drawings: readonly Drawing[], candles: readonly Candle[]
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (candles.length === 0) return out;
  const typical = candles.map((c) => (c.high + c.low + c.close) / 3);
  const volume = candles.map((c) => c.volume);
  for (const drawing of drawings) {
    if (drawing.tool !== AVWAP_TOOL) continue;
    const anchorTime = drawing.points[0]?.time;
    if (anchorTime === undefined) continue;
    const index = anchorBarIndex(candles, anchorTime);
    if (index < 0) { out[drawing.id] = null; continue; }
    const line = anchoredVwap(typical, volume, index);
    const last = line[line.length - 1];
    out[drawing.id] = last !== undefined && Number.isFinite(last) ? last : null;
  }
  return out;
}
