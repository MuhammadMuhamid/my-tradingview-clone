import type { FastifyInstance } from "fastify";
import * as layouts from "../../repositories/layouts";
import * as deployments from "../../repositories/deployments";
import * as strategies from "../../repositories/strategies";
import { isInterval } from "../../types/market";
import type { StrategyParams } from "../../types/strategy";
import type { LayoutMaLine, LayoutProperties } from "../../repositories/layouts";
import { normalizeCanonicalInstrumentId } from "../../market/model";

interface LayoutBody {
  name?: string;
  symbol?: string;
  timeframe?: string;
  bars?: number;
  strategyKey?: string;
  params?: StrategyParams;
  properties?: LayoutProperties;
  movingAverages?: LayoutMaLine[];
}

const storedLayoutSymbol = (value: string): string =>
  normalizeCanonicalInstrumentId(value) ?? value.toUpperCase();

export async function layoutRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/layouts", async () => layouts.listLayouts());

  app.get("/api/layouts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const layout = await layouts.getLayout(id);
    if (!layout) return reply.code(404).send({ error: "layout not found" });
    return layout;
  });

  // Create or update by case-insensitive name (frontend upsert semantics).
  app.post("/api/layouts", async (req, reply) => {
    const body = req.body as LayoutBody;
    if (!body?.name?.trim()) return reply.code(400).send({ error: "name is required" });
    if (!body.symbol) return reply.code(400).send({ error: "symbol is required" });
    if (!body.timeframe || !isInterval(body.timeframe)) {
      return reply.code(400).send({ error: `invalid timeframe: ${body.timeframe}` });
    }
    if (!body.strategyKey) return reply.code(400).send({ error: "strategyKey is required" });
    const saved = await layouts.upsertLayoutByName(body.name, {
      symbol: storedLayoutSymbol(body.symbol),
      timeframe: body.timeframe,
      bars: body.bars ?? 10000,
      strategyKey: body.strategyKey,
      params: body.params ?? {},
      properties: body.properties ?? layouts.defaultSyncedProperties(null),
      movingAverages: body.movingAverages,
    });
    return reply.code(201).send(saved);
  });

  app.patch("/api/layouts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as LayoutBody;
    if (body.timeframe !== undefined && !isInterval(body.timeframe)) {
      return reply.code(400).send({ error: `invalid timeframe: ${body.timeframe}` });
    }
    const updated = await layouts.updateLayout(id, {
      name: body.name,
      symbol: body.symbol === undefined ? undefined : storedLayoutSymbol(body.symbol),
      timeframe: body.timeframe,
      bars: body.bars,
      strategyKey: body.strategyKey,
      params: body.params,
      properties: body.properties,
      movingAverages: body.movingAverages,
    });
    if (!updated) return reply.code(404).send({ error: "layout not found" });
    return updated;
  });

  app.delete("/api/layouts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await layouts.deleteLayout(id);
    if (!deleted) return reply.code(404).send({ error: "layout not found" });
    return reply.code(204).send();
  });

  /**
   * Ensure every coin with a saved alert (deployment) has a layout named
   * after the coin, carrying the deployment's exact strategy settings.
   * Existing layout properties/history depth are preserved.
   */
  app.post("/api/layouts/sync-deployments", async () => {
    const [allDeployments, allStrategies] = await Promise.all([
      deployments.listDeployments(),
      strategies.listStrategies(),
    ]);
    const keyById = new Map(allStrategies.map((s) => [s.id, s.key]));
    const chosen = layouts.pickSyncDeployment(
      allDeployments.filter((d) => d.status !== "stopped")
    );
    const synced: string[] = [];
    for (const [symbol, dep] of chosen) {
      const strategyKey = keyById.get(dep.strategyId);
      if (!strategyKey) continue;
      const existing = await layouts.getLayoutByName(symbol);
      const state = layouts.layoutStateFromDeployment(dep, strategyKey, existing);
      await layouts.upsertLayoutByName(symbol, state);
      synced.push(symbol);
    }
    return { synced, count: synced.length };
  });
}
