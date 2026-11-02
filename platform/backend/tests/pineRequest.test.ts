import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { pineRoutes } from "../src/api/routes/pine";
import { pool } from "../src/db/pool";
import { config } from "../src/config";
import { ADMIN_USER_ID } from "../src/repositories/users";
import { USER_MAX_HISTORY_BARS } from "../src/api/routes/data";
import {
  admitHistoryRequest, SERVER_MAX_HISTORY_IN_FLIGHT, USER_HEAVY_HISTORY_BARS,
} from "../src/api/historyAdmission";
import { symbolRoutes } from "../src/api/routes/symbols";
import type { FastifyReply, FastifyRequest } from "fastify";

test("Pine refuses impossible financial settings before reading data or starting a worker", async (t) => {
  const unexpected: string[] = [];
  t.mock.method(pool, "query", async (sql: string) => {
    unexpected.push(sql);
    throw new Error("Invalid money settings reached the database");
  });
  const app = Fastify({ logger: false });
  await pineRoutes(app);
  try {
    for (const [settings, message] of [
      [{ initialCapital: 0 }, /Initial capital/],
      [{ commissionPct: -1 }, /Commission/],
      [{ slippageTicks: -2 }, /Slippage/],
      [{ qtyCash: -1 }, /qty_cash/],
      [{ qtyPctEquity: 200 }, /qty_pct_equity/],
    ] as const) {
      const response = await app.inject({ method: "POST", url: "/api/pine/run", payload: {
        source: '//@version=5\nstrategy("invalid financial settings")\nif close > 0\n    strategy.entry("L", strategy.long)',
        symbol: "SOLUSDT", timeframe: "1h", startTime: "2025-01-01", endTime: "2025-01-02",
        ...settings,
      } });
      assert.equal(response.statusCode, 400, `${JSON.stringify(settings)}: ${response.body}`);
      assert.match(response.json().error, message);
    }
    assert.deepEqual(unexpected, [], "invalid money settings must not read data or start work");
  } finally {
    await app.close();
    t.mock.restoreAll();
  }
});

test("an ordinary account cannot run a script over more source bars than it may backfill", async (t) => {
  const unexpected: string[] = [];
  t.mock.method(pool, "query", async (sql: string) => {
    unexpected.push(sql);
    throw new Error("the oversized run reached the database");
  });
  const previous = config.authEnabled;
  config.authEnabled = true;
  t.after(() => { config.authEnabled = previous; t.mock.restoreAll(); });
  const app = Fastify({ logger: false });
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = req.headers["x-as"] === "admin"
      ? { id: ADMIN_USER_ID, role: "admin", sessionVersion: 1 }
      : { id: "22222222-2222-4222-8222-222222222222", role: "user", sessionVersion: 1 };
  });
  await pineRoutes(app);
  t.after(() => app.close());
  // 100,000 chart bars of 30s are 3,000,000 one-second klines — the whole
  // span would have been fetched into memory for one run.
  const payload = {
    source: '//@version=5\nindicator("wide")\nplot(close)',
    symbol: "SOLUSDT", timeframe: "30s",
    startTime: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    endTime: new Date(Date.UTC(2026, 0, 1) + 100_000 * 30_000).toISOString(),
  };
  const refused = await app.inject({ method: "POST", url: "/api/pine/run", headers: { "x-as": "user" }, payload });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.match(refused.json().error, new RegExp(`at most ${USER_MAX_HISTORY_BARS.toLocaleString("en-US")} 1s bars`));
  assert.deepEqual(unexpected, [], "a refused run reads nothing");

  // A native resolution at the same chart depth is within the ceiling and proceeds
  // to the data read (which the mock refuses, so the route reports the feed, not the limit).
  const native = await app.inject({ method: "POST", url: "/api/pine/run", headers: { "x-as": "user" }, payload: {
    ...payload, timeframe: "1m", endTime: new Date(Date.UTC(2026, 0, 1) + 100_000 * 60_000).toISOString(),
  } });
  assert.notEqual(native.statusCode, 400, native.body);
  // The admin is not bounded by this check.
  const admin = await app.inject({ method: "POST", url: "/api/pine/run", headers: { "x-as": "admin" }, payload });
  assert.notEqual(admin.statusCode, 400, admin.body);
});

test("a deep Pine run and a deep candle read wait for the same slots as a backfill", async (t) => {
  const previous = config.authEnabled;
  config.authEnabled = true;
  t.after(() => { config.authEnabled = previous; });
  t.mock.method(pool, "query", async () => { throw new Error("a refused request reads nothing"); });
  const app = Fastify({ logger: false });
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = { id: "00000000-0000-4000-8000-0000000000aa", role: "user", sessionVersion: 1 };
  });
  await pineRoutes(app);
  await app.register(symbolRoutes());
  t.after(() => app.close());

  // Every slot on the server held by other accounts.
  const held = Array.from({ length: SERVER_MAX_HISTORY_IN_FLIGHT }, (_, i) => admitHistoryRequest(
    { user: { id: `holder-${i}`, role: "user", sessionVersion: 1 } } as unknown as FastifyRequest,
    {} as FastifyReply,
  ));
  t.after(() => held.forEach((slot) => { if (slot.ok) slot.release(); }));

  const start = Date.UTC(2026, 0, 1);
  const pine = await app.inject({ method: "POST", url: "/api/pine/run", payload: {
    source: '//@version=5\nindicator("deep")\nplot(close)', symbol: "SOLUSDT", timeframe: "1m",
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + (USER_HEAVY_HISTORY_BARS + 1) * 60_000).toISOString(),
  } });
  assert.equal(pine.statusCode, 429, pine.body);

  const candles = await app.inject({
    method: "GET", url: `/api/symbols/SOLUSDT/candles?interval=1m&limit=${USER_HEAVY_HISTORY_BARS + 1}`,
  });
  assert.equal(candles.statusCode, 429, candles.body);
});
