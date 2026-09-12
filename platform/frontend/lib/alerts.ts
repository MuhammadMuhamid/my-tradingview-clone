/**
 * Describing an alert in the UI, whatever it watches.
 *
 * One module because an alert is rendered in four places — the chart's MA
 * panel, the price-alert dialog, the alerts inventory and the fired-alert feed
 * — and four separate descriptions of the same row is how a UI ends up telling
 * a user two different things about one alert.
 */
import {
  ADX_DEFAULTS, BOLLINGER_DEFAULTS, isIntrabarFrequency, MACD_DEFAULTS,
  STOCHASTIC_DEFAULTS, SUPERTREND_DEFAULTS,
  type AlertFrequency, type MaAlert,
} from "@/lib/api";
import type { AlertFilter } from "@/lib/api";
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
    case "sr_zone":
      // These sit on no moving average, so an "SMA 0" label would be a lie.
      return a.srSide === "resistance" ? "Resistance"
        : a.srSide === "support" ? "Support" : "S/R";
    case "pivot_level":
      return a.pivotLevelName === "any" ? "Pivot" : `Pivot ${a.pivotLevelName}`;
    case "rsi":
      return `RSI ${a.rsiLength ?? ""}`.trim();
    case "macd":
      return macdLabel(a);
    case "supertrend":
      return stLabel(a);
    case "bollinger":
      return bbLabel(a);
    case "stochastic":
      return stochLabel(a);
    case "adx":
      return adxLabel(a);
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
  // Kinds that sit on no moving average borrow their own hue rather than a
  // line's, so the swatch never implies a relationship that does not exist.
  if (a.conditionKind === "price") return "#7d8590";
  if (a.conditionKind === "sr_zone") {
    return a.srSide === "resistance" ? "#f23645" : "#089981";
  }
  if (a.conditionKind === "pivot_level") return "#fb8c00";
  // The two oscillators get the hues their own indicator panes use, so a row
  // in this list matches what the chart draws.
  if (a.conditionKind === "rsi") return "#7e57c2";
  if (a.conditionKind === "macd") return "#2962ff";
  // The study paints its uptrend green and its downtrend red. The swatch takes
  // the colour of the direction the alert is waiting FOR, so a rail of
  // Supertrend alerts reads at a glance as "these are my longs, these my exits".
  if (a.conditionKind === "supertrend") {
    return a.mode === "cross_down" ? "#f23645" : "#089981";
  }
  // Same rule for the three families added later: a band is drawn in the
  // Bollinger study's own hue, and the two oscillators in theirs. Falling
  // through to `maColor` would have painted every one of them the 200-SMA
  // grey and labelled it "SMA 0".
  if (a.conditionKind === "bollinger") return "#2962ff";
  if (a.conditionKind === "stochastic") return "#26a69a";
  if (a.conditionKind === "adx") return "#ff9800";
  return maColor(a.maLength ?? 0);
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
      return `${fast} crosses ${a.mode === "cross_down" ? "below" : "above"} ${slow}` +
        describeFilters(a);
    }
    case "sr_zone": {
      const what = a.srSide === "resistance" ? "resistance"
        : a.srSide === "support" ? "support" : "nearest S/R";
      return `${nearPhrase(a)} the ${a.timeframe} ${what}${describeFilters(a)}`;
    }
    case "pivot_level": {
      const level = a.pivotLevelName === "any" ? "nearest level" : a.pivotLevelName;
      return `${nearPhrase(a)} ${a.pivotType} ${level} (${a.pivotAnchor})${describeFilters(a)}`;
    }
    case "rsi": {
      // The subject is the OSCILLATOR, so these read "RSI 50 crosses above",
      // never "price crosses above" — the distinction is the whole point.
      const against = a.indicatorTarget === "sma"
        ? `its SMA ${a.rsiMaLength ?? ""}`.trim()
        : `${a.rsiLevel ?? ""}`.trim();
      return `RSI ${a.rsiLength ?? ""} crosses ` +
        `${a.mode === "cross_down" ? "below" : "above"} ${against}${describeFilters(a)}`;
    }
    case "macd": {
      const against = a.indicatorTarget === "zero" ? "zero" : "the signal line";
      return `${macdLabel(a)} crosses ` +
        `${a.mode === "cross_down" ? "below" : "above"} ${against}${describeFilters(a)}`;
    }
    case "supertrend":
      // "flips", never "crosses": the event is the indicator changing
      // direction. A reader who sees "crosses" looks for a line price went
      // through, which is not what fires this alert.
      return `${stLabel(a)} flips ` +
        `${a.mode === "cross_down" ? "down" : "up"}${describeFilters(a)}`;
    case "bollinger": {
      // The subject is PRICE against a band, so these read like the MA arm.
      const line = bbLabel(a).toLowerCase();
      switch (a.mode) {
        case "touch": return `price touches the ${line}${describeFilters(a)}`;
        case "cross_up": return `price crosses above the ${line}${describeFilters(a)}`;
        case "cross_down": return `price crosses below the ${line}${describeFilters(a)}`;
        case "near_above":
          return `price ${a.nearMinPct}–${a.nearMaxPct}% above the ${line}${describeFilters(a)}`;
        case "near_below":
          return `price ${a.nearMinPct}–${a.nearMaxPct}% below the ${line}${describeFilters(a)}`;
        default: return `price against the ${line}${describeFilters(a)}`;
      }
    }
    case "stochastic": {
      // And here it is the OSCILLATOR, which watches no price at all.
      const against = a.indicatorTarget === "level" ? `${a.stochLevel ?? ""}`.trim() : "its %D";
      return `${stochLabel(a)} crosses ` +
        `${a.mode === "cross_down" ? "below" : "above"} ${against}${describeFilters(a)}`;
    }
    case "adx":
      // "rises through" rather than "crosses above": ADX has no direction, so
      // a crossing of its threshold is a statement about trend STRENGTH.
      return `${adxLabel(a)} ${a.mode === "cross_down" ? "falls" : "rises"} through ` +
        `${a.adxLevel ?? ""}`.trim() + describeFilters(a);
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
 * "the upper Bollinger band" for the study's own 20 / 2 / SMA, the inputs named
 * otherwise. Mirrors `bollingerLabel` on the server, which writes the
 * notification for the same row — two spellings of one alert is how a list and
 * a push notification come to disagree.
 */
export function bbLabel(a: MaAlert): string {
  const band = a.bbBand ?? BOLLINGER_DEFAULTS.band;
  const where = band === "basis" ? "Bollinger basis" : `${band} Bollinger band`;
  const custom = a.bbLength !== BOLLINGER_DEFAULTS.length
    || a.bbMult !== BOLLINGER_DEFAULTS.mult
    || (a.bbMaType ?? BOLLINGER_DEFAULTS.maType) !== BOLLINGER_DEFAULTS.maType;
  if (!custom) return where;
  const maType = (a.bbMaType ?? BOLLINGER_DEFAULTS.maType) === BOLLINGER_DEFAULTS.maType
    ? "" : `, ${(a.bbMaType ?? "sma").toUpperCase()}`;
  return `${where} (${a.bbLength}, ${a.bbMult}${maType})`;
}

/** "Stochastic %K", with its inputs named only when they are not the defaults. */
export function stochLabel(a: MaAlert): string {
  const custom = a.stochKLength !== STOCHASTIC_DEFAULTS.kLength
    || a.stochKSmooth !== STOCHASTIC_DEFAULTS.kSmooth
    || a.stochDSmooth !== STOCHASTIC_DEFAULTS.dSmooth;
  return custom
    ? `Stochastic %K ${a.stochKLength}/${a.stochKSmooth}/${a.stochDSmooth}`
    : "Stochastic %K";
}

/** "ADX", with its lengths named only when they are not the defaults. */
export function adxLabel(a: MaAlert): string {
  const custom = a.adxDiLength !== ADX_DEFAULTS.diLength
    || a.adxSmoothing !== ADX_DEFAULTS.smoothing;
  return custom ? `ADX ${a.adxDiLength}/${a.adxSmoothing}` : "ADX";
}

/**
 * "MACD" for the standard 12/26/9, "MACD 8/21/5" otherwise.
 *
 * Spelling out default lengths on every row is noise; spelling out non-default
 * ones is the only thing distinguishing two MACD alerts in the list.
 */
export function macdLabel(a: MaAlert): string {
  const isDefault =
    a.macdFast === MACD_DEFAULTS.fast &&
    a.macdSlow === MACD_DEFAULTS.slow &&
    a.macdSignal === MACD_DEFAULTS.signal;
  return isDefault ? "MACD" : `MACD ${a.macdFast}/${a.macdSlow}/${a.macdSignal}`;
}

/**
 * "Supertrend" for the study's own 10 / 3 / Wilder inputs, and the differences
 * spelled out otherwise. Same rule as `macdLabel`, and it must agree with
 * `stLabel` on the server, which writes the notification.
 */
export function stLabel(
  a: { stPeriod: number | null; stMultiplier: number | null; stAtrMethod: string | null }
): string {
  const parts: string[] = [];
  if (a.stPeriod !== SUPERTREND_DEFAULTS.period ||
      a.stMultiplier !== SUPERTREND_DEFAULTS.multiplier) {
    parts.push(`${a.stPeriod}/${a.stMultiplier}`);
  }
  if (a.stAtrMethod !== SUPERTREND_DEFAULTS.atrMethod) parts.push("SMA ATR");
  return parts.length > 0 ? `Supertrend ${parts.join(" ")}` : "Supertrend";
}

/**
 * The gates on an alert, phrased as the precondition they are.
 *
 * "only while" rather than "and": a gate never fires anything itself, it just
 * decides whether the event is worth telling you about. Reading it as a second
 * trigger is the misunderstanding this wording exists to prevent.
 *
 * A gate on another timeframe names it; one on the alert's own does not.
 * Labelling both would put "15m" on every gate of a 15m alert, and labelling
 * neither would hide the multi-timeframe case entirely.
 *
 * Must match `describeFilters` on the server, which writes the notification.
 */
export function describeFilters(a: MaAlert): string {
  const filters = a.filters ?? legacyFilters(a);
  if (filters.length === 0) return "";
  const parts = filters.map((f) => {
    const at = f.timeframe ? `${f.timeframe} ` : "";
    switch (f.kind) {
      case "rsi":
        return `${at}RSI ${f.length} is ${f.side} ${f.level}`;
      case "ma":
        return `${at}price is ${f.side} the ${maLabel(f.type, f.length)}`;
      case "supertrend":
        return `${at}price is ${f.side} the ` + stLabel({
          stPeriod: f.period, stMultiplier: f.multiplier, stAtrMethod: f.atrMethod,
        });
      case "pivot": {
        const level = f.levelName === "any"
          ? `the nearest ${f.pivotType} pivot`
          : `${f.pivotType} ${f.levelName}`;
        const where = f.side === "either" ? "either side of" : f.side;
        return `price is ${f.minPct}–${f.maxPct}% ${where} ${level} (${f.anchor})`;
      }
      case "rsi_ma":
        return `${at}RSI ${f.length} is ${f.side} its ${maLabel(f.maType, f.maLength)}`;
      case "macd": {
        const against = f.target === "zero"
          ? "zero"
          : `its signal line (${f.fastLength}/${f.slowLength}/${f.signalLength})`;
        return `${at}MACD is ${f.side} ${against}`;
      }
    }
  });
  return ` — only while ${parts.join(" and ")}`;
}

/** The pre-032 shape, for a row that has not been rewritten yet. */
function legacyFilters(a: MaAlert): AlertFilter[] {
  const out: AlertFilter[] = [];
  if (a.filterRsiLength !== null && a.filterRsiSide !== null) {
    out.push({
      kind: "rsi", timeframe: null, length: a.filterRsiLength,
      level: a.filterRsiLevel ?? 50, side: a.filterRsiSide as "above" | "below",
    });
  }
  if (a.filterMaType !== null && a.filterMaLength !== null && a.filterMaSide !== null) {
    out.push({
      kind: "ma", timeframe: null, type: a.filterMaType,
      length: a.filterMaLength, side: a.filterMaSide as "above" | "below",
    });
  }
  if (a.filterStPeriod !== null && a.filterStSide !== null) {
    out.push({
      kind: "supertrend", timeframe: null, period: a.filterStPeriod,
      multiplier: a.filterStMultiplier ?? 3,
      atrMethod: (a.filterStAtrMethod as "rma" | "sma" | null) ?? "rma",
      side: a.filterStSide as "above" | "below",
    });
  }
  return out;
}

/** The mode phrase shared by every kind that compares against a level. */
function nearPhrase(a: MaAlert): string {
  switch (a.mode) {
    case "touch": return "price touches";
    case "cross_up": return "price crosses above";
    case "cross_down": return "price crosses below";
    case "near_above": return `price ${a.nearMinPct}–${a.nearMaxPct}% above`;
    case "near_below": return `price ${a.nearMinPct}–${a.nearMaxPct}% below`;
    default: return "price reaches";
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
