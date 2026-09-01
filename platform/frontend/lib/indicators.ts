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
import type { ChartMarker } from "@/components/CandleChart";
import {
  PRICE_PANE_ID, shiftedPlotTime, type ChartBarColor, type ChartDecoration,
  type ChartOverlay, type ChartSeriesStyle,
} from "@/lib/chartSeries";
import type { Interval, Trade } from "@/lib/types";

export type PineParams = Record<string, number | string | boolean>;

export interface AppliedIndicator {
  /** instance id — the same script can be applied twice with different inputs */
  key: string;
  /** saved-script id, or null for a script applied straight from the editor */
  scriptId: string | null;
  name: string;
  kind: "indicator" | "strategy";
  shortTitle: string;
  overlay: boolean;
  precision: number | null;
  source: string;
  inputs: PineInputDef[];
  params: PineParams;
  visible: boolean;
  /** true while a run is in flight */
  loading: boolean;
  /** first compile/run error, shown on the instance row */
  error: string | null;
  warnings: { line: number; message: string }[];
  overlays: ChartOverlay[];
  decorations: ChartDecoration[];
  barColors: ChartBarColor[];
  markers: ChartMarker[];
  drawings: PineDrawings;
  trades: Trade[];
}

/** Empty drawing set, so callers never branch on null. */
export const NO_DRAWINGS: PineDrawings = { lines: [], boxes: [], labels: [], tables: [] };

/** Drop every horizon-derived byte before a replay re-run is allowed to settle. */
export function invalidateReplayOutput(indicator: AppliedIndicator): AppliedIndicator {
  return {
    ...indicator, loading: true, error: null,
    overlays: [], decorations: [], barColors: [], markers: [], drawings: NO_DRAWINGS, trades: [],
  };
}

/** Exact API boundaries; Replay must never widen a close-time horizon to end-of-day. */
export function pineRunRange(ctx: { startTime: string; endTime: string }): {
  startTime: string; endTime: string;
} {
  return {
    startTime: new Date(ctx.startTime).toISOString(),
    endTime: new Date(ctx.endTime).toISOString(),
  };
}

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
    shortTitle: "",
    overlay: true,
    precision: null,
    source: s.source,
    inputs: [],
    params: s.params ?? {},
    visible: s.visible !== false,
    loading: true,
    error: null,
    warnings: [],
    overlays: [],
    decorations: [],
    barColors: [],
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
  r: PineRunResult,
  params: PineParams = {}
): Pick<AppliedIndicator, "overlays" | "decorations" | "barColors" | "markers" | "drawings" | "trades"> {
  const times = r.times ?? [];
  /*
   * The script's own name, and nothing else. This used to carry the instance
   * key (`RSI · ind_b`), which put an internal identifier in front of the user
   * on every indicator whether or not anything needed distinguishing. Two
   * copies of one script are told apart by their arguments — which is what the
   * parameter summary beside the name is for — and by an ordinal added at
   * render time when even those match.
   */
  const instanceTitle = r.meta.shortTitle || r.meta.title;
  const activeParams = r.meta.inputs
    .map((input) => [input.title, params[input.key] ?? input.defval] as const)
    .filter(([, value]) => value !== "" && value !== undefined)
    .slice(0, 3)
    .map(([title, value]) => `${title} ${String(value)}`)
    .join(" · ");
  const paneFor = (forceOverlay = false): string =>
    r.meta.overlay || forceOverlay ? PRICE_PANE_ID : `indicator:${key}`;
  const plotOverlays: ChartOverlay[] = (r.plots ?? [])
    .filter((plot) => plot.renderable !== false)
    .map((plot) => ({
      id: `${key}:${plot.id}`,
      title: plot.title,
      color: plot.color,
      width: plot.width,
      style: plot.style as ChartSeriesStyle,
      paneId: paneFor(plot.forceOverlay),
      instanceId: key,
      instanceTitle,
      instanceParams: activeParams,
      precision: r.meta.precision,
      data: plot.data.flatMap((value, i) => {
        const time = shiftedPlotTime(times, i, plot.offset ?? 0);
        return time === null ? [] : [{
          time,
          value,
          color: plot.colors?.[i] === undefined ? plot.color : plot.colors[i],
        }];
      }),
    }));
  const ohlcOverlays: ChartOverlay[] = (r.ohlcPlots ?? [])
    .filter((plot) => plot.renderable !== false)
    .map((plot) => ({
      id: `${key}:${plot.id}`,
      title: plot.title,
      color: plot.color,
      style: plot.style,
      paneId: paneFor(plot.forceOverlay),
      instanceId: key,
      instanceTitle,
      instanceParams: activeParams,
      precision: r.meta.precision,
      data: plot.data.flatMap((value, i) => {
        const time = times[i];
        if (time === undefined) return [];
        return [{
          time,
          value: value?.close ?? null,
          color: plot.colors?.[i] ?? null,
          ...(value ?? {}),
          wickColor: plot.wickColors?.[i] ?? null,
          borderColor: plot.borderColors?.[i] ?? null,
        }];
      }),
    }));
  const hlineOverlays: ChartOverlay[] = (r.hlines ?? [])
    .filter((line) => line.renderable !== false && Number.isFinite(line.price) && times.length > 0)
    .map((line) => ({
      id: `${key}:${line.id}`,
      title: line.title || "Level",
      color: line.color,
      width: line.width,
      dashed: line.style !== "solid",
      lineStyle: line.style,
      paneId: paneFor(),
      instanceId: key,
      instanceTitle,
      instanceParams: activeParams,
      precision: r.meta.precision,
      constantValue: line.price,
      data: [
        { time: times[0]!, value: line.price, color: line.color },
        ...(times.length > 1
          ? [{ time: times[times.length - 1]!, value: line.price, color: line.color }]
          : []),
      ],
    }));
  const decorations: ChartDecoration[] = [
    ...(r.backgrounds ?? []).map((background) => ({
      kind: "background" as const,
      id: `${key}:${background.id}`,
      paneId: paneFor(background.forceOverlay),
      data: background.colors.flatMap((color, i) => {
        const time = shiftedPlotTime(times, i, background.offset ?? 0);
        return time === null ? [] : [{ time, color }];
      }),
    })),
    ...(r.fills ?? [])
      .filter((fill) => fill.renderable !== false)
      .map((fill) => ({
        kind: "fill" as const,
        id: `${key}:${fill.id}`,
        paneId: paneFor(fill.forceOverlay),
        firstId: `${key}:${fill.firstId}`,
        secondId: `${key}:${fill.secondId}`,
        fillgaps: fill.fillgaps,
        data: fill.colors.flatMap((color, i) => {
          const time = times[i];
          return time === undefined ? [] : [{ time, color }];
        }),
      })),
  ];
  const barColors: ChartBarColor[] = (r.barColors ?? []).flatMap((call) =>
    call.colors.flatMap((color, i) => {
      const time = shiftedPlotTime(times, i, call.offset ?? 0);
      return time === null ? [] : [{ time, color }];
    })
  );
  return {
    overlays: [...plotOverlays, ...ohlcOverlays, ...hlineOverlays],
    decorations,
    barColors,
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
      ...pineRunRange(ctx),
      params: ind.params,
    });
    if (!r.ok) {
      const e = r.errors[0];
      return {
        ...ind,
        loading: false,
        inputs: r.meta?.inputs ?? ind.inputs,
        warnings: r.meta?.warnings ?? [],
        error: e ? `line ${e.line}: ${e.message}` : "compile failed",
        overlays: [], decorations: [], barColors: [], markers: [], drawings: NO_DRAWINGS, trades: [],
      };
    }
    return {
      ...ind,
      loading: false,
      error: null,
      kind: r.meta.kind,
      name: ind.name || r.meta.title,
      shortTitle: r.meta.shortTitle,
      overlay: r.meta.overlay,
      precision: r.meta.precision,
      inputs: r.meta.inputs,
      warnings: r.meta.warnings ?? [],
      ...toChartOutput(ind.key, r, ind.params),
    };
  } catch (e) {
    return {
      ...ind, loading: false, error: (e as Error).message,
      overlays: [], decorations: [], barColors: [], markers: [], drawings: NO_DRAWINGS, trades: [],
    };
  }
}
