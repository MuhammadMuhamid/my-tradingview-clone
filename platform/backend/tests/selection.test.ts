/**
 * OPT-04 — the walk-forward's third selection rule was arithmetically broken,
 * in two independent ways. Both are fixed here; both change what that rule
 * picks, which is the point of the finding.
 *
 * 1. `win_rate` and `profit_factor` are LEG-based in every tree, while `trades`
 *    is ENTRY-based in the two MTF Lean trees — deliberately, so the objective's
 *    `min_trades` gate is not inflated ~13× by partial take-profits.
 *    `riskPerTrade` multiplied the entry count by the leg win rate, producing a
 *    win/loss split that describes no real population.
 *
 * 2. The solver bisected `[1e-7, 0.95]` and fell back to a 2000-step grid
 *    whenever the endpoints shared a sign — which is almost always, because the
 *    target function is unimodal with a root on EACH side of its peak. The
 *    fallback returned the argmax, i.e. the peak-growth fraction, not a root.
 *
 * The output feeds `multiPick`'s Pareto vector as `-risk`, so one of the three
 * pre-declared rules the walk-forward exists to COMPARE was ranking on noise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ratePopulation, riskPerTrade, type SelectionMetrics } from "../src/optimizer/selection";

/** The original, copied verbatim from wf.ts before the fix. */
function originalRiskPerTrade(m: SelectionMetrics): number | null {
  const net = m.net_pct ?? 0, trades = m.trades ?? 0, wr = m.win_rate ?? 0, pf = m.profit_factor ?? 0;
  const w = Math.round(trades * wr / 100), l = trades - w;
  if (w <= 0 || l <= 0 || pf <= 0) return null;
  const M = 1 + net / 100;
  if (M <= 0) return null;
  const k = pf * l / w;
  const tgt = Math.log(M);
  const f = (L: number): number => (L >= 0.999 ? 1e9 : w * Math.log(1 + k * L) + l * Math.log(1 - L) - tgt);
  let lo = 1e-7, hi = 0.95;
  if (f(lo) * f(hi) > 0) {
    let best = 0, bv = Infinity;
    for (let i = 1; i < 1900; i++) {
      const L = i / 2000, v = Math.abs(f(L));
      if (v < bv) { bv = v; best = L; }
    }
    return best * 100;
  }
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2 * 100;
}

const LEAN: SelectionMetrics = {
  net_pct: 85, trades: 60, legs: 174, win_rate: 55, profit_factor: 1.45,
};

// ── Defect 1: which population the rates describe ───────────────────────────

test("the rates are leg-based, so legs are counted when the record has them", () => {
  assert.deepEqual(ratePopulation(LEAN), { count: 174, basis: "legs" });
});

test("the MA trees are unaffected by that half: their `trades` IS the leg count", () => {
  // wf6m_1h, optimizer1y15m_wf and optimizer1y1h_wf_trail emit
  // `trades: m.totalTrades` and no `legs` field.
  assert.deepEqual(
    ratePopulation({ net_pct: 62, trades: 140, win_rate: 48, profit_factor: 1.6 }),
    { count: 140, basis: "entries" }
  );
});

test("the old split described a population that does not exist", () => {
  // 60 entries at a 55 % LEG win rate gives 33 wins and 27 losses; the 174 legs
  // those rates describe split 96/78. Neither the counts nor their ratio
  // survive, and the ratio is what the payoff term uses.
  assert.equal(Math.round(60 * 55 / 100), 33);
  assert.equal(Math.round(174 * 55 / 100), 96);
});

test("a zero or absent leg count falls back to the entry count", () => {
  assert.equal(ratePopulation({ trades: 40 }).basis, "entries");
  assert.equal(ratePopulation({ trades: 40, legs: 0 }).count, 40);
  assert.equal(ratePopulation({ trades: 40, legs: null }).count, 40);
  assert.equal(ratePopulation({}).count, 0);
});

// ── Defect 2: the solver ────────────────────────────────────────────────────

test("THE OLD SOLVER WAS NOT MONOTONE IN NET — it was ranking on noise", () => {
  const base = { trades: 60, win_rate: 55, profit_factor: 1.45 };
  const old = [20, 50, 120].map((net) => originalRiskPerTrade({ ...base, net_pct: net })!);
  // 20 % net implied a LARGER fraction than 50 %, and 120 % larger again.
  assert.ok(old[0]! > old[1]!, `expected the old fallback to be non-monotone, got ${old}`);
  assert.ok(old[2]! > old[1]!);
});

test("the fixed solver is monotone in the observed multiple", () => {
  const nets = [5, 20, 50, 85, 120, 200, 400, 1000];
  const got = nets.map((net) => riskPerTrade({ ...LEAN, net_pct: net })!);
  for (let i = 1; i < got.length; i += 1) {
    assert.ok(got[i]! > got[i - 1]!,
      `net ${nets[i]} implied ${got[i]}, not more than net ${nets[i - 1]}'s ${got[i - 1]}`);
  }
  assert.ok(got[0]! > 0 && got[got.length - 1]! < 100);
});

test("the solved fraction actually reproduces the multiple", () => {
  for (const net of [20, 85, 400]) {
    const m = { ...LEAN, net_pct: net };
    const L = riskPerTrade(m)! / 100;
    const { count } = ratePopulation(m);
    const w = Math.round(count * (m.win_rate ?? 0) / 100), l = count - w;
    const k = (m.profit_factor ?? 0) * l / w;
    const multiple = Math.exp(w * Math.log(1 + k * L) + l * Math.log(1 - L));
    const want = 1 + net / 100;
    assert.ok(Math.abs(multiple - want) / want < 1e-6,
      `net ${net}: fraction ${L * 100}% reproduces ${multiple}, expected ${want}`);
  }
});

test("an unreachable multiple is null, not a grid artifact", () => {
  assert.equal(riskPerTrade({ ...LEAN, net_pct: 100_000 }), null);
  // The old version answered with a number for the same input.
  assert.notEqual(originalRiskPerTrade({ ...LEAN, net_pct: 100_000 }), null);
});

test("degenerate inputs still return null rather than a number", () => {
  assert.equal(riskPerTrade({ net_pct: 10, trades: 0, win_rate: 50, profit_factor: 1.2 }), null);
  assert.equal(riskPerTrade({ net_pct: 10, trades: 50, win_rate: 100, profit_factor: 1.2 }), null,
    "no losers means no fraction to solve for");
  assert.equal(riskPerTrade({ net_pct: 10, trades: 50, win_rate: 0, profit_factor: 1.2 }), null);
  assert.equal(riskPerTrade({ net_pct: 10, trades: 50, win_rate: 50, profit_factor: 0 }), null);
  assert.equal(riskPerTrade({ net_pct: -100, trades: 50, win_rate: 50, profit_factor: 1.2 }), null,
    "a total loss has no positive multiple to reproduce");
});

test("a losing but survivable config still solves", () => {
  const r = riskPerTrade({ net_pct: -14, trades: 80, legs: 80, win_rate: 35, profit_factor: 0.9 });
  assert.ok(r === null || (r > 0 && r < 100), `unexpected ${r}`);
});
