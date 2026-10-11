/**
 * A stored run is read for what it means today.
 *
 * Measured by the product-readiness reviewer against the running API:
 *
 *  - C-02: a run recorded before `lotDustExit` and `affordableEntries` was
 *    labelled "Reproducible — engine, data source and cost model recorded"
 *    while its headline win rate was inflated by dust legs the current engine
 *    closes;
 *  - C-07: runs queued before input validation (initial capital −5,
 *    commission −1 %, slippage −50 ticks, order size −100) were listed with
 *    Net −320 %, PF ∞, Win 100 %, and offered Re-run and Stress, which the
 *    server then refused;
 *  - HVBO-4: there was no way to delete a run at all.
 *
 * None of this needs the database: the judgements are pure, and the route
 * refusals tested here answer before any lookup.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  deleteRefusal, engineCurrency, fingerprintCorrections, storedSettingsProblem, withReadTruth,
} from "../src/api/backtestReadTruth";
import { CORRECTION_KEYS, allCorrections, correctionsFingerprint } from "../src/engine/corrections";
import { deleteBacktest } from "../src/repositories/backtests";
import { backtestRoutes } from "../src/api/routes/backtests";
import type { BacktestRow } from "../src/types/backtest";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const ACTIVE = correctionsFingerprint(allCorrections());
const PRE_DUST = `engine:v2-corrected:${CORRECTION_KEYS.filter((k) => k !== "lotDustExit" && k !== "affordableEntries").join("+")}`;

function row(over: Partial<BacktestRow> = {}): BacktestRow {
  return {
    id: "8f6d2c1e-3b4a-4f5e-9a7b-1c2d3e4f5a6b", strategyId: 1, configId: null,
    symbol: "SOLUSDT", timeframe: "1h",
    startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z",
    params: {}, initialCapital: 1000, commissionPct: 0.1, slippageTicks: 2, holdoutFraction: null,
    status: "done", error: null, metrics: null, equityCurve: null,
    engineFingerprint: ACTIVE, resultProvenance: {}, segments: null, executionTruth: null,
    stressRunId: null, semanticsStatus: "reproducible",
    startedAt: null, finishedAt: null, createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

test("a fingerprint is read back into the corrections it names", () => {
  assert.deepEqual(fingerprintCorrections(ACTIVE), [...CORRECTION_KEYS]);
  assert.deepEqual(fingerprintCorrections("engine:legacy-baseline:quarantined"), []);
  // Not a fingerprint this engine writes, or naming a key it does not know: no guess.
  assert.equal(fingerprintCorrections("corrections:v7:abc123"), null);
  assert.equal(fingerprintCorrections("engine:v2-corrected:netAvgTrade+somethingElse"), null);
  assert.equal(fingerprintCorrections(null), null);
});

test("C-02 a run from an older correction set is not current, and says which corrections it lacks", () => {
  const old = engineCurrency(PRE_DUST, ACTIVE)!;
  assert.equal(old.current, false);
  assert.deepEqual(old.missing, ["lotDustExit", "affordableEntries"]);
  assert.deepEqual(old.extra, []);
  assert.equal(old.activeFingerprint, ACTIVE);

  assert.equal(engineCurrency(ACTIVE, ACTIVE)!.current, true);
  // The order of the keys is not the identity; the set is.
  const shuffled = `engine:v2-corrected:${[...CORRECTION_KEYS].reverse().join("+")}`;
  assert.equal(engineCurrency(shuffled, ACTIVE)!.current, true);

  // A server running a subset sees the run's extra corrections, too.
  const partial = engineCurrency(ACTIVE, "engine:v2-corrected:netAvgTrade")!;
  assert.equal(partial.current, false);
  assert.ok(partial.extra.includes("lotDustExit"));

  // The legacy baseline lacks everything.
  assert.equal(engineCurrency("engine:legacy-baseline:quarantined", ACTIVE)!.missing.length, CORRECTION_KEYS.length);
  // Nothing comparable recorded — an unfinished or pre-fingerprint run.
  assert.equal(engineCurrency(null, ACTIVE), null);
});

test("C-07 settings the request validators now refuse are named on the stored run", () => {
  assert.equal(storedSettingsProblem(row(), "ma_rr_v9", NOW), null, "a sane stored run is accepted");
  const cases: [Partial<BacktestRow>, RegExp][] = [
    [{ initialCapital: -5 }, /Initial capital must be a number greater than 0/],
    [{ commissionPct: -1 }, /Commission must be between 0 and 5/],
    [{ slippageTicks: -50 }, /Slippage must be between 0 and 1000/],
    [{ params: { qty_cash: -100 } }, /Order size \(qty_cash\)/],
    [{ params: { rrRatio: -2 } }, /rrRatio/],
    [{ holdoutFraction: 0.9 }, /validation window/],
    // The strategy's own default order size, against a capital it exceeds.
    [{ initialCapital: 100 }, /order size \(930 per entry\) is more than the initial capital \(100\)/],
  ];
  for (const [over, message] of cases) {
    assert.match(storedSettingsProblem(row(over), "ma_rr_v9", NOW) ?? "", message, JSON.stringify(over));
  }
  // An unregistered strategy has no default to judge a size by.
  assert.equal(storedSettingsProblem(row({ initialCapital: 100 }), null, NOW), null);
});

test("the read adds both judgements without touching the stored record", () => {
  const stored = row({ engineFingerprint: PRE_DUST, initialCapital: -5 });
  const read = withReadTruth(stored, "ma_rr_v9", { nowMs: NOW, activeFingerprint: ACTIVE });
  assert.equal(read.engineCurrency?.current, false);
  assert.match(read.refusedSettings ?? "", /Initial capital/);
  assert.equal(read.initialCapital, -5, "the stored figure is reported as stored");
  assert.equal(read.semanticsStatus, "reproducible", "and the stored label is not rewritten");
  assert.equal("engineCurrency" in stored, false, "the input row is not mutated");

  const fresh = withReadTruth(row(), "ma_rr_v9", { nowMs: NOW, activeFingerprint: ACTIVE });
  assert.equal(fresh.engineCurrency?.current, true);
  assert.equal(fresh.refusedSettings, null);
  const queued = withReadTruth(row({ status: "queued", engineFingerprint: null }), "ma_rr_v9", { nowMs: NOW });
  assert.equal(queued.engineCurrency, null, "an unfinished run has no engine to compare yet");
});

test("HVBO-4 a running run and a stress window are refused deletion, with the sentence", () => {
  assert.deepEqual(deleteRefusal(null), { code: 404, error: "backtest not found" });
  const running = deleteRefusal(row({ status: "running" }))!;
  assert.equal(running.code, 409);
  assert.match(running.error, /still running/);
  const window = deleteRefusal(row({ stressRunId: "11111111-1111-4111-8111-111111111111" }))!;
  assert.equal(window.code, 409);
  assert.match(window.error, /stress analysis/);
  for (const status of ["done", "error", "queued"] as const) {
    assert.equal(deleteRefusal(row({ status })), null, status);
  }
});

test("HVBO-4 the delete is one guarded statement, so it cannot race the worker", async () => {
  const seen: { text: string; params?: unknown[] }[] = [];
  const fake = (async (text: string, params?: unknown[]) => {
    seen.push({ text, params });
    return { rows: [{ id: "abc" }] };
  }) as never;
  assert.equal(await deleteBacktest("abc", fake), "abc");
  assert.equal(seen.length, 1, "no read-then-delete pair");
  assert.match(seen[0]!.text, /DELETE FROM backtests/);
  assert.match(seen[0]!.text, /status <> 'running'/);
  assert.match(seen[0]!.text, /stress_run_id IS NULL/);
  assert.deepEqual(seen[0]!.params, ["abc"]);

  const none = (async () => ({ rows: [] })) as never;
  assert.equal(await deleteBacktest("abc", none), null);
});

test("HVBO-4 deleting a malformed id is not found, before any lookup", async () => {
  const app = Fastify();
  await app.register(backtestRoutes);
  try {
    const res = await app.inject({ method: "DELETE", url: "/api/backtests/not-a-uuid" });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, "backtest not found");
  } finally { await app.close(); }
});
