/**
 * Broker emulator replicating TradingView's Strategy Tester fill model for the
 * subset this strategy uses (long-only, pyramiding 0, strategy.cash sizing):
 *
 *   - Market orders placed at a bar's close fill at the NEXT bar's open
 *     (calc_on_order_fills=false, process_orders_on_close=false), with
 *     slippage = slippageTicks × tickSize applied against the trader.
 *   - strategy.exit legs are limit+stop (OCO) orders that persist until filled,
 *     replaced (re-issued with the same id), or the position closes.
 *   - Intrabar fill sequence uses TV's documented OHLC heuristic: green bar
 *     (close >= open) assumes open→low→high→close; red bar open→high→low→close.
 *   - Stop fills at stop price − slippage (or open − slippage on a gap);
 *     limit fills at limit price exactly (or at open when it opens beyond).
 *   - Commission (percent) is charged per fill; per-leg trade PnL is net of
 *     the exit commission plus a pro-rata share of the entry commission,
 *     matching how TV reports per-trade profit.
 */
import type { TradeRecord } from "../types/backtest";
import type { Bars } from "./mtf";

export interface BrokerOptions {
  initialCapital: number;
  commissionPct: number; // 0.05 = 0.05% per fill
  slippageTicks: number;
  tickSize: number;
  qtyCash: number; // strategy.cash default_qty_value — quote spent per entry
  /** >0 = TV "% of equity" sizing: quote spent = equity × pct/100 (compounding). */
  qtyPctEquity?: number;
  /** TV "Process orders on bar Close": market orders fill at the signal bar's
   *  close instead of the next bar's open. */
  fillOnBarClose?: boolean;
}

interface ExitLeg {
  id: string;
  /** null = all remaining at fill time (Pine strategy.exit without qty). */
  qty: number | null;
  limit: number;
  stop: number;
  /** bar index the leg was (re)issued on; active from the NEXT bar. */
  issuedBar: number;
}

interface PendingMarket {
  action: "entry" | "close";
  reason: string;
}

export interface ClosedLeg extends TradeRecord {
  exitBar: number;
  entryBar: number;
  /** Total commission attributable to this leg (its exit fee plus its pro-rata
   *  share of the entry fee). Lets a sub-window report its own fee total. */
  commission: number;
}

export class Broker {
  readonly opts: BrokerOptions;
  private slip: number;

  positionQty = 0;
  avgPrice = NaN;
  entryTime = 0;
  entryBar = -1;
  private entryQty = 0;
  private entryCommission = 0;
  private maxHighSinceEntry = NaN;
  private minLowSinceEntry = NaN;

  realizedNet = 0;
  commissionPaid = 0;
  closed: ClosedLeg[] = [];

  private pending: PendingMarket | null = null;
  private legs: ExitLeg[] = [];
  private tradeNo = 0;

  constructor(opts: BrokerOptions) {
    this.opts = opts;
    this.slip = opts.slippageTicks * opts.tickSize;
  }

  get isFlat(): boolean {
    return this.positionQty === 0;
  }

  /**
   * Read-only snapshot of the working exit legs, so callers can report the live
   * stop/target of a still-open position. Purely observational — it does not
   * touch order state or the fill sequence.
   */
  get workingLegs(): ReadonlyArray<{ id: string; limit: number; stop: number }> {
    return this.legs.map((l) => ({ id: l.id, limit: l.limit, stop: l.stop }));
  }

  /** strategy.entry("Long", strategy.long) at bar close. */
  queueEntry(reason: string): void {
    this.pending = { action: "entry", reason };
  }

  /** strategy.close("Long") at bar close. */
  queueClose(reason: string): void {
    this.pending = { action: "close", reason };
  }

  /** strategy.exit(id, ...) — creates or MODIFIES the working leg with this id.
   *  TV rounds order prices to the symbol's mintick; do the same. */
  setExitLeg(id: string, qty: number | null, limit: number, stop: number, bar: number): void {
    const tick = this.opts.tickSize;
    const rLimit = Math.round(limit / tick) * tick;
    const rStop = Math.round(stop / tick) * tick;
    const existing = this.legs.find((l) => l.id === id);
    if (existing) {
      existing.qty = qty;
      existing.limit = rLimit;
      existing.stop = rStop;
    } else {
      this.legs.push({ id, qty, limit: rLimit, stop: rStop, issuedBar: bar });
    }
  }

  /** Process the bar open: pending market orders fill here (open-fill mode). */
  processOpen(bars: Bars, i: number): void {
    if (this.opts.fillOnBarClose) return;
    this.fillPending(bars, i, bars.open[i]!);
  }

  /** TV process_orders_on_close: pending market orders fill at THIS bar's
   *  close. Call at the very end of the bar's strategy logic. */
  processClose(bars: Bars, i: number): void {
    if (!this.opts.fillOnBarClose) return;
    this.fillPending(bars, i, bars.close[i]!);
  }

  private fillPending(bars: Bars, i: number, px: number): void {
    const order = this.pending;
    if (!order) return;
    this.pending = null;
    if (order.action === "entry" && this.positionQty === 0) {
      const fillPx = px + this.slip;
      const pct = this.opts.qtyPctEquity ?? 0;
      const cash = pct > 0
        ? (this.opts.initialCapital + this.realizedNet) * (pct / 100)
        : this.opts.qtyCash;
      const qty = cash / fillPx;
      const commission = fillPx * qty * (this.opts.commissionPct / 100);
      this.positionQty = qty;
      this.avgPrice = fillPx;
      this.entryQty = qty;
      this.entryTime = bars.time[i]!;
      this.entryBar = i;
      this.entryCommission = commission;
      this.commissionPaid += commission;
      this.realizedNet -= commission;
      this.maxHighSinceEntry = bars.high[i]!;
      this.minLowSinceEntry = bars.low[i]!;
    } else if (order.action === "close" && this.positionQty > 0) {
      this.fillExit(this.positionQty, px - this.slip, bars.time[i]!, i, order.reason);
      this.legs = [];
    }
  }

  /**
   * Evaluate working exit legs against this bar's OHLC.
   * Legs become active the bar AFTER they were issued (TV order timing).
   */
  processIntrabar(bars: Bars, i: number, exitReasons: { tp: Record<string, string>; sl: string }): void {
    if (this.positionQty <= 0) return;
    const active = this.legs.filter((l) => l.issuedBar < i);
    if (active.length === 0) {
      this.trackExcursion(bars, i);
      return;
    }
    const open = bars.open[i]!;
    const high = bars.high[i]!;
    const low = bars.low[i]!;
    const close = bars.close[i]!;
    const t = bars.time[i]!;
    const green = close >= open;

    const fillLeg = (leg: ExitLeg, px: number, reason: string): void => {
      if (this.positionQty <= 0) return;
      const qty = Math.min(leg.qty ?? this.positionQty, this.positionQty);
      if (qty <= 0) return;
      this.fillExit(qty, px, t, i, reason);
      this.legs = this.legs.filter((l) => l.id !== leg.id);
    };

    // 1. Gap fills at the open (open beyond the trigger fills at open).
    for (const leg of [...active]) {
      if (this.positionQty <= 0) break;
      if (open <= leg.stop) fillLeg(leg, open - this.slip, exitReasons.sl);
      else if (open >= leg.limit) fillLeg(leg, open, exitReasons.tp[leg.id] ?? "TP");
    }

    // 2. Intrabar path.
    const remaining = (): ExitLeg[] =>
      this.legs.filter((l) => l.issuedBar < i);
    const runStops = (): void => {
      for (const leg of remaining()) {
        if (this.positionQty <= 0) break;
        if (low <= leg.stop) fillLeg(leg, leg.stop - this.slip, exitReasons.sl);
      }
    };
    const runLimits = (): void => {
      // Rising path fills lower limits first.
      const legsAsc = remaining().sort((a, b) => a.limit - b.limit);
      for (const leg of legsAsc) {
        if (this.positionQty <= 0) break;
        if (high >= leg.limit) fillLeg(leg, leg.limit, exitReasons.tp[leg.id] ?? "TP");
      }
    };
    if (green) {
      runStops();   // open → low first
      runLimits();  // then low → high
    } else {
      runLimits();  // open → high first
      runStops();   // then high → low
    }

    if (this.positionQty === 0) this.legs = [];
    this.trackExcursion(bars, i);
  }

  private trackExcursion(bars: Bars, i: number): void {
    if (this.positionQty <= 0) return;
    const h = bars.high[i]!;
    const l = bars.low[i]!;
    if (Number.isNaN(this.maxHighSinceEntry) || h > this.maxHighSinceEntry) this.maxHighSinceEntry = h;
    if (Number.isNaN(this.minLowSinceEntry) || l < this.minLowSinceEntry) this.minLowSinceEntry = l;
  }

  private fillExit(qty: number, px: number, time: number, bar: number, reason: string): void {
    const exitCommission = px * qty * (this.opts.commissionPct / 100);
    const entryCommShare = this.entryQty > 0 ? this.entryCommission * (qty / this.entryQty) : 0;
    const pnl = (px - this.avgPrice) * qty - exitCommission - entryCommShare;
    this.commissionPaid += exitCommission;
    // Entry commission was already booked into realizedNet at entry; add back
    // gross minus exit commission here so realizedNet stays consistent.
    this.realizedNet += (px - this.avgPrice) * qty - exitCommission;
    this.tradeNo += 1;
    const entryPx = this.avgPrice;
    this.closed.push({
      tradeNo: this.tradeNo,
      direction: "long",
      entryTime: this.entryTime,
      entryPrice: entryPx,
      exitTime: time,
      exitPrice: px,
      qty,
      pnl,
      pnlPct: entryPx !== 0 ? ((px - entryPx) / entryPx) * 100 : null,
      exitReason: reason,
      runUpPct: entryPx !== 0 ? ((this.maxHighSinceEntry - entryPx) / entryPx) * 100 : null,
      drawdownPct: entryPx !== 0 ? ((entryPx - this.minLowSinceEntry) / entryPx) * 100 : null,
      cumProfit: null, // filled by the backtester at the end
      entryBar: this.entryBar,
      exitBar: bar,
      commission: exitCommission + entryCommShare,
    });
    this.positionQty -= qty;
    if (this.positionQty < 1e-12) {
      this.positionQty = 0;
      this.avgPrice = NaN;
      this.legs = [];
    }
  }

  /** Mark-to-market equity (TV: initial + net profit + open profit). */
  equityAt(price: number): number {
    const open = this.positionQty > 0 ? this.positionQty * (price - this.avgPrice) : 0;
    return this.opts.initialCapital + this.realizedNet + open;
  }
}
