/** Trade-driven chart primitives. They require ordered public executions; OHLC
 * candles alone are deliberately insufficient and never used as a substitute. */
export interface AggregateTrade { id?: number; timestamp: number; price: number; quantity: number; aggressor: "buy" | "sell" }
/**
 * `openTime` ORDERS a range bar; `sourceOpenTime` says when it happened.
 *
 * A range bar completes on a price crossing, not on a clock, and one execution
 * can complete several at the same instant. The renderer needs a strictly
 * increasing key — lightweight-charts indexes rows by time point, and rows
 * sharing one are silently mis-indexed by the production build — while the
 * crosshair, the legend and Replay need the real market time. Renko, Kagi,
 * Point & Figure and Line break already carry both for exactly this reason.
 */
export interface RangeBar {
  openTime: number; sourceOpenTime: number;
  open: number; high: number; low: number; close: number;
  volume: number; sourceTrades: number;
}
export interface FootprintLevel { price: number; buyVolume: number; sellVolume: number; totalVolume: number; delta: number }
export interface FootprintBar { openTime: number; closeTime: number; levels: FootprintLevel[]; totalVolume: number; delta: number }

/** Replay boundary: executions after the horizon are never visible. */
export function tradesThroughHorizon(trades: readonly AggregateTrade[], horizonMs: number | null): AggregateTrade[] {
  if (horizonMs == null || !Number.isFinite(horizonMs)) return [...trades];
  return trades.filter((trade) => trade.timestamp <= horizonMs);
}

/**
 * The price move one range bar represents.
 *
 * `ticks` is what the user set, when they set one. `auto` sizes from the
 * instrument instead: five basis points of the last traded price, rounded to a
 * whole number of ticks and never below one. Five is chosen to sit near the
 * reference's own default on a major pair while staying meaningful on a
 * sub-dollar one, which a fixed tick count cannot do for both.
 */
export function rangeBarSize(
  tickSize: number, ticks: number, auto: boolean, lastPrice: number | null
): number {
  if (!(tickSize > 0)) return 0;
  if (!auto || lastPrice === null || !(lastPrice > 0)) return tickSize * Math.max(1, ticks);
  return tickSize * Math.max(1, Math.round((lastPrice * 0.0005) / tickSize));
}

/** Convert truthful trade bars to the common renderer's OHLC shape. */
export function rangeBarsAsOhlc(trades: readonly AggregateTrade[], rangeSize: number, tickSize = 0.01): RangeBar[] {
  return rangeBars(trades, rangeSize, tickSize);
}

export function footprintBarsAsOhlc(trades: readonly AggregateTrade[], intervalMs: number, tickSize = 0.01): Array<{
  openTime: number; open: number; high: number; low: number; close: number; volume: number;
}> {
  return footprintBars(trades, intervalMs, tickSize).flatMap((bar) => {
    if (bar.levels.length === 0) return [];
    const levels = bar.levels;
    const first = levels[0]!.price;
    const last = levels[levels.length - 1]!.price;
    const weighted = levels.reduce((sum, level) => sum + level.price * level.totalVolume, 0);
    return [{ openTime: bar.openTime, open: first, high: last, low: first, close: bar.totalVolume > 0 ? weighted / bar.totalVolume : first, volume: bar.totalVolume }];
  });
}

export function rangeBars(trades: readonly AggregateTrade[], rangeSize: number, tickSize = 0.01): RangeBar[] {
  if (!(rangeSize > 0) || !(tickSize > 0)) return [];
  const out: RangeBar[] = []; let current: RangeBar | null = null;
  /*
   * Range was the one bar producer in this repository with no monotonic guard.
   *
   * It emitted the raw execution timestamp, and a single trade crossing three
   * boundaries emitted three bars carrying that one timestamp. The production
   * `lightweight-charts` bundle does not assert ascending order — only the
   * development build does — so `setData` accepted the duplicates, indexed all
   * but one of them to 0, and every subsequent bar-colour lookup failed
   * `ensureNotNull(findBar(...))`. That is the `Value is null` seen 36 times on
   * Range and on no other chart type: the other four transforms all space their
   * bars by at least a millisecond, and the bucketed types cannot collide.
   *
   * The spacing is a whole second, floored to the second, because the series
   * key is `openTime / 1000` and the renderer's time points are integers — the
   * same reason Renko spaces its bricks by 1000ms rather than by 1. An
   * execution's millisecond precision would otherwise arrive as a fractional
   * time point. The honest time is kept beside it and is what the crosshair,
   * the legend and Replay read through `canonicalOpenTime`.
   */
  let lastEmitted = Number.NEGATIVE_INFINITY;
  const emit = (bar: Omit<RangeBar, "openTime" | "sourceOpenTime"> & { sourceOpenTime: number }): void => {
    const openTime = Math.max(Math.floor(bar.sourceOpenTime / 1000) * 1000, lastEmitted + 1000);
    lastEmitted = openTime;
    out.push({ ...bar, openTime });
  };
  // An exact completion leaves a real boundary behind. The next execution
  // must form from that boundary, rather than seeding a new bar at its own
  // price and silently dropping the intervening move.
  let lastBoundaryU: number | null = null;
  const ticks = Math.max(1, Math.round(rangeSize / tickSize));
  const unit = (price: number) => Math.round(price / tickSize);
  // Keep tick-derived boundaries stable when binary floating point cannot
  // represent the provider's decimal tick (for example 0.0001 * 10003).
  const price = (u: number) => {
    const value = u * tickSize;
    return Number.isFinite(value) ? Number(value.toPrecision(15)) : value;
  };
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp || (a.id ?? 0) - (b.id ?? 0));
  for (const trade of sorted) {
    if (!Number.isFinite(trade.price) || trade.quantity <= 0) continue;
    const target = unit(trade.price);
    if (!current) {
      if (lastBoundaryU === null) {
        const p = price(target);
        current = { openTime: trade.timestamp, sourceOpenTime: trade.timestamp, open: p, high: p, low: p, close: p, volume: trade.quantity, sourceTrades: 1 };
        continue;
      }
      const boundary = price(lastBoundaryU);
      current = { openTime: trade.timestamp, sourceOpenTime: trade.timestamp, open: boundary, high: boundary, low: boundary, close: boundary, volume: 0, sourceTrades: 0 };
    }
    const openU = unit(current.open);
    const dir = target >= openU ? 1 : -1;
    const distance = Math.abs(target - openU);
    if (distance < ticks) {
      const p = price(target);
      current.high = Math.max(current.high, p); current.low = Math.min(current.low, p);
      current.close = p; current.volume += trade.quantity; current.sourceTrades += 1;
      continue;
    }
    // A single execution may cross several boundaries. Complete one bounded
    // synthetic segment per crossed range; only the final segment receives the
    // observed execution's volume. No intratrade path is invented beyond the
    // deterministic boundary prices required to represent the crossing.
    let from = openU;
    let remaining = distance;
    let first = true;
    while (remaining >= ticks) {
      const to = from + dir * ticks;
      const segmentOpen = price(from), segmentClose = price(to);
      emit({
        sourceOpenTime: first ? current.sourceOpenTime : trade.timestamp,
        open: segmentOpen,
        high: Math.max(segmentOpen, segmentClose),
        low: Math.min(segmentOpen, segmentClose),
        close: segmentClose,
        volume: first ? current.volume : 0,
        sourceTrades: first ? current.sourceTrades : 0,
      });
      first = false; from = to; remaining -= ticks;
    }
    if (remaining === 0) {
      const last = out[out.length - 1];
      if (last) { last.volume += trade.quantity; last.sourceTrades += 1; }
      lastBoundaryU = from;
      current = null;
    }
    else {
      const p = price(target), boundary = price(from);
      current = { openTime: trade.timestamp, sourceOpenTime: trade.timestamp, open: boundary, high: Math.max(boundary, p), low: Math.min(boundary, p), close: p, volume: trade.quantity, sourceTrades: 1 };
    }
  }
  if (current) emit(current);
  return out;
}

/**
 * The bar times the tape actually covers — the cheap half of `footprintBars`.
 *
 * A footprint chart draws exchange OHLC for every bar and real bid/ask cells
 * only where the tape reaches, so two places need to know which bars those
 * are: the series, to hand the covered bars a ghost body the cells can be read
 * over, and the pane, to say how many of them there are. Neither needs the
 * per-level aggregation, and running `footprintBars` twice more over 50,000
 * executions to learn a set of timestamps is the kind of cost that is easy to
 * add and hard to find. Same bucketing rule, same admission filter, one pass.
 */
export function footprintCoveredTimes(
  trades: readonly AggregateTrade[], intervalMs: number
): Set<number> {
  const out = new Set<number>();
  if (!(intervalMs > 0)) return out;
  for (const trade of trades) {
    if (!(trade.quantity > 0) || !Number.isFinite(trade.price)) continue;
    out.add(Math.floor(trade.timestamp / intervalMs) * intervalMs);
  }
  return out;
}

export function footprintBars(trades: readonly AggregateTrade[], intervalMs: number, tickSize = 0.01): FootprintBar[] {
  if (!(intervalMs > 0)) return [];
  const grouped = new Map<number, Map<number, FootprintLevel>>();
  const seen = new Set<number>();
  for (const trade of [...trades].sort((a, b) => a.timestamp - b.timestamp)) {
    const id = (trade as AggregateTrade & { id?: number }).id;
    if (id !== undefined) { if (seen.has(id)) continue; seen.add(id); }
    if (!(trade.quantity > 0) || !Number.isFinite(trade.price)) continue;
    const time = Math.floor(trade.timestamp / intervalMs) * intervalMs; const price = Math.round(trade.price / tickSize) * tickSize;
    const levels = grouped.get(time) ?? new Map<number, FootprintLevel>(); grouped.set(time, levels);
    const level = levels.get(price) ?? { price, buyVolume: 0, sellVolume: 0, totalVolume: 0, delta: 0 };
    if (trade.aggressor === "buy") { level.buyVolume += trade.quantity; level.delta += trade.quantity; }
    else { level.sellVolume += trade.quantity; level.delta -= trade.quantity; }
    level.totalVolume += trade.quantity; levels.set(price, level);
  }
  return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([openTime, levels]) => {
    const rows = [...levels.values()].sort((a, b) => a.price - b.price);
    return { openTime, closeTime: openTime + intervalMs, levels: rows,
      totalVolume: rows.reduce((s, l) => s + l.totalVolume, 0),
      delta: rows.reduce((s, l) => s + l.delta, 0) };
  });
}
