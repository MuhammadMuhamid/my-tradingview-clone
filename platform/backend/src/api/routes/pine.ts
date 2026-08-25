/**
 * Pine editor API — save/compile/run user-authored Pine scripts.
 *
 * Running is interactive rather than queued through the backtest worker: the
 * editor needs plot data and compile diagnostics back immediately.
 *
 * `BE-23`: it used to run on THIS event loop with a 45-second budget, so one
 * heavy user script stalled every other request on the process — live alert
 * evaluation and webhook dispatch included. Execution now happens on a bounded
 * worker thread (`../../pine/runInWorker`): its own heap, a hard wall clock
 * enforced by terminating the thread, and a fixed number of concurrent runs.
 */
import type { FastifyInstance } from "fastify";
import * as scripts from "../../repositories/pineScripts";
import * as candleRepo from "../../repositories/candles";
import * as symbolRepo from "../../repositories/symbols";
import { assertSymbol, ensureCandles, syncExchangeFilters } from "../../data/binanceRest";
import { toBars, type Bars } from "../../engine/mtf";
import { PineInterpreter } from "../../pine/interpreter";
import { PineBusyError, runPineInWorker } from "../../pine/runInWorker";
import type { BrokerOptions } from "../../engine/broker";
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
    const { source, params } = req.body as {
      source?: string;
      params?: Record<string, number | string | boolean>;
    };
    if (typeof source !== "string") {
      return reply.code(400).send({ error: "source is required" });
    }
    // Params matter to the declaration pass: `meta.securityTimeframes` can
    // depend on an input, so the editor should report the feeds for the
    // settings actually in force.
    const { meta, errors } = PineInterpreter.compile(source, params);
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
    const compiled = PineInterpreter.compile(source, body.params);
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

    /**
     * Extra feeds for `request.security`. The declaration pass reports which
     * timeframes the script asks for, so they are fetched HERE — the run is
     * synchronous and cannot go and get data itself.
     *
     * Each feed is loaded from the same start as the chart, so a coarse
     * timeframe still has the warmup its own indicators need. A timeframe the
     * platform does not support is skipped; the run then fails naming it,
     * which is a better error than a silent wrong number.
     */
    const htf: Record<string, Bars> = {};
    for (const raw of compiled.meta.securityTimeframes) {
      const tf = normaliseTimeframe(raw);
      if (!tf || tf === interval) continue;
      if (INTERVAL_MS[tf] <= INTERVAL_MS[interval]) {
        // Lower timeframes would need intrabar data this engine does not keep.
        continue;
      }
      try {
        await ensureCandles(symbol, tf, warmupFrom, endMs, () => {});
      } catch {
        continue;
      }
      const rows = await candleRepo.getCandles(symbol, tf, { from: warmupFrom, to: endMs });
      if (rows.length > 0) htf[raw] = toBars(rows);
    }

    const isStrategy = compiled.meta.kind === "strategy";
    let brokerOptions: BrokerOptions | null = null;
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
      brokerOptions = {
        initialCapital: body.initialCapital ?? 1000,
        commissionPct: body.commissionPct ?? 0.1,
        slippageTicks: body.slippageTicks ?? 0,
        tickSize,
        qtyCash: body.qtyCash ?? 930,
        qtyPctEquity: body.qtyPctEquity ?? 0,
      };
    }

    let outcome;
    try {
      outcome = await runPineInWorker({
        source,
        bars,
        startIdx,
        endIdx: bars.length - 1,
        params: body.params,
        broker: brokerOptions,
        htf,
        // A chart request has a user waiting on it. It no longer blocks
        // anything else either, because it runs off this thread — but it is
        // still bounded, and the thread is terminated if it overruns.
        timeBudgetMs: EDITOR_TIME_BUDGET_MS,
      });
    } catch (err) {
      if (err instanceof PineBusyError) {
        return reply.code(503).send({ error: err.message });
      }
      throw err;
    }

    if (outcome.kind === "ok") return { ok: true, errors: [], ...outcome.run };
    if (outcome.kind === "script-error") {
      return { ok: false, errors: outcome.errors, meta: compiled.meta };
    }
    if (outcome.kind === "timeout") {
      return {
        ok: false,
        meta: compiled.meta,
        errors: [{
          line: 1, col: 1,
          message: `the script did not finish within ${Math.round(outcome.budgetMs / 1000)}s and was stopped`,
        }],
      };
    }
    return {
      ok: false,
      meta: compiled.meta,
      errors: [{ line: 1, col: 1, message: outcome.message }],
    };
  });
}

/**
 * Map the timeframe strings Pine scripts use onto the platform's intervals.
 *
 * Pine writes intraday minutes as a bare number ("60" is one hour) and days,
 * weeks and months as "D"/"W"/"M". Returns null for anything this platform has
 * no feed for, including weekly and monthly.
 */
export function normaliseTimeframe(raw: string): Interval | null {
  const t = raw.trim();
  if (t === "") return null;
  const upper = t.toUpperCase();
  if (upper === "D" || upper === "1D") return "1d";
  // Bare digits are minutes in Pine.
  if (/^\d+$/.test(t)) {
    const mins = Number(t);
    const byMinutes: Record<number, Interval> = {
      1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m",
      60: "1h", 120: "2h", 240: "4h", 360: "6h", 720: "12h", 1440: "1d",
    };
    return byMinutes[mins] ?? null;
  }
  return isInterval(t) ? t : null;
}
