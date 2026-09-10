import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  finishBacktest,
  toBacktestRow,
  type DbBacktest,
} from "../src/repositories/backtests";
import type { BacktestMetrics } from "../src/types/backtest";

const metrics: BacktestMetrics = {
  netProfit: 0,
  netProfitPct: 0,
  grossProfit: 0,
  grossLoss: 0,
  profitFactor: null,
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  winRatePct: 0,
  maxDrawdownPct: 0,
  avgTradePct: 0,
  avgBarsInTrade: 0,
  commissionPaid: 0,
};

test("018 adds nullable provenance without rewriting historical backtests", () => {
  const sql = fs.readFileSync(path.join(
    process.cwd(), "src", "db", "migrations", "018_backtest_provenance.sql"
  ), "utf8");
  assert.match(sql, /ALTER TABLE backtests\s+ADD COLUMN engine_fingerprint text;/);
  assert.doesNotMatch(sql, /NOT NULL|DEFAULT|DROP|DELETE|TRUNCATE/i);
});

function dbRow(engineFingerprint: string | null): DbBacktest {
  const now = new Date("2026-08-31T12:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000001",
    strategy_id: 1,
    config_id: null,
    symbol: "BTCUSDT",
    timeframe: "15m",
    start_time: now,
    end_time: now,
    params: {},
    initial_capital: 1000,
    commission_pct: 0.1,
    slippage_ticks: 2,
    status: "done",
    error: null,
    metrics,
    equity_curve: [],
    engine_fingerprint: engineFingerprint,
    result_provenance: null,
    started_at: now,
    finished_at: now,
    created_at: now,
  };
}

test("backtest rows round-trip current provenance and keep historical NULL readable", () => {
  assert.equal(toBacktestRow(dbRow("engine:netAvgTrade")).engineFingerprint, "engine:netAvgTrade");
  assert.equal(toBacktestRow(dbRow("engine:netAvgTrade")).semanticsStatus, "engine_only_legacy");
  assert.equal(toBacktestRow(dbRow(null)).engineFingerprint, null);
  assert.equal(toBacktestRow(dbRow(null)).semanticsStatus, "historical_unversioned");
});

test("finishing a backtest durably writes the engine fingerprint", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  await finishBacktest(
    "00000000-0000-4000-8000-000000000001",
    { metrics, equityCurve: [], trades: [], engine: "engine:baseline" },
    async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [] };
    }
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /engine_fingerprint = \$4/);
  assert.equal(calls[0]!.params[3], "engine:baseline");
  assert.equal(calls[0]!.params[4], null);
});

test("038 adds nullable complete provenance without relabeling saved results", () => {
  const sql = fs.readFileSync(path.join(process.cwd(), "src", "db", "migrations", "038_backtest_semantics_provenance.sql"), "utf8");
  assert.match(sql, /ADD COLUMN result_provenance jsonb/);
  assert.doesNotMatch(sql, /NOT NULL|DEFAULT|UPDATE backtests|DELETE|TRUNCATE/i);
});

test("X6 provenance round-trips as reproducible meaning", () => {
  const row = dbRow("engine:canonical-multiasset.v1:test");
  row.result_provenance = { schemaVersion: "canonical-backtest-result.v1", providerId: "fixture" };
  const mapped = toBacktestRow(row);
  assert.deepEqual(mapped.resultProvenance, row.result_provenance);
  assert.equal(mapped.semanticsStatus, "reproducible");
});

test("finishing an X6 result durably writes its complete provenance envelope", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const provenance = { schemaVersion: "canonical-backtest-result.v1", canonicalInstrument: "instrument:v1:FIXTURE" };
  await finishBacktest("00000000-0000-4000-8000-000000000002",
    { metrics, equityCurve: [], trades: [], engine: "engine:canonical-multiasset.v1:test", provenance },
    async (sql, params = []) => { calls.push({ sql, params }); return { rows: [] }; });
  assert.match(calls[0]!.sql, /result_provenance = \$5/);
  assert.deepEqual(JSON.parse(String(calls[0]!.params[4])), provenance);
});
