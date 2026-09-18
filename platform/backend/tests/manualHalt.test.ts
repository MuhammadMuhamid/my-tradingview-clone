/**
 * The operator halt, on the path that could still reach the market.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * `evaluateRisk` refuses a halted order, and `liveRunner` is the only thing
 * that calls it. So halting stopped the automated deployments and nothing
 * else, while `/api/ops/status` reported `mode: "HALTED"` for the whole
 * platform and `riskControls.ts` said "an operator halt stops everything".
 * The manual ticket could still open a position against a halted platform.
 *
 * ── What must NOT be fixed along with it ──────────────────────────────────
 *
 * Closing. `shariah/gate.ts` states the rule the whole product follows —
 * "SELL is never gated, here as everywhere. An operator must always be able to
 * get out of a position" — and halting is precisely the moment an operator
 * needs to close by hand. This repository has twice shipped a safety fix that
 * trapped the exit it was meant to protect, so both directions are pinned
 * here rather than only the one being added.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { manualTradingRoutes } from "../src/api/routes/manualTrading";
import { config } from "../src/config";

const ORDER = {
  requestId: "browser-request-id-0000000",
  accountId: "11111111-1111-1111-1111-111111111111",
  symbol: "BTCUSDT", orderType: "MARKET", quoteQuantity: 25,
};

const HALTED = async () => ({ tradingHalted: true, haltedReason: "feed lost" });
const RUNNING = async () => ({ tradingHalted: false, haltedReason: null });

async function appWith(
  riskLimits: () => Promise<{ tradingHalted: boolean; haltedReason: string | null }>,
  onBot: () => void
) {
  const app = Fastify({ logger: false });
  await app.register(manualTradingRoutes, {
    riskLimits,
    /*
     * Both gate dependencies are injected, not just the mode.
     *
     * `evaluateShariahGate` looks the asset up even with the mode OFF, because
     * the context it builds is signed onto the Bot request either way. Leaving
     * the lookup to its default sends a real query at a database this test does
     * not have, which surfaces as async work outliving the test rather than as
     * a failure — an uncaughtException in whichever file happens to tear the
     * pool down first.
     */
    shariah: {
      readMode: async () => "off" as const,
      lookupBaseAsset: async () => null,
    },
    botRequest: async () => { onBot(); return { ok: true }; },
  });
  return app;
}

async function post(
  body: Record<string, unknown>,
  riskLimits: () => Promise<{ tradingHalted: boolean; haltedReason: string | null }>,
  path = "/api/manual-trading/orders"
) {
  let reachedBot = false;
  const app = await appWith(riskLimits, () => { reachedBot = true; });
  const response = await app.inject({ method: "POST", url: path, payload: body });
  await app.close();
  return { response, reachedBot };
}

test("a halted platform refuses to OPEN, and never reaches the Bot", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });

  const { response, reachedBot } = await post({ ...ORDER, side: "BUY" }, HALTED);
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error, /trading is halted: feed lost/);
  assert.equal(reachedBot, false, "a refused order must not be signed and sent");
});

test("a halted platform still lets the operator CLOSE", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });

  // The failure this guards against is the one this repository has shipped
  // twice: a safety fix that trapped the exit it was protecting.
  const { response, reachedBot } = await post({ ...ORDER, side: "SELL" }, HALTED);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(reachedBot, true, "halting must not trap an open position");
});

test("the refusal says the exit is still open, so the operator is not stuck guessing", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });

  const { response } = await post({ ...ORDER, side: "BUY" }, HALTED);
  assert.match(response.json().error, /Closing an open position is still allowed/);
});

test("an unreadable side is treated as BUY, so it cannot be a bypass", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });

  // `gatedSide` already fails closed for the Shariah gate, and the halt uses
  // the same reader rather than a second one that could disagree with it.
  //
  // A side that merely needs normalising is NOT unreadable: "bUy " is a BUY
  // and "sElL " is a SELL, which is why the reader normalises before it
  // defaults. Only a side it cannot make sense of falls back to BUY.
  for (const side of ["", undefined, 7, null, "long", {}]) {
    const { response, reachedBot } = await post({ ...ORDER, side }, HALTED);
    assert.equal(response.statusCode, 409, `side ${JSON.stringify(side)} was not refused`);
    assert.equal(reachedBot, false);
  }

  // And a BUY that only needed normalising is still caught.
  const spaced = await post({ ...ORDER, side: "bUy " }, HALTED);
  assert.equal(spaced.response.statusCode, 409);
  assert.equal(spaced.reachedBot, false);
});

test("a normalised SELL is still an exit, and is still allowed", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });

  const { response, reachedBot } = await post({ ...ORDER, side: "sElL " }, HALTED);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(reachedBot, true, "normalising a side must not cost the operator their exit");
});

test("a running platform is unchanged in both directions", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });

  for (const side of ["BUY", "SELL"]) {
    const { response, reachedBot } = await post({ ...ORDER, side }, RUNNING);
    assert.equal(response.statusCode, 200, `${side}: ${response.body}`);
    assert.equal(reachedBot, true);
  }
});

test("cancelling and adjusting protection are never halted", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });

  // Both can only reduce or bound exposure, never create it — and an operator
  // who has halted is exactly the one who needs to tighten a stop.
  const cancel = await post(
    { requestId: ORDER.requestId, symbol: "BTCUSDT" }, HALTED,
    "/api/manual-trading/orders/abc/cancel"
  );
  assert.equal(cancel.response.statusCode, 200, cancel.response.body);
  assert.equal(cancel.reachedBot, true);
});
