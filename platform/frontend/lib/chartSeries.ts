/** Pure chart-series helpers shared by the renderer and deterministic tests. */
import type { Candle } from "@/lib/types";

export const PRICE_PANE_ID = "price";

export type ChartSeriesStyle =
  | "line" | "histogram" | "columns" | "circles" | "cross" | "stepline" | "area"
  | "candles" | "bars";

export interface ChartPoint {
  time: number;
  value: number | null;
  /** A dynamic Pine colour. Null means the point is deliberately hidden. */
  color?: string | null;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  wickColor?: string | null;
  borderColor?: string | null;
}

export interface ChartOverlay {
  id: string;
  title: string;
  color: string;
  width?: number;
  dashed?: boolean;
  lineStyle?: "solid" | "dashed" | "dotted";
  style?: ChartSeriesStyle;
  /** `price` for overlays; a stable indicator-instance key for oscillators. */
  paneId?: string;
  instanceId?: string;
  instanceTitle?: string;
  instanceParams?: string;
  precision?: number | null;
  /** Hlines have two endpoints for the line renderer but one value at every bar. */
  constantValue?: number;
  data: ChartPoint[];
}

export interface ChartDecorationPoint {
  time: number;
  color: string | null;
}

export type ChartDecoration =
  | {
      kind: "fill";
      id: string;
      paneId: string;
      firstId: string;
      secondId: string;
      fillgaps: boolean;
      data: ChartDecorationPoint[];
    }
  | {
      kind: "background";
      id: string;
      paneId: string;
      data: ChartDecorationPoint[];
    };

export interface ChartBarColor {
  time: number;
  color: string | null;
}

export interface ChartPaneGroup {
  id: string;
  title: string;
  params: string;
  overlays: ChartOverlay[];
  decorations: ChartDecoration[];
}

/**
 * Number instances that a reader could not otherwise tell apart.
 *
 * Two applications of the same script with different inputs are already
 * distinct — "RSI · Length 14" against "RSI · Length 7". Only when the name
 * *and* the arguments match does an ordinal have anything to add, so only then
 * is one shown.
 */
export function labelDuplicateInstances<T extends { title: string; params: string }>(
  groups: T[]
): T[] {
  const total = new Map<string, number>();
  for (const g of groups) {
    const k = `${g.title}\u0000${g.params}`;
    total.set(k, (total.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return groups.map((g) => {
    const k = `${g.title}\u0000${g.params}`;
    if ((total.get(k) ?? 0) < 2) return g;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return { ...g, title: `${g.title} (${n})` };
  });
}

export function groupChartOverlays(overlays: ChartOverlay[], decorations: ChartDecoration[] = []): {
  price: ChartOverlay[];
  priceDecorations: ChartDecoration[];
  panes: ChartPaneGroup[];
} {
  const price: ChartOverlay[] = [];
  const priceDecorations: ChartDecoration[] = [];
  const panes = new Map<string, ChartPaneGroup>();
  for (const overlay of overlays) {
    const paneId = overlay.paneId ?? PRICE_PANE_ID;
    if (paneId === PRICE_PANE_ID) {
      price.push(overlay);
      continue;
    }
    const existing = panes.get(paneId);
    if (existing) {
      existing.overlays.push(overlay);
    } else {
      panes.set(paneId, {
        id: paneId,
        title: overlay.instanceTitle || overlay.title,
        params: overlay.instanceParams ?? "",
        overlays: [overlay],
        decorations: [],
      });
    }
  }
  for (const decoration of decorations) {
    if (decoration.paneId === PRICE_PANE_ID) {
      priceDecorations.push(decoration);
      continue;
    }
    const existing = panes.get(decoration.paneId);
    if (existing) {
      existing.decorations.push(decoration);
    } else {
      panes.set(decoration.paneId, {
        id: decoration.paneId,
        title: "Indicator",
        params: "",
        overlays: [],
        decorations: [decoration],
      });
    }
  }
  return {
    price, priceDecorations, panes: labelDuplicateInstances([...panes.values()]),
  };
}

export function shiftedPlotTime(times: number[], index: number, offset: number): number | null {
  const direct = times[index + offset];
  if (direct !== undefined) return direct;
  const at = times[index];
  if (at === undefined || times.length < 2) return null;
  const step = times[1]! - times[0]!;
  if (!Number.isFinite(step) || step <= 0) return null;
  const shifted = at + offset * step;
  return Number.isFinite(shifted) && shifted > 0 ? shifted : null;
}

function samePoint(a: ChartPoint, b: ChartPoint): boolean {
  return a.time === b.time && a.value === b.value && a.color === b.color &&
    a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close &&
    a.wickColor === b.wickColor && a.borderColor === b.borderColor;
}

export type SeriesMutation = "none" | "update" | "replace";

/**
 * Decide whether lightweight-charts can receive one `update()` or needs a
 * full `setData()`, for any series whose points carry a time.
 *
 * ── What `update()` can honour ─────────────────────────────────────────────
 *
 * lightweight-charts' `update()` rewrites the LAST point in place or appends
 * a newer one; anything else needs `setData()`. So the plan is `update` when
 * everything the chart already holds is unchanged except possibly its last
 * point, and `next` either rewrites that point or adds one after it.
 *
 * ── Why the comparison is aligned by time, not by index ───────────────────
 *
 * A rolling 10,000-bar window is trimmed on the left at every bar close:
 * `next` is `previous` minus its oldest point, plus the new bar. Compared
 * from index 0 that looks like every point changed, and the chart repainted
 * all 10,000 candles, the volume and every overlay once a minute per pane.
 * Aligning `next[0]` to the point in `previous` with the same time turns the
 * trim into what it is — the same tail, one point shorter at the front —
 * which `update()` can honour: the chart simply keeps the trimmed point.
 *
 * Any point before the tail that differs still means `replace`. That is
 * the correctness rule; a left trim is the only extra case it admits.
 */
function planAlignedMutation<T>(
  previous: readonly T[], next: readonly T[],
  timeOf: (item: T) => number, same: (a: T, b: T) => boolean
): SeriesMutation {
  if (previous.length === 0 || next.length === 0) {
    return previous.length === next.length ? "none" : "replace";
  }
  // Where `next` starts inside `previous`: 0 normally, >0 after a left trim.
  // A trim is at most a few bars, so a bounded forward scan finds it.
  const firstTime = timeOf(next[0]!);
  let offset = -1;
  const maxTrim = Math.min(previous.length, MAX_ALIGNED_TRIM);
  for (let i = 0; i < maxTrim; i++) {
    if (timeOf(previous[i]!) === firstTime) { offset = i; break; }
  }
  if (offset < 0) return "replace";
  const shared = previous.length - offset;
  // `next` must reach the end of `previous`, and may extend it by one.
  if (next.length !== shared && next.length !== shared + 1) return "replace";
  for (let i = 0; i < next.length - 1; i++) {
    if (!same(previous[offset + i]!, next[i]!)) return "replace";
  }
  if (next.length === shared && same(previous[previous.length - 1]!, next[next.length - 1]!)) {
    return "none";
  }
  return "update";
}

/**
 * How far into `previous` the alignment scan looks. A live window is trimmed
 * by one bar per boundary; a reload that shifts the window by more than this
 * gets a full repaint, which is the right answer for a genuinely new window.
 */
const MAX_ALIGNED_TRIM = 8;

export function planSeriesMutation(
  previous: ChartPoint[], next: ChartPoint[]
): SeriesMutation {
  return planAlignedMutation(previous, next, (p) => p.time, samePoint);
}

function sameCandle(a: Candle, b: Candle): boolean {
  return a.openTime === b.openTime && a.open === b.open && a.high === b.high &&
    a.low === b.low && a.close === b.close && a.volume === b.volume;
}

export function planCandleMutation(
  previous: Candle[], next: Candle[]
): SeriesMutation {
  return planAlignedMutation(previous, next, (c) => c.openTime, sameCandle);
}

/** Candle mutation planning including derived barcolor presentation state. */
export function planColoredCandleMutation(
  previous: Candle[], next: Candle[],
  previousColors: ReadonlyMap<number, string>, nextColors: ReadonlyMap<number, string>
): "none" | "update" | "replace" {
  const canonical = planCandleMutation(previous, next);
  if (canonical === "replace") return "replace";
  for (let i = 0; i < next.length - 1; i++) {
    const time = next[i]!.openTime / 1000;
    if (previousColors.get(time) !== nextColors.get(time)) return "replace";
  }
  if (next.length === 0) return canonical;
  const lastTime = next[next.length - 1]!.openTime / 1000;
  return canonical === "none" && previousColors.get(lastTime) === nextColors.get(lastTime)
    ? "none" : "update";
}

/** Later calls and later indicator instances win; na never clears an earlier override. */
export function mergeBarColorLayers(layers: ChartBarColor[][]): ChartBarColor[] {
  const merged = new Map<number, string>();
  for (const layer of layers) {
    for (const point of layer) {
      if (point.color !== null) merged.set(point.time, point.color);
    }
  }
  return [...merged].map(([time, color]) => ({ time, color }));
}

/** Exact crosshair value, or the newest finite value when the crosshair left. */
export function plotValueAt(points: ChartPoint[], time: number | null): number | null {
  if (time === null) {
    for (let i = points.length - 1; i >= 0; i--) {
      const value = points[i]!.value;
      if (value !== null && Number.isFinite(value)) return value;
    }
    return null;
  }
  let lo = 0, hi = points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = points[mid]!;
    if (point.time === time) return point.value !== null && Number.isFinite(point.value)
      ? point.value : null;
    if (point.time < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

export function formatPlotValue(value: number | null, precision?: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits = precision ?? (Math.abs(value) >= 1000 ? 2 : Math.abs(value) >= 1 ? 4 : 6);
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(0, Math.min(12, digits)),
  });
}

/**
 * The same plan as `planCandleMutation`, for the bars a chart-only transform
 * produces.
 *
 * Transformed bars carry no volume and — for Renko — no relationship to the
 * canonical bar count, so neither candle planner can speak for them. The rule
 * is the one lightweight-charts can actually honour: everything before the
 * last drawn bar must be identical, and then the tail is either unchanged,
 * rewritten in place, or extended by one.
 *
 * Renko's awkward cases fall out correctly. A forming bar that completes two
 * bricks at once, or one that retraces and un-completes a brick it had already
 * produced, both fail the prefix check and get a full `setData` — which is the
 * honest answer, because `update()` cannot remove a bar.
 */
export function planOhlcMutation(
  previous: readonly TransformedBar[], next: readonly TransformedBar[]
): SeriesMutation {
  return planAlignedMutation(previous, next, (b) => b.openTime, sameTransformedBar);
}

/** The shape `planOhlcMutation` compares. Matches `OhlcBar` structurally. */
interface TransformedBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function sameTransformedBar(a: TransformedBar, b: TransformedBar): boolean {
  return a.openTime === b.openTime && a.open === b.open && a.high === b.high &&
    a.low === b.low && a.close === b.close;
}
