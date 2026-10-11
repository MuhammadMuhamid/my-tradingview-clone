import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { pool } from "../src/db/pool";
import { shariahRoutes } from "../src/api/routes/shariah";

for (const failStaleWrite of [false, true]) {
  test(`universe reactivation ${failStaleWrite ? "rolls back" : "commits"} mapping and STALE atomically`, async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [{ symbol: "AAAUSDT" }] }));
    const statements: string[] = [];
    let released = false;
    const client = {
      async query<T extends QueryResultRow>(sql: string): Promise<QueryResult<T>> {
        statements.push(sql.trim());
        if (sql.startsWith("SELECT asset_id, binance_available")) {
          return { rows: [{ asset_id: "1", binance_available: false }] as unknown as T[] } as QueryResult<T>;
        }
        if (sql.startsWith("UPDATE shariah_records") && failStaleWrite) throw new Error("staleness write failed");
        return { rows: [] } as unknown as QueryResult<T>;
      },
      release() { released = true; },
    } as unknown as PoolClient;
    const app = Fastify({ logger: false });
    t.after(() => app.close());
    await app.register(shariahRoutes, {
      connect: async () => client,
      exchangeSymbols: async () => [{ symbol: "AAAUSDT", baseAsset: "AAA", quoteAsset: "USDT", status: "TRADING" }],
    });
    const response = await app.inject({ method: "POST", url: "/api/shariah/universe/sync" });
    assert.equal(response.statusCode, failStaleWrite ? 500 : 200, response.body);
    assert.equal(statements[0], "BEGIN", "reactivation must not make an eligible ticker visible before its STALE decision");
    const lock = statements.findIndex((sql) => /ORDER BY m.asset_id FOR UPDATE/.test(sql));
    const firstWrite = statements.findIndex((sql) => /^UPDATE/.test(sql));
    assert.ok(lock > 0 && lock < firstWrite, "sync and import must lock mapping identities in the same order before writes");
    assert.equal(statements.at(-1), failStaleWrite ? "ROLLBACK" : "COMMIT");
    assert.equal(statements.includes(failStaleWrite ? "COMMIT" : "ROLLBACK"), false);
    assert.equal(released, true);
  });
}
