import type { Candle } from "../types/market";
import type { CanonicalInstrument } from "./model";

export type FxPriceBasis = "bid" | "ask" | "mid";

export class TraditionalMarketSemanticError extends Error {
  readonly status = 422;
}

export interface FxQuote {
  bid: number;
  ask: number;
  observedAt: number;
}

export function normalizeFxQuote(quote: FxQuote): FxQuote & { mid: number; spread: number } {
  if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask <= quote.bid) {
    throw new TraditionalMarketSemanticError("FX quote requires positive bid < ask");
  }
  return { ...quote, mid: (quote.bid + quote.ask) / 2, spread: quote.ask - quote.bid };
}

/** A simulated market buy crosses the ask and a sell crosses the bid. */
export function fxSideAwareFill(quote: FxQuote, side: "BUY" | "SELL"): {
  price: number; basis: "ask" | "bid"; spread: number;
} {
  const normalized = normalizeFxQuote(quote);
  return side === "BUY"
    ? { price: normalized.ask, basis: "ask", spread: normalized.spread }
    : { price: normalized.bid, basis: "bid", spread: normalized.spread };
}

const WEEKDAY: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
});

function zonedClock(at: number, timezone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return { day: WEEKDAY[part("weekday")] ?? -1, minutes: Number(part("hour")) * 60 + Number(part("minute")) };
}

/** OANDA's published FX hours: Sun-Fri 17:05-16:59 New York time, with a daily six-minute break. */
export function oandaFxSessionOpen(at: number): boolean {
  const { day, minutes } = zonedClock(at, "America/New_York");
  const open = 17 * 60 + 5;
  const close = 16 * 60 + 59;
  if (day === 0) return minutes >= open;
  if (day >= 1 && day <= 4) return minutes < close || minutes >= open;
  return day === 5 && minutes < close;
}

/** Representative CME Globex trade session: 17:00-16:00 CT with its daily break. */
export function cmeGlobexSessionOpen(at: number): boolean {
  const { day, minutes } = zonedClock(at, "America/Chicago");
  if (day === 0) return minutes >= 17 * 60;
  if (day >= 1 && day <= 4) return minutes < 16 * 60 || minutes >= 17 * 60;
  return day === 5 && minutes < 16 * 60;
}

export function assertTraditionalResearchSemantics(instrument: CanonicalInstrument, input: {
  purpose: "chart" | "backtest" | "execution";
  priceBasis?: string;
  continuousAdjustment?: string;
  rollSchedule?: string;
}): void {
  if (instrument.fx) {
    if (!input.priceBasis) throw new TraditionalMarketSemanticError("FX chart/backtest requests must state bid, ask, or mid price basis");
    if (!instrument.fx.supportedPriceBases.includes(input.priceBasis as FxPriceBasis)) {
      throw new TraditionalMarketSemanticError("FX price basis must be bid, ask, or mid");
    }
    if (input.purpose === "execution" && input.priceBasis === "mid") {
      throw new TraditionalMarketSemanticError("FX execution cannot fill at mid; buys use ask and sells use bid");
    }
  }
  if (instrument.derivative.kind === "continuous_series") {
    if (input.purpose === "execution") throw new TraditionalMarketSemanticError("continuous futures series are research-only and not directly tradable");
    if (input.continuousAdjustment !== instrument.derivative.adjustment ||
      input.rollSchedule !== instrument.derivative.methodologyId) {
      throw new TraditionalMarketSemanticError("continuous futures requests must state the registered roll schedule and adjustment method");
    }
  }
  if (instrument.referenceIndex && input.purpose === "execution") {
    throw new TraditionalMarketSemanticError("cash/reference indices are read-only; select a distinct tradable futures contract");
  }
}

export interface FuturesRoll {
  fromContract: string;
  toContract: string;
  rollAt: number;
}

export type ContinuousAdjustment = "none" | "back_adjusted_difference" | "back_adjusted_ratio";

/** Deterministic research-only splice. Each roll requires both contract closes at rollAt. */
export function buildContinuousSeries(input: {
  contracts: Readonly<Record<string, readonly Candle[]>>;
  rolls: readonly FuturesRoll[];
  adjustment: ContinuousAdjustment;
}): Candle[] {
  if (input.rolls.length === 0) return [];
  const ordered = [...input.rolls].sort((a, b) => a.rollAt - b.rollAt);
  const contractOrder = [ordered[0]!.fromContract, ...ordered.map((roll) => roll.toContract)];
  const byContract = new Map(Object.entries(input.contracts));
  const adjustments = new Map(contractOrder.map((contract) => [contract, { add: 0, multiply: 1 }]));
  if (input.adjustment !== "none") {
    let add = 0; let multiply = 1;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const roll = ordered[index]!;
      const oldBar = byContract.get(roll.fromContract)?.find((bar) => bar.openTime === roll.rollAt);
      const newBar = byContract.get(roll.toContract)?.find((bar) => bar.openTime === roll.rollAt);
      if (!oldBar || !newBar || oldBar.close <= 0 || newBar.close <= 0) {
        throw new TraditionalMarketSemanticError(`roll ${roll.fromContract}->${roll.toContract} lacks both closes at rollAt`);
      }
      if (input.adjustment === "back_adjusted_difference") add += newBar.close - oldBar.close;
      else multiply *= newBar.close / oldBar.close;
      adjustments.set(roll.fromContract, { add, multiply });
    }
  }
  const boundaries = [-Infinity, ...ordered.map((roll) => roll.rollAt), Infinity];
  const rows: Candle[] = [];
  contractOrder.forEach((contract, index) => {
    const start = boundaries[index]!; const end = boundaries[index + 1]!;
    const transform = adjustments.get(contract)!;
    for (const bar of byContract.get(contract) ?? []) {
      if (bar.openTime < start || bar.openTime >= end) continue;
      const price = (value: number) => input.adjustment === "back_adjusted_ratio"
        ? value * transform.multiply : value + transform.add;
      rows.push({ ...bar, symbol: `continuous:${contractOrder[0]}`, open: price(bar.open), high: price(bar.high),
        low: price(bar.low), close: price(bar.close) });
    }
  });
  return rows.sort((a, b) => a.openTime - b.openTime);
}
