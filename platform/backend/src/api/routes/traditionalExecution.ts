import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config";
import { canonicalJson, ManualBotError, traditionalBotRequest, type ManualBotRequestInput } from "../../manualTrading/client";
import { effectiveListingStatus, normalizeCanonicalInstrumentId, type CanonicalInstrument } from "../../market/model";
import { providerRegistry } from "../../market/providers";
import type { ProviderRegistry } from "../../market/registry";
import { cmeGlobexSessionOpen, oandaFxSessionOpen } from "../../market/traditionalMarkets";
import * as liveSafety from "../../repositories/liveSafety";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ALLOWED = new Set(["deploymentId", "dedupeKey", "barTime", "canonicalInstrumentId", "side", "quantity", "orderType", "limitPrice"]);

const bodyRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManualBotError("invalid request body", 400);
  const body = value as Record<string, unknown>;
  const forbidden = Object.keys(body).find((key) => !ALLOWED.has(key));
  if (forbidden) throw new ManualBotError(`unsupported or provider-derived field: ${forbidden}`, 400);
  return body;
};
const text = (body: Record<string, unknown>, key: string) => {
  if (typeof body[key] !== "string" || !body[key]) throw new ManualBotError(`${key} is required`, 400);
  return body[key] as string;
};
const decimal = (body: Record<string, unknown>, key: string, optional = false) => {
  const value = body[key]; if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !DECIMAL.test(value) || Number(value) <= 0) throw new ManualBotError(`${key} must be a positive decimal string`, 400);
  return value;
};
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
async function send<T>(reply: FastifyReply, action: () => Promise<T>): Promise<T | void> {
  try { return await action(); } catch (error) {
    if (error instanceof ManualBotError) return reply.code(error.status).send({ error: error.message }); throw error;
  }
}
async function resolve(registry: ProviderRegistry, id: string): Promise<CanonicalInstrument | null> {
  const venue = id.split(":")[2]; if (!venue) return null;
  for (const provider of registry.forVenue(venue)) {
    if (provider.catalog.availability.support !== "supported") continue;
    const found = (await registry.call(provider.id, (current) => current.catalog.list()))
      .find((row) => row.identity.canonicalId === id);
    if (found) return found;
  }
  return null;
}

export async function traditionalExecutionRoutes(app: FastifyInstance, dependencies: {
  registry?: ProviderRegistry; now?: () => number; botRequest?: (input: ManualBotRequestInput) => Promise<unknown>;
  claimIntent?: typeof liveSafety.claimIntent; resolveIntent?: typeof liveSafety.resolveIntent;
} = {}): Promise<void> {
  const registry = dependencies.registry ?? providerRegistry; const now = dependencies.now ?? Date.now;
  const botRequest = dependencies.botRequest ?? traditionalBotRequest;
  const claimIntent = dependencies.claimIntent ?? liveSafety.claimIntent;
  const resolveIntent = dependencies.resolveIntent ?? liveSafety.resolveIntent;
  app.get("/api/traditional-execution/v1/state", async (_req, reply) => send(reply, async () =>
    config.traditionalPaperExecutionEnabled ? botRequest({ method: "GET", path: "/api/traditional-execution/v1/state" })
      : { enabled: false, environments: ["OANDA_PRACTICE", "IBKR_PAPER"], externalHandshake: "UNVERIFIED_DISABLED",
        productionActivationAvailable: false }));
  app.post("/api/traditional-execution/v1/orders", async (req, reply) => send(reply, async () => {
    if (!config.traditionalPaperExecutionEnabled) throw new ManualBotError("traditional paper/practice execution is disabled", 404);
    const body = bodyRecord(req.body); const deploymentId = text(body, "deploymentId");
    const dedupeKey = text(body, "dedupeKey"); const barTime = Number(body.barTime);
    if (!UUID.test(deploymentId) || !/^[A-Za-z0-9:_-]{16,160}$/.test(dedupeKey) || !Number.isSafeInteger(barTime) || barTime <= 0) {
      throw new ManualBotError("durable deployment/dedupe/bar identity is invalid", 400);
    }
    const requested = text(body, "canonicalInstrumentId"); const canonicalId = normalizeCanonicalInstrumentId(requested);
    if (!canonicalId || canonicalId !== requested) throw new ManualBotError("canonicalInstrumentId is invalid", 422);
    const side = text(body, "side"); if (side !== "BUY" && side !== "SELL") throw new ManualBotError("side must be BUY or SELL", 422);
    const quantity = decimal(body, "quantity")!; const orderType = text(body, "orderType");
    if (orderType !== "MARKET" && orderType !== "LIMIT") throw new ManualBotError("orderType must be MARKET or LIMIT", 422);
    const limitPrice = decimal(body, "limitPrice", true);
    if ((orderType === "LIMIT") !== Boolean(limitPrice)) throw new ManualBotError("LIMIT requires limitPrice and MARKET forbids it", 422);
    const instrument = await resolve(registry, canonicalId);
    if (!instrument) throw new ManualBotError("canonical instrument is unavailable", 404);
    if (instrument.referenceIndex) throw new ManualBotError("cash/reference indices are read-only and cannot route to orders", 422);
    if (instrument.derivative.kind === "continuous_series") throw new ManualBotError("continuous futures series are research-only and cannot route to orders", 422);
    if (!instrument.fx && !instrument.futures) throw new ManualBotError("instrument is not an X5 FX/futures instrument", 422);
    if (!instrument.execution.availability.paper) throw new ManualBotError("instrument has no paper/practice capability", 422);
    const observedAt = now();
    if (effectiveListingStatus(instrument, observedAt) !== "active") throw new ManualBotError("contract/listing is stale or expired", 422);
    const open = instrument.fx ? oandaFxSessionOpen(observedAt) : cmeGlobexSessionOpen(observedAt);
    if (!open) throw new ManualBotError("provider/exchange session is closed; order was not sent to Bot", 422);
    if (instrument.futures && !Number.isInteger(Number(quantity))) throw new ManualBotError("futures quantity must be whole contracts", 422);
    if (limitPrice && instrument.precision.priceTick.state === "known") {
      const ticks = Number(limitPrice) / instrument.precision.priceTick.value;
      if (Math.abs(ticks - Math.round(ticks)) > 1e-8) throw new ManualBotError("limitPrice is off the contract/pair tick", 422);
    }
    const environment = instrument.fx ? "OANDA_PRACTICE" : "IBKR_PAPER";
    const command = { environment, canonicalInstrumentId: canonicalId, providerId: instrument.listing.providerId,
      providerSymbol: instrument.listing.providerSymbol, instrumentType: instrument.fx ? "FX_PAIR" : "FUTURE",
      side, positionDirection: side === "BUY" ? "LONG" : "SHORT", quantity, orderType,
      ...(limitPrice ? { limitPrice } : {}), priceBasis: instrument.fx ? (side === "BUY" ? "ASK" : "BID") : "EXCHANGE_ORDER",
      session: { open: true, observedAt: new Date(observedAt).toISOString(), calendarId: instrument.sessions.calendarId },
      contract: instrument.futures ? { root: instrument.futures.root, contractCode: instrument.futures.contractCode,
        expiry: instrument.futures.expiry, multiplier: instrument.futures.multiplier, tickSize: instrument.futures.tickSize,
        tickValue: instrument.futures.tickValue } : undefined };
    const claim = await claimIntent({ deploymentId, dedupeKey, action: side === "BUY" ? "buy" : "sell", barTime });
    if (!claim.claimed) return reply.code(409).send({ error: "this Platform X5 intent was already attempted; no retry was sent" });
    const platformIntent = { id: `x5_platform_intent_${claim.intent.id}`, dedupeKey,
      createdAt: new Date(claim.intent.createdAt).toISOString(), payloadHash: hash(command) };
    const result = await botRequest({ method: "POST", path: "/api/traditional-execution/v1/orders",
      requestId: platformIntent.id, body: { platformIntent, ...command } });
    await resolveIntent(claim.intent.id, "delivered", "Bot accepted durable X5 paper/practice intent; no automatic retry is permitted");
    return { ...(result as object), platformIntentId: platformIntent.id, dedupeKey };
  }));
}
