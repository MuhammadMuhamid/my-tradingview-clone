"use client";
/**
 * Volatility, channels, volume flow and the statistical chart tools.
 *
 * ── The statistical ones, and where they stop ──────────────────────────────
 *
 * Standard deviation, variance, z-score, percentile rank, regression slope,
 * R-squared and historical volatility are here because each is a legible LINE
 * about the instrument on screen: "how far from its own mean is this", "how
 * reliable is this trend", "how volatile has this been".
 *
 * Covariance, skewness, kurtosis, downside deviation, Sharpe, Sortino,
 * autocorrelation and return distributions are NOT here, and that is a
 * decision rather than an omission. They are either two-series or
 * whole-distribution concepts; forcing them onto a price chart would produce a
 * line in units nobody can read against a price axis, purely so a feature list
 * could claim them. The shared maths implements covariance because correlation
 * and beta are defined in terms of it; the rest belong to Research and the
 * Backtester, and the final report records that.
 */
import {
  accumulationDistribution, bollingerBandWidth, bollingerPercentB, chaikinMoneyFlow,
  choppiness, donchian, hlc3, historicalVolatility, keltner, linregSlope, mfi,
  percentileRank, priceVolumeTrend, rSquared, stdev, variance, volumeFlowIndicator,
  volumeOscillator, zscore,
  type GenericMaType,
} from "@/lib/ta/core";
import type { NativeStudyDef } from "@/lib/native/registry";
import { INTERVAL_MS } from "@/lib/types";
import {
  ACCENT, AMBER, DOWN, MUTED, UP, VIOLET, bool, lengthInput, num, ohlcv,
  resolveSource, sourceInput, str, zeroLevel, MA_TYPE_OPTIONS,
} from "@/lib/native/shared";

// ── volatility and channels ────────────────────────────────────────────────

export const bbPercentBStudy: NativeStudyDef = {
  id: "bbpercent",
  name: "Bollinger %B",
  aliases: ["%B", "percent b"],
  category: "volatility",
  overlay: false,
  description: "Where price sits across the Bollinger band: 0 at the lower, 1 at the upper.",
  inputs: [
    lengthInput(20),
    { kind: "number", key: "mult", title: "Std dev", defval: 2, min: 0.001, max: 50, integer: false, step: 0.1 },
    sourceInput,
  ],
  plots: [{ id: "b", title: "%B", style: "line", color: ACCENT, width: 2 }],
  levels: [
    { id: "upper", title: "1", value: 1, color: MUTED, dashed: true },
    { id: "mid", title: "0.5", value: 0.5, color: MUTED, dashed: true },
    { id: "lower", title: "0", value: 0, color: MUTED, dashed: true },
  ],
  precision: 4,
  warmup: (p) => num(p, "length", 20) * 4,
  compute: ({ candles, params }) => ({
    plots: {
      b: bollingerPercentB(
        resolveSource(candles, str(params, "source", "close")),
        num(params, "length", 20), num(params, "mult", 2)),
    },
  }),
};

export const bbWidthStudy: NativeStudyDef = {
  id: "bbwidth",
  name: "Bollinger Band Width",
  aliases: ["BBW", "band width", "squeeze"],
  category: "volatility",
  overlay: false,
  description: "Band width as a fraction of the basis — a squeeze reads as a trough.",
  inputs: [
    lengthInput(20),
    { kind: "number", key: "mult", title: "Std dev", defval: 2, min: 0.001, max: 50, integer: false, step: 0.1 },
    sourceInput,
  ],
  plots: [{ id: "w", title: "Width", style: "line", color: VIOLET, width: 2 }],
  precision: 4,
  warmup: (p) => num(p, "length", 20) * 4,
  compute: ({ candles, params }) => ({
    plots: {
      w: bollingerBandWidth(
        resolveSource(candles, str(params, "source", "close")),
        num(params, "length", 20), num(params, "mult", 2)),
    },
  }),
};

export const keltnerStudy: NativeStudyDef = {
  id: "keltner",
  name: "Keltner Channels",
  aliases: ["keltner", "KC"],
  category: "volatility",
  overlay: true,
  description: "An EMA with ATR envelopes — volatility bands that do not breathe with outliers.",
  inputs: [
    lengthInput(20),
    { kind: "number", key: "mult", title: "Multiplier", defval: 2, min: 0.001, max: 50, integer: false, step: 0.1 },
    { kind: "number", key: "atrLength", title: "ATR length", defval: 10, min: 1, max: 1000, integer: true },
  ],
  plots: [
    { id: "upper", title: "Upper", style: "line", color: ACCENT },
    { id: "basis", title: "Basis", style: "line", color: AMBER },
    { id: "lower", title: "Lower", style: "line", color: ACCENT },
  ],
  fills: [{ id: "band", firstPlotId: "upper", secondPlotId: "lower", color: "rgba(79,140,255,0.06)" }],
  precision: null,
  warmup: (p) => Math.max(num(p, "length", 20), num(p, "atrLength", 10)) * 20,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    const k = keltner(
      high, low, close,
      num(params, "length", 20), num(params, "mult", 2), num(params, "atrLength", 10));
    return { plots: { upper: k.upper, basis: k.middle, lower: k.lower } };
  },
};

export const donchianStudy: NativeStudyDef = {
  id: "donchian",
  name: "Donchian Channels",
  aliases: ["donchian", "price channel"],
  category: "volatility",
  overlay: true,
  description: "The highest high and lowest low of the window, with their midpoint.",
  inputs: [lengthInput(20)],
  plots: [
    { id: "upper", title: "Upper", style: "line", color: UP },
    { id: "basis", title: "Basis", style: "line", color: MUTED, hiddenByDefault: true },
    { id: "lower", title: "Lower", style: "line", color: DOWN },
  ],
  fills: [{ id: "band", firstPlotId: "upper", secondPlotId: "lower", color: "rgba(139,147,167,0.06)" }],
  precision: null,
  warmup: (p) => num(p, "length", 20) * 2,
  compute: ({ candles, params }) => {
    const { high, low } = ohlcv(candles);
    const d = donchian(high, low, num(params, "length", 20));
    return { plots: { upper: d.upper, basis: d.middle, lower: d.lower } };
  },
};

/**
 * Annualised close-to-close volatility.
 *
 * `barsPerYear` is derived from the chart's own interval rather than being an
 * input, because it is a property of the TIMEFRAME and not a preference: 1m
 * bars and 1d bars annualise by factors that differ by more than twenty-fold,
 * and a constant would be wrong on ten of the eleven intervals this product
 * serves.
 */
export const historicalVolatilityStudy: NativeStudyDef = {
  id: "hv",
  name: "Historical Volatility",
  aliases: ["HV", "volatility", "realised volatility"],
  category: "statistics",
  overlay: false,
  description: "Annualised close-to-close volatility, in percent.",
  inputs: [lengthInput(20)],
  plots: [{ id: "hv", title: "HV", style: "line", color: AMBER, width: 2 }],
  precision: 2,
  warmup: (p) => num(p, "length", 20) * 3,
  compute: ({ candles, params, interval }) => {
    const { close } = ohlcv(candles);
    // Crypto spot trades continuously, so a year is simply how many bars of
    // this size fit into one.
    const barsPerYear = (365 * 24 * 60 * 60 * 1000) / INTERVAL_MS[interval];
    return { plots: { hv: historicalVolatility(close, num(params, "length", 20), barsPerYear) } };
  },
};

export const choppinessStudy: NativeStudyDef = {
  id: "chop",
  name: "Choppiness Index",
  aliases: ["CHOP", "choppiness"],
  category: "volatility",
  overlay: false,
  description: "Ground covered against distance travelled — high is chop, low is trend.",
  inputs: [lengthInput(14)],
  plots: [{ id: "chop", title: "CHOP", style: "line", color: VIOLET, width: 2 }],
  levels: [
    { id: "upper", title: "61.8", value: 61.8, color: MUTED, dashed: true },
    { id: "lower", title: "38.2", value: 38.2, color: MUTED, dashed: true },
  ],
  precision: 2,
  warmup: (p) => num(p, "length", 14) * 3,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    return { plots: { chop: choppiness(high, low, close, num(params, "length", 14)) } };
  },
};

// ── volume and flow ────────────────────────────────────────────────────────

export const mfiStudy: NativeStudyDef = {
  id: "mfi",
  name: "Money Flow Index",
  aliases: ["MFI", "money flow"],
  category: "volume",
  overlay: false,
  description: "RSI weighted by volume — a 0–100 read on money moving in or out.",
  inputs: [lengthInput(14)],
  plots: [{ id: "mfi", title: "MFI", style: "line", color: ACCENT, width: 2 }],
  levels: [
    { id: "upper", title: "80", value: 80, color: MUTED, dashed: true },
    { id: "lower", title: "20", value: 20, color: MUTED, dashed: true },
  ],
  precision: 2,
  warmup: (p) => num(p, "length", 14) * 3,
  compute: ({ candles, params }) => {
    const { high, low, close, volume } = ohlcv(candles);
    return { plots: { mfi: mfi(hlc3(high, low, close), volume, num(params, "length", 14)) } };
  },
};

export const cmfStudy: NativeStudyDef = {
  id: "cmf",
  name: "Chaikin Money Flow",
  aliases: ["CMF"],
  category: "volume",
  overlay: false,
  description: "Where each bar closed within its range, weighted by volume and averaged.",
  inputs: [lengthInput(20)],
  plots: [{ id: "cmf", title: "CMF", style: "line", color: VIOLET, width: 2 }],
  levels: [zeroLevel],
  precision: 4,
  warmup: (p) => num(p, "length", 20) * 2,
  compute: ({ candles, params }) => {
    const { high, low, close, volume } = ohlcv(candles);
    return {
      plots: { cmf: chaikinMoneyFlow(high, low, close, volume, num(params, "length", 20)) },
    };
  },
};

export const adStudy: NativeStudyDef = {
  id: "ad",
  name: "Accumulation / Distribution",
  aliases: ["A/D", "accumulation", "distribution"],
  category: "volume",
  overlay: false,
  description: "The money-flow multiplier, accumulated bar by bar.",
  inputs: [],
  plots: [{ id: "ad", title: "A/D", style: "line", color: ACCENT, width: 2 }],
  precision: 0,
  // A running total from the first bar; a window would start it elsewhere.
  unbounded: true,
  warmup: () => 0,
  compute: ({ candles }) => {
    const { high, low, close, volume } = ohlcv(candles);
    return { plots: { ad: accumulationDistribution(high, low, close, volume) } };
  },
};

export const volumeOscStudy: NativeStudyDef = {
  id: "volosc",
  name: "Volume Oscillator",
  aliases: ["volume oscillator", "PVO"],
  category: "volume",
  overlay: false,
  description: "The spread between a fast and a slow volume average, in percent.",
  inputs: [
    { kind: "number", key: "fast", title: "Fast", defval: 5, min: 1, max: 1000, integer: true },
    { kind: "number", key: "slow", title: "Slow", defval: 10, min: 1, max: 2000, integer: true },
  ],
  plots: [{ id: "osc", title: "Volume Osc", style: "line", color: AMBER, width: 2 }],
  levels: [zeroLevel],
  precision: 2,
  warmup: (p) => num(p, "slow", 10) * 20,
  compute: ({ candles, params }) => {
    const { volume } = ohlcv(candles);
    return {
      plots: { osc: volumeOscillator(volume, num(params, "fast", 5), num(params, "slow", 10)) },
    };
  },
};

export const pvtStudy: NativeStudyDef = {
  id: "pvt",
  name: "Price Volume Trend",
  aliases: ["PVT"],
  category: "volume",
  overlay: false,
  description: "OBV weighted by the SIZE of each move rather than only its sign.",
  inputs: [],
  plots: [{ id: "pvt", title: "PVT", style: "line", color: UP, width: 2 }],
  precision: 0,
  unbounded: true,
  warmup: () => 0,
  compute: ({ candles }) => {
    const { close, volume } = ohlcv(candles);
    return { plots: { pvt: priceVolumeTrend(close, volume) } };
  },
};

export const vfiStudy: NativeStudyDef = {
  id: "vfi",
  name: "Volume Flow Indicator",
  aliases: ["VFI"],
  category: "volume",
  overlay: false,
  description: "Cutoff-filtered, volume-capped money flow: noise and spikes both bounded.",
  inputs: [
    lengthInput(130),
    { kind: "number", key: "coef", title: "Cutoff coefficient", defval: 0.2, min: 0.01, max: 10, integer: false, step: 0.05 },
    { kind: "number", key: "volumeCoef", title: "Volume cap", defval: 2.5, min: 0.1, max: 20, integer: false, step: 0.1 },
    { kind: "number", key: "smooth", title: "Smoothing", defval: 3, min: 1, max: 500, integer: true },
  ],
  plots: [{ id: "vfi", title: "VFI", style: "line", color: ACCENT, width: 2 }],
  levels: [zeroLevel],
  precision: 4,
  warmup: (p) => num(p, "length", 130) * 3,
  compute: ({ candles, params }) => {
    const { high, low, close, volume } = ohlcv(candles);
    return {
      plots: {
        vfi: volumeFlowIndicator(
          high, low, close, volume,
          num(params, "length", 130), num(params, "coef", 0.2),
          num(params, "volumeCoef", 2.5), num(params, "smooth", 3)),
      },
    };
  },
};

// ── statistical chart tools ────────────────────────────────────────────────

/**
 * Standard deviation, with variance as a style option rather than a second
 * study.
 *
 * They are the same measurement squared, so two entries would be two ways to
 * read one line and would invite the reader to compare them as if they were
 * independent. `variance` is exactly `stdev²` here by construction — the
 * shared maths derives one from the other.
 */
export const stdevStudy: NativeStudyDef = {
  id: "stdev",
  name: "Standard Deviation",
  aliases: ["stdev", "variance", "sigma"],
  category: "statistics",
  overlay: false,
  description: "Rolling dispersion of the source, or its square as variance.",
  inputs: [
    lengthInput(20),
    {
      kind: "select", key: "output", title: "Output", defval: "stdev",
      options: [
        { value: "stdev", label: "Standard deviation" },
        { value: "variance", label: "Variance" },
      ],
    },
    sourceInput,
  ],
  plots: [{ id: "value", title: "Std dev", style: "line", color: VIOLET, width: 2 }],
  precision: null,
  warmup: (p) => num(p, "length", 20) * 2,
  compute: ({ candles, params }) => {
    const src = resolveSource(candles, str(params, "source", "close"));
    const len = num(params, "length", 20);
    return {
      plots: {
        value: str(params, "output", "stdev") === "variance"
          ? variance(src, len) : stdev(src, len),
      },
    };
  },
};

export const zScoreStudy: NativeStudyDef = {
  id: "zscore",
  name: "Z-Score",
  aliases: ["z-score", "zscore", "standard score"],
  category: "statistics",
  overlay: false,
  description: "How many standard deviations the source is from its own rolling mean.",
  inputs: [lengthInput(20), sourceInput],
  plots: [{ id: "z", title: "Z-Score", style: "line", color: ACCENT, width: 2 }],
  levels: [
    { id: "upper", title: "2", value: 2, color: MUTED, dashed: true },
    { id: "zero", title: "0", value: 0, color: MUTED, dashed: true },
    { id: "lower", title: "-2", value: -2, color: MUTED, dashed: true },
  ],
  precision: 4,
  warmup: (p) => num(p, "length", 20) * 2,
  compute: ({ candles, params }) => ({
    plots: {
      z: zscore(resolveSource(candles, str(params, "source", "close")), num(params, "length", 20)),
    },
  }),
};

export const percentileStudy: NativeStudyDef = {
  id: "percentile",
  name: "Percentile Rank",
  aliases: ["percentile", "rank"],
  category: "statistics",
  overlay: false,
  description: "Where the current value sits within its own window, as a percentage.",
  inputs: [lengthInput(100), sourceInput],
  plots: [{ id: "pr", title: "Percentile", style: "line", color: AMBER, width: 2 }],
  levels: [
    { id: "upper", title: "80", value: 80, color: MUTED, dashed: true },
    { id: "mid", title: "50", value: 50, color: MUTED, dashed: true },
    { id: "lower", title: "20", value: 20, color: MUTED, dashed: true },
  ],
  precision: 2,
  warmup: (p) => num(p, "length", 100) * 2,
  compute: ({ candles, params }) => ({
    plots: {
      pr: percentileRank(
        resolveSource(candles, str(params, "source", "close")), num(params, "length", 100)),
    },
  }),
};

export const slopeStudy: NativeStudyDef = {
  id: "linregslope",
  name: "Linear Regression Slope",
  aliases: ["slope", "regression slope"],
  category: "statistics",
  overlay: false,
  description: "The gradient of the rolling least-squares fit, in source units per bar.",
  inputs: [lengthInput(100), sourceInput],
  plots: [{ id: "slope", title: "Slope", style: "line", color: VIOLET, width: 2 }],
  levels: [zeroLevel],
  precision: null,
  warmup: (p) => num(p, "length", 100) * 2,
  compute: ({ candles, params }) => ({
    plots: {
      slope: linregSlope(
        resolveSource(candles, str(params, "source", "close")), num(params, "length", 100)),
    },
  }),
};

/**
 * R-squared.
 *
 * A flat window has no fit to score, so the value is `na` there rather than 1.
 * Reporting a perfect fit at the moment there is no trend is exactly backwards
 * from what the reader would conclude.
 */
export const rSquaredStudy: NativeStudyDef = {
  id: "rsquared",
  name: "R-Squared",
  aliases: ["r2", "r-squared", "fit quality"],
  category: "statistics",
  overlay: false,
  description: "How well the rolling straight-line fit explains the window, 0 to 1.",
  inputs: [lengthInput(100), sourceInput],
  plots: [{ id: "r2", title: "R²", style: "line", color: ACCENT, width: 2 }],
  levels: [
    { id: "strong", title: "0.8", value: 0.8, color: MUTED, dashed: true },
    { id: "weak", title: "0.2", value: 0.2, color: MUTED, dashed: true },
  ],
  precision: 4,
  warmup: (p) => num(p, "length", 100) * 2,
  compute: ({ candles, params }) => ({
    plots: {
      r2: rSquared(
        resolveSource(candles, str(params, "source", "close")), num(params, "length", 100)),
    },
  }),
};

export const VOLATILITY_STUDIES: readonly NativeStudyDef[] = [
  bbPercentBStudy, bbWidthStudy, keltnerStudy, donchianStudy, choppinessStudy,
];

export const VOLUME_STUDIES: readonly NativeStudyDef[] = [
  mfiStudy, cmfStudy, adStudy, volumeOscStudy, pvtStudy, vfiStudy,
];

export const STATISTICS_STUDIES: readonly NativeStudyDef[] = [
  stdevStudy, zScoreStudy, percentileStudy, slopeStudy, rSquaredStudy,
  historicalVolatilityStudy,
];

export { bool, MA_TYPE_OPTIONS };
export type { GenericMaType };
