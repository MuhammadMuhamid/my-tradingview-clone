import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerHealthRoutes } from "../src/api/routes/health";

const migrations = ["001_init.sql", "002_feature.sql"];

async function server(query: (sql: string) => Promise<{ rows: Array<{ filename?: string }> }>) {
  const app = Fastify({ logger: false });
  await registerHealthRoutes(app, { query, requiredMigrations: () => migrations });
  return app;
}

test("readiness is 200 when the database is reachable and schema is current", async (t) => {
  const app = await server(async (sql) => ({
    rows: sql.includes("schema_migrations")
      ? migrations.map((filename) => ({ filename }))
      : [],
  }));
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().checks, { database: "ok", schema: "current" });
  assert.equal(response.json().ready, true);
});

test("readiness is 503 when the database is unavailable", async (t) => {
  const app = await server(async () => { throw new Error("database connection failed"); });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json().checks, { database: "unavailable", schema: "unknown" });
});

test("readiness is 503 and names missing migrations when schema is behind", async (t) => {
  const app = await server(async (sql) => ({
    rows: sql.includes("schema_migrations") ? [{ filename: migrations[0] }] : [],
  }));
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json().checks, { database: "ok", schema: "behind" });
  assert.deepEqual(response.json().schema.missing, [migrations[1]]);
});

test("liveness stays 200 and never queries dependencies", async (t) => {
  let calls = 0;
  const app = await server(async () => {
    calls += 1;
    throw new Error("database connection failed");
  });
  t.after(() => app.close());

  for (const url of ["/health", "/healthz"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.json().ok, true, url);
  }
  assert.equal(calls, 0);
});
