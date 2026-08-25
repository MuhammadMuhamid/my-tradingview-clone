/**
 * Backtest orchestration: resolve params → ensure data (chart + every MTF/BTC
 * feed with warmup) → run the strategy bar loop → persist trades/metrics.
 */
import type { BacktestRow } from "../types/backtest";
import * as candleRepo from "../repositories/candles";
import * as symbolRepo from "../repositories/symbols";
import * as strategyRepo from "../repositories/strategies";
import { ensureCandles, syncExchangeFilters } from "../data/binanceRest";
import { FeedStore, subBarsFor, toBars, type Bars } from "./mtf";
import { computeMetrics, downsampleEquity, toTradeRecords } from "./metrics";
import { ACTIVE_CORRECTIONS, correctionsFingerprint, describeCorrections } from "./corrections";
import { maRrV9Module } from "./strategies/ma_rr_v9";
import { srTrendV10Module } from "./strategies/srtrend_v10";
import { mtfLeanModule } from "./strategies/mtf_lean";
import type { TradeRecord, BacktestMetrics, EquityPoint, OpenTrade } from "../types/backtest";
import { INTERVAL_MS, type Interval } from "../types/market";

/*
 * BE-19: `mtf_lean` was absent from this registry, so the strategy actually
 * deployed with real money had no in-platform backtest path at all — and
 * BE-01/BE-02 therefore could not be checked through the supported route. Its
 * `warmupMs` signature was the blocker; it now matches the others.
 */
const MODULES: Record<string, unknown> = {
  [maRrV9Module.key]: maRrV9Module,
  [srTrendV10Module.key]: srTrendV10Module,
  [mtfLeanModule.key]: mtfLeanModule,
};

export interface BacktestOutput {
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  trades: TradeRecord[];
  /** Position still running when the window ended, or null. */
  openTrade: OpenTrade | null;
  /**
   * Which engine produced this result.
   *
   * A stored number that does not say which engine produced it is exactly how
   * the cost-model confusion in `X-09` became unresolvable, so every result
   * carries its correction set.
   */
  engine: string;
  /** Exit legs the exchange filters refused, when `exchangeFilters` is on. */
  rejectedLegs: { bar: number; id: string; qty: number; reason: string }[];
}

/** The finest already-loaded feed strictly below `chartTf`, or null. */
function finestLoadedFeedBelow(
  feeds: FeedStore,
  symbol: string,
  chartTf: Interval,
  needs: readonly { symbol: string | null; interval: Interval }[]
): Bars | null {
  const chartMs = INTERVAL_MS[chartTf];
  let best: Bars | null = null;
  for (const need of needs) {
    if (need.symbol !== null && need.symbol !== symbol) continue;
    if (INTERVAL_MS[need.interval] >= chartMs) continue;
    if (!feeds.has(symbol, need.interval)) continue;
    const bars = feeds.get(symbol, need.interval);
    if (best === null || INTERVAL_MS[need.interval] < INTERVAL_MS[best.interval]) best = bars;
  }
  return best;
}

export async function executeBacktest(
  row: BacktestRow,
  log: (msg: string) => void = () => {}
): Promise<BacktestOutput> {
  const strategy = await strategyRepo.getStrategyById(row.strategyId);
  if (!strategy) throw new Error(`strategy id ${row.strategyId} not found`);
  // Strategy modules share the same runtime contract but have distinct resolved
  // parameter types; keep dispatch dynamic at this registry boundary.
  const module = MODULES[strategy.key] as typeof maRrV9Module;
  if (!module) throw new Error(`no engine module registered for strategy '${strategy.key}'`);

  const params = module.resolveParams(row.params);
  const startMs = new Date(row.startTime).getTime();
  const endMs = new Date(row.endTime).getTime();

  // Tick size (Pine syminfo.mintick) — required for slippage.
  let symbolInfo = await symbolRepo.getSymbol(row.symbol);
  if (!symbolInfo) throw new Error(`unknown symbol ${row.symbol}`);
  if (!symbolInfo.priceTick) {
    log(`syncing exchange filters for ${row.symbol}`);
    await syncExchangeFilters([row.symbol]);
    symbolInfo = await symbolRepo.getSymbol(row.symbol);
  }
  const tickSize = symbolInfo?.priceTick;
  if (!tickSize || tickSize <= 0) {
    throw new Error(`no tick size available for ${row.symbol}`);
  }

  // Data: every required (symbol, interval) feed, warmup included.
  const needs = module.requiredFeeds(params, row.timeframe);
  // BE-19: `mtf_lean` sizes its warmup per feed like the others now, so this
  // loop is uniform across the registry.
  const feeds = new FeedStore();
  for (const need of needs) {
    const symbol = need.symbol ?? row.symbol;
    if (need.symbol && !(await symbolRepo.getSymbol(need.symbol))) {
      // e.g. BTCUSDT for the BTC filter on a coin that isn't tracked yet
      await symbolRepo.addSymbol(need.symbol, need.symbol.replace(/USDT$/, ""), "USDT");
    }
    const from = startMs - module.warmupMs(need);
    await ensureCandles(symbol, need.interval, from, endMs, log);
    const candles = await candleRepo.getCandles(symbol, need.interval, { from, to: endMs });
    if (candles.length === 0) throw new Error(`no ${need.interval} data for ${symbol}`);
    feeds.set(toBars(candles));
  }

  log(`running ${strategy.key} on ${row.symbol} ${row.timeframe}`);
  /**
   * The finest loaded feed below the chart timeframe, if any. Chosen rather
   * than fetched: adding a feed the strategy did not ask for would change what
   * `ensureCandles` downloads, and a magnifier is a refinement of an existing
   * run, not a new data dependency.
   */
  const magnifierFeed = ACTIVE_CORRECTIONS.barMagnifier
    ? finestLoadedFeedBelow(feeds, row.symbol, row.timeframe, needs)
    : null;
  if (ACTIVE_CORRECTIONS.barMagnifier) {
    log(magnifierFeed
      ? `bar magnifier: resolving intrabar order with the ${magnifierFeed.interval} feed`
      : "bar magnifier is ON but no feed finer than the chart is loaded — "
        + "intrabar order falls back to the open/close heuristic");
  }

  const result = module.runBars(feeds, row.symbol, row.timeframe, params, {
    initialCapital: row.initialCapital,
    commissionPct: row.commissionPct,
    slippageTicks: row.slippageTicks,
    tickSize,
    qtyCash: Number(params.qty_cash),
    qtyPctEquity: Number(params.qty_pct_equity ?? 0),
    // BE-07: the exchange filters are already stored on the symbol row and were
    // read by nothing. They apply only when `exchangeFilters` is on.
    qtyStep: symbolInfo?.qtyStep ?? 0,
    minNotional: symbolInfo?.minNotional ?? 0,
    fillOnBarClose: Boolean(params.fill_bar_close ?? false),
    /*
     * Bar magnifier: when the correction is on AND a finer feed than the chart
     * happens to be loaded (several strategies already request a 1m or 5m
     * feed), the broker walks the actual sub-bar path instead of guessing
     * which of a stop and a target filled first. With no finer feed this is
     * undefined and the behaviour is unchanged.
     */
    ...(magnifierFeed
      ? { magnifier: (chartBars: Bars, i: number) => subBarsFor(chartBars, magnifierFeed, i) }
      : {}),
  }, { startMs, endMs });

  const metrics = computeMetrics(
    result.broker.closed,
    result.equityCurve,
    row.initialCapital,
    result.broker.commissionPaid,
    ACTIVE_CORRECTIONS
  );
  const trades = toTradeRecords(result.broker.closed);

  // A position still open at the end of the window: report it as a running
  // trade rather than dropping it. Metrics stay closed-trades-only.
  const broker = result.broker;
  let openTrade: OpenTrade | null = null;
  if (broker.positionQty > 0) {
    const chart = feeds.get(row.symbol, row.timeframe);
    let last = chart.length - 1;
    while (last > 0 && chart.time[last]! > endMs) last--;
    const lastPrice = chart.close[last] ?? broker.avgPrice;
    const lastTime = chart.time[last] ?? broker.entryTime;
    // Working legs are the OCO pair the strategy last issued for this position.
    const leg = broker.workingLegs[0];
    const unrealizedPnl = (lastPrice - broker.avgPrice) * broker.positionQty;
    openTrade = {
      entryTime: broker.entryTime,
      entryPrice: broker.avgPrice,
      qty: broker.positionQty,
      stop: leg && Number.isFinite(leg.stop) ? leg.stop : null,
      target: leg && Number.isFinite(leg.limit) ? leg.limit : null,
      lastPrice,
      lastTime,
      unrealizedPnl,
      unrealizedPnlPct: broker.avgPrice !== 0
        ? ((lastPrice - broker.avgPrice) / broker.avgPrice) * 100 : 0,
      barsHeld: Math.max(0, last - broker.entryBar),
    };
    metrics.openTrade = openTrade;
    // Surfaced in the trade list as the final row, exit fields left null.
    trades.push({
      tradeNo: trades.length + 1,
      direction: "long",
      entryTime: broker.entryTime,
      entryPrice: broker.avgPrice,
      exitTime: null,
      exitPrice: null,
      qty: broker.positionQty,
      pnl: null,
      pnlPct: null,
      exitReason: null,
      runUpPct: null,
      drawdownPct: null,
      cumProfit: null,
    });
    log(`open position: ${broker.positionQty} @ ${broker.avgPrice} ` +
      `(unrealized ${openTrade.unrealizedPnlPct.toFixed(2)}%)`);
  }

  log(`done: ${metrics.totalTrades} trades, net ${metrics.netProfitPct.toFixed(2)}%`);
  const rejectedLegs = (result.broker as { rejectedLegs?: BacktestOutput["rejectedLegs"] })
    .rejectedLegs ?? [];
  if (rejectedLegs.length > 0) {
    log(
      `${rejectedLegs.length} exit leg(s) refused by the exchange filters — ` +
      "the position stayed open on those bars (BE-07)"
    );
  }
  log(describeCorrections(ACTIVE_CORRECTIONS));

  return {
    metrics,
    equityCurve: downsampleEquity(result.equityCurve),
    trades,
    openTrade,
    engine: correctionsFingerprint(ACTIVE_CORRECTIONS),
    rejectedLegs,
  };
}
