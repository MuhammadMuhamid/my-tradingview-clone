import type { Interval } from "./market";
import type { StrategyParams } from "./strategy";

export type BacktestStatus = "queued" | "running" | "done" | "error";

export interface BacktestRequest {
  strategyId: number;
  configId?: string;
  symbol: string;
  timeframe: Interval;
  startTime: number; // ms epoch
  endTime: number;   // ms epoch
  params: StrategyParams;
  initialCapital: number;
  commissionPct: number;  // % per fill, Pine commission_value
  slippageTicks: number;  // Pine slippage
}

export interface TradeRecord {
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

export interface EquityPoint {
  t: number;           // ms epoch
  equity: number;
  drawdownPct: number;
  /** Equity marked at the bar's LOW. Needed to recompute intrabar-accurate
   *  drawdown for a sub-window (in-sample vs out-of-sample segments). */
  low?: number;
}

/**
 * A position still open when the backtest window ended. Reported so the UI can
 * show the running trade instead of hiding it until it closes, and so the chart
 * can draw its live stop/target lines.
 *
 * Never counted in the summary metrics — those stay closed-trades-only, exactly
 * like TradingView's Strategy Tester.
 */
export interface OpenTrade {
  entryTime: number;
  entryPrice: number;
  qty: number;
  /** Working exit legs at the end of the run (null when the strategy set none). */
  stop: number | null;
  target: number | null;
  /** Last close in the tested range, used for the mark-to-market numbers. */
  lastPrice: number;
  lastTime: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  barsHeld: number;
}

/** TradingView Strategy-Tester-style summary metrics. */
export interface BacktestMetrics {
  netProfit: number;
  netProfitPct: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;  // null when there are no losing trades
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  maxDrawdownPct: number;
  avgTradePct: number;
  avgBarsInTrade: number;
  commissionPaid: number;
  /** Distinct ENTRIES in the window (one entry may close as several legs). */
  entries?: number;
  /** Leg-based win rate / profit factor, kept for reference. The headline
   *  winRatePct and profitFactor are ENTRY-based so they share a denominator
   *  with the reported trade count. */
  legWinRatePct?: number;
  legProfitFactor?: number | null;
  /** Entries where at least one leg exited on the stop (win or lose). */
  slEntries?: number;
  /** Entries stopped out where the stopped portion LOST money. */
  slLossEntries?: number;
  /** Entries stopped out where the stopped portion was PROFITABLE (a trailing
   *  or break-even stop doing its job). */
  slProfitEntries?: number;
  /** Entries where at least one leg exited on a take-profit. */
  tpEntries?: number;
  /** slEntries / entries, as a percentage (any stop fill). */
  slRatePct?: number;
  /** slLossEntries / entries — the "how often did I get stopped out" number. */
  slLossRatePct?: number;
  /** slProfitEntries / entries — stops that locked in a gain. */
  slProfitRatePct?: number;
  otherLossEntries?: number;
  otherLossRatePct?: number;
  /**
   * Position still open at the end of the run, or null/absent. Carried inside
   * the metrics JSONB so no schema migration is needed; it is NOT a metric and
   * never contributes to any figure above.
   */
  openTrade?: OpenTrade | null;
}

export interface BacktestRow {
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
  /** Engine/correction-set identity that produced the stored result. */
  engineFingerprint: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}
