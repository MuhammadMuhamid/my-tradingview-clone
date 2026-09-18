import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { config } from "../src/config";
import { canonicalJson } from "../src/manualTrading/client";
import { createHash } from "node:crypto";
import { spotExecutionRoutes } from "../src/api/routes/spotExecution";

const command = { deploymentId: "00000000-0000-4000-8000-000000000010",
  dedupeKey: "spot:binance:BTCUSDT:1788678000000", barTime: 1_788_678_000_000,
  accountId: "00000000-0000-4000-8000-000000000011", venue: "binance", environment: "paper",
  canonicalInstrumentId: "instrument:v1:crypto:spot:binance:BTC-USDT", venueSymbol: "BTCUSDT",
  side: "BUY", orderType: "MARKET", quoteQuantity: "100", paperReferencePrice: "50000" };

/*
 * X3A creates Spot exposure and now calls the gate, so every fixture supplies
 * its readers. Off by default: these tests are about the intent lifecycle, and
 * a gate that refused would hide the thing they are checking. The gate's own
 * behaviour on this route is asserted separately below.
 */
const shariahOff = { readMode: async () => "off" as const, lookupBaseAsset: async () => null };

const pendingIntent = { id: 41, deploymentId: command.deploymentId, alertId: null,
  dedupeKey: command.dedupeKey, action: "buy" as const, barTime: command.barTime, exitLeg: null,
  state: "pending" as const, resolvedAt: null, detail: null, emitterId: null,
  createdAt: Date.parse("2026-09-10T19:00:00.000Z") };

test("X3A Platform persists a durable intent before authenticated Bot delivery", async () => {
  const old = config.spotExecutionEnabled; config.spotExecutionEnabled = true;
  const events: string[] = []; let sentBody: Record<string, unknown> | null = null;
  const app = Fastify();
  await app.register(async (child) => spotExecutionRoutes(child, {
    shariah: shariahOff,
    claimIntent: async (input) => { events.push("claim"); assert.equal(input.dedupeKey, command.dedupeKey);
      return { claimed: true, intent: pendingIntent }; },
    botRequest: async (input) => { events.push("bot"); sentBody = input.body as Record<string, unknown>;
      return { status: "filled" }; },
    resolveIntent: async (id, state) => { events.push("resolve"); assert.equal(id, 41); assert.equal(state, "delivered"); },
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/spot-execution/v1/orders", payload: command });
    assert.equal(response.statusCode, 200, response.body); assert.deepEqual(events, ["claim", "bot", "resolve"]);
    assert.ok(sentBody); const captured = sentBody as unknown as Record<string, unknown>;
    const platform = captured.platformIntent as Record<string, string>;
    assert.equal(platform.id, "x3a_platform_intent_41"); assert.equal(platform.dedupeKey, command.dedupeKey);
    assert.equal(captured.deploymentId, undefined);
    const expectedHash = createHash("sha256").update(canonicalJson({ accountId: command.accountId,
      venue: command.venue, environment: command.environment, canonicalInstrumentId: command.canonicalInstrumentId,
      venueSymbol: command.venueSymbol, side: command.side, orderType: command.orderType,
      timeInForce: null, baseQuantity: null, quoteQuantity: command.quoteQuantity,
      limitPrice: null, paperReferencePrice: command.paperReferencePrice })).digest("hex");
    assert.equal(platform.payloadHash, expectedHash);
  } finally { config.spotExecutionEnabled = old; await app.close(); }
});

test("X3A unresolved replay never contacts Bot and production is not a valid environment", async () => {
  const old = config.spotExecutionEnabled; config.spotExecutionEnabled = true; let calls = 0;
  const app = Fastify();
  await app.register(async (child) => spotExecutionRoutes(child, {
    shariah: shariahOff,
    claimIntent: async () => ({ claimed: false as const, existing: pendingIntent }),
    botRequest: async () => { calls++; return {}; }, resolveIntent: async () => {},
  }));
  try {
    const replay = await app.inject({ method: "POST", url: "/api/spot-execution/v1/orders", payload: command });
    assert.equal(replay.statusCode, 409); assert.match(replay.body, /no retry was sent/); assert.equal(calls, 0);
    const production = await app.inject({ method: "POST", url: "/api/spot-execution/v1/orders",
      payload: { ...command, environment: "production", dedupeKey: `${command.dedupeKey}:new` } });
    assert.equal(production.statusCode, 422); assert.equal(calls, 0);
  } finally { config.spotExecutionEnabled = old; await app.close(); }
});

test("X3A disabled state is unmistakably non-production without contacting Bot", async () => {
  const old = config.spotExecutionEnabled; config.spotExecutionEnabled = false; let calls = 0;
  const app = Fastify(); await app.register(async (child) => spotExecutionRoutes(child, {
    shariah: shariahOff,
    botRequest: async () => { calls++; return {}; },
  }));
  try { const response = await app.inject({ method: "GET", url: "/api/spot-execution/v1/state" });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { enabled: false,
      mode: "PAPER_TESTNET_ONLY", productionActivationAvailable: false, warning: "Spot execution is disabled" });
    assert.equal(calls, 0);
  } finally { config.spotExecutionEnabled = old; await app.close(); }
});

test("X3A cancellation stays on the authenticated Bot boundary with durable correlation", async () => {
  const old = config.spotExecutionEnabled; config.spotExecutionEnabled = true;
  const app = Fastify(); let sent: { method?: string; path?: string; requestId?: string } | null = null;
  await app.register(async (child) => spotExecutionRoutes(child, {
    shariah: shariahOff,
    botRequest: async (input) => { sent = input; return { status: "canceled" }; },
  }));
  try {
    const id = "00000000-0000-4000-8000-000000000099";
    const requestId = "spot_cancel_request_1234567890";
    const response = await app.inject({ method: "POST", url: `/api/spot-execution/v1/orders/${id}/cancel`,
      payload: { requestId } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(sent, { method: "POST", path: `/api/spot-execution/v1/orders/${id}/cancel`, requestId });
    const malformed = await app.inject({ method: "POST", url: "/api/spot-execution/v1/orders/not-an-id/cancel",
      payload: { requestId } });
    assert.equal(malformed.statusCode, 400);
  } finally { config.spotExecutionEnabled = old; await app.close(); }
});

test("X3A asks the Shariah gate before it claims an intent, and refuses when told to", async () => {
  /*
   * X3A routes Spot orders at nine venues and called no gate at all — while
   * `gate.ts` claimed in its own header that "every Platform path capable of
   * producing a Spot BUY" called it, and the test asserting that inspected two
   * other route files by name. The universal claim gets a universal check in
   * `shariahGate.test.ts`; this pins the behaviour on this route.
   */
  const old = config.spotExecutionEnabled; config.spotExecutionEnabled = true;
  let asked: { symbol: string; side: string } | null = null;
  let claimed = false;
  const app = Fastify();
  await app.register(async (child) => spotExecutionRoutes(child, {
    shariah: {
      readMode: async () => "enforce" as const,
      lookupBaseAsset: async (baseAsset) => {
        asked = { symbol: baseAsset, side: "BUY" };
        // Present in the registry and NOT eligible: the refusal the gate exists for.
        return { assetId: "7", baseAsset, effectiveStatus: "EXCLUDED" as const, currentPublicationId: null };
      },
    },
    claimIntent: async () => { claimed = true; return { claimed: true, intent: pendingIntent }; },
    botRequest: async () => { throw new Error("the Bot must never be contacted for a refused order"); },
    resolveIntent: async () => {},
  }));
  try {
    const response = await app.inject({
      method: "POST", url: "/api/spot-execution/v1/orders",
      payload: { ...command, canonicalInstrumentId: "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot" },
    });
    assert.equal(response.statusCode, 403, response.body);
    const body = JSON.parse(response.body) as { error: string; shariah: { effectiveStatus: string; mode: string } };
    assert.match(body.error, /Shariah/);
    assert.equal(body.shariah.mode, "enforce");
    assert.equal(body.shariah.effectiveStatus, "EXCLUDED");
    // The asset, not the venue: a classification is about BTC whether the order
    // goes to Binance or to Kraken.
    assert.deepEqual(asked, { symbol: "BTC", side: "BUY" });
    // And the refusal must not burn the caller's dedupe identity.
    assert.equal(claimed, false, "a refused order claimed a durable intent it never used");
  } finally { config.spotExecutionEnabled = old; await app.close(); }
});

test("X3A never blocks a SELL, whatever the classification", async () => {
  // Getting OUT is never gated — not by classification, not by mode. An
  // operator holding an asset re-screened EXCLUDED must be able to exit it.
  const old = config.spotExecutionEnabled; config.spotExecutionEnabled = true;
  let reached = false;
  const app = Fastify();
  await app.register(async (child) => spotExecutionRoutes(child, {
    shariah: {
      readMode: async () => "enforce" as const,
      lookupBaseAsset: async (baseAsset) => ({
        assetId: "7", baseAsset, effectiveStatus: "EXCLUDED" as const, currentPublicationId: null }),
    },
    claimIntent: async () => ({ claimed: true, intent: { ...pendingIntent, action: "sell" as const } }),
    botRequest: async () => { reached = true; return { status: "filled" }; },
    resolveIntent: async () => {},
  }));
  try {
    const response = await app.inject({
      method: "POST", url: "/api/spot-execution/v1/orders",
      payload: { ...command, side: "SELL", dedupeKey: `${command.dedupeKey}:sell`,
        canonicalInstrumentId: "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot" },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(reached, "a SELL was blocked; an operator must always be able to exit");
  } finally { config.spotExecutionEnabled = old; await app.close(); }
});
