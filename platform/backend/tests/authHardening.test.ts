import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { authRoutes } from "../src/api/routes/auth";
import { config } from "../src/config";
import { hashPassword, SESSION_COOKIE } from "../src/security/session";

test("login rejects malformed JSON, bounds concurrent work, and preserves valid authentication", async () => {
  const previous = { authEnabled: config.authEnabled, adminUsername: config.adminUsername,
    adminPasswordHash: config.adminPasswordHash };
  config.authEnabled = true;
  config.adminUsername = "fixture-admin";
  config.adminPasswordHash = hashPassword("fixture-password");
  const app = Fastify();
  await app.register(authRoutes);
  const login = (payload: unknown) => app.inject({ method: "POST", url: "/api/auth/login",
    headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
  try {
    for (const payload of [null, [], { username: {} , password: "p" },
      { username: "u", password: [] }, { username: "u", password: "x".repeat(1025) }]) {
      assert.equal((await login(payload)).statusCode, 400);
    }
    const me = await app.inject({ url: "/api/auth/me", headers: { cookie: `${SESSION_COOKIE}=%GG` } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().authenticated, false);
    assert.equal((await login({ username: "fixture-admin", password: "wrong" })).statusCode, 401);
    const payload = { username: "fixture-admin", password: "fixture-password" };
    const replies = await Promise.all(Array.from({ length: 5 }, () => login(payload)));
    assert.deepEqual(replies.map((reply) => reply.statusCode).sort(), [200, 200, 200, 200, 429]);
    const successful = replies.find((reply) => reply.statusCode === 200)!;
    assert.match(String(successful.headers["set-cookie"]), /HttpOnly; SameSite=Lax/);
    assert.equal((await login(payload)).statusCode, 200, "capacity is released after completion");
  } finally {
    Object.assign(config, previous);
    await app.close();
  }
});
