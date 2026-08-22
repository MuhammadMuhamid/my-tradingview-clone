import type { FastifyInstance } from "fastify";
import * as strategies from "../../repositories/strategies";
import { isInterval } from "../../types/market";
import type { StrategyParams } from "../../types/strategy";

export async function strategyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/strategies", async () => strategies.listStrategies());

  app.get("/api/strategies/:key/configs", async (req, reply) => {
    const { key } = req.params as { key: string };
    const strategy = await strategies.getStrategyByKey(key);
    if (!strategy) return reply.code(404).send({ error: "strategy not found" });
    return strategies.listConfigs(strategy.id);
  });

  app.post("/api/strategies/:key/configs", async (req, reply) => {
    const { key } = req.params as { key: string };
    const strategy = await strategies.getStrategyByKey(key);
    if (!strategy) return reply.code(404).send({ error: "strategy not found" });

    const body = req.body as {
      name?: string;
      symbol?: string;
      timeframe?: string;
      params?: StrategyParams;
      isDefault?: boolean;
    };
    if (!body?.name) return reply.code(400).send({ error: "name is required" });
    const timeframe = body.timeframe ?? "5m";
    if (!isInterval(timeframe)) {
      return reply.code(400).send({ error: `invalid timeframe: ${timeframe}` });
    }
    const created = await strategies.createConfig({
      strategyId: strategy.id,
      name: body.name,
      symbol: body.symbol?.toUpperCase(),
      timeframe,
      params: body.params ?? {},
      isDefault: body.isDefault,
    });
    return reply.code(201).send(created);
  });

  app.get("/api/configs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const config = await strategies.getConfig(id);
    if (!config) return reply.code(404).send({ error: "config not found" });
    return config;
  });

  app.patch("/api/configs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      name?: string;
      symbol?: string | null;
      timeframe?: string;
      params?: StrategyParams;
      isDefault?: boolean;
    };
    if (body.timeframe !== undefined && !isInterval(body.timeframe)) {
      return reply
        .code(400)
        .send({ error: `invalid timeframe: ${body.timeframe}` });
    }
    const updated = await strategies.updateConfig(id, {
      name: body.name,
      symbol: body.symbol === undefined ? undefined : body.symbol?.toUpperCase() ?? null,
      timeframe: body.timeframe as never,
      params: body.params,
      isDefault: body.isDefault,
    });
    if (!updated) return reply.code(404).send({ error: "config not found" });
    return updated;
  });

  app.delete("/api/configs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await strategies.deleteConfig(id);
    if (!deleted) return reply.code(404).send({ error: "config not found" });
    return reply.code(204).send();
  });
}
