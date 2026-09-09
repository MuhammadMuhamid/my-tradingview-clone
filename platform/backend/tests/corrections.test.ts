/**
 * Engine corrections, and the historical/corrected fixture pair.
 *
 * The rule these tests enforce is the one that makes the whole scheme safe:
 * **with every flag off, behaviour is bit-for-bit what it was.** Every stored
 * leaderboard number was produced by the baseline engine, and half-corrected
 * results are worse than uncorrected ones because the two cannot be told apart.
 *
 * Each correction is then asserted to change what it claims to change, and
 * nothing else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_CORRECTIONS, activeCorrectionKeys, allCorrections, assertNotBe08Dependent,
  BE08_DEPENDENT, CORRECTION_KEYS, correctionsFingerprint, describeCorrections,
  assertCorrectedEngine, noCorrections, parseCorrections,
} from "../src/engine/corrections";
import { computeMetrics, computeSegmentMetrics } from "../src/engine/metrics";
import type { ClosedLeg } from "../src/engine/broker";
import type { EquityPoint } from "../src/types/backtest";

// ── The baseline invariant ──────────────────────────────────────────────────

test("FC1-B2: missing environment defaults to the complete corrected engine", () => {
  assert.deepEqual(activeCorrectionKeys(ACTIVE_CORRECTIONS), [...CORRECTION_KEYS]);
  assert.match(correctionsFingerprint(ACTIVE_CORRECTIONS), /^engine:v2-corrected:/);
  assert.match(describeCorrections(ACTIVE_CORRECTIONS), /v2 corrected semantics/);
  assert.doesNotThrow(() => assertCorrectedEngine(ACTIVE_CORRECTIONS));
});

test("every declared key is off in the baseline set and on in the full set", () => {
  const none = noCorrections();
  const all = allCorrections();
  for (const key of CORRECTION_KEYS) {
    assert.equal(none[key], false, key);
    assert.equal(all[key], true, key);
  }
  assert.equal(activeCorrectionKeys(all).length, CORRECTION_KEYS.length);
});

// ── Parsing ─────────────────────────────────────────────────────────────────

test("the flag list parses names, `all` and `none`", () => {
  assert.deepEqual(activeCorrectionKeys(parseCorrections("netAvgTrade")), ["netAvgTrade"]);
  assert.deepEqual(
    activeCorrectionKeys(parseCorrections("exchangeFilters, netAvgTrade")),
    ["netAvgTrade", "exchangeFilters"],
    "order follows the canonical key order, not the input order"
  );
  assert.deepEqual(activeCorrectionKeys(parseCorrections("all")), [...CORRECTION_KEYS]);
  assert.deepEqual(activeCorrectionKeys(parseCorrections("none")), []);
  assert.deepEqual(activeCorrectionKeys(parseCorrections("")), [...CORRECTION_KEYS]);
  assert.deepEqual(activeCorrectionKeys(parseCorrections(undefined)), [...CORRECTION_KEYS]);
  assert.deepEqual(activeCorrectionKeys(parseCorrections("legacy-baseline")), []);
});

test("an unrecognised name THROWS rather than being ignored", () => {
  // A typo that silently disabled a correction someone believed was on would
  // reintroduce exactly the ambiguity this module exists to remove.
  assert.throws(() => parseCorrections("netAvgTade"), /unknown engine correction/);
  assert.throws(() => parseCorrections("netAvgTrade,bogus"), /bogus/);
  // Key names are case-SENSITIVE: a mis-cased key is a typo, not a synonym.
  assert.throws(() => parseCorrections("netavgtrade"), /unknown engine correction/);
  // The two sentinels are not, because they are words rather than identifiers.
  assert.deepEqual(activeCorrectionKeys(parseCorrections("ALL")), [...CORRECTION_KEYS]);
  assert.deepEqual(activeCorrectionKeys(parseCorrections("NONE")), []);
});

test("the fingerprint is stable and names what is on", () => {
  assert.equal(correctionsFingerprint(noCorrections()), "engine:legacy-baseline:quarantined");
  assert.equal(
    correctionsFingerprint(parseCorrections("netAvgTrade,zeroPnlIsScratch")),
    "engine:v2-corrected:netAvgTrade+zeroPnlIsScratch"
  );
  // Same set, different input order — same fingerprint, so a stored result can
  // be compared by string.
  assert.equal(
    correctionsFingerprint(parseCorrections("zeroPnlIsScratch,netAvgTrade")),
    correctionsFingerprint(parseCorrections("netAvgTrade,zeroPnlIsScratch"))
  );
});

test("legacy and partial variants are quarantined from new production work", () => {
  assert.throws(() => assertCorrectedEngine(noCorrections()), /quarantined/);
  assert.throws(() => assertCorrectedEngine(parseCorrections("netAvgTrade")), /missing corrections/);
});

test("no currently-implemented correction depends on resolving BE-08", () => {
  // The list exists so a future correction that IS dependent cannot be added
  // without declaring it, and the guard refuses to run one that is.
  assert.deepEqual([...BE08_DEPENDENT], []);
  assert.doesNotThrow(() => assertNotBe08Dependent(allCorrections()));
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const BAR = 900_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % BAR);

function leg(over: Partial<ClosedLeg>): ClosedLeg {
  return {
    direction: "long",
    entryTime: T0,
    entryPrice: 100,
    exitTime: T0 + BAR,
    exitPrice: 101,
    qty: 10,
    pnl: 10,
    pnlPct: 1,
    exitReason: "TP",
    runUpPct: 1,
    drawdownPct: 0,
    cumProfit: null,
    entryBar: 0,
    exitBar: 1,
    commission: 0,
    ...over,
  } as ClosedLeg;
}

const equity: EquityPoint[] = [
  { t: T0, equity: 10_000, drawdownPct: 0 },
  { t: T0 + BAR, equity: 10_010, drawdownPct: 0 },
];

// ── BE-05: avgTradePct net of commission ────────────────────────────────────

test("BE-05 baseline: avgTradePct is the GROSS price change", () => {
  // Entry 100, exit 101 on 10 units: +1 % gross, +10 quote gross. Commission
  // of 2 makes the net +8 on a 1000 notional, i.e. +0.8 %.
  const legs = [leg({ pnl: 8, pnlPct: 1, commission: 2 })];
  const m = computeMetrics(legs, equity, 10_000, 2, noCorrections());
  assert.equal(m.avgTradePct, 1, "gross — the defect");
});

test("BE-05 corrected: avgTradePct is derived from net P&L", () => {
  const legs = [leg({ pnl: 8, pnlPct: 1, commission: 2 })];
  const m = computeMetrics(legs, equity, 10_000, 2, parseCorrections("netAvgTrade"));
  // 8 / (100 * 10) * 100 = 0.8 %
  assert.ok(Math.abs(m.avgTradePct - 0.8) < 1e-9, String(m.avgTradePct));
});

test("BE-05: the correction changes ONLY avgTradePct", () => {
  const legs = [leg({ pnl: 8, pnlPct: 1, commission: 2 }), leg({ pnl: -5, pnlPct: -0.5, commission: 2 })];
  const base = computeMetrics(legs, equity, 10_000, 4, noCorrections());
  const fixed = computeMetrics(legs, equity, 10_000, 4, parseCorrections("netAvgTrade"));
  assert.notEqual(base.avgTradePct, fixed.avgTradePct);
  for (const key of [
    "netProfit", "netProfitPct", "grossProfit", "grossLoss", "profitFactor",
    "totalTrades", "winningTrades", "losingTrades", "winRatePct",
    "maxDrawdownPct", "avgBarsInTrade", "commissionPaid",
  ] as const) {
    assert.deepEqual(base[key], fixed[key], key);
  }
});

// ── BE-10: a zero-P&L trade is a scratch, not a loss ───────────────────────

test("BE-10 baseline: an exact-zero trade counts as a LOSS", () => {
  const legs = [leg({ pnl: 10, pnlPct: 1 }), leg({ pnl: 0, pnlPct: 0 })];
  const m = computeMetrics(legs, equity, 10_000, 0, noCorrections());
  assert.equal(m.losingTrades, 1, "the defect: zero is neither a win nor a loss");
  assert.equal(m.winRatePct, 50);
});

test("BE-10 corrected: a scratch is excluded from BOTH sides of the win rate", () => {
  const legs = [leg({ pnl: 10, pnlPct: 1 }), leg({ pnl: 0, pnlPct: 0 })];
  const m = computeMetrics(legs, equity, 10_000, 0, parseCorrections("zeroPnlIsScratch"));
  assert.equal(m.losingTrades, 0);
  assert.equal(m.winningTrades, 1);
  assert.equal(m.totalTrades, 2, "the trade still happened");
  assert.equal(m.winRatePct, 100, "1 of 1 DECIDED trades");
  // Excluding it from the numerator only would move the rate for the wrong
  // reason, so the denominator excludes it too.
});

test("BE-10: with no exact-zero trade the correction is a no-op", () => {
  const legs = [leg({ pnl: 10 }), leg({ pnl: -4 })];
  const base = computeMetrics(legs, equity, 10_000, 0, noCorrections());
  const fixed = computeMetrics(legs, equity, 10_000, 0, parseCorrections("zeroPnlIsScratch"));
  assert.deepEqual(base, fixed);
});

// ── BE-06: segment validity and boundary attribution ───────────────────────

test("BE-06 baseline: a compounding run still produces IS/OOS numbers", () => {
  const legs = [leg({})];
  // The precondition is that sizing is fixed cash. Baseline does not check it.
  assert.doesNotThrow(() =>
    computeSegmentMetrics(legs, equity, 10_000, T0, T0 + 10 * BAR, {
      corrections: noCorrections(),
      qtyPctEquity: 100,
    })
  );
});

test("BE-06 corrected: a compounding run THROWS instead of producing a meaningless number", () => {
  const legs = [leg({})];
  assert.throws(
    () => computeSegmentMetrics(legs, equity, 10_000, T0, T0 + 10 * BAR, {
      corrections: parseCorrections("assertSegmentValidity"),
      qtyPctEquity: 100,
    }),
    /valid only under fixed-cash sizing/
  );
  // Fixed cash is fine.
  assert.doesNotThrow(() =>
    computeSegmentMetrics(legs, equity, 10_000, T0, T0 + 10 * BAR, {
      corrections: parseCorrections("assertSegmentValidity"),
      qtyPctEquity: 0,
    })
  );
});

test("BE-06 baseline: a boundary-straddling trade counts wholly as IN-SAMPLE", () => {
  const boundary = T0 + 5 * BAR;
  // Opened just before the split, closed well after it.
  const legs = [leg({ entryTime: boundary - BAR, exitTime: boundary + 20 * BAR, pnl: 100 })];
  const inSample = computeSegmentMetrics(legs, equity, 10_000, T0, boundary, {
    corrections: noCorrections(),
  });
  assert.equal(inSample.totalTrades, 1, "the defect: its OOS price action scored in-sample");
});

test("BE-06 corrected: it is attributed by EXIT, to the window whose data decided it", () => {
  const boundary = T0 + 5 * BAR;
  const legs = [leg({ entryTime: boundary - BAR, exitTime: boundary + 20 * BAR, pnl: 100 })];
  const fix = parseCorrections("assertSegmentValidity");
  const inSample = computeSegmentMetrics(legs, equity, 10_000, T0, boundary, {
    corrections: fix, qtyPctEquity: 0,
  });
  const outOfSample = computeSegmentMetrics(legs, equity, 10_000, boundary, boundary + 100 * BAR, {
    corrections: fix, qtyPctEquity: 0,
  });
  assert.equal(inSample.totalTrades, 0);
  assert.equal(outOfSample.totalTrades, 1);
});

test("BE-06 corrected: a still-open leg belongs to no closed segment", () => {
  // Falling back to the entry time would place it in the earlier window on the
  // strength of a decision that has not been made yet.
  const legs = [leg({ entryTime: T0, exitTime: null as unknown as number, pnl: 0 })];
  const fix = parseCorrections("assertSegmentValidity");
  const seg = computeSegmentMetrics(legs, equity, 10_000, T0, T0 + 100 * BAR, {
    corrections: fix, qtyPctEquity: 0,
  });
  assert.equal(seg.totalTrades, 0);
});

test("BE-06: a trade entirely inside one window is attributed the same either way", () => {
  const boundary = T0 + 5 * BAR;
  const legs = [leg({ entryTime: T0 + BAR, exitTime: T0 + 2 * BAR, pnl: 10 })];
  const base = computeSegmentMetrics(legs, equity, 10_000, T0, boundary, {
    corrections: noCorrections(),
  });
  const fixed = computeSegmentMetrics(legs, equity, 10_000, T0, boundary, {
    corrections: parseCorrections("assertSegmentValidity"), qtyPctEquity: 0,
  });
  assert.equal(base.totalTrades, fixed.totalTrades);
  assert.equal(base.netProfit, fixed.netProfit);
});
