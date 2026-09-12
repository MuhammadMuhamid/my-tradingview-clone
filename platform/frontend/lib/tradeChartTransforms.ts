/** Trade-driven chart primitives. They require ordered public executions; OHLC
 * candles alone are deliberately insufficient and never used as a substitute. */
export interface AggregateTrade { id?: number; timestamp: number; price: number; quantity: number; aggressor: "buy" | "sell" }
export interface RangeBar { openTime: number; open: number; high: number; low: number; close: number; volume: number; sourceTrades: number }
export interface FootprintLevel { price: number; buyVolume: number; sellVolume: number; totalVolume: number; delta: number }
export interface FootprintBar { openTime: number; closeTime: number; levels: FootprintLevel[]; totalVolume: number; delta: number }

/** Replay boundary: executions after the horizon are never visible. */
export function tradesThroughHorizon(trades: readonly AggregateTrade[], horizonMs: number | null): AggregateTrade[] {
  if (horizonMs == null || !Number.isFinite(horizonMs)) return [...trades];
  return trades.filter((trade) => trade.timestamp <= horizonMs);
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
  if (!(rangeSize > 0)) return [];
  const out: RangeBar[] = []; let current: RangeBar | null = null;
  for (const trade of [...trades].sort((a, b) => a.timestamp - b.timestamp)) {
    if (!Number.isFinite(trade.price) || trade.quantity <= 0) continue;
    if (!current) current = { openTime: trade.timestamp, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: trade.quantity, sourceTrades: 1 };
    else { current.high = Math.max(current.high, trade.price); current.low = Math.min(current.low, trade.price); current.close = trade.price; current.volume += trade.quantity; current.sourceTrades += 1; }
    if (current.high - current.low >= rangeSize) { out.push({ ...current, high: Math.round(current.high / tickSize) * tickSize, low: Math.round(current.low / tickSize) * tickSize }); current = null; }
  }
  if (current) out.push(current); return out;
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
