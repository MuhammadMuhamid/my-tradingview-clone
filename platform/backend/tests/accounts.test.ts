/**
 * Accounts: sessions, reach, and Google's identity token — the parts that need
 * no database. `accountsDb.test.ts` proves the data separation itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signUserSession, verifyUserSession, SESSION_COOKIE, signSession,
} from "../src/security/session";
import { userMayReach, useUserLoaderForTests } from "../src/security/requestUser";
import {
  openState, readIdToken, safeNext, sealState, newOAuthState, GoogleSignInError,
} from "../src/security/google";
import { config } from "../src/config";
import { buildServer } from "../src/api/server";
import { ADMIN_USER_ID } from "../src/repositories/users";
import type { LiveRunner } from "../src/engine/liveRunner";

const SECRET = "accounts-test-secret-0000000000000000000000";
const USER = "22222222-2222-4222-8222-222222222222";

test("a session names one account and the version it was issued under", () => {
  const now = 1_800_000_000_000;
  const token = signUserSession(USER, 3, SECRET, now);
  assert.deepEqual(verifyUserSession(token, SECRET, now + 1), {
    userId: USER, version: 3, expiresAt: now + 90 * 24 * 3600 * 1000,
  });
  assert.equal(verifyUserSession(token, "another-secret-000000000000000000000", now), null);
  assert.equal(verifyUserSession(token.replace(USER, ADMIN_USER_ID), SECRET, now), null,
    "the account cannot be swapped under the signature");
  assert.equal(verifyUserSession(token.replace(".3.", ".4."), SECRET, now), null);
  assert.equal(verifyUserSession(token, SECRET, now + 91 * 24 * 3600 * 1000), null, "expired");
  assert.equal(verifyUserSession(signSession("admin", SECRET, now), SECRET, now), null,
    "the old single-admin shape is not an account session");
});

test("an ordinary account reaches the chart and its own things, nothing that moves money", () => {
  for (const [method, path] of [
    ["GET", "/api/symbols"], ["GET", "/api/symbols/BTCUSDT/candles"], ["POST", "/api/symbols"],
    ["POST", "/api/data/backfill"], ["GET", "/api/data/trades"], ["GET", "/api/market/v1/search"],
    ["GET", "/api/pine"], ["POST", "/api/pine/run"], ["DELETE", "/api/pine/abc"],
    ["GET", "/api/layouts"], ["PATCH", "/api/layouts/abc"], ["GET", "/api/watchlists"],
    ["PUT", "/api/chart-state/drawings/BTCUSDT"], ["POST", "/api/ma-alerts"], ["POST", "/api/ma-alerts/bulk"],
    ["POST", "/api/push/subscribe"], ["GET", "/api/scanner"], ["POST", "/api/scanner/patterns/analyze"],
    ["GET", "/api/shariah/universe"], ["PATCH", "/api/auth/profile"], ["POST", "/api/auth/logout-all"],
  ] as const) {
    assert.ok(userMayReach(method, path), `${method} ${path} should be reachable`);
  }
  for (const [method, path] of [
    ["GET", "/api/deployments"], ["POST", "/api/deployments/x/activate"], ["GET", "/api/alerts"],
    ["POST", "/api/manual-trading/orders"], ["GET", "/api/manual-trading/state"],
    ["POST", "/api/spot-execution/v1/orders"], ["POST", "/api/derivative-execution/v1/orders"],
    ["POST", "/api/ops/halt"], ["GET", "/api/ops/status"], ["POST", "/api/backtests"],
    ["GET", "/api/optimizer/leaderboard"], ["POST", "/api/stress/runs"], ["GET", "/api/journal"],
    ["GET", "/api/trading-overlays"], ["GET", "/api/strategies"], ["PATCH", "/api/configs/x"],
    ["PATCH", "/api/scanner/config"], ["POST", "/api/scanner/refresh"], ["POST", "/api/scanner/presets"],
    ["PUT", "/api/shariah/mode"], ["POST", "/api/shariah/universe/sync"],
    ["POST", "/api/layouts/sync-deployments"], ["POST", "/api/symbols/x"], ["PATCH", "/api/symbols/BTCUSDT"],
    ["POST", "/api/data/sync-filters"], ["GET", "/api/some-route-added-later"],
  ] as const) {
    assert.ok(!userMayReach(method, path), `${method} ${path} must be admin-only`);
  }
});

test("the gate: no cookie is 401, an account outside its reach is 403, the admin is not limited", async (t) => {
  const previous = { authEnabled: config.authEnabled, sessionSecret: config.sessionSecret };
  config.authEnabled = true;
  config.sessionSecret = SECRET;
  t.after(() => Object.assign(config, previous));
  const versions = new Map([[USER, 2], [ADMIN_USER_ID, 1]]);
  useUserLoaderForTests(async (id) => versions.has(id)
    ? { id, role: id === ADMIN_USER_ID ? "admin" : "user", sessionVersion: versions.get(id)! } : null);
  t.after(() => useUserLoaderForTests(null));
  const app = buildServer(() => ({} as LiveRunner));
  t.after(() => app.close());

  const as = (id: string, version: number) =>
    ({ cookie: `${SESSION_COOKIE}=${signUserSession(id, version, SECRET)}` });

  assert.equal((await app.inject({ method: "GET", url: "/api/ops/status" })).statusCode, 401);
  const userOps = await app.inject({ method: "GET", url: "/api/ops/status", headers: as(USER, 2) });
  assert.equal(userOps.statusCode, 403);
  assert.match(userOps.json().error, /administrator/);
  const userDeploy = await app.inject({ method: "POST", url: "/api/deployments", headers: as(USER, 2), payload: {} });
  assert.equal(userDeploy.statusCode, 403);
  // A revoked session (an older version) is not a session at all.
  assert.equal((await app.inject({ method: "GET", url: "/api/ops/status", headers: as(USER, 1) })).statusCode, 401);
  // An account that no longer exists is not signed in.
  assert.equal((await app.inject({
    method: "GET", url: "/api/ops/status",
    headers: as("33333333-3333-4333-8333-333333333333", 1),
  })).statusCode, 401);
  // The admin passes the gate (whatever the route itself then says).
  const adminOps = await app.inject({ method: "GET", url: "/api/ops/status", headers: as(ADMIN_USER_ID, 1) });
  assert.notEqual(adminOps.statusCode, 401);
  assert.notEqual(adminOps.statusCode, 403);
});

test("a cookie from before accounts signs in as the admin and is moved to the new shape", async (t) => {
  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, adminUsername: config.adminUsername,
  };
  config.authEnabled = true;
  config.sessionSecret = SECRET;
  config.adminUsername = "owner";
  t.after(() => Object.assign(config, previous));
  useUserLoaderForTests(async (id) => id === ADMIN_USER_ID ? { id, role: "admin", sessionVersion: 4 } : null);
  t.after(() => useUserLoaderForTests(null));
  const app = buildServer(() => ({} as LiveRunner));
  t.after(() => app.close());

  const res = await app.inject({
    method: "GET", url: "/api/ops/status",
    headers: { cookie: `${SESSION_COOKIE}=${signSession("owner", SECRET)}` },
  });
  assert.notEqual(res.statusCode, 401);
  const renewed = /srtrend_session=([^;]+)/.exec(String(res.headers["set-cookie"]))![1]!;
  assert.deepEqual(verifyUserSession(renewed, SECRET)?.userId, ADMIN_USER_ID);
  assert.equal(verifyUserSession(renewed, SECRET)?.version, 4);
  // A cookie signed for another name is not the admin's.
  const other = await app.inject({
    method: "GET", url: "/api/ops/status",
    headers: { cookie: `${SESSION_COOKIE}=${signSession("someone", SECRET)}` },
  });
  assert.equal(other.statusCode, 401);
});

function idToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

test("Google's identity token is checked for issuer, audience, expiry and a verified email", () => {
  const now = 1_800_000_000_000;
  const good = {
    iss: "https://accounts.google.com", aud: "client-1", exp: now / 1000 + 600,
    sub: "1234567890", email: "Trader@Example.com", email_verified: true,
    name: "A Trader", picture: "https://lh3.googleusercontent.com/a/x",
  };
  assert.deepEqual(readIdToken(idToken(good), "client-1", now), {
    sub: "1234567890", email: "trader@example.com", name: "A Trader",
    picture: "https://lh3.googleusercontent.com/a/x",
  });
  for (const [bad, why] of [
    [{ ...good, iss: "https://evil.example" }, "issuer"],
    [{ ...good, aud: "client-2" }, "audience"],
    [{ ...good, exp: now / 1000 - 1 }, "expiry"],
    [{ ...good, email_verified: false }, "unverified email"],
    [{ ...good, sub: "" }, "subject"],
  ] as const) {
    assert.throws(() => readIdToken(idToken(bad), "client-1", now), GoogleSignInError, why);
  }
  assert.equal(readIdToken(idToken({ ...good, picture: "http://insecure" }), "client-1", now).picture, null);
});

test("the OAuth state is sealed, expires, and only ever sends the user to a path on this site", () => {
  const s = newOAuthState("/chart?symbol=BTCUSDT", null, 1_000);
  const sealed = sealState(s, SECRET);
  assert.equal(openState(sealed, SECRET, 2_000)?.state, s.state);
  assert.equal(openState(sealed, "other-secret-0000000000000000000000000", 2_000), null);
  assert.equal(openState(sealed.replace(/.$/, (c) => (c === "A" ? "B" : "A")), SECRET, 2_000), null);
  assert.equal(openState(sealed, SECRET, 1_000 + 11 * 60_000), null, "expired");
  assert.equal(safeNext("/alerts"), "/alerts");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "/api/auth/logout", "javascript:x", 5]) {
    assert.equal(safeNext(bad), "/chart", String(bad));
  }
});
