/**
 * The Journal on an installation with manual trading switched OFF: no Bot is
 * asked, and the page is told the feature is off rather than "the read failed".
 *
 * Runs in its OWN database like accountsDb.test.ts, because the shared test
 * database is dropped and recreated by another file in the same run.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_journal`;
const ownUrl = new URL(base.toString());
ownUrl.pathname = `/${target}`;
process.env.DATABASE_URL = ownUrl.toString();

async function prepare(): Promise<string | null> {
  const maintenance = new URL(base.toString());
  maintenance.pathname = "/postgres";
  const admin = new Pool({ connectionString: maintenance.toString(), connectionTimeoutMillis: 2_000, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${JSON.stringify(target)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${JSON.stringify(target)}`);
    return null;
  } catch (error) {
    return `no local PostgreSQL (${(error as Error).message})`;
  } finally {
    await admin.end();
  }
}

test("with manual trading off the Journal says so and never asks the Bot", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");
  const { migrate } = await import("../src/db/migrate");
  const { closePool } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { journalRoutes, MANUAL_DISABLED_LIMITATION } = await import("../src/api/routes/journal");
  const Fastify = (await import("fastify")).default;
  after(() => closePool());
  await migrate();
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = false;
  // No Bot listens on the configured URL in the test environment: had the
  // route asked anyway, the read would have failed and the OLD sentence
  // ("state read failed") would be in the limitations instead.
  t.after(() => { config.manualTradingEnabled = previous; });
  const app = Fastify({ logger: false });
  await journalRoutes(app);
  t.after(() => app.close());
  const res = await app.inject({ method: "GET", url: "/api/journal?from=2026-10-01&to=2026-10-31" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { limitations: string[]; rows: unknown[] };
  assert.ok(body.limitations.includes(MANUAL_DISABLED_LIMITATION));
  assert.ok(!body.limitations.some((l) => /state read failed/.test(l)), "the feature being off is not a failed read");
});
