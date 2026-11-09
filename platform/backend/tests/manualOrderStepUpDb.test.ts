/**
 * The Platform manual order route (OD-7 / OD-2): the browser's request id is
 * required and never minted, a BUY is confirmed at the grant tier, a SELL is
 * never asked for anything, and `positionFull` is passed through only in its
 * one valid shape. Real API, session gate and step-up, real PostgreSQL, the
 * fake Bot recording what it receives.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_manual_order_step_up`;
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

const SECRET = "manual-order-db-test-secret-0123456789abcdef";
const ADMIN_PASSWORD = "owner password";
const POSITION_ID = "pos-0001-manual";
let seq = 0;
const rid = (label = "ord") => `${label}_${Date.now().toString(36)}_${(seq += 1).toString().padStart(6, "0")}`;

test("manual order step-up and request id", async (t) => {
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
  const liveSafety = await import("../src/repositories/liveSafety");
  const { FakeBot } = await import("./support/fakeBot");
  after(() => closePool());
  await migrate();

  const bot = new FakeBot(SECRET);
  await bot.start();
  t.after(() => bot.stop());
  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    adminUsername: config.adminUsername, adminPasswordHash: config.adminPasswordHash, emailFrom: config.emailFrom,
    manualTradingBotUrl: config.manualTradingBotUrl, manualTradingHmacSecret: config.manualTradingHmacSecret,
    manualTradingEnabled: config.manualTradingEnabled,
  };
  Object.assign(config, {
    authEnabled: true, sessionSecret: "manual-order-test-session-secret-00000000000", allowSignups: true,
    adminUsername: "owner", adminPasswordHash: hashPassword(ADMIN_PASSWORD), emailFrom: "",
    manualTradingBotUrl: bot.url, manualTradingHmacSecret: SECRET, manualTradingEnabled: true,
  });
  t.after(() => Object.assign(config, previous));

  const app = buildServer(() => ({} as never));
  t.after(() => app.close());
  type Res = { headers: Record<string, unknown> };
  const cookieNamed = (res: Res, name: string) => {
    const found = ([res.headers["set-cookie"]].flat().filter(Boolean) as string[])
      .map((c) => new RegExp(`^${name}=([^;]+)`).exec(c)?.[1]).find(Boolean);
    return found ? `${name}=${found}` : null;
  };
  const call = (cookie: string | null, payload: object) => {
    loginLimiter.reset("127.0.0.1");
    return app.inject({ method: "POST", url: "/api/manual-trading/orders", headers: cookie ? { cookie } : {}, payload });
  };
  let admin = cookieNamed(await app.inject({ method: "POST", url: "/api/auth/login",
    payload: { username: "owner", password: ADMIN_PASSWORD } }), "srtrend_session")!;
  const standard = cookieNamed(await app.inject({ method: "POST", url: "/api/auth/signup",
    payload: { email: "standard@example.com", password: "correct horse battery" } }), "srtrend_session")!;
  const order = { accountId: "acct-testnet", symbol: "BTCUSDT", orderType: "MARKET" };
  const buy = (extra: object = {}) => ({ requestId: rid("buy"), ...order, side: "BUY", quoteQuantity: 10, ...extra });
  const sell = (extra: object = {}) => ({ requestId: rid("sell"), ...order, side: "SELL", positionId: POSITION_ID,
    baseQuantity: 0.37, ...extra });

  await t.test("nobody 401 and a Standard account 403; nothing reaches the Bot", async () => {
    bot.reset();
    assert.equal((await call(null, buy())).statusCode, 401);
    assert.equal((await call(standard, buy())).statusCode, 403);
    assert.equal((await call(standard, sell())).statusCode, 403);
    assert.equal(bot.manualOrders.length, 0);
  });

  await t.test("F7: the browser's request id is required on BUY and SELL, and never minted", async () => {
    bot.reset();
    for (const requestId of [undefined, "short", "has spaces in it!!", 1234567890123456]) {
      for (const body of [buy({ requestId }), sell({ requestId })]) {
        const res = await call(admin, body);
        assert.deepEqual([res.statusCode, res.json().code], [400, "invalid_request_id"], JSON.stringify(body));
      }
    }
    assert.equal(bot.manualOrders.length, 0);
  });

  await t.test("2FA off: a manual BUY needs two-factor (no password); a SELL needs nothing and goes through unchanged", async () => {
    bot.reset();
    const refused = await call(admin, buy({ credential: { password: ADMIN_PASSWORD } }));
    assert.deepEqual([refused.statusCode, refused.json().code], [403, "two_factor_required"]);
    const requestId = rid("sell");
    const ok = await call(admin, sell({ requestId }));
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(bot.manualOrders.length, 1);
    assert.equal(bot.manualOrders[0]!.requestId, requestId, "the browser's id is the one the Bot sees");
    const body = bot.manualOrders[0]!.body;
    assert.deepEqual([body.positionId, body.baseQuantity, body.side], [POSITION_ID, 0.37, "SELL"]);
    assert.equal("requestId" in body, false);
    assert.equal("credential" in body, false);
  });

  await t.test("positionFull: passed through in its one valid shape, refused in any other", async () => {
    bot.reset();
    const full = await call(admin, sell({ baseQuantity: undefined, positionFull: true }));
    assert.equal(full.statusCode, 200, full.body);
    assert.equal(bot.manualOrders[0]!.body.positionFull, true);
    assert.equal("baseQuantity" in bot.manualOrders[0]!.body, false);
    for (const bad of [
      sell({ positionFull: true }), // beside a quantity
      sell({ baseQuantity: undefined, positionFull: "true" }),
      sell({ baseQuantity: undefined, positionFull: false }),
      sell({ baseQuantity: undefined, positionId: undefined, positionFull: true }),
      buy({ positionFull: true }),
    ]) {
      const res = await call(admin, bad);
      assert.deepEqual([res.statusCode, res.json().code], [400, "invalid_request"], JSON.stringify(bad));
    }
    assert.equal(bot.manualOrders.length, 1);
  });

  // ── two-factor on ──────────────────────────────────────────────────────────
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie: admin }, payload: { password: ADMIN_PASSWORD } });
  const secret = (setup.json() as { secret: string }).secret;
  const enabled = await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie: admin },
    payload: { code: totpCode(secret, totpStepAt(Date.now())) } });
  admin = cookieNamed(enabled, "srtrend_session")!;
  const freshCode = async () => {
    await query("UPDATE users SET totp_last_step = 0 WHERE id = $1", [ADMIN_USER_ID]);
    stepUpLimiter.reset(ADMIN_USER_ID);
    return totpCode(secret, totpStepAt(Date.now()));
  };

  await t.test("2FA on: a BUY asks for the code (grant tier); the code is never forwarded; the grant covers the next BUY", async () => {
    bot.reset();
    const missing = await call(admin, buy());
    assert.deepEqual([missing.statusCode, missing.json().code, missing.json().method, missing.json().tier],
      [400, "step_up_required", "totp", "grant"]);
    const code = await freshCode();
    const ok = await call(admin, buy({ credential: { code } }));
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(!JSON.stringify(bot.manualOrders[0]!.body).includes(code));
    assert.equal("credential" in bot.manualOrders[0]!.body, false);
    const grant = cookieNamed(ok, "srtrend_stepup");
    assert.ok(grant, "a code mints a grant");
    const again = await call(`${admin}; ${grant}`, buy());
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(bot.manualOrders.length, 2);
    // A SELL never needs a code, with or without a grant.
    assert.equal((await call(admin, sell())).statusCode, 200);
  });

  await t.test("halted or paused: the BUY is refused before any code is spent; the SELL still goes", async () => {
    bot.reset();
    await liveSafety.setTradingHalted(true, { reason: "test halt", by: "operator" });
    const code = await freshCode();
    const halted = await call(admin, buy({ credential: { code } }));
    assert.equal(halted.statusCode, 409, halted.body);
    assert.equal((await call(admin, sell())).statusCode, 200, "halt never blocks an exit");
    await liveSafety.setTradingHalted(false);
    await liveSafety.setEntriesPaused(true, { reason: "pause test", by: ADMIN_USER_ID });
    const paused = await call(admin, buy({ credential: { code } }));
    assert.deepEqual([paused.statusCode, paused.json().code], [409, "entries_paused"]);
    assert.equal((await call(admin, sell())).statusCode, 200, "pause never blocks an exit");
    await liveSafety.setEntriesPaused(false);
    // The same code was never spent by the refusals.
    const ok = await call(admin, buy({ credential: { code } }));
    assert.equal(ok.statusCode, 200, ok.body);
  });

  await t.test("AUTH_ENABLED=false refuses a BUY; a SELL is still credential-free", async () => {
    bot.reset();
    config.authEnabled = false;
    try {
      const res = await call(null, buy({ credential: { code: "123456" } }));
      assert.deepEqual([res.statusCode, res.json().code], [403, "auth_disabled"]);
      assert.equal((await call(null, sell())).statusCode, 200);
    } finally { config.authEnabled = true; }
    assert.equal(bot.manualOrders.length, 1, "only the SELL");
  });
});
