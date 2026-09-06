import type { AssetClass } from "./instrument";

/**
 * Binance kline intervals the platform stores.
 *
 * These are the resolutions that exist as rows in `candles`, that the backfill
 * fetches, and that the engine, the alert runner and the Pine runner compute
 * on. A CHART may sit on more than these — see `data/resolution.ts`, which
 * folds whole numbers of these bars into 30-second, 45-minute or 3-hour bars —
 * but every one of those is made of these, and nothing here is ever synthesised
 * from something coarser than itself.
 *
 * `1s` and `8h` are as native as the rest: Binance publishes both as Spot
 * klines, `1s` back to 2017. They were absent because the list was written once
 * and never revisited, not because the data was unavailable.
 *
 * `3d`, `1w` and `1M` remain absent deliberately. Their length or their anchor
 * is a calendar fact rather than arithmetic, and this table's whole contract is
 * that `INTERVAL_MS` is exact.
 */
export const INTERVALS = [
  "1s", "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "8h", "12h", "1d",
] as const;
export type Interval = (typeof INTERVALS)[number];

export function isInterval(v: string): v is Interval {
  return (INTERVALS as readonly string[]).includes(v);
}

/** Milliseconds per interval — used for bar arithmetic and gap detection. */
export const INTERVAL_MS: Record<Interval, number> = {
  "1s": 1_000,
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
};

/**
 * The intervals an alert may be armed on.
 *
 * Every stored interval except `1s`. Not a data limitation — a one-second feed
 * is real — but an engine one, stated here rather than discovered by a user
 * whose alert never fires: the runner throttles intrabar evaluation to one
 * sample every two seconds and recomputes a 1,200-bar window per evaluation, so
 * it could not honour "once per bar" on a one-second bar. An alert this
 * platform cannot evaluate on the promised bar is refused at the API rather
 * than stored and quietly skipped, and `POST /api/alerts` says so.
 */
export const ALERT_INTERVALS: readonly Interval[] = INTERVALS.filter((i) => i !== "1s");

export function isAlertInterval(v: string): v is Interval {
  return (ALERT_INTERVALS as readonly string[]).includes(v);
}

/** One OHLCV bar. Times are epoch milliseconds UTC (Binance native). */
export interface Candle {
  symbol: string;
  interval: Interval;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
  tradeCount?: number;
  closeTime: number;
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  priceTick: number | null;
  qtyStep: number | null;
  minNotional: number | null;
  isActive: boolean;
  /**
   * Which venue and asset class this ticker belongs to.
   *
   * Always `BINANCE` / `crypto_spot` on this installation — that is the only
   * feed there is. Present so the identity is stated rather than assumed by
   * every reader; see `types/instrument.ts`.
   */
  venue: string;
  assetClass: AssetClass;
}
