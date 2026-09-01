import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJournalQuery, MAX_JOURNAL_PAGE_SIZE } from "../src/api/routes/journal";
import { buildServer } from "../src/api/server";
import { config } from "../src/config";
import {
  automatedActivityRows, automatedRealizationRows, botPartialCloseRows,
  manualActivityRows, paperFillRows, summarizeJournal,
  type ProvenanceEvidence,
} from "../src/journal/projection";
import type { StrategyExecutionEvidence } from "../src/timeline/botEvidenceClient";

const T0 = Date.UTC(2026, 8, 1, 12);
const provenance: ProvenanceEvidence = {
  deploymentId: "11111111-1111-4111-8111-111111111111", strategyId: 7,
  strategyKey: "ma_rr_v9", strategyName: "MA + R:R", configId: "cfg-7",
  configName: "BTC disciplined", symbol: "BTCUSDT",
};

const strategyEvidence = (partialId: string, pnl: number, at = T0): StrategyExecutionEvidence => ({
  evidenceType: "STRATEGY_ORDER_INTENT",
  identity: { evidenceClass: "AUTHORITATIVE_LINKAGE", strategyOrderIntentId: `intent-${partialId}`,
    sourceKey: `bot:BTCUSDT:sell:X-${partialId}`, callerDedupeKey: `X-${partialId}`,
    botId: "bot", clientOrderId: `client-${partialId}`, exchangeOrderId: `exchange-${partialId}` },
  order: { symbol: "BTCUSDT", side: "SELL", orderType: "MARKET",
    requestedBaseQuantity: 0.25, requestedQuoteQuantity: null, sellPercent: 25,
    exitLeg: "tp1", simulated: false },
  events: [{ evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
    type: "STRATEGY_PARTIAL_CLOSE_ACCOUNTING_APPLIED", occurredAt: new Date(at).toISOString(),
    identifiers: { partialCloseId: partialId, exchangeOrderId: `exchange-${partialId}` },
    quantities: { baseQuantity: 0.25, quoteRevenue: 30, averagePrice: 120,
      realizedPnlQuote: pnl } }],
  currentState: { evidenceClass: "CURRENT_AUTHORITATIVE_STATE", intentStatus: "reconciled",
    exchangeOrderStatus: "FILLED", cumulativeExecutedBaseQuantity: 0.25,
    cumulativeExecutedQuoteQuantity: 30, averageFillPrice: 120,
    observedAt: new Date(at + 10_000).toISOString() }, limitations: [],
});

test("automated persisted realization keeps authoritative provenance and P&L without inventing fees", () => {
  const [row] = automatedRealizationRows([{ ...provenance, id: 9, closedAt: T0,
    pnlQuote: 10, entryPrice: 100, exitPrice: 110, quantity: 1, reason: "tp" }]);
  assert.equal(row?.source, "AUTOMATED");
  assert.equal(row?.realizedPnl, 10);
  assert.equal(row?.netRealizedPnl, null);
  assert.equal(row?.fees, null);
  assert.equal(row?.grossRealizedPnl, null);
  assert.equal(row?.identifiers.realizedPnlId, "9");
  assert.equal(row?.strategy?.key, "ma_rr_v9");
  assert.equal(row?.config?.id, "cfg-7");
});

test("multiple exact PartialClose events are unique and aggregate once", () => {
  const first = strategyEvidence("partial-1", 5, T0);
  const second = strategyEvidence("partial-2", -2, T0 + 1000);
  const rows = botPartialCloseRows([
    { deployment: provenance, evidence: first },
    { deployment: provenance, evidence: first },
    { deployment: provenance, evidence: second },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ["partial-close:partial-1", "partial-close:partial-2"]);
  const summary = summarizeJournal(rows, "day");
  assert.equal(summary.knownRealizedRows, 2);
  assert.equal(summary.knownRealizedPnl, 3);
});

test("current cumulative snapshot never becomes a second realization", () => {
  const evidence = strategyEvidence("partial-1", 5);
  evidence.currentState.cumulativeExecutedBaseQuantity = 99;
  evidence.currentState.cumulativeExecutedQuoteQuantity = 99_000;
  const rows = botPartialCloseRows([{ deployment: provenance, evidence }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.quantity, 0.25);
  assert.equal(summarizeJournal(rows, "day").knownRealizedPnl, 5);
});

test("paper realization reuses persisted accounting, remains PAPER, and derives exact known fees", () => {
  const [row] = paperFillRows([{ ...provenance, id: 3, occurredAt: T0 + 3_600_000,
    action: "sell", price: 120, quantity: 0.5, commission: 0.06, realizedPnl: 9.89,
    positionQtyAfter: 0.5, reason: "tp1",
    entry: { occurredAt: T0, price: 100, quantity: 1, commission: 0.1 } }]);
  assert.equal(row?.environment, "PAPER");
  assert.equal(row?.source, "PAPER");
  assert.equal(row?.kind, "REALIZATION");
  assert.ok(Math.abs(row!.fees! - 0.11) < 1e-12);
  assert.ok(Math.abs(row!.grossRealizedPnl! - 10) < 1e-12);
  assert.equal(row?.netRealizedPnl, 9.89);
  assert.equal(row?.realizedPnl, 9.89);
  assert.equal(row?.durationMs, 3_600_000);
});

test("manual cumulative execution is activity with unknown P&L and no order pairing", () => {
  const [row] = manualActivityRows([{ id: "manual-1", requestId: "request-1",
    clientOrderId: "client-1", exchangeOrderId: "exchange-1", symbol: "ETHUSDT",
    side: "SELL", status: "filled", createdAt: T0, submittedAt: T0 + 1000,
    completedAt: T0 + 2000, updatedAt: T0 + 2000, filledBaseQty: 0.5,
    averageFillPrice: 2000 }]);
  assert.equal(row?.kind, "ACTIVITY");
  assert.equal(row?.netRealizedPnl, null);
  assert.equal(row?.realizedPnl, null);
  assert.equal(row?.fees, null);
  assert.equal(row?.entryPrice, null);
  assert.equal(row?.exitPrice, 2000);
  assert.equal(row?.identifiers.manualOrderId, "manual-1");
});

test("known outcomes and incomplete activity keep totals and counts semantically separate", () => {
  const realized = automatedRealizationRows([{ ...provenance, id: 1, closedAt: T0,
    pnlQuote: 10, entryPrice: null, exitPrice: null, quantity: null, reason: null },
  { ...provenance, id: 2, closedAt: T0 + 1000,
    pnlQuote: -4, entryPrice: null, exitPrice: null, quantity: null, reason: null }]);
  const activity = automatedActivityRows([{ ...provenance, kind: "EXECUTION_SNAPSHOT", id: 8,
    occurredAt: T0 + 2000, side: "BUY", state: "FILLED", quantity: 1, price: 100,
    intentId: null, executionId: 8, exchangeOrderId: "x-8" }]);
  const summary = summarizeJournal([...realized, ...activity], "day");
  assert.equal(summary.knownRealizedPnl, 6);
  assert.equal(summary.knownRealizedRows, 2);
  assert.equal(summary.realizationRows, 2);
  assert.equal(summary.unknownEconomicRows, 1);
  assert.equal(summary.incompleteRows, 3);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
});

test("daily, weekly, and monthly buckets use realization time only", () => {
  const rows = automatedRealizationRows([
    { ...provenance, id: 1, closedAt: Date.UTC(2026, 7, 31, 23), pnlQuote: 1,
      entryPrice: null, exitPrice: null, quantity: null, reason: null },
    { ...provenance, id: 2, closedAt: Date.UTC(2026, 8, 1, 1), pnlQuote: 2,
      entryPrice: null, exitPrice: null, quantity: null, reason: null },
  ]);
  assert.deepEqual(summarizeJournal(rows, "day").byPeriod.map((x) => x.bucket),
    ["2026-09-01", "2026-08-31"]);
  assert.deepEqual(summarizeJournal(rows, "week").byPeriod.map((x) => x.bucket), ["2026-08-31"]);
  assert.deepEqual(summarizeJournal(rows, "month").byPeriod.map((x) => x.bucket),
    ["2026-09", "2026-08"]);
});

test("activity without a realization timestamp is excluded from realized date buckets", () => {
  const rows = automatedActivityRows([{ ...provenance, kind: "INTENT", id: 1,
    occurredAt: T0, side: "BUY", state: "delivered", quantity: null, price: null,
    intentId: 1, executionId: null, exchangeOrderId: null }]);
  assert.deepEqual(summarizeJournal(rows, "day").byPeriod, []);
});

test("real and paper summaries cannot be numerically conflated", () => {
  const real = automatedRealizationRows([{ ...provenance, id: 1, closedAt: T0,
    pnlQuote: 10, entryPrice: null, exitPrice: null, quantity: null, reason: null }]);
  const paper = paperFillRows([{ ...provenance, id: 2, occurredAt: T0, action: "sell",
    price: 101, quantity: 1, commission: 0.101, realizedPnl: -3,
    positionQtyAfter: 0, reason: "sl",
    entry: { occurredAt: T0 - 1000, price: 100, quantity: 1, commission: 0.1 } }]);
  const summary = summarizeJournal([...real, ...paper], "day");
  assert.equal(summary.real.knownRealizedPnl, 10);
  assert.equal(summary.paper.knownRealizedPnl, -3);
  assert.deepEqual(summary.bySource.map((x) => x.source).sort(), ["AUTOMATED", "PAPER"]);
});

test("query filters and pagination are validated and hard bounded", () => {
  const parsed = parseJournalQuery({ from: "2026-08-01", to: "2026-09-01",
    source: "paper", symbol: "btcusdt", period: "month", page: "2", limit: "100" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value.sources, ["PAPER"]);
    assert.equal(parsed.value.symbol, "BTCUSDT");
    assert.equal(parsed.value.page, 2);
    assert.equal(parsed.value.limit, MAX_JOURNAL_PAGE_SIZE);
    assert.equal(parsed.value.toExclusive.toISOString(), "2026-09-02T00:00:00.000Z");
  }
  assert.equal(parseJournalQuery({ from: "2020-01-01", to: "2026-09-01" }).ok, false);
  assert.equal(parseJournalQuery({ limit: "101" }).ok, false);
  assert.equal(parseJournalQuery({ source: "REAL" }).ok, false);
});

test("Journal read API is protected by the Platform session gate", async () => {
  const previous = { enabled: config.authEnabled, secret: config.sessionSecret,
    username: config.adminUsername };
  config.authEnabled = true;
  config.sessionSecret = "s".repeat(64);
  config.adminUsername = "journal-admin";
  const app = buildServer(() => null as never);
  try {
    const response = await app.inject({ method: "GET",
      url: "/api/journal?from=2026-09-01&to=2026-09-01" });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    config.authEnabled = previous.enabled;
    config.sessionSecret = previous.secret;
    config.adminUsername = previous.username;
  }
});
