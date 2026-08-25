/**
 * Selection helpers shared by the walk-forward trees.
 *
 * `OPT-04`: `win_rate` and `profit_factor` are **leg**-based — they come from
 * `computeMetrics` over `broker.closed`, which is one entry per closed exit leg
 * — while in the MTF Lean trees `trades` is deliberately **entry**-based, set to
 * the number of distinct entry bars so the objective's `min_trades` gate is not
 * inflated ~13× by partial take-profits.
 *
 * `riskPerTrade` then did `w = round(trades * win_rate / 100)`: an ENTRY count
 * multiplied by a LEG win rate. The resulting win/loss decomposition describes
 * no real population, and `k = profit_factor * l / w` compounds the error. Its
 * output feeds `multiPick`'s Pareto vector, so one of the three pre-declared
 * selection rules the walk-forward exists to COMPARE was arithmetically broken,
 * and biased toward partial-TP configurations — the very ones where entries and
 * legs diverge.
 *
 * The fix is to count the population the rates describe: legs where the record
 * has them, entries where entries are all it recorded. The three MA trees emit
 * `trades: m.totalTrades` (already leg-based) and no `legs` field, so their
 * behaviour is unchanged; only the two Lean trees, which emit both, change.
 */

export interface SelectionMetrics {
  net_pct?: number | null;
  /** Entry count in the Lean trees, leg count in the MA trees. */
  trades?: number | null;
  /** Closed exit legs. Present only where `trades` means entries. */
  legs?: number | null;
  /** LEG-based, always. */
  win_rate?: number | null;
  /** LEG-based, always. */
  profit_factor?: number | null;
  [key: string]: number | null | undefined;
}

/**
 * The population `win_rate` and `profit_factor` actually describe.
 *
 * Exported so a caller can assert which one it got rather than guess.
 */
export function ratePopulation(m: SelectionMetrics): { count: number; basis: "legs" | "entries" } {
  const legs = m.legs;
  if (typeof legs === "number" && Number.isFinite(legs) && legs > 0) {
    return { count: legs, basis: "legs" };
  }
  return { count: m.trades ?? 0, basis: "entries" };
}

/**
 * The smallest fixed fraction of equity that reproduces the observed multiple,
 * as a percent, or `null` when no fraction does.
 *
 * Solves `w·ln(1 + kL) + l·ln(1 − L) = ln(M)` for L, where `k = pf·l/w` is the
 * payoff ratio implied by the profit factor.
 *
 * ── The second half of `OPT-04` ───────────────────────────────────────────
 *
 * The original bisected on `[1e-7, 0.95]` after checking `f(lo)·f(hi) > 0`, and
 * fell back to a 2000-step grid returning "the L with the smallest |f|"
 * whenever that product was positive.
 *
 * That branch is taken almost always, and the fallback is not a root. `f` is
 * unimodal: it starts negative at L→0, rises to a peak, and plunges to −∞ as
 * L→1. So there are usually TWO roots and `f(lo)·f(hi)` is positive at both
 * ends — and the grid then returns the argmax of `f`, which is the fraction of
 * PEAK GROWTH, not a fraction reproducing the multiple. Measured on a real Lean
 * record, the result was not even monotone in net: 20 % net gave 33.3, 50 % gave
 * 1.2, 120 % gave 31.5. That number fed `multiPick`'s Pareto vector as `-risk`.
 *
 * This locates the peak, returns `null` when even the peak cannot reach the
 * target — no fixed fraction reproduces that multiple, which is a real and
 * useful answer — and otherwise bisects the LOWER root: the smallest fraction
 * that gets there, which is the conservative reading and the one monotone in
 * the multiple.
 */
export function riskPerTrade(m: SelectionMetrics): number | null {
  const net = m.net_pct ?? 0;
  const { count } = ratePopulation(m);
  const wr = m.win_rate ?? 0, pf = m.profit_factor ?? 0;
  const w = Math.round(count * wr / 100), l = count - w;
  if (w <= 0 || l <= 0 || pf <= 0) return null;
  const M = 1 + net / 100;
  if (M <= 0) return null;
  const k = pf * l / w;
  const tgt = Math.log(M);
  const f = (L: number): number => w * Math.log(1 + k * L) + l * Math.log(1 - L) - tgt;

  // `f` is unimodal on (0, 1): ternary search finds its peak.
  let lo = 1e-9, hi = 0.999999;
  for (let i = 0; i < 200; i += 1) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (f(a) < f(b)) lo = a; else hi = b;
  }
  const peak = (lo + hi) / 2;
  if (f(peak) <= 0) return null;   // unreachable multiple under fixed fractions

  // The lower root, between (0, peak], where f rises from negative to positive.
  let a = 1e-9, b = peak;
  if (f(a) > 0) return a * 100;    // reachable from arbitrarily small fractions
  for (let i = 0; i < 200; i += 1) {
    const mid = (a + b) / 2;
    if (f(mid) > 0) b = mid; else a = mid;
  }
  return ((a + b) / 2) * 100;
}
