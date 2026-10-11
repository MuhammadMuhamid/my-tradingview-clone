/**
 * C-03 / C-04: the surfaces that arm alerts and run automations are told
 * whether anything on this install will evaluate them.
 *
 * Both routes are exercised over HTTP with no database: the alert options
 * route never touched one, and the runner route takes its halt latch as an
 * injected dependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { maAlertRoutes } from "../src/api/routes/maAlerts";
import {
  formatAlertRunnerStatus, operationsRoutes, strategyRunnerStatus,
} from "../src/api/routes/operations";
import { alertEvaluation, ALERT_EVALUATOR_DISABLED_REASON } from "../src/alerts/evaluationGate";
import type { LiveRunner } from "../src/engine/liveRunner";

function withEnv(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const before = process.env.MA_ALERTS_ENABLED;
  if (value === undefined) delete process.env.MA_ALERTS_ENABLED;
  else process.env.MA_ALERTS_ENABLED = value;
  return run().finally(() => {
    if (before === undefined) delete process.env.MA_ALERTS_ENABLED;
    else process.env.MA_ALERTS_ENABLED = before;
  });
}

test("the alert evaluator gate is opt-out, and only the literal 'false' turns it off", () => {
  assert.deepEqual(alertEvaluation({}), { enabled: true, reason: null });
  assert.deepEqual(alertEvaluation({ MA_ALERTS_ENABLED: "true" }), { enabled: true, reason: null });
  assert.deepEqual(alertEvaluation({ MA_ALERTS_ENABLED: "false" }),
    { enabled: false, reason: ALERT_EVALUATOR_DISABLED_REASON });
});

test("/api/ma-alerts/options says when this install does not evaluate alerts", async () => {
  await withEnv("false", async () => {
    const app = Fastify({ logger: false });
    await app.register(maAlertRoutes);
    try {
      const response = await app.inject({ method: "GET", url: "/api/ma-alerts/options" });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().evaluation,
        { enabled: false, reason: ALERT_EVALUATOR_DISABLED_REASON });
      // The vocabulary is still served: creating an alert stays allowed.
      assert.ok(Array.isArray(response.json().frequencies));
    } finally {
      await app.close();
    }
  });
});

test("/api/ma-alerts/options reports an enabled evaluator by default", async () => {
  await withEnv(undefined, async () => {
    const app = Fastify({ logger: false });
    await app.register(maAlertRoutes);
    try {
      const response = await app.inject({ method: "GET", url: "/api/ma-alerts/options" });
      assert.deepEqual(response.json().evaluation, { enabled: true, reason: null });
    } finally {
      await app.close();
    }
  });
});

test("Operations and the alert options read the same gate", () => {
  const status = formatAlertRunnerStatus(false, [], Date.now());
  assert.equal(status.state, "disabled");
  assert.equal(status.reason, ALERT_EVALUATOR_DISABLED_REASON);
});

test("a runner that is not enabled evaluates nothing, whatever else is true", () => {
  for (const isEmitter of [true, false]) {
    for (const tradingHalted of [true, false, null]) {
      const status = strategyRunnerStatus({ liveRunnerEnabled: false, isEmitter, tradingHalted });
      assert.equal(status.state, "off");
      assert.equal(status.evaluating, false);
    }
  }
});

test("an enabled runner is live only while it holds the lease, and halted wins over live", () => {
  assert.deepEqual(
    strategyRunnerStatus({ liveRunnerEnabled: true, isEmitter: true, tradingHalted: false }).state, "live");
  assert.equal(
    strategyRunnerStatus({ liveRunnerEnabled: true, isEmitter: true, tradingHalted: false }).evaluating, true);
  assert.equal(
    strategyRunnerStatus({ liveRunnerEnabled: true, isEmitter: false, tradingHalted: false }).state, "standby");
  assert.equal(
    strategyRunnerStatus({ liveRunnerEnabled: true, isEmitter: false, tradingHalted: null }).evaluating, false);
  assert.equal(
    strategyRunnerStatus({ liveRunnerEnabled: true, isEmitter: true, tradingHalted: true }).state, "halted");
});

async function runnerServer(input: {
  enabled: boolean; isEmitter: boolean; halted: () => Promise<boolean>;
}) {
  const app = Fastify({ logger: false });
  const runner = { isEmitter: input.isEmitter } as unknown as LiveRunner;
  await app.register(operationsRoutes(() => runner, {
    liveRunnerEnabled: () => input.enabled,
    readTradingHalted: input.halted,
  }));
  return app;
}

test("/api/ops/runner says the runner is off when LIVE_RUNNER_ENABLED is not true", async () => {
  const app = await runnerServer({ enabled: false, isEmitter: false, halted: async () => false });
  try {
    const response = await app.inject({ method: "GET", url: "/api/ops/runner" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().state, "off");
    assert.equal(response.json().evaluating, false);
  } finally {
    await app.close();
  }
});

test("/api/ops/runner never 500s on an unreadable halt latch", async () => {
  const app = await runnerServer({
    enabled: true, isEmitter: true, halted: async () => { throw new Error("database down"); },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/ops/runner" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().state, "live");
  } finally {
    await app.close();
  }
});

test("/api/ops/runner reports a halt", async () => {
  const app = await runnerServer({ enabled: true, isEmitter: true, halted: async () => true });
  try {
    const response = await app.inject({ method: "GET", url: "/api/ops/runner" });
    assert.equal(response.json().state, "halted");
  } finally {
    await app.close();
  }
});
