import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config";
import { ManualBotError, spotBotRequest, canonicalJson,
  type ManualBotRequestInput } from "../../manualTrading/client";
import * as liveSafety from "../../repositories/liveSafety";
import {
  assertShariahExposureAllowed, ShariahExposureBlockedError, type ShariahGateDeps,
} from "../../shariah/gate";
import { normalizeCanonicalInstrumentId } from "../../market/model";

const VENUES = ["binance", "coinbase", "bybit", "okx", "kraken", "kucoin", "gateio", "robinhood", "hyperliquid"] as const;
const ENVIRONMENTS = ["paper", "testnet", "demo"] as const;
const ORDER_TYPES = ["MARKET", "LIMIT", "LIMIT_MAKER"] as const;
const TIME_IN_FORCE = ["GTC", "IOC", "FOK", "GTD", "POST_ONLY"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key]; if (typeof value !== "string" || value.length === 0) throw new ManualBotError(`${key} is required`, 400); return value;
};
const positive = (body: Record<string, unknown>, key: string, optional = false): string | undefined => {
  const value = body[key]; if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
      || !Number.isFinite(Number(value)) || !(Number(value) > 0)) {
    throw new ManualBotError(`${key} must be a bounded positive decimal string`, 400);
  }
  return value;
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManualBotError("invalid request body", 400); return value as Record<string, unknown>;
};
function payloadHash(body: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ accountId: body.accountId, venue: body.venue, environment: body.environment,
    canonicalInstrumentId: body.canonicalInstrumentId, venueSymbol: body.venueSymbol, side: body.side, orderType: body.orderType,
    timeInForce: body.timeInForce ?? null, baseQuantity: body.baseQuantity ?? null, quoteQuantity: body.quoteQuantity ?? null,
    limitPrice: body.limitPrice ?? null, paperReferencePrice: body.paperReferencePrice ?? null })).digest("hex");
}
async function send<T>(reply: FastifyReply, action: () => Promise<T>): Promise<T | void> {
  try { return await action(); } catch (error) {
    // A Shariah refusal is an answer carrying the mode and policy that produced it.
    if (error instanceof ShariahExposureBlockedError) {
      return reply.code(error.status).send({ error: error.message, shariah: error.context });
    }
    if (error instanceof ManualBotError) return reply.code(error.status).send({ error: error.message });
    throw error;
  }
}

/**
 * The registry key for a canonical spot instrument, or null.
 *
 * X3A routes spot orders at nine venues, and a Shariah classification is about
 * the ASSET rather than the venue it is bought at: BTC is BTC whether the order
 * goes to Binance or to Kraken. The registry is keyed on the Binance Spot USDT
 * base-asset set, so the base is lifted out of the canonical id and asked about
 * in the form the registry holds. A non-spot id, or one whose base cannot be
 * read, yields null — which the gate resolves to REVIEW and refuses while
 * enforcing, never to an exemption.
 */
function registrySymbolFor(canonicalInstrumentId: string): string | null {
  const canonical = normalizeCanonicalInstrumentId(canonicalInstrumentId);
  if (!canonical) return null;
  const parts = canonical.split(":");
  // instrument:v1:<venue>:<type>:<base>:<quote>:<settlement>:<series>
  if (parts.length !== 8 || parts[3] !== "spot") return null;
  const base = parts[4];
  return base && base.length > 0 ? `${base}USDT` : null;
}

export async function spotExecutionRoutes(app: FastifyInstance, dependencies: {
  botRequest?: (input: ManualBotRequestInput) => Promise<unknown>;
  claimIntent?: typeof liveSafety.claimIntent;
  resolveIntent?: typeof liveSafety.resolveIntent;
  /** Registry and mode readers, so the gate is provable without a database. */
  shariah?: ShariahGateDeps;
} = {}): Promise<void> {
  const botRequest = dependencies.botRequest ?? spotBotRequest;
  const shariahDeps: ShariahGateDeps = dependencies.shariah ?? {};
  const claimIntent = dependencies.claimIntent ?? liveSafety.claimIntent;
  const resolveIntent = dependencies.resolveIntent ?? liveSafety.resolveIntent;
  app.get("/api/spot-execution/v1/state", async (_req, reply) => send(reply, async () => {
    if (!config.spotExecutionEnabled) return { enabled: false, mode: "PAPER_TESTNET_ONLY", productionActivationAvailable: false, warning: "Spot execution is disabled" };
    return botRequest({ method: "GET", path: "/api/spot-execution/v1/state" });
  }));
  app.post("/api/spot-execution/v1/orders", async (req, reply) => send(reply, async () => {
    if (!config.spotExecutionEnabled) throw new ManualBotError("paper/testnet spot execution is disabled", 404);
    const body = record(req.body); const deploymentId = text(body, "deploymentId"); const dedupeKey = text(body, "dedupeKey");
    if (!UUID.test(deploymentId)) throw new ManualBotError("deploymentId must be a UUID", 400);
    if (!/^[A-Za-z0-9:_-]{16,160}$/.test(dedupeKey)) throw new ManualBotError("dedupeKey must be a durable bounded identity", 400);
    const barTime = Number(body.barTime); if (!Number.isSafeInteger(barTime) || barTime <= 0) throw new ManualBotError("barTime must be a positive integer", 400);
    const venue = text(body, "venue"); if (!(VENUES as readonly string[]).includes(venue)) throw new ManualBotError("unsupported spot venue", 422);
    const environment = text(body, "environment"); if (!(ENVIRONMENTS as readonly string[]).includes(environment)) throw new ManualBotError("unsupported execution environment", 422);
    const command = { accountId: text(body, "accountId"), canonicalInstrumentId: text(body, "canonicalInstrumentId"), venueSymbol: text(body, "venueSymbol"),
      side: text(body, "side"), orderType: text(body, "orderType"), venue, environment, timeInForce: body.timeInForce,
      baseQuantity: positive(body, "baseQuantity", true), quoteQuantity: positive(body, "quoteQuantity", true),
      limitPrice: positive(body, "limitPrice", true), paperReferencePrice: positive(body, "paperReferencePrice", true) };
    if (command.side !== "BUY" && command.side !== "SELL") throw new ManualBotError("side must be BUY or SELL", 400);
    if (!UUID.test(command.accountId)) throw new ManualBotError("accountId must be a UUID", 400);
    if (command.canonicalInstrumentId.length < 8 || command.canonicalInstrumentId.length > 240) {
      throw new ManualBotError("canonicalInstrumentId is outside bounds", 400);
    }
    if (!/^[A-Za-z0-9:/_.-]{2,40}$/.test(command.venueSymbol)) throw new ManualBotError("venueSymbol is invalid", 400);
    if (!(ORDER_TYPES as readonly string[]).includes(command.orderType)) throw new ManualBotError("unsupported spot order type", 422);
    if (command.timeInForce !== undefined
        && (!(typeof command.timeInForce === "string")
          || !(TIME_IN_FORCE as readonly string[]).includes(command.timeInForce))) {
      throw new ManualBotError("unsupported time in force", 422);
    }
    /*
     * X3A creates Spot exposure at nine venues and called no gate at all — the
     * one claim `gate.ts` makes about itself ("every Platform path capable of
     * producing a Spot BUY calls this") was not true of this file, and the test
     * asserting it inspected two other routes by name. It is gated before the
     * intent is claimed, so a refused order consumes no dedupe identity.
     */
    /*
     * No `?? command.venueSymbol` fallback.
     *
     * `registrySymbolFor` answers null for a canonical id that is not spot, and
     * the comment on it says null "refuses while enforcing, never an exemption".
     * Falling back to the venue symbol broke exactly that: a perpetual's venue
     * symbol reduces to a base asset, so a derivative would have been cleared on
     * BTC's SPOT verdict — structurally the same defect the derivatives route
     * was just repaired for.
     *
     * An empty string resolves to no registry identity, which `gate.ts` maps to
     * REVIEW and refuses while enforcing. That is the intended fail-closed path.
     */
    const shariah = await assertShariahExposureAllowed(
      { symbol: registrySymbolFor(command.canonicalInstrumentId) ?? "", side: command.side },
      shariahDeps,
    );
    const claim = await claimIntent({ deploymentId, dedupeKey, action: command.side === "BUY" ? "buy" : "sell", barTime });
    if (!claim.claimed) {
      if (claim.existing.state === "delivered" || claim.existing.state === "duplicate") return { status: "duplicate", platformIntentId: String(claim.existing.id), dedupeKey };
      return reply.code(409).send({ error: "this Platform order intent was already attempted; outcome is unresolved and no retry was sent", platformIntentId: String(claim.existing.id) });
    }
    const intent = { id: `x3a_platform_intent_${claim.intent.id}`, dedupeKey, createdAt: new Date(claim.intent.createdAt).toISOString(), payloadHash: payloadHash(command) };
    const result = await botRequest({ method: "POST", path: "/api/spot-execution/v1/orders",
      body: { platformIntent: intent, ...command, shariah }, requestId: intent.id });
    await resolveIntent(claim.intent.id, "delivered", "Bot accepted durable X3A intent; provider lifecycle is reconciled by Bot");
    return { ...(result as object), platformIntentId: intent.id, dedupeKey };
  }));
  app.post<{ Params: { id: string } }>("/api/spot-execution/v1/orders/:id/cancel",
    async (req, reply) => send(reply, async () => {
      if (!config.spotExecutionEnabled) {
        throw new ManualBotError("paper/testnet spot execution is disabled", 404);
      }
      if (!UUID.test(req.params.id)) throw new ManualBotError("invalid Spot execution order id", 400);
      const body = record(req.body);
      const requestId = text(body, "requestId");
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
        throw new ManualBotError("requestId must be a durable 16-128 character identity", 400);
      }
      return botRequest({ method: "POST",
        path: `/api/spot-execution/v1/orders/${encodeURIComponent(req.params.id)}/cancel`, requestId });
    }));
}
