import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";
import { buildServer } from "../src/api/server";
import {
  automatedBotEvidenceIntents, MAX_AUTOMATED_BOT_EVIDENCE_LOOKUPS, parseTimelineLimit,
} from "../src/api/routes/tradingTimeline";
import { initialRuntimeState, type DeploymentRow } from "../src/types/deployments";
import {
  projectDeploymentTimeline, projectManualOrder, type ExecutionEvidence,
} from "../src/timeline/projection";
import type {
  ManualExecutionEvidence, StrategyExecutionEvidence,
} from "../src/timeline/botEvidenceClient";

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const at = (offset: number) => new Date(T0 + offset).toISOString();

const strategyBotEvidence = (overrides: Partial<StrategyExecutionEvidence> = {}): StrategyExecutionEvidence => ({
  evidenceType: "STRATEGY_ORDER_INTENT",
  identity: { evidenceClass: "AUTHORITATIVE_LINKAGE", strategyOrderIntentId: "bot-intent-1",
    sourceKey: "bot-1:BTCUSDT:buy:L-1788264000000", callerDedupeKey: "L-1788264000000",
    botId: "bot-1", clientOrderId: "client-1", exchangeOrderId: "x-1" },
  order: { symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", requestedBaseQuantity: null,
    requestedQuoteQuantity: 100, sellPercent: null, exitLeg: null, simulated: false },
  events: [
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", type: "SUBMISSION_ATTEMPTED",
      occurredAt: at(1000), state: "submitted" },
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", type: "STRATEGY_INTENT_RESOLVED",
      occurredAt: at(4000), state: "reconciled", identifiers: { exchangeOrderId: "x-1" },
      quantities: { cumulativeExecutedBaseQuantity: 1, cumulativeExecutedQuoteQuantity: 100,
        averageFillPrice: 100 } },
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
      type: "STRATEGY_PARTIAL_CLOSE_ACCOUNTING_APPLIED", occurredAt: at(5000),
      identifiers: { partialCloseId: "partial-1", exchangeOrderId: "x-1" },
      quantities: { baseQuantity: 0.5, quoteRevenue: 50, averagePrice: 100,
        realizedPnlQuote: 5 } },
  ],
  currentState: { evidenceClass: "CURRENT_AUTHORITATIVE_STATE", intentStatus: "reconciled",
    exchangeOrderStatus: "FILLED", cumulativeExecutedBaseQuantity: 1,
    cumulativeExecutedQuoteQuantity: 100, averageFillPrice: 100, observedAt: at(6000) },
  limitations: [],
  ...overrides,
});

const manualBotEvidence = (overrides: Partial<ManualExecutionEvidence> = {}): ManualExecutionEvidence => ({
  evidenceType: "MANUAL_ORDER",
  identity: { evidenceClass: "AUTHORITATIVE_LINKAGE", manualOrderId: "manual-1",
    orderRequestId: "request-1", clientOrderId: "client-1", exchangeOrderId: "exchange-1" },
  order: { symbol: "ETHUSDT", side: "BUY", orderType: "MARKET", quantityType: "quote",
    requestedBaseQuantity: null, requestedQuoteQuantity: 100, limitPrice: null },
  events: [
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", type: "MANUAL_ORDER_PERSISTED",
      occurredAt: at(0), state: "requested" },
    { evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", type: "SUBMISSION_ATTEMPTED",
      occurredAt: at(1000), state: "submitted" },
  ],
  currentState: { evidenceClass: "CURRENT_AUTHORITATIVE_STATE", orderStatus: "canceled",
    cumulativeExecutedBaseQuantity: 0.05, cumulativeExecutedQuoteQuantity: 100,
    averageFillPrice: 2000, observedAt: at(3000) },
  linkedCommands: [{ identity: { evidenceClass: "AUTHORITATIVE_LINKAGE",
    manualCommandId: "command-1", commandRequestId: "cancel-request-1",
    targetManualOrderId: "manual-1" }, event: {
      evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", type: "MANUAL_CANCEL_COMMAND_PERSISTED",
      occurredAt: at(2000), state: "cancel_order" }, currentState: {
        evidenceClass: "CURRENT_AUTHORITATIVE_STATE", commandStatus: "succeeded", observedAt: at(2500) } }],
  linkedCommandsTruncated: false, limitations: [], ...overrides,
});

const deployment = (overrides: Partial<DeploymentRow> = {}): DeploymentRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  strategyId: 7,
  configId: "cfg-7",
  symbol: "BTCUSDT",
  timeframe: "15m",
  params: {},
  status: "active",
  delivery: "custom",
  webhookUrl: "https://bot.alphawebstudioz.com/api/webhooks/signal_bots",
  secret: null,
  botUuid: null,
  buyQuoteQty: 100,
  runtimeState: initialRuntimeState(),
  lastBarTime: null,
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
});

const baseIntent = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  deploymentId: deployment().id,
  alertId: 10,
  dedupeKey: "L-1788264000000",
  action: "buy" as const,
  barTime: T0,
  exitLeg: null,
  state: "delivered" as const,
  resolvedAt: T0 + 2000,
  detail: null,
  emitterId: "worker-1",
  createdAt: T0,
  ...overrides,
});

const projectDeployment = (overrides: Partial<Parameters<typeof projectDeploymentTimeline>[0]> = {}) =>
  projectDeploymentTimeline({
    deployment: deployment(),
    intents: [],
    alerts: [],
    executions: [],
    paperFills: [],
    limit: 50,
    ...overrides,
  });

test("manual request, submission attempt, and fill are chronological without invented transitions", () => {
  const timeline = projectManualOrder({
    order: {
      id: "manual-1", requestId: "request-1", clientOrderId: "client-1",
      exchangeOrderId: "exchange-1", exchangeAccountId: "account-1",
      symbol: "ETHUSDT", side: "BUY", orderType: "MARKET", status: "filled",
      requestedQuoteQty: 100, filledBaseQty: 0.05, filledQuoteQty: 100,
      averageFillPrice: 2000, createdAt: at(0), submittedAt: at(1000),
      completedAt: at(2000), updatedAt: at(2000),
    },
    accounts: [{ id: "account-1", testnet: false }], dryRun: false,
  });
  assert.deepEqual(timeline.items.map((event) => event.kind),
    ["REQUEST_CREATED", "SUBMISSION_ATTEMPTED", "COMPLETED"]);
  assert.deepEqual(timeline.items.map((event) => event.timestamp), [at(0), at(1000), at(2000)]);
  assert.equal(timeline.items.some((event) => event.state === "open" || event.state === "partially_filled"), false);
  assert.equal(timeline.scope.executionMode, "BINANCE MAINNET · real funds");
  assert.equal(timeline.items[0]?.identifiers.exchangeOrderId, undefined,
    "an exchange ID learned later must not be attached to request creation");
  assert.equal(timeline.items[0]?.quantity?.filledBase, undefined,
    "a final fill snapshot must not be attached to request creation");
  assert.deepEqual(timeline.items[2]?.identifiers, {
    requestId: "request-1", clientOrderId: "client-1", exchangeOrderId: "exchange-1",
  });
});

test("a final filled snapshot alone stays current-state evidence and fabricates no history", () => {
  const timeline = projectManualOrder({ order: {
    id: "old", status: "filled", filledBaseQty: 1, updatedAt: at(4000),
  }});
  assert.deepEqual(timeline.items.map((event) => [event.kind, event.evidenceClass]),
    [["CURRENT_STATE", "CURRENT_AUTHORITATIVE_STATE"]]);
  assert.match(timeline.gaps.join(" "), /transition time is unavailable/i);
  assert.equal(timeline.items.some((event) => event.kind === "SUBMISSION_ATTEMPTED"), false);
});

test("genuine open, partial, and filled execution reports appear once; repeated snapshots collapse", () => {
  const executions: ExecutionEvidence[] = [
    { id: 1, alertId: 10, deploymentId: deployment().id, exchangeOrderId: "x-1",
      side: "BUY", orderType: "LIMIT", qty: 0, price: 100, status: "NEW", createdAt: T0 + 1000 },
    { id: 2, alertId: 10, deploymentId: deployment().id, exchangeOrderId: "x-1",
      side: "BUY", orderType: "LIMIT", qty: 0.4, price: 100, status: "PARTIALLY_FILLED", createdAt: T0 + 2000 },
    { id: 3, alertId: 10, deploymentId: deployment().id, exchangeOrderId: "x-1",
      side: "BUY", orderType: "LIMIT", qty: 0.4, price: 100, status: "PARTIALLY_FILLED", createdAt: T0 + 3000 },
    { id: 4, alertId: 10, deploymentId: deployment().id, exchangeOrderId: "x-1",
      side: "BUY", orderType: "LIMIT", qty: 1, price: 100, status: "FILLED", createdAt: T0 + 4000 },
  ];
  const timeline = projectDeployment({ executions });
  assert.deepEqual(timeline.items.map((event) => event.state), ["new", "partially_filled", "filled"]);
  assert.deepEqual(timeline.items.map((event) => event.quantity?.reportedQuantity), [0, 0.4, 1]);
});

test("cancel, later fill, exchange rejection, local failure, and reconciliation remain distinct", () => {
  const executions: ExecutionEvidence[] = [
    { id: 1, alertId: 10, deploymentId: deployment().id, exchangeOrderId: "x-1",
      side: "BUY", orderType: "LIMIT", qty: 0.4, price: 100, status: "CANCELED", createdAt: T0 + 1000 },
    { id: 2, alertId: 10, deploymentId: deployment().id, exchangeOrderId: "x-1",
      side: "BUY", orderType: "LIMIT", qty: 1, price: 100, status: "FILLED", createdAt: T0 + 2000 },
    { id: 3, alertId: 11, deploymentId: deployment().id, exchangeOrderId: "x-2",
      side: "BUY", orderType: "LIMIT", qty: 0, price: 90, status: "REJECTED", createdAt: T0 + 3000 },
  ];
  const timeline = projectDeployment({
    executions,
    intents: [
      baseIntent({ id: 5, alertId: 12, state: "failed", resolvedAt: T0 + 4000 }),
      baseIntent({ id: 6, alertId: 13, state: "pending", resolvedAt: null, createdAt: T0 + 5000 }),
    ],
  });
  assert.deepEqual(timeline.items.filter((event) => event.kind === "EXECUTION_STATE_RECORDED")
    .map((event) => event.state), ["canceled", "filled", "rejected"]);
  assert.ok(timeline.items.some((event) => event.state === "failed" && /locally|transport/.test(event.description)));
  assert.equal(timeline.items.some((event) => event.state === "reconciling"), false,
    "pending has no current-state observation timestamp, so it is not rendered as a timed item");
  assert.equal(timeline.finalKnownState, "reconciling");
});

test("a manual canceled record does not invent a cancel request", () => {
  const timeline = projectManualOrder({ order: {
    id: "cancelled", status: "canceled", createdAt: at(0), submittedAt: at(1000),
    completedAt: at(2000), updatedAt: at(2000),
  }});
  assert.equal(timeline.items.some((event) => event.kind === "CANCEL_REQUESTED"), false);
  assert.match(timeline.gaps.join(" "), /cancel-request timestamp is not exposed/i);
});

test("manual Bot history, current state, and exact cancel linkage retain classifications and distinct IDs", () => {
  const timeline = projectManualOrder({ order: {
    id: "manual-1", requestId: "request-1", clientOrderId: "client-1",
    exchangeOrderId: "exchange-1", status: "canceled", createdAt: at(0), updatedAt: at(3000),
  }, botEvidence: manualBotEvidence() });
  assert.equal(timeline.items.find((event) => event.kind === "REQUEST_CREATED")?.evidenceClass,
    "AUTHORITATIVE_HISTORICAL_EVENT");
  assert.equal(timeline.items.find((event) => event.kind === "CURRENT_STATE")?.evidenceClass,
    "CURRENT_AUTHORITATIVE_STATE");
  assert.equal(timeline.items.filter((event) => event.kind === "MANUAL_CANCEL_COMMAND_PERSISTED").length, 1);
  const cancel = timeline.items.find((event) => event.kind === "MANUAL_CANCEL_COMMAND_PERSISTED")!;
  assert.deepEqual(cancel.identifiers, { manualOrderId: "manual-1", manualCommandId: "command-1",
    commandRequestId: "cancel-request-1", targetManualOrderId: "manual-1" });
  assert.equal(cancel.linkageEvidenceClass, "AUTHORITATIVE_LINKAGE");
  assert.match(timeline.gaps.join(" "), /no distinct persisted command-completion timestamp/i);
});

test("missing Bot historical fields create no event, while the current cumulative snapshot remains current", () => {
  const evidence = manualBotEvidence({ events: [] , linkedCommands: [] });
  const timeline = projectManualOrder({ order: { id: "manual-1" }, botEvidence: evidence });
  assert.equal(timeline.items.some((event) => event.kind === "REQUEST_CREATED"), false);
  assert.equal(timeline.items.some((event) => event.kind === "SUBMISSION_ATTEMPTED"), false);
  assert.deepEqual(timeline.items.map((event) => event.evidenceClass), ["CURRENT_AUTHORITATIVE_STATE"]);
});

test("Bot strategy history and PartialClose accounting enrich by exact intent identity once", () => {
  const evidence = strategyBotEvidence();
  const timeline = projectDeployment({ intents: [baseIntent()],
    botEvidence: [{ platformIntentId: 1, evidence }, { platformIntentId: 1, evidence }] });
  assert.equal(timeline.items.filter((event) =>
    event.kind === "STRATEGY_PARTIAL_CLOSE_ACCOUNTING_APPLIED").length, 1);
  const partial = timeline.items.find((event) =>
    event.kind === "STRATEGY_PARTIAL_CLOSE_ACCOUNTING_APPLIED")!;
  assert.equal(partial.identifiers.intentId, "1");
  assert.equal(partial.identifiers.strategyOrderIntentId, "bot-intent-1");
  assert.equal(partial.identifiers.callerDedupeKey, "L-1788264000000");
  assert.equal(partial.identifiers.partialCloseId, "partial-1");
  assert.equal(partial.quantity?.realizedPnlQuote, 5);
});

test("equivalent Platform and Bot historical execution evidence deduplicates deterministically", () => {
  const executions: ExecutionEvidence[] = [{ id: 1, alertId: 10, deploymentId: deployment().id,
    exchangeOrderId: "x-1", side: "BUY", orderType: "MARKET", qty: 1, price: 100,
    status: "FILLED", createdAt: T0 + 4000 }];
  const timeline = projectDeployment({ executions,
    botEvidence: [{ platformIntentId: 1, evidence: strategyBotEvidence() }] });
  assert.equal(timeline.items.filter((event) => event.identifiers.exchangeOrderId === "x-1"
    && event.timestamp === at(4000)).length, 1);
  assert.equal(timeline.items.some((event) => event.kind === "EXECUTION_STATE_RECORDED"), false);
});

test("conflicting authoritative terminal evidence remains visible and is not guessed away", () => {
  const executions: ExecutionEvidence[] = [{ id: 1, alertId: 10, deploymentId: deployment().id,
    exchangeOrderId: "x-1", side: "BUY", orderType: "MARKET", qty: 1, price: 100,
    status: "CANCELED", createdAt: T0 + 4000 }];
  const timeline = projectDeployment({ executions,
    botEvidence: [{ platformIntentId: 1, evidence: strategyBotEvidence() }] });
  assert.ok(timeline.items.some((event) => event.state === "canceled"));
  assert.ok(timeline.items.some((event) => event.state === "filled"
    || event.state === "reconciled"));
  assert.equal(timeline.finalKnownState, "conflicting evidence");
  assert.match(timeline.gaps.join(" "), /without guessing exchange truth/i);
});

test("same-state evidence with conflicting cumulative quantity is not deduplicated", () => {
  const executions: ExecutionEvidence[] = [{ id: 1, alertId: 10, deploymentId: deployment().id,
    exchangeOrderId: "x-1", side: "BUY", orderType: "MARKET", qty: 0.5, price: 100,
    status: "FILLED", createdAt: T0 + 4000 }];
  const timeline = projectDeployment({ executions,
    botEvidence: [{ platformIntentId: 1, evidence: strategyBotEvidence() }] });
  assert.ok(timeline.items.some((event) => event.kind === "EXECUTION_STATE_RECORDED"));
  assert.ok(timeline.items.some((event) => event.kind === "STRATEGY_INTENT_RESOLVED"));
  assert.match(timeline.gaps.join(" "), /conflicting authoritative execution quantities/i);
  assert.equal(timeline.finalKnownState, "conflicting evidence");
});

test("Bot not-found or unavailable enrichment never erases Platform timeline evidence", () => {
  for (const botLookup of [
    { attempted: 1, notFound: 1, unavailable: 0, omittedByBound: 0 },
    { attempted: 1, notFound: 0, unavailable: 1, omittedByBound: 0 },
  ]) {
    const timeline = projectDeployment({ intents: [baseIntent()], botLookup });
    assert.ok(timeline.items.some((event) => event.kind === "INTENT_PERSISTED"));
    assert.ok(timeline.items.some((event) => event.kind === "DELIVERY_RECORDED"));
  }
});

test("automated Bot enrichment is hard-bounded and disabled for non-custom timelines", () => {
  const intents = Array.from({ length: 25 }, (_, index) => baseIntent({
    id: index + 1, dedupeKey: `L-${index + 1}`,
  }));
  assert.equal(MAX_AUTOMATED_BOT_EVIDENCE_LOOKUPS, 10);
  const configured = deployment({ secret: "s".repeat(40) });
  assert.deepEqual(automatedBotEvidenceIntents(configured, intents).map((intent) => intent.id),
    intents.slice(0, 10).map((intent) => intent.id));
  assert.deepEqual(automatedBotEvidenceIntents(deployment({ delivery: "paper" }), intents), []);
});

test("manual exact-evidence not-found or timeout falls back to the existing bounded state timeline", async () => {
  const orderId = "11111111-1111-4111-8111-111111111111";
  const prior = { enabled: config.manualTradingEnabled, url: config.manualTradingBotUrl,
    secret: config.manualTradingHmacSecret, fetch: globalThis.fetch };
  config.manualTradingEnabled = true;
  config.manualTradingBotUrl = "https://bot.alphawebstudioz.com";
  config.manualTradingHmacSecret = "s".repeat(40);
  let evidenceMode: "not-found" | "timeout" = "not-found";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/manual-trading/state")) return new Response(JSON.stringify({
      dryRun: false, accounts: [], orders: [{ id: orderId, requestId: "request-1",
        clientOrderId: "client-1", symbol: "ETHUSDT", side: "BUY", orderType: "MARKET",
        status: "submitted", createdAt: at(0), submittedAt: at(1000), updatedAt: at(2000) }],
    }), { status: 200 });
    if (evidenceMode === "timeout") throw new Error("timeout");
    return new Response(JSON.stringify({ error: "manual order not found" }), { status: 404 });
  };
  const app = buildServer(() => null as never);
  try {
    for (const mode of ["not-found", "timeout"] as const) {
      evidenceMode = mode;
      const response = await app.inject({ method: "GET",
        url: `/api/trading-timeline/manual-orders/${orderId}` });
      assert.equal(response.statusCode, 200);
      assert.ok((response.json() as { items: Array<{ kind: string }> }).items
        .some((event) => event.kind === "SUBMISSION_ATTEMPTED"));
    }
  } finally {
    await app.close();
    config.manualTradingEnabled = prior.enabled;
    config.manualTradingBotUrl = prior.url;
    config.manualTradingHmacSecret = prior.secret;
    globalThis.fetch = prior.fetch;
  }
});

test("deployment provenance is explicit, and paper fills cannot read as real", () => {
  const automated = projectDeployment({ intents: [baseIntent()] });
  assert.equal(automated.scope.source, "AUTOMATED");
  assert.equal(automated.scope.strategyId, "7");
  assert.ok(automated.items.every((event) => event.identifiers.deploymentId === deployment().id));

  const paper = projectDeployment({
    deployment: deployment({ delivery: "paper" }),
    paperFills: [{ id: 1, deploymentId: deployment().id, alertId: 10,
      filledAt: T0 + 1000, action: "buy", price: 100, qty: 1, quote: 100, reason: "entry" }],
  });
  assert.equal(paper.scope.source, "PAPER");
  assert.match(paper.scope.executionMode, /no exchange order/i);
  assert.match(paper.items[0]?.description ?? "", /No exchange order was sent/i);

  const unknown = projectDeployment({ deployment: deployment({ delivery: "off" }) });
  assert.equal(unknown.scope.source, "UNKNOWN");
});

test("equal timestamps use deterministic keys without manufacturing precision", () => {
  const timeline = projectDeployment({ intents: [baseIntent({ resolvedAt: T0 })] });
  assert.ok(timeline.items.length >= 2);
  assert.ok(timeline.items.every((event) => event.timestamp === at(0)));
  assert.deepEqual(timeline.items.map((event) => event.kind), ["INTENT_PERSISTED", "DELIVERY_RECORDED"]);
});

test("the read boundary rejects unbounded limits and remains session-protected", async () => {
  assert.equal(parseTimelineLimit(undefined), 50);
  assert.equal(parseTimelineLimit("1"), 1);
  assert.equal(parseTimelineLimit("100"), 100);
  for (const value of ["0", "101", "1.5", "all", ["5"]]) assert.equal(parseTimelineLimit(value), null);

  const bounded = projectDeployment({ intents: [baseIntent()], limit: 1, sourceWindowFull: true });
  assert.equal(bounded.items.length, 1);
  assert.equal(bounded.truncated, true);
  assert.match(bounded.gaps.join(" "), /Earlier bounded entries|window is full/);

  const previous = config.authEnabled;
  config.authEnabled = true;
  const app = buildServer(() => null as never);
  try {
    const response = await app.inject({ method: "GET",
      url: `/api/trading-timeline/deployments/${deployment().id}?limit=5` });
    assert.equal(response.statusCode, 401);
  } finally {
    config.authEnabled = previous;
    await app.close();
  }
});
