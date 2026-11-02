import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { backfillRange, fetchAggTrades, fetchKlines } from "../../data/binanceRest";
import { marketData } from "../../data/marketData";
import * as candleRepo from "../../repositories/candles";
import { parseResolution, type ResolutionPlan } from "../../data/resolution";
import { sourceInterval } from "../../data/resolvedCandles";
import { InstrumentIdError, storedSymbol } from "../../types/instrument";
import {
  InstrumentDirectoryUnavailableError, registerInstrument, UnknownInstrumentError,
} from "../../data/instrumentRegistration";
import {
  inspectCandleIntegrity, type CandleIntegrityIssueCode, type CandleIntegrityReport,
} from "../../data/candleIntegrity";
import { INTERVAL_MS, type Interval } from "../../types/market";
import { isAdmin, userIdOf } from "../../security/requestUser";

/**
 * The most SOURCE bars one backfill/ensure request may cover for an ordinary
 * account; a longer request is clamped to the newest bars, not refused.
 *
 * The chart's default depth backfills ceil(10,000 * 1.1) = 11,000 bars of a
 * native resolution, but a derived resolution multiplies that by its factor
 * (5s is 55,000 one-second bars; 25m is 55,000 five-minute bars). The ceiling
 * is therefore the same 200,000 source rows the candles GET will serve
 * (`MAX_SOURCE_ROWS` in `data/resolvedCandles`): a window the chart could never
 * draw is refused; everything it can draw is allowed. 200,000 bars is ~30 MB
 * held for one request, bounded further by the in-flight limit below. Without
 * a ceiling any signed-in account could make the API process (which also hosts
 * LiveRunner) hold years of 1m bars in memory at once. The admin is not capped:
 * their large requests stream instead (see below).
 */
export const USER_MAX_HISTORY_BARS = 200_000;

/** Heavy history requests one ordinary account may have running at once. */
export const USER_MAX_HISTORY_IN_FLIGHT = 4;

/** Everything these routes reach outside the process; tests inject fakes. */
export interface DataRouteDeps {
  fetchKlines?: typeof fetchKlines;
  backfillRange?: typeof backfillRange;
  ensureCoverage?: (symbol: string, interval: Interval, startMs: number, endMs: number) => Promise<void>;
  upsertCandles?: typeof candleRepo.upsertCandles;
  countCandles?: typeof candleRepo.countCandles;
  registerInstrument?: typeof registerInstrument;
}

/** Bars of `interval` whose open time falls in [startMs, endMs]. */
function sourceBarsIn(interval: Interval, startMs: number, endMs: number): number {
  return Math.floor((endMs - startMs) / INTERVAL_MS[interval]) + 1;
}

function historyLimitNote(symbol: string, plan: ResolutionPlan, stored: Interval, bars: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const what = plan.id === stored
    ? `${symbol} ${stored} history request covered about ${n(bars)} bars`
    : `${symbol} ${plan.id} is built from ${stored} bars and this request covered about ${n(bars)} of them`;
  return `${what}; an account may load at most ${n(USER_MAX_HISTORY_BARS)} ${stored} bars at a time, ` +
    "so only the most recent were loaded. Ask the administrator to load deeper history.";
}

/**
 * The span an ordinary account's request actually covers.
 *
 * Clamped to the newest `USER_MAX_HISTORY_BARS` source bars rather than
 * refused: the chart offers depth presets up to "All" (200,000 bars, which it
 * backfills ×1.1) and derived resolutions that multiply the source count, and
 * every one of those used to load. The candles GET already serves at most this
 * many source rows, so nothing the chart could draw is lost. The admin is not
 * clamped; their deep backfills stream (see the route).
 */
function clampForAccount(
  req: FastifyRequest, stored: Interval, startMs: number, endMs: number, bars: number,
): { startMs: number; clamped: boolean } {
  if (isAdmin(req) || bars <= USER_MAX_HISTORY_BARS) return { startMs, clamped: false };
  return { startMs: endMs - (USER_MAX_HISTORY_BARS - 1) * INTERVAL_MS[stored], clamped: true };
}

// Registered as `app.register(dataRoutes)`; Fastify hands the plugin options in
// as the second argument, which is where tests inject their fakes.
export async function dataRoutes(app: FastifyInstance, opts: DataRouteDeps = {}): Promise<void> {
  const deps = {
    fetchKlines: opts.fetchKlines ?? fetchKlines,
    backfillRange: opts.backfillRange ?? backfillRange,
    ensureCoverage: opts.ensureCoverage ??
      ((symbol: string, interval: Interval, startMs: number, endMs: number) =>
        marketData.ensureCoverage(symbol, interval, startMs, endMs)),
    upsertCandles: opts.upsertCandles ?? candleRepo.upsertCandles,
    countCandles: opts.countCandles ?? candleRepo.countCandles,
    registerInstrument: opts.registerInstrument ?? registerInstrument,
  };

  /*
   * Ordinary accounts reach backfill/ensure (a chart on an untracked coin starts
   * tracking it), so each account may run only a few at once (the span itself
   * is clamped by `clampForAccount`). The admin is exempt. `ok: false` means it
   * has replied.
   */
  const inFlight = new Map<string, number>();
  const admitHistoryRequest = (
    req: FastifyRequest, reply: FastifyReply,
  ): { ok: false } | { ok: true; release: () => void } => {
    if (isAdmin(req)) return { ok: true, release: () => {} };
    const user = userIdOf(req);
    const running = inFlight.get(user) ?? 0;
    if (running >= USER_MAX_HISTORY_IN_FLIGHT) {
      void reply.code(429).header("retry-after", "5").send({
        error: `This account already has ${running} history requests loading; ` +
          "wait for one to finish and try again.",
      });
      return { ok: false };
    }
    inFlight.set(user, running + 1);
    return {
      ok: true,
      release: () => {
        const left = (inFlight.get(user) ?? 1) - 1;
        if (left <= 0) inFlight.delete(user); else inFlight.set(user, left);
      },
    };
  };

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
    const requestedStartMs = new Date(body.start ?? NaN).getTime();
    const endMs = new Date(body.end ?? Date.now()).getTime();
    if (!Number.isFinite(requestedStartMs) || !Number.isFinite(endMs) || requestedStartMs >= endMs) {
      return reply.code(400).send({ error: "start must be a valid date before end" });
    }
    const requestedBars = sourceBarsIn(stored, requestedStartMs, endMs);
    const { startMs, clamped } = clampForAccount(req, stored, requestedStartMs, endMs, requestedBars);
    const bars = clamped ? USER_MAX_HISTORY_BARS : requestedBars;
    const clampNote = clamped
      ? { clamped: true, coveredFrom: startMs, note: historyLimitNote(symbol, plan, stored, requestedBars) }
      : {};
    const admitted = admitHistoryRequest(req, reply);
    if (!admitted.ok) return reply;
    try {
      // Registration now asks the venue for the real base and quote assets rather
      // than guessing them off a `USDT` suffix — see `data/instrumentRegistration`.
      // A pair the venue does not list is a 404 here and writes nothing.
      try { await deps.registerInstrument(symbol, req.log.warn.bind(req.log)); }
      catch (err) {
        if (err instanceof UnknownInstrumentError) return reply.code(404).send({ error: err.message });
        if (err instanceof InstrumentDirectoryUnavailableError) return reply.code(503).send({ error: err.message });
        throw err;
      }
      if (bars > USER_MAX_HISTORY_BARS) {
        /*
         * Only the admin gets here. `fetchKlines` would hold the whole span in
         * memory before one upsert; `backfillRange` flushes every 5,000 rows, so
         * memory stays one buffer however deep the request. It keeps per-chunk
         * counts rather than example timestamps, so `integrity` is the same
         * shape with `timestamps: []` and an age it did not measure left null.
         */
        const report = await deps.backfillRange(symbol, stored, startMs, endMs, {
          sink: deps.upsertCandles, log: req.log.info.bind(req.log),
        });
        const integrity: CandleIntegrityReport = {
          state: report.integrity, market: "spot", symbol, interval: stored, checkedAt: Date.now(),
          latestCompletedBarOpenTime: report.lastOpenTime, latestCompletedBarAgeMs: null,
          issues: Object.entries(report.issues).map(([code, count]) => ({
            code: code as CandleIntegrityIssueCode, count, timestamps: [],
          })),
        };
        return {
          symbol, interval: plan.id, source: stored, fetched: report.rows, integrity, streamed: true,
        };
      }
      const fetched = await deps.fetchKlines(symbol, stored, startMs, endMs);
      await deps.upsertCandles(fetched);
      const integrity = inspectCandleIntegrity(fetched, {
        symbol, interval: stored, now: endMs, checkFreshness: false,
      });
      return {
        symbol, interval: plan.id, source: stored, fetched: fetched.length, integrity, ...clampNote,
      };
    } finally {
      admitted.release();
    }
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
    const requestedStartMs = new Date(body.start ?? NaN).getTime();
    const endMs = new Date(body.end ?? Date.now()).getTime();
    if (!Number.isFinite(requestedStartMs) || !Number.isFinite(endMs) || requestedStartMs >= endMs) {
      return reply.code(400).send({ error: "start must be a valid date before end" });
    }
    const source = sourceInterval(plan);
    // Same ceiling as backfill: coverage reads, and may fetch, the whole span.
    const requestedBars = sourceBarsIn(source, requestedStartMs, endMs);
    const { startMs, clamped } = clampForAccount(req, source, requestedStartMs, endMs, requestedBars);
    const admitted = admitHistoryRequest(req, reply);
    if (!admitted.ok) return reply;
    try {
      await deps.ensureCoverage(symbol, source, startMs, endMs);
      const count = await deps.countCandles(symbol, source);
      return {
        symbol, interval: plan.id, source, storedTotal: count,
        ...(clamped
          ? { clamped: true, coveredFrom: startMs, note: historyLimitNote(symbol, plan, source, requestedBars) }
          : {}),
      };
    } finally {
      admitted.release();
    }
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
