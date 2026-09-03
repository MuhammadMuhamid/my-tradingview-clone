// Mirrors the backend API response shapes (see backend/src/types).

export type Interval =
  | "1m" | "3m" | "5m" | "15m" | "30m"
  | "1h" | "2h" | "4h" | "6h" | "12h" | "1d";

/**
 * Every interval the backend serves, as a value list.
 *
 * Persisted workspace state names an interval as a plain string, so restoring
 * it needs a runtime guard — a stored `"7m"` from a hand-edited or corrupted
 * entry must be rejected rather than handed to the chart as an `Interval`.
 */
export const INTERVAL_VALUES: readonly Interval[] = [
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d",
];

export function isInterval(value: unknown): value is Interval {
  return typeof value === "string" && (INTERVAL_VALUES as readonly string[]).includes(value);
}

/**
 * One bar's duration, per interval.
 *
 * Here rather than in the chart component because the history loader, the
 * overlay range and the backfill window all need it, and none of them should
 * have to import a React component to do arithmetic.
 */
export const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000,
  "1h": 3600000, "2h": 7200000, "4h": 14400000, "6h": 21600000, "12h": 43200000, "1d": 86400000,
};

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  priceTick: number | null;
  qtyStep: number | null;
  minNotional: number | null;
  isActive: boolean;
}

export interface Candle {
  symbol: string;
  interval: Interval;
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
