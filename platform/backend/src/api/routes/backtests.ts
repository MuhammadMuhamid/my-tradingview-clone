import type { FastifyInstance } from "fastify";
import * as backtests from "../../repositories/backtests";
import * as strategies from "../../repositories/strategies";
import * as symbols from "../../repositories/symbols";
import { isInterval } from "../../types/market";
import type { StrategyParams } from "../../types/strategy";

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
      initialCapital: body.initialCapital ?? 1000,
      commissionPct: body.commissionPct ?? 0.05,
      slippageTicks: body.slippageTicks ?? 2,
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
}
