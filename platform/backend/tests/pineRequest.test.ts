import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { pineRoutes } from "../src/api/routes/pine";
import { pool } from "../src/db/pool";

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
