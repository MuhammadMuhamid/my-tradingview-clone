import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config";
import { canonicalJson, equityBotRequest, ManualBotError, type ManualBotRequestInput } from "../../manualTrading/client";
import { assertExecutionSupported, UnsupportedExecutionError } from "../../market/execution";
import type { CanonicalInstrument } from "../../market/model";
import { normalizeCanonicalInstrumentId } from "../../market/model";
import type { ProviderRegistry } from "../../market/registry";
import { providerRegistry } from "../../market/providers";
import { equityCalendarDate, equitySessionPhase } from "../../market/usEquities";
import * as liveSafety from "../../repositories/liveSafety";
import { evaluateShariahGate } from "../../shariah/gate";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ID = /^instrument:v1:(NASDAQ|NYSE|ARCA|AMEX|BATS):(stock|etf):([A-Z][A-Z0-9.-]{0,14}):USD:USD:cash$/;
const ALLOWED_FIELDS = new Set(["deploymentId", "dedupeKey", "barTime", "canonicalInstrumentId", "side",
  "positionEffect", "quantity", "orderType", "timeInForce", "limitPrice", "extendedHours"]);

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManualBotError("invalid request body", 400);
  const body = value as Record<string, unknown>;
  const forbidden = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
  if (forbidden.length > 0) throw new ManualBotError(`unsupported or provider-derived field: ${forbidden[0]}`, 400);
  return body;
};
const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new ManualBotError(`${key} is required`, 400);
  return value;
};
const choice = <T extends string>(body: Record<string, unknown>, key: string, values: readonly T[]): T => {
  const value = text(body, key);
  if (!values.includes(value as T)) throw new ManualBotError(`unsupported ${key}`, 422);
  return value as T;
};
const positive = (body: Record<string, unknown>, key: string, optional = false): string | undefined => {
  const value = body[key];
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 40 || !DECIMAL.test(value) || Number(value) <= 0) {
    throw new ManualBotError(`${key} must be a bounded positive decimal string`, 400);
  }
  return value;
};

function payloadHash(command: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(command)).digest("hex");
}

async function send<T>(reply: FastifyReply, action: () => Promise<T>): Promise<T | void> {
  try { return await action(); }
  catch (error) {
    if (error instanceof ManualBotError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof UnsupportedExecutionError) return reply.code(error.status).send({ error: error.message });
    throw error;
  }
}

function assertOrderShape(input: {
  side: "BUY" | "SELL";
  positionEffect: "OPEN_LONG" | "CLOSE_LONG" | "OPEN_SHORT" | "COVER_SHORT";
  quantity: string;
  orderType: "MARKET" | "LIMIT";
  timeInForce: "DAY" | "GTC";
  limitPrice?: string;
  extendedHours: boolean;
}, instrument: CanonicalInstrument): void {
  const sideByEffect = { OPEN_LONG: "BUY", CLOSE_LONG: "SELL", OPEN_SHORT: "SELL", COVER_SHORT: "BUY" } as const;
  if (input.side !== sideByEffect[input.positionEffect]) throw new ManualBotError("side does not match positionEffect", 422);
  if (input.orderType === "LIMIT" && input.limitPrice === undefined) throw new ManualBotError("LIMIT orders require limitPrice", 422);
  if (input.orderType === "MARKET" && input.limitPrice !== undefined) throw new ManualBotError("MARKET orders cannot include limitPrice", 422);
  if (instrument.equity?.fractional.support === "unsupported" && !Number.isInteger(Number(input.quantity))) {
    throw new ManualBotError("this asset is not fractionable; quantity must be whole shares", 422);
  }
  if (!Number.isInteger(Number(input.quantity)) && input.timeInForce !== "DAY") {
    throw new ManualBotError("fractional equity orders require DAY time in force", 422);
  }
  if (input.extendedHours && input.orderType !== "LIMIT") {
    throw new ManualBotError("an extended-hours-eligible order must be LIMIT", 422);
  }
  if (input.limitPrice !== undefined) {
    const decimals = input.limitPrice.split(".")[1]?.length ?? 0;
    const maximum = Number(input.limitPrice) >= 1 ? 2 : 4;
    if (decimals > maximum) throw new ManualBotError(`limitPrice permits at most ${maximum} decimal places at this price`, 422);
  }
}

export async function equityExecutionRoutes(app: FastifyInstance, dependencies: {
  botRequest?: (input: ManualBotRequestInput) => Promise<unknown>;
  registry?: ProviderRegistry;
  providerId?: string;
  now?: () => number;
  claimIntent?: typeof liveSafety.claimIntent;
  resolveIntent?: typeof liveSafety.resolveIntent;
  evaluateShariah?: typeof evaluateShariahGate;
} = {}): Promise<void> {
  const botRequest = dependencies.botRequest ?? equityBotRequest;
  const providers = dependencies.registry ?? providerRegistry;
  const providerId = dependencies.providerId ?? "alpaca-us-equities";
  const now = dependencies.now ?? Date.now;
  const claimIntent = dependencies.claimIntent ?? liveSafety.claimIntent;
  const resolveIntent = dependencies.resolveIntent ?? liveSafety.resolveIntent;
  const shariahGate = dependencies.evaluateShariah ?? evaluateShariahGate;

  app.get("/api/equity-execution/v1/state", async (_req, reply) => send(reply, async () => {
    if (!config.equityPaperExecutionEnabled) return { enabled: false, mode: "ALPACA_PAPER_ONLY",
      externalHandshake: "UNVERIFIED_DISABLED", productionActivationAvailable: false,
      warning: "Alpaca paper equity execution is disabled" };
    return botRequest({ method: "GET", path: "/api/equity-execution/v1/state" });
  }));

  app.post("/api/equity-execution/v1/orders", async (req, reply) => send(reply, async () => {
    if (!config.equityPaperExecutionEnabled) throw new ManualBotError("Alpaca paper equity execution is disabled", 404);
    const body = record(req.body);
    const deploymentId = text(body, "deploymentId");
    const dedupeKey = text(body, "dedupeKey");
    const barTime = Number(body.barTime);
    if (!UUID.test(deploymentId) || !/^[A-Za-z0-9:_-]{16,160}$/.test(dedupeKey)) {
      throw new ManualBotError("durable deployment/dedupe identity is invalid", 400);
    }
    if (!Number.isSafeInteger(barTime) || barTime <= 0) throw new ManualBotError("barTime must be a positive integer", 400);
    const requestedId = text(body, "canonicalInstrumentId");
    const canonicalInstrumentId = normalizeCanonicalInstrumentId(requestedId);
    const identity = canonicalInstrumentId ? ID.exec(canonicalInstrumentId) : null;
    if (!identity || canonicalInstrumentId !== requestedId) throw new ManualBotError("canonicalInstrumentId is not a supported U.S. stock/ETF identity", 422);
    const side = choice(body, "side", ["BUY", "SELL"] as const);
    const positionEffect = choice(body, "positionEffect", ["OPEN_LONG", "CLOSE_LONG", "OPEN_SHORT", "COVER_SHORT"] as const);
    const quantity = positive(body, "quantity")!;
    const orderType = choice(body, "orderType", ["MARKET", "LIMIT"] as const);
    const timeInForce = choice(body, "timeInForce", ["DAY", "GTC"] as const);
    const limitPrice = positive(body, "limitPrice", true);
    if (typeof body.extendedHours !== "boolean") throw new ManualBotError("extendedHours must be a boolean", 400);
    const extendedHours = body.extendedHours;

    const provider = providers.get(providerId);
    if (!provider?.equities) throw new ManualBotError("official Alpaca U.S. equity provider is unavailable", 503);
    // One clock sample binds both provider observations. If either official
    // request is slow, Bot's 30/60-second freshness gates reject the command.
    const observedAt = now();
    const rows = await providers.call(providerId, (current) => current.catalog.metadata([identity[3]!]));
    const instrument = rows.find((row) => row.identity.canonicalId === canonicalInstrumentId);
    if (!instrument?.equity) throw new ManualBotError("canonical stock/ETF listing was not found at its declared venue", 404);
    const calendarDate = equityCalendarDate(observedAt);
    const days = await providers.call(providerId, (current) => current.equities!.calendar.days(calendarDate, calendarDate));
    const phase = equitySessionPhase(observedAt, days);
    assertOrderShape({ side, positionEffect, quantity, orderType, timeInForce, limitPrice, extendedHours }, instrument);
    assertExecutionSupported({ providerId, venueId: instrument.identity.venueId,
      instrumentType: instrument.identity.instrumentType, capabilities: instrument.execution,
      marketState: { kind: "calendar", phase, listingStatus: instrument.listing.status,
        observedAt: new Date(observedAt).toISOString() } }, {
      environment: "paper", positionDirection: positionEffect === "OPEN_SHORT" ? "short" : "long",
      orderType, timeInForce, extendedHours,
    });

    const opening = positionEffect === "OPEN_LONG" || positionEffect === "OPEN_SHORT";
    const shariah = await shariahGate({ symbol: instrument.identity.baseAsset, side: opening ? "BUY" : "SELL" });
    if (!shariah.allowed) throw new ManualBotError(shariah.reason ?? "blocked by Shariah Mode", 403);
    const command: Record<string, unknown> = { environment: "paper", canonicalInstrumentId,
      providerSymbol: instrument.listing.providerSymbol,
      instrumentType: instrument.identity.instrumentType === "stock" ? "STOCK" : "ETF",
      primaryVenue: instrument.equity.primaryListing.venueId, side, positionEffect, quantity,
      orderType, timeInForce, ...(limitPrice === undefined ? {} : { limitPrice }), extendedHours,
      adjustmentMode: "raw",
      session: { phase: phase.toUpperCase(), observedAt: new Date(observedAt).toISOString(), calendarDate },
      asset: { status: instrument.listing.status === "active" ? "ACTIVE" : "INACTIVE",
        tradable: instrument.execution.availability.paper,
        fractionable: instrument.equity.fractional.support === "supported",
        shortable: instrument.equity.borrow.shortable === "unknown" ? null : instrument.equity.borrow.shortable === "yes",
        borrowStatus: instrument.equity.borrow.status.toUpperCase(), observedAt: new Date(observedAt).toISOString() } };
    const claim = await claimIntent({ deploymentId, dedupeKey, action: side === "BUY" ? "buy" : "sell", barTime });
    if (!claim.claimed) {
      if (claim.existing.state === "delivered" || claim.existing.state === "duplicate") {
        return { status: "duplicate", platformIntentId: String(claim.existing.id), dedupeKey };
      }
      return reply.code(409).send({ error: "this Platform equity intent was already attempted; outcome is unresolved and no retry was sent",
        platformIntentId: String(claim.existing.id) });
    }
    const intent = { id: `x4_platform_intent_${claim.intent.id}`, dedupeKey,
      createdAt: new Date(claim.intent.createdAt).toISOString(), payloadHash: payloadHash(command) };
    const result = await botRequest({ method: "POST", path: "/api/equity-execution/v1/orders",
      body: { platformIntent: intent, ...command }, requestId: intent.id });
    await resolveIntent(claim.intent.id, "delivered", "Bot accepted durable X4 Alpaca paper intent; no automatic retry is permitted");
    return { ...(result as object), platformIntentId: intent.id, dedupeKey };
  }));
}
