import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";
import { buildServer } from "../src/api/server";
import { parseTimelineLimit } from "../src/api/routes/tradingTimeline";
import { initialRuntimeState, type DeploymentRow } from "../src/types/deployments";
import {
  projectDeploymentTimeline, projectManualOrder, type ExecutionEvidence,
} from "../src/timeline/projection";

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const at = (offset: number) => new Date(T0 + offset).toISOString();

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
