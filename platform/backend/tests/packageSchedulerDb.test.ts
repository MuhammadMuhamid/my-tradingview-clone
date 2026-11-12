/**
 * The package scheduler against PostgreSQL: it keeps active packages two terms
 * ahead, starts and ends cohorts on time, waits for open trades, and is safe
 * to run twice or from two places at once.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_package_scheduler`;
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

const quiet = { info: () => {}, warn: () => {} };

test("package scheduler", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const repo = await import("../src/repositories/packages");
  const { runPackageSchedulerOnce } = await import("../src/packages/scheduler");
  const { ADMIN_USER_ID, createUser } = await import("../src/repositories/users");
  after(() => closePool());
  await migrate();

  const admin = ADMIN_USER_ID;
  const strategyId = (await query<{ id: number }>("SELECT id FROM strategies ORDER BY id LIMIT 1")).rows[0]!.id;
  const btc = (await query<{ id: string }>(
    "INSERT INTO deployments (strategy_id, symbol, timeframe, params) VALUES ($1, 'BTCUSDT', '15m', '{}') RETURNING id",
    [strategyId])).rows[0]!.id;

  const cohortsOf = async (packageId: string) => (await query<{ id: string; starts_at: Date; status: string }>(
    "SELECT id, starts_at, status FROM cohorts WHERE package_id = $1 ORDER BY starts_at", [packageId])).rows;

  const now = new Date("2026-11-13T10:00:00Z");
  const active = await repo.createPackage({ name: "Half", term: "half_month", minAmount: "0", tradePercent: "25", actor: admin });
  await repo.attachDeployment(active, btc, admin);
  await query("UPDATE packages SET status = 'active' WHERE id = $1", [active]);
  const paused = await repo.createPackage({ name: "Paused", term: "month", minAmount: "0", tradePercent: "25", actor: admin });

  await t.test("an active package is kept two terms ahead; a paused one gets none", async () => {
    const tick = await runPackageSchedulerOnce(quiet, now);
    assert.equal(tick.scheduled, 2);
    const cohorts = await cohortsOf(active);
    assert.deepEqual(cohorts.map((c) => c.starts_at.toISOString()),
      ["2026-11-15T19:00:00.000Z", "2026-11-30T19:00:00.000Z"], "16 Nov and 1 Dec, Karachi midnight");
    assert.equal((await cohortsOf(paused)).length, 0);
  });

  await t.test("running it again changes nothing", async () => {
    const tick = await runPackageSchedulerOnce(quiet, now);
    assert.equal(tick.scheduled, 0);
    assert.equal(tick.advanced.length, 0);
    assert.equal((await cohortsOf(active)).length, 2);
  });

  await t.test("two schedulers at once never create the same term twice", async () => {
    const other = await repo.createPackage({ name: "Race", term: "month", minAmount: "0", tradePercent: "25", actor: admin });
    await query("UPDATE packages SET status = 'active' WHERE id = $1", [other]);
    const results = await Promise.all([runPackageSchedulerOnce(quiet, now), runPackageSchedulerOnce(quiet, now)]);
    assert.equal(results.reduce((n, r) => n + r.scheduled, 0), 2);
    assert.equal((await cohortsOf(other)).length, 2);
  });

  let first = "";
  let tradeId = "";
  await t.test("at the start a cohort with money starts, and the next term is added", async () => {
    [first] = (await cohortsOf(active)).map((c) => c.id) as [string];
    const alice = (await createUser({ email: "alice@example.com", displayName: "Alice" })).id;
    const m = await repo.requestMembership(alice, first, now);
    await repo.decideMembership(m, true, admin);
    await repo.recordDeposit({ membershipId: m, amount: "500", reference: "tx", actor: admin, idempotencyKey: "dep-sched-1", now });
    const atStart = new Date("2026-11-15T19:00:00Z");
    const tick = await runPackageSchedulerOnce(quiet, atStart);
    assert.deepEqual(tick.advanced, [{ cohortId: first, status: "running" }]);
    assert.equal(tick.scheduled, 1, "two terms are still ahead");
    assert.deepEqual((await cohortsOf(active)).map((c) => c.status), ["running", "open", "open"]);
    tradeId = (await query<{ id: string }>(
      "INSERT INTO cohort_trades (cohort_id, deployment_id, symbol, quote_spent) VALUES ($1, $2, 'BTCUSDT', 100) RETURNING id",
      [first, btc])).rows[0]!.id;
  });

  await t.test("a cohort nobody funded is cancelled at its start, while the one before keeps its trade", async () => {
    const second = (await cohortsOf(active))[1]!.id;
    const atStart = new Date("2026-11-30T19:00:00Z");
    const tick = await runPackageSchedulerOnce(quiet, atStart);
    assert.ok(tick.advanced.some((a) => a.cohortId === second && a.status === "cancelled"));
    assert.ok(tick.advanced.some((a) => a.cohortId === first && a.status === "settling"),
      "the first cohort ended at the same moment and holds a trade");
  });

  await t.test("at the end a cohort holding a trade settles only after the trade closes", async () => {
    const atEnd = new Date("2026-11-30T19:00:00Z");
    await runPackageSchedulerOnce(quiet, atEnd);
    assert.equal((await query<{ status: string }>("SELECT status FROM cohorts WHERE id = $1", [first])).rows[0]!.status, "settling");
    await runPackageSchedulerOnce(quiet, new Date("2026-12-01T10:00:00Z"));
    assert.equal((await query<{ status: string }>("SELECT status FROM cohorts WHERE id = $1", [first])).rows[0]!.status, "settling");
    await repo.recordTradeClose({ cohortTradeId: tradeId, pnl: "12.5", sourceType: "test", sourceId: "t1", idempotencyKey: "pnl-sched-1" });
    const tick = await runPackageSchedulerOnce(quiet, new Date("2026-12-01T10:01:00Z"));
    assert.ok(tick.advanced.some((a) => a.cohortId === first && a.status === "settled"));
    const row = (await query<{ closing_value: string }>("SELECT closing_value::text AS closing_value FROM cohorts WHERE id = $1", [first])).rows[0]!;
    assert.equal(row.closing_value, "512.50000000");
  });

  await t.test("pausing a package stops new terms but lets its cohorts finish", async () => {
    await query("UPDATE packages SET status = 'paused' WHERE id = $1", [active]);
    const before = (await cohortsOf(active)).length;
    await runPackageSchedulerOnce(quiet, new Date("2027-03-01T00:00:00Z"));
    const after = await cohortsOf(active);
    assert.equal(after.length, before, "no new terms for a paused package");
    assert.ok(after.every((c) => c.status !== "open" || c.starts_at > new Date("2027-03-01T00:00:00Z")),
      "cohorts whose start passed were still started or cancelled");
  });
});
