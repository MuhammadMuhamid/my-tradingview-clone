import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSyncedProperties,
  layoutStateFromDeployment,
  pickSyncDeployment,
} from "../src/repositories/layouts";
import type { DeploymentRow } from "../src/types/deployments";
import { initialRuntimeState } from "../src/types/deployments";

function dep(over: Partial<DeploymentRow>): DeploymentRow {
  return {
    id: "d1",
    strategyId: 1,
    configId: null,
    symbol: "DEXEUSDT",
    timeframe: "15m",
    params: { ma_len: 50 },
    status: "active",
    delivery: "custom",
    webhookUrl: null,
    secret: null,
    botUuid: null,
    buyQuoteQty: 340.01,
    runtimeState: initialRuntimeState(),
    lastBarTime: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

test("synced layout takes symbol/timeframe/strategy/params from the deployment", () => {
  const state = layoutStateFromDeployment(dep({}), "ma_rr_v9", null);
  assert.equal(state.symbol, "DEXEUSDT");
  assert.equal(state.timeframe, "15m");
  assert.equal(state.strategyKey, "ma_rr_v9");
  assert.deepEqual(state.params, { ma_len: 50 });
  // Fresh layouts get the user's standard backtest properties (handoff §7).
  assert.deepEqual(state.properties, defaultSyncedProperties(340.01));
  assert.equal(state.properties.initialCapital, 1000);
  assert.equal(state.properties.qtyType, "percent_of_equity");
  assert.equal(state.properties.qtyValue, 100);
  assert.equal(state.properties.commissionPct, 0.1);
  assert.equal(state.properties.slippageTicks, 0);
  assert.equal(state.bars, 10000);
});

test("sync preserves existing layout properties and history depth", () => {
  const existing = {
    bars: 50000,
    properties: {
      initialCapital: 2500, qtyCash: 800, qtyType: "cash" as const,
      qtyValue: 800, commissionPct: 0.05, slippageTicks: 2,
    },
  };
  const state = layoutStateFromDeployment(
    dep({ params: { ma_len: 99 } }), "srtrend_v10", existing
  );
  assert.equal(state.bars, 50000);
  assert.deepEqual(state.properties, existing.properties);
  assert.deepEqual(state.params, { ma_len: 99 }); // deployment stays authoritative
  assert.equal(state.strategyKey, "srtrend_v10");
});

test("pickSyncDeployment prefers active over paused, then newest", () => {
  const rows = [
    dep({ id: "a", status: "paused", createdAt: "2026-03-01T00:00:00.000Z" }),
    dep({ id: "b", status: "active", createdAt: "2026-01-01T00:00:00.000Z" }),
    dep({ id: "c", status: "active", createdAt: "2026-02-01T00:00:00.000Z" }),
    dep({ id: "z", symbol: "ZECUSDT", status: "paused" }),
  ];
  const chosen = pickSyncDeployment(rows);
  assert.equal(chosen.size, 2);
  assert.equal(chosen.get("DEXEUSDT")?.id, "c");
  assert.equal(chosen.get("ZECUSDT")?.id, "z");
});
