/**
 * A backtest request that cannot mean anything is refused before it is queued.
 *
 * Measured against the running API before this file existed: a POST with an
 * initial capital of -5, a commission of -1 % and -50 ticks of slippage was
 * queued, simulated and stored as `done`; a negative `rrRatio` or `qty_cash`
 * came back as "0 trades"; a window ending tomorrow failed later, in the
 * backfill, as `invalid SOLUSDT 1h backfill: empty_series`; and
 * `GET /api/backtests/<not a uuid>` was a 500.
 *
 * Every refusal tested here happens before the route touches the database, so
 * none of these needs one — the route tests run the real handler through
 * `inject` and would fail loudly if a lookup ran first (there is no database
 * to answer it).
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  BACKTEST_LIMITS, isBacktestId, paramsProblem, runSettingsProblem, sizingProblem,
} from "../src/api/backtestRequest";
import { backtestRoutes } from "../src/api/routes/backtests";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const WINDOW = { startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-10T00:00:00.000Z" };

test("a sane request has no problem", () => {
  assert.equal(runSettingsProblem({
    ...WINDOW, initialCapital: 1000, commissionPct: 0.1, slippageTicks: 2, holdoutFraction: 0.2,
  }, NOW), null);
  // Absent fields take the route's defaults and are not judged.
  assert.equal(runSettingsProblem(WINDOW, NOW), null);
});

test("capital, commission and slippage that describe no market are refused", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ initialCapital: -5 }, /Initial capital must be a number greater than 0/],
    [{ initialCapital: 0 }, /greater than 0/],
    [{ initialCapital: Number.NaN }, /greater than 0/],
    [{ initialCapital: "1000" }, /greater than 0/],
    [{ initialCapital: 1e13 }, /at most/],
    [{ commissionPct: -1 }, /Commission must be between 0 and 5/],
    [{ commissionPct: 50 }, /Commission/],
    [{ slippageTicks: -50 }, /Slippage must be between 0 and 1000/],
    [{ slippageTicks: 1e6 }, /Slippage/],
  ];
  for (const [over, message] of cases) {
    assert.match(runSettingsProblem({ ...WINDOW, ...over }, NOW) ?? "", message, JSON.stringify(over));
  }
  // Zero friction is a legitimate (if optimistic) cost model, and a
  // fractional tick is what the chart's own settings field can send.
  assert.equal(runSettingsProblem({ ...WINDOW, commissionPct: 0, slippageTicks: 0 }, NOW), null);
  assert.equal(runSettingsProblem({ ...WINDOW, slippageTicks: 1.5 }, NOW), null);
});

test("the validation fraction is bounded where the split still means something", () => {
  for (const ok of [BACKTEST_LIMITS.minHoldoutFraction, 0.2, BACKTEST_LIMITS.maxHoldoutFraction]) {
    assert.equal(runSettingsProblem({ ...WINDOW, holdoutFraction: ok }, NOW), null, String(ok));
  }
  for (const bad of [0, 0.01, 0.6, 1, -0.2, Number.NaN]) {
    assert.match(runSettingsProblem({ ...WINDOW, holdoutFraction: bad }, NOW) ?? "",
      /validation window must be between 5 % and 50 %/, String(bad));
  }
});

test("a window in the future is refused; a run to the end of today is not", () => {
  // Tomorrow has no candles. This used to fail in the backfill as empty_series.
  assert.match(runSettingsProblem({ ...WINDOW, endTime: "2026-10-11T00:00:00.000Z" }, NOW) ?? "",
    /end date is in the future/);
  assert.match(runSettingsProblem({
    startTime: "2026-10-10T13:00:00.000Z", endTime: "2026-10-10T20:00:00.000Z",
  }, NOW) ?? "", /in the future/, "a window that begins after now has no bars at all");
  // The chart's Strategy Tester sends `T23:59:59Z` for "today", which is
  // hours ahead of the clock and must keep working.
  assert.equal(runSettingsProblem({ ...WINDOW, endTime: "2026-10-10T23:59:59.000Z" }, NOW), null);
  // The date order rule is unchanged.
  assert.match(runSettingsProblem({ startTime: WINDOW.endTime, endTime: WINDOW.startTime }, NOW) ?? "",
    /startTime < endTime/);
});

test("strategy inputs that the engine cannot honour are refused", () => {
  assert.equal(paramsProblem(undefined), null);
  assert.equal(paramsProblem({ rrRatio: 2, qty_cash: 930, qty_pct_equity: 0, ma1_tf: "1", long_en: true }), null);
  assert.match(paramsProblem({ rrRatio: -2 }) ?? "", /Reward : risk ratio \(rrRatio\) must be greater than 0/);
  assert.match(paramsProblem({ rrRatio: 0 }) ?? "", /rrRatio/);
  assert.match(paramsProblem({ qty_cash: -100 }) ?? "", /qty_cash/);
  assert.match(paramsProblem({ qty_pct_equity: 150 }) ?? "", /qty_pct_equity/);
  assert.match(paramsProblem({ anything: Number.POSITIVE_INFINITY }) ?? "", /anything must be a finite number/);
  assert.match(paramsProblem({ nested: { a: 1 } }) ?? "", /nested must be a number, a string or a boolean/);
  assert.match(paramsProblem([1, 2]) ?? "", /params must be an object/);
  // Equity sizing does not read the cash size, so a legacy zero there is moot.
  assert.equal(paramsProblem({ qty_cash: 0, qty_pct_equity: 100 }), null);
});

test("C-01 an order size larger than the account is refused, the strategy's default included", () => {
  // The research form sends no qty_cash; ma_rr_v9's default 930 is what runs.
  const maDefaults = { qty_cash: 930, qty_pct_equity: 0 };
  assert.equal(sizingProblem({}, 1000, maDefaults), null);
  assert.equal(sizingProblem({}, 930, maDefaults), null, "spending exactly the account is affordable");
  assert.equal(sizingProblem({}, 100, maDefaults),
    "The order size (930 per entry) is more than the initial capital (100). "
    + "A spot account cannot spend more than it holds — lower the order size or raise the initial capital.");
  // A stated size wins over the default, either way.
  assert.equal(sizingProblem({ qty_cash: 90 }, 100, maDefaults), null);
  assert.match(sizingProblem({ qty_cash: 5000 }, 1000, maDefaults) ?? "", /5,000 per entry/);
  // Percent of equity is a share of the account by construction.
  assert.equal(sizingProblem({ qty_pct_equity: 50 }, 100, maDefaults), null);
  assert.equal(sizingProblem({}, 100, { qty_cash: 930, qty_pct_equity: 25 }), null);
  // An unregistered strategy with no stated size has nothing to judge.
  assert.equal(sizingProblem({}, 100, null), null);
});

test("a backtest id is a UUID", () => {
  assert.equal(isBacktestId("8f6d2c1e-3b4a-4f5e-9a7b-1c2d3e4f5a6b"), true);
  for (const bad of ["not-a-uuid", "123", "", "8f6d2c1e-3b4a-4f5e-9a7b-1c2d3e4f5a6b' OR 1=1"]) {
    assert.equal(isBacktestId(bad), false, bad);
  }
});

// ── Through the real route ─────────────────────────────────────────────────

test("the route answers a bad request with 400 and the sentence, before any lookup", async () => {
  const app = Fastify();
  await app.register(backtestRoutes);
  try {
    const post = (payload: Record<string, unknown>) => app.inject({
      method: "POST", url: "/api/backtests",
      payload: { strategyKey: "ma_rr_v9", symbol: "SOLUSDT", timeframe: "1h", ...WINDOW, ...payload },
    });
    for (const [payload, message] of [
      [{ initialCapital: -5 }, /Initial capital/],
      [{ commissionPct: -1 }, /Commission/],
      [{ slippageTicks: -50 }, /Slippage/],
      [{ params: { rrRatio: -1 } }, /rrRatio/],
      [{ endTime: "2999-01-01T00:00:00.000Z" }, /in the future/],
      [{ holdoutFraction: 0.9 }, /validation window/],
      [{ initialCapital: 100 }, /order size \(930 per entry\) is more than the initial capital \(100\)/],
      [{ initialCapital: 500, params: { qty_cash: 600 } }, /order size \(600 per entry\)/],
    ] as const) {
      const res = await post(payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.match(res.json().error, message);
    }
  } finally { await app.close(); }
});

test("a malformed backtest id is not found, not a server error", async () => {
  const app = Fastify();
  await app.register(backtestRoutes);
  try {
    for (const url of ["/api/backtests/not-a-uuid", "/api/backtests/123/trades",
      "/api/backtests/abc/parity?deploymentId=x"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 404, url);
      assert.equal(res.json().error, "backtest not found");
    }
  } finally { await app.close(); }
});
