"use client";
/**
 * What a built-in study IS, so that adding another one is an entry.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * Until now every study on a chart was a Pine script: applying an RSI meant a
 * round trip to the server, a compile and a run over ten thousand bars, and it
 * happened again on every parameter change and at every bar close. That is the
 * right architecture for a user's own script and the wrong one for an RSI —
 * it makes the twelve most common indicators in the product cost a network
 * request each, and it makes updating them on the FORMING candle impossible
 * without hammering the backend once a second per pane.
 *
 * A native study is computed in the browser from the bars the pane already
 * holds, by the canonical math in `lib/ta/core` — the same code the server
 * evaluates alerts with. Nothing about Pine changes: Pine studies and native
 * studies coexist on one chart, in one list, drawing into the same overlay
 * model.
 *
 * ── What a definition has to say ───────────────────────────────────────────
 *
 * Enough that the browser, the settings dialog, the legend, the persistence
 * layer and the alert surface can all be driven from it without any of them
 * knowing what the study computes:
 *
 *   identity     a stable `id` that persisted state refers to forever, plus
 *                the name and aliases search matches on;
 *   placement    overlay on price, or its own pane;
 *   inputs       typed, with defaults and ranges, so the settings dialog is
 *                generated rather than written per study;
 *   outputs      the plots, each with a default style the user may override;
 *   format       precision, and whether values are prices or a fixed scale;
 *   warmup       how many bars are needed before the first value exists, so a
 *                pane can say "not enough history" rather than drawing nothing;
 *   compute      bars in, plot arrays out. Pure, and total.
 *
 * ── Deliberately not general ───────────────────────────────────────────────
 *
 * There is no expression language, no dependency graph between studies, no
 * plugin loading and no user-defined native study. Pine already occupies that
 * space and does it better. This registry describes exactly the curated
 * catalog, and its generality stops there.
 */
import type { ChartOverlay, ChartProfileDecoration } from "@/lib/chartSeries";
import type { Candle } from "@/lib/types";
import type { Resolution } from "@/lib/resolution";
import type { VolumeProfile } from "@/lib/volumeProfile";

// ── Inputs ──────────────────────────────────────────────────────────────────

export type NativeInputValue = number | string | boolean;

export interface NumberInput {
  kind: "number";
  key: string;
  title: string;
  defval: number;
  min?: number;
  max?: number;
  step?: number;
  /** Whole numbers only — a length of 14.5 is not a length. */
  integer?: boolean;
}

export interface SelectInput {
  kind: "select";
  key: string;
  title: string;
  defval: string;
  options: readonly { value: string; label: string }[];
}

export interface BooleanInput {
  kind: "boolean";
  key: string;
  title: string;
  defval: boolean;
}

/**
 * Which price series a study runs on.
 *
 * A separate kind rather than a `select` because every study that offers it
 * offers exactly the same options, and the resolution from name to array lives
 * in one place (`resolveSource`) rather than in each study's compute.
 */
export interface SourceInput {
  kind: "source";
  key: string;
  title: string;
  defval: PriceSource;
}

export type NativeInput = NumberInput | SelectInput | BooleanInput | SourceInput;

export const PRICE_SOURCES = [
  "open", "high", "low", "close", "hl2", "hlc3", "ohlc4",
] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/**
 * How each source is named in the settings dialog.
 *
 * Here rather than in the dialog so a source added to `PRICE_SOURCES` cannot
 * appear in a dropdown as a raw identifier: the record is exhaustive by type,
 * so omitting a label fails the build.
 */
export const PRICE_SOURCE_LABELS: Record<PriceSource, string> = {
  open: "Open", high: "High", low: "Low", close: "Close",
  hl2: "HL2", hlc3: "HLC3", ohlc4: "OHLC4",
};

export type NativeParams = Record<string, NativeInputValue>;

// ── Outputs ─────────────────────────────────────────────────────────────────

export type PlotStyle = "line" | "histogram" | "columns" | "area" | "stepline" | "circles";

export interface PlotDef {
  /** Stable within the study; persisted style overrides are keyed by it. */
  id: string;
  title: string;
  style: PlotStyle;
  color: string;
  width?: number;
  dashed?: boolean;
  /**
   * Plots may be hidden by default — a band's middle line, a signal that most
   * users leave off. The user can turn them on in Style.
   */
  hiddenByDefault?: boolean;
  /**
   * Forward or backward displacement, in bars. Applied at PLOT time, never
   * inside the maths: shifting a series while computing it makes its values
   * disagree with the bars they came from.
   */
  offset?: number;
}

/** A horizontal reference line the study draws in its own pane. */
export interface LevelDef {
  id: string;
  title: string;
  value: number;
  color: string;
  dashed?: boolean;
}

/** A shaded region between two plots. */
export interface FillDef {
  id: string;
  firstPlotId: string;
  secondPlotId: string;
  color: string;
}

// ── The definition ──────────────────────────────────────────────────────────

export type NativeCategory =
  | "moving-average" | "trend" | "momentum" | "volatility" | "volume"
  | "levels" | "statistics";

export interface NativeComputeInput {
  candles: readonly Candle[];
  params: NativeParams;
  interval: Resolution;
  /**
   * Exactly what the user can see, in epoch milliseconds, snapped to the bar
   * grid — for the few studies whose ANSWER is about the viewport rather than
   * about the bars.
   *
   * The window a study is handed is deliberately coarse: it is rounded to
   * 200-bar buckets so an ordinary pan does not invalidate every memoised
   * result sixty times a second. That is right for a moving average, whose
   * value at a bar does not depend on what else is on screen, and wrong for a
   * visible-range volume profile, whose whole definition is "these bars".
   *
   * The coarse window always CONTAINS the exact range, so a study that
   * declares `usesVisibleRange` clips to this and gets both: an exact answer
   * and a cache key that only changes when the visible set of bars does.
   *
   * Absent before the chart has reported a range, which means "all the bars
   * you were given".
   */
  visibleRange?: { fromMs: number; toMs: number };
  /**
   * Series this study may use as its `source`, keyed by source token.
   *
   * Empty for a study whose source is a price. Populated for one whose source
   * is another study's output — see `lib/native/graph` for how the tokens are
   * formed, ordered and kept acyclic. Every array here is aligned bar-for-bar
   * with `candles`.
   */
  sources?: Readonly<Record<string, readonly number[]>>;
}

/**
 * A volume profile a study produces.
 *
 * Not a plot: its rows are intervals of PRICE, so there is no per-bar array
 * that could describe it. It is translated into a `ChartProfileDecoration` by
 * `runNativeStudy` and painted by `VolumeProfileLayer`, which is the only
 * place on this chart that draws against price rather than against time.
 */
export interface NativeProfileOutput {
  /** Stable within the study, so two profiles from one study never collide. */
  id: string;
  profile: VolumeProfile;
  side: "left" | "right";
  /** Share of the plot width the widest row may take, 0.05–1. */
  widthRatio: number;
  split: "total" | "upDown";
  showValueArea: boolean;
  showPoc: boolean;
  showRange: boolean;
  colors: ChartProfileDecoration["colors"];
}

export interface NativeComputeOutput {
  /** One array per plot id, aligned bar-for-bar with `candles`. */
  plots: Record<string, number[]>;
  /**
   * Per-bar colour for a plot whose colour is data-dependent (a histogram that
   * is green above zero, a Supertrend that follows its own direction). Keyed
   * by plot id; a null entry means "use the plot's own colour".
   */
  colors?: Record<string, (string | null)[]>;
  /** Levels the study draws given its current inputs, if they are not static. */
  levels?: LevelDef[];
  /** Volume profiles, drawn against price rather than against time. */
  profiles?: NativeProfileOutput[];
  /**
   * Per-plot displacement in bars, for a study whose offset is an INPUT rather
   * than a constant — Ichimoku's cloud moves with its `displacement` setting.
   * Applied at plot time, never inside the maths.
   */
  plotOffsets?: Record<string, number>;
}

export interface NativeStudyDef {
  /** Stable forever: persisted studies name this. Never renamed, never reused. */
  id: string;
  name: string;
  /** Extra terms search should match — "DMI" finding ADX, "BB" finding Bollinger. */
  aliases?: readonly string[];
  category: NativeCategory;
  /** True to draw on the price pane; false for an oscillator in its own pane. */
  overlay: boolean;
  /** One-line description shown in the browser. */
  description: string;

  inputs: readonly NativeInput[];
  plots: readonly PlotDef[];
  levels?: readonly LevelDef[];
  fills?: readonly FillDef[];

  /**
   * Decimal places. `null` means "the instrument's own price precision", which
   * is what an overlay wants; a fixed number is what a bounded oscillator wants.
   */
  precision: number | null;

  /**
   * Bars of lead-in the study needs before its values match a full-history
   * computation, given these inputs.
   *
   * Not "bars before the first value exists" — that would be too short. A
   * recursive smoother (`ema`, `rma`) seeds from a window and then converges
   * geometrically, so a study handed exactly its seed window produces values
   * that are visibly, if slightly, wrong. The seed error decays by a factor of
   * `1 − alpha` per bar, so a warmup of roughly twenty lengths puts it below
   * one part in a billion — far under any precision a chart displays — while
   * still costing hundreds of bars rather than ten thousand.
   *
   * `tests/nativeStudies.test.ts` checks every bounded study's windowed output
   * against its full-history output, so a warmup that is too short fails
   * rather than shipping a subtly different line.
   */
  warmup: (params: NativeParams) => number;

  /**
   * The study's value at a bar depends on ALL prior bars, not on a bounded
   * window, so it must be computed over the whole series.
   *
   * A running accumulation (OBV), a session accumulation (VWAP) and a
   * ratcheting state machine (Supertrend, Parabolic SAR) are all in this
   * class: their state carries indefinitely and does not converge, so a
   * windowed computation is not a cheaper version of the same indicator — it
   * is a DIFFERENT indicator that happens to look similar. Supertrend is the
   * sharpest case: seeded mid-downtrend it will report an uptrend until the
   * next flip, which may be hundreds of bars away.
   */
  unbounded?: boolean;

  /**
   * The study's answer depends on WHICH BARS ARE ON SCREEN, not only on the
   * bars themselves.
   *
   * Exactly one thing in this catalog is like that — a visible-range volume
   * profile — and it changes two things: `compute` is given the exact visible
   * range to clip to, and the memo key follows that range so panning actually
   * recomputes it. Everything else keeps the coarse 200-bar viewport key,
   * which is what stops an ordinary drag from recomputing the whole pane on
   * every frame.
   */
  usesVisibleRange?: boolean;

  /**
   * Whether this study's `source` input may be another study's output.
   *
   * Only true for studies whose maths is genuinely a function of ONE series —
   * a moving average, an RSI, a smoother. A study that reads highs, lows and
   * volume is not expressible over a single line, and offering it a study
   * source would produce a plausible-looking number computed from the wrong
   * arrays. See `lib/native/graph`.
   */
  acceptsStudySource?: boolean;

  compute: (input: NativeComputeInput) => NativeComputeOutput;
}

/** Defaults for a study, as the settings dialog and persistence both need them. */
export function defaultParams(def: NativeStudyDef): NativeParams {
  const out: NativeParams = {};
  for (const input of def.inputs) out[input.key] = input.defval;
  return out;
}

/**
 * Coerce stored or user-supplied params onto the definition's own schema.
 *
 * Total: an unknown key is dropped, a value of the wrong type or outside the
 * declared range falls back to the default. A persisted study written by an
 * older build, or hand-edited, must degrade to a working study rather than
 * computing on a string where a length belongs.
 */
export function normalizeParams(
  def: NativeStudyDef, raw: Readonly<NativeParams> | undefined
): NativeParams {
  const out: NativeParams = {};
  for (const input of def.inputs) {
    const value = raw?.[input.key];
    out[input.key] = coerceInput(input, value);
  }
  return out;
}

function coerceInput(input: NativeInput, value: NativeInputValue | undefined): NativeInputValue {
  switch (input.kind) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return input.defval;
      let v = input.integer === false ? n : Math.round(n);
      /*
       * `step` is a rule about which values exist, not a spinner decoration.
       *
       * The dialog declares 0.1 for Bollinger's deviation and Supertrend's
       * multiplier, and the browser enforces it only for the arrows — a pasted
       * or typed `2.03719` was stored, serialised, and drawn as a band nobody
       * could reproduce from the dialog.
       *
       * The grid is anchored on the DEFAULT rather than on `min`, because the
       * default is by definition a value the study ships with: Bollinger's
       * minimum deviation is 0.001 and its default is 2, and a grid from the
       * minimum would snap that default to 2.001.
       */
      if (input.step !== undefined && input.step > 0) {
        const base = input.defval;
        const steps = Math.round((v - base) / input.step);
        // Re-rounded because binary floating point turns 0.1 * 3 into
        // 0.30000000000000004, which is not a value any dialog offered.
        v = Number((base + steps * input.step).toFixed(10));
      }
      if (input.min !== undefined) v = Math.max(input.min, v);
      if (input.max !== undefined) v = Math.min(input.max, v);
      return v;
    }
    case "select":
      return input.options.some((o) => o.value === value) ? (value as string) : input.defval;
    case "boolean":
      return typeof value === "boolean" ? value : input.defval;
    case "source":
      return (PRICE_SOURCES as readonly string[]).includes(String(value))
        ? (value as string) : input.defval;
  }
}

export type { ChartOverlay };
