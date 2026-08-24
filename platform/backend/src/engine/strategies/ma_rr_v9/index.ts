/**
 * ma_rr_v9 — stateful bar loop + module export.
 *
 * Replays the Pine execution order per confirmed bar (line refs against
 * ma_riskreward_strategy.pine):
 *   804  choppy-filter closed-trade tracking
 *   822  profit-run-limit tracking
 *   1021 exit-to-flat bar tracking (cooldown)
 *   1038 one-trade-per-signal latch arming
 *   1042 longSignal → strategy.entry (fills next bar open)
 *   1056 unrealized-R gates
 *   1095 composite close (soft exits / HL break / indicator sells)
 *   1123 entry-fill capture (ptpEntryQty/Px, tier + trail flag reset)
 *   1141 R:R exit engine (brackets re-issued per bar; tier-touch flags)
 *   1177 flat-state reset
 */
import type { Interval } from "../../../types/market";
import type { StrategyParams } from "../../../types/strategy";
import { Broker, BrokerOptions } from "../../broker";
import { ACTIVE_CORRECTIONS } from "../../corrections";
import { FeedStore } from "../../mtf";
import type { EquityPoint } from "../../../types/backtest";
import { MA_RR_V9_DEFAULTS, MaRrParams, requiredFeeds, resolveParams, warmupMs } from "./params";
import { computeSignals, SignalArrays } from "./signals";

export interface RunResult {
  broker: Broker;
  equityCurve: EquityPoint[];
  barsProcessed: number;
}

const EXIT_REASONS = {
  tp: { RR1: "TP1", RR2: "TP2", RR3: "TP", "RR X": "TP" } as Record<string, string>,
  sl: "SL",
};

export function runBars(
  feeds: FeedStore,
  symbol: string,
  chartTf: Interval,
  p: MaRrParams,
  brokerOpts: BrokerOptions,
  range: { startMs: number; endMs: number }
): RunResult {
  const chart = feeds.get(symbol, chartTf);
  const sig: SignalArrays = computeSignals(feeds, symbol, chartTf, p);
  const broker = new Broker(brokerOpts);
  const corrections = brokerOpts.corrections ?? ACTIVE_CORRECTIONS;

  // ── Pine `var` state ──
  let consecLosses = 0;
  let choppyUntilBar = -1;
  let runWinStreak = 0;
  let runStreakPnlPct = 0;
  let runPauseUntil = -1;
  let lastExitToFlatBar: number | null = null;
  let indSigArmed = false;
  let savedLongStop = NaN;
  let savedLongTp = NaN;
  let ptpEntryQty = NaN;
  let ptpEntryPx = NaN;
  let ptpTrailArmed = false;
  let ptpTrailAnchor = NaN;
  let ptpTp1Done = false;
  let ptpTp2Done = false;

  let prevClosedCount = 0;
  let prevEndPos = 0;

  const equityCurve: EquityPoint[] = [];
  let equityPeak = brokerOpts.initialCapital;

  const startIdx = chart.time.findIndex((t) => t >= range.startMs);
  if (startIdx < 0) throw new Error("no chart bars in the requested range");
  let barsProcessed = 0;

  for (let i = startIdx; i < chart.length; i++) {
    if (chart.time[i]! > range.endMs) break;
    barsProcessed++;
    const close = chart.close[i]!;
    const high = chart.high[i]!;
    const low = chart.low[i]!;

    // ── Bar open + intrabar: broker fills ──
    broker.processOpen(chart, i);
    broker.processIntrabar(chart, i, EXIT_REASONS);

    // ── Bar close: strategy logic in Pine line order ──
    const pos = broker.positionQty;

    // 804/822: closed-trade streak tracking (inspects the LAST closed trade only,
    // exactly like `strategy.closedtrades.profit(strategy.closedtrades - 1)`).
    if (broker.closed.length > prevClosedCount) {
      const last = broker.closed[broker.closed.length - 1]!;
      const pnl = last.pnl ?? 0;
      if (pnl < 0) {
        consecLosses += 1;
        if (consecLosses >= p.maxConsecLoss) {
          choppyUntilBar = i + p.choppyPauseBars;
          consecLosses = 0;
        }
      } else {
        consecLosses = 0;
      }
      const notional = last.entryPrice * Math.abs(last.qty);
      const pnlPct = notional !== 0 ? (pnl / notional) * 100 : 0;
      if (pnl > 0) {
        runWinStreak += 1;
        runStreakPnlPct += pnlPct;
        if (p.useRunLimit && runWinStreak >= p.runLimTrades && runStreakPnlPct >= p.runLimProfitPct) {
          runPauseUntil = i + p.runLimPauseBars;
          runWinStreak = 0;
          runStreakPnlPct = 0;
        }
      } else {
        runWinStreak = 0;
        runStreakPnlPct = 0;
      }
    }
    const choppyOk = !p.useChoppyFilter || i > choppyUntilBar;
    const runLimitOk = !p.useRunLimit || i > runPauseUntil;

    // 1021: exit-to-flat tracking → cooldown
    if (pos === 0 && prevEndPos !== 0) lastExitToFlatBar = i;
    const cooldownExitOk =
      p.cooldownBarsAfterExit <= 0 || lastExitToFlatBar === null ||
      i - lastExitToFlatBar > p.cooldownBarsAfterExit;

    // 1038: one-trade-per-signal latch arming
    if (sig.anyIndBuyTrig[i]) indSigArmed = true;
    const oneTradeGateOk = !p.useOneTradePerSignal || indSigArmed;

    // 1042: entry signal (confirmed-bar gates are inherently true at bar close)
    const longSignal =
      sig.longSetup[i]! && pos === 0 &&
      cooldownExitOk && choppyOk && oneTradeGateOk && runLimitOk;

    if (longSignal) {
      const a = sig.atrRisk[i]!;
      const rrSl = Math.min(sig.rrSwingLow[i]! - p.rrBufAtr * a, close - p.minSlDistAtr * a);
      indSigArmed = false;
      savedLongStop = rrSl;
      savedLongTp = close + (close - rrSl) * p.rrRatio;
      broker.queueEntry("entry");
    }

    // 1056: unrealized R (avg fill price vs saved stop)
    const longUnrealR =
      pos > 0 && !Number.isNaN(savedLongStop) && broker.avgPrice > savedLongStop
        ? (close - broker.avgPrice) / (broker.avgPrice - savedLongStop)
        : 0;
    const softExitRGateOk = p.minRForSoftExit <= 0 || longUnrealR >= p.minRForSoftExit;
    const hlBreakRGateOk = p.hlBreakMinR <= 0 || longUnrealR >= p.hlBreakMinR;

    // 1083–1095: composite close
    const exitLongSignalNow =
      pos > 0 && softExitRGateOk &&
      (sig.exitMaTrig[i]! || sig.belowSt[i]! || sig.belowMa1[i]! || sig.belowLinReg[i]! || sig.rsiExit[i]!);
    const exitHlBreakNow = pos > 0 && hlBreakRGateOk && sig.hlBreak[i]!;
    const indExitNow = pos > 0 && (sig.rfSell[i]! || sig.atSell[i]! || sig.hacSell[i]! || sig.utSell[i]!);
    const maCloseLongNow = exitLongSignalNow || exitHlBreakNow || indExitNow;

    if (maCloseLongNow) {
      const why =
        exitHlBreakNow ? "HL Break" :
        sig.exitMaTrig[i] ? "MTF MA exit" :
        sig.belowSt[i] ? "Below ST" :
        sig.belowMa1[i] ? "Below TF1 MA" :
        sig.rsiExit[i] ? "RSI rollover" :
        sig.rfSell[i] ? "RF Sell" :
        sig.atSell[i] ? "AlphaTrend Sell" :
        sig.hacSell[i] ? "HACOLT Sell" :
        sig.utSell[i] ? "UT Bot Sell" :
        "Below LinReg";
      broker.queueClose(why);
    }

    // 1123: entry-fill capture
    const justEnteredLong = pos > 0 && prevEndPos <= 0;
    if (justEnteredLong) {
      ptpEntryQty = pos;
      ptpEntryPx = broker.avgPrice;
      ptpTrailArmed = false;
      ptpTrailAnchor = NaN;
      ptpTp1Done = false;
      ptpTp2Done = false;
    }

    /*
     * 1141: R:R exit engine.
     *
     * BE-04: the gate was `pos > 0`, and `pos` is read at line 87 — BEFORE the
     * fill. On the bar that fills the entry, `pos` is therefore still 0, so no
     * bracket is issued; `broker.setExitLeg` records `issuedBar = i` and
     * `processIntrabar` only activates a leg from `i + 1`. The fill bar has no
     * stop and no target.
     *
     * Worse, the tier-touch latches below fire on that bar anyway, permanently
     * cancelling a partial take-profit that was never taken — the comment
     * "including the fill-bar quirk" recorded this as known.
     *
     * `mtf_lean/index.ts` gets it right with `(pos > 0 || longSignal)`. Behind
     * the `entryBarBrackets` flag because turning it on moves every `ma_rr_v9`
     * and `srtrend_v10` leaderboard number.
     */
    const bracketsGate = corrections.entryBarBrackets ? (pos > 0 || longSignal) : pos > 0;
    if (p.useRR && bracketsGate && !Number.isNaN(savedLongStop) && !Number.isNaN(ptpEntryPx) && !maCloseLongNow) {
      const rrTp1P = ptpEntryPx * (1 + p.rrTp1Pct / 100);
      const rrTp2P = ptpEntryPx * (1 + p.rrTp2Pct / 100);
      const rrTp1Q = ptpEntryQty * (p.rrTp1Size / 100);
      const rrTp2Q = ptpEntryQty * (p.rrTp2Size / 100);
      // Tier-touch flags (set by PRICE, not fills — including the fill-bar quirk
      // where a tier touched before its bracket exists is skipped permanently).
      // The latches must not fire while flat: on the fill bar under the
      // corrected gate there IS a bracket, and before it there is no position
      // for a tier to have been taken from.
      const latchable = corrections.entryBarBrackets ? pos > 0 : true;
      if (p.rrUsePartialTp && latchable && !ptpTp1Done && high >= rrTp1P) ptpTp1Done = true;
      if (p.rrUsePartialTp && latchable && !ptpTp2Done && high >= rrTp2P) ptpTp2Done = true;
      // % trailing stop arm + ratchet
      if (p.rrUseTrailSl && !ptpTrailArmed &&
          (p.rrTrailActPct <= 0 ? close > ptpEntryPx : high >= ptpEntryPx * (1 + p.rrTrailActPct / 100))) {
        ptpTrailArmed = true;
      }
      let rrTrailLvl = NaN;
      if (p.rrUseTrailSl && ptpTrailArmed) {
        const cand = close * (1 - p.rrTrailPct / 100);
        ptpTrailAnchor = Number.isNaN(ptpTrailAnchor) ? cand : Math.max(ptpTrailAnchor, cand);
        rrTrailLvl = ptpTrailAnchor;
      }
      let rrStopUse = savedLongStop;
      if (p.rrUseTrailSl && !Number.isNaN(rrTrailLvl)) rrStopUse = Math.max(rrStopUse, rrTrailLvl);
      if (p.rrUsePartialTp) {
        if (!ptpTp1Done) broker.setExitLeg("RR1", rrTp1Q, rrTp1P, rrStopUse, i);
        if (!ptpTp2Done) broker.setExitLeg("RR2", rrTp2Q, rrTp2P, rrStopUse, i);
        broker.setExitLeg("RR3", null, savedLongTp, rrStopUse, i);
      } else {
        broker.setExitLeg("RR X", null, savedLongTp, rrStopUse, i);
      }
    }

    // 1177: flat-state reset (not on the bar that just signalled an entry)
    if (broker.positionQty === 0 && !longSignal) {
      savedLongStop = NaN;
      savedLongTp = NaN;
      ptpEntryQty = NaN;
      ptpEntryPx = NaN;
      ptpTrailArmed = false;
      ptpTrailAnchor = NaN;
      ptpTp1Done = false;
      ptpTp2Done = false;
    }

    // Snapshot Pine-visible state BEFORE any close-fill: on the next bar the
    // code must see this bar's pre-fill position/closed-count, exactly like
    // strategy.position_size[1] with process_orders_on_close.
    prevClosedCount = broker.closed.length;
    prevEndPos = broker.positionQty;

    // TV process_orders_on_close: market orders queued this bar fill at close
    broker.processClose(chart, i);

    // ── Equity curve (close-marked; drawdown vs running peak) ──
    const equity = broker.equityAt(close);
    const lowEquity = broker.equityAt(low);
    if (equity > equityPeak) equityPeak = equity;
    equityCurve.push({
      t: chart.time[i]!,
      equity,
      drawdownPct: equityPeak > 0 ? ((equityPeak - Math.min(equity, lowEquity)) / equityPeak) * 100 : 0,
    });

  }

  // Cumulative profit per closed leg (TV trade-list column)
  let cum = 0;
  for (const trade of broker.closed) {
    cum += trade.pnl ?? 0;
    trade.cumProfit = cum;
  }

  return { broker, equityCurve, barsProcessed };
}

export const maRrV9Module = {
  key: "ma_rr_v9",
  name: "MA + R:R Strategy (SR+Trend v9)",
  defaultParams: MA_RR_V9_DEFAULTS as unknown as StrategyParams,
  resolveParams,
  requiredFeeds,
  warmupMs,
  runBars,
};

export type MaRrV9Module = typeof maRrV9Module;
