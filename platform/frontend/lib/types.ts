// Mirrors the backend API response shapes (see backend/src/types).

export type Interval =
  | "1m" | "3m" | "5m" | "15m" | "30m"
  | "1h" | "2h" | "4h" | "6h" | "12h" | "1d";

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

export type DeliveryMode = "3commas" | "custom" | "off";
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
