import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { config } from "../src/config";
import { buildServer } from "../src/api/server";
import {
  MAX_OVERLAY_ITEMS, MAX_OVERLAY_RANGE_MS, overlayReadPlan, parseTradingOverlayQuery,
} from "../src/api/routes/tradingOverlays";
import {
  isActiveOrderState, overlaysWithinRange, projectCurrentOverlays, projectHistoricalOverlays,
  type ManualOverlayStateEvidence,
} from "../src/overlays/projection";

const T0 = Date.UTC(2026, 8, 1, 12);
const provenance = { deploymentId: "11111111-1111-4111-8111-111111111111",
  strategyId: 7, strategyKey: "ma_rr_v9", strategyName: "MA RR",
  configId: "cfg-7", configName: "Production", symbol: "BTCUSDT" };
const manual = (overrides: Partial<ManualOverlayStateEvidence> = {}): ManualOverlayStateEvidence => ({
  dryRun: false, accounts: [{ id: "main", testnet: false }], positions: [],
  orders: [{ id: "manual-1", requestId: "request-1", clientOrderId: "client-1",
    exchangeOrderId: "exchange-1", exchangeAccountId: "main", symbol: "BTCUSDT",
    side: "BUY", status: "filled", createdAt: T0, submittedAt: T0 + 1000,
    completedAt: T0 + 2000, updatedAt: T0 + 2000, filledBaseQty: 0.5,
    averageFillPrice: 100, orderType: "MARKET", limitPrice: null,
    requestedBaseQty: 0.5 }], ...overrides,
});

test("manual cumulative completion is one order-level activity marker, never individual fills", () => {
  const result = projectHistoricalOverlays({ symbol: "BTCUSDT", manual: manual(),
    automatedActivity: [], automatedRealizations: [], paperFills: [], limit: 50 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.evidenceKind, "ORDER_COMPLETION_EXECUTED_ACTIVITY");
  assert.match(result.items[0]?.detail ?? "", /not an individual exchange fill/i);
  assert.equal(result.items[0]?.quantity, 0.5);
});

test("manual snapshot without completion, trustworthy price, or quantity fabricates no event", () => {
  for (const patch of [{ completedAt: null }, { averageFillPrice: null }, { filledBaseQty: 0 }]) {
    const state = manual(); state.orders[0] = { ...state.orders[0]!, ...patch };
    assert.equal(projectHistoricalOverlays({ symbol: "BTCUSDT", manual: state,
      automatedActivity: [], automatedRealizations: [], paperFills: [], limit: 50 }).items.length, 0);
  }
});

test("linked automated execution, realization, paper fill and provenance remain distinct", () => {
  const result = projectHistoricalOverlays({ symbol: "BTCUSDT",
    automatedActivity: [
      { ...provenance, kind: "INTENT", id: 1, occurredAt: T0, side: "BUY", state: "delivered",
        quantity: null, price: null, intentId: 1, executionId: null, exchangeOrderId: null },
      { ...provenance, kind: "EXECUTION_SNAPSHOT", id: 2, occurredAt: T0 + 1000,
        side: "BUY", state: "FILLED", quantity: 1, price: 100, intentId: null,
        executionId: 2, exchangeOrderId: "exchange-2" },
      // Same authoritative row exposed twice collapses by stable identity.
      { ...provenance, kind: "EXECUTION_SNAPSHOT", id: 2, occurredAt: T0 + 1000,
        side: "BUY", state: "FILLED", quantity: 1, price: 100, intentId: null,
        executionId: 2, exchangeOrderId: "exchange-2" },
      { ...provenance, kind: "EXECUTION_SNAPSHOT", id: 3, occurredAt: T0 + 2000,
        side: "BUY", state: "NEW", quantity: 1, price: 100, intentId: null,
        executionId: 3, exchangeOrderId: "exchange-3" },
      { ...provenance, kind: "EXECUTION_SNAPSHOT", id: 4, occurredAt: T0 + 2500,
        side: "BUY", state: "REJECTED", quantity: 0, price: 100, intentId: null,
        executionId: 4, exchangeOrderId: "exchange-4" },
    ],
    automatedRealizations: [{ ...provenance, id: 9, closedAt: T0 + 3000, pnlQuote: 5,
      entryPrice: 90, exitPrice: 105, quantity: 0.5, reason: "TP1" }],
    paperFills: [{ ...provenance, id: 12, occurredAt: T0 + 4000, action: "sell",
      price: 106, quantity: 0.5, commission: 0.1, realizedPnl: 8,
      positionQtyAfter: 0, reason: "target", entry: null }], limit: 50 });
  assert.deepEqual(result.items.map((item) => item.id),
    ["automated-execution:2", "automated-realization:9", "paper-fill:12"]);
  assert.equal(result.items[0]?.identifiers.executionId, "2");
  assert.equal(result.items[0]?.identifiers.exchangeOrderId, "exchange-2");
  assert.equal(result.items[0]?.provenance.deploymentId, provenance.deploymentId);
  assert.equal(result.items[2]?.environment, "PAPER");
});

test("exchange-order text is scoped by deployment and never conflates authoritative identities", () => {
  const execution = { ...provenance, kind: "EXECUTION_SNAPSHOT" as const, id: 20,
    occurredAt: T0, side: "BUY" as const, state: "FILLED", quantity: 1, price: 100,
    intentId: null, executionId: 20, exchangeOrderId: "shared-text" };
  const result = projectHistoricalOverlays({ symbol: "BTCUSDT", automatedActivity: [
    execution,
    { ...execution, id: 21, executionId: 21,
      deploymentId: "22222222-2222-4222-8222-222222222222" },
  ], automatedRealizations: [], paperFills: [], limit: 50 });
  assert.deepEqual(result.items.map((row) => row.id),
    ["automated-execution:20", "automated-execution:21"]);
});

test("active LIMIT snapshots render; terminal orders do not", () => {
  const state = manual();
  state.orders = [{ ...state.orders[0]!, status: "partially_filled", orderType: "LIMIT",
    limitPrice: 99, requestedBaseQty: 2, updatedAt: T0 + 5000 }];
  const items = projectCurrentOverlays({ symbol: "BTCUSDT", manual: state,
    automatedOrders: [{ ...provenance, executionId: 5, alertId: 4,
      exchangeOrderId: "x-5", side: "SELL", orderType: "LIMIT", quantity: 0.2,
      price: 120, state: "NEW", observedAt: T0 + 5000 }], positions: [] });
  assert.equal(items.filter((item) => item.kind === "ACTIVE_ORDER_LINE").length, 2);
  assert.equal(items.find((item) => item.id === "manual-order:manual-1:active")?.quantity, 2,
    "active order quantity is the requested base quantity, not cumulative execution");
  assert.ok(items.every((item) => item.observedAt !== null));
  assert.equal(isActiveOrderState("FILLED"), false);
  state.orders[0]!.status = "canceled";
  assert.equal(projectCurrentOverlays({ symbol: "BTCUSDT", manual: state,
    automatedOrders: [], positions: [] }).some((item) => item.kind === "ACTIVE_ORDER_LINE"), false);
});

test("positions come only from explicit existing models and preserve REAL versus PAPER", () => {
  const noPosition = projectCurrentOverlays({ symbol: "BTCUSDT", manual: manual(),
    automatedOrders: [], positions: [] });
  assert.equal(noPosition.some((item) => item.kind === "POSITION_LINE"), false,
    "a completed Manual BUY is not a position");
  const state = manual({ positions: [{ id: "position-1", exchangeAccountId: "main",
    pair: "BTCUSDT", status: "active", entryPrice: 100, quantity: 0.5,
    createdAt: T0, updatedAt: T0 + 6000 }] });
  const items = projectCurrentOverlays({ symbol: "BTCUSDT", manual: state,
    automatedOrders: [], positions: [
      { ...provenance, source: "AUTOMATED", price: 101, quantity: null,
        costBasis: null, observedAt: T0 + 6000 },
      { ...provenance, deploymentId: "22222222-2222-4222-8222-222222222222",
        source: "PAPER", price: 102, quantity: 2, costBasis: 204, observedAt: T0 + 6000 },
    ] });
  assert.deepEqual(items.filter((item) => item.kind === "POSITION_LINE").map((item) => item.environment).sort(),
    ["REAL", "PAPER", "REAL"].sort());
  assert.match(items.find((item) => item.id.startsWith("manual-position"))?.detail ?? "", /never|No position was reconstructed/i);
});

test("API parsing enforces exact range/cutoff/limit bounds before reads", () => {
  const valid = parseTradingOverlayQuery({ symbol: "btcusdt", from: String(T0),
    to: String(T0 + 10_000), replayCutoff: String(T0 + 5000), limit: "500" });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.value.to.getTime(), T0 + 5000);
  if (valid.ok) assert.deepEqual(overlayReadPlan(valid.value),
    { historical: true, current: false, manualState: false },
    "Replay performs no current/manual live-state read");
  assert.equal(parseTradingOverlayQuery({ symbol: "BTCUSDT", from: String(T0),
    to: String(T0 + MAX_OVERLAY_RANGE_MS + 1) }).ok, false);
  for (const limit of ["0", String(MAX_OVERLAY_ITEMS + 1), "all", "1.5"]) {
    assert.equal(parseTradingOverlayQuery({ symbol: "BTCUSDT", from: String(T0),
      to: String(T0 + 1), limit }).ok, false);
  }
  assert.equal(parseTradingOverlayQuery({ symbol: "BTCUSDT", from: String(T0),
    to: String(T0 + 1), scope: "generic-sql" }).ok, false);
});

test("projection-side Replay horizon removes future evidence before serialization", () => {
  const projected = projectHistoricalOverlays({ symbol: "BTCUSDT", manual: undefined,
    automatedActivity: [], automatedRealizations: [], paperFills: [
      { ...provenance, id: 1, occurredAt: T0 + 1000, action: "buy", price: 100,
        quantity: 1, commission: 0, realizedPnl: null, positionQtyAfter: 1,
        reason: null, entry: null },
      { ...provenance, id: 2, occurredAt: T0 + 9000, action: "buy", price: 101,
        quantity: 1, commission: 0, realizedPnl: null, positionQtyAfter: 1,
        reason: null, entry: null },
    ], limit: 50 });
  assert.deepEqual(overlaysWithinRange(projected.items, T0, T0 + 5000).map((row) => row.id),
    ["paper-fill:1"]);
});

test("overlay route is session protected and has no per-marker Bot evidence fan-out", async () => {
  const previous = config.authEnabled; config.authEnabled = true;
  const app = buildServer(() => null as never);
  try {
    const response = await app.inject({ method: "GET",
      url: `/api/trading-overlays?symbol=BTCUSDT&from=${T0}&to=${T0 + 1000}` });
    assert.equal(response.statusCode, 401);
  } finally { config.authEnabled = previous; await app.close(); }
  const source = readFileSync("src/api/routes/tradingOverlays.ts", "utf8");
  assert.doesNotMatch(source, /readStrategyExecutionEvidence|readManualExecutionEvidence/);
  assert.equal((source.match(/manualBotRequest</g) ?? []).length, 1);
});

test("large fixture is newest-first bounded with truthful truncation", () => {
  const paperFills = Array.from({ length: 700 }, (_, index) => ({ ...provenance, id: index + 1,
    occurredAt: T0 + index, action: "buy" as const, price: 100, quantity: 1,
    commission: 0, realizedPnl: null, positionQtyAfter: 1, reason: null, entry: null }));
  const result = projectHistoricalOverlays({ symbol: "BTCUSDT", automatedActivity: [],
    automatedRealizations: [], paperFills, limit: 500 });
  assert.equal(result.items.length, 500); assert.equal(result.truncated, true);
  assert.equal(result.items[0]?.id, "paper-fill:201");
});
