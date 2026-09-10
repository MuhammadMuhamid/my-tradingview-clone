import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config";
import { canonicalJson, derivativeBotRequest, ManualBotError, type ManualBotRequestInput } from "../../manualTrading/client";
import * as liveSafety from "../../repositories/liveSafety";
import { evaluateShariahGate } from "../../shariah/gate";

const VENUES = ["binance", "bybit", "okx", "kucoin", "gateio", "kraken", "hyperliquid", "coinbase"] as const;
const ENVIRONMENTS = ["paper", "testnet", "demo"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const record = (value: unknown, label = "request body"): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManualBotError(`invalid ${label}`, 400);
  return value as Record<string, unknown>;
};
const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key]; if (typeof value !== "string" || value.length === 0) throw new ManualBotError(`${key} is required`, 400); return value;
};
const choice = <T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[]): T => {
  const value = text(body, key); if (!allowed.includes(value as T)) throw new ManualBotError(`unsupported ${key}`, 422); return value as T;
};
const positive = (body: Record<string, unknown>, key: string, optional = false): string | undefined => {
  const value = body[key]; if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length > 80 || !DECIMAL.test(value)
      || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new ManualBotError(`${key} must be a bounded positive decimal string`, 400);
  return value;
};
const optionalText = (body: Record<string, unknown>, key: string): string | undefined => {
  const value = body[key]; if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new ManualBotError(`${key} must be text`, 400); return value;
};

function derivativePayloadHash(body: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ accountId: body.accountId, venue: body.venue,
    environment: body.environment, canonicalInstrumentId: body.canonicalInstrumentId, venueSymbol: body.venueSymbol,
    instrument: body.instrument, positionDirection: body.positionDirection, actionSide: body.actionSide,
    quantityUnit: body.quantityUnit, quantity: body.quantity ?? null, marginMode: body.marginMode,
    leverage: body.leverage ?? null, positionMode: body.positionMode, reduceOnly: body.reduceOnly,
    closePosition: body.closePosition, orderType: body.orderType, timeInForce: body.timeInForce ?? null,
    limitPrice: body.limitPrice ?? null, protective: body.protective ?? null,
    paperReferencePrice: body.paperReferencePrice ?? null, position: body.position ?? null,
    shariah: body.shariah ?? null })).digest("hex");
}

async function send<T>(reply: FastifyReply, action: () => Promise<T>): Promise<T | void> {
  try { return await action(); }
  catch (error) { if (error instanceof ManualBotError) return reply.code(error.status).send({ error: error.message }); throw error; }
}

function parseCommand(body: Record<string, unknown>): Record<string, unknown> {
  const instrumentRaw = record(body.instrument, "instrument");
  const instrument = { kind: choice(instrumentRaw, "kind", ["LINEAR", "INVERSE"]),
    contractSize: positive(instrumentRaw, "contractSize")!,
    baseCurrency: text(instrumentRaw, "baseCurrency"), quoteCurrency: text(instrumentRaw, "quoteCurrency"),
    settlementCurrency: text(instrumentRaw, "settlementCurrency"), marginCurrency: text(instrumentRaw, "marginCurrency"),
    ...(optionalText(instrumentRaw, "expiry") ? { expiry: optionalText(instrumentRaw, "expiry") } : {}) };
  for (const currency of [instrument.baseCurrency, instrument.quoteCurrency, instrument.settlementCurrency,
    instrument.marginCurrency]) if (!/^[A-Z0-9]{2,16}$/.test(currency)) throw new ManualBotError("instrument currency is invalid", 400);
  if (instrument.expiry && !Number.isFinite(Date.parse(instrument.expiry))) throw new ManualBotError("instrument expiry is invalid", 400);
  let position: Record<string, unknown> | undefined;
  if (body.position !== undefined) {
    const raw = record(body.position, "position");
    position = { direction: choice(raw, "direction", ["LONG", "SHORT"]), contracts: positive(raw, "contracts")!,
      entryPrice: positive(raw, "entryPrice")!, markPrice: positive(raw, "markPrice")!, observedAt: text(raw, "observedAt"),
      version: text(raw, "version"), ...(positive(raw, "liquidationPrice", true) ? { liquidationPrice: positive(raw, "liquidationPrice", true) } : {}),
      ...(positive(raw, "maintenanceMargin", true) ? { maintenanceMargin: positive(raw, "maintenanceMargin", true) } : {}) };
    if (!Number.isFinite(Date.parse(String(position.observedAt))) || !/^[A-Za-z0-9:_-]{8,160}$/.test(String(position.version))) {
      throw new ManualBotError("position observation identity/time is invalid", 400);
    }
  }
  let protective: Record<string, unknown> | undefined;
  if (body.protective !== undefined) {
    const raw = record(body.protective, "protective order");
    protective = { kind: choice(raw, "kind", ["STOP_LOSS", "TAKE_PROFIT"]),
      triggerPrice: positive(raw, "triggerPrice")!, triggerPriceRole: choice(raw, "triggerPriceRole", ["MARK", "INDEX", "LAST"]),
      paperTriggerModel: choice(raw, "paperTriggerModel", ["COMPLETED_CANDLE_MARKET_AFTER_CLOSE"]) };
  }
  if (body.shariah !== undefined) throw new ManualBotError(
    "shariah is Platform authority and cannot be asserted by an execution caller", 400);
  const accountId = text(body, "accountId"); if (!UUID.test(accountId)) throw new ManualBotError("accountId must be a UUID", 400);
  const canonicalInstrumentId = text(body, "canonicalInstrumentId");
  if (canonicalInstrumentId.length < 8 || canonicalInstrumentId.length > 240) throw new ManualBotError("canonicalInstrumentId is outside bounds", 400);
  const venueSymbol = text(body, "venueSymbol"); if (!/^[A-Za-z0-9:/_.-]{2,50}$/.test(venueSymbol)) throw new ManualBotError("venueSymbol is invalid", 400);
  if (typeof body.reduceOnly !== "boolean" || typeof body.closePosition !== "boolean") throw new ManualBotError("reduceOnly and closePosition must be booleans", 400);
  return { accountId, venue: choice(body, "venue", VENUES), environment: choice(body, "environment", ENVIRONMENTS),
    canonicalInstrumentId, venueSymbol, instrument, positionDirection: choice(body, "positionDirection", ["LONG", "SHORT"]),
    actionSide: choice(body, "actionSide", ["BUY", "SELL"]), quantityUnit: choice(body, "quantityUnit", ["CONTRACTS", "BASE"]),
    quantity: positive(body, "quantity", true), marginMode: choice(body, "marginMode", ["ISOLATED", "CROSS"]),
    leverage: positive(body, "leverage", true), positionMode: choice(body, "positionMode", ["ONE_WAY", "HEDGE"]),
    reduceOnly: body.reduceOnly, closePosition: body.closePosition,
    orderType: choice(body, "orderType", ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]),
    ...(optionalText(body, "timeInForce") ? { timeInForce: choice(body, "timeInForce", ["GTC", "IOC", "FOK", "GTD", "POST_ONLY"]) } : {}),
    limitPrice: positive(body, "limitPrice", true), ...(protective ? { protective } : {}),
    paperReferencePrice: positive(body, "paperReferencePrice", true), ...(position ? { position } : {}) };
}

export async function derivativeExecutionRoutes(app: FastifyInstance, dependencies: {
  botRequest?: (input: ManualBotRequestInput) => Promise<unknown>;
  claimIntent?: typeof liveSafety.claimIntent;
  resolveIntent?: typeof liveSafety.resolveIntent;
  evaluateShariah?: typeof evaluateShariahGate;
} = {}): Promise<void> {
  const botRequest = dependencies.botRequest ?? derivativeBotRequest;
  const claimIntent = dependencies.claimIntent ?? liveSafety.claimIntent;
  const resolveIntent = dependencies.resolveIntent ?? liveSafety.resolveIntent;
  const shariahGate = dependencies.evaluateShariah ?? evaluateShariahGate;
  app.get("/api/derivative-execution/v1/state", async (_req, reply) => send(reply, async () => {
    if (!config.derivativeExecutionEnabled) return { enabled: false, mode: "PAPER_TESTNET_ONLY",
      productionActivationAvailable: false, warning: "Derivatives execution is disabled" };
    return botRequest({ method: "GET", path: "/api/derivative-execution/v1/state" });
  }));
  app.post("/api/derivative-execution/v1/orders", async (req, reply) => send(reply, async () => {
    if (!config.derivativeExecutionEnabled) throw new ManualBotError("paper/testnet derivatives execution is disabled", 404);
    const body = record(req.body); const deploymentId = text(body, "deploymentId"); const dedupeKey = text(body, "dedupeKey");
    if (!UUID.test(deploymentId) || !/^[A-Za-z0-9:_-]{16,160}$/.test(dedupeKey)) throw new ManualBotError("durable deployment/dedupe identity is invalid", 400);
    const barTime = Number(body.barTime); if (!Number.isSafeInteger(barTime) || barTime <= 0) throw new ManualBotError("barTime must be a positive integer", 400);
    const parsed = parseCommand(body); const instrument = parsed.instrument as Record<string, string>;
    const reducing = parsed.reduceOnly === true || parsed.closePosition === true;
    const shariah = await shariahGate({ symbol: `${instrument.baseCurrency}${instrument.quoteCurrency}`,
      side: reducing ? "SELL" : "BUY" });
    if (!shariah.allowed) throw new ManualBotError(shariah.reason ?? "blocked by Shariah Mode", 403);
    const command: Record<string, unknown> = { ...parsed, shariah: shariah.context };
    const actionSide = command.actionSide as "BUY" | "SELL";
    const claim = await claimIntent({ deploymentId, dedupeKey, action: actionSide === "BUY" ? "buy" : "sell", barTime });
    if (!claim.claimed) {
      if (claim.existing.state === "delivered" || claim.existing.state === "duplicate") return { status: "duplicate", platformIntentId: String(claim.existing.id), dedupeKey };
      return reply.code(409).send({ error: "this Platform derivative intent was already attempted; outcome is unresolved and no retry was sent", platformIntentId: String(claim.existing.id) });
    }
    const intent = { id: `x3b_platform_intent_${claim.intent.id}`, dedupeKey,
      createdAt: new Date(claim.intent.createdAt).toISOString(), payloadHash: derivativePayloadHash(command) };
    const result = await botRequest({ method: "POST", path: "/api/derivative-execution/v1/orders",
      body: { platformIntent: intent, ...command }, requestId: intent.id });
    await resolveIntent(claim.intent.id, "delivered", "Bot accepted durable X3B intent; provider lifecycle is reconciled by Bot");
    return { ...(result as object), platformIntentId: intent.id, dedupeKey };
  }));
  app.post<{ Params: { id: string } }>("/api/derivative-execution/v1/orders/:id/cancel",
    async (req, reply) => send(reply, async () => {
      if (!config.derivativeExecutionEnabled) throw new ManualBotError("paper/testnet derivatives execution is disabled", 404);
      if (!UUID.test(req.params.id)) throw new ManualBotError("invalid derivatives execution order id", 400);
      const requestId = text(record(req.body), "requestId");
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) throw new ManualBotError("requestId must be a durable identity", 400);
      return botRequest({ method: "POST", path: `/api/derivative-execution/v1/orders/${encodeURIComponent(req.params.id)}/cancel`, requestId });
    }));
}
