/**
 * Reading one gate on a timeframe that is not the alert's own.
 *
 * ── The rule this file exists to enforce ───────────────────────────────────
 *
 * A gate on a higher timeframe must not see into a period that has not
 * finished. Evaluating a 15m alert at 10:15 with a 1h gate, the 1h value comes
 * from the bar that closed at 10:00 — never from the 10:00–11:00 bar still
 * forming, which does not exist yet as a fact.
 *
 * That is the `chartClose` convention `engine/mtf.ts` implements for Pine's
 * `request.security(..., lookahead_off)`: the latest bar whose `closeTime` is
 * at or before the chart bar's own close. BE-08 is the record of getting this
 * exactly right once already, and there is no reason for alerts to answer the
 * question differently from the chart.
 *
 * Two consequences worth stating plainly:
 *
 *  - **The value is stale, by design.** A 1h gate on a 15m alert can be
 *    reading data up to an hour old. The alternative is a gate whose answer
 *    changes inside the hour and whose past answers cannot be reproduced.
 *  - **It does not repaint.** Once the 1h bar has closed, every later
 *    evaluation that selects it gets the same number.
 *
 * Pure, so the boundary can be tested without a database or a feed.
 */
import { ema, rsi, sma, supertrend } from "../engine/ta";
import type { AlertFilter } from "./alertConditions";

/** The subset of a candle this needs. */
export interface GateBar {
  high: number;
  low: number;
  close: number;
  closeTime: number;
}

/**
 * The bars of `timeframe` that had CLOSED at or before `closeTime`.
 *
 * Exported separately from the reading because the truncation is the part that
 * carries the look-ahead guarantee, and a test that pins it should not have to
 * reason about an indicator at the same time.
 */
export function barsClosedBy<T extends { closeTime: number }>(
  bars: readonly T[], closeTime: number
): T[] {
  let end = bars.length;
  while (end > 0 && bars[end - 1]!.closeTime > closeTime) end--;
  return bars.slice(0, end);
}

/**
 * One gate's reading from another timeframe's bars, or undefined.
 *
 * Undefined means "not resolved" — no closed bar yet, or not enough history
 * for the indicator to have a value. `filtersPass` fails closed on it, so an
 * unresolved gate silences the alert rather than waving it through.
 */
export function gateReading(
  bars: readonly GateBar[], closeTime: number, filter: AlertFilter
): number | undefined {
  const window = barsClosedBy(bars, closeTime);
  if (window.length === 0) return undefined;
  const last = <T>(a: readonly T[]): T | undefined => a[a.length - 1];
  const closes = window.map((b) => b.close);

  switch (filter.kind) {
    case "rsi":
      return finite(last(rsi(closes, filter.length)));
    case "ma":
      return finite(last(
        filter.type === "ema" ? ema(closes, filter.length) : sma(closes, filter.length)
      ));
    case "supertrend":
      return finite(last(supertrend(
        window.map((b) => b.high), window.map((b) => b.low), closes,
        filter.period, filter.multiplier, filter.atrMethod === "rma"
      ).trend));
  }
}

/** A NaN from a warming-up indicator is "not resolved", not a value. */
const finite = (v: number | undefined): number | undefined =>
  v !== undefined && Number.isFinite(v) ? v : undefined;
