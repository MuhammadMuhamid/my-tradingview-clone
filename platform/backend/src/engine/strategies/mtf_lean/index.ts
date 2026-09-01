/**
 * mtf_lean — stateful bar loop + module export.
 *
 * Replays the Pine execution order per confirmed bar (line refs against
 * MTF_Confluence_Lean.pine):
 *   CIRCUIT BREAKERS  consecutive-loss pause, exit-to-flat cooldown, one-trade latch
 *   ENTRY             longSignal → strategy.entry (fills at bar close)
 *   EXIT ENGINE       break-even lift, % trailing ratchet, signal exits
 *   BRACKETS          strategy.exit legs re-issued per bar
 *   RESET             flat-state clear
 *
 * Long only: there is no short path anywhere in this module.
 */
import type { Interval } from "../../../types/market";
import { INTERVAL_MS } from "../../../types/market";
import type { StrategyParams } from "../../../types/strategy";
import { Broker, BrokerOptions } from "../../broker";
import { FeedStore } from "../../mtf";
import type { EquityPoint } from "../../../types/backtest";
import { MTF_LEAN_DEFAULTS, MtfLeanParams, requiredFeeds, resolveParams, warmupMs } from "./params";
import { computeSignals, SignalArrays } from "./signals";

export interface RunResult {
  broker: Broker;
  equityCurve: EquityPoint[];
  barsProcessed: number;
}

export interface MtfLeanHistoricalStateTrace {
  position: "flat" | "long";
  entryPrice: number | null;
  entryBar: number | null;
  savedLongStop: number | null;
  savedLongTp: number | null;
  trailAnchor: number | null;
  trailArmed: boolean;
  tp1Done: boolean;
  tp2Done: boolean;
  consecLosses: number;
  choppyUntilBar: number | null;
  lastExitBar: number | null;
  indSigArmed: boolean;
}

export interface MtfLeanHistoricalBarTrace {
  barIndex: number;
  barTime: number;
  stateBefore: MtfLeanHistoricalStateTrace;
  stateAfter: MtfLeanHistoricalStateTrace;
}

const EXIT_REASONS = {
  tp: { RR1: "TP1", RR2: "TP2", RR3: "TP", "RR X": "TP" } as Record<string, string>,
  sl: "SL",
};

export function runBars(
  feeds: FeedStore,
  symbol: string,
  chartTf: Interval,
  p: MtfLeanParams,
  brokerOpts: BrokerOptions,
  range: { startMs: number; endMs: number },
  trace?: (bar: MtfLeanHistoricalBarTrace) => void,
): RunResult {
  const chart = feeds.get(symbol, chartTf);
  const sig: SignalArrays = computeSignals(feeds, symbol, chartTf, p);
  const broker = new Broker(brokerOpts);

  // ── Pine `var` state ──
  let consecLosses = 0;
  let choppyUntilBar = -1;
  let lastExitToFlatBar: number | null = null;
  let indSigArmed = false;
  let posEntry = NaN;
  let posStop = NaN;
  let posR = NaN;
  let posTp1 = NaN;
  let posTp2 = NaN;
  let posTp3 = NaN;
  let entryBar = -1;
  // Partial-TP state. ptpEntryQty is the ORIGINAL filled quantity: the TP tiers
  // are fractions of that, never of what is left. ptpTp1/2Done latch once a tier
  // has been touched so the leg is not re-issued on later bars — without these
  // the position bleeds out in a geometric series of ever-smaller slices
  // (measured: ~15 legs per entry instead of 3) which inflates the leg win rate
  // and misreports the 40/30/30 split.
  let ptpEntryQty = NaN;
  let ptpTp1Done = false;
  let ptpTp2Done = false;
  let trailAnchor = NaN;
  let trailArmed = false;

  let prevClosedCount = 0;
  let prevEndPos = 0;

  const equityCurve: EquityPoint[] = [];
  let equityPeak = brokerOpts.initialCapital;

  const startIdx = chart.time.findIndex((t) => t >= range.startMs);
  if (startIdx < 0) throw new Error("no chart bars in the requested range");
  let barsProcessed = 0;

  const stateTrace = (): MtfLeanHistoricalStateTrace => ({
    position: broker.positionQty > 0 ? "long" : "flat",
    entryPrice: broker.positionQty > 0 ? broker.avgPrice : null,
    entryBar: entryBar >= 0 ? entryBar : null,
    savedLongStop: Number.isNaN(posStop) ? null : posStop,
    savedLongTp: Number.isNaN(posTp3) ? null : posTp3,
    trailAnchor: Number.isNaN(trailAnchor) ? null : trailAnchor,
    trailArmed,
    tp1Done: ptpTp1Done,
    tp2Done: ptpTp2Done,
    consecLosses,
    choppyUntilBar: choppyUntilBar >= 0 ? choppyUntilBar : null,
    lastExitBar: lastExitToFlatBar,
    indSigArmed,
  });

  for (let i = startIdx; i < chart.length; i++) {
    if (chart.time[i]! > range.endMs) break;
    barsProcessed++;
    const stateBefore = trace ? stateTrace() : null;
    const close = chart.close[i]!;
    const high = chart.high[i]!;
    const low = chart.low[i]!;

    // ── Bar open + intrabar: broker fills ──
    broker.processOpen(chart, i);
    broker.processIntrabar(chart, i, EXIT_REASONS);

    const pos = broker.positionQty;

    // ── Consecutive-loss circuit breaker (inspects the LAST closed trade only) ──
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
    }
    const choppyOk = !p.useChoppyFilter || i > choppyUntilBar;

    // ── Exit-to-flat tracking → cooldown ──
    if (pos === 0 && prevEndPos !== 0) lastExitToFlatBar = i;
    const cooldownExitOk =
      p.cooldownBarsAfterExit <= 0 || lastExitToFlatBar === null ||
      i - lastExitToFlatBar > p.cooldownBarsAfterExit;

    // ── One-trade-per-signal latch ──
    if (sig.anyIndBuyTrig[i]) indSigArmed = true;
    const oneTradeGateOk = !p.useOneTradePerSignal || indSigArmed;

    // ── Stop candidate (R:R swing-low engine) ──
    const a = sig.atrRisk[i]!;
    const plannedStop = Math.min(sig.rrSwingLow[i]! - p.rrBufAtr * a, close - p.minSlDistAtr * a);
    const stopUsable = !Number.isNaN(plannedStop) && plannedStop > 0 && plannedStop < close;
    const atrOk = !Number.isNaN(a) && a > 0;

    // ── Entry ──
    const longSignal =
      sig.longSetup[i]! && pos === 0 && stopUsable && atrOk &&
      cooldownExitOk && choppyOk && oneTradeGateOk;

    if (longSignal) {
      posEntry = close;
      posStop = plannedStop;
      posR = posEntry - posStop;
      posTp1 = posEntry * (1 + p.rrTp1Pct / 100);
      posTp2 = posEntry * (1 + p.rrTp2Pct / 100);
      posTp3 = posEntry + posR * p.rrRatio;
      entryBar = i;
      indSigArmed = false;
      broker.queueEntry("entry");
    }

    // ── Unrealized R (avg fill price vs frozen stop) ──
    const longUnrealR =
      pos > 0 && !Number.isNaN(posStop) && broker.avgPrice > posStop
        ? (close - broker.avgPrice) / (broker.avgPrice - posStop)
        : 0;

    // ── Protective stop: frozen entry stop → break-even → % trail. Monotonic. ──
    if (pos === 0) { trailAnchor = NaN; trailArmed = false; }
    let effStop = posStop;
    if (pos > 0 && p.rrUseBE && !Number.isNaN(posR) && posR > 0 && longUnrealR >= p.rrBeAfterR) {
      effStop = Math.max(Number.isNaN(effStop) ? posStop : effStop, posEntry + p.rrBeOffR * posR);
    }
    if (pos > 0 && p.rrUseTrailSl) {
      if (!trailArmed &&
          (p.rrTrailActPct <= 0 ? close > posEntry : high >= posEntry * (1 + p.rrTrailActPct / 100))) {
        trailArmed = true;
      }
      if (trailArmed) {
        const cand = close * (1 - p.rrTrailPct / 100);
        trailAnchor = Number.isNaN(trailAnchor) ? cand : Math.max(trailAnchor, cand);
        effStop = Math.max(Number.isNaN(effStop) ? trailAnchor : effStop, trailAnchor);
      }
    }

    // ── Signal exits ──
    const barsInTrade = pos > 0 && entryBar >= 0 ? i - entryBar : 0;
    const exitG1 = p.exitOnG1Flip && pos > 0 && sig.g1Bear[i]!;
    const exitS4 = p.exitOnS4Flip && pos > 0 && sig.s4Bear[i]!;
    const exitTime = p.maxBarsTrade > 0 && pos > 0 && barsInTrade >= p.maxBarsTrade;
    const exitHl = p.useHlBreakExit && pos > 0 && sig.hlBreak[i]!;
    const closeNow = exitG1 || exitS4 || exitTime || exitHl;

    if (closeNow) {
      const why = exitHl ? "HL break" : exitG1 ? "G1 flip" : exitS4 ? "S4 flip" : "time stop";
      broker.queueClose(why);
    }

    // ── Entry-fill capture: record the ORIGINAL size the bar the position appears ──
    if (pos > 0 && prevEndPos <= 0) {
      ptpEntryQty = pos;
      ptpTp1Done = false;
      ptpTp2Done = false;
    }

    // ── Brackets ──
    if ((pos > 0 || longSignal) && !closeNow && !Number.isNaN(posStop)) {
      if (p.rrUsePartialTp) {
        // Tier sizes are fractions of the ORIGINAL fill, and each tier is marked
        // done by PRICE touching it so the leg is never re-issued (no over-sell).
        if (!ptpTp1Done && pos > 0 && high >= posTp1) ptpTp1Done = true;
        if (!ptpTp2Done && pos > 0 && high >= posTp2) ptpTp2Done = true;
        const base = Number.isNaN(ptpEntryQty) ? pos : ptpEntryQty;
        const q1 = base * (p.rrTp1Size / 100);
        const q2 = base * (p.rrTp2Size / 100);
        if (!ptpTp1Done) broker.setExitLeg("RR1", q1, posTp1, effStop, i);
        if (!ptpTp2Done) broker.setExitLeg("RR2", q2, posTp2, effStop, i);
        broker.setExitLeg("RR3", null, posTp3, effStop, i);
      } else {
        broker.setExitLeg("RR X", null, posTp3, effStop, i);
      }
    }

    // ── Flat-state reset (not on the bar that just signalled an entry) ──
    if (broker.positionQty === 0 && !longSignal) {
      posEntry = NaN; posStop = NaN; posR = NaN;
      posTp1 = NaN; posTp2 = NaN; posTp3 = NaN;
      entryBar = -1;
      ptpEntryQty = NaN; ptpTp1Done = false; ptpTp2Done = false;
    }

    // Snapshot Pine-visible state BEFORE any close-fill, mirroring
    // strategy.position_size[1] under process_orders_on_close.
    prevClosedCount = broker.closed.length;
    prevEndPos = broker.positionQty;

    broker.processClose(chart, i);

    if (trace) {
      trace({
        barIndex: i,
        barTime: chart.time[i]!,
        stateBefore: stateBefore!,
        stateAfter: stateTrace(),
      });
    }

    // ── Equity curve (close-marked; drawdown vs running peak) ──
    const equity = broker.equityAt(close);
    const lowEquity = broker.equityAt(low);
    if (equity > equityPeak) equityPeak = equity;
    equityCurve.push({
      t: chart.time[i]!,
      equity,
      drawdownPct: equityPeak > 0 ? ((equityPeak - Math.min(equity, lowEquity)) / equityPeak) * 100 : 0,
      low: lowEquity,
    });
  }

  let cum = 0;
  for (const trade of broker.closed) {
    cum += trade.pnl ?? 0;
    trade.cumProfit = cum;
  }

  return { broker, equityCurve, barsProcessed };
}

/**
 * BE-19: `mtf_lean` was not registered in `backtester.ts`, so the strategy
 * actually deployed with real money had NO in-platform backtest path — which
 * meant BE-01 and BE-02 could not be checked through the supported route.
 *
 * The blocker was a signature mismatch: `ma_rr_v9.warmupMs` takes a `FeedNeed`
 * and `mtf_lean.warmupMs` took `(params, chartTf)`. The registry needs one
 * shape, and `FeedNeed` is the right one — the backtester asks per feed, and a
 * whole-strategy maximum forces every feed to load the longest warmup.
 *
 * `warmupMsForParams` keeps the old whole-strategy form for the callers that
 * genuinely want it (the live runner's feed sizing).
 */
export const mtfLeanModule = {
  key: "mtf_lean",
  name: "MTF Confluence Lean",
  defaultParams: MTF_LEAN_DEFAULTS as unknown as StrategyParams,
  resolveParams,
  requiredFeeds,
  /** Per-feed warmup, matching the other modules' registry contract. */
  warmupMs: (need: { interval: Interval; warmupBars: number }): number =>
    need.warmupBars * INTERVAL_MS[need.interval],
  /** Whole-strategy warmup — the previous `warmupMs`, under a clearer name. */
  warmupMsForParams: warmupMs,
  runBars,
};

export type MtfLeanModule = typeof mtfLeanModule;
