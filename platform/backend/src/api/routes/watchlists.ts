import type { FastifyInstance } from "fastify";
import * as watchlists from "../../repositories/watchlists";
import { canonicalizeLegacySpotSymbol } from "../../market/model";
import { userIdOf } from "../../security/requestUser";

export const cleanInstrument = (raw: unknown): string => {
  const value = String(raw).trim();
  return canonicalizeLegacySpotSymbol(value) ?? value.toUpperCase();
};

export const cleanSymbols = (v: unknown): string[] => Array.isArray(v)
  ? [...new Set(v.map(cleanInstrument).filter(Boolean))] : [];

export async function watchlistRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/watchlists", async (req) => watchlists.listWatchlists(userIdOf(req)));

  app.post("/api/watchlists", async (req, reply) => {
    const b = req.body as { name?: string; symbols?: unknown; position?: number };
    if (!b?.name?.trim()) return reply.code(400).send({ error: "name is required" });
    const row = await watchlists.upsertByName(userIdOf(req), b.name, cleanSymbols(b.symbols), b.position ?? 0);
    return reply.code(201).send(row);
  });

  app.patch("/api/watchlists/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { name?: string; symbols?: unknown; position?: number };
    const row = await watchlists.updateWatchlist(userIdOf(req), id, {
      name: b.name,
      symbols: b.symbols === undefined ? undefined : cleanSymbols(b.symbols),
      position: b.position,
    });
    if (!row) return reply.code(404).send({ error: "watchlist not found" });
    return row;
  });

  app.delete("/api/watchlists/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await watchlists.deleteWatchlist(userIdOf(req), id);
    if (!ok) return reply.code(404).send({ error: "watchlist not found" });
    return reply.code(204).send();
  });
}
