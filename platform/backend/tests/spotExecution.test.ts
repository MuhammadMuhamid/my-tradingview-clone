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

const pendingIntent = { id: 41, deploymentId: command.deploymentId, alertId: null,
  dedupeKey: command.dedupeKey, action: "buy" as const, barTime: command.barTime, exitLeg: null,
  state: "pending" as const, resolvedAt: null, detail: null, emitterId: null,
  createdAt: Date.parse("2026-09-10T19:00:00.000Z") };

test("X3A Platform persists a durable intent before authenticated Bot delivery", async () => {
  const old = config.spotExecutionEnabled; config.spotExecutionEnabled = true;
  const events: string[] = []; let sentBody: Record<string, unknown> | null = null;
  const app = Fastify();
  await app.register(async (child) => spotExecutionRoutes(child, {
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
