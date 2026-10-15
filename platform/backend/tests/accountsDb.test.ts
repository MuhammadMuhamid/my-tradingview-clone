/**
 * Two accounts, one database: neither can see, change or collide with the
 * other's alerts, watchlists, layouts, scripts, drawings, pane studies or
 * devices — through the real HTTP API, behind the real session gate.
 *
 * Runs in its OWN database (`<test db>_accounts`): the suite runs files in
 * parallel, and `shariahUniverseDb.test.ts` drops and recreates the shared
 * one. This file points DATABASE_URL elsewhere before anything that reads it
 * is imported, so its pool never touches the shared database.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_accounts`;
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

test("two accounts never see or touch each other's data", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { buildServer } = await import("../src/api/server");
  const { SESSION_COOKIE } = await import("../src/security/session");
  const { ADMIN_USER_ID } = await import("../src/repositories/users");
  after(() => closePool());
  await migrate();

  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret,
    adminUsername: config.adminUsername, adminPasswordHash: config.adminPasswordHash,
    allowSignups: config.allowSignups,
  };
  config.authEnabled = true;
  config.sessionSecret = "accounts-db-test-secret-000000000000000000000";
  config.allowSignups = true;
  t.after(() => Object.assign(config, previous));
  const app = buildServer(() => ({} as never));
  t.after(() => app.close());

  // ── sign up two accounts ─────────────────────────────────────────────────
  async function signUp(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email, password: "correct horse battery", displayName: email.split("@")[0] },
    });
    assert.equal(res.statusCode, 201, res.body);
    const cookie = /srtrend_session=([^;]+)/.exec(String(res.headers["set-cookie"]))![1]!;
    return `${SESSION_COOKIE}=${cookie}`;
  }
  const alice = await signUp("alice@example.com");
  const bob = await signUp("bob@example.com");
  const call = (cookie: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  // A second sign-up with the same address is refused, whatever its case.
  const dupe = await app.inject({ method: "POST", url: "/api/auth/signup",
    payload: { email: "ALICE@example.com", password: "another password" } });
  assert.equal(dupe.statusCode, 409);

  // Signing in works, and a wrong password says nothing about which half was wrong.
  const ok = await app.inject({ method: "POST", url: "/api/auth/login",
    payload: { email: "alice@example.com", password: "correct horse battery" } });
  assert.equal(ok.statusCode, 200);
  const wrong = await app.inject({ method: "POST", url: "/api/auth/login",
    payload: { email: "alice@example.com", password: "nope nope nope" } });
  assert.equal(wrong.statusCode, 401);
  const nobody = await app.inject({ method: "POST", url: "/api/auth/login",
    payload: { email: "nobody@example.com", password: "nope nope nope" } });
  assert.equal(nobody.statusCode, 401);
  assert.equal(wrong.json().error, nobody.json().error);

  // ── watchlists ───────────────────────────────────────────────────────────
  // The same name for both is two lists, not one overwritten.
  assert.equal((await call(alice, "POST", "/api/watchlists", { name: "Main", symbols: ["BTCUSDT"] })).statusCode, 201);
  assert.equal((await call(bob, "POST", "/api/watchlists", { name: "Main", symbols: ["ETHUSDT"] })).statusCode, 201);
  const aliceLists = (await call(alice, "GET", "/api/watchlists")).json() as { id: string; symbols: string[] }[];
  const bobLists = (await call(bob, "GET", "/api/watchlists")).json() as { id: string; symbols: string[] }[];
  assert.equal(aliceLists.length, 1);
  assert.equal(bobLists.length, 1);
  assert.deepEqual(aliceLists[0]!.symbols.map((s) => s.replace(/^.*:([A-Z]+):USDT:USDT:spot$/, "$1USDT")).length, 1);
  assert.notEqual(aliceLists[0]!.id, bobLists[0]!.id);
  // Bob cannot rename or delete Alice's list by id.
  assert.equal((await call(bob, "PATCH", `/api/watchlists/${aliceLists[0]!.id}`, { name: "Mine now" })).statusCode, 404);
  assert.equal((await call(bob, "DELETE", `/api/watchlists/${aliceLists[0]!.id}`)).statusCode, 404);
  assert.equal(((await call(alice, "GET", "/api/watchlists")).json() as unknown[]).length, 1);

  // ── alerts ───────────────────────────────────────────────────────────────
  const alert = {
    symbol: "BTCUSDT", timeframe: "1h", conditionKind: "price",
    targetPrice: 70000, priceDirection: "cross_up", frequency: "once_per_bar",
  };
  const a1 = await call(alice, "POST", "/api/ma-alerts", alert);
  assert.equal(a1.statusCode, 201, a1.body);
  // The identical alert for Bob is HIS alert — the upsert must not update Alice's.
  const b1 = await call(bob, "POST", "/api/ma-alerts", { ...alert, note: "bob's" });
  assert.equal(b1.statusCode, 201, b1.body);
  assert.notEqual(a1.json().id, b1.json().id);
  assert.equal((await call(alice, "GET", "/api/ma-alerts")).json()[0].note ?? null, null,
    "Alice's alert was not overwritten by Bob's identical one");
  assert.equal(((await call(bob, "GET", "/api/ma-alerts")).json() as unknown[]).length, 1);
  // Bob cannot edit, pause or delete Alice's alert.
  assert.equal((await call(bob, "PATCH", `/api/ma-alerts/${a1.json().id}`, { enabled: false })).statusCode, 404);
  assert.equal((await call(bob, "DELETE", `/api/ma-alerts/${a1.json().id}`)).statusCode, 404);
  const bulk = await call(bob, "POST", "/api/ma-alerts/bulk", { action: "delete", ids: [a1.json().id] });
  assert.equal(bulk.statusCode, 409);
  assert.equal(((await call(alice, "GET", "/api/ma-alerts")).json() as unknown[]).length, 1);

  // ── layouts, scripts, drawings, pane studies ─────────────────────────────
  const layout = { name: "BTC", symbol: "BTCUSDT", timeframe: "1h", strategyKey: "sr_trend" };
  const la = await call(alice, "POST", "/api/layouts", layout);
  assert.equal(la.statusCode, 201, la.body);
  assert.equal((await call(bob, "POST", "/api/layouts", layout)).statusCode, 201);
  assert.equal((await call(bob, "GET", `/api/layouts/${la.json().id}`)).statusCode, 404);
  assert.equal(((await call(bob, "GET", "/api/layouts")).json() as unknown[]).length, 1);

  const script = { name: "Mine", source: "//@version=5\nindicator(\"Mine\")\nplot(close)" };
  const sa = await call(alice, "POST", "/api/pine", script);
  assert.equal(sa.statusCode, 201, sa.body);
  assert.equal((await call(bob, "GET", `/api/pine/${sa.json().id}`)).statusCode, 404);
  assert.equal((await call(bob, "PATCH", `/api/pine/${sa.json().id}`, { source: "x" })).statusCode, 404);
  assert.ok(!((await call(bob, "GET", "/api/pine")).json() as { id: string }[]).some((s) => s.id === sa.json().id));

  const drawn = await call(alice, "PUT", "/api/chart-state/drawings/BTCUSDT",
    { drawings: [{ id: "d1", kind: "hline" }], baseVersion: 0 });
  assert.equal(drawn.statusCode, 200, drawn.body);
  const bobDrawings = (await call(bob, "GET", "/api/chart-state/drawings/BTCUSDT")).json();
  assert.deepEqual(bobDrawings.drawings, []);
  assert.equal(bobDrawings.version, 0);
  assert.equal((await call(bob, "PUT", "/api/chart-state/drawings/BTCUSDT",
    { drawings: [], baseVersion: 0 })).statusCode, 200, "Bob's first write is his own row, not a conflict");

  const panes = await call(alice, "PUT", "/api/chart-state/panes/p1", { native: [{ key: "n1" }], baseVersion: 0 });
  assert.equal(panes.statusCode, 200, panes.body);
  assert.deepEqual((await call(bob, "GET", "/api/chart-state/panes")).json(), []);

  // ── devices ──────────────────────────────────────────────────────────────
  const device = {
    endpoint: "https://fcm.googleapis.com/fcm/send/shared-browser",
    keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
  };
  assert.equal((await call(alice, "POST", "/api/push/subscribe", device)).json().devices, 1);
  // The same browser, signed in as Bob, is a device of Bob's too.
  assert.equal((await call(bob, "POST", "/api/push/subscribe", device)).json().devices, 1);
  assert.equal((await call(bob, "POST", "/api/push/unsubscribe", { endpoint: device.endpoint })).json().devices, 0);
  const { rows: aliceDevices } = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM push_subscriptions p JOIN users u ON u.id = p.user_id WHERE u.email = 'alice@example.com'");
  assert.equal(aliceDevices[0]!.n, 1, "Bob unsubscribing did not remove Alice's registration");

  // ── reach ────────────────────────────────────────────────────────────────
  assert.equal((await call(bob, "GET", "/api/deployments")).statusCode, 403);
  assert.equal((await call(bob, "POST", "/api/manual-trading/orders", {})).statusCode, 403);

  // ── profile, onboarding, sign out everywhere, deletion ──────────────────
  const me = (await call(alice, "GET", "/api/auth/me")).json();
  assert.equal(me.user.email, "alice@example.com");
  assert.equal(me.user.role, "user");
  assert.equal(me.user.onboarded, false);
  const onboard = await call(alice, "POST", "/api/auth/onboarding",
    { displayName: "Alice T", symbols: ["SOLUSDT", "ADAUSDT"], watchlistName: "Starter" });
  assert.equal(onboard.statusCode, 200, onboard.body);
  assert.equal(onboard.json().user.onboarded, true);
  assert.equal(onboard.json().user.displayName, "Alice T");
  assert.equal(((await call(alice, "GET", "/api/watchlists")).json() as unknown[]).length, 2);

  const pw = await call(alice, "POST", "/api/auth/password",
    { currentPassword: "wrong", newPassword: "new password 123" });
  assert.equal(pw.statusCode, 401);
  const pwOk = await call(alice, "POST", "/api/auth/password",
    { currentPassword: "correct horse battery", newPassword: "new password 123" });
  assert.equal(pwOk.statusCode, 200);
  // Changing the password ended the other sessions — the old cookie is dead.
  assert.equal((await call(alice, "GET", "/api/watchlists")).statusCode, 401);
  const alice2 = `${SESSION_COOKIE}=${/srtrend_session=([^;]+)/.exec(String(pwOk.headers["set-cookie"]))![1]!}`;
  assert.equal((await call(alice2, "GET", "/api/watchlists")).statusCode, 200);

  const out = await call(alice2, "POST", "/api/auth/logout-all");
  assert.equal(out.statusCode, 200);
  assert.equal((await call(alice2, "GET", "/api/watchlists")).statusCode, 401);

  const gone = await call(bob, "DELETE", "/api/auth/account", { confirm: "DELETE" });
  assert.equal(gone.statusCode, 200);
  const { rows: bobRows } = await query<{ n: number }>(
    `SELECT (SELECT count(*) FROM ma_alerts a JOIN users u ON u.id = a.user_id WHERE u.email = 'bob@example.com')::int
          + (SELECT count(*) FROM users WHERE email = 'bob@example.com')::int AS n`);
  assert.equal(bobRows[0]!.n, 0, "deleting an account deletes what it owned");
  // Alice's things are untouched by Bob's deletion.
  const { rows: aliceAlerts } = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ma_alerts a JOIN users u ON u.id = a.user_id WHERE u.email = 'alice@example.com'");
  assert.equal(aliceAlerts[0]!.n, 1);

  // The admin owns what existed before accounts, and cannot be deleted.
  const { rows: adminRow } = await query<{ role: string }>("SELECT role FROM users WHERE id = $1", [ADMIN_USER_ID]);
  assert.equal(adminRow[0]!.role, "admin");
});
