import type { Interval } from "../types/market";
import type { RuntimeState } from "../types/deployments";
import { FeedStore } from "./mtf";
import { computeSignals } from "./strategies/srtrend_v10/signals";
import type { SrTrendParams } from "./strategies/srtrend_v10/params";
import type { LiveDecision } from "./liveEvaluator";

export function evaluateSrTrendBar(feeds: FeedStore, symbol: string, chartTf: Interval,
  p: SrTrendParams, state: RuntimeState, barTime: number): { next: RuntimeState; decision: LiveDecision | null } {
  const chart = feeds.get(symbol, chartTf), i = chart.time.indexOf(barTime);
  if (i < 0) throw new Error(`bar ${barTime} missing from ${symbol} ${chartTf}`);
  const sig = computeSignals(feeds, symbol, chartTf, p), next = { ...state };
  const c = chart.close[i]!, h = chart.high[i]!, l = chart.low[i]!, a = sig.atr[i]!;
  const barMs = chart.closeTime[i]! - chart.time[i]! + 1;
  const choppyOk = !p.useChoppyFilter || next.choppyUntilBarTime === null || barTime > next.choppyUntilBarTime;
  const cooldownOk = p.cooldownBarsAfterExit <= 0 || next.lastExitBarTime === null ||
    (barTime - next.lastExitBarTime) / barMs > p.cooldownBarsAfterExit;
  if (next.position === "flat") {
    if (next.manualCloseReentryLock && sig.freshPrimaryBuy[i]!) next.manualCloseReentryLock = false;
    if (next.manualCloseReentryLock) return { next, decision: null };
    if (!sig.longSetup[i]! || !choppyOk || !cooldownOk) return { next, decision: null };
    const lvl = sig.supportLevel[i]!, swingStop = sig.swingLow[i]! - p.rrBufAtr * a;
    const structStop = Number.isNaN(lvl) ? swingStop : lvl - p.srStructBuffAtr * a;
    let stop = Math.min(swingStop, structStop, sig.swingLow[i]!);
    stop = Math.min(stop, c - p.minSlDistAtr * a);
    const target = c + (c - stop) * p.rrRatio;
    next.position = "long"; next.entryPrice = c; next.entryBarTime = barTime;
    next.savedLongStop = stop; next.savedLongTp = target; next.trailAnchor = null; next.trailArmed = false;
    next.manualCloseReentryLock = false;
    return { next, decision: { action: "buy", reason: "SR support retest", price: c, barTime, barIndex: i } };
  }
  const entry = next.entryPrice ?? c, stop0 = next.savedLongStop ?? -Infinity;
  const risk = entry - stop0, unrealR = risk > 0 ? (c - entry) / risk : 0;
  if (p.useTrail && risk > 0 && h >= entry + risk * p.trailTriggerR) next.trailArmed = true;
  if (next.trailArmed) {
    const candidate = c - p.trailAtrMult * a;
    next.trailAnchor = next.trailAnchor === null ? candidate : Math.max(next.trailAnchor, candidate);
  }
  let stop = stop0;
  if (p.useBreakEven && risk > 0 && h >= entry + risk * p.breakEvenTriggerR) stop = Math.max(stop, entry);
  if (next.trailAnchor !== null) stop = Math.max(stop, next.trailAnchor);
  const soft = (p.minRForSoftExit <= 0 || unrealR >= p.minRForSoftExit) &&
    (sig.exitMa[i]! || sig.belowSt[i]! || sig.belowMa1[i]! || sig.belowLinReg[i]!);
  const structural = (p.hlBreakMinR <= 0 || unrealR >= p.hlBreakMinR) && sig.hlBreak[i]!;
  const stopHit = l <= stop, tpHit = next.savedLongTp !== null && h >= next.savedLongTp;
  let reason: string | null = structural ? "HL Break" :
    soft ? "Signal exit" : stopHit ? (next.trailAnchor !== null && stop === next.trailAnchor ? "Trail" : "SL") : tpHit ? "TP" : null;
  if (!reason) return { next, decision: null };
  const win = (tpHit ? next.savedLongTp! : stopHit ? stop : c) > entry;
  next.consecLosses = win ? 0 : next.consecLosses + 1;
  if (!win && next.consecLosses >= p.maxConsecLoss) { next.choppyUntilBarTime = barTime + p.choppyPauseBars * barMs; next.consecLosses = 0; }
  next.position = "flat"; next.entryPrice = null; next.entryBarTime = null; next.savedLongStop = null;
  next.savedLongTp = null; next.trailAnchor = null; next.trailArmed = false; next.lastExitBarTime = barTime;
  return { next, decision: { action: "sell", reason, price: c, barTime, barIndex: i } };
}
