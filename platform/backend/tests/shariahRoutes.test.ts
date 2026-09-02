/**
 * The Shariah HTTP boundary: authentication, and the fact that a refused
 * publication never reaches the database.
 *
 * The auth assertion is the one that matters for the Research-facing contract.
 * `api/server.ts` gates every path that is not in `PUBLIC_PATHS`, so these
 * routes are protected by NOT being listed there — a property that is invisible
 * in this file and would be silently lost if someone added one. It is asserted
 * here against the real server rather than by reading the route file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import type { PoolClient } from "pg";
import { config } from "../src/config";
import { buildServer } from "../src/api/server";
import { shariahRoutes } from "../src/api/routes/shariah";
import { SESSION_COOKIE, signSession } from "../src/security/session";
import type { LiveRunner } from "../src/engine/liveRunner";

const SHARIAH_PATHS: Array<{ method: "GET" | "POST" | "PUT"; url: string }> = [
  { method: "GET", url: "/api/shariah/universe" },
  { method: "GET", url: "/api/shariah/assets/1" },
  { method: "POST", url: "/api/shariah/assets/1/evidence" },
  { method: "POST", url: "/api/shariah/assets/1/publications" },
  { method: "POST", url: "/api/shariah/snapshots" },
  { method: "GET", url: "/api/shariah/snapshots" },
  { method: "GET", url: "/api/shariah/snapshots/latest" },
  { method: "GET", url: "/api/shariah/snapshots/1" },
  // The batch review workflow. The pack is the one route that produces a file
  // intended to leave the machine, so it being behind the session gate matters
  // as much as the publication routes do.
  { method: "GET", url: "/api/shariah/review-pack" },
  { method: "POST", url: "/api/shariah/review-results/preview" },
  { method: "POST", url: "/api/shariah/review-results/import" },
  { method: "GET", url: "/api/shariah/mode" },
  { method: "PUT", url: "/api/shariah/mode" },
  { method: "GET", url: "/api/shariah/status" },
];

test("every Shariah route — snapshot reads included — requires a session", async (t) => {
  const previous = { ...config };
  config.authEnabled = true;
  config.adminUsername = "owner";
  config.sessionSecret = "shariah-route-test-session-secret-000000000000";
  t.after(() => Object.assign(config, previous));

  const app = buildServer(() => ({} as LiveRunner));
  t.after(() => app.close());

  for (const route of SHARIAH_PATHS) {
    const denied = await app.inject({ ...route, payload: route.method === "GET" ? undefined : {} });
    assert.equal(denied.statusCode, 401, `${route.method} ${route.url} was reachable without a session`);
    assert.deepEqual(denied.json(), { error: "not authenticated" });
  }

  // The signed-in operator gets past the gate (the publish route then refuses
  // the empty body on its own terms, which is the next test's subject).
  const token = signSession("owner", config.sessionSecret);
  const allowed = await app.inject({
    method: "POST", url: "/api/shariah/assets/1/publications",
    headers: { cookie: `${SESSION_COOKIE}=${token}` }, payload: {},
  });
  assert.notEqual(allowed.statusCode, 401);
});

/** Records every statement, so "nothing reached the database" is checkable. */
class RecordingClient {
  readonly statements: string[] = [];
  async query<T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> {
    this.statements.push(sql);
    return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
  }
  release(): void { /* pooled client stand-in */ }
}

async function routeApp(client: RecordingClient) {
  const app = Fastify({ logger: false });
  await app.register(shariahRoutes, {
    connect: async () => client as unknown as PoolClient,
  });
  return app;
}

test("an incomplete publication is refused as a 400 without touching the database", async (t) => {
  const previous = { ...config };
  config.authEnabled = false;
  t.after(() => Object.assign(config, previous));

  const client = new RecordingClient();
  const app = await routeApp(client);
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST", url: "/api/shariah/assets/7/publications",
    payload: { classification: "ELIGIBLE" },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /requires a reason/);
  assert.deepEqual(client.statements, []);
});

test("a non-numeric asset or snapshot id is refused before any lookup", async (t) => {
  const previous = { ...config };
  config.authEnabled = false;
  t.after(() => Object.assign(config, previous));

  const client = new RecordingClient();
  const app = await routeApp(client);
  t.after(() => app.close());

  for (const url of [
    "/api/shariah/assets/BTC/publications",
    "/api/shariah/assets/1;DROP/publications",
  ]) {
    const response = await app.inject({ method: "POST", url, payload: { classification: "REVIEW" } });
    assert.equal(response.statusCode, 400, url);
    assert.match(response.json().error, /assetId must be numeric/);
  }

  const snapshot = await app.inject({ method: "GET", url: "/api/shariah/snapshots/abc" });
  assert.equal(snapshot.statusCode, 400);
  assert.deepEqual(client.statements, []);
});
