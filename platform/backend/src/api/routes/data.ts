import type { FastifyInstance } from "fastify";
import { ensureCandles, fetchKlines, syncExchangeFilters } from "../../data/binanceRest";
import * as candleRepo from "../../repositories/candles";
import * as symbolRepo from "../../repositories/symbols";
import { isInterval } from "../../types/market";

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Backfill OHLCV from Binance for a symbol/interval range and cache it.
   * POST /api/data/backfill { symbol, interval, start, end }
   */
  app.post("/api/data/backfill", async (req, reply) => {
    const body = req.body as {
      symbol?: string;
      interval?: string;
      start?: string | number;
      end?: string | number;
    };
    if (!body?.symbol || !body.interval) {
      return reply.code(400).send({ error: "symbol and interval are required" });
    }
    const symbol = body.symbol.toUpperCase();
    if (!isInterval(body.interval)) {
      return reply.code(400).send({ error: `invalid interval: ${body.interval}` });
    }
    if (!(await symbolRepo.getSymbol(symbol))) {
      await symbolRepo.addSymbol(symbol, symbol.replace(/USDT$/, ""), "USDT");
    }
    const startMs = new Date(body.start ?? NaN).getTime();
    const endMs = new Date(body.end ?? Date.now()).getTime();
    if (!Number.isFinite(startMs) || startMs >= endMs) {
      return reply.code(400).send({ error: "start must be a valid date before end" });
    }
    const fetched = await fetchKlines(symbol, body.interval, startMs, endMs);
    await candleRepo.upsertCandles(fetched);
    return { symbol, interval: body.interval, fetched: fetched.length };
  });

  /** Ensure coverage without necessarily refetching (used before backtests). */
  app.post("/api/data/ensure", async (req, reply) => {
    const body = req.body as { symbol?: string; interval?: string; start?: string | number; end?: string | number };
    if (!body?.symbol || !body.interval || !isInterval(body.interval)) {
      return reply.code(400).send({ error: "symbol and valid interval are required" });
    }
    const symbol = body.symbol.toUpperCase();
    const startMs = new Date(body.start ?? NaN).getTime();
    const endMs = new Date(body.end ?? Date.now()).getTime();
    if (!Number.isFinite(startMs) || startMs >= endMs) {
      return reply.code(400).send({ error: "start must be a valid date before end" });
    }
    await ensureCandles(symbol, body.interval, startMs, endMs);
    const count = await candleRepo.countCandles(symbol, body.interval);
    return { symbol, interval: body.interval, storedTotal: count };
  });

  /** Sync exchange filters (tick/step/minNotional) for the given symbols. */
  app.post("/api/data/sync-filters", async (req, reply) => {
    const body = req.body as { symbols?: string[] };
    const symbols = (body?.symbols ?? []).map((s) => s.toUpperCase());
    if (symbols.length === 0) return reply.code(400).send({ error: "symbols[] is required" });
    await syncExchangeFilters(symbols);
    return { synced: symbols };
  });
}
