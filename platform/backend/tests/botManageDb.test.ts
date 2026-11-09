/**
 * Bot management from Trading Scene (C10-C19, link-bot) through the real API,
 * session gate and step-up, against a real PostgreSQL and the fake Bot
 * (`support/fakeBot.ts` + `support/fakeBotManage.ts`).
 *
 * What is proved here:
 *   - every new route is admin-only, whatever the path's spelling, and needs
 *     a browser request id for every mutation (never minted);
 *   - each command's tier: C10 fresh unless entries are off, C12 fresh exactly
 *     when the edit weakens protection (and when the bot cannot be read
 *     first), C13/C16/link grant, C14/C17 fresh;
 *   - a webhook secret is stored encrypted before the answer and is absent
 *     from every browser answer, the replay cache, the audit rows and the
 *     logs; a replayed create says it was not captured;
 *   - an enrollment link is answered once, `no-store`, only on
 *     BOT_PUBLIC_ORIGIN, and never replayed or audited;
 *   - link-bot copies the stored secret server-side.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_bot_manage`;
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

/*
 * Everything this process writes to stdout/stderr while the suite runs —
 * Fastify's pino logger writes through `fs.write(Sync)` on fd 1 — so the
 * test can say a secret never reached a log line.
 */
const logged: string[] = [];
const fsw = fs as unknown as { write: (...a: unknown[]) => unknown; writeSync: (...a: unknown[]) => unknown };
const realWrite = fsw.write;
const realWriteSync = fsw.writeSync;
fsw.write = (...a: unknown[]) => { if (a[0] === 1 || a[0] === 2) logged.push(String(a[1])); return realWrite.apply(fs, a); };
fsw.writeSync = (...a: unknown[]) => { if (a[0] === 1 || a[0] === 2) logged.push(String(a[1])); return realWriteSync.apply(fs, a); };
const realStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  logged.push(String(chunk));
  return (realStdout as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;

const SECRET = "bot-manage-db-test-secret-0123456789abcdef";
const ADMIN_PASSWORD = "owner password";
const BOT_ORIGIN = "https://bot.example.test";
const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";

let seq = 0;
const rid = (label = "req") => `${label}_${Date.now().toString(36)}_${(seq += 1).toString().padStart(6, "0")}`;

test("bot management", async (t) => {
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
  const { userMayReach } = await import("../src/security/requestUser");
  const { listAdminAudit } = await import("../src/repositories/adminAudit");
  const { decryptSecret } = await import("../src/security/secrets");
  const { resetBotControlStateForTests, setBotControlTimeoutsForTests } = await import("../src/api/routes/botControl");
  const { weakensProtection } = await import("../src/api/routes/botManage");
  const { FakeBot } = await import("./support/fakeBot");
  after(() => closePool());
  await migrate();

  const bot = new FakeBot(SECRET);
  await bot.start();
  t.after(() => bot.stop());

  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    emailFrom: config.emailFrom, publicBaseUrl: config.publicBaseUrl, adminUsername: config.adminUsername,
    adminPasswordHash: config.adminPasswordHash, manualTradingBotUrl: config.manualTradingBotUrl,
    manualTradingHmacSecret: config.manualTradingHmacSecret, botPublicOrigin: config.botPublicOrigin,
  };
  Object.assign(config, {
    authEnabled: true, sessionSecret: "bot-manage-test-session-secret-00000000000", allowSignups: true,
    emailFrom: "no-reply@example.test", publicBaseUrl: "https://app.example.test",
    adminUsername: "owner", adminPasswordHash: hashPassword(ADMIN_PASSWORD),
    manualTradingBotUrl: bot.url, manualTradingHmacSecret: SECRET, botPublicOrigin: BOT_ORIGIN,
  });
  t.after(() => {
    Object.assign(config, previous); useEmailTransportForTests(null); setBotControlTimeoutsForTests(null);
    fsw.write = realWrite; fsw.writeSync = realWriteSync; process.stdout.write = realStdout as typeof process.stdout.write;
  });
  useEmailTransportForTests(async () => {});

  const app = buildServer(() => ({} as never));
  t.after(() => app.close());

  /** Every body this API sent back to a browser in this suite. */
  const answered: string[] = [];
  const cookiesOf = (res: { headers: Record<string, unknown> }) =>
    ([res.headers["set-cookie"]].flat().filter(Boolean) as string[]);
  const cookieNamed = (res: { headers: Record<string, unknown> }, name: string) => {
    const found = cookiesOf(res).map((c) => new RegExp(`^${name}=([^;]+)`).exec(c)?.[1]).find(Boolean);
    return found ? `${name}=${found}` : null;
  };
  const session = (res: { headers: Record<string, unknown> }) => cookieNamed(res, "srtrend_session");
  const call = async (cookie: string | null, method: string, url: string, payload?: object, headers: Record<string, string> = {}) => {
    loginLimiter.reset("127.0.0.1");
    const res = await app.inject({ method: method as "POST", url,
      headers: { ...headers, ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) });
    answered.push(res.body);
    return res;
  };

  const login = await call(null, "POST", "/api/auth/login", { username: "owner", password: ADMIN_PASSWORD });
  assert.equal(login.statusCode, 200, login.body);
  let admin = session(login)!;
  const signup = await call(null, "POST", "/api/auth/signup", { email: "standard@example.com", password: "correct horse battery" });
  assert.equal(signup.statusCode, 201, signup.body);
  const standard = session(signup)!;

  const strategy = (await query<{ id: number }>("SELECT id FROM strategies ORDER BY id LIMIT 1")).rows[0]!.id;
  const deployment = async (delivery = "custom") => (await query<{ id: string }>(
    `INSERT INTO deployments (strategy_id, symbol, timeframe, params, delivery, webhook_url)
     VALUES ($1, 'BTCUSDT', '1h', '{}', $2, 'https://bot.example.test/api/webhooks/signal_bots') RETURNING id`,
    [strategy, delivery])).rows[0]!.id;
  const depId = await deployment();

  const BOT_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  const ACCOUNT_ID = "7a1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4c";
  const ENROLLMENT_ID = "8b1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4d";
  const ROUTES: [string, string][] = [
    ["POST", "/api/bot/manage/bots"],
    ["GET", `/api/bot/manage/bots/${BOT_ID}`],
    ["PATCH", `/api/bot/manage/bots/${BOT_ID}`],
    ["POST", `/api/bot/manage/bots/${BOT_ID}/delete`],
    ["POST", `/api/bot/manage/bots/${BOT_ID}/rotate-secret`],
    ["GET", "/api/bot/manage/accounts"],
    ["POST", `/api/bot/manage/accounts/${ACCOUNT_ID}/delete`],
    ["GET", `/api/bot/manage/accounts/${ACCOUNT_ID}/balance`],
    ["POST", "/api/bot/manage/enrollments"],
    ["GET", `/api/bot/manage/enrollments/${ENROLLMENT_ID}`],
    ["POST", `/api/deployments/${depId}/link-bot`],
  ];
  /** The same routes, spelled differently: percent-encoded letters, mixed case, absolute form. */
  const variants = (url: string) => [
    url,
    url.replace("/api/bot/", "/api/b%6Ft/").replace("/api/deployments/", "/api/deploym%65nts/"),
    url.replace("/manage/", "/%6Danage/"),
    url.replace("/api/bot/", "/api/Bot/").replace("/api/deployments/", "/api/Deployments/"),
    url.toUpperCase(),
    `http://app.example.test${url}`,
  ];
  const commandsSent = () => bot.commandRequests().length;
  const auditFor = async (requestId: string) =>
    (await listAdminAudit("", 1000)).filter((row) => row.detail.requestId === requestId).reverse();

  await t.test("nobody signed in gets 401 and a Standard account 403, on every route and spelling", async () => {
    bot.reset();
    for (const [method, url] of ROUTES) {
      for (const spelling of variants(url)) {
        const payload = method === "GET" ? undefined : { requestId: rid(), credential: { password: ADMIN_PASSWORD }, botId: BOT_ID };
        const anon = await call(null, method, spelling, payload);
        assert.equal(anon.statusCode, 401, `${method} ${spelling}: ${anon.body}`);
        const user = await call(standard, method, spelling, payload);
        assert.ok(user.statusCode === 403, `${method} ${spelling}: ${user.statusCode} ${user.body}`);
      }
      assert.equal(userMayReach(method, url), false, `${method} ${url} is not on the ordinary account's list`);
    }
    assert.equal(bot.requests.length, 0, "the Bot was never contacted");
  });

  await t.test("with AUTH_ENABLED=false every mutation is refused; reads still work", async () => {
    bot.reset();
    bot.manage.addAccount({ id: ACCOUNT_ID });
    config.authEnabled = false;
    try {
      for (const [method, url] of ROUTES.filter(([m]) => m !== "GET")) {
        const res = await call(null, method, url, { requestId: rid(), botId: BOT_ID, name: "x", pairs: ["BTCUSDT"],
          maxInvestmentPct: 5, confirmation: "REMOVE_ACCOUNT", purpose: "create", testnet: true });
        assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`);
        assert.equal(res.json().code, "auth_disabled");
      }
      assert.equal(commandsSent(), 0);
      assert.equal((await call(null, "GET", "/api/bot/manage/accounts")).statusCode, 200);
    } finally {
      config.authEnabled = true;
    }
  });

  await t.test("2FA off: every management command needs two-factor; none accepts the password", async () => {
    bot.reset();
    const acct = bot.manage.addAccount();
    const managed = bot.manage.addBot();
    const cases: [string, string, object][] = [
      ["POST", "/api/bot/manage/bots", { name: "New", pairs: ["BTCUSDT"], maxInvestmentPct: 5, stopLossPct: 3 }],
      ["PATCH", `/api/bot/manage/bots/${managed.id}`, { name: "Renamed" }],
      ["POST", `/api/bot/manage/bots/${managed.id}/delete`, {}],
      ["POST", `/api/bot/manage/bots/${managed.id}/rotate-secret`, {}],
      ["POST", `/api/bot/manage/accounts/${acct.id}/delete`, { confirmation: "REMOVE_ACCOUNT" }],
      ["POST", "/api/bot/manage/enrollments", { purpose: "create", name: "Main", testnet: true }],
    ];
    for (const [method, url, extra] of cases) {
      const res = await call(admin, method, url, { requestId: rid(), credential: { password: ADMIN_PASSWORD }, ...extra });
      assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`);
      assert.equal(res.json().code, "two_factor_required");
    }
    assert.equal(commandsSent(), 0);
  });

  await t.test("a missing or malformed request id is 400 and nothing is sent (never minted)", async () => {
    bot.reset();
    const managed = bot.manage.addBot();
    const acct = bot.manage.addAccount();
    const cases: [string, string, object][] = [
      ["POST", "/api/bot/manage/bots", { name: "New", pairs: ["BTCUSDT"], maxInvestmentPct: 5, stopLossPct: 3 }],
      ["PATCH", `/api/bot/manage/bots/${managed.id}`, { name: "Renamed" }],
      ["POST", `/api/bot/manage/bots/${managed.id}/delete`, {}],
      ["POST", `/api/bot/manage/bots/${managed.id}/rotate-secret`, {}],
      ["POST", `/api/bot/manage/accounts/${acct.id}/delete`, { confirmation: "REMOVE_ACCOUNT" }],
      ["POST", "/api/bot/manage/enrollments", { purpose: "create", name: "Main", testnet: true }],
    ];
    for (const [method, url, extra] of cases) {
      for (const requestId of [undefined, "short", "has spaces in it!!"]) {
        const res = await call(admin, method, url, { ...extra, requestId, credential: { code: "123456" } });
        assert.equal(res.statusCode, 400, `${method} ${url} ${requestId}`);
        assert.equal(res.json().code, "invalid_request_id");
      }
    }
    const link = await call(admin, "POST", `/api/deployments/${depId}/link-bot`, { botId: managed.id, requestId: "bad id" });
    assert.equal(link.json().code, "invalid_request_id");
    assert.equal(commandsSent(), 0);
  });

  // ── two-factor on ──────────────────────────────────────────────────────────
  const setup = await call(admin, "POST", "/api/auth/2fa/setup", { password: ADMIN_PASSWORD });
  assert.equal(setup.statusCode, 200, setup.body);
  const totp = (setup.json() as { secret: string }).secret;
  const enabled = await call(admin, "POST", "/api/auth/2fa/enable", { code: totpCode(totp, totpStepAt(Date.now())) });
  assert.equal(enabled.statusCode, 200, enabled.body);
  admin = session(enabled)!;
  const freshCode = async () => {
    await query("UPDATE users SET totp_last_step = 0 WHERE id = $1", [ADMIN_USER_ID]);
    stepUpLimiter.reset(ADMIN_USER_ID);
    return totpCode(totp, totpStepAt(Date.now()));
  };
  /** A session plus a step-up grant: a code-confirmed command minted it. */
  const withGrant = async (): Promise<string> => {
    bot.bots.set("6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3aaa", { id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3aaa", name: "g", status: "active" });
    const res = await call(admin, "POST", "/api/bot/control/bots/6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3aaa/status",
      { requestId: rid("grant"), status: "active", credential: { code: await freshCode() } });
    assert.equal(res.statusCode, 200, res.body);
    const grant = cookieNamed(res, "srtrend_stepup");
    assert.ok(grant, "a correct code minted a grant");
    return `${admin}; ${grant}`;
  };

  await t.test("C10 create: fresh when entries are on; the secret is stored encrypted and never answered", async () => {
    bot.reset();
    resetBotControlStateForTests();
    const acct = bot.manage.addAccount();
    const granted = await withGrant();
    const fields = { name: "  Trend bot  ", pairs: ["btc/usdt", "ETHUSDT", "BTCUSDT"], maxInvestmentPct: 5,
      maxInvestmentUnit: "pct_bot", exchangeAccountId: acct.id, entryEnabled: true, entryVolumePct: 100,
      entryOrderType: "market", exitEnabled: true, takeProfitEnabled: false, takeProfitPct: null,
      stopLossEnabled: true, stopLossPct: 3, maxEntryOrders: null, maxActiveSmartTradesEnabled: true,
      maxActiveSmartTrades: 2, alertType: "custom", direction: "long", extra: "dropped", actor: { platformUserId: "forged" } };

    const before = commandsSent();
    const noCode = await call(granted, "POST", "/api/bot/manage/bots", { requestId: rid("c10"), ...fields });
    assert.equal(noCode.statusCode, 400, noCode.body);
    assert.deepEqual([noCode.json().code, noCode.json().tier], ["step_up_required", "fresh"], "a grant is not enough");
    assert.equal(commandsSent(), before);

    const requestId = rid("c10");
    const res = await call(admin, "POST", "/api/bot/manage/bots", { requestId, ...fields, credential: { code: await freshCode() } });
    assert.equal(res.statusCode, 200, res.body);
    const secret = bot.manage.issuedSecrets.at(-1)!;
    assert.equal(res.json().status, "succeeded");
    const result = res.json().result;
    assert.equal(result.bot.name, "Trend bot");
    assert.equal(result.secretIssued, true);
    assert.deepEqual(result.platformSecret, { secretCaptured: true, linkedDeploymentsUpdated: 0 });
    assert.equal("webhookSecret" in result, false);
    assert.ok(!res.body.includes(secret), "the browser never sees the secret");

    const sent = bot.commandRequests().at(-1)!;
    const body = sent.body as Record<string, unknown>;
    assert.equal(sent.requestId, requestId);
    assert.deepEqual(body.pairs, ["BTCUSDT", "ETHUSDT"], "pairs normalised and de-duplicated");
    assert.equal(body.name, "Trend bot");
    assert.equal("extra" in body, false);
    assert.equal((body.actor as { platformUserId: string }).platformUserId, ADMIN_USER_ID, "a body cannot name the actor");

    const stored = await query<{ secret_enc: string }>("SELECT secret_enc FROM bot_webhook_secrets WHERE bot_id = $1", [result.bot.id]);
    assert.equal(stored.rows.length, 1);
    assert.ok(stored.rows[0]!.secret_enc.startsWith("enc:"), "encrypted at rest");
    assert.equal(decryptSecret(stored.rows[0]!.secret_enc), secret);

    // The replay cache keeps the secret-free answer.
    const again = await call(admin, "POST", "/api/bot/manage/bots", { requestId, ...fields, credential: { code: "000000" } });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().replayed, true);
    assert.ok(!again.body.includes(secret));

    const rows = await auditFor(requestId);
    assert.deepEqual(rows.map((r) => r.action), ["bot.bot_create.requested", "bot.bot_create.succeeded"]);
    assert.equal(rows[1]!.detail.secretCaptured, true);
    assert.ok(!JSON.stringify(rows).includes(secret));
  });

  await t.test("C10 create with entries off is grant tier", async () => {
    bot.reset();
    const granted = await withGrant();
    const res = await call(granted, "POST", "/api/bot/manage/bots",
      { requestId: rid("c10g"), name: "Exit only", pairs: ["SOLUSDT"], maxInvestmentPct: 5, stopLossPct: 3, entryEnabled: false });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().result.platformSecret.secretCaptured, true);
  });

  await t.test("C10 fields are checked before step-up, incl. the 50% unprotected-size rule", async () => {
    bot.reset();
    const before = commandsSent();
    const good = { name: "B", pairs: ["BTCUSDT"], maxInvestmentPct: 5, stopLossPct: 3 };
    for (const bad of [
      { ...good, name: "   " }, { ...good, name: "x".repeat(65) }, { ...good, pairs: [] }, { ...good, pairs: ["BTC-EUR"] },
      { ...good, maxInvestmentPct: 101 }, { ...good, maxInvestmentPct: 0 },
      { ...good, maxInvestmentUnit: "usdt_bot", maxInvestmentPct: 20_000_000 }, { ...good, maxInvestmentUnit: "eur" },
      { ...good, entryOrderType: "limit" }, { ...good, direction: "short" }, { ...good, entryVolumePct: 0 },
      { ...good, exchangeAccountId: "not-an-id" }, { ...good, stopLossPct: 0 }, { ...good, maxActiveSmartTrades: 1.5 },
      { ...good, maxInvestmentPct: 60, stopLossEnabled: false },
      { ...good, maxInvestmentPct: 50, entryVolumePct: 100, stopLossEnabled: false, stopLossPct: null },
      { ...good, stopLossEnabled: true, stopLossPct: null },
    ]) {
      const res = await call(admin, "POST", "/api/bot/manage/bots", { requestId: rid(), ...bad, credential: { code: "000000" } });
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
      assert.equal(res.json().code, "invalid_request", JSON.stringify(bad));
    }
    const unsafe = await call(admin, "POST", "/api/bot/manage/bots",
      { requestId: rid(), ...good, maxInvestmentPct: 60, stopLossEnabled: false, credential: { code: "000000" } });
    assert.match(unsafe.json().error, /50% of the balance or more requires a stop loss/);
    assert.equal(commandsSent(), before);
  });

  await t.test("the weakening rule, case by case", () => {
    const current = { id: "x", pairs: ["BTCUSDT"], maxInvestmentPct: 5, maxInvestmentUnit: "pct_bot", entryEnabled: true,
      entryVolumePct: 50, entryOrderType: "market", exitEnabled: true, takeProfitPct: 5, stopLossPct: 3, maxEntryOrders: 2,
      maxActiveSmartTradesEnabled: true, maxActiveSmartTrades: 2, exchangeAccountId: "a1" };
    const weakening: Record<string, unknown>[] = [
      { stopLossEnabled: false }, { stopLossPct: 4 }, { stopLossPct: null }, { maxInvestmentPct: 6 },
      { maxInvestmentUnit: "pct_trade" }, { entryVolumePct: 60 }, { maxActiveSmartTradesEnabled: false },
      { maxActiveSmartTrades: 3 }, { maxEntryOrders: null }, { maxEntryOrders: 3 }, { exchangeAccountId: "b2" },
      { exchangeAccountId: null }, { exitEnabled: false },
    ];
    for (const w of weakening) assert.equal(weakensProtection(w, current), true, JSON.stringify(w));
    assert.equal(weakensProtection({ entryEnabled: true }, { ...current, entryEnabled: false }), true);
    const fine: Record<string, unknown>[] = [
      { name: "x" }, { stopLossPct: 2 }, { takeProfitPct: 50 }, { takeProfitEnabled: false }, { maxInvestmentPct: 4 },
      { entryVolumePct: 40 }, { maxActiveSmartTrades: 1 }, { maxEntryOrders: 1 }, { exchangeAccountId: "a1" },
      { entryEnabled: false }, { exitEnabled: true }, { pairs: ["BTCUSDT", "ETHUSDT"] }, { maxInvestmentUnit: "pct_bot" },
    ];
    for (const f of fine) assert.equal(weakensProtection(f, current), false, JSON.stringify(f));
    assert.equal(weakensProtection({ stopLossEnabled: true, stopLossPct: 5 }, { ...current, stopLossPct: null }), false,
      "turning a stop loss on is never weakening");
    assert.equal(weakensProtection({ name: "x" }, null), true, "an unreadable bot counts as weakening");
  });

  await t.test("C12 edit: weakening needs a fresh code, the rest a grant; the current bot is read first", async () => {
    bot.reset();
    resetBotControlStateForTests();
    const acct = bot.manage.addAccount();
    const other = bot.manage.addAccount({ name: "Other" });
    const managed = bot.manage.addBot({ stopLossEnabled: true, stopLossPct: 3, maxInvestmentPct: 5, entryVolumePct: 50,
      maxActiveSmartTradesEnabled: true, maxActiveSmartTrades: 2, maxEntryOrders: 2, exchangeAccountId: acct.id,
      takeProfitEnabled: true, takeProfitPct: 5 });
    const granted = await withGrant();
    const url = `/api/bot/manage/bots/${managed.id}`;
    const sentBefore = commandsSent();
    for (const w of [{ stopLossEnabled: false, stopLossPct: null }, { stopLossPct: 4 }, { maxInvestmentPct: 6 },
      { maxInvestmentUnit: "pct_trade" }, { entryVolumePct: 60 }, { maxActiveSmartTradesEnabled: false },
      { maxActiveSmartTrades: 3 }, { exchangeAccountId: other.id }, { exitEnabled: false }]) {
      const res = await call(granted, "PATCH", url, { requestId: rid("c12w"), ...w });
      assert.equal(res.statusCode, 400, `${JSON.stringify(w)}: ${res.body}`);
      assert.deepEqual([res.json().code, res.json().tier], ["step_up_required", "fresh"], JSON.stringify(w));
    }
    assert.equal(commandsSent(), sentBefore, "nothing weakening was sent on a grant");
    assert.ok(bot.requests.some((r) => r.method === "GET" && r.path === `/api/manual-trading/control/bots/${managed.id}`),
      "C11 was read to decide the tier");

    for (const f of [{ name: "Renamed" }, { stopLossPct: 2 }, { takeProfitPct: 9 }, { maxInvestmentPct: 4 }]) {
      const res = await call(granted, "PATCH", url, { requestId: rid("c12g"), ...f });
      assert.equal(res.statusCode, 200, `${JSON.stringify(f)}: ${res.body}`);
      assert.equal(res.json().status, "succeeded");
    }
    assert.equal(bot.manage.bots.get(managed.id)!.name, "Renamed");

    // A weakening edit with a code goes through.
    const res = await call(admin, "PATCH", url, { requestId: rid("c12f"), stopLossPct: 6, credential: { code: await freshCode() } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(Object.keys(bot.commandRequests().at(-1)!.body as object).sort(), ["actor", "stopLossPct"]);

    // Entries turned on is weakening.
    bot.manage.bots.get(managed.id)!.entryEnabled = false;
    const entries = await call(granted, "PATCH", url, { requestId: rid("c12e"), entryEnabled: true });
    assert.deepEqual([entries.json().code, entries.json().tier], ["step_up_required", "fresh"]);

    // A bot that cannot be read first: every edit is fresh.
    const unknown = await call(granted, "PATCH", `/api/bot/manage/bots/${UNKNOWN_ID}`, { requestId: rid("c12u"), name: "x" });
    assert.deepEqual([unknown.json().code, unknown.json().tier], ["step_up_required", "fresh"]);

    // Nothing to change, and a merged config that breaks the 50% rule, are refused before step-up.
    assert.equal((await call(granted, "PATCH", url, { requestId: rid(), bogus: 1 })).json().code, "invalid_request");
    const unsafe = await call(granted, "PATCH", url, { requestId: rid(), maxInvestmentPct: 100, entryVolumePct: 100,
      stopLossEnabled: false, stopLossPct: null });
    assert.equal(unsafe.json().code, "invalid_request");

    // `bot_busy_retry` is a definitive refusal (not uncertain) that the Platform never replays.
    const busyId = rid("busy");
    // The edit first reads the current bot (C11, to judge weakening): let that read through.
    bot.replies.push({}, { status: 409, json: { error: "The Bot is busy; try again.", code: "bot_busy_retry" }, skipExecution: true });
    const busy = await call(admin, "PATCH", url, { requestId: busyId, name: "Busy", credential: { code: await freshCode() } });
    assert.deepEqual([busy.statusCode, busy.json().code], [409, "bot_busy_retry"]);
    const retried = await call(admin, "PATCH", url, { requestId: busyId, name: "Busy", credential: { code: await freshCode() } });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json().replayed, undefined, "the retry reached the Bot");

    // The Bot's X5 refusal passes through with its code.
    bot.manage.bots.get(managed.id)!.activeTrades = 1;
    const x5 = await call(admin, "PATCH", url, { requestId: rid("x5"), exchangeAccountId: other.id, credential: { code: await freshCode() } });
    assert.deepEqual([x5.statusCode, x5.json().code], [409, "bot_has_open_trades"]);
  });

  await t.test("C11 read carries whether the secret is held here and the linked deployments", async () => {
    bot.reset();
    const managed = bot.manage.addBot();
    const res = await call(admin, "GET", `/api/bot/manage/bots/${managed.id}`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().bot.id, managed.id);
    assert.deepEqual(res.json().platform, { secret: { stored: false, updatedAt: null }, linkedDeployments: [] });
    assert.ok(!res.body.includes(managed.webhookSecret), "only the mask");
    const missing = await call(admin, "GET", `/api/bot/manage/bots/${UNKNOWN_ID}`);
    assert.deepEqual([missing.statusCode, missing.json().code], [404, "bot_not_found"]);
    assert.equal((await call(admin, "GET", "/api/bot/manage/bots/not-a-uuid")).json().code, "invalid_target_id");
  });

  await t.test("C14 rotate is fresh; link-bot copies the stored secret; rotation re-copies it", async () => {
    bot.reset();
    resetBotControlStateForTests();
    const managed = bot.manage.addBot();
    const granted = await withGrant();
    const url = `/api/bot/manage/bots/${managed.id}/rotate-secret`;
    const linkUrl = `/api/deployments/${depId}/link-bot`;

    // Nothing held yet: link refused before step-up.
    const early = await call(granted, "POST", linkUrl, { botId: managed.id, requestId: rid("link") });
    assert.deepEqual([early.statusCode, early.json().code], [409, "bot_secret_unknown"]);

    const grantOnly = await call(granted, "POST", url, { requestId: rid("rot") });
    assert.deepEqual([grantOnly.json().code, grantOnly.json().tier], ["step_up_required", "fresh"]);
    const rotated = await call(admin, "POST", url, { requestId: rid("rot"), credential: { code: await freshCode() } });
    assert.equal(rotated.statusCode, 200, rotated.body);
    const first = bot.manage.issuedSecrets.at(-1)!;
    assert.equal(rotated.json().result.platformSecret.secretCaptured, true);
    assert.ok(!rotated.body.includes(first));

    // Link: grant tier, server-side copy.
    const linked = await call(granted, "POST", linkUrl, { botId: managed.id, requestId: rid("link") });
    assert.equal(linked.statusCode, 200, linked.body);
    assert.deepEqual([linked.json().linked, linked.json().botId], [true, managed.id]);
    assert.ok(!linked.body.includes(first));
    let row = (await query<{ secret: string; bot_id: string | null }>("SELECT secret, bot_id FROM deployments WHERE id = $1", [depId])).rows[0]!;
    assert.equal(decryptSecret(row.secret), first);
    assert.equal(row.bot_id, managed.id);
    const list = await call(admin, "GET", "/api/deployments");
    const listed = (list.json() as { id: string; secret: string; botId: string }[]).find((d) => d.id === depId)!;
    assert.deepEqual([listed.secret, listed.botId], ["[CONFIGURED]", managed.id]);

    // A rotation re-copies into the linked deployment.
    const again = await call(admin, "POST", url, { requestId: rid("rot"), credential: { code: await freshCode() } });
    assert.equal(again.json().result.platformSecret.linkedDeploymentsUpdated, 1);
    const second = bot.manage.issuedSecrets.at(-1)!;
    row = (await query<{ secret: string; bot_id: string | null }>("SELECT secret, bot_id FROM deployments WHERE id = $1", [depId])).rows[0]!;
    assert.equal(decryptSecret(row.secret), second);
    const read = await call(admin, "GET", `/api/bot/manage/bots/${managed.id}`);
    assert.equal(read.json().platform.secret.stored, true);
    assert.equal(read.json().platform.linkedDeployments[0].id, depId);

    // A linked deployment cannot be pointed elsewhere without that destination's own
    // secret: the Bot's secret would follow it (final review A3). Nothing changes.
    const moved = await call(admin, "PATCH", `/api/deployments/${depId}`, { webhookUrl: "https://api.3commas.io/signal", buyQuoteQty: 10 });
    assert.deepEqual([moved.statusCode, moved.json().code], [409, "deployment_linked_to_bot"], moved.body);
    row = (await query<{ secret: string; bot_id: string | null }>("SELECT secret, bot_id FROM deployments WHERE id = $1", [depId])).rows[0]!;
    assert.deepEqual([decryptSecret(row.secret), row.bot_id], [second, managed.id]);

    // Only a custom deployment can be linked; an unknown deployment is 404; standard 403.
    const paper = await deployment("3commas");
    const notCustom = await call(granted, "POST", `/api/deployments/${paper}/link-bot`, { botId: managed.id });
    assert.deepEqual([notCustom.statusCode, notCustom.json().code], [409, "delivery_not_custom"]);
    const gone = await call(granted, "POST", `/api/deployments/${UNKNOWN_ID}/link-bot`, { botId: managed.id });
    assert.deepEqual([gone.statusCode, gone.json().code], [404, "deployment_not_found"]);
    const noGrant = await call(admin, "POST", linkUrl, { botId: managed.id });
    assert.deepEqual([noGrant.statusCode, noGrant.json().code, noGrant.json().tier], [400, "step_up_required", "grant"]);
    const audit = await listAdminAudit("platform.deployment_link_bot.", 20);
    assert.ok(audit.some((r) => r.action === "platform.deployment_link_bot.succeeded" && r.detail.botId === managed.id));

    // A secret pasted by hand ends the link.
    const pasted = await call(admin, "PATCH", `/api/deployments/${depId}`, { secret: "p".repeat(40), buyQuoteQty: 10 });
    assert.equal(pasted.statusCode, 200, pasted.body);
    row = (await query<{ secret: string; bot_id: string | null }>("SELECT secret, bot_id FROM deployments WHERE id = $1", [depId])).rows[0]!;
    assert.equal(row.bot_id, null);
  });

  await t.test("an uncertain create, retried: the Bot replays without the secret and the page is told it was not captured", async () => {
    bot.reset();
    resetBotControlStateForTests();
    const fields = { name: "Lost answer", pairs: ["BTCUSDT"], maxInvestmentPct: 5, stopLossPct: 3 };
    const requestId = rid("unc");
    bot.replies.push({ destroy: true });
    const first = await call(admin, "POST", "/api/bot/manage/bots", { requestId, ...fields, credential: { code: await freshCode() } });
    assert.deepEqual([first.statusCode, first.json().status], [202, "uncertain"]);
    const lost = bot.manage.issuedSecrets.at(-1)!;
    const c8 = await call(admin, "GET", `/api/bot/control/commands/${requestId}`);
    assert.equal(c8.json().status, "succeeded");
    assert.ok(!c8.body.includes(lost), "C8 carries only the Bot's secret-free record");

    const retried = await call(admin, "POST", "/api/bot/manage/bots", { requestId, ...fields, credential: { code: await freshCode() } });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json().result.secretIssued, true);
    assert.deepEqual(retried.json().result.platformSecret, { secretCaptured: false, linkedDeploymentsUpdated: 0, replayed: true });
    assert.equal(bot.manage.bots.size, 1, "never created twice");
    const stored = await query("SELECT 1 FROM bot_webhook_secrets WHERE bot_id = $1", [retried.json().result.bot.id]);
    assert.equal(stored.rows.length, 0);
  });

  await t.test("C13 delete is grant tier; refusals pass through; a deleted bot's secret is forgotten", async () => {
    bot.reset();
    resetBotControlStateForTests();
    const managed = bot.manage.addBot({ activeTrades: 2 });
    const granted = await withGrant();
    const url = `/api/bot/manage/bots/${managed.id}/delete`;
    const refused = await call(granted, "POST", url, { requestId: rid("del") });
    assert.deepEqual([refused.statusCode, refused.json().code], [409, "bot_has_open_trades"]);
    assert.match(refused.json().error, /active trade/);
    managed.activeTrades = 0;
    managed.unresolvedIntents = 1;
    const intents = await call(granted, "POST", url, { requestId: rid("del") });
    assert.equal(intents.json().code, "bot_has_unresolved_intents");
    managed.unresolvedIntents = 0;
    await query(`INSERT INTO bot_webhook_secrets (bot_id, secret_enc) VALUES ($1, 'enc:x')`, [managed.id]);
    const ok = await call(granted, "POST", url, { requestId: rid("del") });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(ok.json().result, { deleted: true });
    assert.equal((await query("SELECT 1 FROM bot_webhook_secrets WHERE bot_id = $1", [managed.id])).rows.length, 0);
  });

  await t.test("C15 list, C19 balance (and its exchange refusal), C16 remove (grant, typed confirmation)", async () => {
    bot.reset();
    resetBotControlStateForTests();
    const used = bot.manage.addAccount({ botsUsing: 1 });
    const free = bot.manage.addAccount({ name: "Spare", testnet: false });
    const list = await call(admin, "GET", "/api/bot/manage/accounts");
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().accounts.length, 2);

    const balance = await call(admin, "GET", `/api/bot/manage/accounts/${used.id}/balance`);
    assert.equal(balance.statusCode, 200, balance.body);
    assert.equal(balance.json().usdtFree, 812.5);
    bot.manage.failingBalances.add(used.id);
    const down = await call(admin, "GET", `/api/bot/manage/accounts/${used.id}/balance`);
    assert.deepEqual([down.statusCode, down.json().code], [502, "exchange_unavailable"]);
    const missing = await call(admin, "GET", `/api/bot/manage/accounts/${UNKNOWN_ID}/balance`);
    assert.deepEqual([missing.statusCode, missing.json().code], [404, "account_not_found"]);

    const granted = await withGrant();
    const noConfirm = await call(granted, "POST", `/api/bot/manage/accounts/${free.id}/delete`, { requestId: rid() });
    assert.equal(noConfirm.json().code, "invalid_request");
    const inUse = await call(granted, "POST", `/api/bot/manage/accounts/${used.id}/delete`,
      { requestId: rid("acc"), confirmation: "REMOVE_ACCOUNT" });
    assert.deepEqual([inUse.statusCode, inUse.json().code], [409, "account_in_use"]);
    const removed = await call(granted, "POST", `/api/bot/manage/accounts/${free.id}/delete`,
      { requestId: rid("acc"), confirmation: "REMOVE_ACCOUNT" });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(bot.manage.accounts.has(free.id), false);
  });

  await t.test("C17 enrollment: fresh, no-store, only on BOT_PUBLIC_ORIGIN, shown once, never audited", async () => {
    bot.reset();
    resetBotControlStateForTests();
    const acct = bot.manage.addAccount({ testnet: false });

    // Not configured: refused before step-up, so the code is still unused.
    config.botPublicOrigin = "";
    const code = await freshCode();
    const off = await call(admin, "POST", "/api/bot/manage/enrollments",
      { requestId: rid("enr"), purpose: "create", name: "Main", testnet: true, credential: { code } });
    assert.deepEqual([off.statusCode, off.json().code], [503, "enrollment_not_configured"]);
    config.botPublicOrigin = BOT_ORIGIN;

    const mainnet = await call(admin, "POST", "/api/bot/manage/enrollments",
      { requestId: rid("enr"), purpose: "create", name: "Real", testnet: false, credential: { code } });
    assert.deepEqual([mainnet.statusCode, mainnet.json().code], [400, "mainnet_confirmation_required"]);
    assert.equal(commandsSent(), 0);

    const granted = await withGrant();
    const grantOnly = await call(granted, "POST", "/api/bot/manage/enrollments",
      { requestId: rid("enr"), purpose: "create", name: "Main", testnet: true });
    assert.deepEqual([grantOnly.json().code, grantOnly.json().tier], ["step_up_required", "fresh"]);

    const requestId = rid("enr");
    const res = await call(admin, "POST", "/api/bot/manage/enrollments",
      { requestId, purpose: "replace", accountId: acct.id, mainnetConfirmation: "MAINNET", credential: { code: await freshCode() } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["cache-control"], "no-store");
    const link = bot.manage.issuedLinks.at(-1)!;
    assert.equal(res.json().result.enrollUrl, link);
    assert.ok(link.startsWith(`${BOT_ORIGIN}/enroll#t=`));
    assert.deepEqual(Object.keys(bot.commandRequests().at(-1)!.body as object).sort(),
      ["accountId", "actor", "mainnetConfirmation", "purpose"]);

    const replay = await call(admin, "POST", "/api/bot/manage/enrollments",
      { requestId, purpose: "replace", accountId: acct.id, mainnetConfirmation: "MAINNET", credential: { code: "000000" } });
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.json().result.linkUnavailable, true);
    assert.ok(!replay.body.includes(link.split("#t=")[1]!), "the replay cache never holds the link");

    const rows = await auditFor(requestId);
    assert.deepEqual(rows.map((r) => r.action), ["bot.enrollment_create.requested", "bot.enrollment_create.succeeded"]);
    assert.equal(rows[1]!.detail.enrollmentId, res.json().result.enrollmentId);
    assert.ok(!JSON.stringify(rows).includes(link.split("#t=")[1]!));

    // C18 reads the status.
    const status = await call(admin, "GET", `/api/bot/manage/enrollments/${res.json().result.enrollmentId}`);
    assert.deepEqual([status.statusCode, status.json().status, status.json().purpose], [200, "issued", "replace"]);
    const none = await call(admin, "GET", `/api/bot/manage/enrollments/${UNKNOWN_ID}`);
    assert.deepEqual([none.statusCode, none.json().code], [404, "enrollment_not_found"]);

    // A link on any other origin is never handed to the browser.
    bot.manage.publicOrigin = "https://evil.example.test";
    const wrong = await call(admin, "POST", "/api/bot/manage/enrollments",
      { requestId: rid("enr"), purpose: "create", name: "Main", testnet: true, credential: { code: await freshCode() } });
    assert.deepEqual([wrong.statusCode, wrong.json().code], [502, "enrollment_origin_mismatch"]);
    assert.ok(!wrong.body.includes("evil.example.test"));

    // reveal_webhook takes a bot id only.
    bot.manage.publicOrigin = BOT_ORIGIN;
    const managed = bot.manage.addBot();
    const reveal = await call(admin, "POST", "/api/bot/manage/enrollments",
      { requestId: rid("rev"), purpose: "reveal_webhook", botId: managed.id, credential: { code: await freshCode() } });
    assert.equal(reveal.statusCode, 200, reveal.body);
    assert.deepEqual(Object.keys(bot.commandRequests().at(-1)!.body as object).sort(), ["actor", "botId", "purpose"]);
  });

  await t.test("no secret or ticket reached an answer, an audit row or a log line", async () => {
    const answers = answered.join("\n");
    const audit = JSON.stringify(await listAdminAudit("", 2000));
    const logs = logged.join("");
    assert.ok(logs.length > 0, "the server did log");
    assert.ok(bot.manage.everIssuedSecrets.length >= 8);
    for (const secret of bot.manage.everIssuedSecrets) {
      assert.ok(!answers.includes(secret), "never in a browser answer");
      assert.ok(!audit.includes(secret), "never in admin_audit");
      assert.ok(!logs.includes(secret), "never in a log");
    }
    assert.ok(bot.manage.everIssuedLinks.length >= 3);
    for (const link of bot.manage.everIssuedLinks) {
      const ticket = link.split("#t=")[1]!;
      assert.ok(!audit.includes(ticket), "a ticket is never audited");
      assert.ok(!logs.includes(ticket), "a ticket is never logged");
    }
  });
});
