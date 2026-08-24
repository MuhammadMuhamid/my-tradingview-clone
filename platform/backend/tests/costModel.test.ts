/**
 * X-09 / OPT-03 — one commission figure, and it is the trees' figure.
 *
 * The audit found a three-way contradiction: the blueprint said 0.05 %, the
 * handoff said 0.1 %, and the backtest API defaulted to 0.05 % while every
 * optimizer tree on disk ran 0.1 % per side. A run at half the real friction
 * cannot reproduce a leaderboard row, and nothing said so.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_COMMISSION_PCT, DEFAULT_INITIAL_CAPITAL, DEFAULT_SLIPPAGE_TICKS,
} from "../src/api/routes/backtests";
import { listTrees } from "../src/optimizer/registry";

const BACKEND = path.resolve(__dirname, "..");

test("every optimizer tree charges 0.1 % per side — no tree uses 0.05 % or 0.075 %", () => {
  const trees = listTrees(BACKEND);
  assert.ok(trees.length > 0);
  for (const tree of trees) {
    assert.equal(tree.cost.commissionPct, 0.1, `${tree.id} commissionPct`);
  }
});

test("the backtest API's default commission matches what the trees run", () => {
  assert.equal(DEFAULT_COMMISSION_PCT, 0.1);
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

test("the trees disagree on capital and slippage, and that is recorded, not averaged", () => {
  const trees = listTrees(BACKEND);
  const slippage = new Set(trees.map((t) => t.cost.slippageTicks));
  // optimizer1y1h is the only zero-slippage tree. If that stops being true the
  // "not comparable" note in docs/COST-MODELS.md needs rewriting.
  const zero = trees.filter((t) => t.cost.slippageTicks === 0).map((t) => t.id);
  assert.deepEqual(zero, ["optimizer1y1h"]);
  assert.ok(slippage.size > 1);
  assert.equal(trees.find((t) => t.id === "optimizer1y1h")!.status, "not-comparable");
});
