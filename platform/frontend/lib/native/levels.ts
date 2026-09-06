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
  buildZones, DEFAULT_SR_OPTIONS, isPivotType, pivotLevels, swingPoints,
  zonesAsOfSeries, type PivotType,
} from "@/lib/ta/core";
import type { NativeStudyDef } from "@/lib/native/registry";
import { INTERVAL_MS, type Candle } from "@/lib/types";
import {
  ACCENT, AMBER, DOWN, MUTED, UP, VIOLET, num, ohlcv, str,
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

/**
 * Pivot Points.
 *
 * The levels change only when a new anchor period completes, so each level is
 * drawn as a step that holds for the whole of the following period rather than
 * a line recomputed per bar. That is what makes a pivot a level: a value that
 * was decided before the period it governs began.
 */
export const pivotPointsStudy: NativeStudyDef = {
  id: "pivots",
  name: "Pivot Points",
  aliases: ["pivot", "pivots", "S1", "R1", "camarilla", "woodie", "fibonacci pivots"],
  category: "levels",
  overlay: true,
  description: "Standard, Fibonacci, Woodie, Classic or Camarilla levels from the last period.",
  inputs: [
    {
      kind: "select", key: "type", title: "Type", defval: "Fibonacci",
      options: [
        { value: "Traditional", label: "Traditional (Standard)" },
        { value: "Fibonacci", label: "Fibonacci" },
        { value: "Woodie", label: "Woodie" },
        { value: "Classic", label: "Classic" },
        { value: "Camarilla", label: "Camarilla" },
      ],
    },
    { kind: "select", key: "anchor", title: "Anchor", defval: "1d", options: ANCHORS },
  ],
  plots: [
    { id: "P", title: "P", style: "stepline", color: AMBER, width: 2 },
    { id: "R1", title: "R1", style: "stepline", color: DOWN },
    { id: "R2", title: "R2", style: "stepline", color: DOWN },
    { id: "R3", title: "R3", style: "stepline", color: DOWN },
    { id: "R4", title: "R4", style: "stepline", color: DOWN, hiddenByDefault: true },
    { id: "R5", title: "R5", style: "stepline", color: DOWN, hiddenByDefault: true },
    { id: "S1", title: "S1", style: "stepline", color: UP },
    { id: "S2", title: "S2", style: "stepline", color: UP },
    { id: "S3", title: "S3", style: "stepline", color: UP },
    { id: "S4", title: "S4", style: "stepline", color: UP, hiddenByDefault: true },
    { id: "S5", title: "S5", style: "stepline", color: UP, hiddenByDefault: true },
  ],
  precision: null,
  // Levels come from completed periods, so a window that holds fewer than two
  // of them has nothing to draw. Bounded, because only the last few matter.
  warmup: () => 0,
  unbounded: true,
  compute: ({ candles, params }) => {
    const typeName = str(params, "type", "Fibonacci");
    const type: PivotType = isPivotType(typeName) ? typeName : "Fibonacci";
    const anchor = str(params, "anchor", "1d");
    const periods = completedPeriods(candles, anchor);
    const names = ["P", "R1", "R2", "R3", "R4", "R5", "S1", "S2", "S3", "S4", "S5"];
    const plots: Record<string, number[]> = {};
    for (const name of names) plots[name] = new Array<number>(candles.length).fill(NaN);
    for (let p = 0; p < periods.length; p++) {
      const levels = pivotLevels(periods[p]!, type);
      // A period's levels govern the bars AFTER it closed, up to the next
      // period's close. Drawing them over their own period would be lookahead.
      const from = periods[p]!.endIndex + 1;
      const to = p + 1 < periods.length ? periods[p + 1]!.endIndex : candles.length - 1;
      for (const level of levels) {
        const series = plots[level.name];
        if (!series || !Number.isFinite(level.price)) continue;
        for (let i = from; i <= to && i < candles.length; i++) series[i] = level.price;
      }
    }
    return { plots };
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
    { kind: "number", key: "maxZones", title: "Zones per side", defval: 3, min: 1, max: 10, integer: true },
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
      above.slice(0, 3).forEach((z, k) => { plots[ids.resistance[k]!]![i] = z.price; });
      below.slice(0, 3).forEach((z, k) => { plots[ids.support[k]!]![i] = z.price; });
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

export const LEVEL_STUDIES: readonly NativeStudyDef[] = [
  pivotPointsStudy, swingPointsStudy, srZonesStudy, previousPeriodStudy,
];

export { ACCENT, VIOLET, INTERVAL_MS };
