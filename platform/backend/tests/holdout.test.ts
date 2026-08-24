/**
 * `OPT-01` — the frozen holdout, and the guard that keeps selection out of it.
 *
 * The finding: the deployed configurations were chosen by MAXIMISING over the
 * out-of-sample window (`min(WR_is, WR_oos)`, with gates on both sides), so OOS
 * was a second selection criterion rather than a validation set. The analysis
 * script that writes the deploy artifact says so in its own metadata, and
 * nothing enforced it.
 *
 * These tests pin the shape of the fix: a third window selection cannot read,
 * a refusal that is an error rather than a warning, and a deploy gate where
 * "never checked" cannot be mistaken for "passed".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertWindowUsage, evaluateClearance, HoldoutLeakError, splitWindows, windowOf,
  type HoldoutClearance,
} from "../src/engine/holdout";

const DAY = 86_400_000;
const START = Date.parse("2025-08-11T00:00:00Z");
const END = Date.parse("2026-08-11T00:00:00Z");
const RANGE = { startMs: START, endMs: END };

// ── The split ───────────────────────────────────────────────────────────────

test("the holdout is taken from the END of the range", () => {
  // Carving it from the middle would leave later data that selection had
  // already seen, which is the defect rather than the fix.
  const split = splitWindows(RANGE);
  assert.equal(split.holdout.endMs, END);
  assert.ok(split.holdout.startMs > split.outOfSample.startMs);
  assert.equal(split.outOfSample.endMs, split.holdout.startMs);
  assert.equal(split.inSample.endMs, split.outOfSample.startMs);
  assert.equal(split.inSample.startMs, START);
});

test("the three windows tile the range with no gap and no overlap", () => {
  const s = splitWindows(RANGE);
  assert.equal(s.inSample.endMs, s.outOfSample.startMs);
  assert.equal(s.outOfSample.endMs, s.holdout.startMs);
  const total =
    (s.inSample.endMs - s.inSample.startMs) +
    (s.outOfSample.endMs - s.outOfSample.startMs) +
    (s.holdout.endMs - s.holdout.startMs);
  assert.equal(total, END - START);
});

test("the holdout fraction is honoured", () => {
  const s = splitWindows(RANGE, { holdoutFraction: 0.25 });
  const holdoutDays = (s.holdout.endMs - s.holdout.startMs) / DAY;
  const totalDays = (END - START) / DAY;
  assert.ok(Math.abs(holdoutDays / totalDays - 0.25) < 0.001, `${holdoutDays}/${totalDays}`);
});

test("an explicit IS/OOS split is respected, and one inside the holdout is refused", () => {
  const s = splitWindows(RANGE, { splitMs: Date.parse("2026-03-11T00:00:00Z") });
  assert.equal(s.inSample.endMs, Date.parse("2026-03-11T00:00:00Z"));
  // The tree's own configured split date must not land in the frozen window.
  assert.throws(
    () => splitWindows(RANGE, { splitMs: END - DAY }),
    /must fall strictly inside/
  );
});

test("a degenerate range or fraction is refused rather than silently producing nothing", () => {
  assert.throws(() => splitWindows({ startMs: END, endMs: START }), /invalid range/);
  assert.throws(() => splitWindows(RANGE, { holdoutFraction: 0 }), /strictly between 0 and 1/);
  assert.throws(() => splitWindows(RANGE, { holdoutFraction: 1 }), /strictly between 0 and 1/);
});

test("windowOf classifies a timestamp, and reports outside the range as null", () => {
  const s = splitWindows(RANGE);
  assert.equal(windowOf(s, START), "inSample");
  assert.equal(windowOf(s, s.outOfSample.startMs), "outOfSample");
  assert.equal(windowOf(s, s.holdout.startMs), "holdout");
  assert.equal(windowOf(s, END - 1), "holdout");
  assert.equal(windowOf(s, START - DAY), null);
  assert.equal(windowOf(s, END), null, "the end is exclusive");
});

// ── The guard ───────────────────────────────────────────────────────────────

test("reading the holdout to SELECT throws", () => {
  assert.throws(
    () => assertWindowUsage("holdout", "select"),
    (err: unknown) => err instanceof HoldoutLeakError
  );
});

test("reading the holdout to REPORT is permitted", () => {
  assert.doesNotThrow(() => assertWindowUsage("holdout", "report"));
});

test("the in-sample and out-of-sample windows may be selected on", () => {
  // OOS being selectable is not an endorsement — it is what the pipeline does
  // today, and the point of the third window is that it does not matter.
  assert.doesNotThrow(() => assertWindowUsage("inSample", "select"));
  assert.doesNotThrow(() => assertWindowUsage("outOfSample", "select"));
});

test("the refusal explains WHY, not just that it refused", () => {
  try {
    assertWindowUsage("holdout", "select");
    assert.fail("should have thrown");
  } catch (err) {
    const message = (err as Error).message;
    assert.match(message, /selection artefact/);
    assert.match(message, /OPT-01/);
  }
});

// ── The deploy gate ─────────────────────────────────────────────────────────

const split = splitWindows(RANGE);
const rules = {
  minTrades: 30,
  minNetPct: 0,
  expected: { startMs: split.holdout.startMs, endMs: split.holdout.endMs },
};

const clearance = (over: Partial<HoldoutClearance> = {}): HoldoutClearance => ({
  configId: "cfg-1",
  scoredAt: Date.now(),
  netPct: 5,
  trades: 50,
  engine: "engine:baseline",
  holdoutStartMs: split.holdout.startMs,
  holdoutEndMs: split.holdout.endMs,
  ...over,
});

test("a config with a passing holdout result is cleared", () => {
  assert.deepEqual(evaluateClearance(clearance(), rules), { cleared: true });
});

test("NO holdout result is a refusal, and says absence is not a pass", () => {
  for (const missing of [null, clearance({ scoredAt: null })]) {
    const verdict = evaluateClearance(missing, rules);
    assert.equal(verdict.cleared, false);
    assert.match(verdict.cleared ? "" : verdict.reason, /Absence of a result is\s+not a pass/);
  }
});

test("a result scored against a DIFFERENT window is refused", () => {
  // A holdout that moves is not a holdout — this is how `range.end: "now"`
  // makes an out-of-sample figure time-dependent (OPT-18).
  const verdict = evaluateClearance(
    clearance({ holdoutStartMs: split.holdout.startMs - 30 * DAY }),
    rules
  );
  assert.equal(verdict.cleared, false);
  assert.match(verdict.cleared ? "" : verdict.reason, /A holdout that moves is not a holdout/);
});

test("too few holdout trades is refused, with the count", () => {
  const verdict = evaluateClearance(clearance({ trades: 4 }), rules);
  assert.equal(verdict.cleared, false);
  assert.match(verdict.cleared ? "" : verdict.reason, /4 trade\(s\), below the minimum 30/);
  // Four is the real number: JUPUSDT had 13, EIGENUSDT 15, PYTHUSDT 4 surviving
  // configs out of ~206,600 candidates.
});

test("a negative holdout net is refused", () => {
  const verdict = evaluateClearance(clearance({ netPct: -12 }), rules);
  assert.equal(verdict.cleared, false);
  assert.match(verdict.cleared ? "" : verdict.reason, /net is -12%, below the minimum 0%/);
});

test("every refusal names what is missing rather than returning a bare false", () => {
  const refusals = [
    evaluateClearance(null, rules),
    evaluateClearance(clearance({ trades: 0 }), rules),
    evaluateClearance(clearance({ netPct: -1 }), rules),
    evaluateClearance(clearance({ holdoutEndMs: END + DAY }), rules),
  ];
  for (const verdict of refusals) {
    assert.equal(verdict.cleared, false);
    assert.ok((verdict.cleared ? "" : verdict.reason).length > 30, "the reason must be actionable");
  }
});
