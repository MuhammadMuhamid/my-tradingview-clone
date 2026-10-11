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
  /** Canonical economic identity from the market catalog migration. */
  canonicalId?: string | null;
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
  /*
   * The trade figures per ENTRY, beside the leg-based ones above.
   *
   * `totalTrades`, and on the HEADLINE `winRatePct` / `profitFactor`, count
   * exit LEGS — a partial take-profit closes one entry as several. A window's
   * `winRatePct` / `profitFactor` are ENTRY-based (the engine overwrites them)
   * while its `totalTrades` is still legs. These fields name the entry
   * population outright; runs recorded before they existed lack them, and
   * `lib/backtestFigures.ts` decides what such a row can honestly be shown as.
   */
  entries?: number;
  winningEntries?: number;
  losingEntries?: number;
  entryWinRatePct?: number;
  entryProfitFactor?: number | null;
  avgEntryPct?: number;
  avgBarsPerEntry?: number;
  legWinRatePct?: number;
  legProfitFactor?: number | null;
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
  /** Fraction frozen as the final holdout; null took the engine default. */
  holdoutFraction: number | null;
  /** The run's three windows, or the reason it cannot honestly have three. */
  segments: BacktestSegments | null;
  /** What actually ran, as against what was requested. */
  executionTruth: ExecutionTruth | null;
  /**
   * Set when this run answers one window of a stress analysis.
   *
   * A stress window is chosen with hindsight, so its result must never be shown
   * with the frozen-holdout split an ordinary run carries — they are opposite
   * kinds of evidence.
   */
  stressRunId: string | null;
  /** Engine / correction-set identity that produced the stored result. */
  engineFingerprint?: string | null;
  /** The full market, data and methodology envelope; null on historical rows. */
  resultProvenance?: Record<string, unknown> | null;
  /** Read-time label for how much of this result's meaning was recorded. */
  semanticsStatus?: "historical_unversioned" | "engine_only_legacy" | "reproducible";
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
}

/** One of the three windows a run divides into. */
export interface SegmentWindow { startMs: number; endMs: number }

/**
 * A run's development / validation / frozen-holdout scores.
 *
 * `available: false` is a real answer, not a missing field: a run that sizes
 * each entry as a percentage of equity compounds, so a later window's outcomes
 * depend on how the earlier one performed and scoring the windows separately
 * would produce numbers with no meaning. The reason says what to change.
 */
export type BacktestSegments =
  | {
      available: true;
      split: { inSample: SegmentWindow; outOfSample: SegmentWindow; holdout: SegmentWindow };
      inSample: BacktestMetrics;
      outOfSample: BacktestMetrics;
      holdout: BacktestMetrics;
      holdoutFraction: number;
    }
  | { available: false; reason: string };

export interface ExecutionTruth {
  requested: SegmentWindow;
  /** The window the simulated bars actually spanned, which may be narrower. */
  covered: SegmentWindow | null;
  barsProcessed: number;
  sizing: { mode: "fixed_cash" | "percent_of_equity"; value: number };
  fillTiming: "next_bar_open" | "signal_bar_close";
  /**
   * Why this configuration could take no trade at all.
   *
   * "0 trades" is ambiguous in the worst way — a strategy whose entry
   * conditions can never be met reads exactly like one that was given a fair
   * chance and declined. Present only when the strategy itself can say which
   * it was.
   */
  noEntryReason?: string;
}

/** One adverse period, and the benchmark statistics that selected it. */
export interface StressWindow {
  rank: number;
  startMs: number;
  endMs: number;
  bars: number;
  benchmarkReturnPct: number;
  benchmarkDrawdownPct: number;
  benchmarkVolatilityPct: number;
  selectedBy: { metric: StressMethod; value: number };
  label?: string;
}

export type StressMethod =
  | "worst_return" | "deepest_drawdown" | "highest_volatility" | "manual";

export interface StressDiscovery {
  /** v2 measures return and drawdown from the window's first open; v1 from its first close. */
  schemaVersion: "stress-discovery.v1" | "stress-discovery.v2";
  benchmark: {
    symbol: string; canonicalInstrument: string | null; interval: Interval;
    providerId: string; feedId: string;
  };
  searched: { startMs: number; endMs: number; bars: number };
  config: {
    method: StressMethod; lengthBars: number; topN: number;
    minSeparationBars: number;
    manualWindows?: { startMs: number; endMs: number; label?: string }[];
  };
  epistemicNote: string;
}

export interface StressRun {
  id: string;
  strategyId: number;
  symbol: string;
  timeframe: Interval;
  /** The saved configuration this ran, when it ran one. */
  configId: string | null;
  /** The parameters it ran. Empty means the strategy's own defaults. */
  params: Record<string, number | string | boolean>;
  /** The capital and cost model every window ran under. */
  initialCapital: number;
  commissionPct: number;
  slippageTicks: number;
  benchmarkSymbol: string;
  benchmarkInterval: Interval;
  discovery: StressDiscovery;
  windows: (StressWindow & { backtestId: string })[];
  status: "running" | "done" | "error";
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/**
 * What the TRADED symbol itself did over a window: buy-and-hold from the
 * window's first open to its last close. Null until the store holds its bars.
 */
export interface StressTargetReturn {
  returnPct: number;
  /** The span actually measured, which may be narrower than the window. */
  startMs: number;
  endMs: number;
  /** False when the traded symbol's history covers only part of the window. */
  complete: boolean;
}

export interface StressRunDetail extends StressRun {
  results: {
    window: StressWindow & { backtestId: string };
    backtest: Backtest | null;
    /** Absent on a server that predates it; null when there is no figure. */
    target?: StressTargetReturn | null;
  }[];
  epistemicNote: string;
}

/** The benchmark's closes over the searched period, thinned for a chart: [openTime, close]. */
export type StressBenchmarkPath = [number, number][];

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
