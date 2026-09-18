/**
 * The operator halt reaches the live test signal too.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * `POST /api/deployments/:id/test-signal` places a REAL order through the same
 * dispatcher the live runner uses — its own comment says so — and it was gated
 * like a new-exposure path in every way except the one the operator pressed:
 * `deployments.ts` did not import `liveSafety` at all.
 *
 * That is the same defect `manualHalt.test.ts` was written for. The halt
 * stopped the automated deployments and nothing else, while `/api/ops/status`
 * reported `mode: "HALTED"` for the whole platform; the repair went to the
 * manual ticket, and this second real-order path was missed. The Operations
 * page says "Halting refuses every emission, entries and exits alike" while
 * this route answered.
 *
 * ── What must NOT be fixed with it ────────────────────────────────────────
 *
 * The exit. `shariah/gate.ts` states the rule the product follows — "SELL is
 * never gated, here as everywhere" — and halting is precisely when an operator
 * needs to close by hand. Both directions are pinned here, because this
 * repository has twice shipped a safety fix that trapped the exit it was
 * protecting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { config } from "../src/config";
import { deploymentRoutes } from "../src/api/routes/deployments";
import type { LiveRunner } from "../src/engine/liveRunner";

const HALTED = async () => ({ tradingHalted: true, haltedReason: "feed lost" });
const RUNNING = async () => ({ tradingHalted: false, haltedReason: null });

/** A runner that would throw if anything actually reached it. */
const runner = () => ({
  activate: () => { throw new Error("no deployment may be activated here"); },
  deactivate: () => { throw new Error("no deployment may be deactivated here"); },
} as unknown as LiveRunner);

async function testSignal(
  action: "buy" | "sell",
  riskLimits: () => Promise<{ tradingHalted: boolean; haltedReason: string | null }>,
) {
  /*
   * The route 404s unless the live-test flag is on, which is correct and is
   * not what this file is about. Turned on for the call and restored after, so
   * the halt is the only thing under test.
   */
  const previous = config.liveTestEnabled;
  config.liveTestEnabled = true;
  const app = Fastify({ logger: false });
  await app.register(deploymentRoutes(runner, {
    riskLimits,
    /*
     * No database. A SELL has to get PAST the halt to prove the gate does not
     * trap an exit, and continuing would otherwise mean a real query whose
     * connection a parallel test file's teardown can close underneath it —
     * which surfaces as "asynchronous activity after the test ended" rather
     * than as a failure.
     */
    getDeployment: async () => null,
    // The Shariah gate is injected as OFF so this test is about the halt and
    // nothing else; a refusal from either would otherwise look the same.
    shariah: { readMode: async () => "off" as const, lookupBaseAsset: async () => null },
  }));
  const response = await app.inject({
    method: "POST",
    url: "/api/deployments/11111111-1111-4111-8111-111111111111/test-signal",
    payload: { action, confirmation: "LIVE_TEST" },
  });
  await app.close();
  config.liveTestEnabled = previous;
  return response;
}

test("a halted platform refuses a BUY test signal", async () => {
  const response = await testSignal("buy", HALTED);
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error, /trading is halted: feed lost/);
});

test("the refusal says the exit is still open, so the operator is not stuck guessing", async () => {
  const response = await testSignal("buy", HALTED);
  assert.match(response.json().error, /Closing an open position is still allowed/);
});

test("a halted platform does NOT refuse a SELL at the halt gate", async () => {
  /*
   * A SELL must get PAST the halt. It is refused further on for its own
   * reasons — this deployment does not exist, and the route is behind a
   * feature flag — so what is asserted is the thing this gate is responsible
   * for: the halt is not what stopped it.
   */
  const response = await testSignal("sell", HALTED);
  assert.notEqual(response.statusCode, 409,
    "halting must not trap an operator trying to close by hand");
  assert.doesNotMatch(response.body, /trading is halted/,
    "the halt refused an exit");
});

test("a running platform is unchanged in both directions", async () => {
  for (const action of ["buy", "sell"] as const) {
    const response = await testSignal(action, RUNNING);
    assert.notEqual(response.statusCode, 409, `${action} was refused by a halt that is off`);
    assert.doesNotMatch(response.body, /trading is halted/);
  }
});
