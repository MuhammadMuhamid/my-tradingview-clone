/** Pure chart-series helpers shared by the renderer and deterministic tests. */
import type { Candle } from "@/lib/types";

export const PRICE_PANE_ID = "price";

export type ChartSeriesStyle =
  | "line" | "histogram" | "columns" | "circles" | "stepline" | "area";

export interface ChartPoint {
  time: number;
  value: number | null;
  /** A dynamic Pine colour. Null means the point is deliberately hidden. */
  color?: string | null;
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
  data: ChartPoint[];
}

export interface ChartPaneGroup {
  id: string;
  title: string;
  params: string;
  overlays: ChartOverlay[];
}

export function groupChartOverlays(overlays: ChartOverlay[]): {
  price: ChartOverlay[];
  panes: ChartPaneGroup[];
} {
  const price: ChartOverlay[] = [];
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
      });
    }
  }
  return { price, panes: [...panes.values()] };
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
  return a.time === b.time && a.value === b.value && a.color === b.color;
}

/**
 * Decide whether lightweight-charts can receive one `update()` or needs a
 * full `setData()`. The common live cases (replace last bar / append one bar)
 * avoid reprocessing 10,000 points.
 */
export function planSeriesMutation(
  previous: ChartPoint[], next: ChartPoint[]
): "none" | "update" | "replace" {
  if (previous.length === 0 || next.length === 0) {
    return previous.length === next.length ? "none" : "replace";
  }
  const canUpdate = next.length === previous.length || next.length === previous.length + 1;
  if (!canUpdate) return "replace";
  const prefix = next.length - 1;
  for (let i = 0; i < prefix; i++) {
    if (!samePoint(previous[i]!, next[i]!)) return "replace";
  }
  if (next.length === previous.length && samePoint(previous[prefix]!, next[prefix]!)) return "none";
  return "update";
}

function sameCandle(a: Candle, b: Candle): boolean {
  return a.openTime === b.openTime && a.open === b.open && a.high === b.high &&
    a.low === b.low && a.close === b.close && a.volume === b.volume;
}

export function planCandleMutation(
  previous: Candle[], next: Candle[]
): "none" | "update" | "replace" {
  if (previous.length === 0 || next.length === 0) {
    return previous.length === next.length ? "none" : "replace";
  }
  if (next.length !== previous.length && next.length !== previous.length + 1) return "replace";
  for (let i = 0; i < next.length - 1; i++) {
    if (!sameCandle(previous[i]!, next[i]!)) return "replace";
  }
  if (next.length === previous.length && sameCandle(previous.at(-1)!, next.at(-1)!)) return "none";
  return "update";
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
