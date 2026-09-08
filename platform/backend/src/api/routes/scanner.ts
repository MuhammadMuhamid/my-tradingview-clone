import type { FastifyInstance, FastifyReply } from "fastify";
import { ScannerServiceError, scannerRequest } from "../../scanner/client";
import { parseResolution } from "../../data/resolution";

const TIMEFRAMES = new Set(["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "3d", "1w"]);
const INDICATORS = new Set(["ema", "rsi", "macd", "vfi", "adx", "candles", "supertrend", "sr"]);
const SLOTS = new Set(["1h", "15m", "5m"]);
const ASSET = /^[A-Z0-9]{1,20}$/;
const PRESET = /^[A-Za-z0-9_. -]{1,80}$/;
const PATTERN_SYMBOL = /^[A-Z0-9]{3,30}$/;

function record(value: unknown, label = "request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScannerServiceError(`${label} must be an object`, 400);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const invalid = Object.keys(value).filter((key) => !allowed.has(key));
  if (invalid.length) throw new ScannerServiceError(`${label} contains unsupported field ${invalid[0]}`, 400);
}

/** Only timeframe selection is mutable here; Scanner rules and parameters stay canonical. */
export function scannerConfigPatch(body: unknown): Record<string, unknown> {
  const source = record(body);
  exactKeys(source, new Set(["indicators", "strategy"]), "config patch");
  const patch: Record<string, unknown> = {};

  if (source.indicators !== undefined) {
    const indicators = record(source.indicators, "indicators");
    exactKeys(indicators, INDICATORS, "indicators");
    const clean: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(indicators)) {
      const spec = record(raw, `indicator ${name}`);
      exactKeys(spec, new Set(["timeframe"]), `indicator ${name}`);
      if (typeof spec.timeframe !== "string" || !TIMEFRAMES.has(spec.timeframe)) {
        throw new ScannerServiceError(`unsupported timeframe for ${name}`, 400);
      }
      clean[name] = { timeframe: spec.timeframe };
    }
    patch.indicators = clean;
  }

  if (source.strategy !== undefined) {
    const strategy = record(source.strategy, "strategy");
    exactKeys(strategy, new Set(["timeframes"]), "strategy");
    const timeframes = record(strategy.timeframes, "strategy timeframes");
    exactKeys(timeframes, SLOTS, "strategy timeframes");
    const clean: Record<string, string> = {};
    for (const [slot, timeframe] of Object.entries(timeframes)) {
      if (typeof timeframe !== "string" || !TIMEFRAMES.has(timeframe)) {
        throw new ScannerServiceError(`unsupported timeframe for ${slot} slot`, 400);
      }
      clean[slot] = timeframe;
    }
    patch.strategy = { timeframes: clean };
  }

  if (Object.keys(patch).length === 0) throw new ScannerServiceError("config patch is empty", 400);
  return patch;
}

function asset(value: string): string {
  const clean = value.toUpperCase();
  if (!ASSET.test(clean)) throw new ScannerServiceError("invalid Scanner asset", 400);
  return clean;
}

function preset(value: string): string {
  if (!PRESET.test(value)) throw new ScannerServiceError("invalid preset name", 400);
  return encodeURIComponent(value);
}

/** Strict allowlist for the explicit pattern-analysis service boundary. */
export function patternAnalysisRequest(value: unknown): Record<string, unknown> {
  const body = record(value, "pattern analysis");
  exactKeys(body, new Set([
    "venue", "market_type", "symbol", "timeframe", "as_of", "candles", "settings",
  ]), "pattern analysis");
  if (body.venue !== "BINANCE" || body.market_type !== "spot") {
    throw new ScannerServiceError("pattern analysis requires BINANCE spot provenance", 400);
  }
  if (typeof body.symbol !== "string" || !PATTERN_SYMBOL.test(body.symbol)) {
    throw new ScannerServiceError("invalid Binance Spot symbol", 400);
  }
  if (typeof body.timeframe !== "string" || parseResolution(body.timeframe) === null) {
    throw new ScannerServiceError("invalid chart timeframe", 400);
  }
  if (!Number.isSafeInteger(body.as_of) || Number(body.as_of) <= 0) {
    throw new ScannerServiceError("as_of must be a positive integer", 400);
  }
  if (!Array.isArray(body.candles) || body.candles.length < 1 || body.candles.length > 2_000) {
    throw new ScannerServiceError("candles must contain between 1 and 2000 bars", 400);
  }
  const allowedCandle = new Set(["open_time", "open", "high", "low", "close", "close_time"]);
  const candles = body.candles.map((raw, index) => {
    const candle = record(raw, `candle ${index}`);
    exactKeys(candle, allowedCandle, `candle ${index}`);
    for (const key of allowedCandle) {
      if (typeof candle[key] !== "number" || !Number.isFinite(candle[key])) {
        throw new ScannerServiceError(`candle ${index}.${key} must be finite`, 400);
      }
    }
    return candle;
  });
  if (body.settings !== undefined) record(body.settings, "settings");
  return { ...body, candles };
}

async function send<T>(reply: FastifyReply, action: () => Promise<T>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof ScannerServiceError) return reply.code(error.status).send({ error: error.message });
    throw error;
  }
}

/** Explicit operation list: this is intentionally not a generic HTTP proxy. */
export async function scannerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/scanner", (_req, reply) => send(reply,
    () => scannerRequest({ method: "GET", path: "/api/screener" })));
  app.get("/api/scanner/health", (_req, reply) => send(reply,
    () => scannerRequest({ method: "GET", path: "/api/health" })));
  app.get("/api/scanner/presets", (_req, reply) => send(reply,
    () => scannerRequest({ method: "GET", path: "/api/presets" })));
  app.get("/api/scanner/patterns/catalog", (_req, reply) => send(reply,
    () => scannerRequest({ method: "GET", path: "/api/patterns/catalog" })));
  app.post("/api/scanner/patterns/analyze", (req, reply) => send(reply,
    () => scannerRequest({
      method: "POST", path: "/api/patterns/analyze", body: patternAnalysisRequest(req.body),
    }, { timeoutMs: 30_000 })));

  app.patch("/api/scanner/config", (req, reply) => send(reply,
    () => scannerRequest({ method: "PATCH", path: "/api/config", body: scannerConfigPatch(req.body) })));
  app.post("/api/scanner/refresh", (req, reply) => send(reply, () => {
    const force = (req.query as { force?: unknown }).force;
    if (force !== undefined && force !== "true" && force !== "false") {
      throw new ScannerServiceError("force must be true or false", 400);
    }
    return scannerRequest({ method: "POST", path: `/api/refresh?force=${force === "true"}` });
  }));

  app.post("/api/scanner/symbols", (req, reply) => send(reply, () => {
    const body = record(req.body);
    exactKeys(body, new Set(["symbol"]), "symbol request");
    if (typeof body.symbol !== "string" || !/^[A-Za-z0-9]{1,20}\/[A-Za-z0-9]{1,20}$/.test(body.symbol)) {
      throw new ScannerServiceError("symbol must look like BASE/QUOTE", 400);
    }
    return scannerRequest({ method: "POST", path: "/api/symbols", body: { symbol: body.symbol.toUpperCase() } });
  }));
  app.delete<{ Params: { base: string; quote: string } }>("/api/scanner/symbols/:base/:quote", (req, reply) =>
    send(reply, () => scannerRequest({ method: "DELETE",
      path: `/api/symbols/${asset(req.params.base)}/${asset(req.params.quote)}` })));

  app.get<{ Params: { base: string; quote: string } }>("/api/scanner/calibration/:base/:quote", (req, reply) =>
    send(reply, () => scannerRequest({ method: "GET",
      path: `/api/calibration/${asset(req.params.base)}/${asset(req.params.quote)}` })));
  app.post<{ Params: { base: string; quote: string } }>("/api/scanner/calibrate/:base/:quote", (req, reply) =>
    send(reply, () => scannerRequest({ method: "POST",
      path: `/api/calibrate/${asset(req.params.base)}/${asset(req.params.quote)}?with_sr=true` },
      { timeoutMs: 60_000 })));

  app.post("/api/scanner/presets", (req, reply) => send(reply, () => {
    const body = record(req.body);
    exactKeys(body, new Set(["name"]), "preset request");
    if (typeof body.name !== "string") throw new ScannerServiceError("preset name is required", 400);
    preset(body.name);
    return scannerRequest({ method: "POST", path: "/api/presets", body: { name: body.name } });
  }));
  app.post<{ Params: { name: string } }>("/api/scanner/presets/:name/load", (req, reply) =>
    send(reply, () => scannerRequest({ method: "POST", path: `/api/presets/${preset(req.params.name)}/load` })));
  app.delete<{ Params: { name: string } }>("/api/scanner/presets/:name", (req, reply) =>
    send(reply, () => scannerRequest({ method: "DELETE", path: `/api/presets/${preset(req.params.name)}` })));
}
