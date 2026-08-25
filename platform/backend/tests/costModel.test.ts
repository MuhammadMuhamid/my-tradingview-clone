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
