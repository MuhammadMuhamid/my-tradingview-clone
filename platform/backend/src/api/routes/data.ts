import type { FastifyInstance } from "fastify";
import { fetchAggTrades, fetchKlines } from "../../data/binanceRest";
import { marketData } from "../../data/marketData";
import * as candleRepo from "../../repositories/candles";
import { parseResolution } from "../../data/resolution";
import { sourceInterval } from "../../data/resolvedCandles";
import { InstrumentIdError, storedSymbol } from "../../types/instrument";
import { registerInstrument } from "../../data/instrumentRegistration";
import { inspectCandleIntegrity } from "../../data/candleIntegrity";

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  /** Ordered public executions for Range and Volume Footprint charts. */
  app.get("/api/data/trades", async (req, reply) => {
    const q = req.query as { symbol?: string; from?: string; to?: string; limit?: string };
    if (!q.symbol || !/^[A-Z0-9]{2,24}$/i.test(q.symbol)) {
      return reply.code(400).send({ error: "a Binance symbol is required" });
    }
    const from = Number(q.from), to = Number(q.to);
    const limit = Math.min(Math.max(Number(q.limit ?? 10_000) || 10_000, 1), 50_000);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 7 * 86_400_000) {
      return reply.code(400).send({ error: "from/to must describe at most seven days" });
    }
    try {
      const rows = await fetchAggTrades(q.symbol, from, to, limit);
      return rows.map((row) => ({
        id: row.id, timestamp: row.timestamp, price: row.price, quantity: row.quantity,
        aggressor: row.aggressor,
      }));
    } catch (error) {
      req.log.warn({ error }, "aggregate trade history unavailable");
      return reply.code(502).send({ error: "aggregate trade history unavailable" });
    }
  });

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
    let symbol: string;
    try { symbol = storedSymbol(body.symbol); }
    catch (err) {
      if (err instanceof InstrumentIdError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    /*
     * A chart may ask to backfill the resolution it is ON, which may be derived.
     * There is nothing derived to fetch: what gets stored is the SOURCE the
     * resolution folds from, and the response names both so a caller can see
     * which rows it caused to exist.
     */
    const plan = parseResolution(body.interval);
    if (plan === null) {
      return reply.code(400).send({ error: `invalid interval: ${body.interval}` });
    }
    const stored = sourceInterval(plan);
    // Registration now asks the venue for the real base and quote assets rather
    // than guessing them off a `USDT` suffix — see `data/instrumentRegistration`.
    await registerInstrument(symbol, req.log.warn.bind(req.log));
    const startMs = new Date(body.start ?? NaN).getTime();
    const endMs = new Date(body.end ?? Date.now()).getTime();
    if (!Number.isFinite(startMs) || startMs >= endMs) {
      return reply.code(400).send({ error: "start must be a valid date before end" });
    }
    const fetched = await fetchKlines(symbol, stored, startMs, endMs);
    await candleRepo.upsertCandles(fetched);
    const integrity = inspectCandleIntegrity(fetched, {
      symbol, interval: stored, now: endMs, checkFreshness: false,
    });
    return {
      symbol, interval: plan.id, source: stored, fetched: fetched.length, integrity,
    };
  });

  /** Ensure coverage without necessarily refetching (used before backtests). */
  app.post("/api/data/ensure", async (req, reply) => {
    const body = req.body as { symbol?: string; interval?: string; start?: string | number; end?: string | number };
    const plan = body?.interval === undefined ? null : parseResolution(body.interval);
    if (!body?.symbol || plan === null) {
      return reply.code(400).send({ error: "symbol and valid interval are required" });
    }
    let symbol: string;
    try { symbol = storedSymbol(body.symbol); }
    catch (err) {
      if (err instanceof InstrumentIdError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    const startMs = new Date(body.start ?? NaN).getTime();
    const endMs = new Date(body.end ?? Date.now()).getTime();
    if (!Number.isFinite(startMs) || startMs >= endMs) {
      return reply.code(400).send({ error: "start must be a valid date before end" });
    }
    const source = sourceInterval(plan);
    await marketData.ensureCoverage(symbol, source, startMs, endMs);
    const count = await candleRepo.countCandles(symbol, source);
    return { symbol, interval: plan.id, source, storedTotal: count };
  });

  /** Sync exchange filters (tick/step/minNotional) for the given symbols. */
  app.post("/api/data/sync-filters", async (req, reply) => {
    const body = req.body as { symbols?: string[] };
    let symbols: string[];
    try { symbols = (body?.symbols ?? []).map(storedSymbol); }
    catch (err) {
      if (err instanceof InstrumentIdError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    if (symbols.length === 0) return reply.code(400).send({ error: "symbols[] is required" });
    await marketData.syncInstrumentFilters(symbols);
    return { synced: symbols };
  });
}
