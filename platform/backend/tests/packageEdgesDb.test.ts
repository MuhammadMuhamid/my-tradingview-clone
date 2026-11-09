/**
 * Package money edge cases through the real API against PostgreSQL:
 *
 * - an idempotency key replays only the entry it recorded: same cohort, kind,
 *   amount AND membership;
 * - a retry after the cohort moved on returns the original result instead of a
 *   409 that invites recording the money a second time;
 * - a replayed withdrawal answers 200, not 201;
 * - an account with package records can't be deleted, and says so with a 409
 *   rather than a 500, keeping every row.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_package_edges`;
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

test("package money edge cases", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { buildServer } = await import("../src/api/server");
  const { hashPassword } = await import("../src/security/session");
  const { loginLimiter, twoFactorLimiter, stepUpLimiter } = await import("../src/security/rateLimit");
  const { totpCode, totpStepAt } = await import("../src/security/twoFactor");
  const { startTotpSetup, enableTotp } = await import("../src/repositories/accountSecurity");
  const { forgetUser } = await import("../src/security/requestUser");
  const { ADMIN_USER_ID } = await import("../src/repositories/users");
  const repo = await import("../src/repositories/packages");
  after(() => closePool());
  await migrate();

  const previous = { authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    adminUsername: config.adminUsername, adminPasswordHash: config.adminPasswordHash, emailFrom: config.emailFrom };
  Object.assign(config, { authEnabled: true, sessionSecret: "package-edges-test-secret-000000000000000000",
    allowSignups: true, adminUsername: "owner", adminPasswordHash: hashPassword("owner password"), emailFrom: "" });
  t.after(() => Object.assign(config, previous));
  const app = buildServer(() => ({} as never));
  t.after(() => app.close());

  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    `srtrend_session=${/srtrend_session=([^;]+)/.exec(String(res.headers["set-cookie"]))![1]}`;
  const call = (cookie: string | null, method: string, url: string, payload?: object) => {
    loginLimiter.reset("127.0.0.1");
    twoFactorLimiter.reset(ADMIN_USER_ID);
    return app.inject({ method: method as "POST", url, ...(cookie ? { headers: { cookie } } : {}), ...(payload ? { payload } : {}) });
  };
  const admin = cookieOf(await call(null, "POST", "/api/auth/login", { username: "owner", password: "owner password" }));
  const signUp = async (email: string) => {
    const res = await call(null, "POST", "/api/auth/signup", { email, password: "correct horse battery" });
    assert.equal(res.statusCode, 201, res.body);
    return { cookie: cookieOf(res), id: (res.json() as { user: { id: string } }).user.id };
  };
  const ledger = async (membershipId: string) => (await query<{ kind: string; amount: string; idempotency_key: string }>(
    "SELECT kind, amount::text AS amount, idempotency_key FROM ledger_entries WHERE membership_id = $1 ORDER BY recorded_at, id",
    [membershipId])).rows;
  const byKey = async (key: string) =>
    Number((await query<{ n: string }>("SELECT count(*) AS n FROM ledger_entries WHERE idempotency_key = $1", [key])).rows[0]!.n);

  const alice = await signUp("alice@example.com");
  const bob = await signUp("bob@example.com");
  const carol = await signUp("carol@example.com");
  const dave = await signUp("dave@example.com");
  const strategyId = (await query<{ id: number }>("SELECT id FROM strategies ORDER BY id LIMIT 1")).rows[0]!.id;
  const deployment = (await query<{ id: string }>(
    "INSERT INTO deployments (strategy_id, symbol, timeframe, params) VALUES ($1, 'BTCUSDT', '15m', '{}') RETURNING id",
    [strategyId])).rows[0]!.id;
  const packageId = (await call(admin, "POST", "/api/admin/packages",
    { name: "Edges 1M", term: "month", minAmount: "0", tradePercent: "25" })).json().id as string;
  assert.equal((await call(admin, "POST", `/api/admin/packages/${packageId}/deployments`, { deploymentId: deployment })).statusCode, 201);
  const cohortId = (await call(admin, "POST", `/api/admin/packages/${packageId}/cohorts`)).json().id as string;
  assert.equal((await call(admin, "POST", `/api/admin/packages/${packageId}/status`, { status: "active", password: "owner password" })).statusCode, 200);
  const { starts_at: startsAt, ends_at: endsAt } = (await query<{ starts_at: Date; ends_at: Date }>(
    "SELECT starts_at, ends_at FROM cohorts WHERE id = $1", [cohortId])).rows[0]!;

  const addMember = async (email: string) => {
    const res = await call(admin, "POST", `/api/admin/cohorts/${cohortId}/members`, { email });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().membershipId as string;
  };
  const aliceM = await addMember("alice@example.com");
  const bobM = await addMember("bob@example.com");
  // Carol only ASKS to join: a membership row with no money.
  await query("UPDATE users SET email_verified_at = now() WHERE id = $1", [carol.id]);
  await startTotpSetup(carol.id, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  await enableTotp(carol.id);
  forgetUser(carol.id);
  assert.equal((await call(carol.cookie, "POST", `/api/packages/cohorts/${cohortId}/join`)).statusCode, 201);

  const deposit = (membershipId: string, body: object) => call(admin, "POST", `/api/admin/memberships/${membershipId}/deposits`,
    { reference: "trc20-tx", password: "owner password", ...body });
  const withdraw = (membershipId: string, body: object) => call(admin, "POST", `/api/admin/memberships/${membershipId}/withdrawals`,
    { reference: "payout", password: "owner password", ...body });

  await t.test("P1a: a deposit key used for one member is not a replay for another member", async () => {
    const first = await deposit(aliceM, { amount: "500", idempotencyKey: "dep-shared-1" });
    assert.equal(first.statusCode, 201, first.body);
    const misused = await deposit(bobM, { amount: "500", idempotencyKey: "dep-shared-1" });
    assert.equal(misused.statusCode, 409, misused.body);
    assert.deepEqual(await ledger(bobM), [], "nothing is recorded or claimed for Bob");
    assert.equal(await byKey("dep-shared-1"), 1);
    const bobs = await deposit(bobM, { amount: "300", idempotencyKey: "dep-bob-1" });
    assert.equal(bobs.statusCode, 201, bobs.body);
  });

  await t.test("P1b: retrying a recorded deposit after the cohort started returns the original result", async () => {
    const original = (await deposit(aliceM, { amount: "500", idempotencyKey: "dep-shared-1" })).json() as { entryId: string };
    assert.equal(await repo.advanceCohort(cohortId, startsAt), "running");
    const retry = await deposit(aliceM, { amount: "500", idempotencyKey: "dep-shared-1" });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json(), { entryId: original.entryId, created: false });
    assert.equal(await byKey("dep-shared-1"), 1, "never recorded twice");
    // A NEW deposit is still refused once the cohort has started.
    assert.equal((await deposit(aliceM, { amount: "5", idempotencyKey: "dep-alice-late" })).statusCode, 409);
    // The same key with a different amount is not a replay.
    assert.equal((await deposit(aliceM, { amount: "501", idempotencyKey: "dep-shared-1" })).statusCode, 409);
  });

  await t.test("P1c: a replayed withdrawal answers 200, records nothing new, and isn't someone else's", async () => {
    assert.equal(await repo.advanceCohort(cohortId, endsAt), "settled");
    const first = await withdraw(aliceM, { amount: "200", idempotencyKey: "wd-alice-1" });
    assert.equal(first.statusCode, 201, first.body);
    const again = await withdraw(aliceM, { amount: "200", idempotencyKey: "wd-alice-1" });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal((again.json() as { created: boolean }).created, false);
    assert.equal(await byKey("wd-alice-1"), 1);
    const bobsTry = await withdraw(bobM, { amount: "200", idempotencyKey: "wd-alice-1" });
    assert.equal(bobsTry.statusCode, 409, bobsTry.body);
    assert.deepEqual((await ledger(bobM)).filter((e) => e.kind === "CAPITAL_OUT"), [], "Bob has no payout");
  });

  await t.test("P1b: retrying a withdrawal that emptied the balance returns the original result", async () => {
    const last = await withdraw(aliceM, { amount: "300", idempotencyKey: "wd-alice-2" });
    assert.equal(last.statusCode, 201, last.body);
    const retry = await withdraw(aliceM, { amount: "300", idempotencyKey: "wd-alice-2" });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(await byKey("wd-alice-2"), 1);
    assert.equal((await withdraw(aliceM, { amount: "1", idempotencyKey: "wd-alice-2" })).statusCode, 409, "a different amount is not a replay");
    assert.equal((await withdraw(aliceM, { amount: "1", idempotencyKey: "wd-alice-3" })).statusCode, 409, "nothing is left");
    const out = (await ledger(aliceM)).filter((e) => e.kind === "CAPITAL_OUT").map((e) => e.amount);
    assert.deepEqual(out, ["-200.00000000", "-300.00000000"]);
  });

  await t.test("P2 (OD-6): money not yet paid out blocks deletion; a paid-out member and a join request can leave", async () => {
    const entries = Number((await query<{ n: string }>("SELECT count(*) AS n FROM ledger_entries")).rows[0]!.n);
    const sum = async () => (await query<{ s: string }>("SELECT COALESCE(sum(amount), 0)::text AS s FROM ledger_entries")).rows[0]!.s;
    const total = await sum();
    const del = (who: { cookie: string; id: string }, credential: object) => {
      stepUpLimiter.reset(who.id);
      return call(who.cookie, "DELETE", "/api/auth/account", { confirm: "DELETE", credential });
    };

    // Bob deposited 300 and was never paid out: refused, nothing changes, still signed in.
    const refused = await del(bob, { password: "correct horse battery" });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().code, "membership_active");
    assert.match((refused.json() as { error: string }).error, /package/i);
    assert.equal((await query("SELECT 1 FROM users WHERE id = $1", [bob.id])).rowCount, 1, "the account is kept");
    assert.equal((await query("SELECT 1 FROM memberships WHERE user_id = $1", [bob.id])).rowCount, 1, "the membership is kept");
    assert.equal((await call(bob.cookie, "GET", "/api/portfolio")).statusCode, 200, "still signed in");

    // Alice's cohort settled and she was paid out in full: she can leave; her
    // membership and ledger stay, anonymous.
    const aliceGone = await del(alice, { password: "correct horse battery" });
    assert.equal(aliceGone.statusCode, 200, aliceGone.body);
    const kept = await query<{ user_id: string | null; former_member_ref: string | null }>(
      "SELECT user_id, former_member_ref FROM memberships WHERE id = $1", [aliceM]);
    assert.equal(kept.rows[0]!.user_id, null);
    assert.ok(kept.rows[0]!.former_member_ref, "a former-member reference stands in for her");

    // Carol only asked to join (and has two-factor on): the code confirms, the request goes.
    const carolGone = await del(carol, { code: totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", totpStepAt(Date.now())) });
    assert.equal(carolGone.statusCode, 200, carolGone.body);
    assert.equal((await query("SELECT 1 FROM memberships WHERE user_id = $1", [carol.id])).rowCount, 0);

    assert.equal(Number((await query<{ n: string }>("SELECT count(*) AS n FROM ledger_entries")).rows[0]!.n), entries, "no ledger row lost");
    assert.equal(await sum(), total, "no amount changed");
    // An account without any is deleted as before.
    assert.equal((await del(dave, { password: "correct horse battery" })).statusCode, 200);
  });
});
