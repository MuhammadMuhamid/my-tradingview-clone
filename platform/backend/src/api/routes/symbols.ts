import type { FastifyInstance } from "fastify";
import * as symbols from "../../repositories/symbols";
import * as candles from "../../repositories/candles";
import { isInterval } from "../../types/market";
import { toCompact } from "../../data/candleWire";
import { listExchangeSymbols } from "../../data/binanceRest";

/** Quote assets offered as filter chips, best-supported first. */
const QUOTE_ORDER = ["USDT", "FDUSD", "USDC", "BTC", "ETH", "BNB", "TRY", "EUR"];

export async function symbolRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/symbols", async (req) => {
    const { active } = req.query as { active?: string };
    return symbols.listSymbols(active === "true");
  });

  /**
   * Symbol search across every Binance spot pair (TradingView's symbol dialog).
   * Ranked exact → prefix → substring, with tracked pairs and mainstream quotes
   * floated up, so typing "zec" lands ZECUSDT first.
   */
  app.get("/api/symbols/search", async (req, reply) => {
    const q = req.query as { q?: string; quote?: string; limit?: string };
    const term = (q.q ?? "").trim().toUpperCase();
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const quote = (q.quote ?? "").trim().toUpperCase();

    let all: Awaited<ReturnType<typeof listExchangeSymbols>>;
    try {
      all = await listExchangeSymbols();
    } catch (err) {
      return reply.code(502).send({ error: `symbol directory unavailable: ${(err as Error).message}` });
    }
    const tracked = new Set((await symbols.listSymbols()).map((s) => s.symbol));

    const scored: { row: (typeof all)[number]; rank: number }[] = [];
    for (const row of all) {
      if (row.status !== "TRADING") continue;
      if (quote && row.quoteAsset !== quote) continue;
      let rank: number;
      if (!term) rank = 3;
      else if (row.symbol === term) rank = 0;
      else if (row.baseAsset === term) rank = 1;
      else if (row.symbol.startsWith(term)) rank = 2;
      else if (row.symbol.includes(term)) rank = 4;
      else continue;
      // Tie-breakers: already-tracked pairs, then quote-asset popularity.
      const quoteRank = QUOTE_ORDER.indexOf(row.quoteAsset);
      rank = rank * 100 + (tracked.has(row.symbol) ? 0 : 10) +
        (quoteRank < 0 ? QUOTE_ORDER.length : quoteRank);
      scored.push({ row, rank });
    }
    scored.sort((a, b) => a.rank - b.rank || a.row.symbol.localeCompare(b.row.symbol));

    return {
      total: scored.length,
      quotes: QUOTE_ORDER,
      results: scored.slice(0, limit).map(({ row }) => ({
        symbol: row.symbol,
        baseAsset: row.baseAsset,
        quoteAsset: row.quoteAsset,
        tracked: tracked.has(row.symbol),
      })),
    };
  });

  app.post("/api/symbols", async (req, reply) => {
    const body = req.body as {
      symbol?: string;
      baseAsset?: string;
      quoteAsset?: string;
    };
    if (!body?.symbol || !body.baseAsset || !body.quoteAsset) {
      return reply
        .code(400)
        .send({ error: "symbol, baseAsset and quoteAsset are required" });
    }
    const created = await symbols.addSymbol(
      body.symbol.toUpperCase(),
      body.baseAsset.toUpperCase(),
      body.quoteAsset.toUpperCase()
    );
    return reply.code(201).send(created);
  });

  app.patch("/api/symbols/:symbol", async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const { isActive } = req.body as { isActive?: boolean };
    if (typeof isActive !== "boolean") {
      return reply.code(400).send({ error: "isActive (boolean) is required" });
    }
    const updated = await symbols.setSymbolActive(symbol.toUpperCase(), isActive);
    if (!updated) return reply.code(404).send({ error: "symbol not found" });
    return updated;
  });

  // Chart data: stored OHLCV for one symbol+interval.
  app.get("/api/symbols/:symbol/candles", async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const q = req.query as {
      interval?: string;
      from?: string;
      to?: string;
      limit?: string;
      /**
       * `compact` returns positional arrays instead of one object per bar.
       * Measured on the chart's default 10,000-bar request: 249 -> 67 bytes per
       * bar and 11.1 -> 4.2 ms to parse. Opt-in, so no existing consumer
       * changes shape. See `data/candleWire.ts`.
       */
      format?: string;
    };
    if (!q.interval || !isInterval(q.interval)) {
      return reply
        .code(400)
        .send({ error: "interval is required (e.g. 1m, 5m, 1h)" });
    }
    const limit = q.limit !== undefined ? Number(q.limit) : 1000;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 200000) {
      return reply.code(400).send({ error: "limit must be 1..200000" });
    }
    if (q.format !== undefined && q.format !== "compact") {
      return reply.code(400).send({ error: 'format must be "compact" when given' });
    }
    const ticker = symbol.toUpperCase();
    const rows = await candles.getCandles(ticker, q.interval, {
      from: q.from !== undefined ? Number(q.from) : undefined,
      to: q.to !== undefined ? Number(q.to) : undefined,
      limit,
    });
    return q.format === "compact" ? toCompact(rows, ticker, q.interval) : rows;
  });
}
