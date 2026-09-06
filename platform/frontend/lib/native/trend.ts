"use client";
/**
 * Trend studies.
 *
 * Every entry is a `NativeStudyDef` over `lib/ta/core`, exactly like Tier 1.
 * What is worth reading here are the three places a definition has to say
 * something the maths cannot:
 *
 *   which studies are PATH-DEPENDENT and therefore may not be windowed
 *     (`unbounded`) — KAMA, McGinley and Parabolic SAR carry state that never
 *     converges, so a window is a different indicator rather than a cheaper one;
 *
 *   where a DISPLACEMENT belongs — Ichimoku's spans go forward and its lagging
 *     span goes back, and both happen at plot time, because shifting a series
 *     while computing it makes its values disagree with the bars they came from;
 *
 *   what a study draws that is not a line — the regression channel's bands are
 *     computed from the fit rather than from a rolling window.
 */
import {
  aroon, envelopes, genericMa, ichimoku, kama, linregSlope, mcginley,
  parabolicSar, vortex,
  type GenericMaType,
} from "@/lib/ta/core";
import type { NativeStudyDef } from "@/lib/native/registry";
import { num, ohlcv, resolveSource, str, MA_TYPE_OPTIONS, sourceInput, lengthInput,
  UP, DOWN, ACCENT, AMBER, VIOLET, MUTED } from "@/lib/native/shared";

export const kamaStudy: NativeStudyDef = {
  id: "kama",
  name: "Kaufman's Adaptive Moving Average",
  aliases: ["KAMA", "adaptive"],
  category: "moving-average",
  overlay: true,
  description: "Tracks a trend closely and flattens in chop, by efficiency ratio.",
  inputs: [
    lengthInput(10, "Efficiency length"),
    { kind: "number", key: "fast", title: "Fast", defval: 2, min: 1, max: 500, integer: true },
    { kind: "number", key: "slow", title: "Slow", defval: 30, min: 1, max: 500, integer: true },
    sourceInput,
  ],
  plots: [{ id: "kama", title: "KAMA", style: "line", color: ACCENT, width: 2 }],
  precision: null,
  // The smoothing constant is recomputed per bar from the previous value, and
  // the recursion has no seed it converges back to — a window would start it
  // somewhere else and stay there.
  unbounded: true,
  warmup: (p) => num(p, "length", 10) * 5,
  compute: ({ candles, params }) => ({
    plots: {
      kama: kama(
        resolveSource(candles, str(params, "source", "close")),
        num(params, "length", 10), num(params, "fast", 2), num(params, "slow", 30)),
    },
  }),
};

export const mcginleyStudy: NativeStudyDef = {
  id: "mcginley",
  name: "McGinley Dynamic",
  aliases: ["mcginley"],
  category: "moving-average",
  overlay: true,
  description: "An average whose speed adapts to how far price has run from it.",
  inputs: [lengthInput(14), sourceInput],
  plots: [{ id: "md", title: "McGinley", style: "line", color: AMBER, width: 2 }],
  precision: null,
  unbounded: true,
  warmup: (p) => num(p, "length", 14) * 5,
  compute: ({ candles, params }) => ({
    plots: {
      md: mcginley(
        resolveSource(candles, str(params, "source", "close")), num(params, "length", 14)),
    },
  }),
};

/**
 * Ichimoku Cloud.
 *
 * The displacements are the study's, not the maths': `spanA` and `spanB` are
 * plotted `displacement` bars FORWARD and the lagging span the same distance
 * BACK. Applying them here — at plot time — keeps every computed value
 * attached to the bar it was computed from, which is what makes the cloud
 * agree with the crosshair.
 */
export const ichimokuStudy: NativeStudyDef = {
  id: "ichimoku",
  name: "Ichimoku Cloud",
  aliases: ["ichimoku", "kumo", "tenkan", "kijun"],
  category: "trend",
  overlay: true,
  description: "Conversion, base, the cloud between two leading spans, and a lagging close.",
  inputs: [
    { kind: "number", key: "conversion", title: "Conversion", defval: 9, min: 1, max: 1000, integer: true },
    { kind: "number", key: "base", title: "Base", defval: 26, min: 1, max: 1000, integer: true },
    { kind: "number", key: "spanB", title: "Leading span B", defval: 52, min: 1, max: 2000, integer: true },
    { kind: "number", key: "displacement", title: "Displacement", defval: 26, min: 0, max: 500, integer: true },
  ],
  plots: [
    { id: "conversion", title: "Conversion", style: "line", color: ACCENT },
    { id: "base", title: "Base", style: "line", color: DOWN },
    { id: "spanA", title: "Leading span A", style: "line", color: UP },
    { id: "spanB", title: "Leading span B", style: "line", color: "#e5679a" },
    { id: "lagging", title: "Lagging span", style: "line", color: MUTED },
  ],
  fills: [{ id: "cloud", firstPlotId: "spanA", secondPlotId: "spanB", color: "rgba(46,189,133,0.10)" }],
  precision: null,
  warmup: (p) => (num(p, "spanB", 52) + num(p, "displacement", 26)) * 3,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    const displacement = num(params, "displacement", 26);
    const i = ichimoku(
      high, low, close,
      num(params, "conversion", 9), num(params, "base", 26), num(params, "spanB", 52));
    return {
      plots: {
        conversion: i.conversion, base: i.base,
        spanA: i.spanA, spanB: i.spanB, lagging: i.lagging,
      },
      // Displacement is a DRAWING decision, applied by the plot definition.
      plotOffsets: {
        spanA: displacement, spanB: displacement, lagging: -displacement,
      },
    };
  },
};

export const aroonStudy: NativeStudyDef = {
  id: "aroon",
  name: "Aroon",
  aliases: ["aroon oscillator"],
  category: "trend",
  overlay: false,
  description: "How recently the window's high and low occurred, as a percentage.",
  inputs: [
    lengthInput(14),
    { kind: "boolean", key: "showOscillator", title: "Show oscillator", defval: false },
  ],
  plots: [
    { id: "up", title: "Aroon Up", style: "line", color: UP, width: 2 },
    { id: "down", title: "Aroon Down", style: "line", color: DOWN, width: 2 },
    { id: "osc", title: "Aroon Oscillator", style: "line", color: VIOLET, hiddenByDefault: true },
  ],
  levels: [
    { id: "upper", title: "70", value: 70, color: MUTED, dashed: true },
    { id: "lower", title: "30", value: 30, color: MUTED, dashed: true },
  ],
  precision: 2,
  warmup: (p) => num(p, "length", 14) * 3,
  compute: ({ candles, params }) => {
    const { high, low } = ohlcv(candles);
    const a = aroon(high, low, num(params, "length", 14));
    return { plots: { up: a.up, down: a.down, osc: a.oscillator } };
  },
};

export const psarStudy: NativeStudyDef = {
  id: "psar",
  name: "Parabolic SAR",
  aliases: ["PSAR", "SAR", "parabolic"],
  category: "trend",
  overlay: true,
  description: "A stop that accelerates toward price and flips when price crosses it.",
  inputs: [
    { kind: "number", key: "start", title: "Start", defval: 0.02, min: 0.001, max: 1, integer: false, step: 0.01 },
    { kind: "number", key: "increment", title: "Increment", defval: 0.02, min: 0.001, max: 1, integer: false, step: 0.01 },
    { kind: "number", key: "maximum", title: "Maximum", defval: 0.2, min: 0.01, max: 1, integer: false, step: 0.05 },
  ],
  plots: [{ id: "sar", title: "SAR", style: "circles", color: AMBER, width: 2 }],
  precision: null,
  // A ratcheting state machine: seeded in the wrong direction it stays wrong
  // until the next flip, which may be hundreds of bars away.
  unbounded: true,
  warmup: () => 0,
  compute: ({ candles, params }) => {
    const { high, low } = ohlcv(candles);
    return {
      plots: {
        sar: parabolicSar(
          high, low, num(params, "start", 0.02),
          num(params, "increment", 0.02), num(params, "maximum", 0.2)),
      },
    };
  },
};

export const vortexStudy: NativeStudyDef = {
  id: "vortex",
  name: "Vortex Indicator",
  aliases: ["VI", "vortex"],
  category: "trend",
  overlay: false,
  description: "Opposing trend movements measured against true range.",
  inputs: [lengthInput(14)],
  plots: [
    { id: "plus", title: "VI+", style: "line", color: UP, width: 2 },
    { id: "minus", title: "VI-", style: "line", color: DOWN, width: 2 },
  ],
  levels: [{ id: "one", title: "1", value: 1, color: MUTED, dashed: true }],
  precision: 4,
  warmup: (p) => num(p, "length", 14) * 3,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    const v = vortex(high, low, close, num(params, "length", 14));
    return { plots: { plus: v.plus, minus: v.minus } };
  },
};

export const linregCurveStudy: NativeStudyDef = {
  id: "linregcurve",
  name: "Linear Regression Curve",
  aliases: ["linreg", "regression"],
  category: "trend",
  overlay: true,
  description: "The end point of a rolling least-squares fit, plotted per bar.",
  inputs: [lengthInput(100), sourceInput],
  plots: [{ id: "curve", title: "Regression", style: "line", color: VIOLET, width: 2 }],
  precision: null,
  warmup: (p) => num(p, "length", 100) * 2,
  compute: ({ candles, params }) => {
    const src = resolveSource(candles, str(params, "source", "close"));
    const len = num(params, "length", 100);
    // `linreg(src, len, 0)` is the fit's value at the newest bar of each
    // window — which is exactly what a regression CURVE is.
    const out = new Array<number>(src.length).fill(NaN);
    const slope = linregSlope(src, len);
    const mean = genericMa("SMA", src, len, []);
    for (let i = 0; i < src.length; i++) {
      const s = slope[i]!;
      const m = mean[i]!;
      if (Number.isNaN(s) || Number.isNaN(m)) continue;
      // Value at x = len-1 of a fit whose mean sits at x = (len-1)/2.
      out[i] = m + (s * (len - 1)) / 2;
    }
    return { plots: { curve: out } };
  },
};

/**
 * Linear Regression Channel.
 *
 * The centre is the same rolling fit as the curve; the bands are that fit
 * displaced by a multiple of the residual standard deviation. Computing the
 * bands from `stdev(src)` instead would measure dispersion around the MEAN
 * rather than around the LINE, which on a trending window is a different and
 * much larger number — the channel would be too wide to be a channel.
 */
export const linregChannelStudy: NativeStudyDef = {
  id: "linregchannel",
  name: "Linear Regression Channel",
  aliases: ["regression channel", "linreg channel"],
  category: "trend",
  overlay: true,
  description: "A rolling least-squares fit with standard-deviation bands around it.",
  inputs: [
    lengthInput(100),
    { kind: "number", key: "mult", title: "Deviations", defval: 2, min: 0.1, max: 10, integer: false, step: 0.1 },
    sourceInput,
  ],
  plots: [
    { id: "upper", title: "Upper", style: "line", color: ACCENT },
    { id: "mid", title: "Regression", style: "line", color: VIOLET, width: 2 },
    { id: "lower", title: "Lower", style: "line", color: ACCENT },
  ],
  fills: [{ id: "band", firstPlotId: "upper", secondPlotId: "lower", color: "rgba(155,124,245,0.07)" }],
  precision: null,
  warmup: (p) => num(p, "length", 100) * 2,
  compute: ({ candles, params }) => {
    const src = resolveSource(candles, str(params, "source", "close"));
    const len = Math.max(2, num(params, "length", 100));
    const mult = num(params, "mult", 2);
    const n = src.length;
    const mid = new Array<number>(n).fill(NaN);
    const upper = new Array<number>(n).fill(NaN);
    const lower = new Array<number>(n).fill(NaN);
    const sumX = (len * (len - 1)) / 2;
    const sumX2 = ((len - 1) * len * (2 * len - 1)) / 6;
    const denom = len * sumX2 - sumX * sumX;
    if (denom === 0) return { plots: { upper, mid, lower } };
    outer: for (let i = len - 1; i < n; i++) {
      let sumY = 0;
      let sumXY = 0;
      for (let k = 0; k < len; k++) {
        const v = src[i - len + 1 + k]!;
        if (Number.isNaN(v)) continue outer;
        sumY += v;
        sumXY += k * v;
      }
      const slope = (len * sumXY - sumX * sumY) / denom;
      const intercept = sumY / len - (slope * sumX) / len;
      // Residuals against the LINE, not against the mean.
      let ss = 0;
      for (let k = 0; k < len; k++) {
        const v = src[i - len + 1 + k]!;
        const fit = intercept + slope * k;
        ss += (v - fit) ** 2;
      }
      const dev = Math.sqrt(ss / len);
      const end = intercept + slope * (len - 1);
      if (!Number.isFinite(end) || !Number.isFinite(dev)) continue;
      mid[i] = end;
      upper[i] = end + mult * dev;
      lower[i] = end - mult * dev;
    }
    return { plots: { upper, mid, lower } };
  },
};

export const envelopesStudy: NativeStudyDef = {
  id: "envelopes",
  name: "Envelopes",
  aliases: ["envelope", "moving average envelope"],
  category: "trend",
  overlay: true,
  description: "A moving average displaced by a fixed percentage either side.",
  inputs: [
    lengthInput(20),
    { kind: "number", key: "percent", title: "Percent", defval: 2, min: 0.01, max: 100, integer: false, step: 0.1 },
    { kind: "select", key: "maType", title: "Type", defval: "SMA", options: MA_TYPE_OPTIONS },
    sourceInput,
  ],
  plots: [
    { id: "upper", title: "Upper", style: "line", color: ACCENT },
    { id: "basis", title: "Basis", style: "line", color: AMBER },
    { id: "lower", title: "Lower", style: "line", color: ACCENT },
  ],
  precision: null,
  warmup: (p) => num(p, "length", 20) * 20,
  compute: ({ candles, params }) => {
    const src = resolveSource(candles, str(params, "source", "close"));
    const { volume } = ohlcv(candles);
    const e = envelopes(
      src, num(params, "length", 20), num(params, "percent", 2),
      str(params, "maType", "SMA") as GenericMaType, volume);
    return { plots: { upper: e.upper, basis: e.middle, lower: e.lower } };
  },
};

export const TREND_STUDIES: readonly NativeStudyDef[] = [
  kamaStudy, mcginleyStudy, ichimokuStudy, aroonStudy, psarStudy, vortexStudy,
  linregCurveStudy, linregChannelStudy, envelopesStudy,
];
