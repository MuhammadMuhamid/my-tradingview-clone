import type { FastifyInstance } from "fastify";
import * as backtests from "../../repositories/backtests";
import * as strategies from "../../repositories/strategies";
import * as symbols from "../../repositories/symbols";
import { isInterval } from "../../types/market";
import type { StrategyParams } from "../../types/strategy";
import * as deploymentRepo from "../../repositories/deployments";
import * as alertRepo from "../../repositories/alerts";
import { compareParity, type ParitySignal } from "../../engine/parityReport";
import { isBacktestId, paramsProblem, runSettingsProblem, sizingProblem } from "../backtestRequest";
import { engineDefaultParams } from "../../engine/backtester";
import { correctionsFingerprint } from "../../engine/corrections";
import { deleteRefusal, withReadTruth } from "../backtestReadTruth";

/**
 * Cost model applied when the caller does not state one.
 *
 * `X-09` / `OPT-03`: this defaulted to 0.05 % commission — half of the 0.1 %
 * per side that EVERY optimizer tree runs — so a backtest run through the app
 * was not comparable with the leaderboard row it was meant to reproduce, with
 * nothing on screen to say so. 0.1 % per side is 0.2 % round trip, which is
 * Binance spot taker. Existing runs are unaffected: each row stores the cost
 * model it actually ran under.
 */
export const DEFAULT_COMMISSION_PCT = 0.1;
export const DEFAULT_SLIPPAGE_TICKS = 2;
export const DEFAULT_INITIAL_CAPITAL = 1000;

/** Bar times only; an empty list must not collapse the window to NaN. */
const earliest = (s: readonly ParitySignal[]): number =>
  s.length === 0 ? -Infinity : Math.min(...s.map((x) => x.barTime));
const latest = (s: readonly ParitySignal[]): number =>
  s.length === 0 ? Infinity : Math.max(...s.map((x) => x.barTime));

export async function backtestRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Queue a backtest. If configId is given, its params/timeframe/symbol are
   * used as the base and body fields override them; the merged params are
   * snapshotted onto the run. The Stage 2 worker picks up queued rows.
   */
  app.post("/api/backtests", async (req, reply) => {
    const body = req.body as {
      strategyKey?: string;
      configId?: string;
      symbol?: string;
      timeframe?: string;
      startTime?: string | number;
      endTime?: string | number;
      params?: StrategyParams;
      initialCapital?: number;
      commissionPct?: number;
      slippageTicks?: number;
      holdoutFraction?: number;
    };

    if (!body?.strategyKey) {
      return reply.code(400).send({ error: "strategyKey is required" });
    }
    /*
     * The numbers and the dates first, before any lookup: they need no
     * database to judge, and a refusal for a negative capital should not wait
     * on — or depend on — the strategy table answering. See
     * `api/backtestRequest.ts` for what each bound is and why.
     */
    const settingsProblem = runSettingsProblem(body, Date.now());
    if (settingsProblem) return reply.code(400).send({ error: settingsProblem });
    const bodyParamsProblem = paramsProblem(body.params);
    if (bodyParamsProblem) return reply.code(400).send({ error: bodyParamsProblem });
    /*
     * C-01: an order size the account cannot pay for. Without a config the
     * parameters are fully known now — the body's over the engine's own
     * defaults — so this is judged before any lookup too; a config's stored
     * size is judged once it is merged, below.
     */
    const initialCapital = body.initialCapital ?? DEFAULT_INITIAL_CAPITAL;
    const defaults = engineDefaultParams(body.strategyKey);
    if (!body.configId) {
      const sized = sizingProblem(body.params ?? {}, initialCapital, defaults);
      if (sized) return reply.code(400).send({ error: sized });
    }

    const strategy = await strategies.getStrategyByKey(body.strategyKey);
    if (!strategy) return reply.code(404).send({ error: "strategy not found" });

    let baseParams: StrategyParams = {};
    let symbol = body.symbol?.toUpperCase();
    let timeframe = body.timeframe;
    if (body.configId) {
      const config = await strategies.getConfig(body.configId);
      if (!config) return reply.code(404).send({ error: "config not found" });
      baseParams = config.params;
      symbol = symbol ?? config.symbol ?? undefined;
      timeframe = timeframe ?? config.timeframe;
    }

    if (!symbol) return reply.code(400).send({ error: "symbol is required" });
    if (!(await symbols.getSymbol(symbol))) {
      return reply.code(404).send({ error: `unknown symbol: ${symbol}` });
    }
    if (!timeframe || !isInterval(timeframe)) {
      return reply.code(400).send({ error: `invalid timeframe: ${timeframe}` });
    }

    // The holdout fraction and the dates were checked above, with the costs.
    const startTime = new Date(body.startTime ?? NaN).getTime();
    const endTime = new Date(body.endTime ?? NaN).getTime();
    // A config's stored parameters are merged under the body's, and a config
    // saved before these bounds existed must not smuggle a bad value past them.
    const params = { ...baseParams, ...(body.params ?? {}) };
    const mergedProblem = paramsProblem(params);
    if (mergedProblem) return reply.code(400).send({ error: mergedProblem });
    const mergedSizing = sizingProblem(params, initialCapital, defaults);
    if (mergedSizing) return reply.code(400).send({ error: mergedSizing });

    const created = await backtests.createBacktest({
      strategyId: strategy.id,
      configId: body.configId,
      symbol,
      timeframe,
      startTime,
      endTime,
      params,
      initialCapital,
      commissionPct: body.commissionPct ?? DEFAULT_COMMISSION_PCT,
      slippageTicks: body.slippageTicks ?? DEFAULT_SLIPPAGE_TICKS,
      holdoutFraction: body.holdoutFraction,
    });
    return reply.code(201).send(created);
  });

  /*
   * C-02 / C-07: every read carries what the stored row means TODAY — whether
   * the engine that produced it is the one this server runs, and whether this
   * server would accept its settings as a new request. See
   * `api/backtestReadTruth.ts`; nothing is written back.
   */
  app.get("/api/backtests", async (req) => {
    const q = req.query as { symbol?: string; limit?: string };
    const [rows, registered] = await Promise.all([
      backtests.listBacktests({
        symbol: q.symbol?.toUpperCase(),
        limit: q.limit !== undefined ? Number(q.limit) : undefined,
      }),
      strategies.listStrategies(),
    ]);
    const keyOf = new Map(registered.map((s) => [s.id, s.key]));
    const nowMs = Date.now();
    const activeFingerprint = correctionsFingerprint();
    return rows.map((row) => withReadTruth(row, keyOf.get(row.strategyId) ?? null, { nowMs, activeFingerprint }));
  });

  app.get("/api/backtests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isBacktestId(id)) return reply.code(404).send({ error: "backtest not found" });
    const row = await backtests.getBacktest(id);
    if (!row) return reply.code(404).send({ error: "backtest not found" });
    const strategy = await strategies.getStrategyById(row.strategyId);
    return withReadTruth(row, strategy?.key ?? null);
  });

  /**
   * HVBO-4: delete one run.
   *
   * 204 when it is gone; 404 for no such run; 409, with the sentence, for a
   * run that is running (the worker would write its result to nothing) or
   * one window of a stress analysis (the analysis reads it). The delete and
   * the refusal are one statement — see `repositories/backtests.deleteBacktest`.
   */
  app.delete("/api/backtests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isBacktestId(id)) return reply.code(404).send({ error: "backtest not found" });
    const deleted = await backtests.deleteBacktest(id);
    if (deleted !== null) return reply.code(204).send();
    const refusal = deleteRefusal(await backtests.getBacktest(id));
    if (refusal) return reply.code(refusal.code).send({ error: refusal.error });
    // Neither deleted nor refusable: the row changed under us (a queued run
    // the worker claimed). Say so rather than claim a delete that did not happen.
    return reply.code(409).send({ error: "This run changed state while it was being deleted. Try again." });
  });

  app.get("/api/backtests/:id/trades", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isBacktestId(id)) return reply.code(404).send({ error: "backtest not found" });
    const row = await backtests.getBacktest(id);
    if (!row) return reply.code(404).send({ error: "backtest not found" });
    return backtests.getBacktestTrades(id);
  });
  /**
   * Backtest-versus-live parity for one deployment.
   *
   * `BE-01`, `BE-03` and `BE-15` each changed WHICH TRADES ARE TAKEN, and none
   * of them would show up in a metric — the two sides simply take different
   * trades and each looks internally consistent. What catches it is comparing
   * the two signal lists bar by bar, which is what this returns.
   *
   *   GET /api/backtests/:id/parity?deploymentId=<uuid>
   *
   * Signals are compared, not fills. The live payload carries no price and the
   * receiver places a market order (`BE-02`), so comparing prices would be
   * comparing a decision against an outcome.
   */
  app.get("/api/backtests/:id/parity", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { deploymentId?: string };
    if (!isBacktestId(id)) return reply.code(404).send({ error: "backtest not found" });
    if (!q.deploymentId) {
      return reply.code(400).send({ error: "deploymentId is required" });
    }
    const run = await backtests.getBacktest(id);
    if (!run) return reply.code(404).send({ error: "backtest not found" });
    const deployment = await deploymentRepo.getDeployment(q.deploymentId);
    if (!deployment) return reply.code(404).send({ error: "deployment not found" });

    if (deployment.symbol !== run.symbol || deployment.timeframe !== run.timeframe) {
      return reply.code(409).send({
        error:
          `the backtest is ${run.symbol} ${run.timeframe} and the deployment is ` +
          `${deployment.symbol} ${deployment.timeframe}. Comparing different markets ` +
          "would report every signal as a divergence.",
      });
    }

    const trades = await backtests.getBacktestTrades(id);
    // A backtest trade is an entry and an exit; parity compares SIGNALS, so
    // each trade becomes two.
    const backtestSignals: ParitySignal[] = trades.flatMap((t) => [
      { barTime: t.entryTime, action: "buy" as const, reason: "entry", price: t.entryPrice },
      // A trade still open at the end of the window has no exit signal to
      // compare; omitting it is correct, and counting it would report a
      // divergence against a trade that has not finished.
      ...(t.exitTime === null
        ? []
        : [{ barTime: t.exitTime, action: "sell" as const, reason: t.exitReason, price: t.exitPrice }]),
    ]);

    const alerts = await alertRepo.listAlerts({ deploymentId: q.deploymentId, limit: 2000 });
    const liveSignals: ParitySignal[] = alerts.map((a) => ({
      barTime: new Date(a.barTime).getTime(),
      action: a.action,
      reason: a.reason,
      price: a.triggerPrice,
    }));

    const report = compareParity(backtestSignals, liveSignals, {
      window: {
        startMs: Math.max(new Date(run.startTime).getTime(), earliest(liveSignals)),
        endMs: Math.min(new Date(run.endTime).getTime(), latest(liveSignals)),
      },
    });
    return {
      backtestId: id,
      deploymentId: q.deploymentId,
      symbol: run.symbol,
      timeframe: run.timeframe,
      ...report,
      window: report.window && {
        startMs: report.window.startMs,
        endMs: report.window.endMs,
        start: new Date(report.window.startMs).toISOString(),
        end: new Date(report.window.endMs).toISOString(),
      },
      caveat:
        "Signals are compared, not fills: the live payload carries no price and the receiver "
        + "places a market order (BE-02). A divergence in the stated reason means the two sides "
        + "exited on different rules, which changes the win/loss flag and therefore the "
        + "circuit-breaker schedule (BE-03, BE-15).",
    };
  });

}
