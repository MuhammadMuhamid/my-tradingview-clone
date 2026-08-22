/**
 * Live signal evaluation on CONFIRMED BAR CLOSE — the mode the strategy header
 * explicitly recommends for live trading ("Keep ON for live": useBarConfirm +
 * ordersOnConfirmedBar). Unlike the backtester it does NOT simulate broker
 * fills; it decides buy/sell on each closed bar and lets the bot execute at
 * market. This makes live signals deterministic and non-repainting.
 *
 * Entry: fire BUY when the strategy's long setup + all stateful gates pass and
 *        we are flat. Record stop/target for exit management.
 * Exit (while long), fire SELL when any of these hit on the just-closed bar:
 *   - soft exits: MTF MA cross / below ST / below TF1 MA / below LinReg / RSI
 *     rollover / HL structure break / indicator SELL  (Pine maCloseLongNow)
 *   - protective stop: bar low <= effective stop (swing-low, break-even-less
 *     % trail)  → "SL" / "Trail"
 *   - target:      bar high >= savedLongTp  → "TP"
 * This evaluator remains the MA+R:R path. MTF Lean uses its dedicated live
 * evaluator, including exact TP1/TP2/runner quantity transitions.
 */
import type { Interval } from "../types/market";
import type { RuntimeState } from "../types/deployments";
import { FeedStore } from "./mtf";
import { computeSignals } from "./strategies/ma_rr_v9/signals";
import type { MaRrParams } from "./strategies/ma_rr_v9/params";

export interface LiveDecision {
  action: "buy" | "sell";
  reason: string;
  price: number;   // close of the evaluated bar (trigger_price)
  barTime: number; // open time of the evaluated bar
  barIndex: number;
}

/**
 * Evaluate the single bar at `barTime` (must be a fully closed chart bar).
 * Mutates and returns the next RuntimeState; returns a decision when a
 * buy/sell should fire this bar (at most one, matching the long-only strategy).
 */
export function evaluateBar(
  feeds: FeedStore,
  symbol: string,
  chartTf: Interval,
  p: MaRrParams,
  state: RuntimeState,
  barTime: number
): { next: RuntimeState; decision: LiveDecision | null } {
  const chart = feeds.get(symbol, chartTf);
  const i = chart.time.indexOf(barTime);
  if (i < 0) throw new Error(`bar ${barTime} not present in ${symbol} ${chartTf} feed`);

  const sig = computeSignals(feeds, symbol, chartTf, p);
  const next: RuntimeState = { ...state };
  const close = chart.close[i]!;
  const high = chart.high[i]!;
  const low = chart.low[i]!;
  const a = sig.atrRisk[i]!;

  // ── Streak gates (evaluated from persisted counters; updated on our own exits) ──
  const choppyOk = !p.useChoppyFilter || next.choppyUntilBarTime === null || barTime > next.choppyUntilBarTime;
  const runLimitOk = !p.useRunLimit || next.runPauseUntilBarTime === null || barTime > next.runPauseUntilBarTime;
  const cooldownOk =
    p.cooldownBarsAfterExit <= 0 || next.lastExitBarTime === null ||
    (barTime - next.lastExitBarTime) / (chart.closeTime[i]! - chart.time[i]! + 1) > p.cooldownBarsAfterExit;

  // one-trade-per-signal latch
  if (sig.anyIndBuyTrig[i]) next.indSigArmed = true;
  const oneTradeOk = !p.useOneTradePerSignal || next.indSigArmed;

  let decision: LiveDecision | null = null;

  if (next.position === "flat") {
    if (next.manualCloseReentryLock && sig.freshPrimaryBuy[i]!) {
      next.manualCloseReentryLock = false;
    }
    const freshPrimaryGateOk = !next.manualCloseReentryLock;
    const longSignal = sig.longSetup[i]! && freshPrimaryGateOk && choppyOk && runLimitOk && cooldownOk && oneTradeOk;
    if (longSignal) {
      const rrSl = Math.min(sig.rrSwingLow[i]! - p.rrBufAtr * a, close - p.minSlDistAtr * a);
      next.position = "long";
      next.entryPrice = close;         // live: acted at bar close / market
      next.entryBarTime = barTime;
      next.savedLongStop = rrSl;
      next.savedLongTp = close + (close - rrSl) * p.rrRatio;
      next.trailArmed = false;
      next.trailAnchor = null;
      next.tp1Done = false;
      next.tp2Done = false;
      next.indSigArmed = false;
      next.manualCloseReentryLock = false;
      decision = { action: "buy", reason: "entry", price: close, barTime, barIndex: i };
    }
    return { next, decision };
  }

  // ── Position management (long) ──
  const entryPx = next.entryPrice ?? close;
  const longUnrealR =
    next.savedLongStop !== null && entryPx > next.savedLongStop
      ? (close - entryPx) / (entryPx - next.savedLongStop)
      : 0;
  const softGateOk = p.minRForSoftExit <= 0 || longUnrealR >= p.minRForSoftExit;
  const hlGateOk = p.hlBreakMinR <= 0 || longUnrealR >= p.hlBreakMinR;

  // Soft / structural / indicator exits (bar close)
  const softExit = softGateOk &&
    (sig.exitMaTrig[i]! || sig.belowSt[i]! || sig.belowMa1[i]! || sig.belowLinReg[i]! || sig.rsiExit[i]!);
  const hlExit = hlGateOk && sig.hlBreak[i]!;
  const indExit = sig.rfSell[i]! || sig.atSell[i]! || sig.hacSell[i]!|| sig.utSell[i]!;

  // Update % trailing stop (arms in profit; ratchets up only)
  if (p.useRR && p.rrUseTrailSl) {
    if (!next.trailArmed &&
        (p.rrTrailActPct <= 0 ? close > entryPx : high >= entryPx * (1 + p.rrTrailActPct / 100))) {
      next.trailArmed = true;
    }
    if (next.trailArmed) {
      const cand = close * (1 - p.rrTrailPct / 100);
      next.trailAnchor = next.trailAnchor === null ? cand : Math.max(next.trailAnchor, cand);
    }
  }
  let effStop = next.savedLongStop ?? -Infinity;
  if (p.useRR && p.rrUseTrailSl && next.trailAnchor !== null) effStop = Math.max(effStop, next.trailAnchor);

  const stopHit = p.useRR && next.savedLongStop !== null && low <= effStop;
  const tpHit = p.useRR && next.savedLongTp !== null && high >= next.savedLongTp;

  let exitReason: string | null = null;
  if (softExit) {
    exitReason =
      sig.exitMaTrig[i] ? "MTF MA exit" :
      sig.belowSt[i] ? "Below ST" :
      sig.belowMa1[i] ? "Below TF1 MA" :
      sig.rsiExit[i] ? "RSI rollover" : "Below LinReg";
  } else if (hlExit) exitReason = "HL Break";
  else if (indExit) {
    exitReason = sig.rfSell[i] ? "RF Sell" : sig.atSell[i] ? "AlphaTrend Sell" : sig.hacSell[i] ? "HACOLT Sell" : "UT Bot Sell";
  } else if (stopHit) {
    exitReason = next.trailAnchor !== null && effStop === next.trailAnchor ? "Trail" : "SL";
  } else if (tpHit) exitReason = "TP";

  if (exitReason) {
    // Update streak counters using this trade's outcome (close-based proxy).
    const exitPx = tpHit && !softExit && !hlExit && !indExit && !stopHit ? next.savedLongTp! :
      stopHit && !softExit && !hlExit && !indExit ? effStop : close;
    const win = exitPx > entryPx;
    const pnlPct = entryPx !== 0 ? ((exitPx - entryPx) / entryPx) * 100 : 0;
    const barMs = chart.closeTime[i]! - chart.time[i]! + 1;
    if (win) {
      next.consecLosses = 0;
      next.runWinStreak += 1;
      next.runStreakPnlPct += pnlPct;
      if (p.useRunLimit && next.runWinStreak >= p.runLimTrades && next.runStreakPnlPct >= p.runLimProfitPct) {
        next.runPauseUntilBarTime = barTime + p.runLimPauseBars * barMs;
        next.runWinStreak = 0;
        next.runStreakPnlPct = 0;
      }
    } else {
      next.runWinStreak = 0;
      next.runStreakPnlPct = 0;
      next.consecLosses += 1;
      if (next.consecLosses >= p.maxConsecLoss) {
        next.choppyUntilBarTime = barTime + p.choppyPauseBars * barMs;
        next.consecLosses = 0;
      }
    }
    next.position = "flat";
    next.entryPrice = null;
    next.entryBarTime = null;
    next.savedLongStop = null;
    next.savedLongTp = null;
    next.trailArmed = false;
    next.trailAnchor = null;
    next.tp1Done = false;
    next.tp2Done = false;
    next.lastExitBarTime = barTime;
    decision = { action: "sell", reason: exitReason, price: close, barTime, barIndex: i };
  }

  return { next, decision };
}
