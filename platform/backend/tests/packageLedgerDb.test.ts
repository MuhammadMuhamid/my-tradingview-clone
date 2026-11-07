/**
 * The package ledger against a real PostgreSQL: append-only entries, deposit
 * deadlines, idempotency, the cohort lifecycle, carry and per-member values.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_packages`;
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

test("package ledger", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const repo = await import("../src/repositories/packages");
  const { ADMIN_USER_ID, createUser } = await import("../src/repositories/users");
  after(() => closePool());
  await migrate();

  const admin = ADMIN_USER_ID;
  const alice = (await createUser({ email: "alice@example.com", displayName: "Alice" })).id;
  const bob = (await createUser({ email: "bob@example.com", displayName: "Bob" })).id;
  await query("INSERT INTO strategies (id, name) VALUES (9001, 'pkg-test') ON CONFLICT DO NOTHING").catch(() => undefined);
  const strategyId = (await query<{ id: number }>("SELECT id FROM strategies ORDER BY id LIMIT 1")).rows[0]!.id;
  for (const s of ["BTCUSDT", "ETHUSDT"]) {
    await query("INSERT INTO symbols (symbol, base_asset, quote_asset) VALUES ($1, $2, 'USDT') ON CONFLICT DO NOTHING",
      [s, s.replace("USDT", "")]).catch(async () => {
      await query("INSERT INTO symbols (symbol) VALUES ($1) ON CONFLICT DO NOTHING", [s]);
    });
  }
  const deploy = async (symbol: string) => (await query<{ id: string }>(
    "INSERT INTO deployments (strategy_id, symbol, timeframe, params) VALUES ($1, $2, '15m', '{}') RETURNING id",
    [strategyId, symbol])).rows[0]!.id;
  const btc = await deploy("BTCUSDT");
  const eth = await deploy("ETHUSDT");

  const pkg = await repo.createPackage({ name: "Trend 1M", term: "month", minAmount: "100", tradePercent: "25", actor: admin });
  await repo.attachDeployment(pkg, btc, admin);
  await repo.attachDeployment(pkg, eth, admin);

  const before = new Date("2026-11-20T10:00:00Z");
  const first = await repo.scheduleNextCohort(pkg, before);
  const { starts_at: startsAt, ends_at: endsAt } = (await query<{ starts_at: Date; ends_at: Date }>(
    "SELECT starts_at, ends_at FROM cohorts WHERE id = $1", [first])).rows[0]!;
  assert.equal(startsAt.toISOString(), "2026-11-30T19:00:00.000Z");

  await t.test("a second cohort chains on, and overlapping windows are refused", async () => {
    const second = await repo.scheduleNextCohort(pkg, before);
    const row = (await query<{ starts_at: Date }>("SELECT starts_at FROM cohorts WHERE id = $1", [second])).rows[0]!;
    assert.equal(row.starts_at.toISOString(), endsAt.toISOString());
    await assert.rejects(query(
      "INSERT INTO cohorts (package_id, starts_at, ends_at, deposit_cutoff_at) VALUES ($1, $2, $3, $2)",
      [pkg, new Date(startsAt.getTime() + 86_400_000), new Date(endsAt.getTime() + 86_400_000)]));
  });

  let aliceM = "", bobM = "";
  await t.test("joining, approval, and money only after approval", async () => {
    aliceM = await repo.requestMembership(alice, first, before);
    bobM = await repo.requestMembership(bob, first, before);
    await assert.rejects(repo.recordDeposit({ membershipId: aliceM, amount: "600", reference: "tx-a", actor: admin,
      idempotencyKey: "dep-a", now: before }), /Approve the membership/);
    await repo.decideMembership(aliceM, true, admin);
    await repo.decideMembership(bobM, true, admin);
    await assert.rejects(repo.decideMembership(aliceM, false, admin), /already approved/);
  });

  await t.test("a deposit is recorded once however often it's submitted", async () => {
    const one = await repo.recordDeposit({ membershipId: aliceM, amount: "600", reference: "tx-a", actor: admin, idempotencyKey: "dep-a", now: before });
    const again = await repo.recordDeposit({ membershipId: aliceM, amount: "600", reference: "tx-a", actor: admin, idempotencyKey: "dep-a", now: before });
    assert.equal(one.created, true);
    assert.equal(again.created, false);
    assert.equal(again.entryId, one.entryId);
    await assert.rejects(repo.recordDeposit({ membershipId: aliceM, amount: "601", reference: "tx-a", actor: admin, idempotencyKey: "dep-a", now: before }),
      /already used for a different entry/);
    await repo.recordDeposit({ membershipId: bobM, amount: "400", reference: "tx-b", actor: admin, idempotencyKey: "dep-b", now: before });
  });

  await t.test("a deposit after the deadline needs a reason, and is audited", async () => {
    const late = new Date(startsAt.getTime());
    await assert.rejects(repo.recordDeposit({ membershipId: bobM, amount: "50", reference: "tx-late", actor: admin, idempotencyKey: "dep-late", now: late }),
      /deadline has passed/);
    const oneSecondBefore = new Date(startsAt.getTime() - 1000);
    await repo.recordDeposit({ membershipId: bobM, amount: "1", reference: "tx-edge", actor: admin, idempotencyKey: "dep-edge", now: oneSecondBefore });
    await repo.recordDeposit({ membershipId: bobM, amount: "49", reference: "tx-late", actor: admin, idempotencyKey: "dep-late",
      now: late, lateReason: "bank delay, confirmed on the 30th" });
    const audit = await query<{ detail: { late: boolean; lateReason: string } }>(
      "SELECT detail FROM admin_audit WHERE action = 'deposit.record' AND detail->>'reference' = 'tx-late'");
    assert.equal(audit.rows[0]!.detail.late, true);
    assert.match(audit.rows[0]!.detail.lateReason, /bank delay/);
  });

  await t.test("the ledger can't be edited or deleted", async () => {
    await assert.rejects(query("UPDATE ledger_entries SET amount = 1"), /append-only/);
    await assert.rejects(query("DELETE FROM ledger_entries"), /append-only/);
    await assert.rejects(query("TRUNCATE ledger_entries CASCADE"), /append-only/);
    await assert.rejects(query("DELETE FROM admin_audit"), /append-only/);
    await assert.rejects(query(
      "INSERT INTO ledger_entries (cohort_id, kind, amount, idempotency_key) VALUES ($1, 'ADJUSTMENT', 1, 'adj-no-note')", [first]));
    await assert.rejects(query(
      "INSERT INTO ledger_entries (cohort_id, kind, amount, idempotency_key) VALUES ($1, 'CAPITAL_IN', 5, 'in-no-member')", [first]));
  });

  await t.test("no trading before the start, and the start fixes opening capital", async () => {
    assert.deepEqual(await repo.planBuy(btc, "BTCUSDT"), { skip: "no cohort is running" });
    assert.equal(await repo.advanceCohort(first, startsAt), "running");
    const row = (await query<{ opening_capital: string }>("SELECT opening_capital::text AS opening_capital FROM cohorts WHERE id = $1", [first])).rows[0]!;
    assert.equal(row.opening_capital, "1050.00000000");
    await assert.rejects(repo.recordDeposit({ membershipId: aliceM, amount: "5", reference: "x", actor: admin, idempotencyKey: "dep-x",
      now: startsAt, lateReason: "too late" }), /already started/);
  });

  let btcTrade = "";
  await t.test("a BUY is sized from free equity and belongs to the running cohort", async () => {
    const plan = await repo.planBuy(btc, "BTCUSDT");
    assert.deepEqual(plan, { cohortId: first, quote: "262.50000000" });
    btcTrade = await repo.recordTradeOpen({ cohortId: first, deploymentId: btc, symbol: "BTCUSDT", orderIntentId: null, quoteSpent: "262.5" });
    const next = await repo.planBuy(eth, "ETHUSDT");
    assert.deepEqual(next, { cohortId: first, quote: "196.87000000" }, "25% of the 787.50 not already in a trade");
    assert.deepEqual(await repo.planBuy(btc, "BTCUSDT"), { skip: "already holds this symbol" });
  });

  await t.test("withdrawals wait for settlement", async () => {
    await assert.rejects(repo.recordWithdrawal({ membershipId: aliceM, amount: "1", reference: "w", actor: admin, idempotencyKey: "wd-early" }),
      /settled/);
  });

  await t.test("carry: the old cohort keeps its trade, the new one skips that symbol", async () => {
    assert.equal(await repo.advanceCohort(first, endsAt), "settling");
    const second = (await query<{ id: string }>("SELECT id FROM cohorts WHERE package_id = $1 AND starts_at = $2", [pkg, endsAt])).rows[0]!.id;
    const carol = (await createUser({ email: "carol@example.com", displayName: "Carol" })).id;
    const carolM = await repo.requestMembership(carol, second, before);
    await repo.decideMembership(carolM, true, admin);
    await repo.recordDeposit({ membershipId: carolM, amount: "1000", reference: "tx-c", actor: admin, idempotencyKey: "dep-c", now: before });
    assert.equal(await repo.advanceCohort(second, endsAt), "running");
    assert.deepEqual(await repo.planBuy(btc, "BTCUSDT"), { skip: "held by settling cohort" });
    assert.deepEqual(await repo.planBuy(eth, "ETHUSDT"), { cohortId: second, quote: "250.00000000" });
    assert.equal(await repo.planSell(btc, "BTCUSDT"), first, "the SELL closes the settling cohort's position");
    await repo.recordTradeClose({ cohortTradeId: btcTrade, pnl: "-31.5", sourceType: "realization", sourceId: "r1", idempotencyKey: "pnl-r1" });
    await repo.recordTradeClose({ cohortTradeId: btcTrade, pnl: "-31.5", sourceType: "realization", sourceId: "r1", idempotencyKey: "pnl-r1" });
    assert.equal(await repo.advanceCohort(first, endsAt), "settled");
    const closed = (await query<{ closing_value: string }>("SELECT closing_value::text AS closing_value FROM cohorts WHERE id = $1", [first])).rows[0]!;
    assert.equal(closed.closing_value, "1018.50000000", "1050 in, one loss of 31.50 recorded once");
  });

  await t.test("members' values split the closing value exactly by their capital", async () => {
    const a = await repo.statementFor(alice);
    const b = await repo.statementFor(bob);
    assert.equal(a.length, 1);
    assert.equal(a[0]!.capitalIn, "600.00000000");
    assert.equal(a[0]!.value, "582.00000000");
    assert.equal(b[0]!.value, "436.50000000");
    assert.equal(Number(a[0]!.value) + Number(b[0]!.value), 1018.5);
    assert.equal(a.some((s) => s.capitalIn === "400.00000000"), false, "nobody sees another member's figures");
  });

  await t.test("after settlement, a member can withdraw up to their value and no more", async () => {
    await assert.rejects(repo.recordWithdrawal({ membershipId: aliceM, amount: "582.01", reference: "w1", actor: admin, idempotencyKey: "wd-1" }),
      /At most 582/);
    await repo.recordWithdrawal({ membershipId: aliceM, amount: "582", reference: "w1", actor: admin, idempotencyKey: "wd-1" });
    const a = await repo.statementFor(alice);
    assert.equal(a[0]!.paidOut, "582.00000000");
    assert.equal(a[0]!.value, "582.00000000", "a payout doesn't change what the member was worth");
    await assert.rejects(repo.recordWithdrawal({ membershipId: aliceM, amount: "0.01", reference: "w2", actor: admin, idempotencyKey: "wd-2" }),
      /Nothing is left/);
    assert.equal((await repo.statementFor(bob))[0]!.value, "436.50000000", "another member's payout changes nothing for Bob");
    await assert.rejects(repo.recordTradeClose({ cohortTradeId: btcTrade, pnl: "5", sourceType: "x", sourceId: "x", idempotencyKey: "late-pnl" }),
      /settled/);
  });

  await t.test("an account with recorded money can't be deleted", async () => {
    await assert.rejects(query("DELETE FROM users WHERE id = $1", [alice]));
  });

  await t.test("a cohort with no money is cancelled rather than run", async () => {
    const pkg2 = await repo.createPackage({ name: "Empty", term: "half_month", minAmount: "0", tradePercent: "10", actor: admin });
    const cohort = await repo.scheduleNextCohort(pkg2, before);
    const starts = (await query<{ starts_at: Date }>("SELECT starts_at FROM cohorts WHERE id = $1", [cohort])).rows[0]!.starts_at;
    assert.equal(await repo.advanceCohort(cohort, starts), "cancelled");
  });
});
