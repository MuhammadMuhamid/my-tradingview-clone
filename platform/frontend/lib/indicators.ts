/**
 * Applied-indicator store for the chart.
 *
 * TradingView keeps a list of *studies* on a chart, each an instance of a
 * script with its own inputs, visibility and remove button. This module is
 * that list: instances live here, the panel renders them, and the chart draws
 * the union of their overlays and markers.
 *
 * An instance owns its `source` rather than only a script id, so a script
 * applied straight from the editor (never saved) behaves like any other.
 */
import { api, type PineDrawings, type PineInputDef, type PineRunResult } from "@/lib/api";
import type { ChartMarker, ChartOverlay } from "@/components/CandleChart";
import type { Interval, Trade } from "@/lib/types";

export type PineParams = Record<string, number | string | boolean>;

export interface AppliedIndicator {
  /** instance id — the same script can be applied twice with different inputs */
  key: string;
  /** saved-script id, or null for a script applied straight from the editor */
  scriptId: string | null;
  name: string;
  kind: "indicator" | "strategy";
  source: string;
  inputs: PineInputDef[];
  params: PineParams;
  visible: boolean;
  /** true while a run is in flight */
  loading: boolean;
  /** first compile/run error, shown on the instance row */
  error: string | null;
  overlays: ChartOverlay[];
  markers: ChartMarker[];
  drawings: PineDrawings;
  trades: Trade[];
}

/** Empty drawing set, so callers never branch on null. */
export const NO_DRAWINGS: PineDrawings = { lines: [], boxes: [], labels: [], tables: [] };

/** What survives a reload — run output is always recomputed. */
interface StoredIndicator {
  key: string;
  scriptId: string | null;
  name: string;
  source: string;
  params: PineParams;
  visible: boolean;
}

const STORAGE_KEY = "tv.indicators.v1";

export function newKey(): string {
  return `ind_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function loadStored(): StoredIndicator[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as StoredIndicator[]) : [];
    return Array.isArray(list) ? list.filter((s) => typeof s?.source === "string") : [];
  } catch {
    return [];
  }
}

export function saveStored(list: AppliedIndicator[]): void {
  if (typeof window === "undefined") return;
  const slim: StoredIndicator[] = list.map((i) => ({
    key: i.key, scriptId: i.scriptId, name: i.name,
    source: i.source, params: i.params, visible: i.visible,
  }));
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch { /* quota — the list is a convenience, not the source of truth */ }
}

/** Rehydrate a stored entry into a not-yet-run instance. */
export function hydrate(s: StoredIndicator): AppliedIndicator {
  return {
    key: s.key || newKey(),
    scriptId: s.scriptId ?? null,
    name: s.name,
    kind: "indicator",
    source: s.source,
    inputs: [],
    params: s.params ?? {},
    visible: s.visible !== false,
    loading: true,
    error: null,
    overlays: [],
    markers: [],
    drawings: NO_DRAWINGS,
    trades: [],
  };
}

/**
 * Turn a run result into chart primitives. Overlay ids are namespaced by
 * instance so two copies of one script never collide in the chart's series map.
 */
export function toChartOutput(
  key: string,
  r: PineRunResult
): Pick<AppliedIndicator, "overlays" | "markers" | "drawings" | "trades"> {
  const times = r.times ?? [];
  return {
    overlays: (r.plots ?? []).map((p) => ({
      id: `${key}:${p.id}`,
      title: p.title,
      color: p.color,
      width: p.width,
      dashed: p.style === "dashed" || p.style === "dotted",
      data: p.data.map((v, i) => ({ time: times[i] ?? 0, value: v })),
    })),
    markers: (r.shapes ?? []).map((s) => ({
      time: s.time,
      position: s.position === "above" ? "aboveBar" : "belowBar",
      color: s.color,
      text: s.text,
      shape: s.shape === "triangleup" || s.shape === "arrowup"
        ? "arrowUp"
        : s.shape === "triangledown" || s.shape === "arrowdown"
          ? "arrowDown"
          : "circle",
    })),
    drawings: r.drawings ?? NO_DRAWINGS,
    trades: r.trades ?? [],
  };
}

/** Run one instance against the current chart context. */
export async function runIndicator(
  ind: AppliedIndicator,
  ctx: { symbol: string; timeframe: Interval; startTime: string; endTime: string }
): Promise<AppliedIndicator> {
  try {
    const r = await api.runPine({
      source: ind.source,
      symbol: ctx.symbol,
      timeframe: ctx.timeframe,
      startTime: new Date(ctx.startTime).toISOString(),
      endTime: new Date(`${ctx.endTime}T23:59:59Z`).toISOString(),
      params: ind.params,
    });
    if (!r.ok) {
      const e = r.errors[0];
      return {
        ...ind,
        loading: false,
        inputs: r.meta?.inputs ?? ind.inputs,
        error: e ? `line ${e.line}: ${e.message}` : "compile failed",
        overlays: [], markers: [], drawings: NO_DRAWINGS, trades: [],
      };
    }
    return {
      ...ind,
      loading: false,
      error: null,
      kind: r.meta.kind,
      name: ind.name || r.meta.title,
      inputs: r.meta.inputs,
      ...toChartOutput(ind.key, r),
    };
  } catch (e) {
    return { ...ind, loading: false, error: (e as Error).message };
  }
}
