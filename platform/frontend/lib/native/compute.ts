"use client";
import { resolutionMs, type Resolution } from "@/lib/resolution";
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
import { type Candle } from "@/lib/types";
import { profileBasisNotice } from "@/lib/volumeProfile";
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
  /** Output precision override. Absent uses the study/instrument default. */
  precision?: number;
  /** Per-study legend/axis visibility; absent preserves the default-on state. */
  labelsOnPriceScale?: boolean;
  valuesInStatusLine?: boolean;
  inputsInStatusLine?: boolean;
  /**
   * R6b-29: the timeframes this study is drawn on, as the reference's
   * `Visibility` tab writes them.
   *
   * The same shape and the same meaning as a drawing's `visibleOn`
   * (`lib/drawings`): absent or empty is EVERY timeframe, which is what every
   * study on disk already is. A study hidden by resolution is not computed and
   * not drawn — `visible` is the user's own switch and this is the chart's.
   */
  visibleOn?: Resolution[];
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
  /**
   * The raw plot arrays, kept only for a study something else reads.
   *
   * A dependent needs its source's numbers, not its overlays — and it needs
   * them from the CACHE as well as from a fresh computation, or a chart where
   * nothing changed would recompute the whole chain on every render. Absent
   * for the overwhelming majority of studies, which nothing reads, so no chart
   * pays to retain arrays it will never look at.
   */
  series?: Record<string, readonly number[]>;
  /**
   * B-01: the same arrays over the TAIL window, when the study was computed
   * over a viewport window and a tail window (`planStudyWindows`). A dependent
   * computed over the tail reads these, bar for bar, exactly as it reads
   * `series` over the viewport.
   */
  tailSeries?: Record<string, readonly number[]>;
}

const EMPTY: NativeStudyOutput = {
  overlays: [], decorations: [], values: {}, insufficient: false,
};

/** A hidden study's output. Exported so the hook can use exactly this object. */
export const HIDDEN_OUTPUT: NativeStudyOutput = EMPTY;

/** Where the user is looking, in bars. */
export interface Viewport {
  /** Index of the oldest bar on screen. */
  firstVisibleIndex: number;
  /** How many bars are on screen. */
  visibleBars: number;
}

/**
 * The bars a study actually needs.
 *
 * `warmup` is the study's own declaration of how far back its recursion or its
 * window reaches. Handing it the visible bars plus that warmup gives values
 * identical to a full-history computation for every bar the user can SEE,
 * which is the only claim that matters — and it is the difference between a
 * few hundred bars of arithmetic per tick and ten thousand.
 *
 * ── The window follows the viewport, not the newest bar ────────────────────
 *
 * It used to be `candles.slice(-need)`, anchored to the end of the series. A
 * pan changes where the user is looking without changing how MUCH they can
 * see, so the window did not move: scrolling back into a pane's own loaded
 * history — ten thousand bars by default — left every study blank a swipe or
 * two in, with no message and nothing to distinguish it from a rendering bug.
 *
 * Studies whose value depends on ALL prior bars regardless of window — a
 * running accumulation like OBV, a session VWAP, a ratcheting Supertrend —
 * declare `unbounded` and are handed the whole series, because for them a
 * window is a different indicator rather than a cheaper one.
 */
/**
 * A viewport and the window it was measured on (W2D-01).
 *
 * `firstVisibleIndex` is an index into ONE array. Carried to another — a new
 * symbol, a new interval, a reload that came back a different depth — it
 * points at bars the user is not looking at: a viewport measured on 1D's 90
 * bars (`firstVisibleIndex` 0) applied to 5m's 800 computed every study over
 * the OLDEST 200 bars of a pane showing the newest, and the study pane, held
 * to the price chart's range, drew the last two or three of them stretched
 * across its width until something moved the range again.
 */
export interface MeasuredViewport {
  /** `datasetKey` of the window the index was measured in. */
  datasetKey: string;
  /** That window's first bar — a reload of the same dataset can start elsewhere. */
  firstOpenTime: number;
  viewport: Viewport;
}

/**
 * The viewport to compute over, or `undefined` — "the newest bars", which is
 * where a switched chart opens — when it was measured on another window.
 */
export function viewportForWindow(
  measured: MeasuredViewport | null, datasetKey: string | null, firstOpenTime: number | null,
): Viewport | undefined {
  if (!measured || datasetKey === null || firstOpenTime === null) return undefined;
  return measured.datasetKey === datasetKey && measured.firstOpenTime === firstOpenTime
    ? measured.viewport : undefined;
}

export function computeWindow(
  candles: readonly Candle[], warmup: number, viewport: Viewport, unbounded: boolean
): readonly Candle[] {
  if (unbounded) return candles;
  const visible = Math.max(1, Math.ceil(viewport.visibleBars));
  const lead = Math.max(0, Math.ceil(warmup));
  // The viewport may extend past the newest bar (the chart leaves room to the
  // right) or start before the first; both clamp into the series.
  const end = Math.min(candles.length, Math.max(1, Math.ceil(viewport.firstVisibleIndex) + visible));
  const start = Math.max(0, end - visible - lead);
  return start === 0 && end === candles.length ? candles : candles.slice(start, end);
}

/**
 * The windows one study group is computed over: where the user is looking,
 * and — when that is not the end of the series — the newest bars as well
 * (B-01).
 *
 * ── Why a viewport window alone is not enough ──────────────────────────────
 *
 * `computeWindow` follows the viewport, so a chart panned back six hundred
 * bars computed its RSI and ATR only up to the right edge of the screen. The
 * plotted line ended there, the price-axis label showed that bar's reading,
 * and the legend with no crosshair — which promises the NEWEST value — printed
 * a bar the user was not looking at while the SMA and Pine rows beside it
 * printed the last one. One legend, two bars. The reference never does that:
 * its resting legend is always the last bar and its plots run to the end.
 *
 * Computing the whole history instead is not free: measured at 10,000 1m bars
 * the 57 studies cost ~450 ms together against ~28 ms windowed, and the worst
 * single ones (linear-regression curve/channel, S/R zones) cost 40-50 ms each
 * — once per live tick while panned back. So the tail is computed as a SECOND
 * window of exactly the size the viewport one is, ending at the newest bar.
 *
 * When the two windows touch or overlap they are one contiguous window — at
 * most twice the bars, and no seam to stitch. Otherwise `tail` is set and
 * `mergeTailSegment` joins the two outputs with a gap between them, which is
 * off-screen to the right of where the user is looking.
 */
export interface StudyWindows {
  /** The window that covers the viewport. */
  view: readonly Candle[];
  /** The newest bars, when `view` does not reach them. */
  tail: readonly Candle[] | null;
  /** How many of `tail`'s leading bars are warmup, not values to draw. */
  tailLead: number;
  /** Index of the first bar after `view` — where the seam's gap goes. */
  viewEnd: number;
}

export function planStudyWindows(
  candles: readonly Candle[], warmup: number, viewport: Viewport, unbounded: boolean,
  viewportOnly = false,
): StudyWindows {
  const view = computeWindow(candles, warmup, viewport, unbounded);
  const n = candles.length;
  if (unbounded || viewportOnly || n === 0 || view.length === 0
    || view[view.length - 1] === candles[n - 1]) {
    return { view, tail: null, tailLead: 0, viewEnd: n };
  }
  // The same arithmetic `computeWindow` used, so the indices name its slice.
  const visible = Math.max(1, Math.ceil(viewport.visibleBars));
  const lead = Math.max(0, Math.ceil(warmup));
  const viewEnd = Math.min(n, Math.max(1, Math.ceil(viewport.firstVisibleIndex) + visible));
  const viewStart = Math.max(0, viewEnd - visible - lead);
  const tailStart = Math.max(0, n - visible - lead);
  if (viewEnd >= tailStart) {
    // Touching or overlapping: one window, from the viewport's warmup to the
    // newest bar. Never more than twice the windowed cost.
    return {
      view: viewStart === 0 ? candles : candles.slice(viewStart),
      tail: null, tailLead: 0, viewEnd: n,
    };
  }
  return { view, tail: candles.slice(tailStart), tailLead: lead, viewEnd };
}

/** Points of one plot at or after `from` (seconds). */
const pointsFrom = (points: readonly ChartPoint[], from: number) =>
  points.filter((point) => point.time >= from);
/** Points of one plot strictly before `before` (seconds). */
const pointsBefore = (points: readonly ChartPoint[], before: number) =>
  points.filter((point) => point.time < before);

/**
 * One study's output over a viewport window and a tail window, as one output.
 *
 * - every plot is the viewport's points, ONE whitespace point at `gapTime` —
 *   the first bar after the viewport window, so the line breaks instead of
 *   drawing a straight segment across bars nobody computed — and the tail's
 *   points from `tailFrom`, the tail's first converged bar;
 * - a level spans from the viewport window's first bar to the newest bar;
 * - `values` and `insufficient` are the tail's, because they mean "now";
 * - fills join the same way; a profile is the viewport's (it is about it).
 */
export function mergeTailSegment(
  view: NativeStudyOutput, tail: NativeStudyOutput, gapTime: number, tailFrom: number,
): NativeStudyOutput {
  const tailById = new Map(tail.overlays.map((overlay) => [overlay.id, overlay]));
  const overlays: ChartOverlay[] = view.overlays.map((overlay) => {
    const later = tailById.get(overlay.id);
    if (!later) return overlay;
    if (overlay.constantValue !== undefined) {
      const first = overlay.data[0];
      const last = later.data[later.data.length - 1];
      return {
        ...overlay,
        data: first && last && last.time > first.time ? [first, last] : later.data,
      };
    }
    return {
      ...overlay,
      data: [
        ...pointsBefore(overlay.data, gapTime),
        { time: gapTime, value: null },
        ...pointsFrom(later.data, tailFrom),
      ],
    };
  });
  const viewIds = new Set(view.overlays.map((overlay) => overlay.id));
  for (const overlay of tail.overlays) {
    if (!viewIds.has(overlay.id)) {
      overlays.push({ ...overlay, data: pointsFrom(overlay.data, tailFrom) });
    }
  }
  const tailDecorations = new Map(tail.decorations.map((d) => [d.id, d]));
  const decorations: ChartDecoration[] = view.decorations.map((decoration) => {
    const later = tailDecorations.get(decoration.id);
    if (decoration.kind === "profile" || !later || later.kind === "profile") return decoration;
    return {
      ...decoration,
      data: [
        ...decoration.data.filter((point) => point.time < gapTime),
        ...later.data.filter((point) => point.time >= tailFrom),
      ],
    };
  });
  return {
    overlays,
    decorations,
    values: tail.values,
    insufficient: tail.insufficient,
    ...(view.series ? { series: view.series } : {}),
    ...(tail.series ? { tailSeries: tail.series } : {}),
  };
}

/**
 * Compute one applied study and translate it into chart primitives.
 *
 * Total: a definition that throws, a parameter set that makes no sense, or a
 * window with no bars produces an empty output rather than taking the chart
 * down. A study is a decoration on a price chart; it does not get to break the
 * price chart.
 */
/**
 * A plot's displacement, in bars.
 *
 * Static on the definition for a study whose offset is fixed, and overridable
 * per computation for one whose displacement is an INPUT — Ichimoku's cloud
 * moves with its `displacement` setting, so a constant could not express it.
 */
function offsetOf(
  plot: PlotDef, result: { plotOffsets?: Record<string, number> }
): number {
  const dynamic = result.plotOffsets?.[plot.id];
  return typeof dynamic === "number" && Number.isFinite(dynamic)
    ? Math.trunc(dynamic) : (plot.offset ?? 0);
}

export function runNativeStudy(
  def: NativeStudyDef,
  applied: AppliedNativeStudy,
  candles: readonly Candle[],
  interval: Parameters<NativeStudyDef["compute"]>[0]["interval"],
  pricePrecision: number,
  extra: {
    visibleRange?: { fromMs: number; toMs: number };
    sources?: Readonly<Record<string, readonly number[]>>;
    profileCandles?: readonly Candle[];
    profileInterval?: Parameters<NativeStudyDef["compute"]>[0]["interval"];
    /** Human-readable names for study sources, for the legend. */
    sourceLabels?: Readonly<Record<string, string>>;
    /** Keep the plot arrays, because another study reads this one. */
    captureSeries?: boolean;
  } = {}
): NativeStudyOutput {
  if (candles.length === 0) return EMPTY;
  const params = normalizeParams(def, applied.params);
  let result;
  try {
    result = def.compute({
      candles, params, interval,
      visibleRange: extra.visibleRange,
      sources: extra.sources,
      profileCandles: extra.profileCandles,
      profileInterval: extra.profileInterval,
    });
  } catch {
    // A study that cannot compute says nothing. The alternative — letting the
    // exception escape into the render — takes every other study with it.
    return EMPTY;
  }

  const paneId = def.overlay ? PRICE_PANE_ID : `indicator:${applied.key}`;
  const times = candles.map((c) => Math.floor(c.openTime / 1000));
  const stepSeconds = resolutionMs(interval) / 1000;
  const precision = applied.precision ?? def.precision ?? pricePrecision;
  const instanceParams = describeParams(def, params, extra.sourceLabels);

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
      priceScaleLabelVisible: applied.labelsOnPriceScale !== false,
      statusValueVisible: applied.valuesInStatusLine !== false,
      statusInputVisible: applied.inputsInStatusLine !== false,
      data: toPoints(times, series, colors, offsetOf(plot, result), stepSeconds),
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
      /*
       * A9: a level never puts a pill on the scale. The reference's RSI pane
       * shows ordinary tick labels and a value pill; ours showed three grey
       * `70.00 / 50.00 / 30.00` pills instead, and because a pill clears the
       * tick it touches (`lib/axisTickClearance`) the pane's own ticks went
       * with them, and the RSI value pill landed on the 50 band's. A level is a
       * constant: where it sits is the dashed line itself, and its value is in
       * the study's settings. `Labels on price scale` still governs the plots.
       */
      priceScaleLabelVisible: false,
      statusValueVisible: applied.valuesInStatusLine !== false,
      statusInputVisible: applied.inputsInStatusLine !== false,
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
  /*
   * Profiles first, so a fill drawn by the same study lands on top of one.
   *
   * A profile is always on the price pane whatever the definition says about
   * `overlay`: a histogram over price in an oscillator pane would be drawn
   * against that pane's own scale, which is not a price at all.
   */
  for (const output of result.profiles ?? []) {
    const profile = output.profile;
    if (profile.rows.length === 0 || profile.from === null || profile.to === null) continue;
    decorations.push({
      kind: "profile",
      id: `${applied.key}:profile:${output.id}`,
      paneId: PRICE_PANE_ID,
      title: def.name,
      from: Math.floor(profile.from / 1000),
      /*
       * The range ends at the CLOSE of its last bar, not at its open.
       *
       * A profile anchored at the last bar's open time stops a whole bar short
       * of the range it summarises, which on a 30-bar fixed range is visibly
       * wrong and on a two-bar one is half the range.
       */
      to: Math.floor((profile.to + resolutionMs(profile.sourceInterval)) / 1000),
      side: output.side,
      widthRatio: output.widthRatio,
      rows: profile.rows,
      pocIndex: profile.pocIndex,
      valueAreaRows: profile.valueAreaRows,
      peakVolume: profile.peakVolume,
      split: output.split,
      showValueArea: output.showValueArea,
      showPoc: output.showPoc,
      showRange: output.showRange,
      colors: output.colors,
      basis: profile.basis,
      sourceInterval: profile.sourceInterval,
      basisNotice: profileBasisNotice(profile),
    });
  }
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
    /*
     * "Not enough history" means the study produced NO value, not that the
     * window is shorter than its convergence budget. Comparing against
     * `warmup` — twenty lengths — made an RSI(14) on a 200-bar instrument
     * report that it could not speak while drawing a correct line from bar 14.
     */
    insufficient: Object.values(values).every((v) => v === null),
    ...(extra.captureSeries ? { series: result.plots } : {}),
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
  colors: readonly (string | null)[] | undefined, offset: number,
  stepSeconds: number
): ChartPoint[] {
  const out: ChartPoint[] = [];
  // The interval, not the average gap between the window's first and last bar.
  // A window containing any gap makes that average larger than the interval,
  // and a forward-displaced plot would then land progressively further right
  // than the bars it belongs to.
  const step = stepSeconds > 0 ? stepSeconds : 0;
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
export function describeParams(
  def: NativeStudyDef, params: NativeParams,
  sourceLabels?: Readonly<Record<string, string>>
): string {
  const inputs = def.id === "macd"
    ? [def.inputs[0], def.inputs[1], def.inputs[3], def.inputs[2]].filter(Boolean) as NativeStudyDef["inputs"]
    : def.inputs;
  return inputs
    .map((input) => params[input.key])
    .filter((value) => value !== undefined && value !== "" && typeof value !== "boolean")
    /*
     * A study source reads as what it IS, never as its token.
     *
     * "MA · Length 9 · Source study:nat_k91x:rsi" is an implementation detail
     * on screen, and one that looks like a bug even to someone who knows what
     * it means. "MA · Length 9 · Source RSI · RSI" says the same thing.
     */
    .map((value) => sourceLabels?.[String(value)] ?? String(value))
    .join(" ");
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
  applied: AppliedNativeStudy, def: NativeStudyDef, precision: number,
  viewport?: Viewport,
  visibleRange?: { fromMs: number; toMs: number },
  sourceSignature?: string
): string {
  const params = normalizeParams(def, applied.params);
  const parts = def.inputs.map((i) => `${i.key}=${String(params[i.key])}`);
  const styles = Object.entries(applied.styles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, s]) => `${id}:${s.color ?? ""}/${s.width ?? ""}/${s.visible ?? ""}/${s.style ?? ""}`);
  /*
   * The viewport is part of the key because it decides WHICH bars the study
   * saw. Without it, zooming out or panning re-ran the memo, hit the cache, and
   * returned the narrower window's result — so the study's coverage did not
   * follow the user until the bar array happened to change.
   */
  const view = viewport
    ? `|v${Math.ceil(viewport.visibleBars)}@${Math.ceil(viewport.firstVisibleIndex)}`
    : "";
  /*
   * The exact visible range, but only for a study that reads it.
   *
   * `view` above is deliberately coarse — 200-bar buckets — so an ordinary pan
   * does not invalidate every study on the pane. A visible-range profile needs
   * the opposite: its answer IS the range, so its key has to follow the range
   * exactly. Adding it unconditionally would have given every moving average
   * on the chart a key that changes on every scroll frame.
   */
  const range = def.usesVisibleRange && visibleRange
    ? `|r${visibleRange.fromMs}-${visibleRange.toMs}` : "";
  /*
   * What this study's own sources currently ARE, when it reads another study.
   *
   * Its parameters name a source by id; the SERIES behind that id changes
   * whenever the upstream study's inputs change. Without this, retuning an RSI
   * left a moving average of that RSI showing the previous curve until
   * something else happened to invalidate it.
   */
  const sources = sourceSignature ? `|s${sourceSignature}` : "";
  const display = `|display=${applied.precision ?? "default"}/`
    + `${applied.labelsOnPriceScale !== false}/${applied.valuesInStatusLine !== false}/`
    + `${applied.inputsInStatusLine !== false}`;
  return `${applied.defId}|${parts.join(",")}|${styles.join(",")}|p${precision}${display}${view}${range}${sources}`;
}

/** A fresh instance of a definition, with its defaults. */
export function newNativeStudy(def: NativeStudyDef, key: string): AppliedNativeStudy {
  return { key, defId: def.id, params: defaultParams(def), visible: true, styles: {} };
}
