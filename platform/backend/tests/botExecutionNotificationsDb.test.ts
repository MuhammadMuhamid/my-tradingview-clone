/**
 * Bot execution push notifications (P-81), Platform half, through Postgres.
 *
 * What matters here:
 *   - nothing is polled until an admin opts in, and an older Bot (no
 *     `executions.v1`) is left alone;
 *   - a new reader starts from "now" (no backlog flood);
 *   - each Bot event is stored once, however often a page is re-read, and
 *     the cursor moves with it in one transaction;
 *   - only opted-in ADMINS are notified; a Standard user never is, even with a
 *     preference row, and cannot read or set the preference through the API;
 *   - a push outage is retried with backoff and never re-sends to someone
 *     already delivered; a too-old execution is stored but not pushed;
 *   - a Bot feed that went backwards resets the cursor; a malformed event is
 *     skipped without stalling the feed;
 *   - the notification says the environment (REAL only for MAINNET) and
 *     carries no ids in its URL.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives. No
 * network: the Bot feed and the push sender are fakes.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_bot_exec_notify`;
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

const NOW = new Date("2026-11-09T12:00:00.000Z");

function event(seq: number, extra: Record<string, unknown> = {}) {
  return {
    contractVersion: 1, type: "BOT_EXECUTION", seq, eventId: `strategy:intent-${seq}`, side: "BUY",
    symbol: "BTCUSDT", executedBaseQty: 0.00142, executedQuoteQty: 91.18, averagePrice: 64_211.27,
    environment: "TESTNET", source: "strategy", orderComplete: true, cumulativeBaseQty: 0.00142,
    botId: "11111111-1111-4111-8111-111111111111", botName: "Trend bot", smartTradeId: `trade-${seq}`,
    exchangeOrderId: String(9000 + seq), executedAt: new Date(NOW.getTime() - 30_000).toISOString(), ...extra,
  };
}

test("bot execution notifications", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const n = await import("../src/botExecutions/notifier");
  const { botNotificationRoutes } = await import("../src/api/routes/botNotifications");
  const Fastify = (await import("fastify")).default;
  after(() => closePool());
  await migrate();

  const user = async (role: "admin" | "user", email: string) => (await query<{ id: string }>(
    "INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id", [email, role])).rows[0]!.id;
  const adminA = await user("admin", "a@example.test");
  const adminB = await user("admin", "b@example.test");
  const standard = await user("user", "s@example.test");

  // ── fakes ──
  let feed: { latestSeq: number; pages: Record<string, { nextAfter: number; events: unknown[] }> } =
    { latestSeq: 0, pages: {} };
  const fetchCalls: Array<number | null> = [];
  let capabilities = ["executions.v1"];
  let now = NOW;
  const pushes: Array<{ userId: string; title: string; body: string; url?: string; tag?: string }> = [];
  let pushFailFor = new Set<string>();
  const warnings: string[] = [];
  const deps: import("../src/botExecutions/notifier").NotifierDeps = {
    fetchFeed: async (afterSeq) => {
      fetchCalls.push(afterSeq);
      if (afterSeq === null) return { latestSeq: feed.latestSeq, nextAfter: feed.latestSeq, events: [] };
      const page = feed.pages[String(afterSeq)] ?? { nextAfter: afterSeq, events: [] };
      return { latestSeq: feed.latestSeq, ...page };
    },
    readStatus: async () => ({ state: "CONNECTED", cause: null,
      status: { capabilities } as unknown as import("../src/operations/botStatus").BotControlStatus }),
    push: async (message, to) => {
      if (pushFailFor.has(to.userId)) return { sent: 0, pruned: 0, failed: 1 };
      pushes.push({ userId: to.userId, ...message });
      return { sent: 1, pruned: 0, failed: 0 };
    },
    now: () => now,
    log: { warn: (_o, m) => { warnings.push(m); } },
  };
  const stored = async () => (await query<{ event_id: string; notify_outcome: string | null }>(
    "SELECT event_id, notify_outcome FROM bot_execution_events ORDER BY seq")).rows;

  await t.test("validation: malformed events are refused, unknown additive fields dropped", () => {
    assert.equal(n.normalizeExecutionEvent({ ...event(1), futureField: "x" }).eventId, "strategy:intent-1");
    assert.equal("futureField" in n.normalizeExecutionEvent({ ...event(1), futureField: "x" }), false);
    for (const bad of [
      { contractVersion: 2 }, { side: "HOLD" }, { environment: "REAL" }, { executedBaseQty: 0 },
      { executedBaseQty: -1 }, { symbol: "btc/usdt" }, { eventId: "other:1" }, { executedAt: "yesterday" },
      { source: "webhook" }, { orderComplete: "yes" }, { botId: "has space" },
    ]) {
      assert.throws(() => n.normalizeExecutionEvent({ ...event(1), ...bad }), n.ExecutionFeedError, JSON.stringify(bad));
    }
  });

  await t.test("message: environment wording, REAL only for MAINNET, no ids in the URL", () => {
    const real = n.executionMessage(n.normalizeExecutionEvent(event(1, { environment: "MAINNET" })));
    assert.equal(real.title, "BUY executed · BTCUSDT · REAL");
    assert.match(real.body, /0\.00142 BTC at 64,211\.27 USDT \(91\.18 USDT\) · Strategy · Trend bot/);
    assert.equal(real.url, "/bot");
    assert.equal(n.executionMessage(n.normalizeExecutionEvent(event(1))).title, "BUY executed · BTCUSDT · TESTNET");
    assert.match(n.executionMessage(n.normalizeExecutionEvent(event(1, { environment: "DRY_RUN" }))).title, /DRY RUN/);
    assert.match(n.executionMessage(n.normalizeExecutionEvent(event(1, { environment: "UNKNOWN" }))).title,
      /ENVIRONMENT UNKNOWN/);
    const partial = n.executionMessage(n.normalizeExecutionEvent(event(1, {
      source: "manual", side: "SELL", orderComplete: false, executedBaseQty: 0.0005, cumulativeBaseQty: 0.0005,
      botName: "Manual" })));
    assert.match(partial.title, /^SELL executed/);
    assert.match(partial.body, /partial fill \(0\.0005 BTC so far\)/);
    const last = n.executionMessage(n.normalizeExecutionEvent(event(1, {
      source: "manual", orderComplete: true, executedBaseQty: 0.0005, cumulativeBaseQty: 0.001 })));
    assert.match(last.body, /last fill, order complete/);
    for (const m of [real, partial, last]) {
      assert.doesNotMatch(`${m.title}${m.body}${m.url}`, /trade-1|intent-1|1111|9001|secret/);
    }
  });

  await t.test("nobody opted in: nothing is polled and the cursor is forgotten", async () => {
    const result = await n.pollExecutionFeed(deps);
    assert.equal(result.state, "idle_no_subscribers");
    assert.equal(fetchCalls.length, 0);
    assert.equal(await n.readCursor(), null);
  });

  await t.test("an older Bot without executions.v1 is left alone", async () => {
    await n.writePreference(adminA, true);
    capabilities = ["bots.v1"];
    n.resetCapabilityCache();
    assert.equal((await n.pollExecutionFeed(deps)).state, "bot_unsupported");
    assert.equal(fetchCalls.length, 0);
    capabilities = ["bots.v1", "executions.v1"];
    n.resetCapabilityCache();
  });

  await t.test("a new reader starts from now: the backlog is not announced", async () => {
    feed = { latestSeq: 40, pages: {} };
    assert.equal((await n.pollExecutionFeed(deps)).state, "started");
    assert.deepEqual(fetchCalls, [null]);
    assert.equal(await n.readCursor(), 40);
    assert.equal((await stored()).length, 0);
  });

  await t.test("new events are stored once; a re-read page adds nothing", async () => {
    feed = { latestSeq: 42, pages: { "40": { nextAfter: 42, events: [event(41), event(42, { side: "SELL",
      source: "tpsl", eventId: "exit:attempt-42" })] } } };
    assert.equal((await n.pollExecutionFeed(deps)).stored, 2);
    assert.equal(await n.readCursor(), 42);
    // The Bot answers the same page again (a restart, a retry, a slow reply).
    feed.pages["42"] = { nextAfter: 42, events: [event(41), event(42, { side: "SELL", source: "tpsl",
      eventId: "exit:attempt-42" })] };
    assert.equal((await n.pollExecutionFeed(deps)).stored, 0);
    assert.equal((await stored()).length, 2);
  });

  await t.test("only opted-in admins are pushed; a Standard user never is", async () => {
    // A Standard user's preference row (it cannot be set through the API) must still not reach them.
    await query("INSERT INTO bot_execution_notification_prefs (user_id, enabled) VALUES ($1, true)", [standard]);
    assert.equal(await n.dispatchPendingNotifications(deps), 2);
    assert.deepEqual([...new Set(pushes.map((p) => p.userId))], [adminA]);
    assert.deepEqual(pushes.map((p) => p.title), ["BUY executed · BTCUSDT · TESTNET", "SELL executed · BTCUSDT · TESTNET"]);
    assert.ok(pushes.every((p) => p.tag?.startsWith("bot-exec-") && p.url === "/bot"));
    assert.deepEqual((await stored()).map((r) => r.notify_outcome), ["sent", "sent"]);
    // Nothing is re-sent on the next tick.
    assert.equal(await n.dispatchPendingNotifications(deps), 0);
    assert.equal(pushes.length, 2);
  });

  await t.test("push outage: retried with backoff, delivered recipients are not re-sent, then given up", async () => {
    await n.writePreference(adminB, true);
    pushes.length = 0;
    pushFailFor = new Set([adminB]);
    feed = { latestSeq: 43, pages: { "42": { nextAfter: 43, events: [event(43)] } } };
    await n.pollExecutionFeed(deps);
    await n.dispatchPendingNotifications(deps);
    assert.deepEqual(pushes.map((p) => p.userId), [adminA]);
    assert.equal((await stored()).at(-1)!.notify_outcome, null, "still pending for admin B");
    // Inside the backoff window: not attempted again.
    now = new Date(NOW.getTime() + 10_000);
    await n.dispatchPendingNotifications(deps);
    assert.equal(pushes.length, 1);
    // After the backoff, the push service is back: only admin B is sent.
    pushFailFor = new Set();
    now = new Date(NOW.getTime() + 31_000);
    await n.dispatchPendingNotifications(deps);
    assert.deepEqual(pushes.map((p) => p.userId), [adminA, adminB]);
    assert.equal((await stored()).at(-1)!.notify_outcome, "sent");

    // A permanently failing recipient: three attempts, then given up.
    pushFailFor = new Set([adminA, adminB]);
    feed = { latestSeq: 44, pages: { "43": { nextAfter: 44, events: [event(44)] } } };
    await n.pollExecutionFeed(deps);
    for (const offset of [0, 31_000, 92_000, 300_000]) {
      now = new Date(NOW.getTime() + 400_000 + offset);
      await n.dispatchPendingNotifications(deps);
    }
    assert.equal((await stored()).at(-1)!.notify_outcome, "gave_up");
    pushFailFor = new Set();
    now = NOW;
  });

  await t.test("an execution too old when first seen is stored but not pushed", async () => {
    pushes.length = 0;
    feed = { latestSeq: 45, pages: { "44": { nextAfter: 45, events: [event(45, {
      executedAt: new Date(NOW.getTime() - 7 * 3_600_000).toISOString() })] } } };
    await n.pollExecutionFeed(deps);
    await n.dispatchPendingNotifications(deps);
    assert.equal(pushes.length, 0);
    assert.equal((await stored()).at(-1)!.notify_outcome, "expired");
  });

  await t.test("review fix: an event that aged past 6 h while pending expires instead of a late push", async () => {
    pushes.length = 0;
    pushFailFor = new Set([adminA, adminB]);
    feed = { latestSeq: 46, pages: { "45": { nextAfter: 46, events: [event(46, { eventId: "strategy:aging" })] } } };
    await n.pollExecutionFeed(deps);
    await n.dispatchPendingNotifications(deps); // push service down: still pending
    pushFailFor = new Set();
    now = new Date(NOW.getTime() + 7 * 3_600_000);
    await n.dispatchPendingNotifications(deps);
    assert.equal(pushes.length, 0);
    assert.equal((await query<{ notify_outcome: string }>(
      "SELECT notify_outcome FROM bot_execution_events WHERE event_id = 'strategy:aging'")).rows[0]!.notify_outcome, "expired");
    now = NOW;
  });

  await t.test("review fix: a row that throws does not hold up the rows after it", async () => {
    pushes.length = 0;
    await query(`INSERT INTO bot_execution_events (event_id, seq, side, symbol, environment, executed_at, payload)
                 VALUES ('strategy:broken', 100, 'BUY', 'BTCUSDT', 'TESTNET', $1, '{}')`, [NOW]);
    await query(`INSERT INTO bot_execution_events (event_id, seq, side, symbol, environment, executed_at, payload)
                 VALUES ('strategy:after-broken', 101, 'BUY', 'BTCUSDT', 'TESTNET', $1, $2)`,
      [NOW, JSON.stringify(n.normalizeExecutionEvent(event(101, { eventId: "strategy:after-broken" })))]);
    await n.dispatchPendingNotifications(deps);
    assert.deepEqual((await query<{ notify_outcome: string }>(
      "SELECT notify_outcome FROM bot_execution_events WHERE event_id = 'strategy:after-broken'")).rows[0]!.notify_outcome,
      "sent", "the good row after the broken one was delivered");
    assert.equal(pushes.length, 2, "one push per opted-in admin");
    assert.ok(warnings.includes("bot execution notification failed"));
    await query("DELETE FROM bot_execution_events WHERE event_id = 'strategy:broken'");
  });

  await t.test("opted in but no registered device: recorded as no_devices, not sent", async () => {
    const realPush = deps.push;
    deps.push = async () => ({ sent: 0, pruned: 0, failed: 0 });
    await query(`INSERT INTO bot_execution_events (event_id, seq, side, symbol, environment, executed_at, payload)
                 VALUES ('strategy:nodevice', 102, 'BUY', 'BTCUSDT', 'TESTNET', $1, $2)`,
      [NOW, JSON.stringify(n.normalizeExecutionEvent(event(102, { eventId: "strategy:nodevice" })))]);
    await n.dispatchPendingNotifications(deps);
    deps.push = realPush;
    assert.equal((await query<{ notify_outcome: string }>(
      "SELECT notify_outcome FROM bot_execution_events WHERE event_id = 'strategy:nodevice'")).rows[0]!.notify_outcome, "no_devices");
  });

  await t.test("a malformed event is skipped and the feed keeps moving", async () => {
    feed = { latestSeq: 47, pages: { "46": { nextAfter: 47, events: [{ ...event(47), eventId: "strategy:bad", side: "HOLD" }, event(47)] } } };
    assert.equal((await n.pollExecutionFeed(deps)).stored, 1);
    assert.equal(await n.readCursor(), 47);
    assert.ok(warnings.includes("bot execution event rejected"));
  });

  await t.test("a Bot feed that went backwards (restored database) resets the cursor", async () => {
    feed = { latestSeq: 3, pages: {} };
    await n.pollExecutionFeed(deps);
    assert.equal(await n.readCursor(), 3);
    assert.ok(warnings.includes("bot execution feed restarted; cursor reset"));
  });

  await t.test("routes: admin reads and sets the preference; a Standard user gets 403", async () => {
    const previousAuth = config.authEnabled;
    config.authEnabled = true;
    t.after(() => { config.authEnabled = previousAuth; });
    const app = Fastify({ logger: false });
    let as: { id: string; role: "admin" | "user" } | null = null;
    app.decorateRequest("user", null);
    app.addHook("onRequest", async (req) => { req.user = as ? { ...as, sessionVersion: 1 } : null; });
    await botNotificationRoutes(app, { feedSupport: async () => "yes" });
    t.after(() => app.close());

    as = { id: standard, role: "user" };
    assert.equal((await app.inject({ method: "GET", url: "/api/bot/notifications" })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: "/api/bot/notifications", payload: { enabled: true } }))
      .statusCode, 403);

    as = { id: adminB, role: "admin" };
    for (const payload of [{}, { enabled: "yes" }, { enabled: true, extra: 1 }]) {
      assert.equal((await app.inject({ method: "PUT", url: "/api/bot/notifications", payload })).statusCode, 400);
    }
    const off = await app.inject({ method: "PUT", url: "/api/bot/notifications", payload: { enabled: false } });
    assert.equal(off.statusCode, 200);
    const status = (await app.inject({ method: "GET", url: "/api/bot/notifications" })).json() as {
      featureEnabled: boolean; botFeed: string; enabled: boolean; devices: number; recent: Array<{ symbol: string }> };
    assert.equal(status.enabled, false);
    assert.equal(status.botFeed, "yes");
    assert.ok(status.recent.length > 0 && status.recent.length <= 10);
    assert.doesNotMatch(JSON.stringify(status), /trade-4|1111-4111|botId|smartTradeId|exchangeOrderId/);
  });

  await t.test("deleting an account removes its preference and deliveries", async () => {
    await query("DELETE FROM users WHERE id = $1", [adminB]);
    assert.equal((await query("SELECT 1 FROM bot_execution_notification_prefs WHERE user_id = $1", [adminB])).rowCount, 0);
    assert.equal((await query("SELECT 1 FROM bot_execution_deliveries WHERE user_id = $1", [adminB])).rowCount, 0);
  });
});
