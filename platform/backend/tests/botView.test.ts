/**
 * The Bot section's reads: an allowlist, not a proxy.
 *
 * The browser must not be able to name a Bot path or widen a read, and a Bot
 * that refuses this Platform must not look like an expired sign-in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { botViewRoutes, botTradesPath } from "../src/api/routes/botView";
import { config } from "../src/config";
import { ManualBotError, type ManualBotRequestInput } from "../src/manualTrading/client";
import { userMayReach } from "../src/security/requestUser";

const BOT_ID = "11111111-1111-4111-8111-111111111111";

async function appWith(botRequest: (input: ManualBotRequestInput) => Promise<unknown>) {
  const app = Fastify({ logger: false });
  await app.register(botViewRoutes, { botRequest: botRequest as never });
  return app;
}

function withManualTrading(t: { after: (fn: () => void) => void }, enabled: boolean) {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = enabled;
  t.after(() => { config.manualTradingEnabled = previous; });
}

test("an ordinary account can't reach any Bot read", () => {
  for (const path of ["/api/bot/summary", "/api/bot/bots", "/api/bot/trades"]) {
    assert.equal(userMayReach("GET", path), false, path);
  }
});

test("each read goes to exactly one signed Bot path, as a GET", async (t) => {
  withManualTrading(t, true);
  const calls: ManualBotRequestInput[] = [];
  const app = await appWith(async (input) => { calls.push(input); return { ok: true }; });
  t.after(() => app.close());
  for (const url of ["/api/bot/summary", "/api/bot/bots", "/api/bot/trades?status=active"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 200, url);
  }
  assert.deepEqual(calls, [
    { method: "GET", path: "/api/manual-trading/bot-view/summary" },
    { method: "GET", path: "/api/manual-trading/bot-view/bots" },
    { method: "GET", path: "/api/manual-trading/bot-view/trades?status=active&page=1&pageSize=50" },
  ]);
});

test("nothing but a GET is served", async (t) => {
  withManualTrading(t, true);
  let reached = false;
  const app = await appWith(async () => { reached = true; return {}; });
  t.after(() => app.close());
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    for (const url of ["/api/bot/summary", "/api/bot/bots", "/api/bot/trades"]) {
      assert.equal((await app.inject({ method, url })).statusCode, 404, `${method} ${url}`);
    }
  }
  assert.equal(reached, false);
});

test("no other path under /api/bot reaches the Bot", async (t) => {
  withManualTrading(t, true);
  let reached = false;
  const app = await appWith(async () => { reached = true; return {}; });
  t.after(() => app.close());
  for (const url of ["/api/bot/orders", "/api/bot/../manual-trading/orders", "/api/bot/bots/x/toggle", "/api/bot/state"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 404, url);
  }
  assert.equal(reached, false);
});

test("the query is rebuilt from checked values, and anything else is dropped", () => {
  assert.equal(
    botTradesPath({ status: "closed", botId: BOT_ID, page: "2", pageSize: "25", extra: "x", path: "/api/trades" }),
    `/api/manual-trading/bot-view/trades?status=closed&botId=${BOT_ID}&page=2&pageSize=25`
  );
});

test("Feature B: `archived` is passed through only when given, and only as exclude|include|only", () => {
  assert.equal(botTradesPath({ status: "closed", archived: "only" }),
    "/api/manual-trading/bot-view/trades?status=closed&archived=only&page=1&pageSize=50");
  assert.equal(botTradesPath({ status: "closed", archived: "include", page: "3" }),
    "/api/manual-trading/bot-view/trades?status=closed&archived=include&page=3&pageSize=50");
  // Absent: nothing is added, so an older Bot (strict query, no `tradeArchive.v1`) still answers.
  assert.equal(botTradesPath({ status: "closed" }), "/api/manual-trading/bot-view/trades?status=closed&page=1&pageSize=50");
  for (const archived of ["all", "", "ONLY", ["only"], 1]) {
    assert.throws(() => botTradesPath({ status: "closed", archived }), /archived must be/, JSON.stringify(archived));
  }
});

test("a bad query is refused before the Bot is asked", async (t) => {
  withManualTrading(t, true);
  let reached = false;
  const app = await appWith(async () => { reached = true; return {}; });
  t.after(() => app.close());
  for (const query of ["", "status=everything", "status=active&botId=x%26page%3D9", "status=active&page=0",
    "status=active&page=1.5", "status=active&pageSize=101", "status=active&page=-1", "status=active&status=closed", "status=closed&archived=everything"]) {
    const res = await app.inject({ method: "GET", url: `/api/bot/trades?${query}` });
    assert.equal(res.statusCode, 400, query);
  }
  assert.equal(reached, false);
});

test("with manual trading off the page is told so and the Bot isn't asked", async (t) => {
  withManualTrading(t, false);
  let reached = false;
  const app = await appWith(async () => { reached = true; return {}; });
  t.after(() => app.close());
  const res = await app.inject({ method: "GET", url: "/api/bot/summary" });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "manual trading is disabled" });
  assert.equal(reached, false);
});

test("a Bot that can't be reached is a named 502", async (t) => {
  withManualTrading(t, true);
  const app = await appWith(async () => { throw new ManualBotError("the execution bot could not be reached", 502); });
  t.after(() => app.close());
  const res = await app.inject({ method: "GET", url: "/api/bot/bots" });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { error: "the execution bot could not be reached" });
});

test("a Bot refusing the signature is a 502, so the administrator isn't sent to sign in", async (t) => {
  withManualTrading(t, true);
  for (const status of [401, 403, 409]) {
    const app = await appWith(async () => { throw new ManualBotError("signature rejected", status); });
    t.after(() => app.close());
    const res = await app.inject({ method: "GET", url: "/api/bot/summary" });
    assert.equal(res.statusCode, 502, String(status));
    assert.match(res.json().error, /refused this Platform's request: signature rejected/);
  }
});

test("the Bot's own 404 and 400 keep their meaning", async (t) => {
  withManualTrading(t, true);
  for (const status of [400, 404]) {
    const app = await appWith(async () => { throw new ManualBotError("manual trading is disabled", status); });
    t.after(() => app.close());
    assert.equal((await app.inject({ method: "GET", url: "/api/bot/bots" })).statusCode, status);
  }
});
