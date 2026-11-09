/**
 * Genuine self-service account deletion (owner decision OD-6, migration 054),
 * through the real API and session gate against a real PostgreSQL.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_account_deletion`;
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

const PASSWORD = "correct horse battery";
const ADMIN_PASSWORD = "owner password";

/**
 * Every foreign key to users(id), with the rule deletion relies on. A new one
 * fails this test until someone decides what deleting an account does to it.
 * confdeltype: c = CASCADE, n = SET NULL, r = RESTRICT, a = NO ACTION.
 */
const USER_FOREIGN_KEYS: Record<string, "c" | "n"> = {
  "admin_audit.actor": "n",
  "chart_drawings.user_id": "c",
  "chart_layouts.user_id": "c",
  "chart_pane_studies.user_id": "c",
  "email_verification_tokens.user_id": "c",
  "ledger_entries.recorded_by": "n",
  "login_events.user_id": "c",
  "ma_alerts.user_id": "c",
  "memberships.decided_by": "n",
  "memberships.user_id": "n",
  "packages.created_by": "n",
  "pine_scripts.user_id": "c",
  "push_subscriptions.user_id": "c",
  "step_up_grants.user_id": "c",
  "totp_recovery_codes.user_id": "c",
  "watchlists.user_id": "c",
};

test("account deletion", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { buildServer } = await import("../src/api/server");
  const { useEmailTransportForTests } = await import("../src/email/mailer");
  const { loginLimiter, stepUpLimiter } = await import("../src/security/rateLimit");
  const { totpCode, totpStepAt } = await import("../src/security/twoFactor");
  const { hashPassword } = await import("../src/security/session");
  const { ADMIN_USER_ID } = await import("../src/repositories/users");
  const { appendAdminAudit } = await import("../src/repositories/adminAudit");
  const grantsRepo = await import("../src/repositories/stepUpGrants");
  const packages = await import("../src/repositories/packages");
  // Loaded softly, so that against a build without it every other assertion still runs (and fails on behaviour).
  const deletionModule = await import("../src/repositories/accountDeletion").catch(() => null);
  const deleteAccount = async (id: string) => {
    assert.ok(deletionModule, "repositories/accountDeletion exists");
    return deletionModule.deleteAccount(id);
  };
  after(() => closePool());
  await migrate();

  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    emailFrom: config.emailFrom, publicBaseUrl: config.publicBaseUrl, adminUsername: config.adminUsername,
    adminPasswordHash: config.adminPasswordHash, githubClientId: config.githubClientId,
    githubClientSecret: config.githubClientSecret,
  };
  Object.assign(config, {
    authEnabled: true, sessionSecret: "account-deletion-test-secret-000000000000000", allowSignups: true,
    emailFrom: "no-reply@example.test", publicBaseUrl: "https://app.example.test",
    adminUsername: "owner", adminPasswordHash: hashPassword(ADMIN_PASSWORD),
    githubClientId: "id", githubClientSecret: "secret",
  });
  t.after(() => { Object.assign(config, previous); useEmailTransportForTests(null); });
  useEmailTransportForTests(async () => {});

  const app = buildServer(() => ({} as never));
  t.after(() => app.close());

  type Res = { headers: Record<string, unknown> };
  const cookiesOf = (res: Res) => ([res.headers["set-cookie"]].flat().filter(Boolean) as string[]);
  const cookieNamed = (res: Res, name: string) => {
    const found = cookiesOf(res).map((c) => new RegExp(`^${name}=([^;]+)`).exec(c)?.[1]).find(Boolean);
    return found ? `${name}=${found}` : null;
  };
  const session = (res: Res) => cookieNamed(res, "srtrend_session");
  const call = (cookie: string | null, method: string, url: string, payload?: object) => {
    loginLimiter.reset("127.0.0.1");
    return app.inject({ method: method as "POST", url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
  };
  const signUp = async (email: string) => {
    const res = await call(null, "POST", "/api/auth/signup", { email, password: PASSWORD });
    assert.equal(res.statusCode, 201, res.body);
    return { cookie: session(res)!, id: (res.json() as { user: { id: string } }).user.id };
  };
  const exists = async (id: string) => (await query("SELECT 1 FROM users WHERE id = $1", [id])).rowCount === 1;
  const count = async (sql: string, params: unknown[]) => Number((await query<{ n: string }>(sql, params)).rows[0]!.n);
  const del = (cookie: string | null, body: object) => call(cookie, "DELETE", "/api/auth/account", body);

  const admin = session(await call(null, "POST", "/api/auth/login", { username: "owner", password: ADMIN_PASSWORD }))!;

  // A package with one cohort that runs and settles, and another that is running.
  const settledPkg = await packages.createPackage({ name: "Settled pkg", term: "month", minAmount: "0", tradePercent: "10", actor: ADMIN_USER_ID });
  const settledCohort = await packages.scheduleNextCohort(settledPkg, new Date());
  const runningPkg = await packages.createPackage({ name: "Running pkg", term: "month", minAmount: "0", tradePercent: "10", actor: ADMIN_USER_ID });
  const runningCohort = await packages.scheduleNextCohort(runningPkg, new Date());
  const windowOf = async (cohortId: string) => (await query<{ starts_at: Date; ends_at: Date }>(
    "SELECT starts_at, ends_at FROM cohorts WHERE id = $1", [cohortId])).rows[0]!;

  await t.test("contract: every foreign key to users has the rule deletion expects", async () => {
    const { rows } = await query<{ tbl: string; col: string; rule: string }>(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype AS rule
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass`);
    const actual = Object.fromEntries(rows.map((r) => [`${r.tbl}.${r.col}`, r.rule]).sort());
    assert.deepEqual(actual, USER_FOREIGN_KEYS);
    // And what hangs off an alert goes with it.
    const alertChildren = await query<{ tbl: string; rule: string }>(
      `SELECT conrelid::regclass::text AS tbl, confdeltype AS rule FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'ma_alerts'::regclass ORDER BY 1`);
    assert.deepEqual(alertChildren.rows, [
      { tbl: "ma_alert_delivery_outbox", rule: "c" }, { tbl: "ma_alert_events", rule: "c" },
    ]);
  });

  await t.test("a member with settled money, two-factor and everything an account owns: all of it goes", async () => {
    const full = await signUp("full@example.com");
    let cookie = full.cookie;
    // Owned rows of every kind.
    assert.equal((await call(cookie, "POST", "/api/watchlists", { name: "Main", symbols: ["BTCUSDT"] })).statusCode, 201);
    const alert = await call(cookie, "POST", "/api/ma-alerts", {
      symbol: "BTCUSDT", timeframe: "1h", conditionKind: "price", targetPrice: 70000, priceDirection: "cross_up",
      frequency: "once_per_bar" });
    assert.equal(alert.statusCode, 201, alert.body);
    const alertId = alert.json().id as string;
    await query(`INSERT INTO ma_alert_events (alert_id, bar_time, price, ma_value, distance_pct, title, body)
                 VALUES ($1, now(), 1, 1, 0, 't', 'b')`, [alertId]);
    await query(`INSERT INTO ma_alert_delivery_outbox (occurrence_key, alert_id, bar_time, payload)
                 VALUES ('occ-del-1', $1, now(), '{}')`, [alertId]);
    assert.equal((await call(cookie, "POST", "/api/layouts", { name: "BTC", symbol: "BTCUSDT", timeframe: "1h", strategyKey: "sr_trend" })).statusCode, 201);
    assert.equal((await call(cookie, "POST", "/api/pine", { name: "Mine", source: "//@version=5\nindicator(\"Mine\")\nplot(close)" })).statusCode, 201);
    assert.equal((await call(cookie, "PUT", "/api/chart-state/drawings/BTCUSDT", { drawings: [{ id: "d1", kind: "hline" }], baseVersion: 0 })).statusCode, 200);
    assert.equal((await call(cookie, "PUT", "/api/chart-state/panes/p1", { native: [{ key: "n1" }], baseVersion: 0 })).statusCode, 200);
    assert.equal((await call(cookie, "POST", "/api/push/subscribe", {
      endpoint: "https://fcm.googleapis.com/fcm/send/deleted-account",
      keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
    })).json().devices, 1);
    // Two-factor on (recovery codes), and a step-up grant.
    await query("UPDATE users SET email_verified_at = now() WHERE id = $1", [full.id]);
    const setup = await call(cookie, "POST", "/api/auth/2fa/setup", { password: PASSWORD });
    const secret = (setup.json() as { secret: string }).secret;
    const on = await call(cookie, "POST", "/api/auth/2fa/enable", { code: totpCode(secret, totpStepAt(Date.now())) });
    assert.equal(on.statusCode, 200, on.body);
    cookie = session(on)!;
    assert.ok(await grantsRepo.mintGrant(full.id, createHash("sha256").update("x".repeat(43)).digest("hex"), 300_000));
    // An audit row and a ledger row naming this account as actor/recorder (as if it had acted).
    await appendAdminAudit(full.id, "test.acted", "user:someone", { note: "kept" });
    // Money: joined, deposited 100, cohort ran and settled, paid out in full.
    const membership = await packages.addMember(full.id, settledCohort, ADMIN_USER_ID);
    await packages.recordDeposit({ membershipId: membership, amount: "100", reference: "dep", actor: ADMIN_USER_ID, idempotencyKey: "del-dep-1" });
    await query(`INSERT INTO ledger_entries (cohort_id, kind, amount, idempotency_key, recorded_by)
                 VALUES ($1, 'TRADE_PNL', 0, 'del-recorded-by', $2)`, [settledCohort, full.id]);
    const { starts_at: startsAt, ends_at: endsAt } = await windowOf(settledCohort);
    assert.equal(await packages.advanceCohort(settledCohort, startsAt), "running");
    assert.equal(await packages.advanceCohort(settledCohort, endsAt), "settled");
    await packages.recordWithdrawal({ membershipId: membership, amount: "100", reference: "payout", actor: ADMIN_USER_ID, idempotencyKey: "del-wd-1" });
    const ledgerBefore = (await query<{ n: string; s: string }>(
      "SELECT count(*) AS n, COALESCE(sum(amount), 0)::text AS s FROM ledger_entries WHERE cohort_id = $1", [settledCohort])).rows[0]!;
    const owned = async () => {
      const out: Record<string, number> = {};
      for (const [key, rule] of Object.entries(USER_FOREIGN_KEYS)) {
        if (rule !== "c") continue;
        const [table, column] = key.split(".");
        out[key] = await count(`SELECT count(*) AS n FROM ${table} WHERE ${column} = $1`, [full.id]);
      }
      out["ma_alert_events"] = await count("SELECT count(*) AS n FROM ma_alert_events WHERE alert_id = $1", [alertId]);
      out["ma_alert_delivery_outbox"] = await count("SELECT count(*) AS n FROM ma_alert_delivery_outbox WHERE alert_id = $1", [alertId]);
      return out;
    };
    const before = await owned();
    for (const [key, n] of Object.entries(before)) {
      // A brand-new account has no pine script of its own row? It does: it just saved one.
      assert.ok(n > 0, `the fixture has a ${key} row`);
    }

    // Refusals first: nothing is deleted by any of them.
    assert.deepEqual([(await del(cookie, {})).statusCode, (await del(cookie, {})).json().code], [400, "confirmation_required"]);
    const noCode = await del(cookie, { confirm: "DELETE" });
    assert.deepEqual([noCode.statusCode, noCode.json().code, noCode.json().method, noCode.json().tier],
      [400, "step_up_required", "totp", "fresh"]);
    const password = await del(cookie, { confirm: "DELETE", credential: { password: PASSWORD } });
    assert.deepEqual([password.statusCode, password.json().code], [400, "step_up_required"], "two-factor on: only the code");
    const wrong = await del(cookie, { confirm: "DELETE", credential: { code: "000000" } });
    assert.deepEqual([wrong.statusCode, wrong.json().code], [400, "step_up_failed"]);
    // A valid grant does not stand in for a fresh credential.
    const withGrant = await del(`${cookie}; srtrend_stepup=${"x".repeat(43)}`, { confirm: "DELETE" });
    assert.deepEqual([withGrant.statusCode, withGrant.json().code], [400, "step_up_required"]);
    assert.equal(await exists(full.id), true);

    await query("UPDATE users SET totp_last_step = 0 WHERE id = $1", [full.id]);
    stepUpLimiter.reset(full.id);
    const gone = await del(cookie, { confirm: "DELETE", credential: { code: totpCode(secret, totpStepAt(Date.now())) } });
    assert.equal(gone.statusCode, 200, gone.body);
    const cleared = cookiesOf(gone);
    assert.ok(cleared.some((c) => /^srtrend_session=;.*Max-Age=0/.test(c)), "the session cookie is cleared");
    assert.ok(cleared.some((c) => /^srtrend_stepup=;.*Max-Age=0/.test(c)), "the step-up cookie is cleared");

    assert.equal(await exists(full.id), false);
    assert.equal((await call(cookie, "GET", "/api/watchlists")).statusCode, 401, "the old cookie is dead");
    assert.equal((await call(cookie, "GET", "/api/auth/me")).json().authenticated, false);
    const after = await owned();
    for (const [key, n] of Object.entries(after)) assert.equal(n, 0, `${key} rows are gone`);

    // Kept: the audit row (actor now NULL), the ledger (recorder NULL), the anonymous membership.
    const audit = await query<{ actor: string | null; detail: { note: string } }>(
      "SELECT actor, detail FROM admin_audit WHERE action = 'test.acted'");
    assert.deepEqual([audit.rows[0]!.actor, audit.rows[0]!.detail.note], [null, "kept"]);
    const recorded = await query<{ recorded_by: string | null }>(
      "SELECT recorded_by FROM ledger_entries WHERE idempotency_key = 'del-recorded-by'");
    assert.equal(recorded.rows[0]!.recorded_by, null);
    const kept = await query<{ user_id: string | null; former_member_ref: string | null; status: string }>(
      "SELECT user_id, former_member_ref, status FROM memberships WHERE id = $1", [membership]);
    assert.equal(kept.rows[0]!.user_id, null);
    assert.match(kept.rows[0]!.former_member_ref ?? "", /^former-[0-9a-f]{8}$/);
    const ledgerAfter = (await query<{ n: string; s: string }>(
      "SELECT count(*) AS n, COALESCE(sum(amount), 0)::text AS s FROM ledger_entries WHERE cohort_id = $1", [settledCohort])).rows[0]!;
    assert.deepEqual(ledgerAfter, ledgerBefore, "no ledger row lost or changed");
    const detail = await packages.cohortDetail(settledCohort);
    const member = detail.members.find((m) => m.membershipId === membership)!;
    assert.equal(member.userId, null);
    assert.equal(member.email, null);
    assert.equal(member.formerMemberRef, kept.rows[0]!.former_member_ref);
    assert.match(member.displayName, /^Former member former-/);
    assert.ok(!JSON.stringify(detail).includes("full@example.com"));
    const adminView = await call(admin, "GET", `/api/admin/cohorts/${settledCohort}`);
    assert.equal(adminView.statusCode, 200, adminView.body);
  });

  await t.test("append-only still holds: only actor/recorder may become NULL, and nothing may be deleted", async () => {
    const raises = async (sql: string) => {
      await assert.rejects(query(sql), (err: { code?: string }) => err.code === "23001", sql);
    };
    await raises("UPDATE admin_audit SET detail = '{}' WHERE action = 'test.acted'");
    await raises("UPDATE admin_audit SET target = 'x' WHERE action = 'test.acted'");
    await raises(`UPDATE admin_audit SET actor = '${ADMIN_USER_ID}' WHERE action = 'test.acted'`);
    await raises("DELETE FROM admin_audit WHERE action = 'test.acted'");
    await raises("TRUNCATE admin_audit");
    await raises("UPDATE ledger_entries SET amount = amount + 1 WHERE idempotency_key = 'del-dep-1'");
    await raises("UPDATE ledger_entries SET note = 'edited' WHERE idempotency_key = 'del-dep-1'");
    await raises("UPDATE ledger_entries SET recorded_by = NULL, note = 'sneaky' WHERE idempotency_key = 'del-dep-1'");
    await raises("DELETE FROM ledger_entries WHERE idempotency_key = 'del-dep-1'");
    await raises("TRUNCATE ledger_entries CASCADE");
    // Only the one change the foreign key needs is allowed.
    await query("UPDATE ledger_entries SET recorded_by = NULL WHERE idempotency_key = 'del-dep-1'");
  });

  await t.test("a seat in a running cohort, or money not yet paid out, is 409 before any credential is asked", async () => {
    const runner = await signUp("runner@example.com");
    const membership = await packages.addMember(runner.id, runningCohort, ADMIN_USER_ID);
    await packages.recordDeposit({ membershipId: membership, amount: "50", reference: "dep", actor: ADMIN_USER_ID, idempotencyKey: "run-dep-1" });
    const { starts_at: startsAt } = await windowOf(runningCohort);
    assert.equal(await packages.advanceCohort(runningCohort, startsAt), "running");
    stepUpLimiter.reset(runner.id);
    for (const credential of [{ password: PASSWORD }, { password: "wrong" }, undefined]) {
      const res = await del(runner.cookie, { confirm: "DELETE", ...(credential ? { credential } : {}) });
      assert.deepEqual([res.statusCode, res.json().code], [409, "membership_active"], res.body);
    }
    assert.equal(await exists(runner.id), true);
    assert.equal((await call(runner.cookie, "GET", "/api/portfolio")).statusCode, 200, "still signed in");
    assert.equal(await deleteAccount(runner.id), "membership_active", "and again under the lock");
  });

  await t.test("a mere join request leaves no trace; a password account confirms with its password", async () => {
    const asker = await signUp("asker@example.com");
    const later = await packages.createPackage({ name: "Later pkg", term: "month", minAmount: "0", tradePercent: "10", actor: ADMIN_USER_ID });
    const cohort = await packages.scheduleNextCohort(later, new Date());
    const membership = await packages.requestMembership(asker.id, cohort);
    await packages.decideMembership(membership, false, ADMIN_USER_ID);
    stepUpLimiter.reset(asker.id);
    const wrong = await del(asker.cookie, { confirm: "DELETE", credential: { password: "nope nope" } });
    assert.deepEqual([wrong.statusCode, wrong.json().code, wrong.json().method], [400, "step_up_failed", "password"]);
    const gone = await del(asker.cookie, { confirm: "DELETE", credential: { password: PASSWORD } });
    assert.equal(gone.statusCode, 200, gone.body);
    assert.equal((await query("SELECT 1 FROM memberships WHERE id = $1", [membership])).rowCount, 0);
  });

  await t.test("deleting twice: the second is 404 (another instance's cached session); concurrent deletes delete once", async () => {
    const twice = await signUp("twice@example.com");
    assert.equal((await call(twice.cookie, "GET", "/api/auth/me")).json().authenticated, true, "the session is cached");
    // Deleted elsewhere, without this instance forgetting it: its gate still lets the cookie through.
    assert.equal(await deleteAccount(twice.id), "deleted");
    const second = await del(twice.cookie, { confirm: "DELETE", credential: { password: PASSWORD } });
    assert.deepEqual([second.statusCode, second.json().code], [404, "not_found"]);
    assert.equal(await deleteAccount(twice.id), "not_found");

    const racer = await signUp("racer@example.com");
    const results = await Promise.all([1, 2].map(() =>
      del(racer.cookie, { confirm: "DELETE", credential: { password: PASSWORD } })));
    const codes = results.map((r) => r.statusCode).sort();
    assert.equal(codes[0], 200, results.map((r) => r.body).join(" "));
    assert.ok([401, 404].includes(codes[1]!), results.map((r) => r.body).join(" "));
    assert.equal(await exists(racer.id), false);
  });

  await t.test("never the administrator, never with sign-in off, never without a session", async () => {
    const res = await del(admin, { confirm: "DELETE", credential: { password: ADMIN_PASSWORD } });
    assert.deepEqual([res.statusCode, res.json().code], [403, "admin_account"]);
    assert.equal(await deleteAccount(ADMIN_USER_ID), "admin");
    assert.equal((await del(null, { confirm: "DELETE" })).statusCode, 401);
    const user = await signUp("authoff@example.com");
    config.authEnabled = false;
    try {
      const off = await del(user.cookie, { confirm: "DELETE", credential: { password: PASSWORD } });
      assert.deepEqual([off.statusCode, off.json().code], [403, "auth_disabled"]);
    } finally {
      config.authEnabled = true;
    }
    assert.equal(await exists(user.id), true);
    assert.equal(await exists(ADMIN_USER_ID), true);
  });

  await t.test("step-up guesses on deletion are limited", async () => {
    const guesser = await signUp("guesser@example.com");
    stepUpLimiter.reset(guesser.id);
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await del(guesser.cookie, { confirm: "DELETE", credential: { password: "wrong one" } })).json().code, "step_up_failed");
    }
    const limited = await del(guesser.cookie, { confirm: "DELETE", credential: { password: PASSWORD } });
    assert.deepEqual([limited.statusCode, limited.json().code], [429, "step_up_rate_limited"]);
    assert.equal(await exists(guesser.id), true);
  });

  await t.test("a provider-only account confirms by typing DELETE; signing in again with the provider is a new account", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("login/oauth/access_token")) return Response.json({ access_token: "t" });
      if (u.endsWith("api.github.com/user")) return Response.json({ id: 4242, login: "octo" });
      if (u.endsWith("/user/emails")) return Response.json([{ email: "provider@example.com", primary: true, verified: true }]);
      return realFetch(url, init);
    }) as typeof fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const github = async () => {
      const start = await call(null, "GET", "/api/auth/github/start?next=/chart");
      const state = new URL(start.headers.location as string).searchParams.get("state")!;
      const res = await call(cookieNamed(start, "srtrend_oauth"), "GET", `/api/auth/github/callback?code=c&state=${state}`);
      assert.equal(res.statusCode, 302, res.body);
      return session(res)!;
    };
    const first = await github();
    const firstId = (await call(first, "GET", "/api/auth/me")).json().user.id as string;
    assert.equal((await query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = $1", [firstId])).rows[0]!.password_hash, null);
    const gone = await del(first, { confirm: "DELETE" });
    assert.equal(gone.statusCode, 200, gone.body);
    assert.equal(await exists(firstId), false);
    const again = await github();
    const secondId = (await call(again, "GET", "/api/auth/me")).json().user.id as string;
    assert.notEqual(secondId, firstId, "a fresh account, nothing carried over");
    assert.equal((await call(again, "GET", "/api/watchlists")).json().length, 0);
  });
});
