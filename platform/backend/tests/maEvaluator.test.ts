import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMaAlert, cooldownElapsed } from "../src/alerts/maEvaluator";
import type { MaAlertSpec } from "../src/alerts/maEvaluator";

const bar = (high: number, low: number, close: number) => ({ high, low, close });
const spec = (over: Partial<MaAlertSpec>): MaAlertSpec =>
  ({ mode: "touch", nearMinPct: 0.2, nearMaxPct: 0.5, ...over });

test("touch fires when the bar range straddles the MA", () => {
  const r = evaluateMaAlert(spec({ mode: "touch" }), bar(102, 98, 101), 100, null);
  assert.equal(r.triggered, true);
});

test("touch ignores a bar entirely above the MA", () => {
  const r = evaluateMaAlert(spec({ mode: "touch" }), bar(105, 101, 104), 100, null);
  assert.equal(r.triggered, false);
  assert.equal(r.side, "above");
});

test("cross_up needs a previous close below the MA", () => {
  const up = evaluateMaAlert(spec({ mode: "cross_up" }), bar(103, 99, 102), 100, "below");
  assert.equal(up.triggered, true);
  // Same bar, but the alert has never been evaluated: seed state, stay quiet.
  const seed = evaluateMaAlert(spec({ mode: "cross_up" }), bar(103, 99, 102), 100, null);
  assert.equal(seed.triggered, false);
  assert.equal(seed.side, "above");
  // Already above — not a new cross.
  const held = evaluateMaAlert(spec({ mode: "cross_up" }), bar(103, 99, 102), 100, "above");
  assert.equal(held.triggered, false);
});

test("cross_down needs a previous close above the MA", () => {
  assert.equal(evaluateMaAlert(spec({ mode: "cross_down" }), bar(101, 97, 98), 100, "above").triggered, true);
  assert.equal(evaluateMaAlert(spec({ mode: "cross_down" }), bar(101, 97, 98), 100, "below").triggered, false);
});

test("near_above fires only inside the 0.2%..0.5% band", () => {
  const s = spec({ mode: "near_above", nearMinPct: 0.2, nearMaxPct: 0.5 });
  // +0.30% — inside.
  assert.equal(evaluateMaAlert(s, bar(100.4, 100.2, 100.3), 100, null).triggered, true);
  // +0.10% — too close, this is effectively a touch, not an approach.
  assert.equal(evaluateMaAlert(s, bar(100.2, 100.0, 100.1), 100, null).triggered, false);
  // +0.80% — too far away.
  assert.equal(evaluateMaAlert(s, bar(100.9, 100.7, 100.8), 100, null).triggered, false);
  // Band edges are inclusive.
  assert.equal(evaluateMaAlert(s, bar(100.3, 100.1, 100.2), 100, null).triggered, true);
  assert.equal(evaluateMaAlert(s, bar(100.6, 100.4, 100.5), 100, null).triggered, true);
});

test("near_above does not fire below the MA", () => {
  const s = spec({ mode: "near_above" });
  assert.equal(evaluateMaAlert(s, bar(99.8, 99.6, 99.7), 100, null).triggered, false);
});

test("near_below mirrors near_above on the other side", () => {
  const s = spec({ mode: "near_below", nearMinPct: 0.2, nearMaxPct: 0.5 });
  assert.equal(evaluateMaAlert(s, bar(99.8, 99.6, 99.7), 100, null).triggered, true);
  assert.equal(evaluateMaAlert(s, bar(100.4, 100.2, 100.3), 100, null).triggered, false);
});

test("distancePct is signed relative to the MA", () => {
  assert.ok(Math.abs(evaluateMaAlert(spec({}), bar(101, 100, 100.5), 100, null).distancePct - 0.5) < 1e-9);
  assert.ok(Math.abs(evaluateMaAlert(spec({}), bar(100, 99, 99.5), 100, null).distancePct + 0.5) < 1e-9);
});

test("cooldown suppresses repeats inside the window", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  const fired = new Date(now - 30 * 60_000).toISOString();
  assert.equal(cooldownElapsed(fired, 60, now), false);
  assert.equal(cooldownElapsed(fired, 15, now), true);
  // Never fired, or cooldown disabled.
  assert.equal(cooldownElapsed(null, 60, now), true);
  assert.equal(cooldownElapsed(fired, 0, now), true);
});

// ── provisional (intrabar) moving averages ────────────────────────────────
// The runner rolls each MA forward by one forming bar in constant time rather
// than recomputing the whole series on every tick. These assert that shortcut
// lands on exactly the value a full recomputation would.
import { provisionalSma, provisionalEma } from "../src/alerts/maEvaluator";
import { sma as fullSma, ema as fullEma } from "../src/engine/ta";

/** A deterministic price path with enough shape to catch an off-by-one. */
function series(n: number): number[] {
  const out: number[] = [];
  let x = 100;
  for (let i = 0; i < n; i++) { x *= 1 + Math.sin(i * 1.7) * 0.004; out.push(x); }
  return out;
}

test("provisionalSma equals a full SMA over closed bars + the forming bar", () => {
  const closed = series(400);
  for (const len of [15, 21, 50, 100, 200]) {
    const tail = closed.slice(closed.length - (len - 1));
    const tailSum = tail.reduce((a, b) => a + b, 0);
    for (const forming of [closed[closed.length - 1]! * 1.03, 42, 1e5]) {
      const quick = provisionalSma(tailSum, forming, len);
      const full = fullSma([...closed, forming], len).at(-1)!;
      assert.ok(Math.abs(quick - full) / full < 1e-12, `len=${len}: ${quick} vs ${full}`);
    }
  }
});

test("provisionalEma equals a full EMA over closed bars + the forming bar", () => {
  const closed = series(400);
  for (const len of [15, 21, 50, 100, 200]) {
    const prev = fullEma(closed, len).at(-1)!;
    for (const forming of [closed[closed.length - 1]! * 0.97, 42, 1e5]) {
      const quick = provisionalEma(prev, forming, len);
      const full = fullEma([...closed, forming], len).at(-1)!;
      assert.ok(Math.abs(quick - full) / full < 1e-12, `len=${len}: ${quick} vs ${full}`);
    }
  }
});

test("a forming bar that closes unchanged leaves the MA where the tick had it", () => {
  // The intrabar value must be continuous with the bar-close value, or an
  // alert would fire on a tick and then look wrong in the fired-alert feed.
  const closed = series(300);
  const forming = closed.at(-1)! * 1.01;
  const len = 21;
  const tailSum = closed.slice(closed.length - (len - 1)).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(
    provisionalSma(tailSum, forming, len) - fullSma([...closed, forming], len).at(-1)!
  ) < 1e-9);
});
