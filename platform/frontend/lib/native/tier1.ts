"use client";
/**
 * The Tier-1 built-in studies.
 *
 * Twelve entries, chosen because they are what a chart is opened to look at.
 * Each is a `NativeStudyDef` and nothing more: identity, inputs, plots, and a
 * pure `compute` that calls the canonical math in `lib/ta/core`. There is no
 * per-study rendering code, no per-study settings dialog and no per-study
 * persistence — the registry drives all three, which is the point of having
 * one.
 *
 * ── Defaults ───────────────────────────────────────────────────────────────
 *
 * The inputs default to the values the rest of this product already uses where
 * it has an opinion (the alert engine's Supertrend 10/3 Wilder, the MACD
 * 12/26/9 its alert family defaults to) and to the conventional values
 * otherwise. A default that disagreed with the alert engine would mean the
 * line on the chart and the line the server alerts on were different lines.
 */
import {
  adx, atr, bollinger, genericMa, macd as macdOf, obv,
  rsi, stochastic, stochasticRsi, supertrend, vwap,
  type GenericMaType,
} from "@/lib/ta/core";
import type {
  NativeComputeInput, NativeComputeOutput, NativeStudyDef,
} from "@/lib/native/registry";
import {
  ACCENT, AMBER, DOWN, MA_TYPE_OPTIONS, MUTED, UP, VIOLET,
  bool, lengthInput, num, ohlcv, resolveSource, sourceInput, str,
} from "@/lib/native/shared";

// ── 1. Moving Average ───────────────────────────────────────────────────────

/**
 * One study, eight averages.
 *
 * TradingView ships these as separate built-ins. One entry with a type input is
 * the same capability with one settings dialog, one legend row and one
 * persisted shape — and it makes "change my EMA 50 to an HMA 50" a dropdown
 * rather than a remove-and-re-add.
 */
export const movingAverageStudy: NativeStudyDef = {
  id: "ma",
  name: "Moving Average",
  aliases: ["SMA", "EMA", "WMA", "HMA", "VWMA", "DEMA", "TEMA", "RMA", "average"],
  category: "moving-average",
  overlay: true,
  description: "Simple, exponential, weighted, Hull, volume-weighted, double or triple.",
  inputs: [
    { kind: "select", key: "maType", title: "Type", defval: "EMA", options: MA_TYPE_OPTIONS },
    lengthInput(50),
    sourceInput,
  ],
  plots: [{ id: "ma", title: "MA", style: "line", color: ACCENT, width: 2 }],
  precision: null,
  warmup: (p) => num(p, "length", 50) * 20,
  compute: ({ candles, params, sources }: NativeComputeInput): NativeComputeOutput => {
    const src = resolveSource(candles, str(params, "source", "close"), sources);
    const { volume } = ohlcv(candles);
    const type = str(params, "maType", "EMA") as GenericMaType;
    return { plots: { ma: genericMa(type, src, num(params, "length", 50), volume) } };
  },
};

// ── 2. RSI ──────────────────────────────────────────────────────────────────

export const rsiStudy: NativeStudyDef = {
  id: "rsi",
  name: "Relative Strength Index",
  aliases: ["RSI"],
  category: "momentum",
  overlay: false,
  description: "Average gain against average loss, on a 0–100 scale.",
  inputs: [lengthInput(14), sourceInput],
  plots: [{ id: "rsi", title: "RSI", style: "line", color: VIOLET, width: 2 }],
  levels: [
    { id: "upper", title: "70", value: 70, color: MUTED, dashed: true },
    { id: "middle", title: "50", value: 50, color: MUTED, dashed: true },
    { id: "lower", title: "30", value: 30, color: MUTED, dashed: true },
  ],
  precision: 2,
  warmup: (p) => num(p, "length", 14) * 20,
  compute: ({ candles, params, sources }) => ({
    plots: {
      rsi: rsi(resolveSource(candles, str(params, "source", "close"), sources), num(params, "length", 14)),
    },
  }),
};

// ── 3. MACD ─────────────────────────────────────────────────────────────────

export const macdStudy: NativeStudyDef = {
  id: "macd",
  name: "MACD",
  aliases: ["moving average convergence divergence"],
  category: "momentum",
  overlay: false,
  description: "Fast MA minus slow MA, with its own signal line and histogram.",
  inputs: [
    { kind: "number", key: "fast", title: "Fast length", defval: 12, min: 1, max: 2000, integer: true },
    { kind: "number", key: "slow", title: "Slow length", defval: 26, min: 1, max: 2000, integer: true },
    { kind: "number", key: "signal", title: "Signal length", defval: 9, min: 1, max: 2000, integer: true },
    sourceInput,
  ],
  plots: [
    { id: "hist", title: "Histogram", style: "histogram", color: MUTED },
    { id: "macd", title: "MACD", style: "line", color: ACCENT, width: 2 },
    { id: "signal", title: "Signal", style: "line", color: AMBER, width: 2 },
  ],
  levels: [{ id: "zero", title: "0", value: 0, color: MUTED, dashed: true }],
  precision: null,
  warmup: (p) => (num(p, "slow", 26) + num(p, "signal", 9)) * 20,
  compute: ({ candles, params, sources }) => {
    const src = resolveSource(candles, str(params, "source", "close"), sources);
    const m = macdOf(src, num(params, "fast", 12), num(params, "slow", 26), num(params, "signal", 9));
    /*
     * The histogram is coloured by its own direction as well as its sign —
     * four states, which is what makes momentum fading visible before the
     * bars cross zero. This is the study's own colouring, not a user style,
     * so it is per-bar rather than a single plot colour.
     */
    const colors = m.histogram.map((v, i) => {
      if (Number.isNaN(v)) return null;
      const prev = m.histogram[i - 1];
      const rising = prev === undefined || Number.isNaN(prev) ? true : v >= prev;
      if (v >= 0) return rising ? UP : "#7fd6b3";
      return rising ? "#f79aa8" : DOWN;
    });
    return {
      plots: { macd: m.macd, signal: m.signal, hist: m.histogram },
      colors: { hist: colors },
    };
  },
};

// ── 4. Bollinger Bands ──────────────────────────────────────────────────────

export const bollingerStudy: NativeStudyDef = {
  id: "bb",
  name: "Bollinger Bands",
  aliases: ["BB", "bands"],
  category: "volatility",
  overlay: true,
  description: "A moving average with symmetric standard-deviation envelopes.",
  inputs: [
    lengthInput(20),
    { kind: "number", key: "mult", title: "Std dev", defval: 2, min: 0.001, max: 50, integer: false, step: 0.1 },
    { kind: "select", key: "maType", title: "Basis type", defval: "SMA", options: MA_TYPE_OPTIONS },
    sourceInput,
  ],
  plots: [
    { id: "upper", title: "Upper", style: "line", color: ACCENT },
    { id: "basis", title: "Basis", style: "line", color: AMBER },
    { id: "lower", title: "Lower", style: "line", color: ACCENT },
  ],
  fills: [{ id: "band", firstPlotId: "upper", secondPlotId: "lower", color: "rgba(79,140,255,0.08)" }],
  precision: null,
  // The basis may be EMA, RMA, DEMA or TEMA — all recursive — so this
  // follows the registry's twenty-lengths rule like every sibling. At *4 the
  // band was wrong by a displayable amount at the left of the viewport and
  // moved when the user zoomed.
  warmup: (p) => num(p, "length", 20) * 20,
  compute: ({ candles, params, sources }) => {
    const src = resolveSource(candles, str(params, "source", "close"), sources);
    const { volume } = ohlcv(candles);
    const b = bollinger(
      src, num(params, "length", 20), num(params, "mult", 2),
      str(params, "maType", "SMA") as GenericMaType, volume);
    return { plots: { upper: b.upper, basis: b.middle, lower: b.lower } };
  },
};

// ── 5. ATR ──────────────────────────────────────────────────────────────────

export const atrStudy: NativeStudyDef = {
  id: "atr",
  name: "Average True Range",
  aliases: ["ATR", "volatility"],
  category: "volatility",
  overlay: false,
  description: "Wilder's average of true range — volatility in price units.",
  inputs: [lengthInput(14)],
  plots: [{ id: "atr", title: "ATR", style: "line", color: AMBER, width: 2 }],
  precision: null,
  warmup: (p) => num(p, "length", 14) * 20,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    return { plots: { atr: atr(high, low, close, num(params, "length", 14)) } };
  },
};

// ── 6. VWAP ─────────────────────────────────────────────────────────────────

/**
 * Session VWAP, on the UTC day boundary.
 *
 * Crypto spot trades continuously, so there is no exchange session to anchor
 * to; the UTC day is the boundary the chart's own clock already uses
 * (`lib/chartClock`), which makes the reset visible at a place the reader can
 * see on the time axis rather than at an invented one.
 */
export const vwapStudy: NativeStudyDef = {
  id: "vwap",
  name: "VWAP",
  aliases: ["volume weighted average price", "session vwap"],
  category: "volume",
  overlay: true,
  description: "Volume-weighted average price, reset each UTC day.",
  inputs: [{ kind: "source", key: "source", title: "Source", defval: "hlc3" }],
  plots: [{ id: "vwap", title: "VWAP", style: "line", color: AMBER, width: 2 }],
  precision: null,
  // A session accumulation: its value at a bar depends on every bar since the
  // last reset, so a window would silently restart the session.
  unbounded: true,
  warmup: () => 0,
  compute: ({ candles, params, sources }) => {
    const src = resolveSource(candles, str(params, "source", "hlc3"), sources);
    const { volume } = ohlcv(candles);
    const DAY = 86_400_000;
    const starts = candles.map((c, i) => {
      if (i === 0) return true;
      return Math.floor(c.openTime / DAY) !== Math.floor(candles[i - 1]!.openTime / DAY);
    });
    return { plots: { vwap: vwap(src, volume, starts) } };
  },
};

// ── 7. Supertrend ───────────────────────────────────────────────────────────

/**
 * The same Supertrend the alert engine flips on.
 *
 * Defaults are `SUPERTREND_DEFAULTS` from the alert types — 10 / 3 / Wilder —
 * deliberately, so the line drawn here is the line a Supertrend alert on this
 * chart watches. A different default would put two Supertrends in the product.
 */
export const supertrendStudy: NativeStudyDef = {
  id: "supertrend",
  name: "Supertrend",
  aliases: ["ST"],
  category: "trend",
  overlay: true,
  description: "An ATR band that ratchets one way until price closes through it.",
  inputs: [
    { kind: "number", key: "period", title: "ATR period", defval: 10, min: 1, max: 1000, integer: true },
    { kind: "number", key: "multiplier", title: "Multiplier", defval: 3, min: 0.001, max: 100, integer: false, step: 0.1 },
    {
      kind: "select", key: "atrMethod", title: "ATR method", defval: "rma",
      options: [{ value: "rma", label: "Wilder (RMA)" }, { value: "sma", label: "Simple" }],
    },
  ],
  plots: [{ id: "line", title: "Supertrend", style: "line", color: UP, width: 2 }],
  precision: null,
  /*
   * The bands ratchet and the trend carries, so the state at a bar depends on
   * the whole chain before it and does not converge. Seeded mid-downtrend, a
   * windowed Supertrend reports an uptrend until the next flip — which may be
   * hundreds of bars away, and which is the signal the study exists to give.
   */
  unbounded: true,
  warmup: (p) => num(p, "period", 10) * 20,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    const st = supertrend(
      high, low, close, num(params, "period", 10), num(params, "multiplier", 3),
      str(params, "atrMethod", "rma") === "rma");
    return {
      plots: { line: st.line },
      // The band's colour IS the signal: green while the trend is up, red
      // while it is down. A single-colour Supertrend hides the only thing it
      // is asked.
      colors: {
        line: st.trend.map((t) => (Number.isNaN(t) ? null : t === 1 ? UP : DOWN)),
      },
    };
  },
};

// ── 8. Stochastic ───────────────────────────────────────────────────────────

export const stochasticStudy: NativeStudyDef = {
  id: "stoch",
  name: "Stochastic",
  aliases: ["stoch", "%K", "%D"],
  category: "momentum",
  overlay: false,
  description: "Where the close sits in its recent range, smoothed.",
  inputs: [
    { kind: "number", key: "kLength", title: "%K length", defval: 14, min: 1, max: 2000, integer: true },
    { kind: "number", key: "kSmooth", title: "%K smoothing", defval: 1, min: 1, max: 500, integer: true },
    { kind: "number", key: "dSmooth", title: "%D smoothing", defval: 3, min: 1, max: 500, integer: true },
  ],
  plots: [
    { id: "k", title: "%K", style: "line", color: ACCENT, width: 2 },
    { id: "d", title: "%D", style: "line", color: AMBER },
  ],
  levels: [
    { id: "upper", title: "80", value: 80, color: MUTED, dashed: true },
    { id: "lower", title: "20", value: 20, color: MUTED, dashed: true },
  ],
  precision: 2,
  warmup: (p) => (num(p, "kLength", 14) + num(p, "kSmooth", 1) + num(p, "dSmooth", 3)) * 3,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    const s = stochastic(
      high, low, close,
      num(params, "kLength", 14), num(params, "kSmooth", 1), num(params, "dSmooth", 3));
    return { plots: { k: s.k, d: s.d } };
  },
};

// ── 9. Stochastic RSI ───────────────────────────────────────────────────────

export const stochasticRsiStudy: NativeStudyDef = {
  id: "stochrsi",
  name: "Stochastic RSI",
  aliases: ["stoch rsi", "srsi"],
  category: "momentum",
  overlay: false,
  description: "The stochastic formula applied to RSI rather than to price.",
  inputs: [
    { kind: "number", key: "rsiLength", title: "RSI length", defval: 14, min: 1, max: 2000, integer: true },
    { kind: "number", key: "stochLength", title: "Stochastic length", defval: 14, min: 1, max: 2000, integer: true },
    { kind: "number", key: "kSmooth", title: "%K smoothing", defval: 3, min: 1, max: 500, integer: true },
    { kind: "number", key: "dSmooth", title: "%D smoothing", defval: 3, min: 1, max: 500, integer: true },
    sourceInput,
  ],
  plots: [
    { id: "k", title: "%K", style: "line", color: ACCENT, width: 2 },
    { id: "d", title: "%D", style: "line", color: AMBER },
  ],
  levels: [
    { id: "upper", title: "80", value: 80, color: MUTED, dashed: true },
    { id: "lower", title: "20", value: 20, color: MUTED, dashed: true },
  ],
  precision: 2,
  warmup: (p) => (num(p, "rsiLength", 14) + num(p, "stochLength", 14)) * 20,
  compute: ({ candles, params, sources }) => {
    const src = resolveSource(candles, str(params, "source", "close"), sources);
    const s = stochasticRsi(
      src, num(params, "rsiLength", 14), num(params, "stochLength", 14),
      num(params, "kSmooth", 3), num(params, "dSmooth", 3));
    return { plots: { k: s.k, d: s.d } };
  },
};

// ── 10. Volume ──────────────────────────────────────────────────────────────

export const volumeStudy: NativeStudyDef = {
  id: "volume",
  name: "Volume",
  aliases: ["vol"],
  category: "volume",
  overlay: false,
  description: "Base-asset volume per bar, with an optional moving average.",
  inputs: [
    { kind: "boolean", key: "showMa", title: "Show MA", defval: true },
    { kind: "number", key: "maLength", title: "MA length", defval: 20, min: 1, max: 2000, integer: true },
  ],
  plots: [
    { id: "volume", title: "Volume", style: "columns", color: MUTED },
    { id: "ma", title: "Volume MA", style: "line", color: AMBER, width: 2 },
  ],
  precision: 0,
  warmup: (p) => num(p, "maLength", 20) * 3,
  compute: ({ candles, params }) => {
    const { volume, close } = ohlcv(candles);
    const showMa = bool(params, "showMa", true);
    const ma = showMa
      ? genericMa("SMA", volume, num(params, "maLength", 20), volume)
      : new Array<number>(volume.length).fill(NaN);
    return {
      plots: { volume, ma },
      colors: {
        volume: candles.map((c, i) => {
          const prev = close[i - 1];
          // Up/down by the bar's own body, falling back to the previous close
          // on the first bar — the same rule the chart's own volume pane uses.
          const up = c.close === c.open
            ? prev === undefined || c.close >= prev
            : c.close > c.open;
          return up ? "rgba(46,189,133,0.5)" : "rgba(246,70,93,0.5)";
        }),
      },
    };
  },
};

// ── 11. OBV ─────────────────────────────────────────────────────────────────

export const obvStudy: NativeStudyDef = {
  id: "obv",
  name: "On-Balance Volume",
  aliases: ["OBV"],
  category: "volume",
  overlay: false,
  description: "Volume signed by the direction of the close, accumulated.",
  inputs: [
    { kind: "boolean", key: "showMa", title: "Show MA", defval: false },
    { kind: "number", key: "maLength", title: "MA length", defval: 20, min: 1, max: 2000, integer: true },
  ],
  plots: [
    { id: "obv", title: "OBV", style: "line", color: ACCENT, width: 2 },
    { id: "ma", title: "OBV MA", style: "line", color: AMBER, hiddenByDefault: true },
  ],
  precision: 0,
  // A running total from the first comparable bar: a window would start the
  // accumulation somewhere else and draw a differently-shaped line.
  unbounded: true,
  warmup: () => 0,
  compute: ({ candles, params }) => {
    const { close, volume } = ohlcv(candles);
    const series = obv(close, volume);
    const ma = bool(params, "showMa", false)
      ? genericMa("SMA", series, num(params, "maLength", 20), volume)
      : new Array<number>(series.length).fill(NaN);
    return { plots: { obv: series, ma } };
  },
};

// ── 12. ADX / DMI ───────────────────────────────────────────────────────────

export const adxStudy: NativeStudyDef = {
  id: "adx",
  name: "ADX / DMI",
  aliases: ["ADX", "DMI", "directional movement", "+DI", "-DI"],
  category: "trend",
  overlay: false,
  description: "Wilder's directional movement: trend strength and its direction.",
  inputs: [
    { kind: "number", key: "diLength", title: "DI length", defval: 14, min: 1, max: 2000, integer: true },
    { kind: "number", key: "adxLength", title: "ADX smoothing", defval: 14, min: 1, max: 2000, integer: true },
  ],
  plots: [
    { id: "adx", title: "ADX", style: "line", color: VIOLET, width: 2 },
    { id: "plusDi", title: "+DI", style: "line", color: UP },
    { id: "minusDi", title: "-DI", style: "line", color: DOWN },
  ],
  levels: [{ id: "threshold", title: "25", value: 25, color: MUTED, dashed: true }],
  precision: 2,
  warmup: (p) => (num(p, "diLength", 14) + num(p, "adxLength", 14)) * 20,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    const a = adx(high, low, close, num(params, "diLength", 14), num(params, "adxLength", 14));
    return { plots: { adx: a.adx, plusDi: a.plusDi, minusDi: a.minusDi } };
  },
};

/** Tier 1, in the order the browser lists them. */
export const TIER1_STUDIES: readonly NativeStudyDef[] = [
  movingAverageStudy, rsiStudy, macdStudy, bollingerStudy, atrStudy, vwapStudy,
  supertrendStudy, stochasticStudy, stochasticRsiStudy, volumeStudy, obvStudy, adxStudy,
];
