/**
 * The alert a study's `Add alert on …` should open with: that study's own
 * inputs, not the alert family's defaults.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * C-04: the chart's RSI was RSI(14, close), and its ⋯ → "Add alert on
 * Relative Strength Index…" opened the dialog at `RSI_DEFAULTS` — length 50 —
 * so the alert watched a different indicator from the line the reader had
 * just clicked. A reader who arms it is told "RSI 50 crosses above 50" in a
 * summary they have no reason to read twice.
 *
 * Only the indicator's own parameters are carried. What the alert does with
 * it — the level, the target, the direction — stays the dialog's choice,
 * because the study has no opinion about those. The toolbar's path passes no
 * seed and keeps the family defaults. Alert GATES (`FILTER_DEFAULTS`) are a
 * separate thing with their own deliberate defaults and are not touched here.
 *
 * What the alert engine cannot evaluate the study's way — RSI of `hl2`, a
 * Bollinger basis that is neither SMA nor EMA — is said rather than silently
 * substituted: `differs` is the sentence the dialog shows.
 */
import type { StAtrMethod } from "./api";

export interface IndicatorAlertSeed {
  rsiLength?: number;
  macdFast?: number;
  macdSlow?: number;
  macdSignal?: number;
  bbLength?: number;
  bbMult?: number;
  bbMaType?: "sma" | "ema";
  stPeriod?: number;
  stMultiplier?: number;
  stAtrMethod?: StAtrMethod;
  stochKLength?: number;
  stochKSmooth?: number;
  stochDSmooth?: number;
  adxDiLength?: number;
  adxSmoothing?: number;
  /** What of the study the alert cannot match, as a sentence, or null. */
  differs: string | null;
}

type Params = Readonly<Record<string, unknown>>;

const num = (p: Params, key: string): number | undefined => {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** Alerts evaluate an indicator of the bar's close; anything else differs. */
function sourceDiffers(p: Params, name: string): string | null {
  const source = p.source;
  if (source === undefined || source === "close") return null;
  return `This ${name} reads ${String(source)}; an alert evaluates it on the close.`;
}

/** Drop the keys the study did not carry, so the dialog keeps its own value there. */
function defined(seed: IndicatorAlertSeed): IndicatorAlertSeed {
  return Object.fromEntries(
    Object.entries(seed).filter(([k, v]) => v !== undefined || k === "differs"),
  ) as unknown as IndicatorAlertSeed;
}

/** The seed for a built-in study, by its definition id, or null for one no alert watches. */
export function alertSeedFromStudy(defId: string, params: Params): IndicatorAlertSeed | null {
  switch (defId) {
    case "rsi":
      return defined({ rsiLength: num(params, "length"), differs: sourceDiffers(params, "RSI") });
    case "macd":
      return defined({
        macdFast: num(params, "fast"), macdSlow: num(params, "slow"), macdSignal: num(params, "signal"),
        differs: sourceDiffers(params, "MACD"),
      });
    case "bb": {
      const type = typeof params.maType === "string" ? params.maType.toLowerCase() : undefined;
      const basis = type === "sma" || type === "ema" ? type : undefined;
      const notes = [
        sourceDiffers(params, "Bollinger study"),
        type !== undefined && basis === undefined
          ? `This study's basis is ${String(params.maType)}; an alert can watch an SMA or EMA basis only.`
          : null,
      ].filter((s): s is string => s !== null);
      return defined({
        bbLength: num(params, "length"), bbMult: num(params, "mult"), bbMaType: basis,
        differs: notes.length > 0 ? notes.join(" ") : null,
      });
    }
    case "supertrend": {
      const method = params.atrMethod === "rma" || params.atrMethod === "sma"
        ? params.atrMethod as StAtrMethod : undefined;
      return defined({
        stPeriod: num(params, "period"), stMultiplier: num(params, "multiplier"), stAtrMethod: method,
        differs: null,
      });
    }
    case "stoch":
      return defined({
        stochKLength: num(params, "kLength"), stochKSmooth: num(params, "kSmooth"),
        stochDSmooth: num(params, "dSmooth"), differs: null,
      });
    case "adx":
      return defined({
        adxDiLength: num(params, "diLength"), adxSmoothing: num(params, "adxLength"), differs: null,
      });
    default:
      return null;
  }
}
