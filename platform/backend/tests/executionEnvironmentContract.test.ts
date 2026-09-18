/**
 * Where the execution ENVIRONMENT is decided, and where it is not.
 *
 * ── The thing that looks alarming ─────────────────────────────────────────
 *
 * `market/execution.ts` opens its pre-Bot gate with
 *
 *     const environment = intent.environment ?? "live";
 *
 * and the manual ticket sends no `environment` at all. Read on its own that
 * says the platform defaults every hand-typed order to real money, and the
 * panel's own sandbox restriction is client-side, so the browser is not what
 * stops it.
 *
 * ── Why it is not what it looks like ──────────────────────────────────────
 *
 * That `"live"` is a CAPABILITY question, not an AUTHORISATION one. It asks
 * "could this provider do that?", and the answer is never written back into
 * the command. The body forwarded to the Bot still carries no `environment`,
 * so the assumption dies in this process and nothing downstream ever sees it.
 *
 * The Bot then does not take the environment from the request at all. For a
 * manual order it reads `account.testnet` — a property of the stored
 * credential — and mainnet additionally needs `MAINNET_MANUAL_TRADING_ENABLED`
 * plus an exact confirmation phrase. An environment claimed in a payload
 * cannot move that, which is the whole point of deriving it from the
 * credential instead.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * All of that is true by construction today and none of it was pinned. A later
 * edit that "tidied" the default by writing it into the command, or that
 * forwarded `environment` for completeness, would turn a local assumption into
 * a wire assertion and nothing would have failed. These tests fail instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { manualTradingRoutes } from "../src/api/routes/manualTrading";
import { manualBotRequest, ManualBotError } from "../src/manualTrading/client";
import {
  assertExecutionSupported, defaultExecutionTarget, UnsupportedExecutionError,
  type ExecutionTarget,
} from "../src/market/execution";
import { config } from "../src/config";

const ORDER = {
  requestId: "browser-request-id-0000000",
  accountId: "11111111-1111-1111-1111-111111111111",
  symbol: "BTCUSDT", orderType: "MARKET", quoteQuantity: 25, side: "BUY",
};

const RUNNING = async () => ({ tradingHalted: false, haltedReason: null });

/** Captures the body that would have been signed and sent to the Bot. */
async function forwardedBody(payload: Record<string, unknown>) {
  let sent: Record<string, unknown> | undefined;
  const app = Fastify({ logger: false });
  await app.register(manualTradingRoutes, {
    riskLimits: RUNNING,
    shariah: { readMode: async () => "off" as const, lookupBaseAsset: async () => null },
    botRequest: async (input: { body?: unknown }) => {
      sent = input.body as Record<string, unknown>;
      return { ok: true };
    },
  });
  const response = await app.inject({
    method: "POST", url: "/api/manual-trading/orders", payload,
  });
  await app.close();
  return { response, sent };
}

test("the platform's 'live' default never travels: an order with no environment is forwarded without one", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });

  const { response, sent } = await forwardedBody(ORDER);

  assert.equal(response.statusCode, 200, response.body);
  assert.ok(sent, "the order should have reached the Bot seam");
  assert.equal(
    Object.prototype.hasOwnProperty.call(sent, "environment"), false,
    "`intent.environment ?? \"live\"` is a local capability assumption; writing it " +
    "into the forwarded command would turn it into a claim the Bot could act on"
  );
});

test("a client-supplied environment is passed through unchanged, not rewritten to live", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });

  const { response, sent } = await forwardedBody({ ...ORDER, environment: "testnet" });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(sent?.environment, "testnet",
    "the platform must not upgrade a stated environment");
});

test("the capability gate refuses an environment the provider does not declare, before the Bot", () => {
  // A provider that can only be reached in a sandbox. The default `"live"`
  // makes an ABSENT environment fail this gate rather than pass it, so the
  // permissive-looking default is not permissive where it would matter.
  const sandboxOnly: ExecutionTarget = {
    ...defaultExecutionTarget("BTCUSDT"),
    providerId: "sandbox-only-venue",
    capabilities: {
      ...defaultExecutionTarget("BTCUSDT").capabilities,
      availability: { paper: true, testnet: true, live: false },
    },
  };

  assert.throws(
    () => assertExecutionSupported(sandboxOnly, {}),
    (error: unknown) =>
      error instanceof UnsupportedExecutionError &&
      /does not support live execution/.test(error.message),
    "an absent environment must not silently become a sandbox order either"
  );

  // ...and the environments it does declare still pass.
  assert.doesNotThrow(() => assertExecutionSupported(sandboxOnly, { environment: "paper" }));
  assert.doesNotThrow(() => assertExecutionSupported(sandboxOnly, { environment: "testnet" }));
});

test("an unrepresentable environment is refused rather than coerced", () => {
  const target = defaultExecutionTarget("BTCUSDT");
  assert.throws(
    () => assertExecutionSupported(target, { environment: "mainnet" }),
    (error: unknown) =>
      error instanceof UnsupportedExecutionError &&
      /unsupported execution environment: mainnet/.test(error.message)
  );
});

test("the feature flag refuses at the transport, so no route can forget it", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = false;
  t.after(() => { config.manualTradingEnabled = previous; });

  let fetched = false;
  const spy: typeof fetch = async () => { fetched = true; return new Response("{}"); };

  await assert.rejects(
    () => manualBotRequest({ method: "POST", path: "/api/manual-trading/orders", body: ORDER }, spy),
    (error: unknown) =>
      error instanceof ManualBotError && /manual trading is disabled/.test(error.message)
  );
  assert.equal(fetched, false,
    "a disabled installation must not open a connection to the Bot at all");
});
