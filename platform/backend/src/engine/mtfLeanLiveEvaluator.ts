import type { Interval } from "../types/market";
import type { RuntimeState } from "../types/deployments";
import { FeedStore } from "./mtf";
import { computeSignals } from "./strategies/mtf_lean/signals";
import type { MtfLeanParams } from "./strategies/mtf_lean/params";
import type { LiveDecision } from "./liveEvaluator";

export interface MtfLeanDecision extends LiveDecision {
  sellPercent?: number;
  exitLeg?: "tp1" | "tp2" | "runner" | "stop" | "signal";
}

export interface MtfLeanStep {
  decision: MtfLeanDecision;
  stateAfter: RuntimeState;
}

const copy = (s: RuntimeState): RuntimeState => ({ ...s });

function resetPosition(s: RuntimeState, barTime: number): void {
  s.position = "flat";
  s.entryPrice = null;
  s.entryBarTime = null;
  s.savedLongStop = null;
  s.savedLongTp = null;
  s.trailAnchor = null;
  s.trailArmed = false;
  s.tp1Done = false;
  s.tp2Done = false;
  s.lastExitBarTime = barTime;
}

/**
 * Confirmed-close MTF Lean evaluator. Partial percentages are percentages of
 * the receiver's CURRENT remaining quantity. This preserves Pine's original
 * 40/30/30 sizing without needing exchange-side original-quantity state.
 */
export function evaluateMtfLeanBar(
  feeds: FeedStore,
  symbol: string,
  chartTf: Interval,
  p: MtfLeanParams,
  state: RuntimeState,
  barTime: number,
): { next: RuntimeState; steps: MtfLeanStep[] } {
  const chart = feeds.get(symbol, chartTf);
  const i = chart.time.indexOf(barTime);
  if (i < 0) throw new Error(`bar ${barTime} not present in ${symbol} ${chartTf} feed`);
  const sig = computeSignals(feeds, symbol, chartTf, p);
  const next = copy(state);
  const steps: MtfLeanStep[] = [];
  const close = chart.close[i]!;
  const open = chart.open[i]!;
  const high = chart.high[i]!;
  const low = chart.low[i]!;
  const atr = sig.atrRisk[i]!;
  const barMs = chart.closeTime[i]! - chart.time[i]! + 1;

  const emit = (decision: MtfLeanDecision): void => {
    steps.push({ decision, stateAfter: copy(next) });
  };

  if (sig.anyIndBuyTrig[i]!) next.indSigArmed = true;
  if (next.position === "flat") {
    if (next.manualCloseReentryLock && sig.freshPrimaryBuy[i]!) next.manualCloseReentryLock = false;
    const choppyOk = !p.useChoppyFilter || next.choppyUntilBarTime === null || barTime > next.choppyUntilBarTime;
    const cooldownOk = p.cooldownBarsAfterExit <= 0 || next.lastExitBarTime === null ||
      (barTime - next.lastExitBarTime) / barMs > p.cooldownBarsAfterExit;
    const oneTradeOk = !p.useOneTradePerSignal || next.indSigArmed;
    const plannedStop = Math.min(sig.rrSwingLow[i]! - p.rrBufAtr * atr, close - p.minSlDistAtr * atr);
    const validRisk = Number.isFinite(atr) && atr > 0 && Number.isFinite(plannedStop) && plannedStop > 0 && plannedStop < close;
    if (!next.manualCloseReentryLock && sig.longSetup[i]! && choppyOk && cooldownOk && oneTradeOk && validRisk) {
      next.position = "long";
      next.entryPrice = close;
      next.entryBarTime = barTime;
      next.savedLongStop = plannedStop;
      next.savedLongTp = close + (close - plannedStop) * p.rrRatio;
      next.trailAnchor = null;
      next.trailArmed = false;
      next.tp1Done = false;
      next.tp2Done = false;
      next.indSigArmed = false;
      next.manualCloseReentryLock = false;
      emit({ action: "buy", reason: "entry", price: close, barTime, barIndex: i });
    }
    return { next, steps };
  }

  const entry = next.entryPrice ?? close;
  const baseStop = next.savedLongStop ?? -Infinity;
  const risk = entry - baseStop;
  const tp1 = entry * (1 + p.rrTp1Pct / 100);
  const tp2 = entry * (1 + p.rrTp2Pct / 100);
  const runner = next.savedLongTp ?? entry + risk * p.rrRatio;
  const unrealR = risk > 0 ? (close - entry) / risk : 0;

  let effStop = baseStop;
  if (p.rrUseBE && risk > 0 && unrealR >= p.rrBeAfterR) {
    effStop = Math.max(effStop, entry + p.rrBeOffR * risk);
  }
  if (p.rrUseTrailSl) {
    if (!next.trailArmed && (p.rrTrailActPct <= 0 ? close > entry : high >= entry * (1 + p.rrTrailActPct / 100))) {
      next.trailArmed = true;
    }
    if (next.trailArmed) {
      const candidate = close * (1 - p.rrTrailPct / 100);
      next.trailAnchor = next.trailAnchor === null ? candidate : Math.max(next.trailAnchor, candidate);
      effStop = Math.max(effStop, next.trailAnchor);
    }
  }

  const finish = (reason: string, leg: "runner" | "stop" | "signal", price: number): void => {
    const win = price > entry;
    if (win) {
      next.consecLosses = 0;
    } else {
      next.runWinStreak = 0;
      next.runStreakPnlPct = 0;
      next.consecLosses += 1;
      if (next.consecLosses >= p.maxConsecLoss) {
        next.choppyUntilBarTime = barTime + p.choppyPauseBars * barMs;
        next.consecLosses = 0;
      }
    }
    resetPosition(next, barTime);
    emit({ action: "sell", reason, price, barTime, barIndex: i, exitLeg: leg });
  };

  const partial = (tier: "tp1" | "tp2", originalPct: number): void => {
    const already = (next.tp1Done ? p.rrTp1Size : 0) + (next.tp2Done ? p.rrTp2Size : 0);
    const currentPct = Math.min(100, originalPct / Math.max(0.000001, 100 - already) * 100);
    if (tier === "tp1") next.tp1Done = true; else next.tp2Done = true;
    emit({ action: "sell", reason: tier.toUpperCase(), price: tier === "tp1" ? tp1 : tp2,
      barTime, barIndex: i, sellPercent: currentPct, exitLeg: tier });
  };

  const stopHit = Number.isFinite(effStop) && low <= effStop;
  const limits = (): boolean => {
    if (p.rrUsePartialTp) {
      if (!next.tp1Done && high >= tp1) partial("tp1", p.rrTp1Size);
      if (!next.tp2Done && high >= tp2) partial("tp2", p.rrTp2Size);
    }
    if (high >= runner) { finish("TP", "runner", runner); return true; }
    return false;
  };

  // Match broker's deterministic OHLC path: green open→low→high; red open→high→low.
  if (close >= open) {
    if (stopHit) { finish(next.trailAnchor !== null && effStop === next.trailAnchor ? "Trail" : "SL", "stop", effStop); return { next, steps }; }
    if (limits()) return { next, steps };
  } else {
    if (limits()) return { next, steps };
    if (stopHit && next.position === "long") { finish(next.trailAnchor !== null && effStop === next.trailAnchor ? "Trail" : "SL", "stop", effStop); return { next, steps }; }
  }

  const barsInTrade = next.entryBarTime === null ? 0 : Math.floor((barTime - next.entryBarTime) / barMs);
  const reason = p.exitOnG1Flip && sig.g1Bear[i]! ? "G1 flip" :
    p.exitOnS4Flip && sig.s4Bear[i]! ? "S4 flip" :
    p.maxBarsTrade > 0 && barsInTrade >= p.maxBarsTrade ? "time stop" :
    p.useHlBreakExit && sig.hlBreak[i]! ? "HL break" : null;
  if (reason) finish(reason, "signal", close);
  return { next, steps };
}
