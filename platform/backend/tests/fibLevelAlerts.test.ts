/**
 * The fib_level alert family's request rules and the words it notifies with.
 * Evaluation through the real runner is in maAlertRunnerIntegration.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCondition, validateCondition, type AlertCondition } from "../src/alerts/alertConditions";
import { readCondition, toColumns } from "../src/alerts/alertRequest";

const read = (body: Record<string, unknown>) => readCondition("fib_level", body);

test("a fib alert defaults to the indicator's own settings and the 0.618 touch", () => {
  const r = read({});
  assert.ok("condition" in r);
  const c = r.condition as Extract<AlertCondition, { kind: "fib_level" }>;
  assert.deepEqual(
    { deviation: c.deviation, depth: c.depth, reverse: c.reverse, level: c.level, mode: c.mode },
    { deviation: 3, depth: 30, reverse: false, level: 0.618, mode: "touch" });
  assert.equal(validateCondition(r.condition), null);
});

test("inputs the zig-zag cannot use, or a level it never draws, are refused", () => {
  for (const [body, why] of [
    [{ fibDepth: 1 }, "depth below 2 has no pivot window"],
    [{ fibDepth: 30.5 }, "depth is a bar count"],
    [{ fibDeviation: -1 }, "negative deviation"],
    [{ fibLevel: 11 }, "beyond any level the indicator offers"],
    [{ fibLevel: "half" }, "not a number"],
    [{ mode: "sideways" }, "unknown mode"],
  ] as const) {
    assert.ok("error" in read(body as Record<string, unknown>), why);
  }
});

test("every input reaches its column", () => {
  const r = read({ fibDeviation: 2.5, fibDepth: 24, fibReverse: true, fibLevel: 0.786, mode: "cross_up" });
  assert.ok("condition" in r);
  const cols = toColumns(r.condition);
  assert.deepEqual(
    { d: cols.fibDeviation, p: cols.fibDepth, r: cols.fibReverse, l: cols.fibLevel, m: cols.mode },
    { d: 2.5, p: 24, r: true, l: 0.786, m: "cross_up" });
});

test("the notification names the level, and the inputs only when tuned", () => {
  const d = (body: Record<string, unknown>) => {
    const r = read(body); assert.ok("condition" in r); return describeCondition(r.condition);
  };
  assert.equal(d({ fibLevel: 0.618, mode: "touch" }), "touches the 0.618 auto fib level");
  assert.equal(d({ fibLevel: 0.5, mode: "cross_down", fibDepth: 20 }),
    "crosses below the 0.5 auto fib level (dev 3, depth 20)");
  assert.equal(d({ fibLevel: 0.382, mode: "cross_up", fibReverse: true }),
    "crosses above the 0.382 auto fib level (reversed)");
});
