import type { BacktestMetrics, EquityPoint, TradeRecord } from "../types/backtest";
import type { ClosedLeg } from "./broker";
import { ACTIVE_CORRECTIONS, type CorrectionSet } from "./corrections";

export function computeMetrics(
  closed: ClosedLeg[],
  equityCurve: EquityPoint[],
  initialCapital: number,
  commissionPaid: number,
  corrections: CorrectionSet = ACTIVE_CORRECTIONS
): BacktestMetrics {
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let pctSum = 0;
  let barsSum = 0;
  for (const t of closed) {
    const pnl = t.pnl ?? 0;
    /*
     * BE-10: a trade closing at EXACTLY zero is neither a win nor a loss, but
     * the test `pnl > 0` counted it as a loss — inflating `losingTrades` and
     * deflating `winRatePct`. Definitional rather than arithmetically wrong,
     * which is why it is behind a flag: turning it on changes published win
     * rates wherever an exact-zero trade exists.
     */
    if (pnl > 0) {
      grossProfit += pnl;
      wins++;
    } else if (corrections.zeroPnlIsScratch && pnl === 0) {
      scratches++;
    } else {
      grossLoss += -pnl;
      losses++;
    }
    /*
     * BE-05: `pnlPct` is raw price change while every neighbouring metric is
     * net of commission, so `avgTradePct` overstates per-trade edge by the
     * round-trip cost — about 0.2 percentage points at 0.1 % per side, which on
     * a strategy averaging +0.3 %/trade is most of the edge.
     *
     * The correction reads the commission the broker already attributed to this
     * leg, so it needs no cost model of its own and cannot disagree with one.
     */
    if (corrections.netAvgTrade) {
      const notional = t.entryPrice * Math.abs(t.qty);
      const netPct = notional > 0 ? ((t.pnl ?? 0) / notional) * 100 : (t.pnlPct ?? 0);
      pctSum += netPct;
    } else {
      pctSum += t.pnlPct ?? 0;
    }
    barsSum += t.exitBar - t.entryBar;
  }
  const netProfit = grossProfit - grossLoss;
  let maxDrawdownPct = 0;
  for (const pt of equityCurve) {
    if (pt.drawdownPct > maxDrawdownPct) maxDrawdownPct = pt.drawdownPct;
  }
  const total = closed.length;
  // With `zeroPnlIsScratch` off, `scratches` stays zero and every figure below
  // is bit-for-bit what it was.
  const decided = total - scratches;
  return {
    netProfit,
    netProfitPct: initialCapital !== 0 ? (netProfit / initialCapital) * 100 : 0,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    totalTrades: total,
    winningTrades: wins,
    losingTrades: losses,
    // The win rate is over DECIDED trades: a scratch is excluded from the
    // denominator as well as the numerator, or excluding it from one only would
    // move the rate for the wrong reason.
    winRatePct: decided > 0 ? (wins / decided) * 100 : 0,
    maxDrawdownPct,
    avgTradePct: total > 0 ? pctSum / total : 0,
    avgBarsInTrade: total > 0 ? barsSum / total : 0,
    commissionPaid,
  };
}

/**
 * Metrics for a sub-window of a single backtest run — used to score in-sample
 * and out-of-sample segments separately without re-running the strategy.
 *
 * Valid ONLY because position sizing is fixed cash (qty_pct_equity = 0): trade
 * outcomes do not depend on account equity, so a later segment is unaffected by
 * how the earlier one performed. Each segment is rebased to `initialCapital`
 * and its drawdown is measured against its OWN running peak, using the stored
 * intrabar-low equity so the figure stays comparable to a full-run drawdown.
 */
export function computeSegmentMetrics(
  closed: ClosedLeg[],
  equityCurve: EquityPoint[],
  initialCapital: number,
  fromMs: number,
  toMs: number,
  opts: {
    corrections?: CorrectionSet;
    /**
     * The `qty_pct_equity` the run used. Required for `assertSegmentValidity`
     * to do anything — a segment split is only meaningful under fixed-cash
     * sizing, and that precondition was documented in a comment and never
     * checked while `qty_pct_equity` remained a searchable live parameter.
     */
    qtyPctEquity?: number;
  } = {}
): BacktestMetrics {
  const corrections = opts.corrections ?? ACTIVE_CORRECTIONS;

  /*
   * BE-06, first half: assert the validity precondition instead of documenting
   * it. Under percent-of-equity sizing a later segment's outcomes DEPEND on how
   * the earlier one performed, so rebasing each segment to `initialCapital`
   * produces a number with no interpretation. Failing loudly is the only honest
   * option — a silently meaningless OOS figure is what selection then optimises
   * against.
   */
  if (corrections.assertSegmentValidity && (opts.qtyPctEquity ?? 0) > 0) {
    throw new Error(
      `computeSegmentMetrics is valid only under fixed-cash sizing, but this run ` +
      `used qty_pct_equity=${opts.qtyPctEquity}. Segment (IS/OOS) metrics from a ` +
      "compounding run are meaningless; re-run with qty_pct_equity pinned to 0."
    );
  }

  /*
   * BE-06, second half: attribute a boundary-straddling trade by its EXIT.
   *
   * Membership was by entry time alone, so a trade opened on the last
   * in-sample bar and closed weeks into the out-of-sample window counted
   * WHOLLY as in-sample — and its out-of-sample price action, which is the
   * thing the split exists to hold back, contributed to the in-sample score.
   * Attributing by exit puts the trade in the window whose data decided it.
   */
  const legs = corrections.assertSegmentValidity
    ? closed.filter((t) => {
        // A leg with no exit time is still open, so it belongs to no closed
        // segment. Falling back to the entry time would put it in the earlier
        // window on the strength of a decision that has not been made yet.
        const exit = t.exitTime;
        return exit !== null && exit !== undefined && exit >= fromMs && exit < toMs;
      })
    : closed.filter((t) => t.entryTime >= fromMs && t.entryTime < toMs);
  const pts = equityCurve.filter((p) => p.t >= fromMs && p.t < toMs);
  const base = pts.length > 0 ? pts[0]!.equity : initialCapital;
  let peak = initialCapital;
  const seg: EquityPoint[] = [];
  for (const p of pts) {
    const equity = initialCapital + (p.equity - base);
    const low = initialCapital + ((p.low ?? p.equity) - base);
    if (equity > peak) peak = equity;
    seg.push({
      t: p.t,
      equity,
      drawdownPct: peak > 0 ? ((peak - Math.min(equity, low)) / peak) * 100 : 0,
    });
  }
  const commission = legs.reduce((s, t) => s + (t.commission ?? 0), 0);
  const out = computeMetrics(legs, seg, initialCapital, commission, corrections);
  // Exit-reason tally, counted per ENTRY (partial TPs close one entry as several
  // legs, so a leg-based rate would misrepresent the trade).
  //
  // An entry counts as "stopped at a loss" only if it was stopped AND THE WHOLE
  // TRADE finished net-negative. Keying off the stopped LEG's P&L instead made
  // the rate overlap the win rate — a trade could bank TP1+TP2, have its runner
  // stopped for a smaller loss, finish up, and still be counted as a losing
  // stop-out. Measured on PUMPUSDT that inflated the figure to 56.1% against a
  // 59.8% win rate (116% combined) when only 40% of trades actually lost.
  // With this definition slLossRatePct can never exceed (100 - winRatePct).
  const byEntry = new Map<number, { stopped: boolean; tp: boolean; pnl: number }>();
  for (const t of legs) {
    const e = byEntry.get(t.entryBar) ?? { stopped: false, tp: false, pnl: 0 };
    const reason = String(t.exitReason ?? "");
    if (reason === "SL") e.stopped = true;
    else if (reason.startsWith("TP")) e.tp = true;
    e.pnl += t.pnl ?? 0;
    byEntry.set(t.entryBar, e);
  }
  let stopped = 0, slLoss = 0, slProfit = 0, tpHit = 0;
  let eWins = 0, eGP = 0, eGL = 0, otherLoss = 0;
  for (const e of byEntry.values()) {
    if (e.stopped) {
      stopped++;
      // Losing stop-out vs a stop that still finished green (partials or the
      // trailing stop rescued it).
      if (e.pnl < 0) slLoss++; else slProfit++;
    }
    if (e.tp) tpHit++;
    if (e.pnl > 0) { eWins++; eGP += e.pnl; } else { eGL += -e.pnl; if (!e.stopped) otherLoss++; }
  }
  // Win rate and profit factor must share the SAME denominator as `trades`,
  // which is ENTRIES. computeMetrics scores legs, so with partial TPs on it
  // reported a leg win rate beside an entry count — measured 10.6 points apart
  // on ZEC. Leg-based values are kept for reference.
  out.legWinRatePct = out.winRatePct;
  out.legProfitFactor = out.profitFactor;
  out.winningTrades = eWins;
  out.losingTrades = byEntry.size - eWins;
  out.winRatePct = byEntry.size > 0 ? (eWins / byEntry.size) * 100 : 0;
  out.profitFactor = eGL > 0 ? eGP / eGL : null;

  const n = byEntry.size;
  out.entries = n;
  out.slEntries = stopped;
  out.slLossEntries = slLoss;
  out.slProfitEntries = slProfit;
  out.tpEntries = tpHit;
  out.slRatePct = n > 0 ? (stopped / n) * 100 : 0;
  out.slLossRatePct = n > 0 ? (slLoss / n) * 100 : 0;
  out.slProfitRatePct = n > 0 ? (slProfit / n) * 100 : 0;
  // Losing entries that never touched the stop -- they exited at the take-profit
  // (or another exit rule) and STILL finished red once costs were taken. On a
  // wide-tick symbol the round trip can exceed a small R:R target: measured on
  // RIFUSDT 5m, 2 ticks is ~0.217% per side, so 5 of 49 losers were TP exits.
  // This is the term that makes the accounting close exactly:
  //   winRatePct + slLossRatePct + otherLossRatePct === 100
  out.otherLossEntries = otherLoss;
  out.otherLossRatePct = n > 0 ? (otherLoss / n) * 100 : 0;
  return out;
}

/** Downsample the equity curve for storage/charting, keeping first/last points. */
export function downsampleEquity(curve: EquityPoint[], maxPoints = 2000): EquityPoint[] {
  if (curve.length <= maxPoints) return curve;
  const step = Math.ceil(curve.length / maxPoints);
  const out: EquityPoint[] = [];
  for (let i = 0; i < curve.length; i += step) out.push(curve[i]!);
  const last = curve[curve.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function toTradeRecords(closed: ClosedLeg[]): TradeRecord[] {
  return closed.map(({ entryBar: _e, exitBar: _x, ...t }) => t);
}
