import type { Interval } from "../../../types/market";
import type { StrategyParams } from "../../../types/strategy";
import type { EquityPoint } from "../../../types/backtest";
import { Broker, type BrokerOptions } from "../../broker";
import { ACTIVE_CORRECTIONS } from "../../corrections";
import { FeedStore } from "../../mtf";
import { SRTREND_V10_DEFAULTS, resolveParams, requiredFeeds, warmupMs, type SrTrendParams } from "./params";
import { computeSignals } from "./signals";

export function runBars(feeds: FeedStore, symbol: string, chartTf: Interval, p: SrTrendParams,
  opts: BrokerOptions, range: { startMs: number; endMs: number }) {
  const chart = feeds.get(symbol, chartTf), sig = computeSignals(feeds, symbol, chartTf, p);
  const broker = new Broker(opts); const equityCurve: EquityPoint[] = [];
  const corrections = opts.corrections ?? ACTIVE_CORRECTIONS;
  let peak = opts.initialCapital, prevPos = 0, prevClosed = 0, consec = 0, choppyUntil = -1, lastExit = -1;
  let stop = NaN, target = NaN, trail = NaN, trailHi = NaN, trailOn = false, breakEven = NaN;
  let savedTrailR = p.trailTriggerR, htfMode = false;
  const start = chart.time.findIndex(t => t >= range.startMs); if (start < 0) throw new Error("no chart bars in range");
  let barsProcessed = 0;
  for (let i = start; i < chart.length && chart.time[i]! <= range.endMs; i++) {
    barsProcessed++; broker.processOpen(chart, i); broker.processIntrabar(chart, i, { tp: { "Long X": "TP" }, sl: "SL" });
    const pos = broker.positionQty, c = chart.close[i]!, h = chart.high[i]!, l = chart.low[i]!, a = sig.atr[i]!;
    if (broker.closed.length > prevClosed) {
      const pnl = broker.closed[broker.closed.length - 1]!.pnl ?? 0;
      if (pnl < 0) { consec++; if (consec >= p.maxConsecLoss) { choppyUntil = i + p.choppyPauseBars; consec = 0; } }
      else consec = 0;
    }
    if (pos === 0 && prevPos !== 0) lastExit = i;
    const cooldown = p.cooldownBarsAfterExit <= 0 || lastExit < 0 || i - lastExit > p.cooldownBarsAfterExit;
    const choppy = !p.useChoppyFilter || i > choppyUntil;
    const longSignal = pos === 0 && sig.longSetup[i]! && cooldown && choppy;
    if (longSignal) {
      const lvl = sig.supportLevel[i]!;
      const swingStop = sig.swingLow[i]! - p.rrBufAtr * a;
      const structStop = Number.isNaN(lvl) ? swingStop : lvl - p.srStructBuffAtr * a;
      const swing = sig.swingLow[i]!;
      stop = Math.min(swingStop, structStop, swing);
      stop = Math.min(stop, c - p.minSlDistAtr * a);
      const risk = c - stop;
      target = c + risk * p.rrRatio;
      savedTrailR = p.trailTriggerR;
      trail = NaN; trailHi = NaN; trailOn = false; breakEven = NaN; htfMode = false;
      broker.queueEntry("entry");
    }
    const risk = pos > 0 ? broker.avgPrice - stop : 0;
    const unrealR = pos > 0 && risk > 0 ? (c - broker.avgPrice) / risk : 0;
    const softGate = p.minRForSoftExit <= 0 || unrealR >= p.minRForSoftExit;
    const hlGate = p.hlBreakMinR <= 0 || unrealR >= p.hlBreakMinR;
    const closeNow = pos > 0 && ((hlGate && sig.hlBreak[i]!) ||
      (softGate && (sig.exitMa[i]! || sig.belowSt[i]! || sig.belowMa1[i]! || sig.belowLinReg[i]!)));
    if (closeNow) broker.queueClose(sig.hlBreak[i] ? "HL Break" : "Signal exit");
    if (pos > 0 && sig.htfBreak[i]!) { if (!htfMode && p.htfResetTrailAnchorOnBreak) { trail = NaN; trailHi = NaN; } htfMode = true; }
    if (p.useBreakEven && pos > 0 && Number.isNaN(breakEven) && risk > 0 && h >= broker.avgPrice + risk * p.breakEvenTriggerR) breakEven = broker.avgPrice;
    /*
     * BE-04: same defect as `ma_rr_v9`. `pos` is read before the fill, so the
     * fill bar issues no bracket and is unprotected. See the note there.
     */
    const bracketsGate = corrections.entryBarBrackets ? (pos > 0 || longSignal) : pos > 0;
    if (bracketsGate && !closeNow && !Number.isNaN(stop) && !Number.isNaN(target)) {
      const effectiveTrigger = htfMode ? p.htfTrailTriggerR : savedTrailR;
      const effectiveMult = htfMode ? p.htfTrailAtrMult : p.trailAtrMult;
      if ((p.useTrail || htfMode) && ((htfMode && p.htfTrailImmediate) || (risk > 0 && h >= broker.avgPrice + risk * effectiveTrigger))) trailOn = true;
      if (trailOn) {
        if (p.trailStyle === "Chandelier (swing ± ATR)") { trailHi = Number.isNaN(trailHi) ? h : Math.max(trailHi, h); trail = trailHi - effectiveMult * a; }
        else trail = Number.isNaN(trail) ? c - effectiveMult * a : Math.max(trail, c - effectiveMult * a);
      }
      let effectiveStop = stop; if (trailOn && !Number.isNaN(trail)) effectiveStop = Math.max(effectiveStop, trail);
      if (p.useBreakEven && !Number.isNaN(breakEven)) effectiveStop = Math.max(effectiveStop, breakEven);
      broker.setExitLeg("Long X", null, htfMode ? NaN : target, effectiveStop, i);
    }
    if (broker.positionQty === 0 && !longSignal) { stop = NaN; target = NaN; trail = NaN; trailHi = NaN; trailOn = false; breakEven = NaN; htfMode = false; }
    prevClosed = broker.closed.length; prevPos = broker.positionQty; broker.processClose(chart, i);
    const equity = broker.equityAt(c), lowEq = broker.equityAt(l); peak = Math.max(peak, equity);
    equityCurve.push({ t: chart.time[i]!, equity, drawdownPct: peak > 0 ? (peak - Math.min(equity, lowEq)) / peak * 100 : 0 });
  }
  let cum = 0; for (const t of broker.closed) { cum += t.pnl ?? 0; t.cumProfit = cum; }
  return { broker, equityCurve, barsProcessed };
}

export const srTrendV10Module = {
  key: "srtrend_v10", name: "SR+Trend Final (v10)",
  defaultParams: SRTREND_V10_DEFAULTS as unknown as StrategyParams,
  resolveParams, requiredFeeds, warmupMs, runBars,
};
