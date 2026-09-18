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
/*
 * The scope check reads the MODE and nothing else, because TS_SHARIAH_V1 has no
 * finding about derivatives to read. Off here: these tests are about the intent
 * lifecycle. The refusal is asserted on its own below.
 */
const shariahOff = { readMode: async () => "off" as const };
const shariahOffContext = { mode: "off" as const, policyVersion: null,
  assetId: null, baseAsset: null, effectiveStatus: "REVIEW" as const, publicationId: null };
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
    shariah: shariahOff,
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
      position: null, shariah: shariahOffContext })).digest("hex");
    assert.equal(platform.payloadHash, expected);
  } finally { config.derivativeExecutionEnabled = old; await app.close(); }
});

test("X3B unresolved replay and production environment never contact Bot", async () => {
  const old = config.derivativeExecutionEnabled; config.derivativeExecutionEnabled = true; let calls = 0;
  const app = Fastify(); await app.register(async (child) => derivativeExecutionRoutes(child, {
    claimIntent: async () => ({ claimed: false as const, existing: pending }),
    botRequest: async () => { calls++; return {}; }, resolveIntent: async () => {},
    shariah: shariahOff,
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
    shariah: shariahOff,
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/derivative-execution/v1/orders", payload: reduce });
    assert.equal(response.statusCode, 200, response.body); assert.ok(sent);
    assert.deepEqual((sent as unknown as Record<string, unknown>).protective, reduce.protective);
    assert.deepEqual((sent as unknown as Record<string, unknown>).position, reduce.position);
    assert.equal((sent as unknown as Record<string, unknown>).reduceOnly, true);
  } finally { config.derivativeExecutionEnabled = old; await app.close(); }
});

test("X3B refuses a new derivative position while enforcing, rather than clearing it on a SPOT verdict", async () => {
  /*
   * This route asked the SPOT registry about the base asset and opened a
   * derivative position on its answer — so a SHORT on an ELIGIBLE asset passed.
   * That is the product asserting a permissibility conclusion about leverage
   * and shorting that TS_SHARIAH_V1 never made; the policy's own premise is
   * spot crypto, and the methodology document says so in as many words.
   *
   * A wrong answer delivered with the full apparatus of a right one is worse
   * than a refusal, so it refuses — and says it is refusing because it does not
   * know, not because the instrument is impermissible.
   */
  const old = config.derivativeExecutionEnabled; config.derivativeExecutionEnabled = true;
  const short = { ...command, dedupeKey: `${command.dedupeKey}:short`, positionDirection: "SHORT", actionSide: "SELL" };
  let claimed = false; const app = Fastify();
  await app.register(async (child) => derivativeExecutionRoutes(child, {
    shariah: { readMode: async () => "enforce" as const },
    claimIntent: async () => { claimed = true; return { claimed: true, intent: { ...pending, dedupeKey: short.dedupeKey, action: "sell" } }; },
    botRequest: async () => { throw new Error("the Bot must never be contacted for a refused order"); },
    resolveIntent: async () => {},
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/derivative-execution/v1/orders", payload: short });
    assert.equal(response.statusCode, 403, response.body);
    const body = JSON.parse(response.body) as { error: string; shariah: { mode: string; policyVersion: string | null } };
    assert.match(body.error, /makes\s*no finding about derivatives, leverage or short exposure/,
      "the refusal must say the policy is silent, not that the instrument is impermissible");
    assert.match(body.error, /Closing or reducing an existing position is never blocked/,
      "an operator must be told they can still get out");
    assert.equal(body.shariah.mode, "enforce");
    assert.ok(body.shariah.policyVersion, "the policy in force must travel with the refusal");
    assert.equal(claimed, false, "a refused order claimed a durable intent it never used");
  } finally { config.derivativeExecutionEnabled = old; await app.close(); }
});

test("X3B still routes a REDUCING derivative order while enforcing", async () => {
  // Reducing or closing is never blocked, whatever the scope and whatever the
  // mode. A gate that trapped an operator in a position would be a worse
  // failure than the one it was added to fix.
  const old = config.derivativeExecutionEnabled; config.derivativeExecutionEnabled = true;
  const reduce = { ...command, dedupeKey: `${command.dedupeKey}:reduce`, reduceOnly: true, actionSide: "SELL" };
  let reached = false; const app = Fastify();
  await app.register(async (child) => derivativeExecutionRoutes(child, {
    shariah: { readMode: async () => "enforce" as const },
    claimIntent: async () => ({ claimed: true, intent: { ...pending, dedupeKey: reduce.dedupeKey, action: "sell" } }),
    botRequest: async () => { reached = true; return { status: "filled" }; },
    resolveIntent: async () => {},
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/derivative-execution/v1/orders", payload: reduce });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(reached, "a reducing order was blocked while enforcing");
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
