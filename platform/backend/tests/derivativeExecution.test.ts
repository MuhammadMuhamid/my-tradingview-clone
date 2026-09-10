import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { derivativeExecutionRoutes } from "../src/api/routes/derivativeExecution";
import { config } from "../src/config";
import { canonicalJson } from "../src/manualTrading/client";

const command = { deploymentId: "00000000-0000-4000-8000-000000000020",
  dedupeKey: "x3b:binance:BTCUSDT:1788678000000", barTime: 1_788_678_000_000,
  accountId: "00000000-0000-4000-8000-000000000021", venue: "binance", environment: "paper",
  canonicalInstrumentId: "instrument:v1:crypto:perpetual:binance:BTC-USDT", venueSymbol: "BTCUSDT",
  instrument: { kind: "LINEAR", contractSize: "0.001", baseCurrency: "BTC", quoteCurrency: "USDT",
    settlementCurrency: "USDT", marginCurrency: "USDT" }, positionDirection: "LONG", actionSide: "BUY",
  quantityUnit: "CONTRACTS", quantity: "10", marginMode: "ISOLATED", positionMode: "ONE_WAY",
  reduceOnly: false, closePosition: false, orderType: "MARKET", paperReferencePrice: "50000" };
const shariahOff = { allowed: true, reason: null, context: { mode: "off" as const, policyVersion: null,
  assetId: null, baseAsset: "BTC", effectiveStatus: "REVIEW" as const, publicationId: null } };
const pending = { id: 51, deploymentId: command.deploymentId, alertId: null, dedupeKey: command.dedupeKey,
  action: "buy" as const, barTime: command.barTime, exitLeg: null, state: "pending" as const,
  resolvedAt: null, detail: null, emitterId: null, createdAt: Date.parse("2026-09-10T20:00:00.000Z") };

test("X3B Platform durably claims before HMAC Bot delivery and binds every exposure term", async () => {
  const old = config.derivativeExecutionEnabled; config.derivativeExecutionEnabled = true;
  const events: string[] = []; let sent: Record<string, unknown> | null = null;
  const app = Fastify(); await app.register(async (child) => derivativeExecutionRoutes(child, {
    claimIntent: async () => { events.push("claim"); return { claimed: true, intent: pending }; },
    botRequest: async (input) => { events.push("bot"); sent = input.body as Record<string, unknown>; return { status: "filled" }; },
    resolveIntent: async () => { events.push("resolve"); },
    evaluateShariah: async (input) => { assert.equal(input.side, "BUY"); return shariahOff; },
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/derivative-execution/v1/orders", payload: command });
    assert.equal(response.statusCode, 200, response.body); assert.deepEqual(events, ["claim", "bot", "resolve"]); assert.ok(sent);
    const captured = sent as unknown as Record<string, unknown>; assert.equal(captured.deploymentId, undefined);
    const platform = captured.platformIntent as Record<string, string>; assert.equal(platform.id, "x3b_platform_intent_51");
    const expected = createHash("sha256").update(canonicalJson({ accountId: command.accountId, venue: command.venue,
      environment: command.environment, canonicalInstrumentId: command.canonicalInstrumentId, venueSymbol: command.venueSymbol,
      instrument: command.instrument, positionDirection: command.positionDirection, actionSide: command.actionSide,
      quantityUnit: command.quantityUnit, quantity: command.quantity, marginMode: command.marginMode, leverage: null,
      positionMode: command.positionMode, reduceOnly: false, closePosition: false, orderType: command.orderType,
      timeInForce: null, limitPrice: null, protective: null, paperReferencePrice: command.paperReferencePrice,
      position: null, shariah: shariahOff.context })).digest("hex");
    assert.equal(platform.payloadHash, expected);
  } finally { config.derivativeExecutionEnabled = old; await app.close(); }
});

test("X3B unresolved replay and production environment never contact Bot", async () => {
  const old = config.derivativeExecutionEnabled; config.derivativeExecutionEnabled = true; let calls = 0;
  const app = Fastify(); await app.register(async (child) => derivativeExecutionRoutes(child, {
    claimIntent: async () => ({ claimed: false as const, existing: pending }),
    botRequest: async () => { calls++; return {}; }, resolveIntent: async () => {},
    evaluateShariah: async () => shariahOff,
  }));
  try {
    const replay = await app.inject({ method: "POST", url: "/api/derivative-execution/v1/orders", payload: command });
    assert.equal(replay.statusCode, 409); assert.match(replay.body, /unresolved and no retry/); assert.equal(calls, 0);
    const production = await app.inject({ method: "POST", url: "/api/derivative-execution/v1/orders",
      payload: { ...command, environment: "production", dedupeKey: `${command.dedupeKey}:new` } });
    assert.equal(production.statusCode, 422); assert.equal(calls, 0);
    const spoofedPolicy = await app.inject({ method: "POST", url: "/api/derivative-execution/v1/orders",
      payload: { ...command, shariah: { mode: "off" } } });
    assert.equal(spoofedPolicy.statusCode, 400); assert.match(spoofedPolicy.body, /Platform authority/); assert.equal(calls, 0);
  } finally { config.derivativeExecutionEnabled = old; await app.close(); }
});

test("X3B protective/reduce intent and fresh position are preserved without translation", async () => {
  const old = config.derivativeExecutionEnabled; config.derivativeExecutionEnabled = true; let sent: Record<string, unknown> | null = null;
  const reduce = { ...command, dedupeKey: `${command.dedupeKey}:reduce`, positionDirection: "LONG", actionSide: "SELL",
    quantity: "5", reduceOnly: true, orderType: "STOP_MARKET",
    protective: { kind: "STOP_LOSS", triggerPrice: "48000", triggerPriceRole: "MARK",
      paperTriggerModel: "COMPLETED_CANDLE_MARKET_AFTER_CLOSE" }, position: { direction: "LONG", contracts: "10",
      entryPrice: "50000", markPrice: "49000", observedAt: "2026-09-10T20:00:00.000Z", version: "position:v1:1" } };
  const app = Fastify(); await app.register(async (child) => derivativeExecutionRoutes(child, {
    claimIntent: async () => ({ claimed: true, intent: { ...pending, dedupeKey: reduce.dedupeKey, action: "sell" } }),
    botRequest: async (input) => { sent = input.body as Record<string, unknown>; return { status: "open" }; },
    resolveIntent: async () => {},
    evaluateShariah: async (input) => { assert.equal(input.side, "SELL"); return shariahOff; },
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/derivative-execution/v1/orders", payload: reduce });
    assert.equal(response.statusCode, 200, response.body); assert.ok(sent);
    assert.deepEqual((sent as unknown as Record<string, unknown>).protective, reduce.protective);
    assert.deepEqual((sent as unknown as Record<string, unknown>).position, reduce.position);
    assert.equal((sent as unknown as Record<string, unknown>).reduceOnly, true);
  } finally { config.derivativeExecutionEnabled = old; await app.close(); }
});

test("X3B short opening is still new exposure for the authoritative Shariah gate", async () => {
  const old = config.derivativeExecutionEnabled; config.derivativeExecutionEnabled = true;
  const short = { ...command, dedupeKey: `${command.dedupeKey}:short`, positionDirection: "SHORT", actionSide: "SELL" };
  let gateSide = ""; const app = Fastify();
  await app.register(async (child) => derivativeExecutionRoutes(child, {
    evaluateShariah: async (input) => { gateSide = input.side; return shariahOff; },
    claimIntent: async () => ({ claimed: true, intent: { ...pending, dedupeKey: short.dedupeKey, action: "sell" } }),
    botRequest: async () => ({ status: "filled" }), resolveIntent: async () => {},
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/derivative-execution/v1/orders", payload: short });
    assert.equal(response.statusCode, 200, response.body); assert.equal(gateSide, "BUY");
  } finally { config.derivativeExecutionEnabled = old; await app.close(); }
});

test("X3B disabled state is explicit and cancellation stays on the correlated Bot boundary", async () => {
  const old = config.derivativeExecutionEnabled; const app = Fastify(); let sent: unknown;
  config.derivativeExecutionEnabled = false; await app.register(async (child) => derivativeExecutionRoutes(child, {
    botRequest: async (input) => { sent = input; return { status: "canceled" }; },
  }));
  try {
    const state = await app.inject({ method: "GET", url: "/api/derivative-execution/v1/state" });
    assert.equal(state.statusCode, 200); assert.match(state.body, /PAPER_TESTNET_ONLY/); assert.equal(sent, undefined);
  } finally { config.derivativeExecutionEnabled = old; await app.close(); }

  config.derivativeExecutionEnabled = true; const cancelApp = Fastify();
  await cancelApp.register(async (child) => derivativeExecutionRoutes(child, {
    botRequest: async (input) => { sent = input; return { status: "canceled" }; },
  }));
  try {
    const id = "00000000-0000-4000-8000-000000000099", requestId = "x3b_cancel_request_123456789";
    const response = await cancelApp.inject({ method: "POST", url: `/api/derivative-execution/v1/orders/${id}/cancel`, payload: { requestId } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(sent, { method: "POST", path: `/api/derivative-execution/v1/orders/${id}/cancel`, requestId });
  } finally { config.derivativeExecutionEnabled = old; await cancelApp.close(); }
});
