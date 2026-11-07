/**
 * Package routes through the real API and session gate, against PostgreSQL:
 * who may reach what, re-entering a credential before money is recorded, joining
 * only with a verified email and two-factor, and members seeing only their own.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_package_routes`;
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

test("package routes", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { buildServer } = await import("../src/api/server");
  const { hashPassword } = await import("../src/security/session");
  const { loginLimiter, twoFactorLimiter } = await import("../src/security/rateLimit");
  const { startTotpSetup, enableTotp } = await import("../src/repositories/accountSecurity");
  const { totpCode, totpStepAt } = await import("../src/security/twoFactor");
  const { forgetUser } = await import("../src/security/requestUser");
  after(() => closePool());
  await migrate();

  const previous = { authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    adminUsername: config.adminUsername, adminPasswordHash: config.adminPasswordHash, emailFrom: config.emailFrom };
  Object.assign(config, { authEnabled: true, sessionSecret: "package-routes-test-secret-00000000000000000",
    allowSignups: true, adminUsername: "owner", adminPasswordHash: hashPassword("owner password"), emailFrom: "" });
  t.after(() => Object.assign(config, previous));
  const app = buildServer(() => ({} as never));
  t.after(() => app.close());

  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    `srtrend_session=${/srtrend_session=([^;]+)/.exec(String(res.headers["set-cookie"]))![1]}`;
  const call = (cookie: string | null, method: string, url: string, payload?: object) => {
    loginLimiter.reset("127.0.0.1");
    return app.inject({ method: method as "POST", url, ...(cookie ? { headers: { cookie } } : {}), ...(payload ? { payload } : {}) });
  };
  const admin = cookieOf(await call(null, "POST", "/api/auth/login", { username: "owner", password: "owner password" }));
  const signUp = async (email: string) => {
    const res = await call(null, "POST", "/api/auth/signup", { email, password: "correct horse battery" });
    return { cookie: cookieOf(res), id: (res.json() as { user: { id: string } }).user.id };
  };
  const secure = async (userId: string) => {
    await query("UPDATE users SET email_verified_at = now() WHERE id = $1", [userId]);
    await startTotpSetup(userId, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    await enableTotp(userId);
    forgetUser(userId);
  };

  const alice = await signUp("alice@example.com");
  const bob = await signUp("bob@example.com");
  await query("INSERT INTO symbols (symbol) VALUES ('BTCUSDT') ON CONFLICT DO NOTHING").catch(() => undefined);
  const strategyId = (await query<{ id: number }>("SELECT id FROM strategies ORDER BY id LIMIT 1")).rows[0]!.id;
  const deployment = (await query<{ id: string }>(
    "INSERT INTO deployments (strategy_id, symbol, timeframe, params) VALUES ($1, 'BTCUSDT', '15m', '{}') RETURNING id",
    [strategyId])).rows[0]!.id;

  await t.test("an ordinary account gets 403 on every admin route", async () => {
    for (const [method, url] of [["GET", "/api/admin/packages"], ["POST", "/api/admin/packages"], ["GET", "/api/admin/audit"],
      ["POST", "/api/admin/memberships/00000000-0000-4000-8000-000000000009/deposits"],
      ["GET", "/api/admin/cohorts/00000000-0000-4000-8000-000000000009"]] as const) {
      assert.equal((await call(alice.cookie, method, url, {})).statusCode, 403, `${method} ${url}`);
    }
    assert.equal((await call(null, "GET", "/api/packages")).statusCode, 401);
  });

  let packageId = "", cohortId = "";
  await t.test("the administrator creates a package, adds a coin and schedules a cohort", async () => {
    const bad = await call(admin, "POST", "/api/admin/packages", { name: "X", term: "weekly", tradePercent: "10" });
    assert.equal(bad.statusCode, 400);
    const created = await call(admin, "POST", "/api/admin/packages",
      { name: "Trend 1M", term: "month", minAmount: "100", tradePercent: "25", joinInstructions: "Send USDT on TRC20." });
    assert.equal(created.statusCode, 201, created.body);
    packageId = created.json().id;
    assert.equal((await call(admin, "POST", "/api/admin/packages", { name: "trend 1m", term: "month", tradePercent: "5" })).statusCode, 409);
    assert.equal((await call(admin, "POST", `/api/admin/packages/${packageId}/deployments`, { deploymentId: deployment })).statusCode, 201);
    assert.equal((await call(admin, "POST", `/api/admin/packages/${packageId}/deployments`, { deploymentId: deployment })).statusCode, 409);
    const cohort = await call(admin, "POST", `/api/admin/packages/${packageId}/cohorts`);
    assert.equal(cohort.statusCode, 201, cohort.body);
    cohortId = cohort.json().id;
  });

  await t.test("a paused package isn't offered, and activating it needs the password", async () => {
    assert.deepEqual((await call(alice.cookie, "GET", "/api/packages")).json().packages, []);
    assert.equal((await call(admin, "POST", `/api/admin/packages/${packageId}/status`, { status: "active", password: "wrong" })).statusCode, 400);
    twoFactorLimiter.reset("00000000-0000-4000-8000-000000000001");
    assert.equal((await call(admin, "POST", `/api/admin/packages/${packageId}/status`, { status: "active", password: "owner password" })).statusCode, 200);
    const offered = (await call(alice.cookie, "GET", "/api/packages")).json().packages;
    assert.equal(offered.length, 1);
    assert.equal(offered[0].nextCohort.id, cohortId);
    assert.equal(offered[0].joinInstructions, "Send USDT on TRC20.");
    assert.equal(JSON.stringify(offered).includes("tradePercent"), false, "members don't see sizing");
  });

  let aliceM = "";
  await t.test("joining needs a verified email and two-factor", async () => {
    const refused = await call(alice.cookie, "POST", `/api/packages/cohorts/${cohortId}/join`);
    assert.equal(refused.statusCode, 403);
    await secure(alice.id);
    const joined = await call(alice.cookie, "POST", `/api/packages/cohorts/${cohortId}/join`);
    assert.equal(joined.statusCode, 201, joined.body);
    aliceM = joined.json().membershipId;
    assert.equal((await call(alice.cookie, "GET", "/api/portfolio")).json().pending[0].status, "requested");
  });

  await t.test("money is recorded only after approval and only with a re-entered credential", async () => {
    const deposit = (extra: object) => call(admin, "POST", `/api/admin/memberships/${aliceM}/deposits`,
      { amount: "500", reference: "trc20-tx-1", idempotencyKey: "deposit-alice-1", ...extra });
    twoFactorLimiter.reset("00000000-0000-4000-8000-000000000001");
    assert.equal((await deposit({ password: "owner password" })).statusCode, 409, "not approved yet");
    assert.equal((await call(admin, "POST", `/api/admin/memberships/${aliceM}/decision`, { approve: true })).statusCode, 200);
    assert.equal((await deposit({})).statusCode, 400, "no password");
    assert.equal((await deposit({ amount: "5e2", password: "owner password" })).statusCode, 400, "not a plain number");
    twoFactorLimiter.reset("00000000-0000-4000-8000-000000000001");
    assert.equal((await deposit({ password: "owner password" })).statusCode, 201);
    twoFactorLimiter.reset("00000000-0000-4000-8000-000000000001");
    assert.equal((await deposit({ password: "owner password" })).statusCode, 200, "the same key again records nothing new");
  });

  await t.test("an administrator with two-factor on confirms with a code instead", async () => {
    const adminId = "00000000-0000-4000-8000-000000000001";
    await startTotpSetup(adminId, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    await enableTotp(adminId);
    forgetUser(adminId);
    twoFactorLimiter.reset(adminId);
    const withPassword = await call(admin, "POST", `/api/admin/packages/${packageId}/status`, { status: "active", password: "owner password" });
    assert.equal(withPassword.statusCode, 400);
    assert.match(withPassword.json().error, /code/);
    const code = totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", totpStepAt(Date.now()));
    assert.equal((await call(admin, "POST", `/api/admin/packages/${packageId}/status`, { status: "active", code })).statusCode, 200);
    await query("UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL WHERE id = $1", [adminId]);
    forgetUser(adminId);
  });

  await t.test("the administrator can add someone directly, and sees every member", async () => {
    const added = await call(admin, "POST", `/api/admin/cohorts/${cohortId}/members`, { email: "bob@example.com" });
    assert.equal(added.statusCode, 201, added.body);
    assert.equal((await call(admin, "POST", `/api/admin/cohorts/${cohortId}/members`, { email: "nobody@example.com" })).statusCode, 404);
    const detail = (await call(admin, "GET", `/api/admin/cohorts/${cohortId}`)).json();
    assert.equal(detail.members.length, 2);
    assert.equal(detail.members.find((m: { email: string }) => m.email === "alice@example.com").capitalIn, "500.00000000");
    assert.equal(detail.equity, "500.00000000");
  });

  await t.test("a member sees only their own holdings", async () => {
    const mine = (await call(alice.cookie, "GET", "/api/portfolio")).json();
    assert.equal(mine.holdings.length, 1);
    assert.equal(mine.holdings[0].capitalIn, "500.00000000");
    const bobs = (await call(bob.cookie, "GET", "/api/portfolio")).json();
    assert.equal(bobs.holdings[0].capitalIn, "0.00000000");
    assert.equal(JSON.stringify(bobs).includes("alice"), false);
  });

  await t.test("withdrawing before settlement is refused, and every action is in the audit log", async () => {
    twoFactorLimiter.reset("00000000-0000-4000-8000-000000000001");
    const early = await call(admin, "POST", `/api/admin/memberships/${aliceM}/withdrawals`,
      { amount: "10", reference: "payout-1", idempotencyKey: "withdraw-alice-1", password: "owner password" });
    assert.equal(early.statusCode, 409);
    const actions = (await call(admin, "GET", "/api/admin/audit")).json().entries.map((e: { action: string }) => e.action);
    for (const action of ["package.create", "package.attach_deployment", "package.status", "membership.approve", "deposit.record", "membership.add"]) {
      assert.ok(actions.includes(action), action);
    }
  });
});
