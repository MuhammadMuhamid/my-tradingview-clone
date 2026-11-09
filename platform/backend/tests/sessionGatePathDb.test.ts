/**
 * The session gate must check the SAME path the router dispatches on.
 *
 * Fastify's router (find-my-way) percent-decodes the path, cuts it at `?` or
 * `#`, and strips an absolute-form `http://host` prefix before matching. A gate
 * that checks the raw `req.url` instead can allow a request the router then
 * hands to an administrator-only handler, and a rate limit keyed on the raw
 * path can miss a request the router hands to the sign-in handler.
 *
 * Proven over REAL local HTTP (node:http on 127.0.0.1, so the path is sent
 * verbatim) and through inject, for a Standard account, the administrator and
 * no session. Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_gate_path`;
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

interface Raw { status: number; body: string; cookies: string[] }

test("the session gate and the sign-in limit check the path the router dispatches", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { buildServer } = await import("../src/api/server");
  const { hashPassword } = await import("../src/security/session");
  const { loginLimiter } = await import("../src/security/rateLimit");
  after(() => closePool());
  await migrate();

  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    adminUsername: config.adminUsername, adminPasswordHash: config.adminPasswordHash, emailFrom: config.emailFrom,
  };
  Object.assign(config, {
    authEnabled: true, sessionSecret: "gate-path-test-secret-000000000000000000000",
    allowSignups: true, adminUsername: "owner", adminPasswordHash: hashPassword("owner password"), emailFrom: "",
  });
  t.after(() => Object.assign(config, previous));

  const app = buildServer(() => ({} as never));
  // Where the router actually sent each request, recorded after the reply.
  const dispatched: { raw: string; route: string | undefined; status: number }[] = [];
  app.addHook("onResponse", async (req, reply) => {
    dispatched.push({ raw: req.raw.url ?? "", route: req.routeOptions.url, status: reply.statusCode });
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const port = Number(new URL(address).port);

  /** One request with the path exactly as written: no URL parsing on the way out. */
  const raw = (method: string, path: string, cookie: string | null, payload?: object): Promise<Raw> =>
    new Promise((resolve, reject) => {
      const body = payload ? JSON.stringify(payload) : undefined;
      const req = http.request({
        host: "127.0.0.1", port, method, path,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
        },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({
          status: res.statusCode ?? 0, body: text,
          cookies: [res.headers["set-cookie"] ?? []].flat(),
        }));
      });
      req.on("error", reject);
      req.end(body);
    });
  const sessionOf = (cookies: string[]) => {
    const found = cookies.map((c) => /^srtrend_session=([^;]+)/.exec(c)?.[1]).find(Boolean);
    assert.ok(found, "a session cookie was issued");
    return `srtrend_session=${found}`;
  };

  // ── identities ─────────────────────────────────────────────────────────────
  loginLimiter.reset("127.0.0.1");
  const signed = await raw("POST", "/api/auth/signup", null, { email: "standard@example.com", password: "correct horse battery" });
  assert.equal(signed.status, 201, signed.body);
  const standard = sessionOf(signed.cookies);
  const standardId = (JSON.parse(signed.body) as { user: { id: string } }).user.id;
  loginLimiter.reset("127.0.0.1");
  const adminLogin = await raw("POST", "/api/auth/login", null, { username: "owner", password: "owner password" });
  assert.equal(adminLogin.status, 200, adminLogin.body);
  const admin = sessionOf(adminLogin.cookies);
  const roles = { standard, admin, none: null } as const;

  // The administrator's deployment: what the admin-only sync would copy.
  await query("INSERT INTO symbols (symbol, base_asset, quote_asset) VALUES ('BTCUSDT', 'BTC', 'USDT') ON CONFLICT DO NOTHING");
  const strategyId = (await query<{ id: number }>("SELECT id FROM strategies ORDER BY id LIMIT 1")).rows[0]!.id;
  await query(
    "INSERT INTO deployments (strategy_id, symbol, timeframe, params) VALUES ($1, 'BTCUSDT', '15m', '{\"secretTuning\": 42}')",
    [strategyId]);
  const layoutsOf = async (userId: string) =>
    (await query<{ name: string }>("SELECT name FROM chart_layouts WHERE user_id = $1", [userId])).rows.map((r) => r.name);

  // ── variants of the one administrator-only route under a Standard prefix ───
  // `admin` is what the administrator must get: the handler (200) for every
  // form the router sends to it, 404 for forms it does not route, 400 for a
  // rejected encoding. A Standard account and no session never reach it.
  // `injectAdmin`, where present, is what the administrator gets through
  // `inject` instead of over real HTTP: light-my-request parses the URL with
  // the WHATWG parser, which folds `..` segments to the real path before the
  // server sees them, so the admin reaches the handler (200). Standard and
  // unauthenticated are unchanged — the point of the row — so only the admin
  // column differs, and only for the two dot-segment forms.
  const SYNC_VARIANTS: { name: string; path: string; admin: number; standard: number; none: number; injectAdmin?: number }[] = [
    { name: "plain", path: "/api/layouts/sync-deployments", admin: 200, standard: 403, none: 401 },
    { name: "encoded hyphen %2D", path: "/api/layouts/sync%2Ddeployments", admin: 200, standard: 403, none: 401 },
    { name: "encoded hyphen %2d (lower-case hex)", path: "/api/layouts/sync%2ddeployments", admin: 200, standard: 403, none: 401 },
    { name: "encoded letter %73", path: "/api/layouts/%73ync-deployments", admin: 200, standard: 403, none: 401 },
    { name: "mixed-case escapes %6C / %6c", path: "/api/%6Cayouts/sync%2ddeployments", admin: 200, standard: 403, none: 401 },
    { name: "fragment #x", path: "/api/layouts/sync-deployments#x", admin: 200, standard: 403, none: 401 },
    { name: "query then fragment", path: "/api/layouts/sync-deployments?a=1#x", admin: 200, standard: 403, none: 401 },
    { name: "absolute-form", path: "http://127.0.0.1/api/layouts/sync-deployments", admin: 200, standard: 403, none: 401 },
    // `;` is not a delimiter in this router: the path is `…sync-deployments;x`,
    // which no POST route matches.
    { name: "semicolon suffix", path: "/api/layouts/sync-deployments;x", admin: 404, standard: 404, none: 401 },
    { name: "trailing slash", path: "/api/layouts/sync-deployments/", admin: 404, standard: 403, none: 401 },
    { name: "double slash (inner)", path: "/api//layouts/sync-deployments", admin: 404, standard: 403, none: 401 },
    { name: "double slash (before id)", path: "/api/layouts//sync-deployments", admin: 404, standard: 403, none: 401 },
    { name: "upper-case prefix", path: "/API/layouts/sync-deployments", admin: 404, standard: 403, none: 401 },
    { name: "capitalised segment", path: "/api/Layouts/sync-deployments", admin: 404, standard: 403, none: 401 },
    { name: "dot segments", path: "/api/layouts/../layouts/sync-deployments", admin: 404, standard: 403, none: 401, injectAdmin: 200 },
    { name: "encoded dot segments", path: "/api/layouts/%2E%2E/layouts/sync-deployments", admin: 404, standard: 403, none: 401, injectAdmin: 200 },
    // An encoded slash is never sent by this product's client, and inside a
    // parameter the router decodes it to a real one: refused outright.
    { name: "encoded slash %2F", path: "/api/layouts%2Fsync-deployments", admin: 400, standard: 400, none: 400 },
  ];

  await t.test("real HTTP: every variant, every role", async () => {
    const rows: string[] = [];
    const wrong: string[] = [];
    for (const v of SYNC_VARIANTS) {
      for (const [role, cookie] of Object.entries(roles)) {
        dispatched.length = 0;
        const res = await raw("POST", v.path, cookie);
        const seen = dispatched.at(-1);
        const want = v[role as keyof typeof roles];
        rows.push(`${v.name.padEnd(36)} ${role.padEnd(8)} got=${res.status} want=${want} route=${seen?.route ?? "(none)"} raw=${v.path}`);
        if (res.status !== want) wrong.push(`${role} POST ${JSON.stringify(v.path)} (${v.name}): got ${res.status} ${res.body.slice(0, 120)}`);
      }
    }
    t.diagnostic(`variant matrix (variant, role, status, router route, raw path):\n${rows.join("\n")}`);
    assert.deepEqual(wrong, [], `variants answered wrongly:\n${wrong.join("\n")}`);
    assert.deepEqual(await layoutsOf(standardId), [],
      "no variant copied the administrator's deployments into the Standard account's layouts");
  });

  await t.test("inject: the encoded variants a URL parser keeps, every role", async () => {
    const wrong: string[] = [];
    for (const v of SYNC_VARIANTS.filter((x) => !x.path.includes("#") && !x.path.startsWith("http"))) {
      for (const [role, cookie] of Object.entries(roles)) {
        const res = await app.inject({ method: "POST", url: v.path, ...(cookie ? { headers: { cookie } } : {}) });
        const want = role === "admin" && v.injectAdmin !== undefined ? v.injectAdmin : v[role as keyof typeof roles];
        if (res.statusCode !== want) {
          wrong.push(`${role} inject POST ${JSON.stringify(v.path)} (${v.name}): got ${res.statusCode} want ${want} ${res.body.slice(0, 100)}`);
        }
        // The security invariant holds whatever the transport does with the path.
        if (role !== "admin") {
          assert.notEqual(res.statusCode, 200, `${role} inject POST ${JSON.stringify(v.path)} (${v.name}) reached the handler`);
        }
      }
    }
    assert.deepEqual(wrong, [], `variants answered wrongly:\n${wrong.join("\n")}`);
    assert.deepEqual(await layoutsOf(standardId), []);
  });

  await t.test("a malformed escape is refused before any handler", async () => {
    for (const [role, cookie] of Object.entries(roles)) {
      const res = await raw("POST", "/api/layouts/sync%ZZdeployments", cookie);
      assert.equal(res.status, 400, `${role}: ${res.body}`);
    }
  });

  await t.test("inject: a target without a leading slash is refused, though the router would dispatch it", async () => {
    // Node's HTTP parser refuses these request lines, and app.inject's URL
    // parser adds the slash, so the request is built by light-my-request (what
    // app.inject uses) and its URL set verbatim before Fastify's own handler.
    const { default: lightMyRequest } = await import("light-my-request");
    const verbatim = (method: string, url: string, cookie: string | null) =>
      lightMyRequest((req, res) => { req.url = url; app.routing(req, res); },
        { method: method as "POST", url: "/placeholder", ...(cookie ? { headers: { cookie } } : {}) });
    const wrong: string[] = [];
    for (const url of ["xapi/layouts/sync-deployments", "?api/layouts/sync-deployments", "\\api/layouts/sync-deployments"]) {
      for (const [role, cookie] of Object.entries(roles)) {
        dispatched.length = 0;
        const res = await verbatim("POST", url, cookie);
        const seen = dispatched.at(-1);
        // The router really does pick the admin-only handler for this target…
        assert.equal(seen?.route, "/api/layouts/sync-deployments", `router dispatch for ${JSON.stringify(url)}`);
        // …and the gate refuses it before that handler, for every role.
        if (res.statusCode !== 400) wrong.push(`${role} POST ${JSON.stringify(url)}: got ${res.statusCode} ${res.body.slice(0, 100)}`);
      }
    }
    assert.deepEqual(wrong, [], `a target without a leading slash was not refused:\n${wrong.join("\n")}`);
    assert.deepEqual(await layoutsOf(standardId), []);
  });

  await t.test("every encoded or variant form of a limited sign-in path is counted, and the sixth is refused", async () => {
    const LIMITED = ["/api/auth/login", "/api/auth/signup", "/api/auth/password", "/api/auth/2fa/login", "/api/auth/email/verify"];
    const forms = (p: string) => [
      { name: "plain", path: p },
      { name: "encoded last letter", path: p.slice(0, -1) + `%${p.charCodeAt(p.length - 1).toString(16).toUpperCase()}` },
      { name: "encoded letter, lower-case hex", path: p.replace("/auth/", `/%${"a".charCodeAt(0).toString(16)}uth/`) },
      { name: "fragment", path: `${p}#x` },
      { name: "absolute-form", path: `http://127.0.0.1${p}` },
    ];
    const rows: string[] = [];
    const wrong: string[] = [];
    for (const p of LIMITED) {
      for (const f of forms(p)) {
        for (const [role, cookie] of [["none", null], ["standard", standard]] as const) {
          loginLimiter.reset("127.0.0.1");
          const statuses: number[] = [];
          // Wrong credentials and junk bodies: none of these may succeed, so
          // nothing resets the counter.
          for (let i = 0; i < 6; i += 1) {
            statuses.push((await raw("POST", f.path, cookie, { email: "nobody@example.com", password: "wrong", token: "x", code: "000000" })).status);
          }
          rows.push(`${p.padEnd(24)} ${f.name.padEnd(32)} ${role.padEnd(8)} ${statuses.join(",")}`);
          if (statuses[5] !== 429) wrong.push(`${role} ${JSON.stringify(f.path)} (${f.name}): got ${statuses.join(",")}`);
        }
      }
    }
    loginLimiter.reset("127.0.0.1");
    t.diagnostic(`limiter matrix (path, form, role, statuses of six attempts):\n${rows.join("\n")}`);
    assert.deepEqual(wrong, [], `the sixth attempt was not refused:\n${wrong.join("\n")}`);
  });

  await t.test("ordinary paths are unchanged for both roles", async () => {
    for (const [role, cookie] of [["standard", standard], ["admin", admin]] as const) {
      assert.equal((await raw("GET", "/api/layouts", cookie)).status, 200, `${role} GET /api/layouts`);
      assert.equal((await raw("GET", "/api/watchlists?x=1", cookie)).status, 200, `${role} GET /api/watchlists?x=1`);
      assert.equal((await raw("GET", "/api/auth/me", cookie)).status, 200, `${role} GET /api/auth/me`);
      const missing = await raw("GET", "/api/layouts/00000000-0000-4000-8000-00000000abcd", cookie);
      assert.equal(missing.status, 404, `${role} GET a missing layout`);
    }
    assert.equal((await raw("GET", "/api/deployments", standard)).status, 403);
    assert.equal((await raw("GET", "/api/deployments", admin)).status, 200);
    assert.equal((await raw("GET", "/api/layouts", null)).status, 401);
    assert.equal((await raw("GET", "/health", null)).status, 200);
    assert.equal((await raw("GET", "/api/auth/me", null)).status, 200, "a public path stays public");
  });
});
