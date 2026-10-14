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
import type { Trade } from "@/lib/types";
import { resolutionMs, type Resolution } from "@/lib/resolution";
import { legacyBinanceSpotTicker } from "@/lib/instrument";
import { isAbortError } from "@/lib/requestGuard";

export type PineParams = Record<string, number | string | boolean>;

export interface AppliedIndicator {
  /** The user's look per plot (`plotKey`), applied over every run's output. */
  plotStyles?: Record<string, PlotLook>;
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

/**
 * The most bars one Pine run may ask for (B-12).
 *
 * The server refuses a run over 120,000 bars (`MAX_RUN_BARS` in
 * `backend/src/api/routes/pine.ts`), counting from the requested start to the
 * end. The chart runs from the standard backtest start, which on 1m is
 * 496,800 bars — so every 1m run came back 400 and the study drew nothing. A
 * little under the server's figure, so a clock a few minutes apart from the
 * server's cannot tip a clamped run back over it.
 */
export const PINE_MAX_RUN_BARS = 119_000;

/**
 * Exact API boundaries; Replay must never widen a close-time horizon to end-of-day.
 *
 * With a timeframe, the START is moved later when the window would exceed
 * what the server will run — never the end, which is the horizon and the one
 * thing lookahead depends on.
 */
export function pineRunRange(ctx: { startTime: string; endTime: string }, timeframe?: Resolution): {
  startTime: string; endTime: string;
} {
  const startMs = Date.parse(ctx.startTime);
  const endMs = Date.parse(ctx.endTime);
  const stepMs = timeframe ? resolutionMs(timeframe) : 0;
  const earliest = stepMs > 0 ? endMs - PINE_MAX_RUN_BARS * stepMs : -Infinity;
  return {
    startTime: new Date(Math.max(startMs, earliest)).toISOString(),
    endTime: new Date(endMs).toISOString(),
  };
}

/**
 * What a study's legend says when its run failed, or null when it did not.
 *
 * The legend showed `∅ ∅` and nothing else. A compile error is the reader's
 * own script and names its line; anything else is said as what happened to
 * the study, never in the server's words (the contract's rule for failure
 * copy — the raw cause stays on `error` for the Indicators panel).
 */
/** The legend's words for a study whose run is in flight (W2D-01). */
export const PINE_RUN_LOADING = "Loading…";

export function pineRunStatus(error: string | null | undefined): string | null {
  if (!error) return null;
  const line = /^line (\d+):/.exec(error);
  if (line) return `Script error on line ${line[1]} — open it in the Pine editor`;
  if (/Binance Spot candle store/.test(error)) return "Not available for this instrument";
  return "Could not run on this chart";
}

/** What survives a reload — run output is always recomputed. */
export interface StoredIndicator {
  key: string;
  scriptId: string | null;
  name: string;
  source: string;
  params: PineParams;
  visible: boolean;
  /** The user's look per plot, keyed by `plotKey`. Absent: the script's own. */
  plotStyles?: Record<string, PlotLook>;
}

/**
 * The user's override of one Pine plot's look — the Style tab's row.
 *
 * Stored BESIDE the run output, never written into it, and applied after
 * every run (`applyPlotStyles`): a script's plots are recomputed on each run,
 * so a colour written into the output would be repainted by the next one.
 * That was the release's reason for offering no Style tab at all.
 */
export interface PlotLook {
  color?: string;
  width?: number;
  lineStyle?: "solid" | "dashed" | "dotted";
  hidden?: boolean;
}

/**
 * A plot's stable key: its title, which a script declares and which does not
 * change between runs. Untitled plots fall back to their position.
 */
export const plotKey = (o: { title: string }, index: number): string =>
  o.title && o.title.trim() ? o.title : `plot ${index + 1}`;

/** Only well-formed parts survive a load; a bad part drops itself, not the look. */
export function validPlotStyles(raw: unknown): Record<string, PlotLook> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, PlotLook> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const l = v as Record<string, unknown>;
    const look: PlotLook = {
      ...(typeof l.color === "string" && /^#[0-9a-fA-F]{6}$/.test(l.color) ? { color: l.color } : {}),
      ...(typeof l.width === "number" && [1, 2, 3, 4].includes(l.width) ? { width: l.width } : {}),
      ...(l.lineStyle === "solid" || l.lineStyle === "dashed" || l.lineStyle === "dotted"
        ? { lineStyle: l.lineStyle } : {}),
      ...(l.hidden === true ? { hidden: true } : {}),
    };
    if (Object.keys(look).length > 0) out[k] = look;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The run's plots, as the user styled them.
 *
 * A chosen colour also clears per-point colours: a Pine plot can colour each
 * bar, and leaving those would show the choice only on the bars the script
 * did not colour — which reads as the setting half-working. A point the script
 * HIDES (`color: null`) stays hidden.
 */
export function applyPlotStyles(
  overlays: readonly ChartOverlay[], styles: Record<string, PlotLook> | undefined,
): ChartOverlay[] {
  if (!styles) return overlays as ChartOverlay[];
  const out: ChartOverlay[] = [];
  overlays.forEach((o, i) => {
    const look = styles[plotKey(o, i)];
    if (!look) { out.push(o); return; }
    if (look.hidden) return;
    out.push({
      ...o,
      ...(look.color ? {
        color: look.color,
        // A string colour is the script's tint and gives way to the user's; a
        // NULL colour is the script HIDING that point (Pine's `na`) and is
        // kept — clearing it would draw points the script deliberately blanks.
        data: o.data.map((pt) => {
          if (typeof pt.color !== "string") return pt;
          const { color: _c, ...rest } = pt;
          return rest;
        }),
      } : {}),
      ...(look.width ? { width: look.width } : {}),
      ...(look.lineStyle ? { lineStyle: look.lineStyle, dashed: look.lineStyle === "dashed" } : {}),
    });
  });
  return out;
}

const STORAGE_KEY = "tv.indicators.v1";

/**
 * Applied studies are per pane, so their storage is too.
 *
 * The first pane keeps the original unsuffixed key, which is what makes an
 * existing user's studies survive the move to a multi-pane workspace: their
 * chart is pane `p1`, and it reads exactly the entry it wrote before this
 * change existed. Every other pane gets its own suffixed entry, so adding a
 * study to the fourth chart cannot appear on the first.
 */
export const PRIMARY_INDICATOR_SCOPE = "p1";

export function indicatorStorageKey(scope: string): string {
  return scope === PRIMARY_INDICATOR_SCOPE ? STORAGE_KEY : `${STORAGE_KEY}.${scope}`;
}

export function newKey(): string {
  return `ind_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function loadStored(scope: string = PRIMARY_INDICATOR_SCOPE): StoredIndicator[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(indicatorStorageKey(scope));
    const list = raw ? (JSON.parse(raw) as StoredIndicator[]) : [];
    return Array.isArray(list) ? list.filter((s) => typeof s?.source === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The persistable half of an applied study.
 *
 * Run OUTPUT is never stored — plots, drawings and trades are recomputed from
 * the bars on screen, and a stored copy would be a second, stale answer to a
 * question the chart already answers. Extracted so local storage and the
 * server write exactly the same shape rather than two that drift.
 */
export function storable(list: readonly AppliedIndicator[]): StoredIndicator[] {
  return list.map((i) => ({
    key: i.key, scriptId: i.scriptId, name: i.name,
    source: i.source, params: i.params, visible: i.visible,
    ...(i.plotStyles ? { plotStyles: i.plotStyles } : {}),
  }));
}

export function saveStored(
  list: AppliedIndicator[], scope: string = PRIMARY_INDICATOR_SCOPE
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(indicatorStorageKey(scope), JSON.stringify(storable(list)));
  } catch { /* quota — the list is a convenience, not the source of truth */ }
}

/** Forget one pane's stored studies, when that pane is closed for good. */
export function clearStored(scope: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(indicatorStorageKey(scope)); } catch { /* nothing to do */ }
}

/**
 * A copy of one pane's studies for another pane.
 *
 * `params` is copied rather than referenced: a cloned pane that shared its
 * source pane's params object would retune both charts from one dialog.
 */
export function copyStoredForScope(from: string, to: string): void {
  if (typeof window === "undefined" || from === to) return;
  const source = loadStored(from);
  try {
    window.localStorage.setItem(indicatorStorageKey(to), JSON.stringify(
      source.map((s) => ({ ...s, params: { ...s.params } }))
    ));
  } catch { /* quota — the new pane simply starts with no studies */ }
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
    plotStyles: validPlotStyles(s.plotStyles),
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
  ctx: { symbol: string; timeframe: Resolution; startTime: string; endTime: string },
  /**
   * W2D-01: a run the chart has moved on from is CANCELLED, not left to finish.
   *
   * Every interval or symbol switch starts a fresh run of every applied study,
   * and the superseded ones used to run to completion in the server's
   * two-worker Pine pool, so five quick switches queued five long runs ahead
   * of the one the chart was waiting for. An abort REJECTS with the abort
   * error rather than resolving to a failed study: the caller superseded this
   * run, and a cancelled run is not news about the study.
   */
  signal?: AbortSignal,
): Promise<AppliedIndicator> {
  /*
   * `/api/pine/run` is a TICKER contract; `ctx.symbol` is the pane's CANONICAL
   * id. The editor's own run path was reduced at this boundary and this one —
   * the path that keeps an APPLIED study live on every chart context change —
   * was not, so a Pine indicator added to the chart 400'd on every re-run and
   * rendered nothing. Live acceptance caught it: `Add to chart` succeeded and a
   * second request went out carrying `instrument:v1:…`.
   *
   * Refused with a reason rather than sent to fail when the instrument is not
   * in the engine's store, which is the same answer the editor gives.
   */
  const runSymbol = legacyBinanceSpotTicker(ctx.symbol);
  if (runSymbol === null) {
    return {
      ...ind,
      loading: false,
      error: "The Pine engine reads the Binance Spot candle store; this instrument is not in it.",
      overlays: [], decorations: [], barColors: [], markers: [], drawings: NO_DRAWINGS, trades: [],
    };
  }
  try {
    const r = await api.runPine({
      source: ind.source,
      symbol: runSymbol,
      timeframe: ctx.timeframe,
      ...pineRunRange(ctx, ctx.timeframe),
      params: ind.params,
    }, signal);
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
    if (isAbortError(e)) throw e;
    return {
      ...ind, loading: false, error: (e as Error).message,
      overlays: [], decorations: [], barColors: [], markers: [], drawings: NO_DRAWINGS, trades: [],
    };
  }
}
