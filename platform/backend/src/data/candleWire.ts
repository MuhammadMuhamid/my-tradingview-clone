/**
 * Compact wire encoding for candle responses.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * The verbose per-candle object repeats `symbol` and `interval` on EVERY bar
 * and carries `closeTime`, which is `openTime + interval - 1` by definition.
 * Measured on the chart's default 10,000-bar request for a 15m feed
 * (`scripts/bench_candles.ts`):
 *
 *     verbose   2,487,844 bytes   249 B/bar   11.1 ms to JSON.parse
 *     compact     674,250 bytes    67 B/bar    4.2 ms to JSON.parse
 *
 * 72.9 % smaller, 2.7x faster to parse. That parse happens on the browser's
 * main thread before anything can be drawn, and it happens again on every
 * symbol and timeframe switch.
 *
 * ── Rounding ───────────────────────────────────────────────────────────────
 *
 * Prices are rounded to 8 decimals, which is Binance's maximum tick precision.
 * This is not lossy in the meaningful sense: Binance sends prices as decimal
 * STRINGS with at most 8 places, and `parseFloat` then produces a double whose
 * shortest round-trip representation sometimes carries printing noise —
 * `100.30000000000001` for a price that was `100.3`. Rounding recovers the
 * value that was actually sent. It is both smaller and more faithful.
 *
 * ── Compatibility ──────────────────────────────────────────────────────────
 *
 * Opt-in via `?format=compact`. The default response shape is unchanged, so no
 * existing consumer breaks.
 */
import type { Candle, Interval } from "../types/market";
import { INTERVAL_MS } from "../types/market";

/** `[openTime, open, high, low, close, volume]`. */
export type CompactBar = [number, number, number, number, number, number];

export interface CompactCandles {
  format: "compact-v1";
  symbol: string;
  interval: Interval;
  /** Milliseconds per bar, so `closeTime` is derivable without a lookup table. */
  stepMs: number;
  count: number;
  bars: CompactBar[];
}

/** Binance quotes at most 8 decimal places; anything beyond is float noise. */
const PRICE_DECIMALS = 8;
const round = (n: number): number =>
  Number.isFinite(n) ? Number(n.toFixed(PRICE_DECIMALS)) : 0;

export function toCompact(
  candles: Candle[],
  symbol: string,
  interval: Interval
): CompactCandles {
  return {
    format: "compact-v1",
    symbol,
    interval,
    stepMs: INTERVAL_MS[interval],
    count: candles.length,
    bars: candles.map((c): CompactBar => [
      c.openTime,
      round(c.open),
      round(c.high),
      round(c.low),
      round(c.close),
      round(c.volume),
    ]),
  };
}

/**
 * Expand back to full candles.
 *
 * `quoteVolume` and `tradeCount` are NOT carried: nothing on the chart path
 * reads them, and including them would give back most of the saving. A consumer
 * that needs them must use the default format — which is why this is opt-in
 * rather than the only shape.
 */
export function fromCompact(payload: CompactCandles): Candle[] {
  const { symbol, interval, stepMs } = payload;
  return payload.bars.map(([openTime, open, high, low, close, volume]) => ({
    symbol,
    interval,
    openTime,
    open,
    high,
    low,
    close,
    volume,
    closeTime: openTime + stepMs - 1,
  }));
}

/** True when a response body is the compact shape rather than a candle array. */
export function isCompact(body: unknown): body is CompactCandles {
  return (
    typeof body === "object" && body !== null &&
    (body as { format?: unknown }).format === "compact-v1"
  );
}
