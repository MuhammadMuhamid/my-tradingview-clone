import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";
import { signManualCommand } from "../src/manualTrading/client";
import {
  readManualExecutionEvidence, readStrategyExecutionEvidence, strategyEvidenceUrl,
  type ManualExecutionEvidence, type StrategyExecutionEvidence,
} from "../src/timeline/botEvidenceClient";
import { initialRuntimeState, type DeploymentRow } from "../src/types/deployments";

const T0 = "2026-09-01T12:00:00.000Z";
const secret = "s".repeat(40);
const deployment: DeploymentRow = {
  id: "11111111-1111-4111-8111-111111111111", strategyId: 7, configId: "cfg-7",
  symbol: "BTCUSDT", timeframe: "15m", params: {}, status: "active", delivery: "custom",
  webhookUrl: "https://bot.alphawebstudioz.com/api/webhooks/signal_bots", secret,
  botUuid: null, buyQuoteQty: 100, runtimeState: initialRuntimeState(), lastBarTime: null,
  createdAt: T0, updatedAt: T0,
};
const intent = { action: "buy" as const, dedupeKey: "L-1788264000000" };

export const strategyEvidence = (overrides: Partial<StrategyExecutionEvidence> = {}): StrategyExecutionEvidence => ({
  evidenceType: "STRATEGY_ORDER_INTENT",
  identity: { evidenceClass: "AUTHORITATIVE_LINKAGE", strategyOrderIntentId: "strategy-intent-1",
    sourceKey: "bot-1:BTCUSDT:buy:L-1788264000000", callerDedupeKey: intent.dedupeKey,
    botId: "bot-1", clientOrderId: "client-1", exchangeOrderId: "exchange-1" },
  order: { symbol: "BTCUSDT", side: "BUY", orderType: "MARKET",
    requestedBaseQuantity: null, requestedQuoteQuantity: 100, sellPercent: null,
    exitLeg: null, simulated: false },
  events: [
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", type: "STRATEGY_INTENT_PERSISTED",
      occurredAt: T0, state: "requested", identifiers: { strategyOrderIntentId: "strategy-intent-1" } },
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", type: "SUBMISSION_ATTEMPTED",
      occurredAt: "2026-09-01T12:00:01.000Z", state: "submitted" },
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", type: "STRATEGY_INTENT_RESOLVED",
      occurredAt: "2026-09-01T12:00:02.000Z", state: "reconciled",
      identifiers: { exchangeOrderId: "exchange-1" }, quantities: {
        cumulativeExecutedBaseQuantity: 1, cumulativeExecutedQuoteQuantity: 100,
        averageFillPrice: 100 } },
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
      type: "STRATEGY_PARTIAL_CLOSE_ACCOUNTING_APPLIED", occurredAt: "2026-09-01T12:00:03.000Z",
      identifiers: { partialCloseId: "partial-1", exchangeOrderId: "exchange-1" },
      quantities: { baseQuantity: 0.5, quoteRevenue: 50, averagePrice: 100, realizedPnlQuote: 5 } },
  ],
  currentState: { evidenceClass: "CURRENT_AUTHORITATIVE_STATE", intentStatus: "reconciled",
    exchangeOrderStatus: "FILLED", cumulativeExecutedBaseQuantity: 1,
    cumulativeExecutedQuoteQuantity: 100, averageFillPrice: 100,
    observedAt: "2026-09-01T12:00:04.000Z" },
  limitations: ["No individual exchange fills."],
  ...overrides,
});

export const manualEvidence = (orderId = "11111111-1111-4111-8111-111111111111"):
ManualExecutionEvidence => ({
  evidenceType: "MANUAL_ORDER",
  identity: { evidenceClass: "AUTHORITATIVE_LINKAGE", manualOrderId: orderId,
    orderRequestId: "order_request_123456", clientOrderId: "manual-client-1",
    exchangeOrderId: "manual-exchange-1" },
  order: { symbol: "ETHUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote",
    requestedBaseQuantity: null, requestedQuoteQuantity: 200, limitPrice: 2000 },
  events: [
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", type: "MANUAL_ORDER_PERSISTED",
      occurredAt: T0, state: "requested" },
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", type: "SUBMISSION_ATTEMPTED",
      occurredAt: "2026-09-01T12:00:01.000Z", state: "submitted" },
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", type: "MANUAL_ORDER_COMPLETED",
      occurredAt: "2026-09-01T12:00:02.000Z", state: "canceled" },
  ],
  currentState: { evidenceClass: "CURRENT_AUTHORITATIVE_STATE", orderStatus: "canceled",
    cumulativeExecutedBaseQuantity: 0.05, cumulativeExecutedQuoteQuantity: 100,
    averageFillPrice: 2000, observedAt: "2026-09-01T12:00:03.000Z" },
  linkedCommands: [{
    identity: { evidenceClass: "AUTHORITATIVE_LINKAGE", manualCommandId: "command-1",
      commandRequestId: "cancel_request_123", targetManualOrderId: orderId },
    event: { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
      type: "MANUAL_CANCEL_COMMAND_PERSISTED", occurredAt: "2026-09-01T12:00:01.500Z",
      state: "cancel_order" },
    currentState: { evidenceClass: "CURRENT_AUTHORITATIVE_STATE", commandStatus: "succeeded",
      observedAt: "2026-09-01T12:00:02.500Z" },
  }],
  linkedCommandsTruncated: false,
  limitations: ["No individual manual exchange fills."],
});

test("automated evidence uses the exact validated source identity and preserves response classes", async () => {
  let seenUrl = "";
  let seenBody: unknown;
  const result = await readStrategyExecutionEvidence(deployment, intent, async (input, init) => {
    seenUrl = String(input); seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(strategyEvidence()), { status: 200 });
  });
  assert.equal(strategyEvidenceUrl(deployment),
    "https://bot.alphawebstudioz.com/api/webhooks/signal_bots/execution-evidence");
  assert.deepEqual(seenBody, { secret, symbol: "BTCUSDT", action: "buy",
    dedupe_key: "L-1788264000000" });
  assert.ok(!seenUrl.includes(secret));
  assert.equal(result.state, "FOUND");
  if (result.state === "FOUND") {
    assert.equal(result.evidence.events[0]?.evidenceClass, "AUTHORITATIVE_HISTORICAL_EVENT");
    assert.equal(result.evidence.currentState.evidenceClass, "CURRENT_AUTHORITATIVE_STATE");
    assert.equal(result.evidence.identity.evidenceClass, "AUTHORITATIVE_LINKAGE");
  }
});

test("automated not-found, unavailable, and mismatched identities do not guess a correlation", async () => {
  assert.deepEqual(await readStrategyExecutionEvidence(deployment, intent,
    async () => new Response("", { status: 404 })), { state: "NOT_FOUND" });
  assert.deepEqual(await readStrategyExecutionEvidence(deployment, intent,
    async () => { throw new Error("timeout"); }), { state: "UNAVAILABLE" });
  const wrong = strategyEvidence({ identity: { ...strategyEvidence().identity,
    callerDedupeKey: "nearby-but-not-exact" } });
  assert.deepEqual(await readStrategyExecutionEvidence(deployment, intent,
    async () => new Response(JSON.stringify(wrong), { status: 200 })), { state: "UNAVAILABLE" });
});

test("manual evidence lookup reuses fresh nonce/request HMAC construction without exposing the secret", async () => {
  const prior = { enabled: config.manualTradingEnabled, url: config.manualTradingBotUrl,
    secret: config.manualTradingHmacSecret };
  config.manualTradingEnabled = true;
  config.manualTradingBotUrl = "https://bot.alphawebstudioz.com";
  config.manualTradingHmacSecret = secret;
  const orderId = manualEvidence().identity.manualOrderId;
  try {
    const result = await readManualExecutionEvidence(orderId, async (input, init) => {
      const headers = new Headers(init?.headers);
      const timestamp = headers.get("x-manual-timestamp")!;
      const nonce = headers.get("x-manual-nonce")!;
      const requestId = headers.get("x-manual-request-id")!;
      const body = JSON.parse(String(init?.body));
      assert.equal(String(input), "https://bot.alphawebstudioz.com/api/manual-trading/execution-evidence/manual-orders/lookup");
      assert.deepEqual(body, { orderId });
      assert.match(nonce, /^[A-Za-z0-9_-]{16,128}$/);
      assert.match(requestId, /^[A-Za-z0-9_-]{16,128}$/);
      assert.ok(Math.abs(Date.now() - Number(timestamp)) < 60_000);
      assert.equal(headers.get("x-manual-signature"), signManualCommand({ method: "POST",
        path: "/api/manual-trading/execution-evidence/manual-orders/lookup",
        timestamp, nonce, requestId, body }, secret));
      assert.ok(!String(input).includes(secret));
      return new Response(JSON.stringify(manualEvidence(orderId)), { status: 200 });
    });
    assert.equal(result.state, "FOUND");
  } finally {
    config.manualTradingEnabled = prior.enabled;
    config.manualTradingBotUrl = prior.url;
    config.manualTradingHmacSecret = prior.secret;
  }
});
