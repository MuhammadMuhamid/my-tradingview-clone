/**
 * Ten Standard users, one admin, and the signed-out / stale / unverified
 * identities: each sees and controls only their own data, through the real
 * HTTP API behind the real session gate, against a real PostgreSQL.
 *
 * For every user-owned resource a Standard user can reach, this proves:
 *  (a) each user can create / read / update / delete their own;
 *  (b) no other user can list, read, update or delete it — by real id, a
 *      guessed UUID, a body field naming another owner, a different verb, a
 *      list endpoint, or a nested id;
 *  (c) signed-out → 401, a stale (bumped-version) cookie → 401;
 *  (d) account switch on one client: B's response carries none of A's data;
 *  (e) ten users read and write their own in parallel with no contamination;
 *  (f) admin-only areas → 403 for a Standard user;
 *  (g) the admin's own scope, recorded from what the code does.
 * Plus: every row a user created carries that user's id (checked in the DB),
 * and an alert owned by A delivers only to A's push subscriptions.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_ten_user_iso`;
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

const GUESS_UUID = "99999999-9999-4999-8999-999999999999";
const DEVICE = (tag: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${tag}`,
  keys: {
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  },
});

test("ten Standard users each see and control only their own data", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { buildServer } = await import("../src/api/server");
  const { SESSION_COOKIE, signUserSession, hashPassword } = await import("../src/security/session");
  const { loginLimiter } = await import("../src/security/rateLimit");
  const pushRepo = await import("../src/repositories/pushSubscriptions");
  const { ADMIN_USER_ID: ADMIN_ID } = await import("../src/repositories/users");
  after(() => closePool());
  await migrate();

  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    adminUsername: config.adminUsername, adminPasswordHash: config.adminPasswordHash, emailFrom: config.emailFrom,
  };
  const SECRET = "ten-user-iso-test-secret-00000000000000000000";
  Object.assign(config, {
    authEnabled: true, sessionSecret: SECRET, allowSignups: true,
    adminUsername: "owner", adminPasswordHash: hashPassword("owner password"), emailFrom: "",
  });
  t.after(() => Object.assign(config, previous));
  const app = buildServer(() => ({} as never));
  t.after(() => app.close());

  const cookieOf = (res: { headers: Record<string, unknown> }) => {
    const found = [res.headers["set-cookie"]].flat().filter(Boolean)
      .map((c) => /^srtrend_session=([^;]+)/.exec(String(c))?.[1]).find(Boolean);
    return found ? `${SESSION_COOKIE}=${found}` : null;
  };
  const call = (cookie: string | null, method: string, url: string, payload?: unknown) => {
    loginLimiter.reset("127.0.0.1");
    return app.inject({
      method: method as "GET", url,
      ...(cookie ? { headers: { cookie } } : {}),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  };

  interface User { email: string; cookie: string; id: string; n: number }
  const signUp = async (n: number): Promise<User> => {
    const email = `user${n}@example.com`;
    const res = await call(null, "POST", "/api/auth/signup", { email, password: "correct horse battery", displayName: `User ${n}` });
    assert.equal(res.statusCode, 201, res.body);
    return { email, cookie: cookieOf(res)!, id: (res.json() as { user: { id: string } }).user.id, n };
  };

  // ── 10 Standard users, 1 admin, and the three edge identities ──────────────
  const users: User[] = [];
  for (let n = 0; n < 10; n += 1) users.push(await signUp(n));
  const adminCookie = cookieOf(await call(null, "POST", "/api/auth/login", { username: "owner", password: "owner password" }))!;
  const signedOut: string | null = null;

  // Stale cookie: a session signed under a version the account has moved past.
  // A dedicated account, never one of the ten, so bumping it invalidates only
  // this cookie and not a real user's session used elsewhere.
  const stale = await signUp(98);
  const staleCookie = `${SESSION_COOKIE}=${signUserSession(stale.id, 1, SECRET)}`; // version 1…
  await query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [stale.id]); // …now 2
  const { forgetUser } = await import("../src/security/requestUser");
  forgetUser(stale.id);

  // Unverified identity: a fresh sign-up has emailVerified=false. Its session
  // is valid for the chart; money/2FA features are what verification gates.
  const unverified = await signUp(99);
  assert.equal((await call(unverified.cookie, "GET", "/api/auth/me")).json().user.emailVerified, false);

  // ── resource matrix: create-own, then every cross-owner probe ──────────────
  interface Resource {
    name: string;
    table: string;
    create: (u: User) => Promise<unknown>;          // returns created id (or null)
    /** A create by `attacker` whose body names `victim` as the owner; returns the new id. */
    forge: (attacker: User, victim: User) => Promise<unknown>;
    /** An update of the caller's OWN row whose body names `victim` as the owner. */
    forgeUpdate: (attacker: User, id: unknown, victim: User) => Promise<{ statusCode: number; body: string }>;
    listOwn: (u: User) => Promise<{ id: string }[]>; // the owner's list
    probes: (ownerId: unknown, victim: User, attacker: User) => { label: string; run: () => Promise<{ statusCode: number; body: string }> }[];
  }

  /** Every spelling of "the owner is someone else" a body could carry. */
  const namesOwner = (owner: string, extra: object) =>
    ({ ...extra, userId: owner, user_id: owner, owner, ownerId: owner });

  const resources: Resource[] = [
    {
      name: "watchlist",
      table: "watchlists",
      create: async (u) => (await call(u.cookie, "POST", "/api/watchlists", { name: `WL-${u.n}`, symbols: [`SYM${u.n}USDT`] })).json().id,
      forge: async (a, v) => (await call(a.cookie, "POST", "/api/watchlists", namesOwner(v.id, { name: `FORGED-WL-${a.n}`, symbols: ["FRGUSDT"] }))).json().id,
      forgeUpdate: async (a, id, v) => await call(a.cookie, "PATCH", `/api/watchlists/${id}`, namesOwner(v.id, { name: `FORGED-WL-${a.n}-renamed` })),
      listOwn: async (u) => (await call(u.cookie, "GET", "/api/watchlists")).json() as { id: string }[],
      probes: (id, victim, attacker) => [
        { label: "read by id (PATCH)", run: async () => await call(attacker.cookie, "PATCH", `/api/watchlists/${id}`, { name: "stolen" }) },
        { label: "delete by id", run: async () => await call(attacker.cookie, "DELETE", `/api/watchlists/${id}`) },
        { label: "guessed uuid patch", run: async () => await call(attacker.cookie, "PATCH", `/api/watchlists/${GUESS_UUID}`, { name: "x" }) },
        { label: "body names owner", run: async () => await call(attacker.cookie, "PATCH", `/api/watchlists/${id}`, namesOwner(victim.id, { name: "x" })) },
      ],
    },
    {
      name: "layout",
      table: "chart_layouts",
      create: async (u) => (await call(u.cookie, "POST", "/api/layouts", { name: `LO-${u.n}`, symbol: "BTCUSDT", timeframe: "1h", strategyKey: "sr_trend" })).json().id,
      forge: async (a, v) => (await call(a.cookie, "POST", "/api/layouts", namesOwner(v.id, { name: `FORGED-LO-${a.n}`, symbol: "BTCUSDT", timeframe: "1h", strategyKey: "sr_trend" }))).json().id,
      forgeUpdate: async (a, id, v) => await call(a.cookie, "PATCH", `/api/layouts/${id}`, namesOwner(v.id, { name: `FORGED-LO-${a.n}-renamed` })),
      listOwn: async (u) => (await call(u.cookie, "GET", "/api/layouts")).json() as { id: string }[],
      probes: (id, victim, attacker) => [
        { label: "GET by id", run: async () => await call(attacker.cookie, "GET", `/api/layouts/${id}`) },
        { label: "PATCH by id", run: async () => await call(attacker.cookie, "PATCH", `/api/layouts/${id}`, { name: "stolen" }) },
        { label: "DELETE by id", run: async () => await call(attacker.cookie, "DELETE", `/api/layouts/${id}`) },
        { label: "guessed uuid GET", run: async () => await call(attacker.cookie, "GET", `/api/layouts/${GUESS_UUID}`) },
        { label: "body names owner", run: async () => await call(attacker.cookie, "PATCH", `/api/layouts/${id}`, namesOwner(victim.id, { name: "x" })) },
      ],
    },
    {
      name: "pine",
      table: "pine_scripts",
      create: async (u) => (await call(u.cookie, "POST", "/api/pine", { name: `PS-${u.n}`, source: "//@version=5\nindicator(\"x\")\nplot(close)" })).json().id,
      forge: async (a, v) => (await call(a.cookie, "POST", "/api/pine", namesOwner(v.id, { name: `FORGED-PS-${a.n}`, source: "//@version=5\nindicator(\"f\")\nplot(close)" }))).json().id,
      forgeUpdate: async (a, id, v) => await call(a.cookie, "PATCH", `/api/pine/${id}`, namesOwner(v.id, { name: `FORGED-PS-${a.n}-renamed` })),
      listOwn: async (u) => (await call(u.cookie, "GET", "/api/pine")).json() as { id: string }[],
      probes: (id, victim, attacker) => [
        { label: "GET by id", run: async () => await call(attacker.cookie, "GET", `/api/pine/${id}`) },
        { label: "PATCH by id", run: async () => await call(attacker.cookie, "PATCH", `/api/pine/${id}`, { source: "//@version=5\nindicator(\"y\")\nplot(open)" }) },
        { label: "DELETE by id", run: async () => await call(attacker.cookie, "DELETE", `/api/pine/${id}`) },
        { label: "body names owner", run: async () => await call(attacker.cookie, "PATCH", `/api/pine/${id}`, namesOwner(victim.id, { name: "x" })) },
      ],
    },
    {
      name: "ma-alert",
      table: "ma_alerts",
      create: async (u) => (await call(u.cookie, "POST", "/api/ma-alerts", {
        symbol: "BTCUSDT", timeframe: "1h", conditionKind: "price",
        targetPrice: 70000 + u.n, priceDirection: "cross_up", frequency: "once_per_bar",
      })).json().id,
      forge: async (a, v) => (await call(a.cookie, "POST", "/api/ma-alerts", namesOwner(v.id, {
        symbol: "BTCUSDT", timeframe: "1h", conditionKind: "price",
        targetPrice: 80000 + a.n, priceDirection: "cross_up", frequency: "once_per_bar",
      }))).json().id,
      forgeUpdate: async (a, id, v) => await call(a.cookie, "PATCH", `/api/ma-alerts/${id}`, namesOwner(v.id, { enabled: false })),
      listOwn: async (u) => (await call(u.cookie, "GET", "/api/ma-alerts")).json() as { id: string }[],
      probes: (id, victim, attacker) => [
        { label: "PATCH by id", run: async () => await call(attacker.cookie, "PATCH", `/api/ma-alerts/${id}`, { enabled: false }) },
        { label: "DELETE by id", run: async () => await call(attacker.cookie, "DELETE", `/api/ma-alerts/${id}`) },
        { label: "bulk delete foreign id", run: async () => await call(attacker.cookie, "POST", "/api/ma-alerts/bulk", { action: "delete", ids: [id] }) },
        { label: "bulk-edit foreign id", run: async () => await call(attacker.cookie, "POST", "/api/ma-alerts/bulk-edit", { ids: [id], patch: { enabled: false } }) },
        { label: "body names owner", run: async () => await call(attacker.cookie, "PATCH", `/api/ma-alerts/${id}`, namesOwner(victim.id, { enabled: false })) },
      ],
    },
  ];

  // ── (a) + (b): each user owns one of each; nobody else can touch it ────────
  const createdIds = new Map<string, Map<number, unknown>>();
  await t.test("(a) each user creates and reads their own, and the DB row carries their id", async () => {
    await query("INSERT INTO symbols (symbol, base_asset, quote_asset) VALUES ('BTCUSDT','BTC','USDT') ON CONFLICT DO NOTHING");
    for (const r of resources) {
      const ids = new Map<number, unknown>();
      for (const u of users) {
        const id = await r.create(u);
        assert.ok(id, `${u.email} could not create its own ${r.name}`);
        ids.set(u.n, id);
        const own = await r.listOwn(u);
        assert.equal(own.length, 1, `${u.email} ${r.name}: own list should hold exactly its one row, had ${own.length}`);
      }
      createdIds.set(r.name, ids);
    }
    // Direct DB check: every owned row carries its creator's id.
    for (const [table, col] of [["watchlists", "user_id"], ["chart_layouts", "user_id"], ["pine_scripts", "user_id"], ["ma_alerts", "user_id"]] as const) {
      for (const u of users) {
        const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [u.id]);
        assert.ok(rows[0]!.n >= 1, `${table}: no row carries ${u.email}'s id`);
      }
    }
  });

  await t.test("(b) no other user can read, update or delete it, by any route", async () => {
    const failures: string[] = [];
    for (const r of resources) {
      const ids = createdIds.get(r.name)!;
      for (const victim of users) {
        const id = ids.get(victim.n);
        const attacker = users[(victim.n + 1) % users.length]!; // a different real user
        for (const p of r.probes(id, victim, attacker)) {
          const res = await p.run();
          // Allowed outcomes: 404 (hidden), 403 (refused), 409 (bulk refuses foreign ids). Never 200/204.
          if (![403, 404, 409].includes(res.statusCode)) {
            failures.push(`${r.name}: ${attacker.email} vs ${victim.email} [${p.label}] got ${res.statusCode} ${res.body.slice(0, 80)}`);
          }
        }
        // The victim's row still exists and is unchanged in count.
        const own = await r.listOwn(victim);
        if (own.length !== 1) failures.push(`${r.name}: ${victim.email} lost/gained rows after attacks: now ${own.length}`);
      }
    }
    assert.deepEqual(failures, [], `cross-owner access was not refused:\n${failures.join("\n")}`);
  });

  await t.test("(b) a body naming another owner creates and updates only the CALLER's row", async () => {
    const failures: string[] = [];
    const updateOutcomes = new Set<string>();
    const ownerOf = async (table: string, id: unknown) =>
      (await query<{ user_id: string }>(`SELECT user_id FROM ${table} WHERE id = $1`, [id])).rows[0]?.user_id;
    for (const r of resources) {
      for (const victim of users) {
        const attacker = users[(victim.n + 1) % users.length]!;
        const victimBefore = (await r.listOwn(victim)).map((x) => x.id);
        const forged = await r.forge(attacker, victim);
        if (!forged) { failures.push(`${r.name}: ${attacker.email}'s forged create returned no id`); continue; }
        const owner = await ownerOf(r.table, forged);
        if (owner !== attacker.id) {
          failures.push(`${r.name}: create by ${attacker.email} naming ${victim.email} stored user_id=${owner}, want the attacker's`);
        }
        const victimAfter = (await r.listOwn(victim)).map((x) => x.id);
        if (victimAfter.includes(String(forged)) || victimAfter.length !== victimBefore.length) {
          failures.push(`${r.name}: ${victim.email}'s list changed after ${attacker.email}'s forged create`);
        }
        if (!(await r.listOwn(attacker)).some((x) => x.id === forged)) {
          failures.push(`${r.name}: ${attacker.email} cannot see the row it created`);
        }
        // Updating its OWN row with a body naming the victim moves nothing. The
        // route may ignore the owner fields (200) or refuse them (400, as the
        // alert route does: "not editable"); either way the row stays put.
        const upd = await r.forgeUpdate(attacker, forged, victim);
        updateOutcomes.add(`${r.name}=${upd.statusCode}`);
        if (upd.statusCode !== 200 && upd.statusCode !== 400) {
          failures.push(`${r.name}: ${attacker.email}'s own update answered ${upd.statusCode} ${upd.body.slice(0, 80)}`);
        }
        const ownerAfterUpdate = await ownerOf(r.table, forged);
        if (ownerAfterUpdate !== attacker.id) {
          failures.push(`${r.name}: update naming ${victim.email} moved the row to user_id=${ownerAfterUpdate}`);
        }
      }
    }

    // Push subscriptions, pane studies and drawings: the same, by their own keys.
    const countFor = async (table: string, userId: string, extra = "", params: unknown[] = []) =>
      (await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1 ${extra}`, [userId, ...params])).rows[0]!.n;
    for (const victim of users) {
      const attacker = users[(victim.n + 1) % users.length]!;
      const endpoint = DEVICE(`forged-${attacker.n}`).endpoint;
      const sub = await call(attacker.cookie, "POST", "/api/push/subscribe", namesOwner(victim.id, DEVICE(`forged-${attacker.n}`)));
      if (sub.statusCode !== 201) failures.push(`push: ${attacker.email} subscribe answered ${sub.statusCode}`);
      const { rows: subOwners } = await query<{ user_id: string }>("SELECT user_id FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
      if (subOwners.length !== 1 || subOwners[0]!.user_id !== attacker.id) {
        failures.push(`push: subscribe by ${attacker.email} naming ${victim.email} stored owners ${JSON.stringify(subOwners)}`);
      }
      if ((await pushRepo.listSubscriptions(victim.id)).some((x) => x.endpoint === endpoint)) {
        failures.push(`push: ${victim.email}'s devices include ${attacker.email}'s forged endpoint`);
      }

      const scope = `f${attacker.n}`;
      const pane = await call(attacker.cookie, "PUT", `/api/chart-state/panes/${scope}`,
        namesOwner(victim.id, { native: [{ key: `forged-${attacker.n}` }], baseVersion: 0 }));
      if (pane.statusCode !== 200) failures.push(`panes: ${attacker.email} PUT answered ${pane.statusCode} ${pane.body.slice(0, 80)}`);
      const { rows: paneOwners } = await query<{ user_id: string }>("SELECT user_id FROM chart_pane_studies WHERE scope = $1", [scope]);
      if (paneOwners.length !== 1 || paneOwners[0]!.user_id !== attacker.id) {
        failures.push(`panes: PUT by ${attacker.email} naming ${victim.email} stored owners ${JSON.stringify(paneOwners)}`);
      }
      if (JSON.stringify((await call(victim.cookie, "GET", `/api/chart-state/panes/${scope}`)).json()).includes(`forged-${attacker.n}`)) {
        failures.push(`panes: ${victim.email} reads ${attacker.email}'s forged pane ${scope}`);
      }

      const victimDrawings = await countFor("chart_drawings", victim.id);
      const attackerDrawings = await countFor("chart_drawings", attacker.id);
      const drew = await call(attacker.cookie, "PUT", "/api/chart-state/drawings/ETHUSDT",
        namesOwner(victim.id, { drawings: [{ id: `forged-${attacker.n}`, kind: "hline" }], baseVersion: 0 }));
      if (drew.statusCode !== 200) failures.push(`drawings: ${attacker.email} PUT answered ${drew.statusCode} ${drew.body.slice(0, 80)}`);
      if (await countFor("chart_drawings", victim.id) !== victimDrawings) {
        failures.push(`drawings: PUT by ${attacker.email} naming ${victim.email} added a row to the victim`);
      }
      if (await countFor("chart_drawings", attacker.id) !== attackerDrawings + 1) {
        failures.push(`drawings: PUT by ${attacker.email} did not land on the attacker`);
      }
    }
    t.diagnostic(`own-row update naming another owner, status per resource: ${[...updateOutcomes].join(", ")}`);
    assert.deepEqual(failures, [], `a body owner field was honoured:\n${failures.join("\n")}`);
  });

  await t.test("(b) alert events: both list branches and every limit show only the caller's", async () => {
    // Seeded through the repository function the alert runner itself writes
    // events with (`MaAlertRunnerDependencies.createEvent`), two per user, on
    // the user's own alert.
    const { createEvent } = await import("../src/repositories/maAlerts");
    const alertOf = createdIds.get("ma-alert")!;
    for (const u of users) {
      for (const k of [0, 1]) {
        await createEvent({
          alertId: String(alertOf.get(u.n)), barTime: Date.UTC(2026, 10, 1, u.n, k), price: 70000 + u.n,
          maValue: 70000 + u.n, distancePct: 0, title: `EVENT-U${u.n}-${k}`, body: `owner user${u.n}`,
          pushedTo: 0, pushFailed: 0, pushPruned: 0, deliveryStatus: "no_devices",
          intrabar: false, frequency: "once_per_bar",
        });
      }
    }
    const failures: string[] = [];
    for (const u of users) {
      const own = new Set((await call(u.cookie, "GET", "/api/ma-alerts")).json().map((a: { id: string }) => a.id));
      for (const url of [
        "/api/ma-alerts/events?limit=500",                                     // unscoped branch
        "/api/ma-alerts/events?symbol=BTCUSDT&timeframe=1h&limit=500",         // scoped branch
        "/api/ma-alerts/events?limit=1",                                       // the smallest page
        "/api/ma-alerts/events?symbol=BTCUSDT&timeframe=1h&limit=1",
        "/api/ma-alerts/events",                                               // the default page
      ]) {
        const events = (await call(u.cookie, "GET", url)).json() as { alertId: string; title: string }[];
        const foreign = events.filter((e) => !own.has(e.alertId) || !e.title.startsWith(`EVENT-U${u.n}-`));
        if (foreign.length > 0) failures.push(`${u.email} ${url}: saw ${foreign.map((e) => e.title).join(",")}`);
        const want = url.includes("limit=1") ? 1 : 2;
        if (events.length !== want) failures.push(`${u.email} ${url}: ${events.length} events, want ${want} of its own`);
      }
    }
    assert.deepEqual(failures, [], `alert events crossed owners:\n${failures.join("\n")}`);
  });

  await t.test("(b) list and nested-id endpoints never show another owner's rows", async () => {
    const a = users[2]!, b = users[3]!;
    // drawings are a nested id (symbol); A writes, B must see an empty own row.
    const drew = await call(a.cookie, "PUT", "/api/chart-state/drawings/BTCUSDT", { drawings: [{ id: "d1", kind: "hline" }], baseVersion: 0 });
    assert.equal(drew.statusCode, 200, drew.body);
    const bView = (await call(b.cookie, "GET", "/api/chart-state/drawings/BTCUSDT")).json();
    assert.deepEqual(bView.drawings, [], "B saw A's drawings on the same nested symbol id");
    assert.equal(bView.version, 0);
    // The drawn-instruments list is the caller's: A draws on a symbol nobody else uses.
    assert.equal((await call(a.cookie, "PUT", "/api/chart-state/drawings/SOLUSDT",
      { drawings: [{ id: "only-a", kind: "hline" }], baseVersion: 0 })).statusCode, 200);
    assert.match(JSON.stringify((await call(a.cookie, "GET", "/api/chart-state/instruments")).json()), /SOL/);
    for (const other of users.filter((u) => u.id !== a.id)) {
      assert.doesNotMatch(JSON.stringify((await call(other.cookie, "GET", "/api/chart-state/instruments")).json()), /SOL/,
        `${other.email}'s drawn-instruments list shows ${a.email}'s SOLUSDT`);
    }
    // Pane studies on the same scope id are two rows, one each.
    assert.equal((await call(a.cookie, "PUT", "/api/chart-state/panes/p7", { native: [{ key: "a-secret" }], baseVersion: 0 })).statusCode, 200);
    const bPane = (await call(b.cookie, "GET", "/api/chart-state/panes/p7")).json();
    assert.doesNotMatch(JSON.stringify(bPane), /a-secret/, "B read A's pane studies on the same scope");
    assert.equal(bPane.version, 0);
    assert.doesNotMatch(JSON.stringify((await call(b.cookie, "GET", "/api/chart-state/panes")).json()), /a-secret/,
      "B's pane list shows A's studies");
    assert.equal((await call(b.cookie, "PUT", "/api/chart-state/panes/p7", { native: [{ key: "b-own" }], baseVersion: 0 })).statusCode, 200,
      "B's first write on the scope is its own row, not a conflict with A's");
    assert.match(JSON.stringify((await call(a.cookie, "GET", "/api/chart-state/panes/p7")).json()), /a-secret/,
      "B's write changed A's pane");
    // ma-alerts list for B never contains A's alert id.
    const aAlertId = createdIds.get("ma-alert")!.get(a.n);
    const bAlerts = (await call(b.cookie, "GET", "/api/ma-alerts")).json() as { id: string }[];
    assert.ok(!bAlerts.some((x) => x.id === aAlertId), "B's alert list contained A's alert");
  });

  // ── (c) signed-out and stale ───────────────────────────────────────────────
  await t.test("(c) signed-out and a stale cookie are 401 on every owned resource", async () => {
    const paths = ["/api/watchlists", "/api/layouts", "/api/pine", "/api/ma-alerts", "/api/chart-state/panes", "/api/portfolio", "/api/auth/login-history"];
    for (const p of paths) {
      assert.equal((await call(signedOut, "GET", p)).statusCode, 401, `signed-out GET ${p}`);
      assert.equal((await call(staleCookie, "GET", p)).statusCode, 401, `stale GET ${p}`);
    }
    // The stale cookie cannot write either.
    assert.equal((await call(staleCookie, "POST", "/api/watchlists", { name: "x", symbols: [] })).statusCode, 401);
  });

  // ── (d) account switch on one client ───────────────────────────────────────
  await t.test("(d) switching the cookie from A to B returns none of A's data", async () => {
    const a = users[4]!, b = users[5]!;
    // A names its watchlist distinctively.
    await call(a.cookie, "POST", "/api/watchlists", { name: `SECRET-A-${a.n}`, symbols: ["AAAUSDT"] });
    const aBody = JSON.stringify((await call(a.cookie, "GET", "/api/watchlists")).json());
    assert.match(aBody, /SECRET-A/);
    // Same client, now B's cookie.
    const bBody = JSON.stringify((await call(b.cookie, "GET", "/api/watchlists")).json());
    assert.doesNotMatch(bBody, /SECRET-A/, "B's response carried A's watchlist");
    assert.doesNotMatch(JSON.stringify((await call(b.cookie, "GET", "/api/auth/me")).json()), new RegExp(a.email), "B's /me carried A's identity");
  });

  // ── (e) concurrency ───────────────────────────────────────────────────────
  await t.test("(e) ten users read and write their own in parallel with no contamination", async () => {
    const work = users.map(async (u) => {
      const name = `PAR-${u.n}`;
      await call(u.cookie, "POST", "/api/watchlists", { name, symbols: [`P${u.n}USDT`] });
      const lists = (await call(u.cookie, "GET", "/api/watchlists")).json() as { name: string; symbols: string[] }[];
      // Every list this user sees is its own: none names another user's parallel symbol.
      for (const l of lists) {
        for (const s of l.symbols) {
          const m = /^P(\d+)USDT$/.exec(s.replace(/^.*:([A-Z0-9]+):USDT:USDT:spot$/, "$1USDT"));
          if (m) assert.equal(Number(m[1]), u.n, `${u.email} saw another user's parallel symbol ${s}`);
        }
      }
      return lists.some((l) => l.name === name);
    });
    const results = await Promise.all(work);
    assert.ok(results.every(Boolean), "a user did not see its own parallel write");
  });

  // ── (f) admin-only areas → 403 for a Standard user ─────────────────────────
  await t.test("(f) admin-only areas are 403 for a Standard user", async () => {
    const adminOnly: [string, string][] = [
      ["GET", "/api/deployments"], ["POST", "/api/deployments"], ["GET", "/api/alerts"],
      ["GET", "/api/manual-trading/state"], ["POST", "/api/manual-trading/orders"],
      ["GET", "/api/bot/summary"], ["GET", "/api/bot/bots"], ["GET", "/api/bot/trades"],
      ["GET", "/api/ops/status"], ["POST", "/api/ops/halt"], ["GET", "/api/journal"],
      ["GET", "/api/trading-overlays"], ["POST", "/api/backtests"], ["GET", "/api/optimizer/leaderboard"],
      ["POST", "/api/stress/runs"], ["GET", "/api/strategies"], ["PATCH", "/api/scanner/config"],
      ["POST", "/api/scanner/refresh"], ["PUT", "/api/shariah/mode"], ["POST", "/api/shariah/universe/sync"],
      ["POST", "/api/spot-execution/v1/orders"], ["POST", "/api/derivative-execution/v1/orders"],
      ["GET", "/api/admin/packages"], ["POST", "/api/admin/packages"], ["GET", "/api/admin/audit"],
      ["POST", "/api/layouts/sync-deployments"], ["POST", "/api/data/sync-filters"], ["PATCH", "/api/symbols/BTCUSDT"],
    ];
    const victim = users[6]!;
    for (const [m, p] of adminOnly) {
      assert.equal((await call(victim.cookie, m, p, {})).statusCode, 403, `Standard ${m} ${p} must be 403`);
    }
  });

  // ── (g) admin scope: record what the admin actually sees ───────────────────
  await t.test("(g) the admin reaches admin areas and its OWN owned data, not a user's", async () => {
    // Admin passes the gate on an admin-only area (whatever the handler then says, not 403/401).
    const ops = await call(adminCookie, "GET", "/api/ops/status");
    assert.notEqual(ops.statusCode, 401);
    assert.notEqual(ops.statusCode, 403);
    // The admin's own layouts are the admin's — a user's layout id is still 404 for the admin
    // through the per-owner route, because that route filters by the admin's id.
    const aLayoutId = createdIds.get("layout")!.get(users[0]!.n);
    const adminSeesUserLayout = await call(adminCookie, "GET", `/api/layouts/${aLayoutId}`);
    assert.equal(adminSeesUserLayout.statusCode, 404, "the admin read a Standard user's layout through the per-owner route");
    // But the admin CAN reach admin-only package member views (by design) — recorded, not asserted as a leak.
    const audit = await call(adminCookie, "GET", "/api/admin/audit");
    t.diagnostic(`admin scope: /api/ops/status=${ops.statusCode}, GET user layout=404 (own-scoped), /api/admin/audit=${audit.statusCode}`);
  });

  // ── push: an alert owned by A delivers only to A's subscriptions ───────────
  await t.test("push delivery selects only the owner's devices (repository seam)", async () => {
    const a = users[7]!, b = users[8]!;
    // Relative to what each already holds (the forged-owner subtest registered
    // one device per user as the caller).
    const endpointsOf = async (u: User) => (await pushRepo.listSubscriptions(u.id)).map((x) => x.endpoint).sort();
    const aBefore = await endpointsOf(a), bBefore = await endpointsOf(b);
    const devA = DEVICE("dev-a").endpoint, devB = DEVICE("dev-b").endpoint;
    assert.equal((await call(a.cookie, "POST", "/api/push/subscribe", DEVICE("dev-a"))).json().devices, aBefore.length + 1);
    assert.equal((await call(b.cookie, "POST", "/api/push/subscribe", DEVICE("dev-b"))).json().devices, bBefore.length + 1);
    // This is exactly the selection `alerts/webPush.ts sendPush({userId})` makes
    // before any network call: `listSubscriptions(userId)`.
    const aSet = await endpointsOf(a), bSet = await endpointsOf(b);
    assert.deepEqual(aSet, [...aBefore, devA].sort(), "A's fan-out set is A's devices and only those");
    assert.deepEqual(bSet, [...bBefore, devB].sort(), "B's fan-out set is B's devices and only those");
    assert.ok(!aSet.some((e) => bSet.includes(e)), "A's and B's delivery sets overlap");
    // Over HTTP: B unsubscribing A's endpoint removes nothing of A's.
    const bUnsub = await call(b.cookie, "POST", "/api/push/unsubscribe", { endpoint: devA });
    assert.equal(bUnsub.statusCode, 200, bUnsub.body);
    assert.equal(bUnsub.json().devices, bBefore.length + 1, "B's own device count is unchanged");
    assert.equal((await call(a.cookie, "GET", "/api/push/vapid")).json().devices, aBefore.length + 1, "A's device survived B's unsubscribe");
    assert.ok((await endpointsOf(a)).includes(devA));
    // And A unsubscribing its own removes only A's.
    assert.equal((await call(a.cookie, "POST", "/api/push/unsubscribe", { endpoint: devA })).json().devices, aBefore.length);
    assert.equal((await call(b.cookie, "GET", "/api/push/vapid")).json().devices, bBefore.length + 1, "B's device survived A's unsubscribe");
  });

  // ── unverified: reaches the chart, but not money features ──────────────────
  await t.test("an unverified account controls its own chart data and is held back from money features", async () => {
    assert.equal((await call(unverified.cookie, "POST", "/api/watchlists", { name: "u", symbols: [] })).statusCode, 201);
    // Admin-only money area still 403 (verification does not grant admin).
    assert.equal((await call(unverified.cookie, "GET", "/api/deployments")).statusCode, 403);
  });

  // ── the rest of the owned surface: profile, onboarding, 2FA, packages, sessions
  // Last, because logout-all ends a session the earlier subtests use.
  await t.test("profile, onboarding, 2FA status, package membership and logout-all are each the caller's own", async () => {
    const a = users[9]!, b = users[8]!;
    const nameOf = async (u: User) => (await call(u.cookie, "GET", "/api/auth/me")).json().user.displayName as string;

    // Profile: A renames itself; a body naming A changes only B.
    assert.equal((await call(a.cookie, "PATCH", "/api/auth/profile", { displayName: "A Renamed" })).statusCode, 200);
    assert.equal(await nameOf(a), "A Renamed");
    assert.equal(await nameOf(b), `User ${b.n}`, "A's rename changed B");
    assert.equal((await call(b.cookie, "PATCH", "/api/auth/profile", namesOwner(a.id, { displayName: "B Renamed" }))).statusCode, 200);
    assert.equal(await nameOf(a), "A Renamed", "a profile body naming A changed A");
    assert.equal(await nameOf(b), "B Renamed");

    // Onboarding writes a watchlist for the caller only.
    assert.equal((await call(a.cookie, "POST", "/api/auth/onboarding", namesOwner(b.id,
      { displayName: "A Onboarded", symbols: ["ADAUSDT"], watchlistName: "ONBOARD-A" }))).statusCode, 200);
    assert.ok((await call(a.cookie, "GET", "/api/watchlists")).json().some((l: { name: string }) => l.name === "ONBOARD-A"));
    for (const other of users.filter((u) => u.id !== a.id)) {
      assert.ok(!(await call(other.cookie, "GET", "/api/watchlists")).json().some((l: { name: string }) => l.name === "ONBOARD-A"),
        `${other.email} received A's onboarding watchlist`);
    }
    assert.equal((await call(b.cookie, "GET", "/api/auth/me")).json().user.onboarded, false, "A's onboarding marked B onboarded");

    // 2FA status is per account: A turns it on (the repository seam the
    // package test uses); B's stays off.
    const { startTotpSetup, enableTotp } = await import("../src/repositories/accountSecurity");
    const secure = async (u: User) => {
      await query("UPDATE users SET email_verified_at = now() WHERE id = $1", [u.id]);
      await startTotpSetup(u.id, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
      await enableTotp(u.id);
      forgetUser(u.id);
    };
    await secure(a);
    assert.equal((await call(a.cookie, "GET", "/api/auth/2fa/status")).json().enabled, true);
    assert.equal((await call(b.cookie, "GET", "/api/auth/2fa/status")).json().enabled, false, "A's 2FA shows as B's");

    // Package membership: A joins a cohort; B's portfolio shows none of it.
    const { twoFactorLimiter } = await import("../src/security/rateLimit");
    const strategyId = (await query<{ id: number }>("SELECT id FROM strategies ORDER BY id LIMIT 1")).rows[0]!.id;
    const deployment = (await query<{ id: string }>(
      "INSERT INTO deployments (strategy_id, symbol, timeframe, params) VALUES ($1, 'BTCUSDT', '15m', '{}') RETURNING id",
      [strategyId])).rows[0]!.id;
    const pkg = await call(adminCookie, "POST", "/api/admin/packages",
      { name: "Iso 1M", term: "month", minAmount: "100", tradePercent: "25", joinInstructions: "x" });
    assert.equal(pkg.statusCode, 201, pkg.body);
    const packageId = pkg.json().id as string;
    assert.equal((await call(adminCookie, "POST", `/api/admin/packages/${packageId}/deployments`, { deploymentId: deployment })).statusCode, 201);
    const cohort = await call(adminCookie, "POST", `/api/admin/packages/${packageId}/cohorts`);
    assert.equal(cohort.statusCode, 201, cohort.body);
    const cohortId = cohort.json().id as string;
    twoFactorLimiter.reset(ADMIN_ID);
    assert.equal((await call(adminCookie, "POST", `/api/admin/packages/${packageId}/status`, { status: "active", password: "owner password" })).statusCode, 200);
    const joined = await call(a.cookie, "POST", `/api/packages/cohorts/${cohortId}/join`, namesOwner(b.id, {}));
    assert.equal(joined.statusCode, 201, joined.body);
    const membershipId = joined.json().membershipId as string;
    const { rows: memberRows } = await query<{ user_id: string }>("SELECT user_id FROM memberships WHERE id = $1", [membershipId]);
    assert.equal(memberRows[0]!.user_id, a.id, "the membership is A's, whatever the body named");
    assert.equal((await call(a.cookie, "GET", "/api/portfolio")).json().pending.length, 1);
    for (const other of users.filter((u) => u.id !== a.id)) {
      const body = JSON.stringify((await call(other.cookie, "GET", "/api/portfolio")).json());
      assert.ok(!body.includes(membershipId), `${other.email}'s portfolio shows A's membership`);
      assert.deepEqual((await call(other.cookie, "GET", "/api/portfolio")).json().pending, [], `${other.email} has A's pending request`);
    }

    // Logout-all ends A's sessions and nobody else's.
    assert.equal((await call(a.cookie, "POST", "/api/auth/logout-all")).statusCode, 200);
    assert.equal((await call(a.cookie, "GET", "/api/watchlists")).statusCode, 401, "A's old session survived logout-all");
    for (const other of users.filter((u) => u.id !== a.id)) {
      assert.equal((await call(other.cookie, "GET", "/api/watchlists")).statusCode, 200, `A's logout-all ended ${other.email}'s session`);
    }
  });
});
