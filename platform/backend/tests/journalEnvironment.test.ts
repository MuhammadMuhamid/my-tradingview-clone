/**
 * D3 — one order, one environment, on every surface.
 *
 * The Journal labelled every manual and automated row REAL while the chart
 * overlay called the very same simulated order DRY_RUN
 * (Integrated-Engineering-Finish-2026-11-09/repro/zz_audit_d3_environment.test.ts).
 * Two answers for one order is the defect, and REAL as a default is the worst
 * of the two answers: a testnet or dry-run fill read as real money.
 *
 * The rule both surfaces now share (src/journal/environment.ts):
 *   - REAL only with POSITIVE PER-ROW evidence;
 *   - the Bot's CURRENT mode / current dry-run flag never labels a past row;
 *   - anything unproven is UNKNOWN, and UNKNOWN is never real.
 *
 * Every assertion here goes through the public projections — the Journal's
 * row builders and the overlay's projections — so the two surfaces are
 * compared exactly as the routes call them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { journalRoutes } from "../src/api/routes/journal";
import { config } from "../src/config";
import {
  automatedActivityRows, automatedRealizationRows, manualActivityRows, paperFillRows,
  summarizeJournal,
  type AutomatedActivityEvidence, type AutomatedRealizationEvidence, type ProvenanceEvidence,
} from "../src/journal/projection";
import {
  projectCurrentOverlays, projectHistoricalOverlays,
  type ManualOverlayOrderEvidence,
} from "../src/overlays/projection";
import type { JournalResponse, JournalRow } from "../src/journal/types";

const T0 = Date.parse("2026-11-04T12:00:00Z");

/* The audit fixture's order: a simulated $100 BTCUSDT MARKET BUY. */
const order = (over: Partial<ManualOverlayOrderEvidence> = {}): ManualOverlayOrderEvidence => ({
  id: "manual-1", requestId: "req-1", clientOrderId: "cid-1", exchangeOrderId: "dry-cid-1",
  symbol: "BTCUSDT", side: "BUY", status: "filled", createdAt: T0, submittedAt: T0,
  completedAt: T0 + 1000, updatedAt: T0 + 1000, filledBaseQty: 0.00142, averageFillPrice: 70422.5,
  exchangeAccountId: "acct-testnet", orderType: "MARKET", limitPrice: null, requestedBaseQty: null,
  ...over,
});

type Account = { id: string; testnet?: unknown; mode?: unknown };
const ACCOUNTS: Account[] = [
  { id: "acct-testnet", testnet: true, mode: "testnet" },
  { id: "acct-main", testnet: false, mode: "mainnet" },
  { id: "acct-noflag" },
  { id: "acct-stringflag", testnet: "false", mode: "mainnet" },
];

/** The same order through the Journal and through the chart overlay. */
function bothSurfaces(o: ManualOverlayOrderEvidence, state: { dryRun: boolean; accounts: Account[] }) {
  const [journal] = manualActivityRows([o],
    state.accounts as Parameters<typeof manualActivityRows>[1]);
  const marker = projectHistoricalOverlays({
    symbol: "BTCUSDT",
    manual: { dryRun: state.dryRun, accounts: state.accounts as never, orders: [o], positions: [] },
    automatedActivity: [], automatedRealizations: [], paperFills: [], limit: 100,
  }).items.find((item) => item.source === "MANUAL");
  assert.ok(journal, "the Journal produced no row");
  assert.ok(marker, "the overlay produced no marker");
  return { journal: journal.environment, overlay: marker.environment };
}

// ── Manual rows ─────────────────────────────────────────────────────────────

test("the audit's simulated testnet order is DRY_RUN on both surfaces, never REAL", () => {
  assert.deepEqual(bothSurfaces(order(), { dryRun: true, accounts: ACCOUNTS }),
    { journal: "DRY_RUN", overlay: "DRY_RUN" });
});

test("a dry- exchange id is DRY_RUN even on a mainnet account and a Bot that is live today", () => {
  // The id is durable per-row proof of simulation; today's flag says nothing.
  assert.deepEqual(bothSurfaces(order({ exchangeAccountId: "acct-main" }),
    { dryRun: false, accounts: ACCOUNTS }), { journal: "DRY_RUN", overlay: "DRY_RUN" });
});

test("an acknowledged order on a testnet account is TESTNET whatever the Bot's current dry-run flag", () => {
  for (const dryRun of [true, false]) {
    assert.deepEqual(bothSurfaces(order({ exchangeOrderId: "123456" }), { dryRun, accounts: ACCOUNTS }),
      { journal: "TESTNET", overlay: "TESTNET" }, `dryRun=${dryRun}`);
  }
});

test("REAL needs an explicit mainnet account AND a non-simulated exchange id, and nothing else", () => {
  // A Bot in dry-run TODAY does not turn last week's acknowledged mainnet order
  // into a simulation, any more than a live Bot would turn a simulation real.
  for (const dryRun of [true, false]) {
    assert.deepEqual(bothSurfaces(order({ exchangeOrderId: "8812345", exchangeAccountId: "acct-main" }),
      { dryRun, accounts: ACCOUNTS }), { journal: "REAL", overlay: "REAL" }, `dryRun=${dryRun}`);
  }
});

test("missing account, missing or non-boolean flag, or no exchange acknowledgement is UNKNOWN", () => {
  const cases: Array<[string, ManualOverlayOrderEvidence, Account[]]> = [
    ["account not in the Bot's list", order({ exchangeOrderId: "8812345", exchangeAccountId: "acct-gone" }), ACCOUNTS],
    ["no account id on the order", order({ exchangeOrderId: "8812345", exchangeAccountId: null }), ACCOUNTS],
    ["no accounts at all", order({ exchangeOrderId: "8812345", exchangeAccountId: "acct-main" }), []],
    ["account without a testnet flag", order({ exchangeOrderId: "8812345", exchangeAccountId: "acct-noflag" }), ACCOUNTS],
    ["testnet flag that is not a boolean", order({ exchangeOrderId: "8812345", exchangeAccountId: "acct-stringflag" }), ACCOUNTS],
    ["mainnet account, no exchange id", order({ exchangeOrderId: null, exchangeAccountId: "acct-main" }), ACCOUNTS],
    ["mainnet account, blank exchange id", order({ exchangeOrderId: "  ", exchangeAccountId: "acct-main" }), ACCOUNTS],
    ["mainnet flag contradicted by a testnet mode", order({ exchangeOrderId: "8812345", exchangeAccountId: "acct-odd" }),
      [{ id: "acct-odd", testnet: false, mode: "testnet" }]],
  ];
  for (const [name, o, accounts] of cases) {
    for (const dryRun of [true, false]) {
      assert.deepEqual(bothSurfaces(o, { dryRun, accounts }),
        { journal: "UNKNOWN", overlay: "UNKNOWN" }, `${name} (dryRun=${dryRun})`);
    }
  }
});

test("without account context the Journal never calls a manual row REAL", () => {
  for (const exchangeOrderId of ["dry-1", "8812345", null]) {
    const [row] = manualActivityRows([order({ exchangeOrderId, exchangeAccountId: "acct-main" })]);
    assert.notEqual(row?.environment, "REAL", String(exchangeOrderId));
  }
});

test("current manual overlays (active orders, positions) use the same rule", () => {
  const state = {
    dryRun: true, accounts: ACCOUNTS as never,
    orders: [order({ id: "limit-main", status: "new", orderType: "LIMIT", limitPrice: 60000,
      exchangeOrderId: "7700", exchangeAccountId: "acct-main", completedAt: null }),
    order({ id: "limit-test", status: "new", orderType: "LIMIT", limitPrice: 60000,
      exchangeOrderId: "7701", exchangeAccountId: "acct-testnet", completedAt: null })],
    positions: [
      { id: "pos-test", exchangeAccountId: "acct-testnet", pair: "BTCUSDT", status: "active",
        entryPrice: 70000, quantity: 0.1, createdAt: T0, updatedAt: T0 },
      // A position on a mainnet account carries no exchange acknowledgement of
      // its own and may have been built from simulated fills: not proven real.
      { id: "pos-main", exchangeAccountId: "acct-main", pair: "BTCUSDT", status: "active",
        entryPrice: 70000, quantity: 0.1, createdAt: T0, updatedAt: T0 },
    ],
  };
  const items = projectCurrentOverlays({ symbol: "BTCUSDT", manual: state, automatedOrders: [],
    positions: [] });
  const env = (id: string) => items.find((item) => item.id === id)?.environment;
  assert.equal(env("manual-order:limit-main:active"), "REAL");
  assert.equal(env("manual-order:limit-test:active"), "TESTNET");
  assert.equal(env("manual-position:pos-test"), "TESTNET");
  assert.equal(env("manual-position:pos-main"), "UNKNOWN");
});

// ── Automated rows ──────────────────────────────────────────────────────────

const provenance: ProvenanceEvidence = {
  deploymentId: "11111111-1111-4111-8111-111111111111", strategyId: 7,
  strategyKey: "ma_rr_v9", strategyName: "MA + R:R", configId: "cfg-7",
  configName: "BTC disciplined", symbol: "BTCUSDT",
};
const realization = (id: number, over: Record<string, unknown> = {}): AutomatedRealizationEvidence => ({
  ...provenance, id, closedAt: T0, pnlQuote: 10, entryPrice: null, exitPrice: 120, quantity: 0.4,
  reason: "tp1", sourceEventId: `bot-realization-v1:partial:${id}`, realizationKind: "partial",
  strategyOrderIntentId: `bot-intent-${id}`, exchangeOrderId: `exchange-${id}`,
  platformOrderIntentId: String(40 + id), accountingBasis: "modeled_fee_adjusted",
  feeModel: "fixed_0.1pct_each_side_not_exchange_observed", sourceSystem: "BOT_CUSTOM_V1",
  ...over,
} as AutomatedRealizationEvidence);
const execution = (id: number, over: Record<string, unknown> = {}): AutomatedActivityEvidence => ({
  ...provenance, kind: "EXECUTION_SNAPSHOT", id, occurredAt: T0 + id, side: "BUY", state: "FILLED",
  quantity: 1, price: 100, intentId: null, executionId: id, exchangeOrderId: `exchange-${id}`,
  delivery: "custom", ...over,
} as AutomatedActivityEvidence);

/** One automated evidence row through the Journal and through the overlay. */
function automatedBoth(input: { realization?: AutomatedRealizationEvidence; activity?: AutomatedActivityEvidence }) {
  const journal = input.realization
    ? automatedRealizationRows([input.realization])[0]
    : automatedActivityRows([input.activity!])[0];
  const marker = projectHistoricalOverlays({ symbol: "BTCUSDT",
    automatedActivity: input.activity ? [input.activity] : [],
    automatedRealizations: input.realization ? [input.realization] : [],
    paperFills: [], limit: 100 }).items[0];
  assert.ok(journal && marker);
  return { journal: journal.environment, overlay: marker.environment };
}

test("Bot realizations: dry- id is DRY_RUN, an explicit environment is honoured, otherwise UNKNOWN", () => {
  assert.deepEqual(automatedBoth({ realization: realization(1, { exchangeOrderId: "dry-sell-1" }) }),
    { journal: "DRY_RUN", overlay: "DRY_RUN" });
  for (const [declared, expected] of [["TESTNET", "TESTNET"], ["MAINNET", "REAL"]]) {
    assert.deepEqual(automatedBoth({ realization: realization(2, { declaredEnvironment: declared }) }),
      { journal: expected, overlay: expected }, `declared ${declared}`);
  }
  // OD-5 consistency: a declaration must agree with the row's own exchange id.
  assert.deepEqual(automatedBoth({ realization: realization(2, { declaredEnvironment: "DRY_RUN", exchangeOrderId: "dry-sell-2" }) }),
    { journal: "DRY_RUN", overlay: "DRY_RUN" }, "DRY_RUN with a dry- id");
  assert.deepEqual(automatedBoth({ realization: realization(2, { declaredEnvironment: "DRY_RUN" }) }),
    { journal: "UNKNOWN", overlay: "UNKNOWN" }, "DRY_RUN with an exchange id is a contradiction");
  assert.deepEqual(automatedBoth({ realization: realization(2, { declaredEnvironment: "MAINNET", exchangeOrderId: "dry-sell-3" }) }),
    { journal: "UNKNOWN", overlay: "UNKNOWN" }, "MAINNET with a dry- id is a contradiction, never REAL");
  assert.deepEqual(automatedBoth({ realization: realization(2, { declaredEnvironment: "TESTNET", exchangeOrderId: "dry-sell-4" }) }),
    { journal: "DRY_RUN", overlay: "DRY_RUN" }, "a dry- id is still DRY_RUN under a TESTNET declaration");
  // Strict enum: anything else is not evidence.
  for (const declared of ["REAL", "mainnet", "LIVE", "", 1, true, null, { value: "MAINNET" }]) {
    assert.deepEqual(automatedBoth({ realization: realization(3, { declaredEnvironment: declared }) }),
      { journal: "UNKNOWN", overlay: "UNKNOWN" }, `declared ${JSON.stringify(declared)}`);
  }
  // No evidence at all: UNKNOWN, never REAL.
  assert.deepEqual(automatedBoth({ realization: realization(4) }), { journal: "UNKNOWN", overlay: "UNKNOWN" });
});

test("a legacy realization (no Bot source system) is UNKNOWN whatever it carries", () => {
  for (const over of [{ sourceSystem: null }, { sourceSystem: null, declaredEnvironment: "MAINNET" },
    { sourceSystem: undefined, exchangeOrderId: null, sourceEventId: null }]) {
    assert.deepEqual(automatedBoth({ realization: realization(5, over) }),
      { journal: "UNKNOWN", overlay: "UNKNOWN" }, JSON.stringify(over));
  }
});

test("automated activity: 3commas is UNKNOWN, a Bot dry- id is DRY_RUN, otherwise UNKNOWN", () => {
  assert.deepEqual(automatedBoth({ activity: execution(10, { delivery: "3commas", exchangeOrderId: "dry-10" }) }),
    { journal: "UNKNOWN", overlay: "UNKNOWN" });
  assert.deepEqual(automatedBoth({ activity: execution(11, { exchangeOrderId: "dry-11" }) }),
    { journal: "DRY_RUN", overlay: "DRY_RUN" });
  assert.deepEqual(automatedBoth({ activity: execution(12) }), { journal: "UNKNOWN", overlay: "UNKNOWN" });
  assert.deepEqual(automatedBoth({ activity: execution(13, { delivery: undefined }) }),
    { journal: "UNKNOWN", overlay: "UNKNOWN" });
  const [intent] = automatedActivityRows([{ ...execution(14), kind: "INTENT", state: "delivered",
    quantity: null, price: null, intentId: 14, executionId: null, exchangeOrderId: null }]);
  assert.equal(intent?.environment, "UNKNOWN");
});

test("paper fills are PAPER on both surfaces", () => {
  const fill = { ...provenance, id: 20, occurredAt: T0, action: "sell" as const, price: 101,
    quantity: 1, commission: 0.101, realizedPnl: -3, positionQtyAfter: 0, reason: "sl",
    entry: { occurredAt: T0 - 1000, price: 100, quantity: 1, commission: 0.1 } };
  assert.equal(paperFillRows([fill])[0]?.environment, "PAPER");
  assert.equal(projectHistoricalOverlays({ symbol: "BTCUSDT", automatedActivity: [],
    automatedRealizations: [], paperFills: [fill], limit: 100 }).items[0]?.environment, "PAPER");
});

test("current automated overlays are never REAL without per-row evidence", () => {
  const items = projectCurrentOverlays({ symbol: "BTCUSDT", automatedOrders: [{ ...provenance,
    executionId: 32, alertId: null, exchangeOrderId: "exchange-32", side: "SELL", orderType: "LIMIT",
    quantity: 0.2, price: 120, state: "NEW", observedAt: T0 }], positions: [
    { ...provenance, source: "AUTOMATED", price: 101, quantity: null, costBasis: null, observedAt: T0 },
    { ...provenance, deploymentId: "22222222-2222-4222-8222-222222222222", source: "PAPER",
      price: 102, quantity: 2, costBasis: 204, observedAt: T0 },
  ] });
  assert.deepEqual(items.map((item) => [item.source, item.environment]).sort(),
    [["AUTOMATED", "UNKNOWN"], ["AUTOMATED", "UNKNOWN"], ["PAPER", "PAPER"]]);
});

// ── Totals ──────────────────────────────────────────────────────────────────

function mixedRows(): JournalRow[] {
  return [
    ...manualActivityRows([
      order({ id: "m-real", exchangeOrderId: "8812345", exchangeAccountId: "acct-main" }),
      order({ id: "m-test", exchangeOrderId: "123456", exchangeAccountId: "acct-testnet" }),
      order({ id: "m-dry" }),
      order({ id: "m-unknown", exchangeOrderId: "8812346", exchangeAccountId: "acct-gone" }),
    ], ACCOUNTS as Parameters<typeof manualActivityRows>[1]),
    ...automatedRealizationRows([
      realization(1, { pnlQuote: 10, declaredEnvironment: "MAINNET" }),
      realization(2, { pnlQuote: 100, declaredEnvironment: "TESTNET" }),
      realization(3, { pnlQuote: 1000, exchangeOrderId: "dry-3" }),
      realization(4, { pnlQuote: 7 }),
    ]),
    ...paperFillRows([{ ...provenance, id: 5, occurredAt: T0, action: "sell", price: 101,
      quantity: 1, commission: 0.101, realizedPnl: -3, positionQtyAfter: 0, reason: "sl",
      entry: { occurredAt: T0 - 1000, price: 100, quantity: 1, commission: 0.1 } }]),
  ];
}

test("the real slice counts only REAL; every other environment has its own slice", () => {
  const summary = summarizeJournal(mixedRows(), "day");
  assert.equal(summary.real.knownRealizedPnl, 10);
  assert.equal(summary.real.knownRealizedRows, 1);
  // The REAL manual order is real activity with unknown economics: counted as
  // unknown, never as a figure.
  assert.equal(summary.real.unknownEconomicRows, 1);
  assert.equal(summary.testnet.knownRealizedPnl, 100);
  assert.equal(summary.testnet.unknownEconomicRows, 1);
  assert.equal(summary.dryRun.knownRealizedPnl, 1000);
  assert.equal(summary.dryRun.unknownEconomicRows, 1);
  assert.equal(summary.unknownEnvironment.knownRealizedPnl, 7);
  assert.equal(summary.unknownEnvironment.unknownEconomicRows, 1);
  assert.equal(summary.paper.knownRealizedPnl, -3);
});

test("per-period, per-symbol and per-source groups never add two environments together", () => {
  const summary = summarizeJournal(mixedRows(), "day");
  for (const [name, groups] of [["byPeriod", summary.byPeriod], ["bySymbol", summary.bySymbol],
    ["bySource", summary.bySource]] as const) {
    const items = groups as Array<{ environment?: string; source: string; summary: { knownRealizedPnl: number } }>;
    assert.ok(items.every((item) => typeof item.environment === "string"), `${name} items carry no environment`);
    const automatedReal = items.filter((item) => item.source === "AUTOMATED" && item.environment === "REAL");
    assert.equal(automatedReal.length, 1, name);
    assert.equal(automatedReal[0]!.summary.knownRealizedPnl, 10, `${name} added another environment to REAL`);
    const automated = items.filter((item) => item.source === "AUTOMATED");
    assert.deepEqual(automated.map((item) => item.environment).sort(),
      ["DRY_RUN", "REAL", "TESTNET", "UNKNOWN"], name);
  }
});

/*
 * A refresh re-reads the Bot. Its CURRENT flags may have changed in between —
 * dry-run switched on, a mainnet account added (MIXED) — and none of that may
 * move a single past row's label or a single total. Both reads go through the
 * real Journal route; the overlay projection is fed the same two states.
 */
test("a refresh after the Bot's dry-run/mixed flags flip gives identical labels and totals", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 4, 12, minute)).toISOString();
  const wireOrder = (id: string, exchangeOrderId: string | null, exchangeAccountId: string, minute: number) => ({
    id, requestId: `req-${id}`, clientOrderId: `cid-${id}`, exchangeOrderId, exchangeAccountId,
    symbol: "BTCUSDT", side: "BUY", status: "filled", createdAt: at(minute), submittedAt: at(minute),
    completedAt: at(minute), updatedAt: at(minute), filledBaseQty: 0.001, averageFillPrice: 70000,
  });
  const orders = [wireOrder("dry", "dry-cid-dry", "acct-testnet", 1), wireOrder("test", "1001", "acct-testnet", 2),
    wireOrder("main", "2002", "acct-main", 3), wireOrder("gone", "3003", "acct-gone", 4)];
  const states = [
    { dryRun: true, mixed: true, accounts: ACCOUNTS, orders },
    { dryRun: false, mixed: false, accounts: ACCOUNTS, orders },
  ];
  let read = 0;
  const app = Fastify({ logger: false });
  await journalRoutes(app, { stateRequest: (async () => states[read++]) as never });
  t.after(() => app.close());
  const get = async () => {
    const res = await app.inject({ method: "GET", url: "/api/journal?source=MANUAL&from=2026-11-04&to=2026-11-04" });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as JournalResponse;
  };
  const first = await get();
  const second = await get();
  assert.equal(read, 2, "each refresh must read the Bot again");
  const labels = (body: JournalResponse) =>
    Object.fromEntries(body.rows.map((row) => [row.identifiers.manualOrderId, row.environment]));
  assert.deepEqual(labels(first), { dry: "DRY_RUN", test: "TESTNET", main: "REAL", gone: "UNKNOWN" });
  assert.deepEqual(labels(second), labels(first));
  assert.deepEqual(second.rows, first.rows);
  assert.deepEqual(second.summary, first.summary);

  // The chart overlay, given the same two Bot states, agrees and does not move.
  const overlay = (state: typeof states[number]) => projectHistoricalOverlays({ symbol: "BTCUSDT",
    manual: { dryRun: state.dryRun, accounts: ACCOUNTS as never, positions: [],
      orders: orders.map((o) => order({ id: o.id, exchangeOrderId: o.exchangeOrderId,
        exchangeAccountId: o.exchangeAccountId, completedAt: Date.parse(o.completedAt) })) },
    automatedActivity: [], automatedRealizations: [], paperFills: [], limit: 100 }).items
    .map((item) => [item.identifiers.manualOrderId, item.environment]);
  assert.deepEqual(Object.fromEntries(overlay(states[0]!)), labels(first));
  assert.deepEqual(overlay(states[1]!), overlay(states[0]!));
});

// ── Historical rows without provenance ──────────────────────────────────────

test("history without provenance is UNKNOWN and leaves Real money evidence empty", () => {
  const rows = [
    ...automatedRealizationRows([realization(30, { sourceSystem: null, sourceEventId: null,
      exchangeOrderId: null, accountingBasis: null, feeModel: null })]),
    ...automatedActivityRows([{ ...execution(31), kind: "INTENT", state: "delivered", quantity: null,
      price: null, intentId: 31, executionId: null, exchangeOrderId: null }]),
    ...manualActivityRows([order({ id: "m-old", exchangeOrderId: null, exchangeAccountId: null })], []),
  ];
  assert.deepEqual(rows.map((row) => row.environment), ["UNKNOWN", "UNKNOWN", "UNKNOWN"]);
  const summary = summarizeJournal(rows, "day");
  // The D3 symptom was a "Real money evidence" card reading "Unknown" with
  // incomplete rows that were never real money. It is now simply empty.
  assert.equal(summary.real.knownRealizedRows, 0);
  assert.equal(summary.real.incompleteRows, 0);
  assert.equal(summary.real.unknownEconomicRows, 0);
  assert.equal(summary.real.realizationRows, 0);
});

// ── Positions (walkthrough D-4) ─────────────────────────────────────────────

test("a dry-run position on a testnet account is DRY_RUN, like its order — never TESTNET", () => {
  const entry = order({ id: "entry-dry", exchangeOrderId: "dry-cid-entry", exchangeAccountId: "acct-testnet" });
  const position = (id: string, over: Record<string, unknown>) => ({ id, exchangeAccountId: "acct-testnet",
    pair: "BTCUSDT", status: "active", entryPrice: 70000, quantity: 0.001, createdAt: T0, updatedAt: T0, ...over });
  const items = projectCurrentOverlays({ symbol: "BTCUSDT", automatedOrders: [], positions: [], manual: {
    dryRun: false, accounts: ACCOUNTS as never, orders: [entry],
    positions: [
      position("by-entry", { manualOrderId: "entry-dry" }),
      position("by-own-id", { exchangeOrderId: "dry-cid-other" }),
      position("no-ids", {}),
      position("real-entry", { exchangeAccountId: "acct-main", exchangeOrderId: "8812399" }),
      position("main-no-ids", { exchangeAccountId: "acct-main" }),
    ] } });
  const env = (id: string) => items.find((item) => item.id === `manual-position:${id}`)?.environment;
  // The position and its entry order's own marker say the same thing.
  const marker = projectHistoricalOverlays({ symbol: "BTCUSDT", automatedActivity: [], automatedRealizations: [],
    paperFills: [], limit: 10, manual: { dryRun: false, accounts: ACCOUNTS as never, orders: [entry], positions: [] } })
    .items[0]?.environment;
  assert.equal(marker, "DRY_RUN");
  assert.equal(env("by-entry"), marker);
  assert.equal(env("by-own-id"), "DRY_RUN");
  // Without the entry's identity, only the account speaks: TESTNET, never REAL.
  assert.equal(env("no-ids"), "TESTNET");
  assert.equal(env("real-entry"), "REAL", "an acknowledged mainnet entry is real exposure");
  assert.equal(env("main-no-ids"), "UNKNOWN");
});
