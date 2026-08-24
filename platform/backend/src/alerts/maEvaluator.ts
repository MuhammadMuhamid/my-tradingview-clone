/**
 * Pure decision logic for one MA alert against one closed bar. Kept free of
 * database and network so the rules can be reasoned about and tested directly.
 *
 * Sides are taken from the CLOSE, not the wick: a bar that pokes through the
 * MA and closes back on the original side has not crossed it. `touch` exists
 * precisely to catch that wick case.
 */
import type { Candle } from "../types/market";
import type { MaAlertMode, MaType } from "../types/maAlerts";
import { describeMode, maLabel } from "../types/maAlerts";

export type Side = "above" | "below";

export interface MaAlertSpec {
  mode: MaAlertMode;
  nearMinPct: number;
  nearMaxPct: number;
}

export interface MaEvaluation {
  /** Which side of the MA this bar closed on — persisted for cross detection. */
  side: Side;
  /** Signed distance of the close from the MA, in percent. */
  distancePct: number;
  triggered: boolean;
}

export function evaluateMaAlert(
  spec: MaAlertSpec,
  candle: Pick<Candle, "high" | "low" | "close">,
  maValue: number,
  prevSide: Side | null
): MaEvaluation {
  const side: Side = candle.close >= maValue ? "above" : "below";
  const distancePct = ((candle.close - maValue) / maValue) * 100;

  let triggered = false;
  switch (spec.mode) {
    case "touch":
      triggered = candle.low <= maValue && maValue <= candle.high;
      break;
    // A cross needs a known previous side. On the very first evaluation after
    // an alert is created there is none, so we only seed the side and stay
    // quiet rather than firing on whatever side the market happens to be.
    case "cross_up":
      triggered = prevSide === "below" && candle.close > maValue;
      break;
    case "cross_down":
      triggered = prevSide === "above" && candle.close < maValue;
      break;
    case "near_above":
      triggered = distancePct >= spec.nearMinPct && distancePct <= spec.nearMaxPct;
      break;
    case "near_below":
      triggered = -distancePct >= spec.nearMinPct && -distancePct <= spec.nearMaxPct;
      break;
  }
  return { side, distancePct, triggered };
}

/** True when the cooldown window since the last fire has elapsed. */
export function cooldownElapsed(
  lastFiredAt: string | null,
  cooldownMin: number,
  now = Date.now()
): boolean {
  if (!lastFiredAt || cooldownMin <= 0) return true;
  return now - Date.parse(lastFiredAt) >= cooldownMin * 60_000;
}

/** Price formatting that keeps sub-cent alt pairs readable. */
export function formatAlertPrice(n: number): string {
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return n.toFixed(d).replace(/\.?0+$/, "");
}

/**
 * The notification text for a fired MA alert. Pure so the wording — and its
 * size against the Web Push payload limit — can be tested without a database.
 */
export function formatMaAlertPush(
  alert: {
    id: string; symbol: string; timeframe: string;
    maType: MaType; maLength: number;
    mode: MaAlertMode; nearMinPct: number; nearMaxPct: number;
  },
  bar: { close: number },
  maValue: number,
  distancePct: number
): { title: string; body: string; tag: string; url: string } {
  const line = maLabel(alert.maType, alert.maLength);
  return {
    title: `${alert.symbol} ${alert.timeframe} \u2014 ${line}`,
    body:
      `Price ${describeMode(alert)} the ${line} ` +
      `(close ${formatAlertPrice(bar.close)}, ${line} ${formatAlertPrice(maValue)}, ` +
      `${distancePct >= 0 ? "+" : ""}${distancePct.toFixed(2)}%)`,
    tag: `ma-${alert.id}`,
    url: `/chart?symbol=${alert.symbol}&interval=${alert.timeframe}`,
  };
}
