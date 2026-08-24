/**
 * BE-11 / BOT-011: there was no kill switch, no daily-loss limit, no exposure
 * cap and no concurrency cap anywhere in either repository. With thirteen
 * correlated deployments across correlated coins, one market move could fire
 * every one of them on the same bar close with nothing to stop it.
 *
 * The two properties that matter most are asserted first, because getting
 * either wrong makes the control worse than not having it:
 *
 *   * an EXIT is never refused by a numeric limit;
 *   * every limit is off until an operator sets a number.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countOpenPositions, DEFAULT_RISK_LIMITS, describeRiskState, evaluateRisk,
  intendedExposure, realisedPnlInWindow, shouldLatchHalt,
  type ProposedOrder, type RiskLimits, type RiskSnapshot,
} from "../src/engine/riskControls";

const limits = (over: Partial<RiskLimits> = {}): RiskLimits => ({ ...DEFAULT_RISK_LIMITS, ...over });
const snap = (over: Partial<RiskSnapshot> = {}): RiskSnapshot => ({
  currentExposureQuote: 0, openPositions: 0, realisedPnlInWindow: 0, ...over,
});
const buy = (over: Partial<ProposedOrder> = {}): ProposedOrder => ({
  action: "buy", quoteQty: 340.01, alreadyLong: false, ...over,
});
const sell = (over: Partial<ProposedOrder> = {}): ProposedOrder => ({
  action: "sell", quoteQty: 0, alreadyLong: true, ...over,
});

// ── The two invariants ──────────────────────────────────────────────────────

test("with every limit unset, nothing is refused — the controls are opt-in", () => {
  const hostile = snap({
    currentExposureQuote: 1_000_000,
    openPositions: 500,
    realisedPnlInWindow: -999_999,
  });
  assert.deepEqual(evaluateRisk(limits(), hostile, buy()), { allowed: true });
  assert.deepEqual(evaluateRisk(limits(), hostile, sell()), { allowed: true });
});

test("a numeric limit NEVER blocks an exit — that would trap the bad position", () => {
  const tight = limits({
    maxTotalExposureQuote: 1,
    maxConcurrentPositions: 0,
    maxDailyLossQuote: 1,
  });
  const bad = snap({ currentExposureQuote: 99_999, openPositions: 99, realisedPnlInWindow: -50_000 });
  assert.deepEqual(evaluateRisk(tight, bad, sell()), { allowed: true });
  // The same snapshot refuses an entry.
  assert.equal(evaluateRisk(tight, bad, buy()).allowed, false);
});

// ── Kill switch ─────────────────────────────────────────────────────────────

test("the kill switch stops entries AND exits — it means touch nothing", () => {
  const halted = limits({ tradingHalted: true, haltedReason: "operator stop", haltedBy: "operator" });
  for (const order of [buy(), sell()]) {
    const d = evaluateRisk(halted, snap(), order);
    assert.equal(d.allowed, false, order.action);
    assert.equal(d.allowed ? "" : d.code, "trading_halted");
    assert.match(d.allowed ? "" : d.reason, /operator stop/);
  }
});

test("a halt with no reason still refuses, and says so plainly", () => {
  const d = evaluateRisk(limits({ tradingHalted: true }), snap(), buy());
  assert.equal(d.allowed, false);
  assert.equal(d.allowed ? "" : d.reason, "trading is halted");
});

// ── Exposure ────────────────────────────────────────────────────────────────

test("exposure is judged AFTER the proposed order, not before", () => {
  const l = limits({ maxTotalExposureQuote: 1000 });
  // 700 committed + 340.01 would be 1040.01 — over.
  const over = evaluateRisk(l, snap({ currentExposureQuote: 700 }), buy());
  assert.equal(over.allowed, false);
  assert.equal(over.allowed ? "" : over.code, "max_exposure");
  // 600 + 340.01 = 940.01 — under.
  assert.equal(evaluateRisk(l, snap({ currentExposureQuote: 600 }), buy()).allowed, true);
});

test("landing exactly on the exposure limit is allowed; a hair over is not", () => {
  const l = limits({ maxTotalExposureQuote: 1000 });
  assert.equal(evaluateRisk(l, snap({ currentExposureQuote: 0 }), buy({ quoteQty: 1000 })).allowed, true);
  assert.equal(evaluateRisk(l, snap({ currentExposureQuote: 0 }), buy({ quoteQty: 1000.01 })).allowed, false);
});

// ── Concurrency ─────────────────────────────────────────────────────────────

test("the concurrency cap counts positions, and adding to one already long does not count", () => {
  const l = limits({ maxConcurrentPositions: 3 });
  assert.equal(evaluateRisk(l, snap({ openPositions: 2 }), buy()).allowed, true);
  const blocked = evaluateRisk(l, snap({ openPositions: 3 }), buy());
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.allowed ? "" : blocked.code, "max_concurrent_positions");
  // Scaling into a position that is already open does not open a new one.
  assert.equal(evaluateRisk(l, snap({ openPositions: 3 }), buy({ alreadyLong: true })).allowed, true);
});

test("a zero concurrency cap refuses every new position", () => {
  const l = limits({ maxConcurrentPositions: 0 });
  assert.equal(evaluateRisk(l, snap({ openPositions: 0 }), buy()).allowed, false);
});

// ── Daily loss ──────────────────────────────────────────────────────────────

test("the daily-loss limit reads the rolling window and only counts losses", () => {
  const l = limits({ maxDailyLossQuote: 500 });
  assert.equal(evaluateRisk(l, snap({ realisedPnlInWindow: -499.99 }), buy()).allowed, true);
  const blocked = evaluateRisk(l, snap({ realisedPnlInWindow: -500 }), buy());
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.allowed ? "" : blocked.code, "daily_loss_limit");
  // A profit is not a loss, however large.
  assert.equal(evaluateRisk(l, snap({ realisedPnlInWindow: 10_000 }), buy()).allowed, true);
});

test("a daily-loss breach latches the kill switch rather than refusing order by order", () => {
  const l = limits({ maxDailyLossQuote: 500 });
  const decision = evaluateRisk(l, snap({ realisedPnlInWindow: -600 }), buy());
  assert.equal(shouldLatchHalt(decision), "daily_loss");
  // The other limits are self-clearing conditions and must NOT latch.
  assert.equal(shouldLatchHalt(evaluateRisk(limits({ maxConcurrentPositions: 0 }), snap(), buy())), null);
  assert.equal(shouldLatchHalt(evaluateRisk(limits({ maxTotalExposureQuote: 0 }), snap(), buy())), null);
  assert.equal(shouldLatchHalt({ allowed: true }), null);
});

test("limits are evaluated loss-first, so the most serious reason is the one reported", () => {
  const l = limits({ maxDailyLossQuote: 100, maxConcurrentPositions: 0, maxTotalExposureQuote: 0 });
  const d = evaluateRisk(l, snap({ realisedPnlInWindow: -200, openPositions: 9 }), buy());
  assert.equal(d.allowed, false);
  assert.equal(d.allowed ? "" : d.code, "daily_loss_limit");
});

// ── Snapshot helpers ────────────────────────────────────────────────────────

test("intended exposure sums only the deployments that are long", () => {
  const deployments = [
    { position: "long" as const, buyQuoteQty: 340.01 },
    { position: "long" as const, buyQuoteQty: 800 },
    { position: "flat" as const, buyQuoteQty: 10_000 },
    { position: "long" as const, buyQuoteQty: null },
  ];
  assert.equal(intendedExposure(deployments), 1140.01);
  assert.equal(countOpenPositions(deployments), 3);
  assert.equal(intendedExposure([]), 0);
});

test("the rolling P&L window excludes anything older than its horizon", () => {
  const now = 1_700_000_000_000;
  const rows = [
    { closedAt: now - 1_000, pnlQuote: -100 },
    { closedAt: now - 23 * 3_600_000, pnlQuote: -50 },
    { closedAt: now - 25 * 3_600_000, pnlQuote: -10_000 },
  ];
  assert.equal(realisedPnlInWindow(rows, 24, now), -150);
  assert.equal(realisedPnlInWindow(rows, 48, now), -10_150);
  assert.equal(realisedPnlInWindow(rows, 1, now), -100);
  assert.equal(realisedPnlInWindow([], 24, now), 0);
});

// ── Operator summary ────────────────────────────────────────────────────────

test("the operator summary states HALTED first, with the source and reason", () => {
  const text = describeRiskState(
    limits({ tradingHalted: true, haltedBy: "daily_loss", haltedReason: "loss 600 >= 500" }),
    snap()
  );
  assert.match(text, /^HALTED \(daily_loss\): loss 600 >= 500$/);
});

test("the live summary shows each figure against its limit, or bare when unset", () => {
  const withLimits = describeRiskState(
    limits({ maxTotalExposureQuote: 5000, maxConcurrentPositions: 4, maxDailyLossQuote: 250 }),
    snap({ currentExposureQuote: 1140.01, openPositions: 3, realisedPnlInWindow: -80 })
  );
  assert.match(withLimits, /^LIVE — /);
  assert.match(withLimits, /exposure 1140\.01\/5000\.00/);
  assert.match(withLimits, /positions 3\/4/);
  assert.match(withLimits, /24h loss 80\.00\/250\.00/);

  const bare = describeRiskState(limits(), snap({ openPositions: 2 }));
  assert.match(bare, /positions 2,/);
  assert.ok(!bare.includes("/"), bare);
});
