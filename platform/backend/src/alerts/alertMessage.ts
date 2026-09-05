/**
 * The notification text for a fired alert.
 *
 * The `ma` kind delegates to `formatMaAlertPush` unchanged, so every alert that
 * existed before frequencies were added produces byte-identical notifications.
 * A user who has learned to read those messages at a glance should not have to
 * relearn them because the system grew two new condition kinds.
 *
 * Pure, so the wording — and its size against the 4 KB Web Push payload limit —
 * is testable without a push service.
 */
import {
  describeCondition, macdLabel, rsiLabel, stLabel, type AlertCondition,
} from "./alertConditions";
import { formatAlertPrice, formatMaAlertPush } from "./maEvaluator";
import { INTRABAR_WARNING, isIntrabar, type AlertFrequency } from "./alertFrequency";
import { maLabel } from "../types/maAlerts";

export interface PushMessage {
  title: string;
  body: string;
  tag: string;
  url: string;
}

/**
 * `intrabar` is a property of the SAMPLE, not of the frequency: a
 * `once_per_minute` alert whose minute happens to elapse exactly on a bar close
 * fired on a closed candle and should not be labelled provisional.
 */
export function formatAlertPush(
  alert: {
    id: string; symbol: string; timeframe: string;
    frequency: AlertFrequency;
    nearMinPct: number; nearMaxPct: number;
    /** The user's own reason for arming this alert, if they gave one. */
    note?: string | null;
  },
  condition: AlertCondition,
  bar: { close: number },
  reference: number,
  distancePct: number,
  intrabar: boolean,
  /** What the runner matched: "S1", "1h support". Names an `any` pivot alert. */
  label?: string
): PushMessage {
  const base = buildBase(alert, condition, bar, reference, distancePct, label);
  // Only when this particular notification came from an unfinished candle. The
  // marker is short because the body competes for a phone's two visible lines.
  const withBar = intrabar ? { ...base, body: `${base.body} · bar still forming` } : base;
  return withNote(withBar, alert.note);
}

/**
 * The user's own note, appended to the body.
 *
 * Appended rather than substituted: the note says WHY the alert was armed ("TP
 * 1 for the March long"), and the generated sentence says what the market
 * actually did. A phone showing only the note would tell you an alert you wrote
 * three weeks ago fired, without saying at what price or on which line.
 *
 * It goes last because a notification body is truncated from the end on both
 * iOS and Android, so the market fact — the part that cannot be reconstructed
 * from memory — survives the truncation.
 */
function withNote(message: PushMessage, note: string | null | undefined): PushMessage {
  const trimmed = note?.trim();
  if (!trimmed) return message;
  return { ...message, body: `${message.body} — ${trimmed}` };
}

function buildBase(
  alert: {
    id: string; symbol: string; timeframe: string;
    nearMinPct: number; nearMaxPct: number;
  },
  condition: AlertCondition,
  bar: { close: number },
  reference: number,
  distancePct: number,
  label?: string
): PushMessage {
  const url = `/chart?symbol=${alert.symbol}&interval=${alert.timeframe}`;
  const tag = `ma-${alert.id}`;

  switch (condition.kind) {
    case "ma":
      // Unchanged wording, produced by the original formatter.
      return formatMaAlertPush(
        {
          id: alert.id, symbol: alert.symbol, timeframe: alert.timeframe,
          maType: condition.maType, maLength: condition.maLength,
          mode: condition.mode,
          nearMinPct: condition.nearMinPct, nearMaxPct: condition.nearMaxPct,
        },
        bar, reference, distancePct
      );

    case "price":
      return {
        title: `${alert.symbol} ${alert.timeframe} — ${formatAlertPrice(condition.targetPrice)}`,
        body: `Price ${describeCondition(condition)} (last ${formatAlertPrice(bar.close)})`,
        tag, url,
      };

    case "ma_vs_ma": {
      const fast = maLabel(condition.maType, condition.maLength);
      const slow = maLabel(condition.ma2Type, condition.ma2Length);
      return {
        title: `${alert.symbol} ${alert.timeframe} — ${fast}/${slow}`,
        body:
          `${describeCondition(condition)} ` +
          `(${fast} ${distancePct >= 0 ? "+" : ""}${distancePct.toFixed(2)}% vs ` +
          `${slow} ${formatAlertPrice(reference)})`,
        tag, url,
      };
    }

    case "sr_zone": {
      // `label` already reads "1h support" — it carries the timeframe, so the
      // body must not prefix it again.
      const what = label ?? (condition.srSide === "resistance" ? "resistance" : "support");
      const side = condition.srSide === "resistance" ? "resistance" : "support";
      return {
        title: `${alert.symbol} ${alert.timeframe} — ${side}`,
        body:
          `Price is ${formatDistance(distancePct)} the ${what} ` +
          `at ${formatAlertPrice(reference)} (last ${formatAlertPrice(bar.close)})`,
        tag, url,
      };
    }

    case "pivot_level": {
      // `label` is the level the runner actually matched, which for an "any"
      // alert is the one price approached — naming it is the whole point.
      const level = label ?? condition.levelName;
      return {
        title: `${alert.symbol} ${alert.timeframe} — pivot ${level}`,
        body:
          `Price is ${formatDistance(distancePct)} ${condition.pivotType} ${level} ` +
          `at ${formatAlertPrice(reference)} ` +
          `(${condition.anchor} pivots, last ${formatAlertPrice(bar.close)})`,
        tag, url,
      };
    }

    /*
     * Oscillator families report the READING, not a price distance. "RSI 52.31
     * vs 50" is the fact a trader checks; a percentage would be read as a move
     * in the market. `distancePct` carries RSI points here (see
     * `evaluateSeriesCross`), so it is not printed with a % sign.
     */
    case "rsi": {
      const what = rsiLabel(condition);
      return {
        title: `${alert.symbol} ${alert.timeframe} — ${what}`,
        body:
          `${describeCondition(condition)} ` +
          `(${what} ${formatIndicator(reference + distancePct)} vs ` +
          `${formatIndicator(reference)})`,
        tag, url,
      };
    }

    case "supertrend": {
      /*
       * Named as a direction change with the line's price, because that is what
       * the indicator asserts. A percentage distance from the line is included
       * for the same reason the level families carry one — it says how far the
       * flip already ran before this notification reached the phone.
       */
      const what = stLabel(condition);
      const direction = condition.mode === "cross_up" ? "flipped up" : "flipped down";
      return {
        title: `${alert.symbol} ${alert.timeframe} — ${what}`,
        body:
          `${what} ${direction} at ${formatAlertPrice(bar.close)} ` +
          `(line ${formatAlertPrice(reference)}, ` +
          `price ${formatDistance(distancePct)})`,
        tag, url,
      };
    }

    case "macd": {
      const what = macdLabel(condition);
      const against = condition.target === "signal" ? "signal" : "zero";
      return {
        title: `${alert.symbol} ${alert.timeframe} — ${what}`,
        body:
          `${describeCondition(condition)} ` +
          `(${what} ${formatIndicator(reference + distancePct)} vs ` +
          `${against} ${formatIndicator(reference)})`,
        tag, url,
      };
    }
  }
}

/**
 * Oscillator readings, not prices.
 *
 * MACD on a low-priced pair lives in the third decimal place while RSI needs
 * two, so this keeps enough significant digits for both rather than rounding a
 * MACD crossover to "0.00 vs 0.00".
 */
function formatIndicator(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 10) return value.toFixed(2);
  if (abs >= 0.1) return value.toFixed(3);
  return value.toFixed(5);
}

/**
 * "0.34% above" / "0.12% below".
 *
 * Absolute value plus a direction word, because a signed percentage in a
 * notification reads as a price change rather than a distance from a level.
 */
function formatDistance(distancePct: number): string {
  const side = distancePct >= 0 ? "above" : "below";
  return `${Math.abs(distancePct).toFixed(2)}% ${side}`;
}

/**
 * The warning an intrabar frequency must be presented with, or null.
 *
 * Returned from one place so the API, the notification and the UI cannot drift
 * into three different descriptions of the same promise.
 */
export function frequencyWarning(frequency: AlertFrequency): string | null {
  return isIntrabar(frequency) ? INTRABAR_WARNING : null;
}
