"use client";
/**
 * Turning a native study into what the chart already knows how to draw.
 *
 * ── Why there is no new renderer ───────────────────────────────────────────
 *
 * `CandleChart` draws `ChartOverlay`s grouped by `paneId`, with per-point
 * colours, fills, hlines, precision and an instance grouping for the legend.
 * Pine studies have produced exactly that shape since they existed. A native
 * study produces the same shape, so it lands in the same series map, the same
 * oscillator panes, the same legend and the same pane layout — with no branch
 * anywhere in the renderer that asks which engine a study came from.
 *
 * That is the whole integration. Everything below is a translation.
 *
 * ── Intrabar, without recomputing the world ───────────────────────────────
 *
 * A native study is recomputed when its bars, its inputs or its instance
 * change — and a live tick changes the bars, once a second, per pane. Two
 * things keep that cheap enough to do on the forming candle:
 *
 *   WINDOWING     `computeWindow` hands the study only the bars it can
 *                 possibly need: the visible window plus its declared warmup.
 *                 A ten-thousand-bar 1m chart running an EMA 50 evaluates a
 *                 few hundred bars per tick, not ten thousand.
 *
 *   MEMOISATION   `StudyCache` keys a result by the instance, its parameters
 *                 and the identity of the bar array it was computed from, so a
 *                 render that changes neither does no arithmetic at all. A
 *                 tick that only revises the FORMING bar reuses nothing —
 *                 correctly, because the forming bar's value is what changed —
 *                 but a crosshair move, a legend hover or a sibling pane's
 *                 update reuses everything.
 *
 * Neither is a substitute for the other: windowing bounds the cost of the work
 * that must happen, memoisation removes the work that must not.
 */
import type { ChartDecoration, ChartOverlay, ChartPoint } from "@/lib/chartSeries";
import { PRICE_PANE_ID } from "@/lib/chartSeries";
import type { Candle } from "@/lib/types";
import {
  defaultParams, normalizeParams, type NativeParams, type NativeStudyDef, type PlotDef,
} from "./registry";

/** A study applied to one pane: which study, tuned how, styled how. */
export interface AppliedNativeStudy {
  /** Instance id. Two RSIs on one chart are two instances of one definition. */
  key: string;
  /** `NativeStudyDef.id`. Persisted; an unknown one degrades, never throws. */
  defId: string;
  params: NativeParams;
  visible: boolean;
  /** Per-plot style overrides. Absent keys keep the definition's defaults. */
  styles: Record<string, PlotStyleOverride>;
}

export interface PlotStyleOverride {
  color?: string;
  width?: number;
  visible?: boolean;
  style?: PlotDef["style"];
}

export interface NativeStudyOutput {
  overlays: ChartOverlay[];
  decorations: ChartDecoration[];
  /** Current value per plot, for the legend and the settings preview. */
  values: Record<string, number | null>;
  /** Set when the window holds fewer bars than the study's warmup needs. */
  insufficient: boolean;
}

const EMPTY: NativeStudyOutput = {
  overlays: [], decorations: [], values: {}, insufficient: false,
};

/**
 * The bars a study actually needs.
 *
 * `warmup` is the study's own declaration of how far back its recursion or its
 * window reaches. Handing it `visible + warmup` bars gives values that are
 * identical to a full-history computation for every bar the user can see,
 * which is the only claim that matters — and it is the difference between a
 * few hundred bars of arithmetic per tick and ten thousand.
 *
 * Studies whose value depends on ALL prior bars regardless of window — a
 * running accumulation like OBV, a session VWAP — declare a warmup of zero and
 * are handed the whole series, because for them a window would be a different
 * indicator rather than a cheaper one. `unbounded` says which those are.
 */
export function computeWindow(
  candles: readonly Candle[], warmup: number, visibleBars: number, unbounded: boolean
): readonly Candle[] {
  if (unbounded) return candles;
  const need = Math.max(0, Math.ceil(warmup)) + Math.max(1, Math.ceil(visibleBars));
  return candles.length <= need ? candles : candles.slice(-need);
}

/**
 * Compute one applied study and translate it into chart primitives.
 *
 * Total: a definition that throws, a parameter set that makes no sense, or a
 * window with no bars produces an empty output rather than taking the chart
 * down. A study is a decoration on a price chart; it does not get to break the
 * price chart.
 */
export function runNativeStudy(
  def: NativeStudyDef,
  applied: AppliedNativeStudy,
  candles: readonly Candle[],
  interval: Parameters<NativeStudyDef["compute"]>[0]["interval"],
  pricePrecision: number
): NativeStudyOutput {
  if (candles.length === 0) return EMPTY;
  const params = normalizeParams(def, applied.params);
  let result;
  try {
    result = def.compute({ candles, params, interval });
  } catch {
    // A study that cannot compute says nothing. The alternative — letting the
    // exception escape into the render — takes every other study with it.
    return EMPTY;
  }

  const paneId = def.overlay ? PRICE_PANE_ID : `indicator:${applied.key}`;
  const times = candles.map((c) => Math.floor(c.openTime / 1000));
  const precision = def.precision ?? pricePrecision;
  const instanceParams = describeParams(def, params);

  const overlays: ChartOverlay[] = [];
  const values: Record<string, number | null> = {};

  for (const plot of def.plots) {
    const series = result.plots[plot.id];
    if (!series) continue;
    const override = applied.styles[plot.id] ?? {};
    const shown = override.visible ?? !plot.hiddenByDefault;
    const last = lastFinite(series);
    values[plot.id] = last;
    if (!shown) continue;
    const colors = result.colors?.[plot.id];
    overlays.push({
      id: `${applied.key}:${plot.id}`,
      title: plot.title,
      color: override.color ?? plot.color,
      width: override.width ?? plot.width,
      dashed: plot.dashed,
      style: override.style ?? plot.style,
      paneId,
      instanceId: applied.key,
      instanceTitle: def.name,
      instanceParams,
      precision,
      data: toPoints(times, series, colors, plot.offset ?? 0),
    });
  }

  // Levels are constant lines in the study's own pane. They use the same
  // `constantValue` hline shape Pine's `hline` already produces, so the price
  // scale and the legend treat them identically.
  for (const level of [...(def.levels ?? []), ...(result.levels ?? [])]) {
    if (!Number.isFinite(level.value) || times.length === 0) continue;
    overlays.push({
      id: `${applied.key}:level:${level.id}`,
      title: level.title,
      color: level.color,
      dashed: level.dashed !== false,
      lineStyle: level.dashed === false ? "solid" : "dashed",
      paneId,
      instanceId: applied.key,
      instanceTitle: def.name,
      instanceParams,
      precision,
      constantValue: level.value,
      data: times.length > 1
        ? [
            { time: times[0]!, value: level.value, color: level.color },
            { time: times[times.length - 1]!, value: level.value, color: level.color },
          ]
        : [{ time: times[0]!, value: level.value, color: level.color }],
    });
  }

  const decorations: ChartDecoration[] = [];
  for (const fill of def.fills ?? []) {
    const firstShown = (applied.styles[fill.firstPlotId]?.visible ?? true);
    const secondShown = (applied.styles[fill.secondPlotId]?.visible ?? true);
    // A fill between a band edge the user has hidden would shade to nothing.
    if (!firstShown || !secondShown) continue;
    decorations.push({
      kind: "fill",
      id: `${applied.key}:fill:${fill.id}`,
      paneId,
      firstId: `${applied.key}:${fill.firstPlotId}`,
      secondId: `${applied.key}:${fill.secondPlotId}`,
      fillgaps: false,
      data: times.map((time) => ({ time, color: fill.color })),
    });
  }

  return {
    overlays,
    decorations,
    values,
    insufficient: candles.length < def.warmup(params),
  };
}

/**
 * Points for one plot, with the displacement applied HERE rather than in the
 * maths.
 *
 * A forward offset (Ichimoku's cloud) needs times the bar array does not have,
 * so it is extrapolated on the interval grid the bars themselves establish.
 * Points that would fall before the first bar are dropped rather than clamped:
 * stacking a displaced series onto bar zero would draw a vertical wall.
 */
function toPoints(
  times: readonly number[], series: readonly number[],
  colors: readonly (string | null)[] | undefined, offset: number
): ChartPoint[] {
  const out: ChartPoint[] = [];
  const step = times.length > 1 ? (times[times.length - 1]! - times[0]!) / (times.length - 1) : 0;
  for (let i = 0; i < series.length && i < times.length; i++) {
    const value = series[i]!;
    const index = i + offset;
    let time: number;
    if (index >= 0 && index < times.length) time = times[index]!;
    else if (index >= times.length && step > 0) time = times[times.length - 1]! + (index - times.length + 1) * step;
    else continue;
    out.push({
      time,
      value: Number.isFinite(value) ? value : null,
      color: colors?.[i] ?? undefined,
    });
  }
  return out;
}

function lastFinite(series: readonly number[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i]!;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * The short parameter summary beside a study's name in the legend.
 *
 * The same convention Pine instances already use: the first few inputs that
 * differ from nothing, so "RSI · Length 14" and "RSI · Length 7" are told
 * apart without an internal key being shown to the user.
 */
export function describeParams(def: NativeStudyDef, params: NativeParams): string {
  return def.inputs
    .map((input) => [input.title, params[input.key]] as const)
    .filter(([, value]) => value !== undefined && value !== "" && typeof value !== "boolean")
    .slice(0, 3)
    .map(([title, value]) => `${title} ${String(value)}`)
    .join(" · ");
}

/**
 * Results, keyed by everything that can change one.
 *
 * The bar array's IDENTITY is part of the key rather than its contents: the
 * history hook replaces the array whenever anything about it changes and
 * returns the same reference when nothing did, so identity is both cheap and
 * exact. Hashing ten thousand bars per study per render to discover the same
 * fact would cost more than the studies do.
 */
export class StudyCache {
  private entries = new Map<string, { bars: readonly Candle[]; key: string; out: NativeStudyOutput }>();

  constructor(private readonly maxEntries = 64) {}

  get(
    applied: AppliedNativeStudy, bars: readonly Candle[], signature: string
  ): NativeStudyOutput | null {
    const hit = this.entries.get(applied.key);
    if (!hit || hit.bars !== bars || hit.key !== signature) return null;
    return hit.out;
  }

  set(
    applied: AppliedNativeStudy, bars: readonly Candle[], signature: string,
    out: NativeStudyOutput
  ): void {
    this.entries.delete(applied.key);
    this.entries.set(applied.key, { bars, key: signature, out });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  forget(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}

/** Everything about an instance that changes its output, as one string. */
export function studySignature(
  applied: AppliedNativeStudy, def: NativeStudyDef, precision: number
): string {
  const params = normalizeParams(def, applied.params);
  const parts = def.inputs.map((i) => `${i.key}=${String(params[i.key])}`);
  const styles = Object.entries(applied.styles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, s]) => `${id}:${s.color ?? ""}/${s.width ?? ""}/${s.visible ?? ""}/${s.style ?? ""}`);
  return `${applied.defId}|${parts.join(",")}|${styles.join(",")}|p${precision}`;
}

/** A fresh instance of a definition, with its defaults. */
export function newNativeStudy(def: NativeStudyDef, key: string): AppliedNativeStudy {
  return { key, defId: def.id, params: defaultParams(def), visible: true, styles: {} };
}
