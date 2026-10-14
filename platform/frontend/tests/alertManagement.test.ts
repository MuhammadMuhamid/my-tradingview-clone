import { test } from "node:test";
import assert from "node:assert/strict";
import type { MaAlert } from "../lib/api";
import {
  ALERT_TYPE_FILTERS, alertTimeframeOptions, buildBulkRequest, bulkCompletionMessage,
  deleteConfirmation, describeAlertScope, filterAlerts, normalizeTimeframeFilter,
  type AlertFilters, type AlertTypeFilter,
} from "../lib/alertManagement";

const base: MaAlert = {
  id: "base", symbol: "BTCUSDT", timeframe: "1h", conditionKind: "price",
  filters: null,
  maType: null, maLength: null, mode: null, ma2Type: null, ma2Length: null,
  targetPrice: 100, priceDirection: "either",
  srSide: null, srPivotLength: null, srInvalidation: null,
  pivotType: null, pivotLevelName: null, pivotAnchor: null,
  rsiLength: null, rsiLevel: null, rsiMaLength: null,
  macdFast: null, macdSlow: null, macdSignal: null, indicatorTarget: null,
  filterRsiLength: null, filterRsiLevel: null, filterRsiSide: null,
  filterMaType: null, filterMaLength: null, filterMaSide: null,
  filterStPeriod: null, filterStMultiplier: null,
  filterStAtrMethod: null, filterStSide: null,
  stPeriod: null, stMultiplier: null, stAtrMethod: null,
  bbLength: null, bbMult: null, bbBand: null, bbMaType: null,
  stochKLength: null, stochKSmooth: null, stochDSmooth: null, stochLevel: null,
  adxDiLength: null, adxSmoothing: null, adxLevel: null,
  nearMinPct: 0.2, nearMaxPct: 0.5, enabled: true,
  frequency: "once_per_bar_close", cooldownMin: 0, note: null,
  lastSide: null, lastFiredAt: null, lastFiredBarTime: null,
  lastBarTime: null, completedAt: null, createdAt: "", updatedAt: "",
};
const alert = (id: string, over: Partial<MaAlert>): MaAlert => ({ ...base, id, ...over });
const all: AlertFilters = { search: "", status: "all", type: "all", timeframe: "all" };

const fixtures = [
  alert("price", { conditionKind: "price" }),
  alert("ema", { conditionKind: "ma", maType: "ema", maLength: 200, mode: "touch" }),
  alert("sma", { conditionKind: "ma", maType: "sma", maLength: 50, mode: "touch" }),
  alert("cross", {
    conditionKind: "ma_vs_ma",
    filters: null, maType: "ema", maLength: 50,
    ma2Type: "sma", ma2Length: 200, mode: "cross_up",
  }),
  alert("sr", { conditionKind: "sr_zone", srSide: "support", mode: "touch" }),
  alert("pivot", { conditionKind: "pivot_level", pivotLevelName: "P", mode: "touch" }),
  alert("rsi", { conditionKind: "rsi", rsiLength: 14, mode: "cross_up" }),
  alert("macd", { conditionKind: "macd", macdFast: 12, macdSlow: 26, mode: "cross_up" }),
  alert("supertrend", {
    conditionKind: "supertrend",
    filters: null, stPeriod: 10, stMultiplier: 3,
    stAtrMethod: "rma", mode: "cross_up",
  }),
  alert("bollinger", { conditionKind: "bollinger", mode: "touch" }),
  alert("stochastic", { conditionKind: "stochastic", mode: "cross_up" }),
  alert("adx", { conditionKind: "adx", mode: "cross_up" }),
  alert("fib", { conditionKind: "fib_level", fibLevel: 0.618, fibDeviation: 3, fibDepth: 30, fibReverse: false, mode: "touch" }),
];

test("symbol search is case-insensitive for exact and partial coin names", () => {
  assert.equal(filterAlerts(fixtures, { ...all, search: "BTCUSDT" }).length, fixtures.length);
  assert.equal(filterAlerts(fixtures, { ...all, search: "btc" }).length, fixtures.length);
  assert.equal(filterAlerts(fixtures, { ...all, search: " eth " }).length, 0);
});

test("active and paused/inactive status include spent once-only alerts truthfully", () => {
  const states = [
    alert("active", {}),
    alert("paused", { enabled: false }),
    alert("spent", { frequency: "once_only", completedAt: "2026-08-31T00:00:00Z" }),
  ];
  assert.deepEqual(
    filterAlerts(states, { ...all, status: "active" }).map((item) => item.id), ["active"]
  );
  assert.deepEqual(
    filterAlerts(states, { ...all, status: "inactive" }).map((item) => item.id),
    ["paused", "spent"]
  );
});

test("every family mapping and reliable EMA/SMA subtype mapping is covered", () => {
  const expected: Record<AlertTypeFilter, string[]> = {
    all: fixtures.map((item) => item.id),
    price: ["price"], ma: ["ema", "sma"], ma_ema: ["ema"], ma_sma: ["sma"],
    ma_vs_ma: ["cross"], sr_zone: ["sr"], pivot_level: ["pivot"], fib_level: ["fib"],
    rsi: ["rsi"], macd: ["macd"], supertrend: ["supertrend"],
    bollinger: ["bollinger"], stochastic: ["stochastic"], adx: ["adx"],
  };
  assert.deepEqual(ALERT_TYPE_FILTERS.map((option) => option.value), Object.keys(expected));
  for (const [type, ids] of Object.entries(expected)) {
    assert.deepEqual(
      filterAlerts(fixtures, { ...all, type: type as AlertTypeFilter }).map((item) => item.id),
      ids,
      type
    );
  }
});

test("search, status, and type filters compose", () => {
  const rows = [
    alert("btc-active-rsi", { conditionKind: "rsi", rsiLength: 14 }),
    alert("btc-paused-rsi", { conditionKind: "rsi", rsiLength: 14, enabled: false }),
    alert("eth-paused-rsi", { symbol: "ETHUSDT", conditionKind: "rsi", rsiLength: 14, enabled: false }),
    alert("btc-paused-macd", { conditionKind: "macd", enabled: false }),
  ];
  assert.deepEqual(filterAlerts(rows, {
    search: "btc", status: "inactive", type: "rsi", timeframe: "all",
  }).map((item) => item.id), ["btc-paused-rsi"]);
});

test("bulk pause/resume/delete use explicit deduplicated IDs and reject empty scope", () => {
  for (const action of ["pause", "resume", "delete"] as const) {
    assert.deepEqual(buildBulkRequest(action, [fixtures[0]!, fixtures[0]!, fixtures[6]!]), {
      action, ids: ["price", "rsi"],
    });
    assert.equal(buildBulkRequest(action, []), null);
    assert.match(bulkCompletionMessage(action, 2, {
      action, requested: 2, affected: 2, missingIds: [],
    }), /2 alerts$/);
  }
});

test("a partial or mismatched bulk result is surfaced instead of reported as success", () => {
  assert.throws(() => bulkCompletionMessage("pause", 3, {
    action: "pause", requested: 3, affected: 2, missingIds: [],
  }), /changed 2 of 3/);
  assert.throws(() => bulkCompletionMessage("resume", 1, {
    action: "resume", requested: 1, affected: 0, missingIds: ["gone"],
  }), /result may be partial/);
});

test("delete confirmation names exact filtered count and empty scope cannot confirm", () => {
  assert.equal(deleteConfirmation({ search: "btc", status: "inactive", type: "rsi", timeframe: "all" }, 12),
    "Delete 12 paused / inactive RSI alerts matching “btc”?\n\n" +
    "Only the current filtered result will be deleted. This cannot be undone."
  );
  assert.equal(deleteConfirmation(all, 0), null);
});

// ── the timeframe filter ──────────────────────────────────────────────────

test("only timeframes some alert is on are offered, in duration order", () => {
  const rows = [
    alert("a", { timeframe: "4h" }),
    alert("b", { timeframe: "15m" }),
    alert("c", { timeframe: "4h" }),
    alert("d", { timeframe: "1h" }),
  ];
  // 15m sorts between 5m and 1h rather than between 12h and 1d, which is what
  // an alphabetical list would do.
  assert.deepEqual(alertTimeframeOptions(rows), ["15m", "1h", "4h"]);
  assert.deepEqual(alertTimeframeOptions([]), []);
});

test("the timeframe narrows the list and composes with the other filters", () => {
  const rows = [
    alert("btc-4h", { symbol: "BTCUSDT", timeframe: "4h" }),
    alert("btc-1h", { symbol: "BTCUSDT", timeframe: "1h" }),
    alert("eth-4h", { symbol: "ETHUSDT", timeframe: "4h" }),
  ];
  assert.deepEqual(
    filterAlerts(rows, { ...all, timeframe: "4h" }).map((a) => a.id),
    ["btc-4h", "eth-4h"]
  );
  assert.deepEqual(
    filterAlerts(rows, { ...all, timeframe: "4h", search: "btc" }).map((a) => a.id),
    ["btc-4h"]
  );
});

test("the chosen timeframe falls back to all once its last alert is gone", () => {
  // Deleting the last 4h alert while filtered to 4h would otherwise leave an
  // empty list under a filter whose point is no longer visible — which reads
  // as "my alerts are gone" rather than "nothing matches".
  const chosen: AlertFilters = { ...all, timeframe: "4h" };
  assert.equal(
    normalizeTimeframeFilter(chosen, [alert("a", { timeframe: "4h" })]).timeframe,
    "4h",
    "a timeframe that still has alerts is kept"
  );
  assert.equal(
    normalizeTimeframeFilter(chosen, [alert("a", { timeframe: "1h" })]).timeframe,
    "all"
  );
  assert.equal(normalizeTimeframeFilter(chosen, []).timeframe, "all");
});

test("the scope sentence names the timeframe last, so it still reads as one scope", () => {
  assert.equal(
    describeAlertScope({ ...all, status: "active", type: "rsi", search: "BTC", timeframe: "4h" }, 3),
    "3 active RSI alerts matching “BTC” on 4h"
  );
  assert.equal(describeAlertScope(all, 3), "3 alerts");
});
