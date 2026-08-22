import type { BacktestMetrics, EquityPoint, TradeRecord } from "../types/backtest";
import type { ClosedLeg } from "./broker";

export function computeMetrics(
  closed: ClosedLeg[],
  equityCurve: EquityPoint[],
  initialCapital: number,
  commissionPaid: number
): BacktestMetrics {
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let pctSum = 0;
  let barsSum = 0;
  for (const t of closed) {
    const pnl = t.pnl ?? 0;
    if (pnl > 0) { grossProfit += pnl; wins++; } else { grossLoss += -pnl; losses++; }
    pctSum += t.pnlPct ?? 0;
    barsSum += t.exitBar - t.entryBar;
  }
  const netProfit = grossProfit - grossLoss;
  let maxDrawdownPct = 0;
  for (const pt of equityCurve) {
    if (pt.drawdownPct > maxDrawdownPct) maxDrawdownPct = pt.drawdownPct;
  }
  const total = closed.length;
  return {
    netProfit,
    netProfitPct: initialCapital !== 0 ? (netProfit / initialCapital) * 100 : 0,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    totalTrades: total,
    winningTrades: wins,
    losingTrades: losses,
    winRatePct: total > 0 ? (wins / total) * 100 : 0,
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
  toMs: number
): BacktestMetrics {
  const legs = closed.filter((t) => t.entryTime >= fromMs && t.entryTime < toMs);
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
  const out = computeMetrics(legs, seg, initialCapital, commission);
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
