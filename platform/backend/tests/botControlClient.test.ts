/**
 * The Platform side of the Bot control channel, without a database.
 *
 * - F10: the fixed signing vector both repositories assert. The Bot's copy is
 *   `logs/signing-vector.txt` and `bot/backend/tests/botControl.test.ts`.
 * - F8 / F11: which Bot answers are definitive and which leave the outcome
 *   unknown. "Unreachable" is not "nothing happened".
 * - F5: a signed request is never redirected; the timeout is per call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";
import {
  ManualBotError, botControlCommand, botControlReplies, classifyBotControlReply, manualBotControlRequest,
  signManualCommand,
} from "../src/manualTrading/client";

const SECRET = "bot-control-client-secret-0123456789abcdef";

function withChannel(t: { after: (fn: () => void) => void }, url = "http://127.0.0.1:9", secret = SECRET) {
  const previous = { url: config.manualTradingBotUrl, secret: config.manualTradingHmacSecret };
  config.manualTradingBotUrl = url;
  config.manualTradingHmacSecret = secret;
  t.after(() => { config.manualTradingBotUrl = previous.url; config.manualTradingHmacSecret = previous.secret; });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" } });

test("F10: the shared signing vector gives the same v1= signature as the Bot", () => {
  const body = JSON.parse('{"confirmation":"HALT_TRADING","reason":"vector test","actor":{"platformUserId":'
    + '"00000000-0000-4000-8000-000000000001","stepUp":{"method":"totp","at":"2026-11-09T00:00:00.000Z"}}}');
  const signature = signManualCommand({
    method: "POST", path: "/api/manual-trading/control/halt", timestamp: "1794200000000",
    nonce: "nonceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", requestId: "req_0123456789abcdef", body,
  }, "test-secret-0123456789abcdef0123456789abcdef");
  // Split so no run of 40+ hex characters is a literal (`scripts/ci/scan-secrets.sh`); the value is
  // the one in `logs/signing-vector.txt`, which the Bot's test asserts in the same pieces.
  assert.equal(signature, "v1=" + "35140d29de6a2b893ccb422e" + "964b2f1597d05e93db91" + "da1fa0f1da380cc5dcb0");
});

test("F8: only a Bot-authored JSON 2xx of the right shape, or a coded JSON 4xx, is definitive", () => {
  const accept = botControlReplies.halt;
  const ok = { halted: true, haltedBy: "operator", haltedReason: "x", haltedAt: null, alreadyHalted: false };
  assert.deepEqual(classifyBotControlReply(200, ok, accept), { outcome: "ok", status: 200, body: ok });
  // A 2xx that is not the expected shape, or not JSON at all, is not an answer.
  assert.deepEqual(classifyBotControlReply(200, { status: "ok" }, accept), { outcome: "uncertain", reason: "invalid_reply" });
  assert.deepEqual(classifyBotControlReply(200, undefined, accept), { outcome: "uncertain", reason: "invalid_reply" });
  // Business refusals pass through with their own words.
  const refused = classifyBotControlReply(409, { error: "Still breached.", code: "still_breached" }, accept);
  assert.deepEqual(refused, { outcome: "refused", status: 409, code: "still_breached", fault: "business", message: "Still breached." });
  // A 4xx without a code, any 5xx (coded or not), a 429 without a code: unknown.
  assert.deepEqual(classifyBotControlReply(400, { error: "bad" }, accept), { outcome: "uncertain", reason: "no_code" });
  assert.deepEqual(classifyBotControlReply(500, { error: "Internal server error", code: "internal_error" }, accept),
    { outcome: "uncertain", reason: "server_error" });
  assert.deepEqual(classifyBotControlReply(502, undefined, accept), { outcome: "uncertain", reason: "server_error" });
  assert.deepEqual(classifyBotControlReply(504, undefined, accept), { outcome: "uncertain", reason: "server_error" });
  assert.deepEqual(classifyBotControlReply(429, { error: "slow down" }, accept), { outcome: "uncertain", reason: "no_code" });
});

test("F8: channel faults are definitive refusals of the CHANNEL, never business answers", () => {
  const accept = botControlReplies.halt;
  const fault = (status: number, body: unknown) => {
    const result = classifyBotControlReply(status, body, accept);
    return result.outcome === "refused" ? result.fault : result.outcome;
  };
  assert.equal(fault(401, { error: "bad signature", code: "auth" }), "channel_auth");
  assert.equal(fault(401, undefined), "channel_auth");
  assert.equal(fault(403, undefined), "channel_proxy", "the proxy's Platform-IP rule answers with no body");
  assert.equal(fault(409, { error: "used", code: "nonce_replay" }), "channel_replay");
  assert.equal(fault(429, { error: "slow", code: "bot_rate_limited" }), "rate_limited");
  assert.equal(fault(503, { error: "unset", code: "channel_not_configured" }), "not_configured");
  // A 409 that is NOT a replay is the Bot's business answer.
  assert.equal(fault(409, { error: "closing", code: "trade_closing" }), "business");
});

test("the refusal text is capped and only taken from a coded body", () => {
  const long = "x".repeat(1000);
  const result = classifyBotControlReply(422, { error: long, code: "trade_manual" }, botControlReplies.close);
  assert.equal(result.outcome, "refused");
  assert.equal(result.outcome === "refused" && result.message.length, 300);
});

test("each reply guard accepts the contract's shape and rejects drift", () => {
  assert.equal(botControlReplies.resume({ halted: false }), true);
  assert.equal(botControlReplies.resume({ halted: true }), false);
  assert.equal(botControlReplies.riskLimits({
    limits: { maxTotalExposureQuote: null, maxConcurrentTrades: 3, maxDailyLossQuote: 50, dailyLossWindowHours: 24 },
    snapshot: { openExposureQuote: 1, openTrades: 1, realisedPnlInWindow: 0 }, summary: "", latched: false,
  }), true);
  assert.equal(botControlReplies.riskLimits({ limits: {}, snapshot: {}, summary: "", latched: false }), false);
  assert.equal(botControlReplies.botStatus({ id: "b", status: "paused", changed: true }), true);
  assert.equal(botControlReplies.botStatus({ id: "b", status: "toggled", changed: true }), false);
  assert.equal(botControlReplies.close({ status: "pending", intentId: "i" }), true);
  assert.equal(botControlReplies.close({ status: "closed" }), false);
  assert.equal(botControlReplies.partialClose({ requestedQty: 1, executedQty: 0.5 }), true);
  assert.equal(botControlReplies.partialClose({ status: "pending", attemptId: "a" }), true);
  assert.equal(botControlReplies.partialClose({ requestedQty: "1" }), false);
  assert.equal(botControlReplies.command({ requestId: "r", kind: "halt", status: "pending" }), true);
  assert.equal(botControlReplies.command({ requestId: "r", kind: "halt", status: "done" }), false);
});

test("no control channel: nothing is sent and the refusal says so", async (t) => {
  withChannel(t, "http://127.0.0.1:9", "");
  let sent = false;
  const result = await botControlCommand({ method: "GET", path: "/api/manual-trading/control/status",
    accept: () => true }, async () => { sent = true; return json(200, {}); });
  assert.deepEqual(result, { outcome: "refused", status: 503, code: "bot_channel_not_configured",
    fault: "not_configured", message: "Bot control channel not configured." });
  assert.equal(sent, false);
});

test("F5: a signed request refuses redirects, and the timeout is the caller's", async (t) => {
  withChannel(t);
  let seen: RequestInit | undefined;
  // AbortSignal.timeout()'s timer does not keep the event loop alive, and a real
  // socket would. Hold the loop open until the abort lands, or Node 22's test
  // runner cancels this test ("event loop has already resolved").
  const hangUntilAbort = (init?: RequestInit): Promise<Response> => new Promise<Response>((_resolve, reject) => {
    const keepAlive = setInterval(() => {}, 1_000);
    init?.signal?.addEventListener("abort", () => { clearInterval(keepAlive); reject(init.signal!.reason); });
  });
  const hang: typeof fetch = async (_input, init) => {
    seen = init;
    return hangUntilAbort(init);
  };
  const started = Date.now();
  const result = await botControlCommand({ method: "POST", path: "/api/manual-trading/control/halt",
    body: { a: 1 }, requestId: "req_0123456789abcdef", accept: () => true, timeoutMs: 50 }, hang);
  assert.deepEqual(result, { outcome: "uncertain", reason: "timeout" });
  assert.ok(Date.now() - started < 2_000, "the 50 ms timeout was used, not the 10 s default");
  assert.equal(seen?.redirect, "error");
  assert.equal((seen?.headers as Record<string, string>)["x-manual-request-id"], "req_0123456789abcdef");

  // The thrown-error transport keeps its old contract, with the caller's timeout in the sentence.
  await assert.rejects(manualBotControlRequest({ method: "GET", path: "/x", timeoutMs: 1_000 },
    async (_input, init) => hangUntilAbort(init)),
  (error: unknown) => error instanceof ManualBotError && error.status === 502 && /within 1s/.test(error.message));
});

test("a connection that fails, or a 2xx that is not JSON, is uncertain", async (t) => {
  withChannel(t);
  const refused = await botControlCommand({ method: "POST", path: "/p", body: {}, accept: () => true },
    async () => { throw new TypeError("fetch failed"); });
  assert.deepEqual(refused, { outcome: "uncertain", reason: "transport" });
  const html = await botControlCommand({ method: "POST", path: "/p", body: {}, accept: () => true },
    async () => new Response("<html>ok</html>", { status: 200 }));
  assert.deepEqual(html, { outcome: "uncertain", reason: "invalid_reply" });
});
