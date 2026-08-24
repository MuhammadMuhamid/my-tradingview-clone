/**
 * Describing an alert in the UI, whatever it watches.
 *
 * One module because an alert is rendered in four places — the chart's MA
 * panel, the price-alert dialog, the alerts inventory and the fired-alert feed
 * — and four separate descriptions of the same row is how a UI ends up telling
 * a user two different things about one alert.
 */
import {
  isIntrabarFrequency, type AlertFrequency, type MaAlert,
} from "@/lib/api";
import { maColor, maLabel } from "@/lib/movingAverages";
import { fmtPrice } from "@/lib/format";

/**
 * The warning shown beside every intrabar frequency.
 *
 * It must be exactly the sentence the server defines in
 * `backend/src/alerts/alertFrequency.ts`, because it is a statement about what
 * the runner does, not UI copy. `tests/alerts.test.ts` compares the two files
 * and fails if they ever drift. The server also serves it from
 * `/api/ma-alerts/options`; this copy is what renders before that arrives.
 */
export const INTRABAR_WARNING =
  "May trigger before the candle closes. The condition can become false again before bar close.";

export const FREQUENCY_LABELS: Record<AlertFrequency, string> = {
  once_only: "Once only",
  once_per_bar: "Once per bar",
  once_per_bar_close: "Once per bar close",
  once_per_minute: "Once per minute",
};

export const FREQUENCY_HELP: Record<AlertFrequency, string> = {
  once_only: "Triggers the first time the condition is met, then turns itself off permanently.",
  once_per_bar: "Triggers the first moment the condition becomes true inside each candle, at most once per candle.",
  once_per_bar_close: "Evaluates only completed candles. A condition that was true mid-candle but false at the close does not trigger.",
  once_per_minute: "Triggers at most once a minute for as long as the condition stays true.",
};

/** The exact warning for a frequency, or null when it evaluates closed bars. */
export const frequencyWarning = (f: AlertFrequency): string | null =>
  isIntrabarFrequency(f) ? INTRABAR_WARNING : null;

/** The short label in the left column of an alert row. */
export function alertLineLabel(a: MaAlert): string {
  switch (a.conditionKind) {
    case "price":
      return fmtPrice(a.targetPrice);
    case "ma_vs_ma":
      return `${maLabel(a.maType ?? "sma", a.maLength ?? 0)}/${maLabel(a.ma2Type ?? "sma", a.ma2Length ?? 0)}`;
    case "ma":
    default:
      return maLabel(a.maType ?? "sma", a.maLength ?? 0);
  }
}

/** The colour of the swatch beside an alert. */
export function alertColor(a: MaAlert): string {
  // A price alert is not on any line, so it borrows the neutral accent rather
  // than a moving average's hue — colouring it like the 200 SMA would suggest a
  // relationship that does not exist.
  return a.conditionKind === "price" ? "#7d8590" : maColor(a.maLength ?? 0);
}

/** What the alert is waiting for, phrased as the notification phrases it. */
export function describeAlert(a: MaAlert): string {
  switch (a.conditionKind) {
    case "price":
      switch (a.priceDirection) {
        case "cross_up": return `price crosses above ${fmtPrice(a.targetPrice)}`;
        case "cross_down": return `price crosses below ${fmtPrice(a.targetPrice)}`;
        default: return `price reaches ${fmtPrice(a.targetPrice)}`;
      }
    case "ma_vs_ma": {
      const fast = maLabel(a.maType ?? "sma", a.maLength ?? 0);
      const slow = maLabel(a.ma2Type ?? "sma", a.ma2Length ?? 0);
      return `${fast} crosses ${a.mode === "cross_down" ? "below" : "above"} ${slow}`;
    }
    case "ma":
    default:
      switch (a.mode) {
        case "touch": return "price touches";
        case "cross_up": return "price crosses above";
        case "cross_down": return "price crosses below";
        case "near_above": return `price ${a.nearMinPct}–${a.nearMaxPct}% above`;
        case "near_below": return `price ${a.nearMinPct}–${a.nearMaxPct}% below`;
        default: return "condition met";
      }
  }
}

/**
 * Why an alert is not currently watching, or null when it is.
 *
 * A retired `once_only` alert is the case worth being explicit about: it is
 * still `enabled`, so without this it would read as armed while being
 * permanently inert.
 */
export function alertInactiveReason(a: MaAlert): string | null {
  if (a.completedAt !== null) return "Fired once — done";
  if (!a.enabled) return "Paused";
  return null;
}

/** Whether the alert is armed and will be evaluated. */
export const isAlertActive = (a: MaAlert): boolean =>
  a.enabled && a.completedAt === null;
