import type { FastifyInstance } from "fastify";
import * as symbols from "../../repositories/symbols";
import { parseResolution } from "../../data/resolution";
import { IncompleteDerivedCandleError, readResolvedCandles } from "../../data/resolvedCandles";
import { toCompact } from "../../data/candleWire";
import { fetch24hTickers, listExchangeSymbols, TICKER_BATCH_LIMIT, type Ticker24h } from "../../data/binanceRest";
import { InstrumentIdError, storedSymbol } from "../../types/instrument";

/** Quote assets offered as filter chips, best-supported first. */
const QUOTE_ORDER = ["USDT", "FDUSD", "USDC", "BTC", "ETH", "BNB", "TRY", "EUR"];

/**
 * Ticker seeds are shared by every browser tab and change once a second at
 * most; a short cache keeps a watchlist of forty rows from costing forty
 * upstream calls a minute across a few open tabs.
 */
const TICKER_CACHE_TTL_MS = 3_000;

export interface SymbolRouteDeps {
  tickers?: (symbols: readonly string[]) => Promise<Ticker24h[]>;
  now?: () => number;
}

export function symbolRoutes(deps: SymbolRouteDeps = {}): (app: FastifyInstance) => Promise<void> {
  const loadTickers = deps.tickers ?? ((s) => fetch24hTickers(s));
  const now = deps.now ?? (() => Date.now());
  const tickerCache = new Map<string, { at: number; rows: Ticker24h[] }>();
  return async (app) => registerSymbolRoutes(app, { loadTickers, now, tickerCache });
}

async function registerSymbolRoutes(app: FastifyInstance, ctx: {
  loadTickers: (symbols: readonly string[]) => Promise<Ticker24h[]>;
  now: () => number;
  tickerCache: Map<string, { at: number; rows: Ticker24h[] }>;
}): Promise<void> {
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

  /**
   * Same-origin watchlist seed: last price and 24h-ago price per symbol, from
   * Binance's public 24h ticker through the backend's market-data host. The
   * browser reads this once per watchlist change so its rows are never blank
   * while the stream connects — or forever, where the stream host is fenced.
   */
  app.get("/api/symbols/tickers", async (req, reply) => {
    const q = req.query as { symbols?: string };
    const wanted = [...new Set((q.symbols ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
    if (wanted.length === 0) return reply.code(400).send({ error: "symbols is required (comma-separated)" });
    if (wanted.length > TICKER_BATCH_LIMIT) {
      return reply.code(400).send({ error: `at most ${TICKER_BATCH_LIMIT} symbols per request` });
    }
    if (!wanted.every((s) => /^[A-Z0-9]{2,24}$/.test(s))) {
      return reply.code(400).send({ error: "symbols must be Binance tickers" });
    }
    const key = [...wanted].sort().join(",");
    const cached = ctx.tickerCache.get(key);
    if (cached && ctx.now() - cached.at <= TICKER_CACHE_TTL_MS) return cached.rows;
    let rows: Ticker24h[];
    try {
      rows = await ctx.loadTickers(wanted);
    } catch (err) {
      req.log.warn({ err }, "ticker seed unavailable");
      return reply.code(502).send({ error: "market-data host did not answer the ticker request" });
    }
    ctx.tickerCache.set(key, { at: ctx.now(), rows });
    // Bounded: a tab that walks many lists must not grow this without limit.
    if (ctx.tickerCache.size > 64) {
      const oldest = ctx.tickerCache.keys().next();
      if (!oldest.done) ctx.tickerCache.delete(oldest.value);
    }
    return rows;
  });

  // Chart data: OHLCV for one symbol at one resolution — stored directly when
  // the venue publishes it, folded from whole venue bars when it does not.
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
    /*
     * Any resolution the venue's own bars can be folded into exactly.
     *
     * `parseResolution` refuses everything else — including a plausible
     * near-miss such as `7s` or `1w` — rather than serving the closest thing it
     * has under the requested name. See `data/resolution.ts`.
     */
    const plan = parseResolution(q.interval);
    if (plan === null) {
      return reply.code(400).send({
        error: "interval is required and must be a resolution this venue can " +
          "serve exactly (e.g. 1m, 45m, 30s, 3h)",
      });
    }
    const limit = q.limit !== undefined ? Number(q.limit) : 1000;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 200000) {
      return reply.code(400).send({ error: "limit must be 1..200000" });
    }
    if (q.format !== undefined && q.format !== "compact") {
      return reply.code(400).send({ error: 'format must be "compact" when given' });
    }
    /*
     * Accepts the bare ticker every stored row and link already carries AND
     * the venue-qualified `BINANCE:BTCUSDT` form, which resolve to exactly the
     * same instrument. A venue this build does not implement is refused here
     * rather than silently served from Binance's tape — see
     * `types/instrument.ts`.
     */
    let ticker: string;
    try { ticker = storedSymbol(symbol); }
    catch (err) {
      if (err instanceof InstrumentIdError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    let rows;
    try {
      rows = await readResolvedCandles(ticker, plan, {
        from: q.from !== undefined ? Number(q.from) : undefined,
        to: q.to !== undefined ? Number(q.to) : undefined,
        limit,
        asOfMs: ctx.now(),
      });
    } catch (error) {
      if (error instanceof IncompleteDerivedCandleError) {
        return reply.code(409).send({
          error: "incomplete_closed_derived_candle",
          interval: plan.id,
          openTime: error.bar.openTime,
          sourceBarCount: error.bar.sourceBarCount,
          expectedSourceBarCount: error.bar.expectedSourceBarCount,
        });
      }
      throw error;
    }
    return q.format === "compact" ? toCompact(rows, ticker, plan.id) : rows;
  });
}
