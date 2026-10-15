"use client";
/**
 * Levels and market structure.
 *
 * ── The rule that shapes this file ─────────────────────────────────────────
 *
 * Every level here is drawn by the SAME code the alert engine fires on. Pivot
 * levels and support/resistance zones both live in `lib/ta/core`, moved there
 * verbatim from the engine, and both sides now import them rather than each
 * having their own. A pivot alert that says "price reached Fibonacci S1" must
 * name the line the user can see; two implementations of the same arithmetic
 * would eventually disagree, and the user would be told price reached a level
 * that is not where the chart drew it.
 *
 * ── Confirmation, and why nothing here looks ahead ─────────────────────────
 *
 * A swing is only a swing once `right` further bars have failed to beat it. So
 * a marker belongs at the CONFIRMATION bar, carrying the price of the bar it
 * confirms — reporting it at the pivot bar would be a claim the chart could
 * not have made at the time, which is the definition of lookahead and would
 * make every Replay and every backtest read the future.
 */
import {
  AUTO_FIB_DEFAULTS, AUTO_FIB_LEVELS, autoFib, autoFibLevelPrice,
  buildZones, DEFAULT_SR_OPTIONS, isPivotType, pivotLevels, swingPoints,
  zonesAsOfSeries, type PivotType,
} from "@/lib/ta/core";
import type { NativeStudyDef } from "@/lib/native/registry";
import type { PineDrawings } from "@/lib/api";
import { fluxSrStudy } from "@/lib/native/fluxSr";
import { INTERVAL_MS, type Candle } from "@/lib/types";
import {
  ACCENT, DOWN, MUTED, UP, VIOLET, bool, num, ohlcv, quotedDecimals, str,
} from "@/lib/native/shared";

/** The anchor periods a pivot study can be computed from. */
const ANCHORS = [
  { value: "1d", label: "Daily" },
  { value: "1w", label: "Weekly" },
  { value: "1M", label: "Monthly" },
] as const;

const DAY_MS = 86_400_000;

/**
 * Group bars into completed anchor periods, newest last.
 *
 * UTC boundaries throughout, because that is what the chart's own time axis
 * uses (`lib/chartClock`) and what Binance stamps bars with. A local-midnight
 * boundary would put the day's pivot at a different place for every reader.
 *
 * The CURRENT period is excluded: a pivot is computed from a COMPLETED
 * period's high, low and close, and a period that is still forming has none of
 * those yet. Including it would move the levels every bar.
 */
export function completedPeriods(
  candles: readonly Candle[], anchor: string
): { key: number; open: number; high: number; low: number; close: number; endIndex: number }[] {
  const keyOf = (t: number): number => {
    const d = new Date(t);
    if (anchor === "1M") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    if (anchor === "1w") {
      // ISO weeks start on Monday; the epoch was a Thursday, so shift by 4 days.
      const day = (d.getUTCDay() + 6) % 7;
      return Math.floor((t - day * DAY_MS) / DAY_MS) * DAY_MS;
    }
    return Math.floor(t / DAY_MS) * DAY_MS;
  };
  const out: {
    key: number; open: number; high: number; low: number; close: number; endIndex: number;
  }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const key = keyOf(c.openTime);
    const current = out[out.length - 1];
    if (!current || current.key !== key) {
      out.push({ key, open: c.open, high: c.high, low: c.low, close: c.close, endIndex: i });
      continue;
    }
    current.high = Math.max(current.high, c.high);
    current.low = Math.min(current.low, c.low);
    current.close = c.close;
    current.endIndex = i;
  }
  // Drop the period that is still forming.
  return out.slice(0, -1);
}

/** TradingView's single default colour for every pivot level. */
const PIVOT_ORANGE = "#fb8c00";

/** Pivots Timeframe, as TradingView offers it. Values are period keys below. */
const PIVOT_TIMEFRAMES = [
  { value: "auto", label: "Auto" },
  { value: "1d", label: "Daily" },
  { value: "1w", label: "Weekly" },
  { value: "1M", label: "Monthly" },
  { value: "3M", label: "Quarterly" },
  { value: "12M", label: "Yearly" },
] as const;

/**
 * "Auto", resolved as TradingView resolves it: intraday charts of 15 minutes
 * or less take daily pivots, other intraday charts weekly, a daily chart
 * monthly, and anything coarser yearly.
 */
export function pivotPeriodFor(choice: string, intervalMs: number): string {
  if (choice !== "auto") return choice;
  if (intervalMs <= 15 * 60_000) return "1d";
  if (intervalMs < DAY_MS) return "1w";
  if (intervalMs < 7 * DAY_MS) return "1M";
  return "12M";
}

/** The UTC start of the period containing `t`, and of the one after it. */
export function periodBounds(t: number, period: string): { start: number; end: number } {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (period === "1M") return { start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 1) };
  if (period === "3M") {
    const q = Math.floor(m / 3) * 3;
    return { start: Date.UTC(y, q, 1), end: Date.UTC(y, q + 3, 1) };
  }
  if (period === "12M") return { start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1) };
  if (period === "1w") {
    // ISO weeks start on Monday.
    const day = (d.getUTCDay() + 6) % 7;
    const start = Math.floor((t - day * DAY_MS) / DAY_MS) * DAY_MS;
    return { start, end: start + 7 * DAY_MS };
  }
  const start = Math.floor(t / DAY_MS) * DAY_MS;
  return { start, end: start + DAY_MS };
}

const PIVOT_LEVEL_NAMES = ["P", "R1", "S1", "R2", "S2", "R3", "S3", "R4", "S4", "R5", "S5"] as const;

/**
 * Pivot Points Standard, drawn as TradingView draws it.
 *
 * Each period gets its own horizontal SEGMENT per level, from the start of the
 * period it governs to that period's end, with "R1 (5.282)" written beside it.
 * It used to be a continuous step line per level, which joined consecutive
 * periods with vertical risers and coloured resistance red and support green —
 * a picture TradingView never draws. The levels govern the period AFTER the
 * one they were computed from; the forming period's own levels would be
 * lookahead and are never drawn.
 *
 * The arithmetic is `pivotLevels` in `lib/ta/core`, the one the pivot alerts
 * fire on, so an alert names the line the chart shows.
 */
export const pivotPointsStudy: NativeStudyDef = {
  id: "pivots",
  name: "Pivot Points Standard",
  aliases: ["pivot", "pivots", "pivot points", "S1", "R1", "camarilla", "woodie", "fibonacci pivots"],
  category: "levels",
  overlay: true,
  description: "Traditional, Fibonacci, Woodie, Classic or Camarilla levels for each period.",
  inputs: [
    {
      kind: "select", key: "type", title: "Type", defval: "Fibonacci",
      options: [
        { value: "Traditional", label: "Traditional" },
        { value: "Fibonacci", label: "Fibonacci" },
        { value: "Woodie", label: "Woodie" },
        { value: "Classic", label: "Classic" },
        { value: "Camarilla", label: "Camarilla" },
      ],
    },
    { kind: "select", key: "anchor", title: "Pivots Timeframe", defval: "1d", options: PIVOT_TIMEFRAMES },
    { kind: "number", key: "lookBack", title: "Number of Pivots Back", defval: 15, min: 1, max: 5000, integer: true },
    { kind: "boolean", key: "showLabels", title: "Show Labels", defval: true },
    { kind: "boolean", key: "showPrices", title: "Show Prices", defval: true },
    {
      kind: "select", key: "labelsPosition", title: "Labels Position", defval: "Left",
      options: [{ value: "Left", label: "Left" }, { value: "Right", label: "Right" }],
    },
  ],
  // The Style tab's rows — one per level, TradingView's orange — for lines the
  // study DRAWS rather than plots.
  plots: PIVOT_LEVEL_NAMES.map((name) => ({
    id: name, title: name, style: "line" as const, color: PIVOT_ORANGE, width: 1, drawingOnly: true,
  })),
  precision: null,
  warmup: () => 0,
  unbounded: true,
  compute: ({ candles, params, interval, styles }) => {
    const typeName = str(params, "type", "Fibonacci");
    const type: PivotType = isPivotType(typeName) ? typeName : "Fibonacci";
    const intervalMs = (INTERVAL_MS as Record<string, number>)[interval] ?? 60_000;
    const period = pivotPeriodFor(str(params, "anchor", "1d"), intervalMs);
    const lookBack = Math.max(1, Math.round(num(params, "lookBack", 15)));
    const showLabels = bool(params, "showLabels", true);
    const showPrices = bool(params, "showPrices", true);
    const onLeft = str(params, "labelsPosition", "Left") !== "Right";
    const decimals = quotedDecimals(candles);

    // Every period's OHLC, the forming one included (it is drawn over, not from).
    const periods: { start: number; end: number; open: number; high: number; low: number; close: number }[] = [];
    for (const c of candles) {
      const last = periods[periods.length - 1];
      if (last && c.openTime < last.end) {
        last.high = Math.max(last.high, c.high);
        last.low = Math.min(last.low, c.low);
        last.close = c.close;
        continue;
      }
      const b = periodBounds(c.openTime, period);
      periods.push({ ...b, open: c.open, high: c.high, low: c.low, close: c.close });
    }

    const drawings: PineDrawings = { lines: [], boxes: [], labels: [], tables: [] };
    const first = Math.max(1, periods.length - lookBack);
    for (let k = first; k < periods.length; k++) {
      const from = periods[k - 1]!;
      const span = periods[k]!;
      const x1 = Math.floor(span.start / 1000);
      const x2 = Math.floor(span.end / 1000);
      for (const level of pivotLevels(from, type)) {
        const look = styles?.[level.name];
        if (!look || !look.visible || !Number.isFinite(level.price)) continue;
        drawings.lines.push({
          x1, y1: level.price, x2, y2: level.price,
          color: look.color, width: look.width, style: "solid", extend: "none",
        });
        if (!showLabels && !showPrices) continue;
        const price = `(${level.price.toFixed(decimals)})`;
        const text = showLabels && showPrices ? `${level.name} ${price}` : showLabels ? level.name : price;
        drawings.labels.push({
          x: onLeft ? x1 : x2, y: level.price, text,
          color: "", textColor: look.color,
          style: onLeft ? "style_label_right" : "style_label_left", size: "normal",
        });
      }
    }
    return { plots: {}, drawings };
  },
};

/**
 * Confirmed swing highs and lows.
 *
 * Drawn as two step series rather than markers, so the level a swing
 * established is visible for as long as it stands — which is what a trader
 * reads a swing point for. The value appears at the CONFIRMATION bar.
 */
export const swingPointsStudy: NativeStudyDef = {
  id: "swings",
  name: "Swing Highs / Lows",
  aliases: ["swing", "pivots high low", "fractals"],
  category: "levels",
  overlay: true,
  description: "Confirmed swing extremes, each shown from the bar it became knowable.",
  inputs: [
    { kind: "number", key: "left", title: "Left bars", defval: 15, min: 1, max: 200, integer: true },
    { kind: "number", key: "right", title: "Right bars", defval: 15, min: 1, max: 200, integer: true },
  ],
  plots: [
    { id: "high", title: "Swing high", style: "stepline", color: DOWN },
    { id: "low", title: "Swing low", style: "stepline", color: UP },
  ],
  precision: null,
  unbounded: true,
  warmup: (p) => (num(p, "left", 15) + num(p, "right", 15)) * 4,
  compute: ({ candles, params }) => {
    const { high, low } = ohlcv(candles);
    const n = candles.length;
    const highs = new Array<number>(n).fill(NaN);
    const lows = new Array<number>(n).fill(NaN);
    const points = swingPoints(high, low, num(params, "left", 15), num(params, "right", 15));
    for (const point of points) {
      const target = point.kind === "high" ? highs : lows;
      // From the confirmation bar onward, until the next swing of that kind
      // replaces it. Filling forward is what makes it a level rather than a dot.
      for (let i = point.confirmIndex; i < n; i++) target[i] = point.price;
    }
    return { plots: { high: highs, low: lows } };
  },
};

/**
 * Support and resistance zones, from the engine the alerts use.
 *
 * `buildZones` and `zonesAsOf` are `lib/ta/core`'s — the same functions
 * `alerts/alertConditions` resolves an `sr_zone` alert against. There is no
 * second zone detector in this product, which is the whole point: an alert
 * that fires on "1h support" names a line the chart drew from the same call.
 */
export const srZonesStudy: NativeStudyDef = {
  id: "srzones",
  name: "Support / Resistance Zones",
  aliases: ["S/R", "support", "resistance", "zones"],
  category: "levels",
  overlay: true,
  description: "Swing-based zones that die when price closes through them — the alert engine's own.",
  inputs: [
    { kind: "number", key: "pivotLength", title: "Swing length", defval: 15, min: 1, max: 200, integer: true },
    {
      kind: "select", key: "invalidation", title: "Invalidated by", defval: "close",
      options: [
        { value: "close", label: "A close through the level" },
        { value: "wick", label: "Any wick through it" },
      ],
    },
    /*
     * TVP8: this accepted 1–10 and there are three plot slots per side, so
     * asking for ten drew three and said nothing. The bound is the number of
     * plots that exist, and the value is now READ — asking for one drew three
     * as well.
     */
    { kind: "number", key: "maxZones", title: "Zones per side", defval: 3, min: 1, max: 3, integer: true },
  ],
  plots: [
    { id: "r1", title: "Resistance 1", style: "stepline", color: DOWN },
    { id: "r2", title: "Resistance 2", style: "stepline", color: DOWN, hiddenByDefault: true },
    { id: "r3", title: "Resistance 3", style: "stepline", color: DOWN, hiddenByDefault: true },
    { id: "s1", title: "Support 1", style: "stepline", color: UP },
    { id: "s2", title: "Support 2", style: "stepline", color: UP, hiddenByDefault: true },
    { id: "s3", title: "Support 3", style: "stepline", color: UP, hiddenByDefault: true },
  ],
  precision: null,
  // Zones are stateful across the whole series: one is born at a pivot and
  // dies when price closes through it, which a window cannot know.
  unbounded: true,
  warmup: (p) => num(p, "pivotLength", 15) * 6,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    const n = candles.length;
    const options = {
      ...DEFAULT_SR_OPTIONS,
      pivotLength: num(params, "pivotLength", 15),
      invalidation: str(params, "invalidation", "close") === "wick"
        ? ("wick" as const) : ("close" as const),
      maxZones: num(params, "maxZones", 3),
    };
    const maxZones = options.maxZones;
    const zones = buildZones({ high, low, close }, options);
    const ids = { resistance: ["r1", "r2", "r3"], support: ["s1", "s2", "s3"] };
    const plots: Record<string, number[]> = {};
    for (const id of [...ids.resistance, ...ids.support]) {
      plots[id] = new Array<number>(n).fill(NaN);
    }
    /*
     * One forward walk, not one query per bar.
     *
     * `zonesAsOf` in a loop is quadratic — a full filter and sort over every
     * zone the series ever produced, for every bar — which measured 53 ms per
     * tick at ten thousand bars and grew super-linearly past that.
     * `zonesAsOfSeries` carries the live set forward instead, and returns
     * exactly what the loop did.
     */
    const liveByBar = zonesAsOfSeries(zones, n, options);
    for (let i = 0; i < n; i++) {
      const live = liveByBar[i]!;
      const above = live.filter((z) => z.kind === "resistance" && z.price >= close[i]!)
        .sort((a, b) => a.price - b.price);
      const below = live.filter((z) => z.kind === "support" && z.price <= close[i]!)
        .sort((a, b) => b.price - a.price);
      above.slice(0, maxZones).forEach((z, k) => { plots[ids.resistance[k]!]![i] = z.price; });
      below.slice(0, maxZones).forEach((z, k) => { plots[ids.support[k]!]![i] = z.price; });
    }
    return { plots };
  },
};

/**
 * The previous period's high, low and close.
 *
 * One study rather than two, with the anchor as an input: "previous day" and
 * "previous week" are the same three levels from a different period, and two
 * entries would mean two settings dialogs and two legend rows for one idea.
 */
export const previousPeriodStudy: NativeStudyDef = {
  id: "prevperiod",
  name: "Previous Period High / Low / Close",
  aliases: ["PDH", "PDL", "previous day", "previous week", "PWH", "PWL"],
  category: "levels",
  overlay: true,
  description: "The last completed day's or week's high, low and close, held as levels.",
  inputs: [{ kind: "select", key: "anchor", title: "Period", defval: "1d", options: ANCHORS }],
  plots: [
    { id: "high", title: "Previous high", style: "stepline", color: DOWN },
    { id: "low", title: "Previous low", style: "stepline", color: UP },
    { id: "close", title: "Previous close", style: "stepline", color: MUTED },
  ],
  precision: null,
  unbounded: true,
  warmup: () => 0,
  compute: ({ candles, params }) => {
    const periods = completedPeriods(candles, str(params, "anchor", "1d"));
    const n = candles.length;
    const highs = new Array<number>(n).fill(NaN);
    const lows = new Array<number>(n).fill(NaN);
    const closes = new Array<number>(n).fill(NaN);
    for (let p = 0; p < periods.length; p++) {
      const from = periods[p]!.endIndex + 1;
      const to = p + 1 < periods.length ? periods[p + 1]!.endIndex : n - 1;
      for (let i = from; i <= to && i < n; i++) {
        highs[i] = periods[p]!.high;
        lows[i] = periods[p]!.low;
        closes[i] = periods[p]!.close;
      }
    }
    return { plots: { high: highs, low: lows, close: closes } };
  },
};


/** A fib level's plot id: "fib_0_618", "fib_neg_0_382". Stable — styles are keyed by it. */
export const fibPlotId = (value: number): string =>
  `fib_${value < 0 ? "neg_" : ""}${String(Math.abs(value)).replace(".", "_")}`;

/**
 * Auto Fib Retracement — TradingView's script, on this chart.
 *
 * Levels are drawn across the latest confirmed zig-zag swing, from its start
 * pivot to the right edge (Extend Right, on by default as on the owner's
 * chart). The swing, and every level price, come from `autoFib` in
 * `lib/ta/core` — the SAME function the alert engine evaluates a fib alert
 * with, so the line on the chart is the line an alert fires on.
 *
 * Defaults are the owner's own chart, not the script's: Depth 30 (the script
 * says 10), 0 through 1 shown except 0.65, the extensions and negatives off,
 * 0 and 1 grey and the retracements white. Which levels show and their
 * colours are the Style tab's per-plot visibility and colour.
 *
 * Not drawn: the script's text labels beside each line and the shaded bands.
 * Each level's price is on the price scale instead, and the owner's background
 * transparency of 100 already draws no bands.
 */
export const autoFibStudy: NativeStudyDef = {
  id: "auto_fib",
  name: "Auto fib retracement",
  aliases: ["fib", "fibonacci", "auto fib", "retracement", "zigzag"],
  category: "levels",
  overlay: true,
  description: "Fibonacci levels across the latest zig-zag swing, redrawn as new swings confirm.",
  inputs: [
    { kind: "number", key: "deviation", title: "Deviation", defval: AUTO_FIB_DEFAULTS.deviation, min: 0, max: 100, step: 0.1 },
    { kind: "number", key: "depth", title: "Depth", defval: AUTO_FIB_DEFAULTS.depth, min: 2, max: 500, integer: true },
    { kind: "boolean", key: "reverse", title: "Reverse", defval: false },
    { kind: "boolean", key: "extendLeft", title: "Extend Left", defval: false },
    { kind: "boolean", key: "extendRight", title: "Extend Right", defval: true },
  ],
  plots: AUTO_FIB_LEVELS.map((l) => ({
    id: fibPlotId(l.value),
    title: String(l.value),
    style: "line" as const,
    color: l.value === 0 || l.value === 1 ? "#787b86" : "#ffffff",
    width: 1,
    hiddenByDefault: !l.on,
    notASource: true,
  })),
  precision: null,
  warmup: () => 0,
  // Path-dependent, like any zig-zag: the latest swing depends on every pivot
  // before it, so it is computed over the whole loaded series.
  unbounded: true,
  compute: ({ candles, params }) => {
    const { high, low, close } = ohlcv(candles);
    const n = candles.length;
    const plots: Record<string, number[]> = {};
    for (const l of AUTO_FIB_LEVELS) plots[fibPlotId(l.value)] = new Array<number>(n).fill(NaN);
    const fib = autoFib(high, low, close,
      num(params, "deviation", AUTO_FIB_DEFAULTS.deviation),
      num(params, "depth", AUTO_FIB_DEFAULTS.depth),
      bool(params, "reverse", false));
    if (!fib) return { plots };
    const from = bool(params, "extendLeft", false) ? 0 : fib.leg.start.index;
    const to = bool(params, "extendRight", true) ? n - 1 : fib.leg.end.index;
    for (const l of AUTO_FIB_LEVELS) {
      const price = autoFibLevelPrice(fib, l.value);
      const series = plots[fibPlotId(l.value)]!;
      for (let i = from; i <= to; i++) series[i] = price;
    }
    return { plots };
  },
};

export const LEVEL_STUDIES: readonly NativeStudyDef[] = [
  pivotPointsStudy, swingPointsStudy, srZonesStudy, previousPeriodStudy, autoFibStudy, fluxSrStudy,
];

export { ACCENT, VIOLET, INTERVAL_MS };
