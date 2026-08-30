/**
 * Pivot-based support and resistance zones.
 *
 * The shape follows the Flux Charts "Support & Resistance (MTF)" indicator the
 * user works from: a swing high becomes a resistance, a swing low becomes a
 * support, a level dies when price closes through it, and levels that sit on
 * top of each other are merged rather than stacked.
 *
 * ── Confirmation, and why it matters here ──
 * A pivot at bar `i` is only a pivot once `length` further bars have printed
 * without exceeding it. So at bar `t` the newest usable pivot is at `t -
 * length`, never at `t`. Treating a pivot as known on the bar it forms would
 * make every backtest and every alert read the future — the zone would appear
 * before the market could have shown it. `zonesAsOf` enforces the delay.
 */

export type ZoneKind = "support" | "resistance";

export interface Zone {
  kind: ZoneKind;
  /** The pivot price this zone sits at. */
  price: number;
  /** Index of the bar the pivot formed on. */
  pivotIndex: number;
  /** Index at which the pivot became knowable (`pivotIndex + length`). */
  confirmedIndex: number;
  /** Index where price closed through it, or null while it still holds. */
  brokenIndex: number | null;
  /** How many times price returned to the level without breaking it. */
  touches: number;
}

export interface SrOptions {
  /** Bars either side of a swing that must not exceed it. */
  pivotLength: number;
  /** A wick through the level, or only a close through it, invalidates. */
  invalidation: "close" | "wick";
  /** Levels within this fraction of ATR of an existing one are merged. */
  mergeAtrFraction: number;
  /** Newest N live zones of each kind are kept. */
  maxZones: number;
}

export const DEFAULT_SR_OPTIONS: SrOptions = {
  pivotLength: 15,
  invalidation: "close",
  mergeAtrFraction: 1 / 8,
  maxZones: 10,
};

export interface Bars {
  high: number[];
  low: number[];
  close: number[];
}

/** True when `high[i]` is the highest of the window `length` bars either side. */
export function isPivotHigh(high: number[], i: number, length: number): boolean {
  if (i - length < 0 || i + length >= high.length) return false;
  const v = high[i]!;
  for (let j = i - length; j <= i + length; j++) {
    if (j === i) continue;
    // `>=` on the left half and `>` on the right breaks ties toward the EARLIER
    // bar, so a flat top yields one pivot rather than one per equal bar.
    if (j < i ? high[j]! >= v : high[j]! > v) return false;
  }
  return true;
}

export function isPivotLow(low: number[], i: number, length: number): boolean {
  if (i - length < 0 || i + length >= low.length) return false;
  const v = low[i]!;
  for (let j = i - length; j <= i + length; j++) {
    if (j === i) continue;
    if (j < i ? low[j]! <= v : low[j]! < v) return false;
  }
  return true;
}

/** Average true range, used only to decide when two levels are "the same". */
export function atr(bars: Bars, length = 20): number[] {
  const out: number[] = new Array(bars.close.length).fill(NaN);
  let sum = 0;
  const trs: number[] = [];
  for (let i = 0; i < bars.close.length; i++) {
    const prevClose = i > 0 ? bars.close[i - 1]! : bars.close[i]!;
    const tr = Math.max(
      bars.high[i]! - bars.low[i]!,
      Math.abs(bars.high[i]! - prevClose),
      Math.abs(bars.low[i]! - prevClose)
    );
    trs.push(tr);
    sum += tr;
    if (i >= length) sum -= trs[i - length]!;
    // Seeded progressively rather than only after a full window. The value is
    // used to decide whether two levels are "the same price", and leaving it
    // NaN through the warmup made early zones fall back to a fixed relative
    // tolerance that stacked levels a trader would read as one.
    out[i] = i >= length - 1 ? sum / length : sum / (i + 1);
  }
  return out;
}

/**
 * Every zone the series produced, each carrying the bar it became knowable on
 * and the bar it broke on. Computed once per feed; `zonesAsOf` then answers
 * "what was live at bar t" without recomputing.
 */
export function buildZones(bars: Bars, opts: SrOptions = DEFAULT_SR_OPTIONS): Zone[] {
  const n = bars.close.length;
  const { pivotLength: L, invalidation, mergeAtrFraction } = opts;
  const atrSeries = atr(bars);
  const zones: Zone[] = [];

  for (let i = 0; i < n; i++) {
    const confirmedAt = i + L;
    if (confirmedAt >= n) break;

    const near = (a: number, b: number): boolean => {
      const scale = atrSeries[confirmedAt];
      // Before ATR is seeded, fall back to a relative tolerance so early bars
      // still merge sensibly instead of stacking near-identical levels.
      const tol = Number.isFinite(scale) ? scale! * mergeAtrFraction : Math.abs(b) * 0.001;
      return Math.abs(a - b) <= tol;
    };

    for (const kind of ["support", "resistance"] as ZoneKind[]) {
      const hit = kind === "support"
        ? isPivotLow(bars.low, i, L)
        : isPivotHigh(bars.high, i, L);
      if (!hit) continue;
      const price = kind === "support" ? bars.low[i]! : bars.high[i]!;

      // Merge into a live zone of the same kind at effectively the same price.
      const existing = zones.find(
        (z) => z.kind === kind && z.brokenIndex === null && near(z.price, price)
      );
      if (existing) {
        existing.touches += 1;
        continue;
      }
      zones.push({
        kind, price, pivotIndex: i, confirmedIndex: confirmedAt,
        brokenIndex: null, touches: 1,
      });
    }

    // Invalidate live zones against the bar that has just printed.
    const level = invalidation === "close" ? bars.close[i]! : null;
    for (const z of zones) {
      if (z.brokenIndex !== null || i < z.confirmedIndex) continue;
      const through = z.kind === "support"
        ? (level !== null ? level < z.price : bars.low[i]! < z.price)
        : (level !== null ? level > z.price : bars.high[i]! > z.price);
      if (through) z.brokenIndex = i;
    }
  }
  return zones;
}

/** The zones that were live and knowable at bar `index`, newest first. */
export function zonesAsOf(zones: Zone[], index: number, opts: SrOptions = DEFAULT_SR_OPTIONS): Zone[] {
  return zones
    .filter((z) => z.confirmedIndex <= index && (z.brokenIndex === null || z.brokenIndex > index))
    .sort((a, b) => b.confirmedIndex - a.confirmedIndex)
    .slice(0, opts.maxZones * 2);
}

/**
 * The nearest live support at or below `price`, and the nearest live
 * resistance at or above it.
 *
 * "Nearest support" deliberately means the closest one BELOW: a support that
 * price has already risen far above is not what a trader means by the level
 * they are approaching, and one above current price has been broken.
 */
export function nearestZones(
  zones: Zone[], index: number, price: number, opts: SrOptions = DEFAULT_SR_OPTIONS
): { support: Zone | null; resistance: Zone | null } {
  const live = zonesAsOf(zones, index, opts);
  let support: Zone | null = null;
  let resistance: Zone | null = null;
  for (const z of live) {
    if (z.kind === "support" && z.price <= price) {
      if (!support || z.price > support.price) support = z;
    } else if (z.kind === "resistance" && z.price >= price) {
      if (!resistance || z.price < resistance.price) resistance = z;
    }
  }
  return { support, resistance };
}
