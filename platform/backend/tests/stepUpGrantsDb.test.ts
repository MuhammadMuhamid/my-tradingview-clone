/**
 * Step-up grants (owner decision OD-2), through the real API, session gate and
 * step-up, against a real PostgreSQL and the fake Bot (`support/fakeBot.ts`).
 *
 * A correct authenticator code before a command leaves a five-minute,
 * server-validated grant in an HttpOnly SameSite=Strict cookie; the next
 * grant-tier command from the same browser needs no code. Fresh-tier commands
 * ignore it. Every way of changing how someone signs in ends it.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_step_up`;
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

const SECRET = "step-up-db-test-secret-0123456789abcdef0123";
const BOT_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const TRADE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ADMIN_PASSWORD = "owner password";
const USER_PASSWORD = "correct horse battery";

let seq = 0;
const rid = (label = "req") => `${label}_${Date.now().toString(36)}_${(seq += 1).toString().padStart(6, "0")}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("step-up grants", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { buildServer } = await import("../src/api/server");
  const { useEmailTransportForTests } = await import("../src/email/mailer");
  const { loginLimiter, twoFactorLimiter, stepUpLimiter } = await import("../src/security/rateLimit");
  const { totpCode, totpStepAt } = await import("../src/security/twoFactor");
  const { hashPassword, signUserSession } = await import("../src/security/session");
  const users = await import("../src/repositories/users");
  const { forgetUser } = await import("../src/security/requestUser");
  const { listAdminAudit } = await import("../src/repositories/adminAudit");
  const grantsRepo = await import("../src/repositories/stepUpGrants");
  const { resetTwoFactor, targetOf } = await import("../src/scripts/resetAdmin2fa");
  const { resetBotControlStateForTests } = await import("../src/api/routes/botControl");
  const liveSafety = await import("../src/repositories/liveSafety");
  const { FakeBot } = await import("./support/fakeBot");
  after(() => closePool());
  await migrate();
  const ADMIN = users.ADMIN_USER_ID;

  const bot = new FakeBot(SECRET);
  await bot.start();
  t.after(() => bot.stop());
  bot.bots.set(BOT_ID, { id: BOT_ID, name: "Trend bot", status: "active" });

  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    emailFrom: config.emailFrom, publicBaseUrl: config.publicBaseUrl, adminUsername: config.adminUsername,
    adminPasswordHash: config.adminPasswordHash, manualTradingBotUrl: config.manualTradingBotUrl,
    manualTradingHmacSecret: config.manualTradingHmacSecret, cookieSecure: config.cookieSecure,
  };
  Object.assign(config, {
    authEnabled: true, sessionSecret: "step-up-test-session-secret-000000000000000", allowSignups: true,
    emailFrom: "no-reply@example.test", publicBaseUrl: "https://app.example.test",
    adminUsername: "owner", adminPasswordHash: hashPassword(ADMIN_PASSWORD),
    manualTradingBotUrl: bot.url, manualTradingHmacSecret: SECRET, cookieSecure: false,
  });
  t.after(() => { Object.assign(config, previous); useEmailTransportForTests(null); });
  useEmailTransportForTests(async () => {});

  const app = buildServer(() => ({} as never));
  t.after(() => app.close());

  type Res = { headers: Record<string, unknown> };
  const cookiesOf = (res: Res) => ([res.headers["set-cookie"]].flat().filter(Boolean) as string[]);
  const cookieNamed = (res: Res, name: string) => {
    const found = cookiesOf(res).map((c) => new RegExp(`^${name}=([^;]*)`).exec(c)?.[1]).find((v) => v !== undefined);
    return found ? `${name}=${found}` : null;
  };
  const rawSetCookie = (res: Res, name: string) => cookiesOf(res).find((c) => c.startsWith(`${name}=`)) ?? null;
  const session = (res: Res) => cookieNamed(res, "srtrend_session");
  const grantCookie = (res: Res) => cookieNamed(res, "srtrend_stepup");
  const jar = (...parts: (string | null)[]) => parts.filter(Boolean).join("; ");
  const call = (cookie: string | null, method: string, url: string, payload?: object) => {
    loginLimiter.reset("127.0.0.1");
    return app.inject({ method: method as "POST", url,
      headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
  };
  const grantRows = async (userId: string) =>
    (await query<{ id: string; handle_hash: string; revoked_at: Date | null; expires_at: Date; created_at: Date;
      session_version: number; role: string; method: string; action_class: string }>(
      "SELECT * FROM step_up_grants WHERE user_id = $1 ORDER BY created_at", [userId])).rows;

  const adminLogin = async () => {
    const res = await call(null, "POST", "/api/auth/login", { username: "owner", password: ADMIN_PASSWORD });
    assert.equal(res.statusCode, 200, res.body);
    return session(res)!;
  };
  let admin = await adminLogin();
  const signup = await call(null, "POST", "/api/auth/signup", { email: "standard@example.com", password: USER_PASSWORD });
  assert.equal(signup.statusCode, 201, signup.body);
  let standard = session(signup)!;
  const standardId = (signup.json() as { user: { id: string } }).user.id;

  const halt = (credential?: Record<string, string>, requestId = rid("halt")) => ({
    requestId, confirmation: "HALT_TRADING", reason: "grant test halt", ...(credential ? { credential } : {}),
  });
  const close = (cookie: string, credential?: Record<string, string>, requestId = rid("close")) =>
    call(cookie, "POST", `/api/bot/control/trades/${TRADE_ID}/close`, { requestId, ...(credential ? { credential } : {}) });
  const pauseBot = (cookie: string, credential?: Record<string, string>, requestId = rid("bot")) =>
    call(cookie, "POST", `/api/bot/control/bots/${BOT_ID}/status`,
      { requestId, status: "paused", ...(credential ? { credential } : {}) });
  const status = async (cookie: string) => {
    const res = await call(cookie, "GET", "/api/auth/step-up/status");
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { twoFactorEnabled: boolean; method: string | null; grant: { valid: boolean; expiresAt?: string } };
  };

  // ── two-factor off ─────────────────────────────────────────────────────────

  await t.test("2FA off: the password confirms a halt but never mints a grant", async () => {
    bot.reset();
    const res = await call(admin, "POST", "/api/bot/control/halt", halt({ password: ADMIN_PASSWORD }));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(grantCookie(res), null, "no grant cookie for a password");
    assert.equal((await grantRows(ADMIN)).length, 0);
    assert.deepEqual(await status(admin), { twoFactorEnabled: false, method: "password", grant: { valid: false } });
  });

  await t.test("Platform ops: halt by password (2FA off) is audited; resume and limits need two-factor", async () => {
    await liveSafety.setTradingHalted(false);
    const missing = await call(admin, "POST", "/api/ops/halt", { confirmation: "HALT_TRADING", reason: "ops test" });
    assert.equal(missing.statusCode, 400, missing.body);
    assert.deepEqual([missing.json().code, missing.json().method, missing.json().tier], ["step_up_required", "password", "grant"]);
    assert.equal((await liveSafety.getRiskLimits()).tradingHalted, false, "nothing changed without a credential");
    const wrong = await call(admin, "POST", "/api/ops/halt",
      { confirmation: "HALT_TRADING", reason: "ops test", credential: { password: "not it" } });
    assert.deepEqual([wrong.statusCode, wrong.json().code], [400, "step_up_failed"]);
    assert.equal((await liveSafety.getRiskLimits()).tradingHalted, false);
    const ok = await call(admin, "POST", "/api/ops/halt",
      { confirmation: "HALT_TRADING", reason: "ops test", credential: { password: ADMIN_PASSWORD } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await liveSafety.getRiskLimits()).tradingHalted, true);
    const rows = (await listAdminAudit("platform.halt.", 10)).reverse();
    assert.deepEqual(rows.map((r) => r.action), ["platform.halt.requested", "platform.halt.succeeded"]);
    assert.equal(rows[0]!.actor, ADMIN);
    assert.equal(rows[0]!.detail.stepUpMethod, "password");
    assert.ok(!JSON.stringify(rows).includes(ADMIN_PASSWORD));

    for (const [method, url, payload] of [
      ["POST", "/api/ops/resume", { confirmation: "RESUME_TRADING", credential: { password: ADMIN_PASSWORD } }],
      ["PATCH", "/api/ops/risk-limits", { maxConcurrentPositions: 2, credential: { password: ADMIN_PASSWORD } }],
    ] as [string, string, object][]) {
      const res = await call(admin, method, url, payload);
      assert.deepEqual([res.statusCode, res.json().code], [403, "two_factor_required"], url);
    }
    assert.equal((await liveSafety.getRiskLimits()).tradingHalted, true, "resume was refused");
  });

  await t.test("Platform ops: nobody 401, a Standard account 403, AUTH_ENABLED=false refused", async () => {
    const routes: [string, string, object][] = [
      ["POST", "/api/ops/halt", { confirmation: "HALT_TRADING", reason: "x y z", credential: { password: USER_PASSWORD } }],
      ["POST", "/api/ops/resume", { confirmation: "RESUME_TRADING" }],
      ["PATCH", "/api/ops/risk-limits", { maxConcurrentPositions: 1 }],
    ];
    for (const [method, url, payload] of routes) {
      assert.equal((await call(null, method, url, payload)).statusCode, 401, url);
      assert.equal((await call(standard, method, url, payload)).statusCode, 403, url);
    }
    config.authEnabled = false;
    try {
      for (const [method, url, payload] of routes) {
        const res = await call(null, method, url, { ...payload, credential: { password: ADMIN_PASSWORD } });
        assert.deepEqual([res.statusCode, res.json().code], [403, "auth_disabled"], url);
      }
    } finally {
      config.authEnabled = true;
    }
    assert.equal((await liveSafety.getRiskLimits()).tradingHalted, true, "still halted from the previous test");
  });

  await t.test("a Standard account reaches step-up status and Lock now (gate-normal), and sees no secret", async () => {
    const body = await status(standard);
    assert.deepEqual(body, { twoFactorEnabled: false, method: "password", grant: { valid: false } });
    assert.equal((await call(standard, "POST", "/api/auth/step-up/revoke")).statusCode, 200);
    assert.equal((await call(null, "GET", "/api/auth/step-up/status")).statusCode, 401);
  });

  // ── turning two-factor on ──────────────────────────────────────────────────

  const setup = await call(admin, "POST", "/api/auth/2fa/setup", { password: ADMIN_PASSWORD });
  assert.equal(setup.statusCode, 200, setup.body);
  const secret = (setup.json() as { secret: string }).secret;
  // A stale grant row a version ago (it cannot be minted while 2FA is off): enabling must delete it.
  await query(`INSERT INTO step_up_grants (user_id, session_version, role, handle_hash, action_class, method, expires_at)
               VALUES ($1, 1, 'admin', $2, 'operate', 'totp', now() + interval '5 minutes')`, [ADMIN, sha256("stale-handle")]);

  await t.test("enabling two-factor ends every other session, re-issues this one and deletes grants", async () => {
    const otherBrowser = await adminLogin();
    const enabled = await call(admin, "POST", "/api/auth/2fa/enable", { code: totpCode(secret, totpStepAt(Date.now())) });
    assert.equal(enabled.statusCode, 200, enabled.body);
    const reissued = session(enabled);
    assert.ok(reissued, "this session is re-issued");
    assert.match(rawSetCookie(enabled, "srtrend_stepup") ?? "", /Max-Age=0/, "any grant cookie is cleared");
    assert.equal((await call(admin, "GET", "/api/auth/me")).json().authenticated, false, "the old cookie no longer works");
    assert.equal((await call(otherBrowser, "GET", "/api/watchlists")).statusCode, 401, "another browser was signed out");
    admin = reissued!;
    assert.equal((await call(admin, "GET", "/api/watchlists")).statusCode, 200, "the re-issued session works");
    assert.equal((await grantRows(ADMIN)).length, 0, "the stale grant is gone");
    const rows = await listAdminAudit("auth.2fa.enabled", 5);
    assert.equal(rows.length, 1);
  });

  /** A code that will be accepted once: the last-used step is reset so tests need not wait 30 s. */
  const freshCode = async () => {
    await query("UPDATE users SET totp_last_step = 0 WHERE id = $1", [ADMIN]);
    stepUpLimiter.reset(ADMIN);
    twoFactorLimiter.reset(ADMIN);
    return totpCode(secret, totpStepAt(Date.now()));
  };
  /** Signing in again once two-factor is on: password, then the code. */
  const adminSignIn = async () => {
    const first = await call(null, "POST", "/api/auth/login", { username: "owner", password: ADMIN_PASSWORD });
    assert.equal(first.json().twoFactorRequired, true, first.body);
    const second = await call(cookieNamed(first, "srtrend_2fa"), "POST", "/api/auth/2fa/login", { code: await freshCode() });
    assert.equal(second.statusCode, 200, second.body);
    return session(second)!;
  };
  /** Mint a grant with one code-confirmed command; returns the grant cookie. */
  const mint = async () => {
    bot.reset();
    const res = await close(admin, { code: await freshCode() });
    assert.equal(res.statusCode, 200, res.body);
    const cookie = grantCookie(res);
    assert.ok(cookie, "a grant cookie is set");
    return cookie!;
  };

  await t.test("a code mints a grant cookie: HttpOnly, SameSite=Strict, Path=/api, five minutes, only its hash stored", async () => {
    bot.reset();
    const res = await close(admin, { code: await freshCode() });
    assert.equal(res.statusCode, 200, res.body);
    const raw = rawSetCookie(res, "srtrend_stepup")!;
    assert.ok(raw, res.headers["set-cookie"] as string);
    for (const attr of ["HttpOnly", "SameSite=Strict", "Path=/api", "Max-Age=300"]) assert.ok(raw.includes(attr), `${attr} in ${raw}`);
    assert.ok(!raw.includes("Secure"), "Secure follows COOKIE_SECURE");
    const handle = /^srtrend_stepup=([^;]+)/.exec(raw)![1]!;
    assert.match(handle, /^[A-Za-z0-9_-]{43}$/);
    const rows = await grantRows(ADMIN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.handle_hash, sha256(handle));
    assert.deepEqual([rows[0]!.method, rows[0]!.action_class, rows[0]!.role], ["totp", "operate", "admin"]);
    const life = rows[0]!.expires_at.getTime() - rows[0]!.created_at.getTime();
    assert.ok(Math.abs(life - 300_000) < 1000, `five minutes, got ${life}`);
    const everything = JSON.stringify((await query("SELECT * FROM step_up_grants")).rows)
      + JSON.stringify(await listAdminAudit("", 1000));
    assert.ok(!everything.includes(handle), "the handle itself is stored nowhere");
    const body = await status(jar(admin, `srtrend_stepup=${handle}`));
    assert.equal(body.grant.valid, true);
    assert.equal(body.grant.expiresAt, rows[0]!.expires_at.toISOString());
    assert.equal(body.method, "totp");
    assert.ok(!JSON.stringify(body).includes(handle));
  });

  await t.test("grant reuse: two more commands with no code; the Bot sees totp at the code's time; audit says grant", async () => {
    const grant = await mint();
    const row = (await grantRows(ADMIN)).find((g) => g.handle_hash === sha256(grant.split("=")[1]!));
    bot.reset();
    const first = await pauseBot(jar(admin, grant));
    assert.equal(first.statusCode, 200, first.body);
    const second = await call(jar(admin, grant), "POST", "/api/bot/control/halt", halt());
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(grantCookie(second), null, "using a grant does not reissue or extend it");
    const sent = bot.commandRequests();
    assert.equal(sent.length, 2);
    for (const request of sent) {
      const actor = (request.body as { actor: { stepUp: { method: string; at: string } } }).actor;
      assert.equal(actor.stepUp.method, "totp", "the Bot accepts totp|password only");
      assert.equal(actor.stepUp.at, row!.created_at.toISOString(), "at = when the code was entered");
      assert.ok(!request.raw.includes(grant.split("=")[1]!), "the handle never reaches the Bot");
    }
    const audits = (await listAdminAudit("bot.", 50)).filter((r) => r.action.endsWith(".requested")).slice(0, 2);
    for (const audit of audits) {
      assert.equal(audit.detail.stepUpMethod, "grant");
      assert.equal(audit.detail.grantId, row!.id);
    }
    const after = (await grantRows(ADMIN)).find((g) => g.id === row!.id)!;
    assert.equal(after.expires_at.getTime(), row!.expires_at.getTime(), "never extended on use");
  });

  await t.test("parallel tabs: two requests carrying the same handle both pass", async () => {
    const grant = await mint();
    bot.reset();
    resetBotControlStateForTests();
    const [a, b] = await Promise.all([
      close(jar(admin, grant)),
      call(jar(admin, grant), "POST", "/api/bot/control/halt", halt()),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode], [200, 200], `${a.body} ${b.body}`);
    assert.equal(bot.commandRequests().length, 2);
  });

  await t.test("the fresh tier ignores a grant; its code mints a new one and retires this browser's old handle", async () => {
    const grant = await mint();
    bot.reset();
    const refused = await call(jar(admin, grant), "PATCH", "/api/bot/control/risk-limits",
      { requestId: rid("risk"), maxConcurrentTrades: 2 });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.deepEqual([refused.json().code, refused.json().method, refused.json().tier], ["step_up_required", "totp", "fresh"]);
    const ops = await call(jar(admin, grant), "PATCH", "/api/ops/risk-limits", { maxConcurrentPositions: 2 });
    assert.deepEqual([ops.statusCode, ops.json().code, ops.json().tier], [400, "step_up_required", "fresh"]);
    assert.equal(bot.commandRequests().length, 0);
    const ok = await call(jar(admin, grant), "PATCH", "/api/bot/control/risk-limits",
      { requestId: rid("risk"), maxConcurrentTrades: 2, credential: { code: await freshCode() } });
    assert.equal(ok.statusCode, 200, ok.body);
    const renewed = grantCookie(ok);
    assert.ok(renewed && renewed !== grant, "a new grant");
    assert.equal((await pauseBot(jar(admin, grant))).json().code, "step_up_required", "the old handle was retired");
    assert.equal((await pauseBot(jar(admin, renewed))).statusCode, 200);
  });

  await t.test("expiry: after five minutes the grant is refused and the dialog asks again", async () => {
    const grant = await mint();
    await query("UPDATE step_up_grants SET expires_at = now() - interval '1 second', created_at = now() - interval '301 seconds'"
      + " WHERE handle_hash = $1", [sha256(grant.split("=")[1]!)]);
    bot.reset();
    const res = await pauseBot(jar(admin, grant));
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual([res.json().code, res.json().method, res.json().tier], ["step_up_required", "totp", "grant"]);
    assert.equal((await status(jar(admin, grant))).grant.valid, false);
    assert.equal(bot.commandRequests().length, 0);
  });

  await t.test("Lock now revokes this browser's grant only", async () => {
    const grant = await mint();
    const other = await mint();
    const lock = await call(jar(admin, grant), "POST", "/api/auth/step-up/revoke");
    assert.equal(lock.statusCode, 200);
    assert.match(rawSetCookie(lock, "srtrend_stepup") ?? "", /Max-Age=0/);
    assert.equal((await status(jar(admin, grant))).grant.valid, false);
    assert.equal((await pauseBot(jar(admin, grant))).json().code, "step_up_required");
    assert.equal((await status(jar(admin, other))).grant.valid, true, "another browser keeps its grant");
  });

  await t.test("a grant minted under another role is refused", async () => {
    const grant = await mint();
    await query("UPDATE step_up_grants SET role = 'user' WHERE handle_hash = $1", [sha256(grant.split("=")[1]!)]);
    assert.equal((await pauseBot(jar(admin, grant))).json().code, "step_up_required");
  });

  await t.test("one account's handle does nothing for another account's session", async () => {
    const grant = await mint();
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [standardId]);
    forgetUser(standardId);
    try {
      bot.reset();
      const res = await pauseBot(jar(standard, grant));
      assert.notEqual(res.statusCode, 200, res.body);
      assert.ok(["two_factor_required", "step_up_required"].includes(res.json().code), res.body);
      assert.equal(bot.commandRequests().length, 0);
    } finally {
      await query("UPDATE users SET role = 'user' WHERE id = $1", [standardId]);
      forgetUser(standardId);
    }
  });

  await t.test("TOTP replay across a grant mint: one code, two simultaneous commands, one passes", async () => {
    await query("DELETE FROM step_up_grants WHERE user_id = $1", [ADMIN]);
    bot.reset();
    resetBotControlStateForTests();
    const code = await freshCode();
    const results = await Promise.all([close(admin, { code }), pauseBot(admin, { code })]);
    const codes = results.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [200, 400], results.map((r) => r.body).join(" "));
    assert.equal(results.find((r) => r.statusCode === 400)!.json().code, "step_up_failed");
    assert.equal((await grantRows(ADMIN)).length, 1, "exactly one grant was minted");
    assert.equal(bot.commandRequests().length, 1);
  });

  await t.test("step-up has its own limiter: five wrong codes never lock the sign-in second step", async () => {
    await freshCode();
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await close(admin, { code: "000000" })).json().code, "step_up_failed");
    }
    const limited = await close(admin, { code: totpCode(secret, totpStepAt(Date.now())) });
    assert.deepEqual([limited.statusCode, limited.json().code], [429, "step_up_rate_limited"]);
    assert.ok(Number(limited.headers["retry-after"]) > 0);
    // The sign-in second step is untouched by those five.
    await query("UPDATE users SET totp_last_step = 0 WHERE id = $1", [ADMIN]);
    const first = await call(null, "POST", "/api/auth/login", { username: "owner", password: ADMIN_PASSWORD });
    assert.equal(first.json().twoFactorRequired, true);
    const second = await call(cookieNamed(first, "srtrend_2fa"), "POST", "/api/auth/2fa/login",
      { code: totpCode(secret, totpStepAt(Date.now())) });
    assert.equal(second.statusCode, 200, second.body);
    stepUpLimiter.reset(ADMIN);
  });

  await t.test("Platform ops with two-factor: a wrong code changes nothing; a grant halts and resumes; audit rows", async () => {
    await liveSafety.setTradingHalted(false);
    const wrong = await call(admin, "POST", "/api/ops/halt",
      { confirmation: "HALT_TRADING", reason: "ops grant", credential: { code: "000000" } });
    assert.deepEqual([wrong.statusCode, wrong.json().code], [400, "step_up_failed"]);
    assert.equal((await liveSafety.getRiskLimits()).tradingHalted, false);
    const password = await call(admin, "POST", "/api/ops/halt",
      { confirmation: "HALT_TRADING", reason: "ops grant", credential: { password: ADMIN_PASSWORD } });
    assert.deepEqual([password.statusCode, password.json().method], [400, "totp"], "with 2FA on, only the code");
    const grant = await mint();
    const halted = await call(jar(admin, grant), "POST", "/api/ops/halt", { confirmation: "HALT_TRADING", reason: "ops grant" });
    assert.equal(halted.statusCode, 200, halted.body);
    assert.equal((await liveSafety.getRiskLimits()).tradingHalted, true);
    const resumed = await call(jar(admin, grant), "POST", "/api/ops/resume", { confirmation: "RESUME_TRADING" });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal((await liveSafety.getRiskLimits()).tradingHalted, false);
    const limits = await call(admin, "PATCH", "/api/ops/risk-limits",
      { maxConcurrentPositions: 4, credential: { code: await freshCode() } });
    assert.equal(limits.statusCode, 200, limits.body);
    assert.equal(limits.json().maxConcurrentPositions, 4);
    const rows = (await listAdminAudit("platform.", 20)).reverse().map((r) => [r.action, r.detail.stepUpMethod ?? null]);
    const tail = rows.slice(-6);
    assert.deepEqual(tail, [
      ["platform.halt.requested", "grant"], ["platform.halt.succeeded", null],
      ["platform.resume.requested", "grant"], ["platform.resume.succeeded", null],
      ["platform.risk_limits.requested", "totp"], ["platform.risk_limits.succeeded", null],
    ]);
    const all = JSON.stringify(await listAdminAudit("platform.", 50));
    assert.ok(!all.includes(secret) && !/"credential"\s*:\s*\{/.test(all));
  });

  // ── every invalidation path ────────────────────────────────────────────────

  await t.test("plain sign-out revokes this browser's grant only", async () => {
    const mine = await mint();
    const other = await mint();
    const out = await call(jar(admin, mine), "POST", "/api/auth/logout");
    assert.equal(out.statusCode, 200);
    assert.match(rawSetCookie(out, "srtrend_stepup") ?? "", /Max-Age=0/);
    assert.equal((await status(jar(admin, mine))).grant.valid, false);
    assert.equal((await status(jar(admin, other))).grant.valid, true);
  });

  await t.test("recovery-code regeneration deletes every grant", async () => {
    const grant = await mint();
    const res = await call(jar(admin, grant), "POST", "/api/auth/2fa/recovery-codes", { code: await freshCode() });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await grantRows(ADMIN)).length, 0);
    assert.equal((await pauseBot(jar(admin, grant))).json().code, "step_up_required");
  });

  await t.test("sign out everywhere deletes every grant", async () => {
    const grant = await mint();
    assert.equal((await call(jar(admin, grant), "POST", "/api/auth/logout-all")).statusCode, 200);
    assert.equal((await grantRows(ADMIN)).length, 0);
    admin = await adminSignIn();
    assert.equal((await pauseBot(jar(admin, grant))).json().code, "step_up_required", "and a new session cannot reuse it");
  });

  await t.test("a session-version bump alone also ends a grant (compared at use)", async () => {
    const grant = await mint();
    await query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [ADMIN]);
    forgetUser(ADMIN);
    admin = await adminSignIn();
    assert.equal((await pauseBot(jar(admin, grant))).json().code, "step_up_required");
  });

  await t.test("a password change deletes every grant (ordinary account)", async () => {
    await query("UPDATE users SET email_verified_at = now() WHERE id = $1", [standardId]);
    forgetUser(standardId);
    const userSetup = await call(standard, "POST", "/api/auth/2fa/setup", { password: USER_PASSWORD });
    assert.equal(userSetup.statusCode, 200, userSetup.body);
    const userSecret = (userSetup.json() as { secret: string }).secret;
    const on = await call(standard, "POST", "/api/auth/2fa/enable", { code: totpCode(userSecret, totpStepAt(Date.now())) });
    assert.equal(on.statusCode, 200, on.body);
    standard = session(on)!;
    const handle = "h".repeat(43);
    assert.ok(await grantsRepo.mintGrant(standardId, sha256(handle), 300_000));
    assert.equal((await status(jar(standard, `srtrend_stepup=${handle}`))).grant.valid, true);
    const changed = await call(jar(standard, `srtrend_stepup=${handle}`), "POST", "/api/auth/password",
      { currentPassword: USER_PASSWORD, newPassword: "a brand new password" });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.match(rawSetCookie(changed, "srtrend_stepup") ?? "", /Max-Age=0/);
    assert.equal((await grantRows(standardId)).length, 0);
    standard = session(changed)!;
  });

  await t.test("a reclaim of an unverified account deletes the registrant's grants", async () => {
    const squatter = await users.createUser({ email: "reclaim@example.com", displayName: "s", passwordHash: hashPassword("pw pw pw pw") });
    await query("UPDATE users SET totp_enabled_at = now() WHERE id = $1", [squatter.id]);
    assert.ok(await grantsRepo.mintGrant(squatter.id, sha256("squatter-handle"), 300_000));
    const joined = await users.joinProviderByEmail(squatter.id,
      { kind: "google", providerId: "g-reclaim", email: "reclaim@example.com", avatarUrl: null });
    assert.equal(joined?.reclaimed, true);
    assert.equal((await grantRows(squatter.id)).length, 0);
  });

  await t.test("turning two-factor off deletes every grant and clears the cookie", async () => {
    const grant = await mint();
    const off = await call(jar(admin, grant), "POST", "/api/auth/2fa/disable", { password: ADMIN_PASSWORD, code: await freshCode() });
    assert.equal(off.statusCode, 200, off.body);
    assert.match(rawSetCookie(off, "srtrend_stepup") ?? "", /Max-Age=0/);
    assert.equal((await grantRows(ADMIN)).length, 0);
    admin = session(off)!;
    // Two-factor off: a grant could not be honoured even if a row survived.
    assert.equal((await pauseBot(jar(admin, grant))).json().code, "two_factor_required");
  });

  await t.test("OAuth-only account without two-factor: step_up_unavailable on Platform ops too", async () => {
    const provider = await users.createUser({ email: "oauth-only@example.com", displayName: "o", googleSub: "g-oauth-only", emailVerified: true });
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [provider.id]);
    forgetUser(provider.id);
    const cookie = `srtrend_session=${signUserSession(provider.id, provider.sessionVersion, config.sessionSecret)}`;
    const savedHash = config.adminPasswordHash;
    config.adminPasswordHash = "";
    try {
      const res = await call(cookie, "POST", "/api/ops/halt",
        { confirmation: "HALT_TRADING", reason: "no credential", credential: { password: "" } });
      assert.deepEqual([res.statusCode, res.json().code], [403, "step_up_unavailable"], res.body);
      assert.deepEqual(await status(cookie), { twoFactorEnabled: false, method: null, grant: { valid: false } });
    } finally {
      config.adminPasswordHash = savedHash;
      await query("UPDATE users SET role = 'user' WHERE id = $1", [provider.id]);
      forgetUser(provider.id);
    }
  });

  await t.test("reset-admin-2fa: clears two-factor, recovery codes and grants, ends sessions, audits with no actor", async () => {
    assert.equal(targetOf(["--admin"]), ADMIN);
    assert.equal(targetOf(["--", "--admin"]), ADMIN);
    assert.equal(targetOf([standardId.toUpperCase()]), standardId);
    assert.equal(targetOf([]), null);
    assert.equal(targetOf(["not-an-id"]), null);
    assert.equal(targetOf(["--admin", standardId]), null);
    // Two-factor back on for the admin, with a grant, then lost.
    const again = await call(admin, "POST", "/api/auth/2fa/setup", { password: ADMIN_PASSWORD });
    const secret2 = (again.json() as { secret: string }).secret;
    const on = await call(admin, "POST", "/api/auth/2fa/enable", { code: totpCode(secret2, totpStepAt(Date.now())) });
    assert.equal(on.statusCode, 200, on.body);
    admin = session(on)!;
    await query("UPDATE users SET totp_last_step = 0 WHERE id = $1", [ADMIN]);
    stepUpLimiter.reset(ADMIN);
    bot.reset();
    const minted = await close(admin, { code: totpCode(secret2, totpStepAt(Date.now())) });
    assert.equal(minted.statusCode, 200, minted.body);
    const before = await users.getUser(ADMIN);

    assert.deepEqual(await resetTwoFactor("00000000-0000-4000-8000-0000000000ff"), { found: false });
    const result = await resetTwoFactor(ADMIN);
    assert.deepEqual(result, { found: true, sessionVersion: before!.sessionVersion + 1 });
    const row = (await query<{ totp_secret_enc: string | null; totp_enabled_at: Date | null; totp_last_step: string }>(
      "SELECT totp_secret_enc, totp_enabled_at, totp_last_step FROM users WHERE id = $1", [ADMIN])).rows[0]!;
    assert.deepEqual([row.totp_secret_enc, row.totp_enabled_at, Number(row.totp_last_step)], [null, null, 0]);
    assert.equal((await query("SELECT 1 FROM totp_recovery_codes WHERE user_id = $1", [ADMIN])).rowCount, 0);
    assert.equal((await grantRows(ADMIN)).length, 0);
    forgetUser(ADMIN);
    assert.equal((await call(admin, "GET", "/api/watchlists")).statusCode, 401, "every session ended");
    const audit = (await listAdminAudit("auth.2fa.reset", 5))[0]!;
    assert.deepEqual([audit.actor, audit.target, audit.detail.by], [null, `user:${ADMIN}`, "server_script"]);
    assert.ok(!JSON.stringify(audit).includes(secret2));
  });
});
