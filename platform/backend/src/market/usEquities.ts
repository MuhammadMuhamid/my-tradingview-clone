import { INTERVAL_MS, type Candle, type Interval } from "../types/market";
import type {
  EquityAdjustmentMode, EquityCorporateAction, EquitySessionMode, EquitySessionPhase,
  MarketCalendarDay,
} from "./provider";

const ET_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

export function equityCalendarDate(epochMs: number): string {
  const parts = Object.fromEntries(ET_DATE.formatToParts(new Date(epochMs))
    .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function instant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${label} instant: ${JSON.stringify(value)}`);
  return parsed;
}

export function validateMarketCalendar(days: readonly MarketCalendarDay[]): MarketCalendarDay[] {
  const seen = new Set<string>();
  return [...days].sort((a, b) => a.date.localeCompare(b.date)).map((day) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || equityCalendarDate(instant(day.open, "market open")) !== day.date ||
        equityCalendarDate(instant(day.close, "market close")) !== day.date || instant(day.open, "market open") >= instant(day.close, "market close")) {
      throw new Error(`invalid US equity calendar day: ${JSON.stringify(day)}`);
    }
    if (seen.has(day.date)) throw new Error(`duplicate US equity calendar day: ${day.date}`);
    seen.add(day.date);
    return { date: day.date, open: new Date(instant(day.open, "market open")).toISOString(),
      close: new Date(instant(day.close, "market close")).toISOString() };
  });
}

/**
 * Alpaca's calendar gives exact regular-session instants, including DST and
 * early closes. Pre-market is exactly 04:00 ET (5.5h before the 09:30 open)
 * and after-hours ends at 20:00 ET (10.5h after that open). Deriving both from
 * the provider open preserves the day's actual UTC offset without a home-grown
 * timezone table.
 */
export function equitySessionPhase(epochMs: number,
  days: readonly MarketCalendarDay[]): EquitySessionPhase {
  const day = days.find((item) => item.date === equityCalendarDate(epochMs));
  if (!day) return "closed";
  const open = instant(day.open, "market open");
  const close = instant(day.close, "market close");
  const preOpen = open - 5.5 * 3_600_000;
  const afterClose = open + 10.5 * 3_600_000;
  if (epochMs >= open && epochMs < close) return "regular";
  if (epochMs >= preOpen && epochMs < open) return "pre";
  if (epochMs >= close && epochMs < afterClose) return "after";
  return "closed";
}

export function phaseIncluded(phase: EquitySessionPhase, mode: EquitySessionMode): boolean {
  if (phase === "closed") return false;
  if (mode === "all") return true;
  if (mode === "regular") return phase === "regular";
  return phase === "pre" || phase === "after";
}

export function filterEquitySessionBars(rows: readonly Candle[], mode: EquitySessionMode,
  days: readonly MarketCalendarDay[]): Candle[] {
  return rows.filter((row) => phaseIncluded(equitySessionPhase(row.openTime, days), mode));
}

/** Closed nights, weekends and holidays never enter the denominator. */
export function expectedEquityBars(days: readonly MarketCalendarDay[], interval: Interval,
  startMs: number, endMs: number, mode: EquitySessionMode): number {
  const step = INTERVAL_MS[interval];
  let count = 0;
  for (const day of days) {
    const open = instant(day.open, "market open");
    const close = instant(day.close, "market close");
    const ranges: Array<[number, number]> = mode === "regular" ? [[open, close]]
      : mode === "extended" ? [[open - 5.5 * 3_600_000, open], [close, open + 10.5 * 3_600_000]]
      : [[open - 5.5 * 3_600_000, open + 10.5 * 3_600_000]];
    for (const [rangeStart, rangeEnd] of ranges) {
      const first = Math.max(rangeStart, startMs);
      const lastExclusive = Math.min(rangeEnd, endMs + 1);
      if (lastExclusive <= first) continue;
      count += Math.ceil((lastExclusive - first) / step);
    }
  }
  return count;
}

function actionApplies(mode: EquityAdjustmentMode, action: EquityCorporateAction): boolean {
  return mode === "all" || (mode === "split" && action.type === "split") ||
    (mode === "dividend" && action.type === "dividend");
}

/**
 * Deterministic replay from raw bars. Splits scale historical OHLC inversely
 * and volume directly. Cash dividends use the last raw close before ex-date
 * as the explicit reference, then scale earlier OHLC by (close-cash)/close.
 */
export function replayCorporateActions(rawBars: readonly Candle[], actions: readonly EquityCorporateAction[],
  mode: EquityAdjustmentMode): { bars: Candle[]; actionIds: string[] } {
  let bars = rawBars.map((bar) => ({ ...bar }));
  const used: string[] = [];
  if (mode === "raw") return { bars, actionIds: used };
  for (const action of [...actions].filter((item) => actionApplies(mode, item))
      .sort((a, b) => a.exDate.localeCompare(b.exDate) || a.id.localeCompare(b.id))) {
    if (action.dataQuality !== "complete") continue;
    const prior = bars.filter((bar) => equityCalendarDate(bar.openTime) < action.exDate);
    if (prior.length === 0) continue;
    let priceFactor: number | null = null;
    let volumeFactor = 1;
    if (action.type === "split" && Number.isFinite(action.splitRatio) && action.splitRatio! > 0) {
      priceFactor = 1 / action.splitRatio!;
      volumeFactor = action.splitRatio!;
    } else if (action.type === "dividend" && Number.isFinite(action.cashAmount) && action.cashAmount! >= 0) {
      const reference = prior[prior.length - 1]!.close;
      const factor = (reference - action.cashAmount!) / reference;
      if (Number.isFinite(factor) && factor > 0) priceFactor = factor;
    }
    if (priceFactor === null) continue;
    bars = bars.map((bar) => equityCalendarDate(bar.openTime) < action.exDate ? {
      ...bar, open: bar.open * priceFactor!, high: bar.high * priceFactor!,
      low: bar.low * priceFactor!, close: bar.close * priceFactor!, volume: bar.volume * volumeFactor,
    } : bar);
    used.push(action.id);
  }
  return { bars, actionIds: used };
}

export class EquitySemanticError extends Error {
  readonly status = 422;
}

export function assertEquityPricePurpose(adjustment: EquityAdjustmentMode,
  purpose: "chart" | "study" | "alert" | "execution", session: EquitySessionMode): void {
  if ((purpose === "execution" || purpose === "alert") && adjustment !== "raw") {
    throw new EquitySemanticError(`${purpose} prices must be raw; adjusted bars cannot silently substitute for ${purpose} evaluation`);
  }
  if (purpose === "alert" && session !== "regular") {
    throw new EquitySemanticError("equity alerts are regular-session-only until extended-hours alert evaluation is explicitly supported");
  }
}
