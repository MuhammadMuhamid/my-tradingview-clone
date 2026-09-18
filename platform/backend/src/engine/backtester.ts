/**
 * Backtest orchestration: resolve params → ensure data (chart + every MTF/BTC
 * feed with warmup) → run the strategy bar loop → persist trades/metrics.
 */
import type { BacktestRow } from "../types/backtest";
import type { StrategyParams } from "../types/strategy";
import * as candleRepo from "../repositories/candles";
import * as symbolRepo from "../repositories/symbols";
import { registerInstrument } from "../data/instrumentRegistration";
import * as strategyRepo from "../repositories/strategies";
import { ensureCandles, syncExchangeFilters } from "../data/binanceRest";
import { assertNoInternalCandleGaps } from "../data/candleSeries";
import { FeedStore, subBarsFor, toBars, type Bars } from "./mtf";
import { computeMetrics, computeSegmentMetrics, downsampleEquity, toTradeRecords } from "./metrics";
import { splitWindows, type WindowSplit } from "./holdout";
import { ACTIVE_CORRECTIONS, assertCorrectedEngine, correctionsFingerprint, describeCorrections } from "./corrections";
import { maRrV9Module } from "./strategies/ma_rr_v9";
import { srTrendV10Module } from "./strategies/srtrend_v10";
import { mtfLeanModule } from "./strategies/mtf_lean";
import type { TradeRecord, BacktestMetrics, EquityPoint, OpenTrade } from "../types/backtest";
import { resolutionMs } from "../data/resolution";
import { INTERVAL_MS, type Interval } from "../types/market";
import { canonicalInstrumentId } from "../market/model";

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
  /** Full market/data/methodology meaning for every new corrected result. */
  provenance: Record<string, unknown>;
  /** Exit legs the exchange filters refused, when `exchangeFilters` is on. */
  rejectedLegs: { bar: number; id: string; qty: number; reason: string }[];
  /** IS / OOS / frozen-holdout scores, or why this run cannot honestly split. */
  segments: BacktestSegments;
  /** What actually ran, as against what was asked for. */
  executionTruth: ExecutionTruth;
}

/**
 * The three windows of one run, scored separately.
 *
 * `splitWindows` and `computeSegmentMetrics` have been in this engine, tested,
 * since the holdout work — with no production caller, so no surface could show
 * a user where their development data ended and their validation data began. A
 * run is one contiguous simulation either way; what this adds is the honest
 * division of it, and the refusal to pretend to one where it would mean
 * nothing.
 *
 * The holdout is FROZEN: it is reported and never selected on. That is a
 * property of how it is used, not of this record, and it is why the record
 * names it rather than calling it a second out-of-sample.
 */
export type BacktestSegments =
  | {
      available: true;
      /** The window each segment covers, so the dates are never inferred. */
      split: WindowSplit;
      inSample: BacktestMetrics;
      outOfSample: BacktestMetrics;
      holdout: BacktestMetrics;
      holdoutFraction: number;
    }
  | { available: false; reason: string };

/** What actually ran — the answer to "is this number about the window I asked for?" */
export interface ExecutionTruth {
  requested: { startMs: number; endMs: number };
  /** The window the simulated bars actually spanned, which may be narrower. */
  covered: { startMs: number; endMs: number } | null;
  barsProcessed: number;
  /**
   * Fixed cash, or a percentage of equity that compounds. The two are not
   * comparable and two product surfaces defaulted to different ones.
   */
  sizing: { mode: "fixed_cash" | "percent_of_equity"; value: number };
  /**
   * When an entry fills. `next_bar_open` is the default; `signal_bar_close` is
   * TradingView's `process_orders_on_close` and assumes zero latency — one
   * shipped strategy defaults to each, which made cross-strategy comparison on
   * one chart quietly not like-for-like.
   */
  fillTiming: "next_bar_open" | "signal_bar_close";
  /**
   * Why this configuration could take no trade, when that is a property of the
   * configuration rather than of the market.
   *
   * A run reporting "0 trades" is ambiguous in the worst way: a strategy whose
   * entry conditions can never be met looks exactly like one that was given a
   * fair chance and declined. Only set when the strategy itself can say so, and
   * only when the run did in fact take nothing.
   */
  noEntryReason?: string;
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
    if (best === null || INTERVAL_MS[need.interval] < resolutionMs(best.interval)) best = bars;
  }
  return best;
}

export async function executeBacktest(
  row: BacktestRow,
  log: (msg: string) => void = () => {}
): Promise<BacktestOutput> {
  // Legacy and partially corrected variants remain reproducible in focused
  // pure tests, but production backtests/optimizers may only create corrected
  // results. Existing rows retain their original fingerprint unchanged.
  assertCorrectedEngine(ACTIVE_CORRECTIONS);
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
  if (!symbolInfo) throw new Error(`symbol ${row.symbol} disappeared while syncing filters`);
  const resolvedSymbolInfo = symbolInfo;

  // Data: every required (symbol, interval) feed, warmup included.
  const needs = module.requiredFeeds(params, row.timeframe);
  // BE-19: `mtf_lean` sizes its warmup per feed like the others now, so this
  // loop is uniform across the registry.
  const feeds = new FeedStore();
  for (const need of needs) {
    const symbol = need.symbol ?? row.symbol;
    if (need.symbol) {
      // e.g. BTCUSDT for the BTC filter on a coin that isn't tracked yet. The
      // assets come from the venue's own metadata; the suffix split survives
      // only as a fallback when the directory is unreachable, so a backtest
      // does not fail because `exchangeInfo` blipped. See
      // `data/instrumentRegistration`.
      await registerInstrument(need.symbol, log);
    }
    const from = startMs - module.warmupMs(need);
    await ensureCandles(symbol, need.interval, from, endMs, log);
    const candles = await candleRepo.getCandles(symbol, need.interval, { from, to: endMs });
    if (candles.length === 0) throw new Error(`no ${need.interval} data for ${symbol}`);
    // Boundaries may be partial because a pair was newly listed or the cache
    // begins inside the requested warmup. A hole between two present candles
    // is never partial coverage: toBars would compress it into one bar step.
    assertNoInternalCandleGaps(candles, need.interval, `${symbol} ${need.interval}`);
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

  /*
   * ── What actually ran, and how it divides ────────────────────────────────
   *
   * Boundary coverage is legitimately partial — `ensureCandles` above permits
   * a window that begins inside the requested one because the pair was listed
   * later or the cache starts further in — and `barsProcessed` was computed by
   * every strategy and thrown away here. So a result could report a confident
   * figure over a window a third of which had no data, printed against the
   * REQUESTED dates. It reports the covered window now, beside the requested
   * one, and never instead of it.
   */
  const qtyPctEquity = Number(params.qty_pct_equity ?? 0);
  const coveredCurve = result.equityCurve;
  const covered = coveredCurve.length > 0
    ? { startMs: coveredCurve[0]!.t, endMs: coveredCurve[coveredCurve.length - 1]!.t }
    : null;
  const executionTruth: ExecutionTruth = {
    requested: { startMs, endMs },
    covered,
    barsProcessed: result.barsProcessed,
    sizing: qtyPctEquity > 0
      ? { mode: "percent_of_equity", value: qtyPctEquity }
      : { mode: "fixed_cash", value: Number(params.qty_cash) },
    fillTiming: params.fill_bar_close ? "signal_bar_close" : "next_bar_open",
  };
  /*
   * Asked only when the run took nothing, so a strategy that traded is never
   * second-guessed, and only of a module that can answer — the others simply
   * do not implement it and say nothing rather than guessing.
   */
  if (metrics.totalTrades === 0) {
    const explain = (module as { explainNoEntries?: (p: StrategyParams) => string | null })
      .explainNoEntries;
    const reason = explain ? explain(row.params) : null;
    if (reason) executionTruth.noEntryReason = reason;
  }

  /*
   * The split is taken over the window that was SIMULATED, not the one that
   * was asked for: carving a holdout out of dates the run never reached would
   * hand back three windows two of which are empty.
   *
   * It is refused rather than approximated when the run compounds.
   * `computeSegmentMetrics` throws on that by design — under
   * percent-of-equity sizing a later segment's outcomes depend on how the
   * earlier one performed, so rebasing each segment to the initial capital
   * produces a number with no interpretation. Saying so is the honest result;
   * a plausible-looking number would be the dishonest one.
   */
  const segments = computeSegments(
    covered, result.broker.closed, result.equityCurve,
    row.initialCapital, qtyPctEquity, row.holdoutFraction,
  );

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
    provenance: {
      schemaVersion: "backtest-provenance.v1",
      engineVersion: "v2-corrected",
      engineFingerprint: correctionsFingerprint(ACTIVE_CORRECTIONS),
      canonicalInstrument: canonicalInstrumentId({
        venueId: "BINANCE", instrumentType: "spot", baseAsset: resolvedSymbolInfo.baseAsset,
        quoteAsset: resolvedSymbolInfo.quoteAsset, settlementAsset: resolvedSymbolInfo.quoteAsset, series: { kind: "spot" },
      }),
      assetClass: "crypto",
      providerId: "binance-spot",
      feedId: "binance-public-klines",
      priceBasis: { execution: "last", valuation: "last" },
      sessionMode: "continuous-24x7",
      adjustmentMode: "not_applicable",
      costs: { commissionPct: row.commissionPct, slippageTicks: row.slippageTicks, tickSize },
      fundingMethodology: "not_applicable",
      rolloverMethodology: "not_applicable",
      rollMethodology: "not_applicable",
      margin: { model: "cash", leverage: 1, position: "long_only" },
      dataCompleteness: "internal_gaps_rejected; incomplete_live_bars_not_persisted",
    },
    rejectedLegs,
    segments,
    executionTruth,
  };
}

/** The three-window division of a finished run, or the reason there is none. */
function computeSegments(
  covered: { startMs: number; endMs: number } | null,
  closed: Parameters<typeof computeSegmentMetrics>[0],
  equityCurve: EquityPoint[],
  initialCapital: number,
  qtyPctEquity: number,
  holdoutFraction: number | null | undefined,
): BacktestSegments {
  if (covered === null) {
    return { available: false, reason: "This run simulated no bars, so it has no window to divide." };
  }
  if (qtyPctEquity > 0) {
    return {
      available: false,
      reason: "This run sizes each entry as a percentage of equity, so it compounds: "
        + "a later window's outcomes depend on how the earlier one performed, and scoring "
        + "the windows separately would produce numbers with no meaning. Re-run with a "
        + "fixed cash size to see the in-sample, out-of-sample and holdout split.",
    };
  }
  const fraction = holdoutFraction ?? undefined;
  let split: WindowSplit;
  try {
    split = splitWindows(covered, fraction === undefined ? {} : { holdoutFraction: fraction });
  } catch (error) {
    return { available: false, reason: (error as Error).message };
  }
  const score = (w: { startMs: number; endMs: number }): BacktestMetrics => computeSegmentMetrics(
    closed, equityCurve, initialCapital, w.startMs, w.endMs, { qtyPctEquity },
  );
  return {
    available: true,
    split,
    inSample: score(split.inSample),
    outOfSample: score(split.outOfSample),
    holdout: score(split.holdout),
    holdoutFraction: fraction ?? 0.2,
  };
}
