/**
 * OPT-01 — the deploy-time holdout gate.
 *
 * `src/engine/holdout.ts` defined the gate and nothing called it; its own
 * comment said "this is the shape of the gate they should apply". The deploy
 * scripts accepted whatever the selection artifact named, and every
 * configuration in that artifact was chosen by gating and maximising on the
 * out-of-sample window it is now cited as evidence for.
 *
 * The gate lives twice on purpose: in TypeScript for the application, and as a
 * standalone `.mjs` so the deploy scripts stay runnable with nothing but node
 * inside the container. These tests hold the two to the same answers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertHoldoutClearance, clearanceVerdict, gateRulesFrom,
} from "../../deployment/aws/lib/holdoutGate.mjs";
import { evaluateClearance } from "../src/engine/holdout.ts";

const WINDOW = { startMs: Date.UTC(2026, 4, 1), endMs: Date.UTC(2026, 7, 1) };
const RULES = { minTrades: 30, minNetPct: 0, expected: WINDOW };
const cleared = {
  configId: "c1", scoredAt: Date.UTC(2026, 7, 2), netPct: 4.5, trades: 41,
  engine: "mtf_lean@v1", holdoutStartMs: WINDOW.startMs, holdoutEndMs: WINDOW.endMs,
};

const CASES = [
  ["a scored, in-window, above-threshold result clears", cleared],
  ["no record at all", null],
  ["a record that was never scored", { ...cleared, scoredAt: null }],
  ["a result scored against a moved window", { ...cleared, holdoutStartMs: WINDOW.startMs - 1 }],
  ["a result scored against a moved end", { ...cleared, holdoutEndMs: WINDOW.endMs + 1 }],
  ["too few trades to distinguish edge from noise", { ...cleared, trades: 29 }],
  ["a negative holdout net", { ...cleared, netPct: -0.1 }],
  ["a null net", { ...cleared, netPct: null }],
  ["a null trade count", { ...cleared, trades: null }],
];

for (const [label, clearance] of CASES) {
  test(`the two implementations agree: ${label}`, () => {
    const js = clearanceVerdict(clearance, RULES);
    const ts = evaluateClearance(clearance, RULES);
    assert.equal(js.cleared, ts.cleared, label);
    assert.equal(js.reason ?? null, ts.reason ?? null, label);
  });
}

test("ABSENCE OF A RESULT IS A REFUSAL, not a pass", () => {
  const verdict = clearanceVerdict(null, RULES);
  assert.equal(verdict.cleared, false);
  assert.match(verdict.reason, /Absence of a result is\s+not a pass/);
});

test("an artifact with no holdout window refuses the whole deployment", () => {
  assert.throws(
    () => assertHoldoutClearance({ coins: {} }, [{ symbol: "SOLUSDT" }], "replace_x.mjs"),
    (err) => /carries no `holdout_window`/.test(err.message)
      && /holdout_rules/.test(err.message)          // it says what to add
      && /HOLDOUT_GATE=off/.test(err.message)       // and how to override deliberately
  );
});

test("one uncleared coin refuses the WHOLE portfolio", () => {
  const report = { holdout_window: WINDOW, holdout_rules: { minTrades: 30, minNetPct: 0 } };
  const entries = [
    { symbol: "AAAUSDT", holdout: cleared },
    { symbol: "BBBUSDT", holdout: { ...cleared, trades: 4 } },
  ];
  assert.throws(
    () => assertHoldoutClearance(report, entries, "replace_x.mjs"),
    (err) => /1 of 2 configurations/.test(err.message) && /BBBUSDT/.test(err.message)
  );
});

test("a fully cleared portfolio passes", () => {
  const report = { holdout_window: WINDOW, holdout_rules: { minTrades: 30, minNetPct: 0 } };
  const result = assertHoldoutClearance(
    report, [{ symbol: "AAAUSDT", holdout: cleared }], "replace_x.mjs"
  );
  assert.deepEqual(result, { cleared: true, overridden: false });
});

test("the rules come from the artifact, so a window cannot be chosen at deploy time", () => {
  assert.equal(gateRulesFrom({}), null);
  assert.equal(gateRulesFrom({ holdout_window: { startMs: "x", endMs: 1 } }), null);
  const rules = gateRulesFrom({ holdout_window: WINDOW });
  assert.deepEqual(rules.expected, WINDOW);
  assert.equal(rules.minTrades, 30, "a default floor, not an absent one");
  assert.equal(rules.minNetPct, 0);
});

test("the override must be deliberate AND give a reason", () => {
  const saved = { gate: process.env.HOLDOUT_GATE, reason: process.env.HOLDOUT_OVERRIDE_REASON };
  try {
    process.env.HOLDOUT_GATE = "off";
    delete process.env.HOLDOUT_OVERRIDE_REASON;
    assert.throws(
      () => assertHoldoutClearance({}, [], "replace_x.mjs"),
      /also requires HOLDOUT_OVERRIDE_REASON/
    );
    process.env.HOLDOUT_OVERRIDE_REASON = "emergency reconfiguration, ticket 12";
    const warn = console.warn;
    const lines = [];
    console.warn = (m) => lines.push(String(m));
    try {
      const result = assertHoldoutClearance({}, [], "replace_x.mjs");
      assert.deepEqual(result,
        { cleared: false, overridden: true, reason: "emergency reconfiguration, ticket 12" });
      assert.match(lines.join("\n"), /HOLDOUT GATE OVERRIDDEN/);
      assert.match(lines.join("\n"), /ticket 12/);
    } finally {
      console.warn = warn;
    }
  } finally {
    if (saved.gate === undefined) delete process.env.HOLDOUT_GATE;
    else process.env.HOLDOUT_GATE = saved.gate;
    if (saved.reason === undefined) delete process.env.HOLDOUT_OVERRIDE_REASON;
    else process.env.HOLDOUT_OVERRIDE_REASON = saved.reason;
  }
});
