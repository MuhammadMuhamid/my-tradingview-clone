/**
 * Bot controls through the real API, session gate and step-up, against a real
 * PostgreSQL and a fake Bot on 127.0.0.1 that authenticates every request the
 * way the Bot's `requireManualAuth` does (`support/fakeBot.ts`).
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_bot_control`;
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

const SECRET = "bot-control-db-test-secret-0123456789abcdef";
const BOT_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const TRADE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const MANUAL_TRADE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ADMIN_PASSWORD = "owner password";

let seq = 0;
const rid = (label = "req") => `${label}_${Date.now().toString(36)}_${(seq += 1).toString().padStart(6, "0")}`;

test("bot control", async (t) => {
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
  const { forgetUser, userMayReach } = await import("../src/security/requestUser");
  const { listAdminAudit } = await import("../src/repositories/adminAudit");
  const { resetBotControlStateForTests, setBotControlTimeoutsForTests } = await import("../src/api/routes/botControl");
  const { FakeBot } = await import("./support/fakeBot");
  after(() => closePool());
  await migrate();

  const bot = new FakeBot(SECRET);
  await bot.start();
  t.after(() => bot.stop());
  bot.bots.set(BOT_ID, { id: BOT_ID, name: "Trend bot", status: "active" });
  bot.manualTrades.add(MANUAL_TRADE_ID);

  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    emailFrom: config.emailFrom, publicBaseUrl: config.publicBaseUrl, adminUsername: config.adminUsername,
    adminPasswordHash: config.adminPasswordHash, githubClientId: config.githubClientId,
    githubClientSecret: config.githubClientSecret, manualTradingBotUrl: config.manualTradingBotUrl,
    manualTradingHmacSecret: config.manualTradingHmacSecret,
  };
  Object.assign(config, {
    authEnabled: true, sessionSecret: "bot-control-test-session-secret-0000000000", allowSignups: true,
    emailFrom: "no-reply@example.test", publicBaseUrl: "https://app.example.test",
    adminUsername: "owner", adminPasswordHash: hashPassword(ADMIN_PASSWORD),
    githubClientId: "id", githubClientSecret: "secret",
    manualTradingBotUrl: bot.url, manualTradingHmacSecret: SECRET,
  });
  t.after(() => { Object.assign(config, previous); useEmailTransportForTests(null); setBotControlTimeoutsForTests(null); });
  useEmailTransportForTests(async () => {});

  const app = buildServer(() => ({} as never));
  t.after(() => app.close());

  const cookiesOf = (res: { headers: Record<string, unknown> }) =>
    ([res.headers["set-cookie"]].flat().filter(Boolean) as string[]);
  const cookieNamed = (res: { headers: Record<string, unknown> }, name: string) => {
    const found = cookiesOf(res).map((c) => new RegExp(`^${name}=([^;]+)`).exec(c)?.[1]).find(Boolean);
    return found ? `${name}=${found}` : null;
  };
  const session = (res: { headers: Record<string, unknown> }) => cookieNamed(res, "srtrend_session");
  const call = (cookie: string | null, method: string, url: string, payload?: object, headers: Record<string, string> = {}) => {
    loginLimiter.reset("127.0.0.1");
    return app.inject({ method: method as "POST", url,
      headers: { ...headers, ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) });
  };

  const adminLogin = async () => {
    const res = await call(null, "POST", "/api/auth/login", { username: "owner", password: ADMIN_PASSWORD });
    assert.equal(res.statusCode, 200, res.body);
    return session(res)!;
  };
  let admin = await adminLogin();
  const signup = await call(null, "POST", "/api/auth/signup", { email: "standard@example.com", password: "correct horse battery" });
  assert.equal(signup.statusCode, 201, signup.body);
  let standard = session(signup)!;

  const ROUTES: [string, string][] = [
    ["GET", "/api/bot/control/status"],
    ["GET", "/api/bot/control/risk-limits"],
    ["GET", "/api/bot/control/commands/req_0123456789abcdef"],
    ["POST", "/api/bot/control/halt"],
    ["POST", "/api/bot/control/resume"],
    ["PATCH", "/api/bot/control/risk-limits"],
    ["POST", `/api/bot/control/bots/${BOT_ID}/status`],
    ["POST", `/api/bot/control/trades/${TRADE_ID}/close`],
    ["POST", `/api/bot/control/trades/${TRADE_ID}/partial-close`],
  ];
  const halt = (credential: Record<string, string> | undefined, requestId = rid("halt")) => ({
    requestId, confirmation: "HALT_TRADING", reason: "unit test halt", ...(credential ? { credential } : {}),
  });
  const commandsSent = () => bot.commandRequests().length;
  const auditFor = async (requestId: string) =>
    (await listAdminAudit("bot.", 500)).filter((row) => row.detail.requestId === requestId).reverse();

  await t.test("nobody signed in gets 401 and a Standard account 403, on every control route", async () => {
    bot.reset();
    for (const [method, url] of ROUTES) {
      assert.equal((await call(null, method, url, method === "GET" ? undefined : halt({ password: ADMIN_PASSWORD }))).statusCode,
        401, `${method} ${url}`);
      assert.equal((await call(standard, method, url, method === "GET" ? undefined : halt({ password: "correct horse battery" }))).statusCode,
        403, `${method} ${url}`);
      assert.equal(userMayReach(method, url), false, `${method} ${url} is not on the ordinary account's list`);
    }
    assert.equal(bot.requests.length, 0, "the Bot was never contacted");
  });

  await t.test("with AUTH_ENABLED=false every mutating command is refused; reads still work", async () => {
    bot.reset();
    config.authEnabled = false;
    try {
      for (const [method, url] of ROUTES.filter(([m]) => m !== "GET")) {
        const res = await call(null, method, url, { ...halt({ password: ADMIN_PASSWORD }), status: "paused", pct: 10 });
        assert.equal(res.statusCode, 403, `${method} ${url}`);
        assert.equal(res.json().code, "auth_disabled");
      }
      assert.equal(commandsSent(), 0);
      assert.equal((await call(null, "GET", "/api/bot/control/status")).statusCode, 200);
      assert.equal((await call(null, "GET", "/api/bot/control/risk-limits")).statusCode, 200);
    } finally {
      config.authEnabled = true;
    }
  });

  await t.test("2FA off: halt by password is allowed; the Bot gets the actor and never the credential", async () => {
    bot.reset();
    const requestId = rid("halt");
    const res = await call(admin, "POST", "/api/bot/control/halt", halt({ password: ADMIN_PASSWORD }, requestId));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, "succeeded");
    assert.equal(res.json().result.halted, true);
    const sent = bot.commandRequests();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.verified, true);
    assert.equal(sent[0]!.requestId, requestId, "the browser's id is forwarded, never replaced");
    const body = sent[0]!.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["actor", "confirmation", "reason"]);
    const actor = body.actor as { platformUserId: string; stepUp: { method: string; at: string } };
    assert.equal(actor.platformUserId, ADMIN_USER_ID);
    assert.equal(actor.stepUp.method, "password");
    assert.ok(!Number.isNaN(Date.parse(actor.stepUp.at)));
    assert.ok(!sent[0]!.raw.includes(ADMIN_PASSWORD) && !sent[0]!.raw.includes("credential"));

    const rows = await auditFor(requestId);
    assert.deepEqual(rows.map((r) => r.action), ["bot.halt.requested", "bot.halt.succeeded"]);
    assert.equal(rows[0]!.actor, ADMIN_USER_ID);
    assert.equal(rows[0]!.detail.stepUpMethod, "password");
    assert.equal(rows[0]!.target, "bot");
    assert.ok(rows.every((r) => !JSON.stringify(r).includes(ADMIN_PASSWORD)));
  });

  await t.test("step-up: missing, wrong and too many attempts never reach the Bot", async () => {
    bot.reset();
    stepUpLimiter.reset(ADMIN_USER_ID);
    const missing = await call(admin, "POST", "/api/bot/control/halt", halt(undefined));
    assert.equal(missing.statusCode, 400);
    assert.deepEqual([missing.json().code, missing.json().method], ["step_up_required", "password"]);
    const wrong = await call(admin, "POST", "/api/bot/control/halt", halt({ password: "not it" }));
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().code, "step_up_failed");
    for (let i = 0; i < 4; i += 1) await call(admin, "POST", "/api/bot/control/halt", halt({ password: "not it" }));
    const limited = await call(admin, "POST", "/api/bot/control/halt", halt({ password: ADMIN_PASSWORD }));
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, "step_up_rate_limited");
    assert.ok(Number(limited.headers["retry-after"]) > 0);
    assert.equal(commandsSent(), 0);
    stepUpLimiter.reset(ADMIN_USER_ID);
  });

  await t.test("2FA off: every money-moving command is two_factor_required, with no Bot call and no audit", async () => {
    bot.reset();
    const before = (await listAdminAudit("bot.", 500)).length;
    const cases: [string, string, object][] = [
      ["POST", "/api/bot/control/resume", { confirmation: "RESUME_TRADING" }],
      ["PATCH", "/api/bot/control/risk-limits", { maxConcurrentTrades: 2 }],
      ["POST", `/api/bot/control/bots/${BOT_ID}/status`, { status: "paused" }],
      ["POST", `/api/bot/control/trades/${TRADE_ID}/close`, {}],
      ["POST", `/api/bot/control/trades/${TRADE_ID}/partial-close`, { pct: 25 }],
    ];
    for (const [method, url, extra] of cases) {
      const res = await call(admin, method, url, { requestId: rid(), credential: { password: ADMIN_PASSWORD }, ...extra });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.equal(res.json().code, "two_factor_required");
    }
    assert.equal(commandsSent(), 0);
    assert.equal((await listAdminAudit("bot.", 500)).length, before);
  });

  await t.test("F7: a missing or malformed request id is 400 and nothing is sent", async () => {
    bot.reset();
    const bad = [undefined, "short_id_15char", "has spaces in it!!", "x".repeat(129), 1234567890123456];
    for (const requestId of bad) {
      const res = await call(admin, "POST", "/api/bot/control/halt",
        { ...halt({ password: ADMIN_PASSWORD }), requestId });
      assert.equal(res.statusCode, 400, String(requestId));
      assert.equal(res.json().code, "invalid_request_id");
    }
    const mismatch = await call(admin, "POST", "/api/bot/control/halt", halt({ password: ADMIN_PASSWORD }, rid()),
      { "x-manual-request-id": rid("other") });
    assert.equal(mismatch.json().code, "invalid_request_id");
    assert.equal((await call(admin, "GET", "/api/bot/control/commands/bad%20id")).json().code, "invalid_request_id");
    assert.equal(commandsSent(), 0);
    assert.equal(bot.requests.length, 0);
  });

  await t.test("F5: a path id that is not a UUID is 400 and nothing is sent", async () => {
    bot.reset();
    for (const id of ["not-a-uuid", "..%2F..%2Forders", `${TRADE_ID}x`, "%20"]) {
      const res = await call(admin, "POST", `/api/bot/control/trades/${id}/close`, { requestId: rid(), credential: { code: "123456" } });
      assert.equal(res.statusCode, 400, id);
      // An encoded slash is refused earlier, by the session gate's path
      // canonicalisation (G1), with its own 400; either way nothing is sent.
      if (id.includes("%2F")) assert.equal(res.json().error, "malformed request path", id);
      else assert.equal(res.json().code, "invalid_target_id", id);
    }
    // A dot-segment id is not even routed to the handler.
    const dots = await call(admin, "POST", "/api/bot/control/trades/%2e%2e/close", { requestId: rid(), credential: { code: "123456" } });
    assert.equal(dots.statusCode, 404);
    const botRes = await call(admin, "POST", "/api/bot/control/bots/1%3B2/status", { requestId: rid(), status: "paused" });
    assert.equal(botRes.json().code, "invalid_target_id");
    assert.equal(bot.requests.length, 0);
  });

  // ── two-factor on ──────────────────────────────────────────────────────────
  const setup = await call(admin, "POST", "/api/auth/2fa/setup", { password: ADMIN_PASSWORD });
  assert.equal(setup.statusCode, 200, setup.body);
  const secret = (setup.json() as { secret: string }).secret;
  const enabled = await call(admin, "POST", "/api/auth/2fa/enable", { code: totpCode(secret, totpStepAt(Date.now())) });
  assert.equal(enabled.statusCode, 200, enabled.body);
  // OD-2: turning two-factor on ends every other session and re-issues this one.
  admin = session(enabled)!;
  /** A code that will be accepted once: the last-used step is reset so tests need not wait 30 s. */
  const freshCode = async () => {
    await query("UPDATE users SET totp_last_step = 0 WHERE id = $1", [ADMIN_USER_ID]);
    stepUpLimiter.reset(ADMIN_USER_ID);
    return totpCode(secret, totpStepAt(Date.now()));
  };

  await t.test("F1: enabling two-factor is recorded in admin_audit", async () => {
    const rows = await listAdminAudit("auth.2fa.", 50);
    assert.deepEqual(rows.map((r) => r.action).reverse(), ["auth.2fa.setup_started", "auth.2fa.enabled"]);
    assert.ok(rows.every((r) => r.actor === ADMIN_USER_ID && r.target === `user:${ADMIN_USER_ID}`));
    assert.ok(rows.every((r) => !JSON.stringify(r.detail).includes(secret)));
  });

  await t.test("F1 rows name administrators only, so an ordinary account stays deletable", async () => {
    await query("UPDATE users SET email_verified_at = now() WHERE email = 'standard@example.com'");
    const me = (await call(standard, "GET", "/api/auth/me")).json().user as { id: string };
    forgetUser(me.id);
    const userSetup = await call(standard, "POST", "/api/auth/2fa/setup", { password: "correct horse battery" });
    assert.equal(userSetup.statusCode, 200, userSetup.body);
    const userSecret = (userSetup.json() as { secret: string }).secret;
    const on = await call(standard, "POST", "/api/auth/2fa/enable", { code: totpCode(userSecret, totpStepAt(Date.now())) });
    assert.equal(on.statusCode, 200, on.body);
    standard = session(on)!;
    assert.equal((await listAdminAudit("auth.2fa.", 50)).filter((r) => r.target === `user:${me.id}`).length, 0);
    // admin_audit.actor is ON DELETE SET NULL under an append-only trigger: a row naming
    // this account would turn the delete below into a 500.
    const gone = await call(standard, "DELETE", "/api/auth/account", { confirm: "DELETE" });
    assert.equal(gone.statusCode, 200, gone.body);
  });

  await t.test("2FA on: a code confirms; the same code again is refused; a password is not accepted", async () => {
    bot.reset();
    const code = await freshCode();
    const first = await call(admin, "POST", `/api/bot/control/trades/${TRADE_ID}/close`, { requestId: rid("close"), credential: { code } });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json().result, { status: "ok", detail: "closed" });
    const actor = (bot.commandRequests()[0]!.body as { actor: { stepUp: { method: string } } }).actor;
    assert.equal(actor.stepUp.method, "totp");
    assert.ok(!bot.commandRequests()[0]!.raw.includes(code));

    const replayed = await call(admin, "POST", `/api/bot/control/trades/${TRADE_ID}/close`, { requestId: rid("close"), credential: { code } });
    assert.equal(replayed.statusCode, 400);
    assert.equal(replayed.json().code, "step_up_failed");

    const password = await call(admin, "POST", "/api/bot/control/halt", halt({ password: ADMIN_PASSWORD }));
    assert.equal(password.statusCode, 400);
    assert.deepEqual([password.json().code, password.json().method], ["step_up_required", "totp"]);
    assert.equal(commandsSent(), 1);
  });

  await t.test("each command's body is rebuilt from validated fields", async () => {
    bot.reset();
    let res = await call(admin, "PATCH", "/api/bot/control/risk-limits", {
      requestId: rid("risk"), credential: { code: await freshCode() },
      maxDailyLossQuote: null, dailyLossWindowHours: 48, extra: "dropped", actor: { platformUserId: "forged" },
    });
    assert.equal(res.statusCode, 200, res.body);
    let body = bot.commandRequests()[0]!.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["actor", "dailyLossWindowHours", "maxDailyLossQuote"]);
    assert.equal((body.actor as { platformUserId: string }).platformUserId, ADMIN_USER_ID, "a body cannot name the actor");

    for (const bad of [{ dailyLossWindowHours: 0 }, { dailyLossWindowHours: 721 }, { maxConcurrentTrades: 1.5 },
      { maxTotalExposureQuote: -1 }, { maxDailyLossQuote: "10" }, {}]) {
      const refused = await call(admin, "PATCH", "/api/bot/control/risk-limits", { requestId: rid(), credential: { code: "000000" }, ...bad });
      assert.equal(refused.statusCode, 400, JSON.stringify(bad));
      assert.equal(refused.json().code, "invalid_request");
    }

    res = await call(admin, "POST", `/api/bot/control/bots/${BOT_ID}/status`, { requestId: rid("bot"), credential: { code: await freshCode() }, status: "paused" });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual([res.json().result.status, res.json().result.changed], ["paused", true]);
    res = await call(admin, "POST", `/api/bot/control/bots/${BOT_ID}/status`, { requestId: rid("bot"), credential: { code: await freshCode() }, status: "active" });
    assert.equal(res.json().result.unresolvedIntents, 2, "a start reports the unresolved intents it releases");

    res = await call(admin, "POST", `/api/bot/control/trades/${TRADE_ID}/partial-close`, { requestId: rid("pc"), credential: { code: await freshCode() }, pct: 25 });
    assert.equal(res.statusCode, 200, res.body);
    body = bot.commandRequests().at(-1)!.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["actor", "pct"]);
    for (const pct of [0, 100, 12.5, "25"]) {
      const refused = await call(admin, "POST", `/api/bot/control/trades/${TRADE_ID}/partial-close`, { requestId: rid(), credential: { code: "000000" }, pct });
      assert.equal(refused.json().code, "invalid_request", String(pct));
    }
  });

  await t.test("OAuth: an administrator who signed in with GitHub steps up with the code, the same way", async () => {
    bot.reset();
    const realFetch = globalThis.fetch;
    let identity = { id: 500, email: "owner-gh@example.com" };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("login/oauth/access_token")) return Response.json({ access_token: "t" });
      if (u.endsWith("api.github.com/user")) return Response.json({ id: identity.id, login: "octo" });
      if (u.endsWith("/user/emails")) return Response.json([{ email: identity.email, primary: true, verified: true }]);
      return realFetch(url, init);
    }) as typeof fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const github = async (cookie: string | null, mode = "") => {
      const start = await call(cookie, "GET", `/api/auth/github/start?next=/bot${mode ? `&mode=${mode}` : ""}`);
      assert.equal(start.statusCode, 302, start.body);
      const state = new URL(start.headers.location as string).searchParams.get("state")!;
      const oauth = cookieNamed(start, "srtrend_oauth")!;
      // Link mode is bound to the signed-in session that started it (A1), so
      // the callback carries that session cookie too, as a browser would.
      const jar = mode === "link" && cookie ? `${cookie}; ${oauth}` : oauth;
      return call(jar, "GET", `/api/auth/github/callback?code=c&state=${state}`);
    };

    // The administrator links GitHub from a signed-in session, then signs in with it.
    const linked = await github(admin, "link");
    assert.equal(linked.statusCode, 302, linked.body);
    assert.doesNotMatch(String(linked.headers.location), /error=/, "the link succeeded");
    const signIn = await github(null);
    assert.match(signIn.headers.location as string, /^\/login\?step=2fa/, "two-factor is still asked for");
    const pending = cookieNamed(signIn, "srtrend_2fa");
    const done = await call(pending, "POST", "/api/auth/2fa/login", { code: await freshCode() });
    assert.equal(done.statusCode, 200, done.body);
    const oauthSession = session(done)!;
    const history = (await call(oauthSession, "GET", "/api/auth/login-history")).json().logins as { method: string }[];
    assert.equal(history[0]!.method, "github", "this session came from GitHub");

    const res = await call(oauthSession, "POST", "/api/bot/control/halt", halt({ code: await freshCode() }));
    assert.equal(res.statusCode, 200, res.body);
    const actor = (bot.commandRequests()[0]!.body as { actor: { platformUserId: string; stepUp: { method: string } } }).actor;
    assert.deepEqual([actor.platformUserId, actor.stepUp.method], [ADMIN_USER_ID, "totp"]);

    // An account that only ever signed in with GitHub: no password, no two-factor.
    identity = { id: 501, email: "oauth-only@example.com" };
    const created = await github(null);
    const oauthOnly = session(created)!;
    const id = (await call(oauthOnly, "GET", "/api/auth/me")).json().user.id as string;
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [id]);
    forgetUser(id);
    const savedHash = config.adminPasswordHash;
    config.adminPasswordHash = "";
    try {
      for (const [method, url, extra] of [
        ["POST", "/api/bot/control/halt", { confirmation: "HALT_TRADING", reason: "no way to confirm" }],
        ["POST", "/api/bot/control/resume", { confirmation: "RESUME_TRADING" }],
      ] as [string, string, object][]) {
        const refused = await call(oauthOnly, method, url, { requestId: rid(), credential: { password: "" }, ...extra });
        assert.equal(refused.statusCode, 403, `${url}: ${refused.body}`);
        assert.equal(refused.json().code, "step_up_unavailable", "never a bypass");
      }
    } finally {
      config.adminPasswordHash = savedHash;
    }
    assert.equal(bot.commandRequests().length, 1);
  });

  await t.test("a double-click (one request id, twice) is one Bot command and one answer", async () => {
    bot.reset();
    resetBotControlStateForTests();
    const requestId = rid("dbl");
    const payload = { requestId, credential: { code: await freshCode() }, status: "paused" };
    const [a, b] = await Promise.all([
      call(admin, "POST", `/api/bot/control/bots/${BOT_ID}/status`, payload),
      call(admin, "POST", `/api/bot/control/bots/${BOT_ID}/status`, payload),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode], [200, 200], `${a.body} ${b.body}`);
    assert.equal(commandsSent(), 1, "the Bot saw one request");
    assert.equal(bot.executions, 1);
    assert.deepEqual(a.json().result, b.json().result);
    assert.equal([a.json().replayed, b.json().replayed].filter(Boolean).length, 1);

    const again = await call(admin, "POST", `/api/bot/control/bots/${BOT_ID}/status`, payload);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().replayed, true);
    assert.equal(commandsSent(), 1, "a late repeat is answered from the first result");

    const different = await call(admin, "POST", `/api/bot/control/bots/${BOT_ID}/status`, { ...payload, status: "active" });
    assert.equal(different.statusCode, 409);
    assert.equal(different.json().code, "request_id_reused");
    assert.equal((await auditFor(requestId)).length, 2, "requested + succeeded, once");
  });

  await t.test("only the Bot's own definitive answers are replayed: a wrong code, then the right one, same id", async () => {
    bot.reset();
    resetBotControlStateForTests();
    const requestId = rid("retry");
    stepUpLimiter.reset(ADMIN_USER_ID);
    const wrong = await call(admin, "POST", "/api/bot/control/halt", halt({ code: "000000" }, requestId));
    assert.equal(wrong.json().code, "step_up_failed");
    const right = await call(admin, "POST", "/api/bot/control/halt", halt({ code: await freshCode() }, requestId));
    assert.equal(right.statusCode, 200, right.body);
    assert.equal(right.json().replayed, undefined, "the refusal was this Platform's, so it was not replayed");
    assert.equal(commandsSent(), 1);

    // A channel refusal is not replayed either: the Bot never ran it, a retry must reach it.
    const channelId = rid("chan");
    bot.replies.push({ status: 403, raw: "", skipExecution: true });
    const refused = await call(admin, "POST", "/api/bot/control/halt", halt({ code: await freshCode() }, channelId));
    assert.equal(refused.json().code, "bot_channel_rejected");
    const retried = await call(admin, "POST", "/api/bot/control/halt", halt({ code: await freshCode() }, channelId));
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json().replayed, undefined);
  });

  await t.test("a Bot business refusal passes through with its code and words", async () => {
    bot.reset();
    const res = await call(admin, "POST", `/api/bot/control/trades/${MANUAL_TRADE_ID}/close`,
      { requestId: rid("manual"), credential: { code: await freshCode() } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, "trade_manual");
    assert.match(res.json().error, /Trade panel/);
    const rows = await auditFor(bot.commandRequests()[0]!.requestId!);
    assert.deepEqual(rows.map((r) => r.action), ["bot.trade_close.requested", "bot.trade_close.refused"]);
    assert.equal(rows[1]!.detail.code, "trade_manual");
  });

  await t.test("F8 error mapping, row by row", async () => {
    resetBotControlStateForTests();
    const run = async (reply: Parameters<typeof bot.replies.push>[0] | null, path = "/api/bot/control/halt",
      extra: object = { confirmation: "HALT_TRADING", reason: "mapping" }) => {
      bot.reset();
      if (reply) bot.replies.push(reply);
      const requestId = rid("map");
      const res = await call(admin, path.includes("risk") ? "PATCH" : "POST", path,
        { requestId, credential: { code: await freshCode() }, ...extra });
      return { res, requestId, body: res.json() as Record<string, unknown> };
    };

    let r = await run({ status: 403, raw: "", skipExecution: true });
    assert.deepEqual([r.res.statusCode, r.body.code, r.body.cause], [502, "bot_channel_rejected", "proxy"]);
    assert.deepEqual((await auditFor(r.requestId)).map((x) => x.action), ["bot.halt.requested", "bot.halt.refused"]);

    r = await run({ status: 409, json: { error: "used", code: "nonce_replay" }, skipExecution: true });
    assert.deepEqual([r.res.statusCode, r.body.code, r.body.cause], [502, "bot_channel_rejected", "replay"]);

    r = await run({ status: 429, json: { error: "slow", code: "bot_rate_limited" }, skipExecution: true });
    assert.deepEqual([r.res.statusCode, r.body.code], [503, "bot_rate_limited"]);

    r = await run({ status: 503, json: { error: "unset", code: "channel_not_configured" }, skipExecution: true });
    assert.deepEqual([r.res.statusCode, r.body.code], [503, "bot_channel_not_configured"]);

    r = await run({ status: 409, json: { error: "The daily loss is still at its limit.", code: "still_breached" }, skipExecution: true },
      "/api/bot/control/resume", { confirmation: "RESUME_TRADING" });
    assert.deepEqual([r.res.statusCode, r.body.code, r.body.error], [409, "still_breached", "The daily loss is still at its limit."]);

    // `command_in_progress` is "still running": uncertain, audited so, and never replayed from here.
    r = await run({ status: 409, json: { error: "Still being processed.", code: "command_in_progress" }, skipExecution: true });
    assert.deepEqual([r.res.statusCode, r.body.status, r.body.requestId, r.body.code],
      [202, "uncertain", r.requestId, "command_in_progress"]);
    assert.deepEqual((await auditFor(r.requestId)).map((x) => x.action), ["bot.halt.requested", "bot.halt.uncertain"]);
    const sameId = await call(admin, "POST", "/api/bot/control/halt", halt({ code: await freshCode() }, r.requestId));
    assert.equal(sameId.statusCode, 200, sameId.body);
    assert.equal(sameId.json().replayed, undefined, "not answered from the Platform's cache");
    assert.equal(commandsSent(), 2, "the same id went back to the Bot");

    // `request_id_reused` is about the id: passed on, but a corrected retry still reaches the Bot.
    r = await run({ status: 409, json: { error: "Reused.", code: "request_id_reused" }, skipExecution: true });
    assert.deepEqual([r.res.statusCode, r.body.code], [409, "request_id_reused"]);
    const retry = await call(admin, "POST", "/api/bot/control/halt", halt({ code: await freshCode() }, r.requestId));
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().replayed, undefined);

    // Everything below may have run on the Bot: uncertain, never a failure.
    for (const reply of [
      { status: 429, json: { error: "slow" } },
      { status: 502, raw: "<html>Bad gateway</html>" },
      { status: 500, json: { error: "Internal server error", code: "internal_error" } },
      { status: 200, raw: "ok" },
      { status: 200, json: { done: true } },
      { status: 400, json: { error: "no code" } },
      { destroy: true },
    ]) {
      r = await run(reply);
      assert.deepEqual([r.res.statusCode, r.body.status, r.body.requestId], [202, "uncertain", r.requestId], JSON.stringify(reply));
      assert.deepEqual((await auditFor(r.requestId)).map((x) => x.action), ["bot.halt.requested", "bot.halt.uncertain"]);
    }

    // A pending exchange order is the Bot's answer, and still not a success.
    r = await run({ status: 202, json: { status: "pending", intentId: "intent-1", detail: "reconciling" } },
      `/api/bot/control/trades/${TRADE_ID}/close`, {});
    assert.deepEqual([r.res.statusCode, r.body.status], [202, "pending"]);

    // A timeout: the Bot ran it, the answer never came. C8 then knows.
    setBotControlTimeoutsForTests({ defaultMs: 150, longMs: 150 });
    r = await run({ delayMs: 600 });
    setBotControlTimeoutsForTests(null);
    assert.deepEqual([r.res.statusCode, r.body.status], [202, "uncertain"]);
    const c8 = await call(admin, "GET", `/api/bot/control/commands/${r.requestId}`);
    assert.equal(c8.statusCode, 200, c8.body);
    assert.equal(c8.json().status, "succeeded");
    assert.equal(c8.json().kind, "halt");

    // Any other coded 404 from C8 is not "no such command": it is relayed as itself.
    bot.replies.push({ status: 404, json: { error: "Record not found.", code: "not_found" } });
    const other = await call(admin, "GET", `/api/bot/control/commands/${rid("other404")}`);
    assert.deepEqual([other.statusCode, other.json().code], [404, "not_found"]);

    // Never sent: C8 says so, and only C8 may.
    const unknown = await call(admin, "GET", `/api/bot/control/commands/${rid("never")}`);
    assert.deepEqual([unknown.statusCode, unknown.json().code], [404, "command_not_found"]);

    // The Bot down: a command is uncertain, a read is plainly unreachable.
    config.manualTradingBotUrl = "http://127.0.0.1:9";
    try {
      r = await run(null);
      assert.deepEqual([r.res.statusCode, r.body.status], [202, "uncertain"]);
      const read = await call(admin, "GET", "/api/bot/control/risk-limits");
      assert.deepEqual([read.statusCode, read.json().code], [502, "bot_unreachable"]);
      const status = await call(admin, "GET", "/api/bot/control/status");
      assert.equal(status.statusCode, 200);
      assert.deepEqual(status.json().signed, { state: "UNREACHABLE", cause: null });
      assert.deepEqual(status.json().channel, { configured: true });
    } finally {
      config.manualTradingBotUrl = bot.url;
    }

    // A key the Bot does not share: the channel is refused.
    config.manualTradingHmacSecret = "a-different-secret-0123456789abcdef0123";
    try {
      r = await run(null);
      assert.deepEqual([r.res.statusCode, r.body.code, r.body.cause], [502, "bot_channel_rejected", "auth"]);
    } finally {
      config.manualTradingHmacSecret = SECRET;
    }

    // No control key on this Platform: refused before step-up, so the code is not spent.
    config.manualTradingHmacSecret = "";
    try {
      bot.reset();
      const code = await freshCode();
      const res = await call(admin, "POST", "/api/bot/control/halt", halt({ code }));
      assert.deepEqual([res.statusCode, res.json().code], [503, "bot_channel_not_configured"]);
      config.manualTradingHmacSecret = SECRET;
      stepUpLimiter.reset(ADMIN_USER_ID);
      const sameCode = await call(admin, "POST", "/api/bot/control/halt", halt({ code }));
      assert.equal(sameCode.statusCode, 200, "the code was still unused");
    } finally {
      config.manualTradingHmacSecret = SECRET;
    }
  });

  await t.test("the status read carries the separate statuses and the Platform's own halt", async () => {
    bot.reset();
    bot.halted = true;
    const res = await call(admin, "GET", "/api/bot/control/status");
    assert.equal(res.statusCode, 200, res.body);
    const panel = res.json();
    assert.deepEqual(panel.channel, { configured: true });
    assert.deepEqual(panel.signed, { state: "CONNECTED", cause: null });
    assert.equal(panel.webhook.state, "NOT_CONFIGURED");
    assert.equal(panel.facts.halt.halted, true);
    assert.equal(panel.facts.dryRun, true);
    assert.deepEqual(panel.platformHalt, { halted: false, haltedBy: null, haltedReason: null });
    const ops = await call(admin, "GET", "/api/ops/status");
    assert.equal(ops.statusCode, 200, ops.body);
    assert.equal(ops.json().bot.state, "CONNECTED", "Operations no longer says NOT CONFIGURED");
    assert.deepEqual(ops.json().botControl.signed, { state: "CONNECTED", cause: null });
  });

  await t.test("no audit row anywhere carries a credential", async () => {
    const rows = await listAdminAudit("", 1000);
    const text = JSON.stringify(rows);
    assert.ok(!text.includes(ADMIN_PASSWORD));
    assert.ok(!text.includes(secret));
    assert.ok(!/"credential"\s*:\s*\{/.test(text));
    assert.ok(rows.some((r) => r.action === "bot.halt.requested"));
  });

  await t.test("F1: turning two-factor off is recorded", async () => {
    const off = await call(admin, "POST", "/api/auth/2fa/disable", { password: ADMIN_PASSWORD, code: await freshCode() });
    assert.equal(off.statusCode, 200, off.body);
    const rows = await listAdminAudit("auth.2fa.disabled", 5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.actor, ADMIN_USER_ID);
  });
});
