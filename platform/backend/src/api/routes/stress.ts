/**
 * Stress-regime analysis routes.
 *
 * Two things happen here and they are deliberately separate:
 *
 *   `POST /api/stress/windows` DISCOVERS adverse windows from a benchmark's
 *   market data. It is cheap, it names no strategy, and it can be run on its
 *   own — which is the point. A user should be able to ask "when was BTC at
 *   its worst?" and get an answer that has nothing to do with any strategy,
 *   because that independence is what makes the subsequent analysis mean
 *   anything.
 *
 *   `POST /api/stress/runs` discovers the same windows and then queues ONE
 *   ORDINARY BACKTEST PER WINDOW. Stress analysis adds no execution path: the
 *   per-window runs go through the same engine, the same correction set, the
 *   same warmup and the same no-lookahead guarantees as any other backtest,
 *   claimed by the same worker. If they did not, their numbers could not be
 *   compared with the development and holdout numbers they exist to be
 *   compared against.
 */
import type { FastifyInstance } from "fastify";
import * as backtests from "../../repositories/backtests";
import * as stressRepo from "../../repositories/stress";
import * as strategies from "../../repositories/strategies";
import * as symbols from "../../repositories/symbols";
import * as candleRepo from "../../repositories/candles";
import { ensureCandles } from "../../data/binanceRest";
import {
  benchmarkPath, discoverStressWindows, StressDiscoveryError, stressProvenance,
  STRESS_EPISTEMIC_NOTE, validateStressConfig, type StressMethod, type StressWindowConfig,
} from "../../engine/stress";
import { targetReturn, type TargetReturn } from "../../engine/stressTarget";
import { isUuid, parseStressRunSettings } from "./stressRequest";
import { sizingProblem } from "../backtestRequest";
import { engineDefaultParams } from "../../engine/backtester";
import { INTERVAL_MS, isInterval, type Interval } from "../../types/market";
import {
  DEFAULT_COMMISSION_PCT, DEFAULT_INITIAL_CAPITAL, DEFAULT_SLIPPAGE_TICKS,
} from "./backtests";
import { canonicalInstrumentId } from "../../market/model";
import type { StrategyParams } from "../../types/strategy";

const METHODS: readonly StressMethod[] = [
  "worst_return", "deepest_drawdown", "highest_volatility", "manual",
];

/**
 * The benchmarks this install can honestly offer.
 *
 * ── Why this is a list and not a free-text field ──────────────────────────
 *
 * A stress benchmark has to be a series this product actually has, at a
 * provider it can name. Anything else produces a report whose windows cannot
 * be regenerated and whose "worst week" is unverifiable.
 *
 * The owner is also interested in broad-market stress — an S&P 500 drawdown,
 * say. This install has no trustworthy historical provider for that, and the
 * honest answer is to say so rather than to scrape something and call it a
 * benchmark. So the shape here is an ABSTRACTION with one supported kind: any
 * instrument whose candles this install stores. A broad-market feed becomes a
 * second kind behind the same interface, with its own provider identity in the
 * provenance, and changes nothing about discovery — which reads candles and
 * knows nothing about where they came from.
 */
interface BenchmarkResolution {
  symbol: string;
  canonicalInstrument: string | null;
  providerId: string;
  feedId: string;
}

async function resolveBenchmark(symbol: string): Promise<BenchmarkResolution | null> {
  const info = await symbols.getSymbol(symbol);
  if (!info) return null;
  return {
    symbol: info.symbol,
    canonicalInstrument: canonicalInstrumentId({
      venueId: "BINANCE", instrumentType: "spot", baseAsset: info.baseAsset,
      quoteAsset: info.quoteAsset, settlementAsset: info.quoteAsset, series: { kind: "spot" },
    }),
    providerId: "binance-spot",
    feedId: "binance-public-klines",
  };
}

interface DiscoveryBody {
  benchmarkSymbol?: string;
  benchmarkInterval?: string;
  startTime?: string | number;
  endTime?: string | number;
  method?: string;
  lengthBars?: number;
  topN?: number;
  minSeparationBars?: number;
  manualWindows?: { startMs?: number; endMs?: number; label?: string }[];
}

/** Everything both routes need, or the reply that says why they cannot have it. */
async function prepareDiscovery(body: DiscoveryBody): Promise<
  | { ok: false; code: number; error: string }
  | {
      ok: true;
      benchmark: BenchmarkResolution;
      interval: Interval;
      config: StressWindowConfig;
      startMs: number;
      endMs: number;
    }
> {
  const benchmarkSymbol = (body.benchmarkSymbol ?? "").toUpperCase();
  if (!benchmarkSymbol) return { ok: false, code: 400, error: "benchmarkSymbol is required" };
  const benchmark = await resolveBenchmark(benchmarkSymbol);
  if (!benchmark) {
    return {
      ok: false, code: 404,
      error: `this install has no market data for ${benchmarkSymbol}, so it cannot say when `
        + "that market was at its worst. Choose an instrument the product tracks.",
    };
  }
  const interval = body.benchmarkInterval ?? "";
  if (!isInterval(interval)) {
    return { ok: false, code: 400, error: `invalid benchmarkInterval: ${interval}` };
  }
  const method = body.method ?? "";
  if (!METHODS.includes(method as StressMethod)) {
    return {
      ok: false, code: 400,
      error: `method must be one of ${METHODS.join(", ")}`,
    };
  }
  const startMs = new Date(body.startTime ?? NaN).getTime();
  const endMs = new Date(body.endTime ?? NaN).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    return {
      ok: false, code: 400,
      error: "startTime and endTime must be valid dates with startTime < endTime",
    };
  }

  if (!Array.isArray(body.manualWindows ?? [])) {
    return { ok: false, code: 400, error: "manualWindows must be a list" };
  }
  const manualWindows = (body.manualWindows ?? []).map((w) => ({
    startMs: Number(w.startMs), endMs: Number(w.endMs),
    ...(w.label === undefined ? {} : { label: String(w.label) }),
  }));
  const config: StressWindowConfig = {
    method: method as StressMethod,
    lengthBars: Number(body.lengthBars),
    topN: Number(body.topN),
    ...(body.minSeparationBars === undefined
      ? {} : { minSeparationBars: Number(body.minSeparationBars) }),
    ...(manualWindows.length === 0 ? {} : { manualWindows }),
  };
  /*
   * Refused HERE, before `ensureCandles`, and not only inside discovery: an
   * oversized request used to download and read every minute bar of the
   * period first and only then learn it could not be answered. The number of
   * positions is estimated from the period, which is what the search would
   * read if the store held every bar.
   */
  try {
    validateStressConfig(config,
      Math.max(0, Math.floor((endMs - startMs) / INTERVAL_MS[interval]) - config.lengthBars + 1));
  } catch (error) {
    if (error instanceof StressDiscoveryError) return { ok: false, code: 400, error: error.message };
    throw error;
  }
  return { ok: true, benchmark, interval, startMs, endMs, config };
}

export async function stressRoutes(app: FastifyInstance): Promise<void> {
  /** The benchmark's worst windows. No strategy is named, or can be. */
  app.post("/api/stress/windows", async (req, reply) => {
    const prepared = await prepareDiscovery(req.body as DiscoveryBody);
    if (!prepared.ok) return reply.code(prepared.code).send({ error: prepared.error });
    const { benchmark, interval, config, startMs, endMs } = prepared;

    await ensureCandles(benchmark.symbol, interval, startMs, endMs,
      (msg) => req.log.info({ benchmark: benchmark.symbol }, msg));
    const candles = await candleRepo.getCandles(
      benchmark.symbol, interval, { from: startMs, to: endMs });

    try {
      const windows = discoverStressWindows(candles, config);
      return {
        windows,
        discovery: stressProvenance(
          { ...benchmark, interval }, candles, config),
        // The searched period to draw the windows over; the candles are in hand.
        path: benchmarkPath(candles),
        epistemicNote: STRESS_EPISTEMIC_NOTE,
      };
    } catch (error) {
      if (error instanceof StressDiscoveryError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  /**
   * Run a strategy through the benchmark's worst windows.
   *
   * The windows are discovered first and the strategy is queued second, in
   * that order, with no path between them: nothing about the strategy is
   * available while the windows are being chosen. That ordering is the whole
   * scientific content of the feature.
   */
  app.post("/api/stress/runs", async (req, reply) => {
    const body = (req.body ?? {}) as DiscoveryBody & Record<string, unknown>;

    const prepared = await prepareDiscovery(body);
    if (!prepared.ok) return reply.code(prepared.code).send({ error: prepared.error });
    const { benchmark, interval, config, startMs, endMs } = prepared;

    /*
     * The run's own settings — a finished backtest's parameters, capital and
     * costs when the page was opened from one — are checked here, as the
     * request's shape. They cannot reach discovery: `discoverStressWindows`
     * has already been handed everything it will ever see, by `prepared`.
     */
    const parsed = parseStressRunSettings(body);
    if (!parsed.ok) return reply.code(parsed.code).send({ error: parsed.error });
    const settings = parsed.value;

    const strategy = await strategies.getStrategyByKey(settings.strategyKey);
    if (!strategy) return reply.code(404).send({ error: "strategy not found" });

    let baseParams: StrategyParams = {};
    let symbol = settings.symbol;
    let timeframe = settings.timeframe;
    if (settings.configId) {
      const config_ = await strategies.getConfig(settings.configId);
      if (!config_) return reply.code(404).send({ error: "config not found" });
      baseParams = config_.params;
      symbol = symbol ?? config_.symbol ?? undefined;
      timeframe = timeframe ?? config_.timeframe;
    }
    if (!symbol) return reply.code(400).send({ error: "symbol is required" });
    if (!(await symbols.getSymbol(symbol))) {
      return reply.code(404).send({ error: `unknown symbol: ${symbol}` });
    }
    if (!timeframe || !isInterval(timeframe)) {
      return reply.code(400).send({ error: `invalid timeframe: ${timeframe}` });
    }
    /*
     * C-01: an order size the account cannot pay for, refused once rather
     * than queued as up to ten runs that each skip every entry. Judged on the
     * strategy's settings alone — discovery has already been handed all it
     * will ever see.
     */
    const sized = sizingProblem(
      { ...baseParams, ...settings.params },
      settings.initialCapital ?? DEFAULT_INITIAL_CAPITAL,
      engineDefaultParams(settings.strategyKey));
    if (sized) return reply.code(400).send({ error: sized });

    await ensureCandles(benchmark.symbol, interval, startMs, endMs,
      (msg) => req.log.info({ benchmark: benchmark.symbol }, msg));
    const candles = await candleRepo.getCandles(
      benchmark.symbol, interval, { from: startMs, to: endMs });

    let discovered;
    try {
      discovered = discoverStressWindows(candles, config);
    } catch (error) {
      if (error instanceof StressDiscoveryError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
    if (discovered.length === 0) {
      return reply.code(400).send({
        error: "no stress window was found in this benchmark period. Widen the period, "
          + "shorten the window, or reduce the separation.",
      });
    }

    const params = { ...baseParams, ...settings.params };
    const initialCapital = settings.initialCapital ?? DEFAULT_INITIAL_CAPITAL;
    const commissionPct = settings.commissionPct ?? DEFAULT_COMMISSION_PCT;
    const slippageTicks = settings.slippageTicks ?? DEFAULT_SLIPPAGE_TICKS;
    /*
     * The coordinator row is created FIRST, empty, so each child can carry its
     * id. Without it a stress window's run is indistinguishable from an
     * ordinary backtest, and the result page rendered its frozen-holdout split
     * over a slice of a hand-picked crash — the exact conflation the top of
     * `engine/stress.ts` forbids.
     */
    const coordinator = await stressRepo.createStressRun({
      strategyId: strategy.id,
      configId: settings.configId ?? null,
      symbol, timeframe, params,
      initialCapital, commissionPct, slippageTicks,
      benchmarkSymbol: benchmark.symbol,
      benchmarkInterval: interval,
      discovery: stressProvenance({ ...benchmark, interval }, candles, config),
      windows: [],
    });
    const windows: stressRepo.StressRunWindow[] = [];
    for (const window of discovered) {
      const run = await backtests.createBacktest({
        stressRunId: coordinator.id,
        strategyId: strategy.id,
        configId: settings.configId,
        symbol, timeframe,
        startTime: window.startMs,
        endTime: window.endMs,
        params,
        initialCapital, commissionPct, slippageTicks,
      });
      windows.push({ ...window, backtestId: run.id });
    }
    const created = await stressRepo.attachStressWindows(coordinator.id, windows);
    return reply.code(201).send(created);
  });

  /*
   * Previous runs, SETTLED. A coordinator's status is only ever moved by
   * `settleStressRun`, and only `GET /:id` called it — so the list kept
   * saying "Running" about runs whose every window had finished, until
   * someone happened to open each one.
   */
  app.get("/api/stress/runs", async () => {
    const rows = await stressRepo.listStressRuns();
    return Promise.all(rows.map((row) => stressRepo.settleStressRun(row)));
  });

  /** A stress run, its windows, and whatever the worker has made of them. */
  app.get("/api/stress/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Not a uuid cannot name a row; asking Postgres anyway was a 500.
    if (!isUuid(id)) return reply.code(404).send({ error: "stress run not found" });
    const found = await stressRepo.getStressRun(id);
    if (!found) return reply.code(404).send({ error: "stress run not found" });
    const run = await stressRepo.settleStressRun(found);
    const children = await stressRepo.stressRunBacktests(run);
    const targets = await Promise.all(
      run.windows.map((window) => tradedBuyAndHold(run.symbol, run.timeframe, window)));
    return {
      ...run,
      results: run.windows.map((window, i) => ({
        window,
        backtest: children.get(window.backtestId) ?? null,
        target: targets[i] ?? null,
      })),
      epistemicNote: STRESS_EPISTEMIC_NOTE,
    };
  });

  /**
   * The benchmark over the period discovery searched, thinned for a chart.
   *
   * Its own route rather than a field on `GET /:id`, which the page polls
   * while windows run: this is read once per opened run.
   */
  app.get("/api/stress/runs/:id/benchmark", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "stress run not found" });
    const run = await stressRepo.getStressRun(id);
    if (!run) return reply.code(404).send({ error: "stress run not found" });
    const { benchmark, searched } = run.discovery;
    const candles = await candleRepo.getCandles(
      benchmark.symbol, benchmark.interval, { from: searched.startMs, to: searched.endMs });
    return { symbol: benchmark.symbol, interval: benchmark.interval, path: benchmarkPath(candles) };
  });
}

/**
 * The traded symbol's own buy-and-hold over one window.
 *
 * Two indexed reads — the first bar opening in the window and the last bar
 * CLOSING in it — rather than the window's every bar, because the page polls
 * this route while the windows run. Read from the store the window's
 * backtest loads from; it names no strategy and reads no result. Null until
 * the store holds the traded symbol's bars for the window.
 */
async function tradedBuyAndHold(
  symbol: string, timeframe: Interval, window: { startMs: number; endMs: number },
): Promise<TargetReturn | null> {
  const barMs = INTERVAL_MS[timeframe];
  const [first] = await candleRepo.getCandles(symbol, timeframe,
    { from: window.startMs, to: window.endMs, limit: 1 });
  const [last] = await candleRepo.getCandles(symbol, timeframe,
    { to: window.endMs - barMs + 1, limit: 1 });
  return targetReturn(first, last, window, barMs);
}
