import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readCondition, toColumns } from "../src/alerts/alertRequest";
import { conditionFromRow, validateCondition } from "../src/alerts/alertConditions";
import { planAlert, type AlertSpec, type FeedSample } from "../src/alerts/alertPlan";
import { MaAlertRunner } from "../src/engine/maAlertRunner";
import type { MaAlertRow } from "../src/types/maAlerts";
import type { Candle } from "../src/types/market";

const T0 = Date.UTC(2026, 8, 8);
const bar: Candle = {
  symbol: "BTCUSDT", interval: "1h", openTime: T0, closeTime: T0 + 3_600_000 - 1,
  open: 100, high: 112, low: 98, close: 110, volume: 10,
};

test("pattern alert request stores only a stable canonical id", () => {
  const read = readCondition("candlestick_pattern", { patternId: "engulfing_bullish" });
  assert.ok(!("error" in read));
  assert.equal(validateCondition(read.condition), null);
  const columns = toColumns(read.condition);
  assert.equal(columns.conditionKind, "candlestick_pattern");
  assert.equal(columns.patternId, "engulfing_bullish");
  assert.equal(columns.mode, null);
  const restored = conditionFromRow({ ...columns });
  assert.ok(restored);
  assert.equal(restored.kind, "candlestick_pattern");
  assert.ok("error" in readCondition("candlestick_pattern", { patternId: "Bullish Engulfing" }));
});

test("pattern planner fires only from canonical ids on a completed exact bar", () => {
  const condition = { kind: "candlestick_pattern" as const, patternId: "engulfing_bullish" };
  const spec: AlertSpec = {
    id: "p1", symbol: "BTCUSDT", timeframe: "1h", enabled: true, condition,
    frequency: "once_per_bar_close", lastSide: null, lastBarTime: null,
    fireState: { lastFiredAt: null, lastFiredBarTime: null, completed: false, cooldownMin: 0 },
  };
  const sample: FeedSample = {
    symbol: "BTCUSDT", timeframe: "1h", barTime: T0, isClosedBar: true,
    high: bar.high, low: bar.low, close: bar.close, series: () => undefined,
    patterns: { ids: ["engulfing_bullish"], nameFor: () => "Engulfing - Bullish" },
  };
  const plan = planAlert(spec, sample, T0 + 3_600_000);
  assert.equal(plan.act, true);
  if (plan.act) {
    assert.equal(plan.fire, true);
    assert.equal(plan.label, "Engulfing - Bullish");
  }
  assert.deepEqual(planAlert(spec, { ...sample, isClosedBar: false }, T0 + 1_000),
    { act: false, reason: "wrong_sample_kind" });
});

test("runner asks canonical service once and records the exact server bar", async () => {
  const alert = {
    id: "p1", symbol: "BTCUSDT", timeframe: "1h", conditionKind: "candlestick_pattern",
    patternId: "engulfing_bullish", enabled: true, frequency: "once_per_bar_close",
    cooldownMin: 0, note: null, lastSide: null, lastFiredAt: null,
    lastFiredBarTime: null, lastBarTime: null, completedAt: null,
    nearMinPct: 0.2, nearMaxPct: 0.5,
  } as MaAlertRow;
  const evaluated: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  let analyses = 0;
  const runner = new MaAlertRunner({ info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return this; }, silent() {} } as never, {
    listAlerts: (async () => [alert]) as never,
    recordEvaluation: (async (value: Record<string, unknown>) => { evaluated.push(value); }) as never,
    createEvent: (async (value: Record<string, unknown>) => { events.push(value); return value; }) as never,
    sendPush: async () => ({ sent: 1, failed: 0, pruned: 0 }),
    now: () => T0 + 3_600_000,
    analyzePatterns: async ({ asOf }) => {
      analyses += 1;
      assert.equal(asOf, bar.closeTime);
      return { patterns: [{ id: "engulfing_bullish", name: "Engulfing - Bullish", open_time: T0 }] };
    },
  });
  await runner.replay({ symbol: "BTCUSDT", interval: "1h", bars: [bar], sampleBar: bar, isClosedBar: true });
  runner.stop();
  assert.equal(analyses, 1);
  assert.equal(evaluated.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.barTime, T0);
  assert.equal(events[0]!.intrabar, false);
  assert.match(String(events[0]!.body), /not a return forecast/);
});

test("runner does not consume a bar when canonical service is unavailable", async () => {
  const alert = {
    id: "p1", symbol: "BTCUSDT", timeframe: "1h", conditionKind: "candlestick_pattern",
    patternId: "doji", enabled: true, frequency: "once_per_bar_close", cooldownMin: 0,
    nearMinPct: 0.2, nearMaxPct: 0.5, lastSide: null, lastFiredAt: null,
    lastFiredBarTime: null, lastBarTime: null, completedAt: null,
  } as MaAlertRow;
  let writes = 0;
  const runner = new MaAlertRunner({ info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return this; }, silent() {} } as never, {
    listAlerts: (async () => [alert]) as never,
    recordEvaluation: (async () => { writes += 1; }) as never,
    createEvent: (async () => { writes += 1; }) as never,
    sendPush: async () => ({ sent: 0, failed: 0, pruned: 0 }), now: () => T0,
    analyzePatterns: async () => { throw new Error("offline"); },
  });
  await runner.replay({ symbol: "BTCUSDT", interval: "1h", bars: [bar], sampleBar: bar, isClosedBar: true });
  runner.stop();
  assert.equal(writes, 0);
});

test("migration 032 is additive and enforces canonical id plus bar-close shape", () => {
  const sql = fs.readFileSync(path.join(
    __dirname, "..", "src", "db", "migrations", "032_candlestick_pattern_alerts.sql",
  ), "utf8");
  const statements = sql.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ");
  assert.match(statements, /ADD COLUMN IF NOT EXISTS pattern_id text/);
  assert.match(statements, /condition_kind = 'candlestick_pattern' AND pattern_id IS NOT NULL/);
  assert.match(statements, /pattern_id ~ '\^\[a-z0-9\]\+\(_\[a-z0-9\]\+\)\*\$'/);
  assert.match(statements, /frequency = 'once_per_bar_close'/);
  assert.match(statements, /ADD CONSTRAINT ma_alerts_shape_ck CHECK \(.*\) NOT VALID;/);
  assert.match(statements, /VALIDATE CONSTRAINT ma_alerts_shape_ck/);
  assert.match(statements, /EXCEPTION WHEN check_violation THEN/);
  assert.match(statements, /CREATE UNIQUE INDEX IF NOT EXISTS ma_alerts_candlestick_pattern_uniq/);
  for (const forbidden of [/DROP TABLE/i, /DROP COLUMN/i, /DELETE FROM/i, /TRUNCATE/i,
                           /UPDATE ma_alerts SET/i]) {
    assert.doesNotMatch(statements, forbidden);
  }
});
