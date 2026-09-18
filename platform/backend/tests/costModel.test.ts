/**
 * X-09 / OPT-03 — one commission figure, and it is the trees' figure.
 *
 * The audit found a three-way contradiction: the blueprint said 0.05 %, the
 * handoff said 0.1 %, and the backtest API defaulted to 0.05 % while every
 * optimizer tree on disk ran 0.1 % per side. A run at half the real friction
 * cannot reproduce a leaderboard row, and nothing said so.
 *
 * The trees now live in the backtesting repository, so the half of this that
 * reads them — "every tree charges 0.1 %", "optimizer1y1h is the only
 * zero-slippage tree" — moved there with them
 * (backtesting:scripts/ci/check_docs.py). What stays here is the half that is
 * about THIS repository: the backtest API's default and the chart's default
 * must both state the trees' figure, and they must agree with each other.
 * Those are the two values a user's ad-hoc chart backtest actually runs at,
 * and they were the ones that were wrong.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_COMMISSION_PCT, DEFAULT_INITIAL_CAPITAL, DEFAULT_SLIPPAGE_TICKS,
} from "../src/api/routes/backtests";

const BACKEND = path.resolve(__dirname, "..");

/**
 * The figure every optimizer tree runs, verified against the trees themselves
 * by the backtesting repository's docs check. It is restated here as a literal
 * because this repository can no longer read a tree to derive it — and a
 * default that drifts from the trees is finding X-09 exactly.
 */
const TREE_COMMISSION_PCT = 0.1;

test("the backtest API's default commission matches what the trees run", () => {
  assert.equal(DEFAULT_COMMISSION_PCT, TREE_COMMISSION_PCT);
  assert.equal(DEFAULT_SLIPPAGE_TICKS, 2);
  assert.equal(DEFAULT_INITIAL_CAPITAL, 1000);
});

test("the frontend's default properties state the same commission", () => {
  const src = fs.readFileSync(
    path.join(BACKEND, "..", "frontend", "components", "tv", "StrategySettingsModal.tsx"),
    "utf8"
  );
  const block = src.slice(src.indexOf("export const DEFAULT_PROPERTIES"));
  const match = /commissionPct:\s*([\d.]+)/.exec(block);
  assert.ok(match, "DEFAULT_PROPERTIES must state commissionPct");
  assert.equal(Number(match[1]), DEFAULT_COMMISSION_PCT);
});

/**
 * The recurrence vector, closed.
 *
 * X-09 was not a wrong number so much as a number typed in more than one
 * place. It came back exactly that way: `routes/pine.ts` defaulted an ad-hoc
 * Pine run to `slippageTicks ?? 0` while the constant beside it said 2, and
 * `scripts/run_backtest_cli.ts` still carried `?? 0.05` — the pre-X-09 figure
 * the constant was created to retire — years after the route stopped using it.
 * Neither drifted; both were re-typed, which is the same defect arriving by a
 * different route.
 *
 * So this asserts the SHAPE rather than the values: no caller may state its
 * own fallback for these three fields. A number that exists once cannot
 * disagree with itself.
 *
 * `repositories/layouts.ts` is deliberately exempt. Its
 * `defaultSyncedProperties` states 0 slippage as a recorded product decision
 * ("the defaults the user standardized on", handoff §7) rather than as a
 * forgotten default, and the Strategy Tester sends that value explicitly, so
 * it never reaches a `??` here. Changing it is the owner's call, not a tidy-up.
 */
const COST_FIELDS = ["initialCapital", "commissionPct", "slippageTicks"] as const;

const CALLERS = [
  "src/api/routes/pine.ts",
  "src/api/routes/stress.ts",
  "scripts/run_backtest_cli.ts",
] as const;

test("no caller states its own fallback for the cost model", () => {
  for (const file of CALLERS) {
    const src = fs.readFileSync(path.join(BACKEND, file), "utf8");
    for (const field of COST_FIELDS) {
      // `commissionPct: body.commissionPct ?? 0.1` and friends — a literal on
      // the right of a nullish coalesce, in a cost-model position.
      const retyped = new RegExp(`${field}[^\\n]*\\?\\?\\s*[\\d.]+`);
      assert.equal(
        retyped.test(src), false,
        `${file} re-types a ${field} default instead of importing DEFAULT_*`
      );
    }
  }
});

test("the reported holdout fraction is the one that was applied", async () => {
  // `executeBacktest` puts `holdoutFraction` on the result and `splitWindows`
  // decides the split. These were two independent `?? 0.2`s, so moving the
  // policy figure would have left the research page printing a split that did
  // not happen.
  const { DEFAULT_HOLDOUT_FRACTION } = await import("../src/engine/holdout");
  assert.equal(DEFAULT_HOLDOUT_FRACTION, 0.2);

  for (const file of ["src/engine/holdout.ts", "src/engine/backtester.ts"]) {
    const src = fs.readFileSync(path.join(BACKEND, file), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.equal(
      /holdoutFraction[^\n]*\?\?\s*[\d.]+/.test(code), false,
      `${file} re-types the holdout fraction instead of importing it`
    );
  }
});
