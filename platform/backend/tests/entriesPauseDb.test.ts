/**
 * Pause new entries (owner decision OD-3), the Platform half and the one
 * operator action that sets both halves, through the real API, session gate
 * and step-up against a real PostgreSQL and the fake Bot's C9.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_entries_pause`;
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

const SECRET = "entries-pause-db-test-secret-0123456789abcd";
const ADMIN_PASSWORD = "owner password";
let seq = 0;
const rid = (label = "ent") => `${label}_${Date.now().toString(36)}_${(seq += 1).toString().padStart(6, "0")}`;

test("pause new entries", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { buildServer } = await import("../src/api/server");
  const { loginLimiter, stepUpLimiter } = await import("../src/security/rateLimit");
  const { totpCode, totpStepAt } = await import("../src/security/twoFactor");
  const { hashPassword } = await import("../src/security/session");
  const { ADMIN_USER_ID } = await import("../src/repositories/users");
  const { listAdminAudit } = await import("../src/repositories/adminAudit");
  const liveSafety = await import("../src/repositories/liveSafety");
  const { evaluateRisk } = await import("../src/engine/riskControls");
  const { isBotControlStatus, botHasCapability } = await import("../src/operations/botStatus");
  const { manualTradingRoutes } = await import("../src/api/routes/manualTrading");
  const { deploymentRoutes } = await import("../src/api/routes/deployments");
  const { resetBotControlStateForTests } = await import("../src/api/routes/botControl");
  const { FakeBot, controlStatus } = await import("./support/fakeBot");
  const Fastify = (await import("fastify")).default;
  after(() => closePool());
  await migrate();

  const bot = new FakeBot(SECRET);
  await bot.start();
  t.after(() => bot.stop());

  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    adminUsername: config.adminUsername, adminPasswordHash: config.adminPasswordHash,
    manualTradingBotUrl: config.manualTradingBotUrl, manualTradingHmacSecret: config.manualTradingHmacSecret,
    manualTradingEnabled: config.manualTradingEnabled, liveTestEnabled: config.liveTestEnabled, emailFrom: config.emailFrom,
  };
  Object.assign(config, {
    authEnabled: true, sessionSecret: "entries-pause-test-session-secret-0000000000", allowSignups: true,
    adminUsername: "owner", adminPasswordHash: hashPassword(ADMIN_PASSWORD), emailFrom: "",
    manualTradingBotUrl: bot.url, manualTradingHmacSecret: SECRET,
  });
  t.after(() => Object.assign(config, previous));

  const app = buildServer(() => ({} as never));
  t.after(() => app.close());
  type Res = { headers: Record<string, unknown> };
  const session = (res: Res) => {
    const found = ([res.headers["set-cookie"]].flat().filter(Boolean) as string[])
      .map((c) => /^srtrend_session=([^;]+)/.exec(c)?.[1]).find(Boolean);
    return found ? `srtrend_session=${found}` : null;
  };
  const call = (cookie: string | null, method: string, url: string, payload?: object) => {
    loginLimiter.reset("127.0.0.1");
    return app.inject({ method: method as "POST", url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
  };
  let admin = session(await call(null, "POST", "/api/auth/login", { username: "owner", password: ADMIN_PASSWORD }))!;
  const signup = await call(null, "POST", "/api/auth/signup", { email: "standard@example.com", password: "correct horse battery" });
  const standard = session(signup)!;
  const pause = (credential?: object, extra: object = {}, requestId = rid("pause")) => ({
    requestId, paused: true, reason: "news risk", ...(credential ? { credential } : {}), ...extra });
  const entries = (cookie: string | null, body: object) => call(cookie, "POST", "/api/bot/control/entries", body);
  const platformState = async () => (await liveSafety.getRiskLimits()).entriesPaused;

  await t.test("nobody 401, a Standard account 403, AUTH_ENABLED=false refused, F7 request id required", async () => {
    bot.reset();
    assert.equal((await entries(null, pause({ password: ADMIN_PASSWORD }))).statusCode, 401);
    assert.equal((await entries(standard, pause({ password: "correct horse battery" }))).statusCode, 403);
    config.authEnabled = false;
    try {
      const off = await entries(null, pause({ password: ADMIN_PASSWORD }));
      assert.deepEqual([off.statusCode, off.json().code], [403, "auth_disabled"]);
    } finally { config.authEnabled = true; }
    for (const requestId of [undefined, "short"]) {
      const res = await entries(admin, { ...pause({ password: ADMIN_PASSWORD }), requestId });
      assert.deepEqual([res.statusCode, res.json().code], [400, "invalid_request_id"]);
    }
    assert.equal(await platformState(), false);
    assert.equal(bot.requests.length, 0);
  });

  await t.test("body validation: reason when pausing, booleans only, nothing extra reaches the Bot", async () => {
    bot.reset();
    for (const bad of [{ paused: "yes" }, { paused: true, reason: "x" }, { paused: true, reason: "y".repeat(201) },
      { paused: true, reason: "fine reason", cancelWorkingEntries: "true" }, { paused: false, cancelWorkingEntries: true }]) {
      const res = await entries(admin, { requestId: rid(), credential: { password: ADMIN_PASSWORD }, ...bad });
      assert.deepEqual([res.statusCode, res.json().code], [400, "invalid_request"], JSON.stringify(bad));
    }
    assert.equal(bot.requests.length, 0);
    assert.equal(await platformState(), false);
  });

  await t.test("2FA off: pausing takes the password and sets both halves; audited; the Bot gets only validated fields", async () => {
    bot.reset();
    resetBotControlStateForTests();
    const requestId = rid("pause");
    const res = await entries(admin, pause({ password: ADMIN_PASSWORD }, { actor: { platformUserId: "forged" } }, requestId));
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { platform: Record<string, unknown>; bot: Record<string, unknown> };
    assert.deepEqual([body.platform.paused, body.platform.changed, body.platform.reason, body.platform.by],
      [true, true, "news risk", ADMIN_USER_ID]);
    assert.ok(typeof body.platform.at === "string");
    assert.deepEqual([body.bot.httpStatus, body.bot.status, body.bot.requestId], [200, "succeeded", requestId]);
    assert.deepEqual((body.bot.result as { entries: { paused: boolean } }).entries.paused, true);
    assert.equal(await platformState(), true);
    const sent = bot.commandRequests();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.path, "/api/manual-trading/control/entries");
    const sentBody = sent[0]!.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(sentBody).sort(), ["actor", "paused", "reason"]);
    assert.equal((sentBody.actor as { platformUserId: string; stepUp: { method: string } }).platformUserId, ADMIN_USER_ID);
    assert.equal((sentBody.actor as { stepUp: { method: string } }).stepUp.method, "password");
    assert.ok(!sent[0]!.raw.includes(ADMIN_PASSWORD));
    const platformAudit = (await listAdminAudit("platform.entries_", 5))[0]!;
    assert.deepEqual([platformAudit.action, platformAudit.actor, platformAudit.detail.changed, platformAudit.detail.reason],
      ["platform.entries_paused", ADMIN_USER_ID, true, "news risk"]);
    const botAudit = (await listAdminAudit("bot.entries.", 5)).reverse().map((r) => r.action);
    assert.deepEqual(botAudit, ["bot.entries.requested", "bot.entries.succeeded"]);
  });

  await t.test("target state: pausing again changes nothing and keeps the first reason", async () => {
    bot.reset();
    const res = await entries(admin, pause({ password: ADMIN_PASSWORD }, { reason: "a second reason" }));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual([res.json().platform.changed, res.json().platform.reason], [false, "news risk"]);
  });

  await t.test("pausing is restart-safe: a fresh connection reads it from the database", async () => {
    const fresh = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const { rows } = await fresh.query<{ entries_paused: boolean; entries_paused_reason: string }>(
        "SELECT entries_paused, entries_paused_reason FROM risk_controls WHERE id = 1");
      assert.deepEqual(rows[0], { entries_paused: true, entries_paused_reason: "news risk" });
    } finally { await fresh.end(); }
    // What the live runner's gate reads on every emission after a restart.
    const limits = await liveSafety.getRiskLimits();
    const snap = { currentExposureQuote: 0, openPositions: 0, realisedPnlInWindow: 0 };
    const buy = evaluateRisk(limits, snap, { action: "buy", quoteQty: 10, alreadyLong: false });
    assert.equal(buy.allowed ? "" : buy.code, "entries_paused");
    assert.deepEqual(evaluateRisk(limits, snap, { action: "sell", quoteQty: 0, alreadyLong: true }), { allowed: true });
  });

  await t.test("paused: the Platform manual BUY is 409 entries_paused; a SELL still reaches the Bot", async () => {
    config.manualTradingEnabled = true;
    try {
      const sent: unknown[] = [];
      const manual = Fastify({ logger: false });
      await manual.register(manualTradingRoutes, {
        shariah: { readMode: async () => "off" as const, lookupBaseAsset: async () => null },
        botRequest: (async (input: unknown) => { sent.push(input); return { ok: true }; }) as never,
        stepUp: async () => ({ method: "grant" as const, at: new Date().toISOString() }),
      } as never);
      const order = { requestId: "browser-request-id-entries-01", accountId: "acct", symbol: "BTCUSDT", orderType: "MARKET" };
      const buy = await manual.inject({ method: "POST", url: "/api/manual-trading/orders", payload: { ...order, side: "BUY", quoteQuantity: 10 } });
      assert.deepEqual([buy.statusCode, buy.json().code], [409, "entries_paused"], buy.body);
      const sell = await manual.inject({ method: "POST", url: "/api/manual-trading/orders",
        payload: { ...order, requestId: "browser-request-id-entries-02", side: "SELL", baseQuantity: 0.1 } });
      assert.equal(sell.statusCode, 200, sell.body);
      assert.equal(sent.length, 1, "only the SELL was sent");
      await manual.close();
    } finally { config.manualTradingEnabled = false; }
  });

  await t.test("paused: a deployment test-signal BUY is 409 entries_paused; a SELL is not refused by the pause", async () => {
    config.liveTestEnabled = true;
    try {
      const routes = Fastify({ logger: false });
      await routes.register(deploymentRoutes(() => ({} as never), {
        getDeployment: async () => null,
        shariah: { readMode: async () => "off" as const, lookupBaseAsset: async () => null },
      }));
      const url = "/api/deployments/11111111-1111-4111-8111-111111111111/test-signal";
      const buy = await routes.inject({ method: "POST", url, payload: { action: "buy", confirmation: "LIVE_TEST" } });
      assert.deepEqual([buy.statusCode, buy.json().code], [409, "entries_paused"], buy.body);
      const sell = await routes.inject({ method: "POST", url, payload: { action: "sell", confirmation: "LIVE_TEST" } });
      assert.notEqual(sell.json().code, "entries_paused");
      await routes.close();
    } finally { config.liveTestEnabled = false; }
  });

  await t.test("status: both halves, separately; an older Bot without entries is still CONNECTED and its half unknown", async () => {
    bot.reset();
    bot.entries = { ...bot.entries, paused: true, reason: "news risk" };
    bot.workingEntries = [{ orderId: "o-1", symbol: "BTCUSDT" }, { orderId: "o-2", symbol: "ETHUSDT" }];
    let res = await call(admin, "GET", "/api/bot/control/status");
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().platformEntries.paused, true);
    assert.equal(res.json().facts.entries.paused, true);
    assert.equal(res.json().facts.entries.workingEntryLimits, 2);
    assert.deepEqual(res.json().facts.capabilities, ["entries.v1", "manualPositionFull.v1"]);
    bot.legacyStatus = true;
    res = await call(admin, "GET", "/api/bot/control/status");
    assert.deepEqual(res.json().signed, { state: "CONNECTED", cause: null });
    assert.equal(res.json().facts.entries, undefined, "absent, so the UI says unknown");
    assert.equal(res.json().facts.capabilities, undefined);
    // Present but malformed is not the contract.
    assert.equal(isBotControlStatus(controlStatus()), true);
    assert.equal(isBotControlStatus({ ...controlStatus(), entries: { paused: "yes" } }), false);
    assert.equal(isBotControlStatus({ ...controlStatus(), capabilities: "entries.v1" }), false);
    assert.equal(isBotControlStatus({ ...controlStatus(), entries: { paused: true, pausedAt: null, pausedBy: null,
      reason: null, workingEntryLimits: -1 } }), false);
    assert.equal(botHasCapability(controlStatus({ capabilities: ["entries.v1"] }) as never, "entries.v1"), true);
    assert.equal(botHasCapability(controlStatus() as never, "entries.v1"), false);
    assert.equal(botHasCapability(null, "entries.v1"), false);
  });

  // ── two-factor on ──────────────────────────────────────────────────────────
  const setup = await call(admin, "POST", "/api/auth/2fa/setup", { password: ADMIN_PASSWORD });
  const secret = (setup.json() as { secret: string }).secret;
  const enabled = await call(admin, "POST", "/api/auth/2fa/enable", { code: totpCode(secret, totpStepAt(Date.now())) });
  assert.equal(enabled.statusCode, 200, enabled.body);
  admin = session(enabled)!;
  const freshCode = async () => {
    await query("UPDATE users SET totp_last_step = 0 WHERE id = $1", [ADMIN_USER_ID]);
    stepUpLimiter.reset(ADMIN_USER_ID);
    return totpCode(secret, totpStepAt(Date.now()));
  };

  await t.test("resume needs two-factor; a refused resume leaves the Platform paused", async () => {
    bot.reset();
    const pw = await entries(admin, { requestId: rid("resume"), paused: false, credential: { password: ADMIN_PASSWORD } });
    assert.deepEqual([pw.statusCode, pw.json().code, pw.json().method], [400, "step_up_required", "totp"]);
    assert.equal(await platformState(), true);
    const res = await entries(admin, { requestId: rid("resume"), paused: false, credential: { code: await freshCode() } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual([res.json().platform.paused, res.json().platform.changed], [false, true]);
    assert.equal(await platformState(), false);
    assert.deepEqual(Object.keys(bot.commandRequests()[0]!.body as object).sort(), ["actor", "paused"]);
    assert.equal((await listAdminAudit("platform.entries_", 1))[0]!.action, "platform.entries_resumed");
  });

  await t.test("resume is recorded before it takes effect: audit down → 503, still paused, nothing sent (review R1)", async () => {
    await liveSafety.setEntriesPaused(true, { reason: "audit-first probe", by: ADMIN_USER_ID });
    bot.reset();
    await query(`CREATE FUNCTION r1_refuse_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'r1: audit down'; END; $$ LANGUAGE plpgsql`);
    await query("CREATE TRIGGER r1_block BEFORE INSERT ON admin_audit FOR EACH ROW EXECUTE FUNCTION r1_refuse_audit()");
    try {
      const res = await entries(admin, { requestId: rid("r1"), paused: false, credential: { code: await freshCode() } });
      assert.deepEqual([res.statusCode, res.json().code], [503, "audit_unavailable"], res.body);
      assert.equal(await platformState(), true);
      assert.equal(bot.commandRequests().length, 0);
    } finally {
      await query("DROP TRIGGER r1_block ON admin_audit");
      await query("DROP FUNCTION r1_refuse_audit()");
    }
    const ok = await entries(admin, { requestId: rid("r1ok"), paused: false, credential: { code: await freshCode() } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(await platformState(), false);
    const actions = (await listAdminAudit("platform.entries_", 2)).map((r) => r.action).sort();
    assert.deepEqual(actions, ["platform.entries_resume.requested", "platform.entries_resumed"]);
  });

  await t.test("cancelWorkingEntries is an explicit opt-in, passed through, and the Bot's report comes back", async () => {
    bot.reset();
    bot.workingEntries = [{ orderId: "o-9", symbol: "BTCUSDT" }];
    const res = await entries(admin, pause({ code: await freshCode() }, { cancelWorkingEntries: true }));
    assert.equal(res.statusCode, 200, res.body);
    const sent = bot.commandRequests()[0]!.body as Record<string, unknown>;
    assert.equal(sent.cancelWorkingEntries, true);
    assert.deepEqual(res.json().bot.result.canceledEntries, [{ orderId: "o-9", symbol: "BTCUSDT", outcome: "canceled" }]);
    // false is the same as absent: never sent.
    bot.reset();
    await liveSafety.setEntriesPaused(false);
    const plain = await entries(admin, pause({ code: await freshCode() }, { cancelWorkingEntries: false }));
    assert.equal(plain.statusCode, 200, plain.body);
    assert.equal("cancelWorkingEntries" in (bot.commandRequests()[0]!.body as object), false);
  });

  await t.test("the Bot half uncertain or unconfigured: the Platform half still applies and says so separately", async () => {
    await liveSafety.setEntriesPaused(false);
    bot.reset();
    bot.replies.push({ destroy: true });
    const uncertain = await entries(admin, pause({ code: await freshCode() }));
    assert.equal(uncertain.statusCode, 200, uncertain.body);
    assert.equal(uncertain.json().platform.paused, true);
    assert.deepEqual([uncertain.json().bot.httpStatus, uncertain.json().bot.status], [202, "uncertain"]);
    assert.equal(await platformState(), true);

    await liveSafety.setEntriesPaused(false);
    config.manualTradingHmacSecret = "";
    try {
      const unset = await entries(admin, pause({ code: await freshCode() }));
      assert.equal(unset.statusCode, 200, unset.body);
      assert.equal(unset.json().platform.paused, true);
      assert.deepEqual([unset.json().bot.httpStatus, unset.json().bot.code], [503, "bot_channel_not_configured"]);
    } finally { config.manualTradingHmacSecret = SECRET; }
  });

  await t.test("a grant from a recent code pauses with no new code", async () => {
    await liveSafety.setEntriesPaused(false);
    bot.reset();
    const first = await call(admin, "POST", "/api/bot/control/halt",
      { requestId: rid("halt"), confirmation: "HALT_TRADING", reason: "mint a grant", credential: { code: await freshCode() } });
    assert.equal(first.statusCode, 200, first.body);
    const grant = ([first.headers["set-cookie"]].flat() as string[]).find((c) => c.startsWith("srtrend_stepup="))!.split(";")[0]!;
    const res = await entries(`${admin}; ${grant}`, pause());
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().platform.paused, true);
    const actor = (bot.commandRequests().at(-1)!.body as { actor: { stepUp: { method: string } } }).actor;
    assert.equal(actor.stepUp.method, "totp");
  });
});
