/**
 * Pine editor API — save/compile/run user-authored Pine scripts.
 *
 * Running is synchronous rather than queued through the backtest worker: the
 * editor needs plot data and compile diagnostics back immediately, and a Pine
 * run is a single-feed bar loop that finishes in milliseconds.
 */
import type { FastifyInstance } from "fastify";
import * as scripts from "../../repositories/pineScripts";
import * as candleRepo from "../../repositories/candles";
import * as symbolRepo from "../../repositories/symbols";
import { assertSymbol, ensureCandles, syncExchangeFilters } from "../../data/binanceRest";
import { toBars } from "../../engine/mtf";
import { Broker } from "../../engine/broker";
import { computeMetrics, downsampleEquity, toTradeRecords } from "../../engine/metrics";
import { PineInterpreter, PineRuntimeError } from "../../pine/interpreter";
import { PineSyntaxError } from "../../pine/lexer";
import { INTERVAL_MS, isInterval, type Interval } from "../../types/market";

/** Bars of history loaded before the requested start so indicators settle. */
const WARMUP_BARS = 1500;
const MAX_SOURCE_BYTES = 200_000;
/**
 * Upper bound on bars a single run may load. Caps both the interpreter's work
 * and, more importantly, the size of the Binance backfill a request can
 * trigger — a 10-year 1m range would otherwise be several million klines.
 */
const MAX_RUN_BARS = 120_000;
/**
 * Execution budget for an editor/chart run. Larger than the engine default,
 * which is sized for the live alert runner: a heavy multi-indicator script
 * over tens of thousands of bars legitimately takes tens of seconds, and
 * nothing time-critical is queued behind this request.
 */
const EDITOR_TIME_BUDGET_MS = Number(process.env.PINE_EDITOR_TIME_BUDGET_MS ?? 45_000);

/** UUID check so a malformed id 404s instead of erroring inside Postgres. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorsFrom(err: unknown): { line: number; col: number; message: string }[] | null {
  if (err instanceof PineSyntaxError) return [{ line: err.line, col: err.col, message: err.message }];
  if (err instanceof PineRuntimeError) return [{ line: err.line, col: 1, message: err.message }];
  // A pathological script can still exhaust the JS stack before the parser's
  // own depth guard trips. Report it as a script error, not a 500.
  if (err instanceof RangeError) {
    return [{ line: 1, col: 1, message: "script is too complex to compile (call stack exhausted)" }];
  }
  return null;
}

export async function pineRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/pine", async () => scripts.listScripts());

  app.get("/api/pine/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: "script not found" });
    const row = await scripts.getScript(id);
    if (!row) return reply.code(404).send({ error: "script not found" });
    return row;
  });

  app.post("/api/pine", async (req, reply) => {
    const body = req.body as { name?: string; source?: string };
    if (!body?.name?.trim() || typeof body.source !== "string") {
      return reply.code(400).send({ error: "name and source are required" });
    }
    if (body.source.length > MAX_SOURCE_BYTES) {
      return reply.code(400).send({ error: "script is too large" });
    }
    const { meta } = PineInterpreter.compile(body.source);
    return reply.code(201).send(
      await scripts.upsertScript({
        name: body.name.trim(),
        source: body.source,
        kind: meta.kind,
      })
    );
  });

  app.patch("/api/pine/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: "script not found" });
    const body = req.body as { name?: string; source?: string };
    if (body.source !== undefined && body.source.length > MAX_SOURCE_BYTES) {
      return reply.code(400).send({ error: "script is too large" });
    }
    const kind = body.source !== undefined
      ? PineInterpreter.compile(body.source).meta.kind
      : undefined;
    const row = await scripts.updateScript(id, {
      name: body.name?.trim(),
      source: body.source,
      kind,
    });
    if (!row) return reply.code(404).send({ error: "script not found" });
    return row;
  });

  app.delete("/api/pine/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: "script not found" });
    const ok = await scripts.deleteScript(id);
    if (!ok) return reply.code(404).send({ error: "script not found" });
    return reply.code(204).send();
  });

  /** Parse + declaration pass only: metadata, inputs and diagnostics. */
  app.post("/api/pine/compile", async (req, reply) => {
    const { source } = req.body as { source?: string };
    if (typeof source !== "string") {
      return reply.code(400).send({ error: "source is required" });
    }
    const { meta, errors } = PineInterpreter.compile(source);
    return { ok: errors.length === 0, meta, errors };
  });

  /**
   * Execute a script over real candles and return everything the chart needs:
   * plot series, shape markers, and (for strategies) trades, metrics and the
   * equity curve.
   */
  app.post("/api/pine/run", async (req, reply) => {
    const body = req.body as {
      source?: string;
      scriptId?: string;
      symbol?: string;
      timeframe?: string;
      startTime?: string;
      endTime?: string;
      params?: Record<string, number | string | boolean>;
      initialCapital?: number;
      commissionPct?: number;
      slippageTicks?: number;
      qtyCash?: number;
      qtyPctEquity?: number;
    };

    let source = body.source;
    if (source === undefined && body.scriptId) {
      if (!UUID_RE.test(body.scriptId)) return reply.code(404).send({ error: "script not found" });
      const row = await scripts.getScript(body.scriptId);
      if (!row) return reply.code(404).send({ error: "script not found" });
      source = row.source;
    }
    if (typeof source !== "string") {
      return reply.code(400).send({ error: "source or scriptId is required" });
    }
    const timeframe = body.timeframe ?? "";
    let symbol: string;
    try {
      symbol = assertSymbol(body.symbol ?? "");
    } catch {
      return reply.code(400).send({ error: "invalid symbol" });
    }
    if (!isInterval(timeframe)) return reply.code(400).send({ error: "invalid timeframe" });

    const endMs = body.endTime ? Date.parse(body.endTime) : Date.now();
    const startMs = body.startTime
      ? Date.parse(body.startTime)
      : endMs - 2000 * INTERVAL_MS[timeframe as Interval];
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      return reply.code(400).send({ error: "invalid start/end time" });
    }
    const requestedBars = (endMs - startMs) / INTERVAL_MS[timeframe as Interval];
    if (requestedBars > MAX_RUN_BARS) {
      return reply.code(400).send({
        error: `range is too large: ${Math.round(requestedBars).toLocaleString()} bars ` +
          `exceeds the ${MAX_RUN_BARS.toLocaleString()} limit for one run`,
      });
    }

    // Compile first so syntax errors never trigger a data fetch.
    const compiled = PineInterpreter.compile(source);
    if (compiled.errors.length > 0) {
      return { ok: false, errors: compiled.errors, meta: compiled.meta };
    }

    const interval = timeframe as Interval;
    const warmupFrom = startMs - WARMUP_BARS * INTERVAL_MS[interval];
    try {
      await ensureCandles(symbol, interval, warmupFrom, endMs, () => {});
    } catch (err) {
      return reply.code(502).send({ error: `market data unavailable: ${(err as Error).message}` });
    }
    const candles = await candleRepo.getCandles(symbol, interval, { from: warmupFrom, to: endMs });
    if (candles.length === 0) {
      return reply.code(404).send({ error: `no ${interval} data for ${symbol}` });
    }
    const bars = toBars(candles);
    const startIdx = Math.max(0, bars.time.findIndex((t) => t >= startMs));

    const isStrategy = compiled.meta.kind === "strategy";
    let broker: Broker | undefined;
    if (isStrategy) {
      let info = await symbolRepo.getSymbol(symbol);
      if (!info?.priceTick) {
        await syncExchangeFilters([symbol]);
        info = await symbolRepo.getSymbol(symbol);
      }
      const tickSize = info?.priceTick;
      if (!tickSize || tickSize <= 0) {
        return reply.code(400).send({ error: `no tick size available for ${symbol}` });
      }
      broker = new Broker({
        initialCapital: body.initialCapital ?? 1000,
        commissionPct: body.commissionPct ?? 0.1,
        slippageTicks: body.slippageTicks ?? 0,
        tickSize,
        qtyCash: body.qtyCash ?? 930,
        qtyPctEquity: body.qtyPctEquity ?? 0,
      });
    }

    try {
      const interp = new PineInterpreter(source);
      const out = interp.run({
        bars,
        startIdx,
        endIdx: bars.length - 1,
        params: body.params,
        broker,
        // A chart request has a user waiting on it and blocks nothing else,
        // so it gets a longer budget than the live alert runner's default.
        timeBudgetMs: EDITOR_TIME_BUDGET_MS,
      });

      return {
        ok: true,
        errors: [],
        meta: out.meta,
        times: out.times,
        plots: out.plots,
        hlines: out.hlines,
        shapes: out.shapes,
        drawings: out.drawings,
        ...(broker
          ? {
              trades: toTradeRecords(broker.closed),
              metrics: computeMetrics(
                broker.closed, out.equityCurve,
                broker.opts.initialCapital, broker.commissionPaid
              ),
              equityCurve: downsampleEquity(out.equityCurve),
            }
          : {}),
      };
    } catch (err) {
      const errors = errorsFrom(err);
      if (errors) return { ok: false, errors, meta: compiled.meta };
      throw err;
    }
  });
}
