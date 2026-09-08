"use client";
/**
 * Volume Profile: how much volume traded at each price, over a range of bars.
 *
 * ── What a profile is, and what it is not ──────────────────────────────────
 *
 * A profile is a histogram over PRICE rather than over time. Its inputs are a
 * range of bars and a price-binning policy; its outputs are per-bin volume,
 * the point of control, and the value area. Nothing about it is a series in
 * time, which is why it cannot be a `NativeStudyDef` plot and gets its own
 * render primitive (`ChartDecoration` of kind `profile`).
 *
 * ── The honest part ────────────────────────────────────────────────────────
 *
 * TradingView's help centre says its volume profiles are "calculated using
 * data from lower timeframes for the same symbol" — a daily profile is built
 * from that day's one-minute bars, so it knows WHERE inside the day each unit
 * of volume traded.
 *
 * This module is handed bars and told what they ARE. It never pretends to
 * know more than that:
 *
 *   `basis: "chart"`     the profile was built from the bars the chart is
 *                        drawing. Each bar's volume is spread across the rows
 *                        its own high–low covers, because that is the entire
 *                        extent of what the source data says about where it
 *                        traded. A one-day bar therefore produces a smear over
 *                        the day's range, not a spike at its close.
 *
 *   `basis: "refined"`   the caller genuinely loaded a finer venue resolution
 *                        for exactly this range and passed those bars instead.
 *                        The same allocation rule then runs over bars that are
 *                        actually small, which is where the detail comes from.
 *
 * The difference is reported, never hidden. `sourceInterval` names the bars
 * that were actually used. A profile that says "1D" is a coarse profile and
 * says so; one that says "1m" earned the shape it is drawing.
 *
 * ── Following the benchmark where the benchmark is a rule, not a look ──────
 *
 * Two definitions are TradingView's, taken from its published documentation
 * rather than guessed, because they are conventions rather than opinions and
 * a profile that disagreed with them would be quietly incomparable:
 *
 *   up/down    "If the bar closes above or equal to its open, this counts as
 *              an up bar, otherwise it's a down bar."  A doji is an up bar.
 *
 *   value area start at the point of control; repeatedly compare the next row
 *              above with the next row below and take the larger; on a tie take
 *              the row closer to the point of control, and if the distances are
 *              equal take the row above; stop once the running total reaches
 *              the requested share of the range's volume.
 *
 * Row layout deliberately diverges. TradingView offers "ticks per row", which
 * requires the instrument's tick size; this pane does not have one, and a
 * guessed tick would put every row boundary in the wrong place while looking
 * exactly like a real one. So the layouts are a row COUNT and an explicit
 * price-height per row, both of which are true without venue metadata.
 */
import type { Candle } from "@/lib/types";
import type { Resolution } from "@/lib/resolution";

/** How the price axis is cut into rows. */
export type RowLayout = "rows" | "height";

/** How a bar's volume is placed on the price axis. */
export type VolumeAllocation = "range" | "close";

/** What the bars a profile was computed from actually were. */
export type ProfileBasis = "chart" | "refined";

export interface VolumeProfileSettings {
  layout: RowLayout;
  /** Row count when `layout` is `rows`; price height per row when `height`. */
  rowSize: number;
  /** Share of the range's volume inside the value area, in percent. */
  valueAreaPercent: number;
  allocation: VolumeAllocation;
}

export const DEFAULT_PROFILE_SETTINGS: VolumeProfileSettings = {
  layout: "rows",
  rowSize: 24,
  valueAreaPercent: 70,
  allocation: "range",
};

/** Rows a profile may be cut into. Bounded so a drag cannot ask for 10⁶ rows. */
export const MIN_ROWS = 4;
export const MAX_ROWS = 400;
export const MIN_VALUE_AREA = 30;
export const MAX_VALUE_AREA = 100;

export interface VolumeProfileRow {
  /** Inclusive lower price edge. */
  low: number;
  /** Exclusive upper price edge, except for the top row which includes it. */
  high: number;
  /** Volume attributed to this row, in the instrument's base units. */
  total: number;
  /** The share of `total` from bars whose close was at or above their open. */
  up: number;
  /** `total − up`, kept explicitly so a renderer never has to subtract. */
  down: number;
}

export interface VolumeProfile {
  rows: VolumeProfileRow[];
  /** Index into `rows` of the point of control, or −1 when there is no volume. */
  pocIndex: number;
  /** Mid price of the point-of-control row, or null. */
  poc: number | null;
  /** Upper edge of the highest row in the value area, or null. */
  valueAreaHigh: number | null;
  /** Lower edge of the lowest row in the value area, or null. */
  valueAreaLow: number | null;
  /** Indices of `rows` inside the value area, ascending. */
  valueAreaRows: number[];
  /** Volume inside the value area. */
  valueAreaVolume: number;
  totalVolume: number;
  /** The largest single row total, which is what a renderer scales against. */
  peakVolume: number;
  /** Lowest low and highest high across the range. */
  priceLow: number;
  priceHigh: number;
  /** Open time of the first and last bar used, in epoch milliseconds. */
  from: number | null;
  to: number | null;
  /** How many bars were folded in. */
  bars: number;
  basis: ProfileBasis;
  /** The resolution of the bars actually used. */
  sourceInterval: Resolution;
  /** How each source bar's volume was assigned to price rows. */
  allocation: VolumeAllocation;
}

/** A profile of nothing: an empty range, or one with no traded volume. */
export function emptyProfile(interval: Resolution, basis: ProfileBasis = "chart"): VolumeProfile {
  return {
    rows: [], pocIndex: -1, poc: null,
    valueAreaHigh: null, valueAreaLow: null, valueAreaRows: [], valueAreaVolume: 0,
    totalVolume: 0, peakVolume: 0,
    priceLow: 0, priceHigh: 0, from: null, to: null, bars: 0,
    basis, sourceInterval: interval, allocation: DEFAULT_PROFILE_SETTINGS.allocation,
  };
}

/**
 * Coerce settings that may have come from storage, a dialog, or a hand-edited
 * layout onto values a profile can actually be computed from.
 *
 * Total, like `normalizeParams`: a row count of `"lots"` is a default, not an
 * exception thrown inside a render.
 */
export function normalizeProfileSettings(
  raw: Partial<VolumeProfileSettings> | undefined
): VolumeProfileSettings {
  const layout: RowLayout = raw?.layout === "height" ? "height" : "rows";
  const size = typeof raw?.rowSize === "number" && Number.isFinite(raw.rowSize)
    ? raw.rowSize : DEFAULT_PROFILE_SETTINGS.rowSize;
  const rowSize = layout === "rows"
    ? Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(size)))
    // A row height is a price, so it is not rounded — but it must be positive,
    // because a height of zero is a request for infinitely many rows.
    : (size > 0 ? size : DEFAULT_PROFILE_SETTINGS.rowSize);
  const pct = typeof raw?.valueAreaPercent === "number" && Number.isFinite(raw.valueAreaPercent)
    ? raw.valueAreaPercent : DEFAULT_PROFILE_SETTINGS.valueAreaPercent;
  return {
    layout,
    rowSize,
    valueAreaPercent: Math.max(MIN_VALUE_AREA, Math.min(MAX_VALUE_AREA, Math.round(pct))),
    allocation: raw?.allocation === "close" ? "close" : "range",
  };
}

/**
 * Bars whose open time falls in `[fromMs, toMs]`, as a contiguous slice.
 *
 * A slice rather than a filter because the caller's bars are already sorted by
 * open time, and a binary search over ten thousand of them is what makes a
 * fixed range cheap enough to recompute while its handle is being dragged.
 *
 * The bounds are inclusive at both ends and the pair may arrive either way
 * round, because a range drawn right-to-left is the same range.
 */
export function barsInRange(
  candles: readonly Candle[], fromMs: number, toMs: number
): readonly Candle[] {
  if (candles.length === 0) return candles;
  const lo = Math.min(fromMs, toMs);
  const hi = Math.max(fromMs, toMs);
  const start = lowerBound(candles, lo);
  const end = upperBound(candles, hi);
  if (end <= start) return [];
  return start === 0 && end === candles.length ? candles : candles.slice(start, end);
}

/** First index whose open time is >= `t`. */
function lowerBound(candles: readonly Candle[], t: number): number {
  let low = 0, high = candles.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (candles[mid]!.openTime < t) low = mid + 1; else high = mid;
  }
  return low;
}

/** First index whose open time is > `t`. */
function upperBound(candles: readonly Candle[], t: number): number {
  let low = 0, high = candles.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (candles[mid]!.openTime <= t) low = mid + 1; else high = mid;
  }
  return low;
}

/**
 * The profile of a range of bars.
 *
 * Pure and total: no bars, no volume, or a range where every bar traded at one
 * price all produce a well-formed profile rather than a thrown error or a NaN
 * edge. The one thing it will not do is invent a distribution the bars do not
 * support — see the module note on `basis`.
 */
export function computeVolumeProfile(
  candles: readonly Candle[],
  settings: VolumeProfileSettings,
  interval: Resolution,
  basis: ProfileBasis = "chart"
): VolumeProfile {
  if (candles.length === 0) return emptyProfile(interval, basis);

  let priceLow = Number.POSITIVE_INFINITY;
  let priceHigh = Number.NEGATIVE_INFINITY;
  for (const c of candles) {
    if (Number.isFinite(c.low) && c.low < priceLow) priceLow = c.low;
    if (Number.isFinite(c.high) && c.high > priceHigh) priceHigh = c.high;
  }
  if (!Number.isFinite(priceLow) || !Number.isFinite(priceHigh)) {
    return emptyProfile(interval, basis);
  }

  /*
   * A range where price never moved is one row, not zero and not `rowSize` of
   * height zero. It happens on a halted or untraded instrument and on a single
   * bar whose high equals its low, and both should draw one bar of volume at
   * that price rather than nothing at all.
   */
  const span = priceHigh - priceLow;
  const rowCount = span <= 0
    ? 1
    : settings.layout === "rows"
      ? settings.rowSize
      : Math.max(1, Math.min(MAX_ROWS, Math.ceil(span / settings.rowSize)));
  const rowHeight = span <= 0 ? 0 : span / rowCount;

  const totals = new Float64Array(rowCount);
  const ups = new Float64Array(rowCount);

  /** Which row a price belongs to, clamped into the profile. */
  const rowOf = (price: number): number => {
    if (rowHeight <= 0) return 0;
    const idx = Math.floor((price - priceLow) / rowHeight);
    return idx < 0 ? 0 : idx >= rowCount ? rowCount - 1 : idx;
  };

  for (const bar of candles) {
    const volume = Number.isFinite(bar.volume) ? Math.max(0, bar.volume) : 0;
    if (volume === 0) continue;
    // TradingView's rule, quoted in the module note: at-or-above open is up.
    const up = bar.close >= bar.open;

    if (settings.allocation === "close" || !(bar.high > bar.low)) {
      const idx = rowOf(settings.allocation === "close" ? bar.close : bar.high);
      totals[idx]! += volume;
      if (up) ups[idx]! += volume;
      continue;
    }

    /*
     * Spread across every row the bar's own range touches, proportionally to
     * how much of the bar's range each row holds.
     *
     * This is the whole of what an OHLCV bar says about where its volume
     * traded. Concentrating it at the close instead would draw a sharp,
     * confident profile out of data that does not contain that confidence —
     * which is the specific dishonesty this module exists to avoid. It stays
     * available as `allocation: "close"` because it is a legitimate different
     * question ("where did bars finish"), just not the default.
     */
    const first = rowOf(bar.low);
    const last = rowOf(bar.high);
    if (first === last) {
      totals[first]! += volume;
      if (up) ups[first]! += volume;
      continue;
    }
    const barSpan = bar.high - bar.low;
    for (let i = first; i <= last; i++) {
      const rowLow = priceLow + i * rowHeight;
      const rowHigh = i === rowCount - 1 ? priceHigh : rowLow + rowHeight;
      const overlap = Math.min(bar.high, rowHigh) - Math.max(bar.low, rowLow);
      if (!(overlap > 0)) continue;
      const share = (overlap / barSpan) * volume;
      totals[i]! += share;
      if (up) ups[i]! += share;
    }
  }

  const rows: VolumeProfileRow[] = [];
  let totalVolume = 0;
  let peakVolume = 0;
  let pocIndex = -1;
  for (let i = 0; i < rowCount; i++) {
    const low = priceLow + i * rowHeight;
    const high = i === rowCount - 1 ? priceHigh : low + rowHeight;
    const total = totals[i]!;
    const up = ups[i]!;
    rows.push({ low, high, total, up, down: total - up });
    totalVolume += total;
    /*
     * Strictly greater, so the LOWEST row wins a tie for the point of control.
     * A rule is needed because ties are common on thin instruments and on a
     * profile with many rows; which way it goes matters less than that it is
     * the same way every time, so the level does not flicker between two rows
     * as a live bar nudges them past each other.
     */
    if (total > peakVolume) { peakVolume = total; pocIndex = i; }
  }

  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const base: VolumeProfile = {
    rows, pocIndex,
    poc: pocIndex >= 0 ? (rows[pocIndex]!.low + rows[pocIndex]!.high) / 2 : null,
    valueAreaHigh: null, valueAreaLow: null, valueAreaRows: [], valueAreaVolume: 0,
    totalVolume, peakVolume,
    priceLow, priceHigh,
    from: first.openTime, to: last.openTime, bars: candles.length,
    basis, sourceInterval: interval, allocation: settings.allocation,
  };
  if (pocIndex < 0 || totalVolume <= 0) return base;

  const area = valueArea(rows, pocIndex, totalVolume, settings.valueAreaPercent);
  return {
    ...base,
    valueAreaRows: area.indices,
    valueAreaVolume: area.volume,
    valueAreaLow: rows[area.indices[0]!]!.low,
    valueAreaHigh: rows[area.indices[area.indices.length - 1]!]!.high,
  };
}

/**
 * The value area, by TradingView's published rule.
 *
 * Start at the point of control. Compare the next row above with the next row
 * below and take the larger. On equal volumes take the row closer to the point
 * of control; if the distances are also equal take the row above. Stop once
 * the running total has reached the requested share of the range's volume —
 * the row that crosses the threshold is included, so the area always holds at
 * least the percentage asked for rather than the largest amount under it.
 */
function valueArea(
  rows: readonly VolumeProfileRow[], pocIndex: number,
  totalVolume: number, percent: number
): { indices: number[]; volume: number } {
  const target = totalVolume * (percent / 100);
  let low = pocIndex;
  let high = pocIndex;
  let running = rows[pocIndex]!.total;

  while (running < target && (low > 0 || high < rows.length - 1)) {
    const above = high < rows.length - 1 ? rows[high + 1]!.total : null;
    const below = low > 0 ? rows[low - 1]!.total : null;
    let takeAbove: boolean;
    if (above === null && below === null) break;
    else if (above === null) takeAbove = false;
    else if (below === null) takeAbove = true;
    else if (above > below) takeAbove = true;
    else if (below > above) takeAbove = false;
    else {
      const distAbove = high + 1 - pocIndex;
      const distBelow = pocIndex - (low - 1);
      takeAbove = distAbove <= distBelow;
    }
    if (takeAbove) { high += 1; running += rows[high]!.total; }
    else { low -= 1; running += rows[low]!.total; }
  }

  const indices: number[] = [];
  for (let i = low; i <= high; i++) indices.push(i);
  return { indices, volume: running };
}

/**
 * What the reader is owed about how truthful this profile's shape is.
 *
 * Returned as a sentence rather than a badge because the fact is not binary:
 * a 1-minute chart's own bars ARE minute resolution, and saying "coarse" about
 * them would be as wrong as saying "precise" about a daily bar's smear.
 */
export function profileBasisNotice(profile: VolumeProfile): string {
  if (profile.bars === 0) return "No bars in this range.";
  const where = profile.basis === "refined"
    ? `Built from ${profile.sourceInterval} bars loaded for this range`
    : `Built from this chart's own ${profile.sourceInterval} bars`;
  const how = profile.rows.length > 0 && profile.rows.some((r) => r.total > 0)
    ? profile.allocation === "close"
      ? ", each bar's volume placed at its close"
      : ", each bar's volume spread across the rows its high–low covers"
    : "";
  const caveat = profile.basis === "refined"
    ? "."
    : " — the source data does not say where inside a bar its volume traded.";
  return `${where}${how}${caveat}`;
}
