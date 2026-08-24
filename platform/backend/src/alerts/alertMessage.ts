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
import { describeCondition, type AlertCondition } from "./alertConditions";
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
  },
  condition: AlertCondition,
  bar: { close: number },
  reference: number,
  distancePct: number,
  intrabar: boolean
): PushMessage {
  const base = buildBase(alert, condition, bar, reference, distancePct);
  // Only when this particular notification came from an unfinished candle. The
  // marker is short because the body competes for a phone's two visible lines.
  return intrabar ? { ...base, body: `${base.body} · bar still forming` } : base;
}

function buildBase(
  alert: {
    id: string; symbol: string; timeframe: string;
    nearMinPct: number; nearMaxPct: number;
  },
  condition: AlertCondition,
  bar: { close: number },
  reference: number,
  distancePct: number
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
  }
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
