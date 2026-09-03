import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ManualBotError, canonicalJson, manualBotRequest, signManualCommand,
} from "../src/manualTrading/client";
import { config } from "../src/config";
import { pushShariahModeToBot } from "../src/shariah/botEnforcement";

test("platform signs the distinct manual command canonical method/path/body", () => {
  const body = { side: "BUY", nested: { z: 2, a: 1 } };
  const input = { method: "POST", path: "/api/manual-trading/orders?z=2&a=1",
    timestamp: "1700000000000", nonce: "nonce_1234567890123456",
    requestId: "request_123456789012", body };
  const secret = "h".repeat(40);
  const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  const expected = `v1=${createHmac("sha256", secret).update([
    "POST", "/api/manual-trading/orders?a=1&z=2", input.timestamp,
    input.nonce, input.requestId, bodyHash,
  ].join("\n")).digest("hex")}`;
  assert.equal(signManualCommand(input, secret), expected);
  assert.notEqual(signManualCommand({ ...input, body: { side: "SELL" } }, secret), expected);
});

test("manual HMAC material has no frontend reference", () => {
  const frontend = path.resolve(__dirname, "../../frontend");
  const files: string[] = [];
  const visit = (dir: string) => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === "node_modules" || item.name === ".next") continue;
    const full = path.join(dir, item.name); if (item.isDirectory()) visit(full); else files.push(full);
  }};
  visit(frontend);
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /MANUAL_TRADING_HMAC_SECRET|x-manual-signature/i, file);
  }
});

/**
 * An execution bot that never answered is an upstream failure, not ours.
 *
 * `fetch` rejects on a refused connection, a DNS failure or the 10s timeout.
 * That rejection is not a `ManualBotError`, so it used to fall through the
 * route handler to Fastify's generic 500 and reach the operator's trading panel
 * as "internal server error" — wrong about whose fault it is, and useless about
 * what to do. Nothing about what EXECUTES changed here: the request had already
 * failed. Only the status and the sentence are different.
 */
test("an unreachable execution bot is a named 502, not an internal server error", async () => {
  const priorEnabled = config.manualTradingEnabled;
  const priorSecret = config.manualTradingHmacSecret;
  try {
    config.manualTradingEnabled = true;
    config.manualTradingHmacSecret = "a".repeat(64);

    const refused = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    await assert.rejects(
      () => manualBotRequest({ method: "GET", path: "/api/manual-trading/state" }, refused),
      (error: unknown) => {
        assert.ok(error instanceof ManualBotError);
        assert.equal(error.status, 502);
        assert.equal(error.message, "the execution bot could not be reached");
        return true;
      });

    const timedOut = async (): Promise<Response> => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    };
    await assert.rejects(
      () => manualBotRequest({ method: "GET", path: "/api/manual-trading/state" }, timedOut),
      (error: unknown) => {
        assert.ok(error instanceof ManualBotError);
        assert.equal(error.status, 502);
        assert.equal(error.message, "the execution bot did not respond within 10s");
        return true;
      });

    // A bot that DID answer still reports its own status and its own words.
    const refusedByBot = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "insufficient balance" }), { status: 400 });
    await assert.rejects(
      () => manualBotRequest({ method: "GET", path: "/api/manual-trading/state" }, refusedByBot),
      (error: unknown) => {
        assert.ok(error instanceof ManualBotError);
        assert.equal(error.status, 400);
        assert.equal(error.message, "insufficient balance");
        return true;
      });
  } finally {
    config.manualTradingEnabled = priorEnabled;
    config.manualTradingHmacSecret = priorSecret;
  }
});

/** The Shariah refusal is unchanged; only its sentence is now usable. */
test("a refused Shariah mode change states what is true and what to do", async () => {
  const failed = await pushShariahModeToBot("enforce", {
    controlChannelConfigured: true,
    request: async () => { throw new ManualBotError("the execution bot could not be reached", 502); },
  }).catch((e: Error) => e);

  assert.ok(failed instanceof Error);
  assert.match(failed.message, /the change was not applied and Platform Shariah Mode is unchanged/);
  assert.match(failed.message, /Cause: the execution bot could not be reached/);
  assert.match(failed.message, /Check that the execution bot is running and reachable/);
  assert.doesNotMatch(failed.message, /was not applied: fetch failed/);
});
