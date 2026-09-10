// Mirrors the backend API response shapes (see backend/src/types).
import type { AssetClass } from "./instrument";
import type { Resolution } from "./resolution";

/**
 * An interval the backend stores as venue klines.
 *
 * NOT the same thing as what a chart can be set to. A chart is set to a
 * `Resolution` (`lib/resolution.ts`), which is either one of these or a whole
 * multiple of one — `30s` is three… no: `30s` is thirty `1s` bars, `45m` is
 * three `15m` bars. This narrower type is what alerts, backtests and
 * deployments speak, because those subsystems run on stored series.
 */
export type Interval =
  | "1s" | "1m" | "3m" | "5m" | "15m" | "30m"
  | "1h" | "2h" | "4h" | "6h" | "8h" | "12h" | "1d";

/**
 * Every interval the backend stores, as a value list.
 *
 * Persisted workspace state names a resolution as a plain string, so restoring
 * it needs a runtime guard — a stored `"7s"` from a hand-edited or corrupted
 * entry must be rejected rather than handed to the chart. For a CHART that
 * guard is `isResolution`; this one is for the subsystems that need a stored
 * series to exist.
 *
 * Kept in step with the backend's own `INTERVALS` and with
 * `resolution.NATIVE_RESOLUTIONS` by `tests/resolution.test.ts`.
 */
export const INTERVAL_VALUES: readonly Interval[] = [
  "1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d",
];

export function isInterval(value: unknown): value is Interval {
  return typeof value === "string" && (INTERVAL_VALUES as readonly string[]).includes(value);
}

/**
 * The intervals an alert may be armed on — every stored interval except `1s`.
 *
 * Mirrors the backend's `ALERT_INTERVALS`, and for the backend's reason: the
 * alert runner cannot honour "once per bar close" on a one-second bar, so the
 * API refuses one. Offering it in a dialog and having the server refuse it
 * would be a worse way to learn that.
 */
export const ALERT_INTERVAL_VALUES: readonly Interval[] =
  INTERVAL_VALUES.filter((i) => i !== "1s");

/**
 * One bar's duration, per stored interval.
 *
 * Here rather than in the chart component because the history loader, the
 * overlay range and the backfill window all need it, and none of them should
 * have to import a React component to do arithmetic. For a chart resolution
 * that may be derived, use `resolutionMs` — this table only knows the eleven…
 * thirteen the store holds.
 */
export const INTERVAL_MS: Record<Interval, number> = {
  "1s": 1000,
  "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000,
  "1h": 3600000, "2h": 7200000, "4h": 14400000, "6h": 21600000, "8h": 28800000,
  "12h": 43200000, "1d": 86400000,
};

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
   * Legacy database rows remain `BINANCE` / `crypto_spot`; canonical market
   * rows can also be read-only crypto derivatives.
   * Optional because this is a mirror of a response shape rather than a shape
   * this side owns: a reader must not crash on a row that predates the field.
   * `lib/instrument` supplies the same defaults the backend does.
   */
  venue?: string;
  assetClass?: AssetClass;
}

export interface Candle {
  symbol: string;
  /**
   * The resolution this bar IS — `"15m"`, or `"45m"` when the server folded
   * three of them. A `Resolution`, not an `Interval`: the chart draws bars the
   * candle store does not hold, and a bar that named its source instead of
   * itself would let a live `15m` frame be merged into a `45m` window.
   */
  interval: Resolution;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface Strategy {
  id: number;
  key: string;
  name: string;
  description: string | null;
  pineSource: string | null;
}

export type StrategyParams = Record<string, number | string | boolean>;

export interface StrategyConfig {
  id: string;
  strategyId: number;
  name: string;
  symbol: string | null;
  timeframe: Interval;
  params: StrategyParams;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type BacktestStatus = "queued" | "running" | "done" | "error";

export interface BacktestMetrics {
  netProfit: number;
  netProfitPct: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  maxDrawdownPct: number;
  avgTradePct: number;
  avgBarsInTrade: number;
  commissionPaid: number;
  /** Position still running at the end of the window; never counted above. */
  openTrade?: OpenTrade | null;
}

/** A trade that had not closed when the backtest window ended. */
export interface OpenTrade {
  entryTime: number;
  entryPrice: number;
  qty: number;
  stop: number | null;
  target: number | null;
  lastPrice: number;
  lastTime: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  barsHeld: number;
}

export interface EquityPoint {
  t: number;
  equity: number;
  drawdownPct: number;
}

export interface Backtest {
  id: string;
  strategyId: number;
  configId: string | null;
  symbol: string;
  timeframe: Interval;
  startTime: string;
  endTime: string;
  params: StrategyParams;
  initialCapital: number;
  commissionPct: number;
  slippageTicks: number;
  status: BacktestStatus;
  error: string | null;
  metrics: BacktestMetrics | null;
  equityCurve: EquityPoint[] | null;
  createdAt: string;
}

export interface Trade {
  tradeNo: number;
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  exitTime: number | null;
  exitPrice: number | null;
  qty: number;
  pnl: number | null;
  pnlPct: number | null;
  exitReason: string | null;
  runUpPct: number | null;
  drawdownPct: number | null;
  cumProfit: number | null;
}

/**
 * How a deployment's signals leave the platform. Mirrors the backend's
 * `types/deployments.ts`.
 *
 *   `custom` / `3commas` — real orders.
 *   `off`                — evaluate and record; send nothing, simulate nothing.
 *   `paper`              — evaluate, record, and SIMULATE the fill at the live
 *                          cost model. Sends nothing.
 */
export type DeliveryMode = "3commas" | "custom" | "off" | "paper";

/** The two modes that reach an external system. */
export const LIVE_DELIVERY_MODES: readonly DeliveryMode[] = ["3commas", "custom"];

export function deliversLiveOrders(mode: DeliveryMode): boolean {
  return LIVE_DELIVERY_MODES.includes(mode);
}
export type DeploymentStatus = "active" | "paused" | "stopped";

export interface Deployment {
  id: string;
  strategyId: number;
  configId: string | null;
  symbol: string;
  timeframe: Interval;
  params: StrategyParams;
  status: DeploymentStatus;
  delivery: DeliveryMode;
  webhookUrl: string | null;
  botUuid: string | null;
  buyQuoteQty: number | null;
  runtimeState: { position: "flat" | "long"; entryPrice: number | null };
  lastBarTime: string | null;
  createdAt: string;
}

export interface Alert {
  id: number;
  deploymentId: string;
  barTime: string;
  firedAt: string;
  action: "buy" | "sell";
  marketPosition: string;
  triggerPrice: number;
  reason: string | null;
  dedupeKey: string | null;
  deliveryStatus: "pending" | "sent" | "failed" | "skipped";
  httpStatus: number | null;
  attempts: number;
}
