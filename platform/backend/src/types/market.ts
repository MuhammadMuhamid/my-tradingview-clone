import type { AssetClass } from "./instrument";

/** Binance kline intervals the platform supports. */
export const INTERVALS = [
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "12h", "1d",
] as const;
export type Interval = (typeof INTERVALS)[number];

export function isInterval(v: string): v is Interval {
  return (INTERVALS as readonly string[]).includes(v);
}

/** Milliseconds per interval — used for bar arithmetic and gap detection. */
export const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
};

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
