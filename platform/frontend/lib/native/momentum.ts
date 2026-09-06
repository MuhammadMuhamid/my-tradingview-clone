"use client";
/**
 * Momentum studies.
 *
 * Fourteen entries, all thin: each is inputs, plots and one call into
 * `lib/ta/core`. The only decisions a definition makes here are which levels
 * are worth drawing (an oscillator with no reference line is a wiggle) and
 * what precision its readings deserve — a CCI in the hundreds and a TSI in
 * the tens do not want the same number of decimals.
 *
 * Relative Vigor Index and Balance of Power are deliberately NOT here: the
 * catalog files them under Pine, and adding them natively would be feature
 * count rather than capability.
 */
import {
  awesomeOscillator, cci, chandeMomentum, coppock, detrendedPriceOscillator,
  elderForceIndex, fisherTransform, hlc3, momentum, ppo, roc, trix, tsi,
  ultimateOscillator, williamsR,
} from "@/lib/ta/core";
import type { NativeStudyDef } from "@/lib/native/registry";
import {
  ACCENT, AMBER, DOWN, MUTED, UP, VIOLET, lengthInput, num, ohlcv, resolveSource,
  sourceInput, str, zeroLevel,
} from "@/lib/native/shared";

export const cciStudy: NativeStudyDef = {
  id: "cci",
  name: "Commodity Channel Index",
  aliases: ["CCI"],
  category: "momentum",
  overlay: false,
  description: "How far the typical price is from its mean, in mean deviations.",
  inputs: [lengthInput(20), { kind: "source", key: "source", title: "Source", defval: "hlc3" }],
  plots: [{ id: "cci", title: "CCI", style: "line", color: VIOLET, width: 2 }],
  levels: [
    { id: "upper", title: "100", value: 100, color: MUTED, dashed: true },
    { id: "zero", title: "0", value: 0, color: MUTED, dashed: true },
    { id: "lower", title: "-100", value: -100, color: MUTED, dashed: true },
  ],
  precision: 2,
  warmup: (p) => num(p, "length", 20) * 3,
  compute: ({ candles, params, sources }) => ({
    plots: {
      cci: cci(resolveSource(candles, str(params, "source", "hlc3"), sources), num(params, "length", 20)),
    },
  }),
};

export const williamsRStudy: NativeStudyDef = {
  id: "willr",
  name: "Williams %R",
  aliases: ["%R", "williams"],
  category: "momentum",
  overlay: false,
  description: "The stochastic, read from the top of the range down.",
  inputs: [lengthInput(14)],
  plots: [{ id: "wr", title: "%R", style: "line", color: ACCENT, width: 2 }],
  levels: [
    { id: "upper", title: "-20", value: -20, color: MUTED, dashed: true },
    { id: "lower", title: "-80", value: -80, color: MUTED, dashed: true },
  ],
  precision: 2,
  warmup: (p) => num(p, "length", 14) * 3,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    return { plots: { wr: williamsR(high, low, close, num(params, "length", 14)) } };
  },
};

export const rocStudy: NativeStudyDef = {
  id: "roc",
  name: "Rate of Change",
  aliases: ["ROC"],
  category: "momentum",
  overlay: false,
  description: "Percentage change over the chosen number of bars.",
  inputs: [lengthInput(9), sourceInput],
  plots: [{ id: "roc", title: "ROC", style: "line", color: ACCENT, width: 2 }],
  levels: [zeroLevel],
  precision: 2,
  warmup: (p) => num(p, "length", 9) * 3,
  compute: ({ candles, params, sources }) => ({
    plots: {
      roc: roc(resolveSource(candles, str(params, "source", "close"), sources), num(params, "length", 9)),
    },
  }),
};

export const momentumStudy: NativeStudyDef = {
  id: "momentum",
  name: "Momentum",
  aliases: ["MOM"],
  category: "momentum",
  overlay: false,
  description: "The plain difference over the chosen number of bars, in price units.",
  inputs: [lengthInput(10), sourceInput],
  plots: [{ id: "mom", title: "Momentum", style: "line", color: AMBER, width: 2 }],
  levels: [zeroLevel],
  // Price units, so the instrument's own precision rather than a fixed one.
  precision: null,
  warmup: (p) => num(p, "length", 10) * 3,
  compute: ({ candles, params, sources }) => ({
    plots: {
      mom: momentum(
        resolveSource(candles, str(params, "source", "close"), sources), num(params, "length", 10)),
    },
  }),
};

export const trixStudy: NativeStudyDef = {
  id: "trix",
  name: "TRIX",
  aliases: ["triple exponential"],
  category: "momentum",
  overlay: false,
  description: "The rate of change of a triple-smoothed EMA.",
  inputs: [
    lengthInput(18),
    { kind: "number", key: "signal", title: "Signal length", defval: 9, min: 1, max: 500, integer: true },
    sourceInput,
  ],
  plots: [
    { id: "trix", title: "TRIX", style: "line", color: VIOLET, width: 2 },
    { id: "signal", title: "Signal", style: "line", color: AMBER, hiddenByDefault: true },
  ],
  levels: [zeroLevel],
  precision: 4,
  warmup: (p) => num(p, "length", 18) * 40,
  compute: ({ candles, params, sources }) => {
    const src = resolveSource(candles, str(params, "source", "close"), sources);
    const line = trix(src, num(params, "length", 18));
    // The signal is smoothed from TRIX including its leading NaNs, so it
    // appears at the bar the indicator would show it rather than earlier.
    return { plots: { trix: line, signal: emaOf(line, num(params, "signal", 9)) } };
  },
};

export const ppoStudy: NativeStudyDef = {
  id: "ppo",
  name: "Percentage Price Oscillator",
  aliases: ["PPO"],
  category: "momentum",
  overlay: false,
  description: "MACD expressed as a percentage of the slow average.",
  inputs: [
    { kind: "number", key: "fast", title: "Fast length", defval: 12, min: 1, max: 2000, integer: true },
    { kind: "number", key: "slow", title: "Slow length", defval: 26, min: 1, max: 2000, integer: true },
    { kind: "number", key: "signal", title: "Signal length", defval: 9, min: 1, max: 2000, integer: true },
    sourceInput,
  ],
  plots: [
    { id: "hist", title: "Histogram", style: "histogram", color: MUTED },
    { id: "ppo", title: "PPO", style: "line", color: ACCENT, width: 2 },
    { id: "signal", title: "Signal", style: "line", color: AMBER },
  ],
  levels: [zeroLevel],
  precision: 4,
  warmup: (p) => (num(p, "slow", 26) + num(p, "signal", 9)) * 20,
  compute: ({ candles, params, sources }) => {
    const o = ppo(
      resolveSource(candles, str(params, "source", "close"), sources),
      num(params, "fast", 12), num(params, "slow", 26), num(params, "signal", 9));
    return { plots: { ppo: o.line, signal: o.signal, hist: o.histogram } };
  },
};

export const tsiStudy: NativeStudyDef = {
  id: "tsi",
  name: "True Strength Index",
  aliases: ["TSI"],
  category: "momentum",
  overlay: false,
  description: "Double-smoothed momentum over double-smoothed absolute momentum.",
  inputs: [
    { kind: "number", key: "long", title: "Long length", defval: 25, min: 1, max: 1000, integer: true },
    { kind: "number", key: "short", title: "Short length", defval: 13, min: 1, max: 1000, integer: true },
    { kind: "number", key: "signal", title: "Signal length", defval: 13, min: 1, max: 1000, integer: true },
    sourceInput,
  ],
  plots: [
    { id: "tsi", title: "TSI", style: "line", color: VIOLET, width: 2 },
    { id: "signal", title: "Signal", style: "line", color: AMBER },
  ],
  levels: [zeroLevel],
  precision: 2,
  warmup: (p) => (num(p, "long", 25) + num(p, "short", 13)) * 20,
  compute: ({ candles, params, sources }) => {
    const o = tsi(
      resolveSource(candles, str(params, "source", "close"), sources),
      num(params, "long", 25), num(params, "short", 13), num(params, "signal", 13));
    return { plots: { tsi: o.line, signal: o.signal } };
  },
};

export const ultimateStudy: NativeStudyDef = {
  id: "uo",
  name: "Ultimate Oscillator",
  aliases: ["UO", "ultimate"],
  category: "momentum",
  overlay: false,
  description: "Buying pressure over true range, weighted 4:2:1 across three windows.",
  inputs: [
    { kind: "number", key: "len1", title: "Fast", defval: 7, min: 1, max: 1000, integer: true },
    { kind: "number", key: "len2", title: "Middle", defval: 14, min: 1, max: 1000, integer: true },
    { kind: "number", key: "len3", title: "Slow", defval: 28, min: 1, max: 2000, integer: true },
  ],
  plots: [{ id: "uo", title: "UO", style: "line", color: ACCENT, width: 2 }],
  levels: [
    { id: "upper", title: "70", value: 70, color: MUTED, dashed: true },
    { id: "lower", title: "30", value: 30, color: MUTED, dashed: true },
  ],
  precision: 2,
  warmup: (p) => num(p, "len3", 28) * 3,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    return {
      plots: {
        uo: ultimateOscillator(
          high, low, close,
          num(params, "len1", 7), num(params, "len2", 14), num(params, "len3", 28)),
      },
    };
  },
};

export const awesomeStudy: NativeStudyDef = {
  id: "ao",
  name: "Awesome Oscillator",
  aliases: ["AO", "awesome"],
  category: "momentum",
  overlay: false,
  description: "The difference between two averages of the median price.",
  inputs: [
    { kind: "number", key: "fast", title: "Fast", defval: 5, min: 1, max: 1000, integer: true },
    { kind: "number", key: "slow", title: "Slow", defval: 34, min: 1, max: 2000, integer: true },
  ],
  plots: [{ id: "ao", title: "AO", style: "histogram", color: MUTED }],
  levels: [zeroLevel],
  precision: null,
  warmup: (p) => num(p, "slow", 34) * 3,
  compute: ({ candles, params }) => {
    const { high, low } = ohlcv(candles);
    const values = awesomeOscillator(high, low, num(params, "fast", 5), num(params, "slow", 34));
    return {
      plots: { ao: values },
      // The AO's convention is a bar coloured by whether it rose or fell, not
      // by its sign — that is what the indicator is read for.
      colors: {
        ao: values.map((v, i) => {
          if (Number.isNaN(v)) return null;
          const prev = values[i - 1];
          return prev === undefined || Number.isNaN(prev) || v >= prev ? UP : DOWN;
        }),
      },
    };
  },
};

export const fisherStudy: NativeStudyDef = {
  id: "fisher",
  name: "Fisher Transform",
  aliases: ["fisher"],
  category: "momentum",
  overlay: false,
  description: "Price position in its range, mapped so extremes become sharp peaks.",
  inputs: [lengthInput(9)],
  plots: [
    { id: "fisher", title: "Fisher", style: "line", color: ACCENT, width: 2 },
    { id: "trigger", title: "Trigger", style: "line", color: AMBER },
  ],
  levels: [zeroLevel],
  precision: 4,
  // Recursive with no reset: the value carries from the first bar onward.
  unbounded: true,
  warmup: (p) => num(p, "length", 9) * 5,
  compute: ({ candles, params }) => {
    const { high, low } = ohlcv(candles);
    const f = fisherTransform(high, low, num(params, "length", 9));
    return { plots: { fisher: f.line, trigger: f.signal } };
  },
};

export const cmoStudy: NativeStudyDef = {
  id: "cmo",
  name: "Chande Momentum Oscillator",
  aliases: ["CMO", "chande"],
  category: "momentum",
  overlay: false,
  description: "Net momentum over total momentum, on a -100..100 scale.",
  inputs: [lengthInput(9), sourceInput],
  plots: [{ id: "cmo", title: "CMO", style: "line", color: VIOLET, width: 2 }],
  levels: [
    { id: "upper", title: "50", value: 50, color: MUTED, dashed: true },
    { id: "zero", title: "0", value: 0, color: MUTED, dashed: true },
    { id: "lower", title: "-50", value: -50, color: MUTED, dashed: true },
  ],
  precision: 2,
  warmup: (p) => num(p, "length", 9) * 3,
  compute: ({ candles, params, sources }) => ({
    plots: {
      cmo: chandeMomentum(
        resolveSource(candles, str(params, "source", "close"), sources), num(params, "length", 9)),
    },
  }),
};

/**
 * Detrended Price Oscillator.
 *
 * The price it plots is read from the middle of the window rather than its
 * end, which is what "detrended" means here and what makes the DPO a
 * cycle-spotting tool. It is NOT a signal generator, and nothing in this
 * product arms an alert on it.
 *
 * Causal, despite how the displacement reads: every input is at or before the
 * bar the value is plotted on. The variant that is not causal plots the result
 * shifted backward, and this one does not.
 */
export const dpoStudy: NativeStudyDef = {
  id: "dpo",
  name: "Detrended Price Oscillator",
  aliases: ["DPO"],
  category: "momentum",
  overlay: false,
  description: "Price minus a displaced average — a cycle tool, not a signal.",
  inputs: [lengthInput(21), sourceInput],
  plots: [{ id: "dpo", title: "DPO", style: "line", color: ACCENT, width: 2 }],
  levels: [zeroLevel],
  precision: null,
  warmup: (p) => num(p, "length", 21) * 3,
  compute: ({ candles, params, sources }) => ({
    plots: {
      dpo: detrendedPriceOscillator(
        resolveSource(candles, str(params, "source", "close"), sources), num(params, "length", 21)),
    },
  }),
};

export const coppockStudy: NativeStudyDef = {
  id: "coppock",
  name: "Coppock Curve",
  aliases: ["coppock"],
  category: "momentum",
  overlay: false,
  description: "A weighted average of two rates of change; long-horizon by design.",
  inputs: [
    { kind: "number", key: "longRoc", title: "Long ROC", defval: 14, min: 1, max: 1000, integer: true },
    { kind: "number", key: "shortRoc", title: "Short ROC", defval: 11, min: 1, max: 1000, integer: true },
    { kind: "number", key: "wmaLength", title: "WMA length", defval: 10, min: 1, max: 1000, integer: true },
    sourceInput,
  ],
  plots: [{ id: "coppock", title: "Coppock", style: "line", color: VIOLET, width: 2 }],
  levels: [zeroLevel],
  precision: 2,
  warmup: (p) => (num(p, "longRoc", 14) + num(p, "wmaLength", 10)) * 3,
  compute: ({ candles, params, sources }) => ({
    plots: {
      coppock: coppock(
        resolveSource(candles, str(params, "source", "close"), sources),
        num(params, "longRoc", 14), num(params, "shortRoc", 11), num(params, "wmaLength", 10)),
    },
  }),
};

export const forceIndexStudy: NativeStudyDef = {
  id: "efi",
  name: "Elder Force Index",
  aliases: ["force index", "EFI"],
  category: "volume",
  overlay: false,
  description: "Signed price change scaled by the volume behind it.",
  inputs: [lengthInput(13)],
  plots: [{ id: "efi", title: "Force Index", style: "line", color: ACCENT, width: 2 }],
  levels: [zeroLevel],
  precision: 0,
  warmup: (p) => num(p, "length", 13) * 20,
  compute: ({ candles, params }) => {
    const { close, volume } = ohlcv(candles);
    return { plots: { efi: elderForceIndex(close, volume, num(params, "length", 13)) } };
  },
};

export const MOMENTUM_STUDIES: readonly NativeStudyDef[] = [
  cciStudy, williamsRStudy, rocStudy, momentumStudy, trixStudy, ppoStudy, tsiStudy,
  ultimateStudy, awesomeStudy, fisherStudy, cmoStudy, dpoStudy, coppockStudy,
  forceIndexStudy,
];

/** Imported lazily to keep the import list above readable. */
import { ema as emaOf } from "@/lib/ta/core";
export { hlc3 };
