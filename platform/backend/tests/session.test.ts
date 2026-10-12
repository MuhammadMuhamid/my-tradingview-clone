import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  hashPassword, verifyPassword, signSession, verifySession,
  readCookie, safeEqual, SESSION_TTL_MS,
} from "../src/security/session";

const SECRET = "a".repeat(48);

test("scrypt hashes round-trip and reject the wrong password", async () => {
  const stored = hashPassword("hunter2");
  assert.ok(stored.startsWith("scrypt$"));
  assert.equal(await verifyPassword("hunter2", stored), true);
  assert.equal(await verifyPassword("hunter3", stored), false);
});

test("bcrypt hashes from the old Caddy config still verify", async () => {
  // The exact situation on the live server: ADMIN_PASSWORD_HASH is bcrypt.
  const stored = bcrypt.hashSync("caddy-era-password", 10);
  assert.equal(await verifyPassword("caddy-era-password", stored), true);
  assert.equal(await verifyPassword("wrong", stored), false);
});

test("malformed hashes are rejected rather than throwing", async () => {
  assert.equal(await verifyPassword("x", ""), false);
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
  assert.equal(await verifyPassword("x", "scrypt$zz$zz"), false);
  assert.equal(await verifyPassword("x", "$2b$broken"), false);
});

test("a signed session verifies and carries the username", () => {
  const token = signSession("muhamid", SECRET);
  const claims = verifySession(token, SECRET);
  assert.equal(claims?.username, "muhamid");
});

test("the session lasts 90 days", () => {
  const now = Date.now();
  const claims = verifySession(signSession("u", SECRET, now), SECRET, { now });
  assert.equal(claims!.expiresAt - now, SESSION_TTL_MS);
});

test("tampered or foreign-signed tokens are rejected", () => {
  const token = signSession("muhamid", SECRET);
  assert.equal(verifySession(token, "b".repeat(48)), null);
  assert.equal(verifySession(token.slice(0, -2) + "xx", SECRET), null);
  assert.equal(verifySession("garbage", SECRET), null);
  // Username swapped, signature left alone.
  const [, expiry, mac] = token.split(".");
  const forged = `${Buffer.from("root").toString("base64url")}.${expiry}.${mac}`;
  assert.equal(verifySession(forged, SECRET), null);
});

test("expired sessions are rejected", () => {
  const issued = Date.now() - SESSION_TTL_MS - 1000;
  assert.equal(verifySession(signSession("u", SECRET, issued), SECRET), null);
});

test("cookie parsing picks the right value out of a crowded header", () => {
  assert.equal(readCookie("a=1; srtrend_session=tok; b=2", "srtrend_session"), "tok");
  assert.equal(readCookie("other=1", "srtrend_session"), null);
  assert.equal(readCookie(undefined, "srtrend_session"), null);
});

test("safeEqual handles differing lengths without throwing", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

test("a session signed for a different username is rejected", () => {
  const token = signSession("muhamid", SECRET);
  assert.equal(verifySession(token, SECRET, { expectedUsername: "muhamid" })?.username, "muhamid");
  // Sessions are stateless with a 90-day TTL and no revocation list, so a token
  // for a username that is no longer configured must stop working.
  assert.equal(verifySession(token, SECRET, { expectedUsername: "admin" }), null);
  assert.equal(verifySession(token, SECRET, { expectedUsername: "" }), null);
});

 test("malformed cookie encoding fails closed", () => {
  for (const value of ["%", "%GG", "%E0%A4%A"]) {
    assert.equal(readCookie(`srtrend_session=${value}`, "srtrend_session"), null);
  }
});

test("password verification yields to the API event loop", async () => {
  const stored = hashPassword("fixture-password");
  const timer = new Promise<string>((resolve) => setTimeout(() => resolve("timer"), 0));
  const checks = Array.from({ length: 4 }, () => verifyPassword("fixture-password", stored));
  assert.equal(await Promise.race([timer, Promise.all(checks).then(() => "checks")]), "timer");
  assert.deepEqual(await Promise.all(checks), [true, true, true, true]);
});
