import type { FastifyInstance } from "fastify";
import * as backtests from "../../repositories/backtests";
import * as strategies from "../../repositories/strategies";
import * as symbols from "../../repositories/symbols";
import { isInterval } from "../../types/market";
import type { StrategyParams } from "../../types/strategy";
import * as deploymentRepo from "../../repositories/deployments";
import * as alertRepo from "../../repositories/alerts";
import { compareParity, type ParitySignal } from "../../engine/parityReport";

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
    };

    if (!body?.strategyKey) {
      return reply.code(400).send({ error: "strategyKey is required" });
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

    const startTime = new Date(body.startTime ?? NaN).getTime();
    const endTime = new Date(body.endTime ?? NaN).getTime();
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
      return reply
        .code(400)
        .send({ error: "startTime and endTime must be valid dates with startTime < endTime" });
    }

    const created = await backtests.createBacktest({
      strategyId: strategy.id,
      configId: body.configId,
      symbol,
      timeframe,
      startTime,
      endTime,
      params: { ...baseParams, ...(body.params ?? {}) },
      initialCapital: body.initialCapital ?? DEFAULT_INITIAL_CAPITAL,
      commissionPct: body.commissionPct ?? DEFAULT_COMMISSION_PCT,
      slippageTicks: body.slippageTicks ?? DEFAULT_SLIPPAGE_TICKS,
    });
    return reply.code(201).send(created);
  });

  app.get("/api/backtests", async (req) => {
    const q = req.query as { symbol?: string; limit?: string };
    return backtests.listBacktests({
      symbol: q.symbol?.toUpperCase(),
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
    });
  });

  app.get("/api/backtests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await backtests.getBacktest(id);
    if (!row) return reply.code(404).send({ error: "backtest not found" });
    return row;
  });

  app.get("/api/backtests/:id/trades", async (req, reply) => {
    const { id } = req.params as { id: string };
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
