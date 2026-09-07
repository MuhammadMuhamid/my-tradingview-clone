/**
 * The form behind "edit this alert", for every family.
 *
 * Pure on purpose. The editor component renders these fields and calls these
 * functions; it holds no rules of its own. That matters because the same editor
 * opens from the Alerts page and from the chart sidebar, and two copies of
 * "which fields does an RSI alert have" is how one surface ends up silently
 * dropping a value the other saves.
 *
 * ── What a save sends ──────────────────────────────────────────────────────
 *
 * Only what actually CHANGED. The server merges a partial edit onto the row's
 * existing condition and re-validates the whole thing, so sending an unchanged
 * field would be noise — and sending all of them would make every save look
 * like a rewrite in the audit trail. It also means opening an editor and
 * pressing Save without touching anything is a no-op rather than a write.
 */
import {
  ADX_DEFAULTS, ALERT_HISTORY_BARS, BOLLINGER_DEFAULTS, DEFAULT_ALERT_FREQUENCY, FILTER_DEFAULTS,
  MACD_DEFAULTS, RSI_DEFAULTS, STOCHASTIC_DEFAULTS, SUPERTREND_DEFAULTS,
  MAX_ALERT_FILTERS,
  type AlertFilter, type AlertFrequency, type BollingerBand, type ConditionKind, type FilterSide,
  type MaAlert, type StAtrMethod, type StochasticTarget,
  type MaAlertMode, type MaAlertUpdate, type MacdTarget, type MaType,
  type PivotType, type PriceDirection, type RsiTarget, type SrSide,
} from "@/lib/api";
import { filtersFromAlert } from "@/components/tv/AlertFiltersField";
import type { Interval } from "@/lib/types";

/** Every timeframe the backend supports, in toolbar order. */
export const EDIT_INTERVALS: Interval[] = [
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d",
];

/** Pivot anchors the platform stores candles for. Mirrors LevelAlertModal. */
export const PIVOT_ANCHORS: { id: string; label: string }[] = [
  { id: "1M", label: "Monthly" },
  { id: "1w", label: "Weekly" },
  { id: "1d", label: "Daily" },
  { id: "12h", label: "12 hours" },
  { id: "6h", label: "6 hours" },
  { id: "4h", label: "4 hours" },
];

export const PIVOT_TYPES: PivotType[] = [
  "Fibonacci", "Traditional", "Classic", "Woodie", "Camarilla",
];

/** Fibonacci defines P and three levels either side — it has no R4/R5. */
const FIB_LEVELS = ["any", "P", "R1", "S1", "R2", "S2", "R3", "S3"];
const FULL_LEVELS = [
  "any", "P", "R1", "S1", "R2", "S2", "R3", "S3", "R4", "S4", "R5", "S5",
];

export const pivotLevelNames = (type: PivotType): string[] =>
  type === "Fibonacci" ? FIB_LEVELS : FULL_LEVELS;

/** What the editor's title calls this alert. */
export const ALERT_FAMILY_LABELS: Record<ConditionKind, string> = {
  price: "Price",
  ma: "Moving average",
  ma_vs_ma: "MA cross",
  sr_zone: "Support / resistance",
  pivot_level: "Pivot level",
  rsi: "RSI",
  macd: "MACD",
  supertrend: "Supertrend",
  bollinger: "Bollinger band",
  stochastic: "Stochastic",
  adx: "ADX",
};

/** The modes each family can actually be evaluated with. */
export const MODE_LABELS: Record<MaAlertMode, string> = {
  touch: "Touches the level",
  cross_up: "Crosses above",
  cross_down: "Crosses below",
  near_above: "Approaches from above",
  near_below: "Approaches from below",
};

/**
 * What the condition dropdown calls a mode, for this family.
 *
 * Supertrend needs its own words: it does not cross anything, it changes
 * direction, and offering "crosses above" would describe an event this alert
 * does not watch. Everything else keeps the shared labels.
 */
export function modeLabel(kind: ConditionKind, mode: MaAlertMode): string {
  if (kind !== "supertrend") return MODE_LABELS[mode];
  return mode === "cross_down" ? "Flips down (Sell)" : "Flips up (Buy)";
}

/**
 * `rsi`, `macd`, `ma_vs_ma`, `stochastic` and `adx` are crosses of one series
 * against another, and `supertrend` is a direction change; the evaluator offers
 * no touch or band for any of them — showing those would be a control that
 * cannot do anything. `bollinger` compares PRICE against a band, so it keeps
 * the full set the MA family has.
 *
 * The server refuses the extra modes outright
 * (`backend/src/alerts/alertRequest.ts`), so offering them here produced a
 * dropdown whose entries were rejected on save.
 */
const CROSS_ONLY: readonly ConditionKind[] = [
  "rsi", "macd", "ma_vs_ma", "supertrend", "stochastic", "adx",
];

export const modesFor = (kind: ConditionKind): MaAlertMode[] =>
  CROSS_ONLY.includes(kind)
    ? ["cross_up", "cross_down"]
    : ["near_above", "near_below", "touch", "cross_up", "cross_down"];

/** Whether the percentage approach band is meaningful for this state. */
export const usesBand = (kind: ConditionKind, mode: MaAlertMode): boolean =>
  (kind === "ma" || kind === "sr_zone" || kind === "pivot_level" || kind === "bollinger") &&
  (mode === "near_above" || mode === "near_below");

/**
 * Whether this family supports the optional trend gates.
 *
 * All of them do. Kept as a function rather than deleted: the callers read
 * better for it, and if a family ever genuinely could not be gated this is the
 * one place that would say so.
 */
export const usesGates = (_kind: ConditionKind): boolean => true;

export interface AlertEditForm {
  symbol: string;
  timeframe: Interval;
  frequency: AlertFrequency;
  cooldownMin: number;
  note: string;
  enabled: boolean;
  mode: MaAlertMode;
  /** Kept as text so a half-typed decimal is not rewritten under the cursor. */
  targetPrice: string;
  priceDirection: PriceDirection;
  maType: MaType;
  maLength: number;
  ma2Type: MaType;
  ma2Length: number;
  nearMinPct: number;
  nearMaxPct: number;
  srSide: SrSide;
  pivotLength: number;
  invalidation: "close" | "wick";
  pivotType: PivotType;
  levelName: string;
  anchor: string;
  rsiLength: number;
  rsiTarget: RsiTarget;
  rsiLevel: number;
  rsiMaLength: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  macdTarget: MacdTarget;
  stPeriod: number;
  stMultiplier: number;
  stAtrMethod: StAtrMethod;
  bbLength: number;
  bbMult: number;
  bbBand: BollingerBand;
  bbMaType: MaType;
  stochKLength: number;
  stochKSmooth: number;
  stochDSmooth: number;
  stochTarget: StochasticTarget;
  stochLevel: number;
  adxDiLength: number;
  adxSmoothing: number;
  adxLevel: number;
  filterRsi: boolean;
  filterRsiLength: number;
  filterRsiLevel: number;
  filterRsiSide: FilterSide;
  filterMa: boolean;
  filterMaType: MaType;
  filterMaLength: number;
  filterMaSide: FilterSide;
  filterSt: boolean;
  filterStPeriod: number;
  filterStMultiplier: number;
  filterStAtrMethod: StAtrMethod;
  filterStSide: FilterSide;
  /**
   * The gates, in order — the shape actually saved since migration 032. The
   * flat `filter*` fields above are kept only so nothing that still reads them
   * breaks; `alertEditRequest` sends this list.
   */
  filters: AlertFilter[];
}

/** Default swing length for support/resistance; mirrors DEFAULT_SR_OPTIONS. */
const DEFAULT_SR_PIVOT_LENGTH = 5;

/**
 * Load a persisted alert into the form.
 *
 * Columns that belong to another family are null on this row, so every one of
 * them falls back to the same default the creation dialog would have offered.
 * That is deliberate: the fallback is never SAVED unless the user edits that
 * family's field, because `alertEditRequest` only sends what changed.
 */
export function alertEditForm(alert: MaAlert): AlertEditForm {
  return {
    symbol: alert.symbol,
    timeframe: alert.timeframe,
    frequency: alert.frequency,
    cooldownMin: alert.cooldownMin,
    note: alert.note ?? "",
    enabled: alert.enabled,
    mode: alert.mode ?? "cross_up",
    targetPrice: alert.targetPrice === null ? "" : String(alert.targetPrice),
    priceDirection: alert.priceDirection ?? "either",
    maType: alert.maType ?? "ema",
    maLength: alert.maLength ?? 200,
    ma2Type: alert.ma2Type ?? "sma",
    ma2Length: alert.ma2Length ?? 200,
    nearMinPct: alert.nearMinPct,
    nearMaxPct: alert.nearMaxPct,
    srSide: alert.srSide ?? "either",
    pivotLength: alert.srPivotLength ?? DEFAULT_SR_PIVOT_LENGTH,
    invalidation: alert.srInvalidation === "wick" ? "wick" : "close",
    pivotType: alert.pivotType ?? "Fibonacci",
    levelName: alert.pivotLevelName ?? "any",
    anchor: alert.pivotAnchor ?? "1d",
    rsiLength: alert.rsiLength ?? RSI_DEFAULTS.length,
    rsiTarget: alert.indicatorTarget === "sma" ? "sma" : "level",
    rsiLevel: alert.rsiLevel ?? RSI_DEFAULTS.level,
    rsiMaLength: alert.rsiMaLength ?? RSI_DEFAULTS.maLength,
    macdFast: alert.macdFast ?? MACD_DEFAULTS.fast,
    macdSlow: alert.macdSlow ?? MACD_DEFAULTS.slow,
    macdSignal: alert.macdSignal ?? MACD_DEFAULTS.signal,
    macdTarget: alert.indicatorTarget === "zero" ? "zero" : "signal",
    stPeriod: alert.stPeriod ?? SUPERTREND_DEFAULTS.period,
    stMultiplier: alert.stMultiplier ?? SUPERTREND_DEFAULTS.multiplier,
    stAtrMethod: (alert.stAtrMethod as StAtrMethod | null) ?? SUPERTREND_DEFAULTS.atrMethod,
    bbLength: alert.bbLength ?? BOLLINGER_DEFAULTS.length,
    bbMult: alert.bbMult ?? BOLLINGER_DEFAULTS.mult,
    bbBand: (alert.bbBand as BollingerBand | null) ?? BOLLINGER_DEFAULTS.band,
    bbMaType: alert.bbMaType ?? BOLLINGER_DEFAULTS.maType,
    stochKLength: alert.stochKLength ?? STOCHASTIC_DEFAULTS.kLength,
    stochKSmooth: alert.stochKSmooth ?? STOCHASTIC_DEFAULTS.kSmooth,
    stochDSmooth: alert.stochDSmooth ?? STOCHASTIC_DEFAULTS.dSmooth,
    stochTarget: alert.indicatorTarget === "level" ? "level" : "signal",
    stochLevel: alert.stochLevel ?? STOCHASTIC_DEFAULTS.level,
    adxDiLength: alert.adxDiLength ?? ADX_DEFAULTS.diLength,
    adxSmoothing: alert.adxSmoothing ?? ADX_DEFAULTS.smoothing,
    adxLevel: alert.adxLevel ?? ADX_DEFAULTS.level,
    filterRsi: alert.filterRsiLength !== null && alert.filterRsiSide !== null,
    filterRsiLength: alert.filterRsiLength ?? FILTER_DEFAULTS.rsi.length,
    filterRsiLevel: alert.filterRsiLevel ?? FILTER_DEFAULTS.rsi.level,
    filterRsiSide: (alert.filterRsiSide as FilterSide | null) ?? FILTER_DEFAULTS.rsi.side,
    filterMa: alert.filterMaType !== null && alert.filterMaLength !== null,
    filterMaType: alert.filterMaType ?? FILTER_DEFAULTS.ma.type,
    filterMaLength: alert.filterMaLength ?? FILTER_DEFAULTS.ma.length,
    filterMaSide: (alert.filterMaSide as FilterSide | null) ?? FILTER_DEFAULTS.ma.side,
    filterSt: alert.filterStPeriod !== null && alert.filterStSide !== null,
    filterStPeriod: alert.filterStPeriod ?? FILTER_DEFAULTS.supertrend.period,
    filterStMultiplier: alert.filterStMultiplier ?? FILTER_DEFAULTS.supertrend.multiplier,
    filterStAtrMethod:
      (alert.filterStAtrMethod as StAtrMethod | null) ?? FILTER_DEFAULTS.supertrend.atrMethod,
    filterStSide: (alert.filterStSide as FilterSide | null) ?? FILTER_DEFAULTS.supertrend.side,
    filters: filtersFromAlert(alert),
  };
}

/**
 * What the user must fix before the server would refuse it.
 *
 * Deliberately a SUBSET of the server's rules, not a replacement: the server
 * validates every one of these again, plus the ones only it can check. These
 * exist so an obvious mistake is named beside the field rather than returned as
 * a 400 after a round trip.
 */
export function validateAlertForm(
  kind: ConditionKind, form: AlertEditForm
): string | null {
  if (!/^[A-Z0-9]{2,24}$/.test(form.symbol.trim().toUpperCase())) {
    return "Symbol must be 2–24 letters or digits, e.g. BTCUSDT.";
  }
  if (!Number.isInteger(form.cooldownMin) || form.cooldownMin < 0) {
    return "Cooldown must be a whole number of minutes, or 0 for none.";
  }
  if (usesBand(kind, form.mode) && !(form.nearMaxPct > form.nearMinPct)) {
    return "The far edge of the band must be larger than the near edge.";
  }
  if (kind === "price") {
    const target = Number(form.targetPrice);
    if (!Number.isFinite(target) || target <= 0) return "Enter a price above zero.";
  }
  if (kind === "ma" || kind === "ma_vs_ma") {
    if (!isLength(form.maLength)) return "MA length must be a whole number from 1 to 1000.";
  }
  if (kind === "ma_vs_ma") {
    if (!isLength(form.ma2Length)) return "The second MA length must be from 1 to 1000.";
    if (form.maType === form.ma2Type && form.maLength === form.ma2Length) {
      return "The two moving averages must differ, or they can never cross.";
    }
  }
  if (kind === "sr_zone") {
    if (!Number.isInteger(form.pivotLength) || form.pivotLength < 2 || form.pivotLength > 100) {
      return "Swing length must be a whole number from 2 to 100.";
    }
  }
  if (kind === "pivot_level" && !pivotLevelNames(form.pivotType).includes(form.levelName)) {
    return `${form.pivotType} pivots do not define ${form.levelName}.`;
  }
  if (kind === "rsi") {
    if (!isLength(form.rsiLength)) return "RSI length must be a whole number from 1 to 1000.";
    if (form.rsiTarget === "level" && !(form.rsiLevel > 0 && form.rsiLevel < 100)) {
      return "RSI level must be between 0 and 100 — the oscillator cannot leave that range.";
    }
    if (form.rsiTarget === "sma" && !isLength(form.rsiMaLength)) {
      return "The RSI moving-average length must be from 1 to 1000.";
    }
  }
  if (kind === "macd") {
    for (const value of [form.macdFast, form.macdSlow, form.macdSignal]) {
      if (!isLength(value)) return "MACD lengths must be whole numbers from 1 to 1000.";
    }
    if (form.macdFast >= form.macdSlow) {
      return "Fast length must be below slow length, or the oscillator's sign inverts.";
    }
  }
  if (kind === "supertrend") {
    if (!isLength(form.stPeriod)) {
      return "The ATR period must be a whole number from 1 to 1000.";
    }
    if (!isMultiplier(form.stMultiplier)) return MULTIPLIER_MESSAGE;
  }
  if (kind === "bollinger") {
    if (!isLength(form.bbLength) || form.bbLength < 2) {
      return "Bollinger length must be a whole number from 2 to 1000.";
    }
    if (!isMultiplier(form.bbMult)) return MULTIPLIER_MESSAGE;
  }
  if (kind === "stochastic") {
    for (const value of [form.stochKLength, form.stochKSmooth, form.stochDSmooth]) {
      if (!isLength(value)) return "Stochastic lengths must be whole numbers from 1 to 1000.";
    }
    if (form.stochTarget === "level" && !(form.stochLevel > 0 && form.stochLevel < 100)) {
      return "The Stochastic level must be between 0 and 100 — %K cannot leave that range.";
    }
  }
  if (kind === "adx") {
    for (const value of [form.adxDiLength, form.adxSmoothing]) {
      if (!isLength(value)) return "ADX lengths must be whole numbers from 1 to 1000.";
    }
    if (!(form.adxLevel > 0 && form.adxLevel < 100)) {
      return "The ADX level must be between 0 and 100.";
    }
  }
  /*
   * And the combination the per-field bounds cannot see.
   *
   * Every length above is checked at 1..1000 independently, but the runner
   * evaluates against a fixed window of bars. Lengths that individually pass
   * can together need more history than the runner ever loads, which produces
   * an alert that looks armed on the list and can never warm up. The server
   * refuses the same combinations; this exists so the number is named beside
   * the field rather than returned as a 400.
   */
  const need = warmupBars(kind, form);
  if (need > ALERT_HISTORY_BARS) {
    return `These lengths need ${need} bars of history and the alert runner keeps ` +
      `${ALERT_HISTORY_BARS}. Reduce them, or the alert can never warm up.`;
  }
  if (form.filters.length > MAX_ALERT_FILTERS) {
    return `An alert may carry at most ${MAX_ALERT_FILTERS} filters.`;
  }
  for (const f of form.filters) {
    if (f.kind === "rsi") {
      if (!isLength(f.length)) return "A filter's RSI length must be from 1 to 1000.";
      if (!(f.level > 0 && f.level < 100)) {
        return "A filter's RSI level must be between 0 and 100.";
      }
    }
    if (f.kind === "ma" && !isLength(f.length)) {
      return "A filter's moving-average length must be from 1 to 1000.";
    }
    if (f.kind === "supertrend") {
      if (!isLength(f.period)) return "A filter's Supertrend ATR period must be from 1 to 1000.";
      if (!isMultiplier(f.multiplier)) return MULTIPLIER_MESSAGE;
    }
  }
  // Two identical gates are the same question asked twice — almost always a
  // timeframe the user meant to change and did not.
  const seen = new Set<string>();
  for (const f of form.filters) {
    const key = JSON.stringify(f);
    if (seen.has(key)) {
      return "Two filters are identical — remove one, or change its timeframe.";
    }
    seen.add(key);
  }
  if (usesGates(kind)) {
    if (form.filterRsi) {
      if (!isLength(form.filterRsiLength)) return "The RSI filter length must be from 1 to 1000.";
      if (!(form.filterRsiLevel > 0 && form.filterRsiLevel < 100)) {
        return "The RSI filter level must be between 0 and 100.";
      }
    }
    if (form.filterMa && !isLength(form.filterMaLength)) {
      return "The moving-average filter length must be from 1 to 1000.";
    }
    if (form.filterSt) {
      if (!isLength(form.filterStPeriod)) {
        return "The Supertrend filter ATR period must be from 1 to 1000.";
      }
      if (!isMultiplier(form.filterStMultiplier)) return MULTIPLIER_MESSAGE;
    }
  }
  return null;
}

const isLength = (v: number): boolean => Number.isInteger(v) && v >= 1 && v <= 1000;

/**
 * A Supertrend multiplier that can actually produce a flip.
 *
 * At or below zero the bands collapse onto the midpoint or swap, so the trend
 * flips on nearly every bar; far above, the band is wider than any move the
 * market makes and it never flips at all. Both are alerts that look armed and
 * are useless, in opposite directions.
 */
const isMultiplier = (v: number): boolean => Number.isFinite(v) && v > 0 && v <= 100;
const MULTIPLIER_MESSAGE =
  "The ATR multiplier must be greater than 0 and at most 100.";

/**
 * The PATCH body for this edit: the keys whose value differs from the alert as
 * the server currently holds it, and nothing else.
 *
 * `conditionKind` is always sent. It changes nothing — the server refuses any
 * value but the row's own — and that is exactly what makes it useful: an editor
 * opened on a stale list cannot save an RSI form onto a row that has since
 * become something else.
 */
export function alertEditRequest(
  alert: MaAlert, form: AlertEditForm
): MaAlertUpdate {
  const body: MaAlertUpdate = { conditionKind: alert.conditionKind };
  const set = <K extends keyof MaAlertUpdate>(
    key: K, next: MaAlertUpdate[K], current: unknown
  ): void => {
    if (next !== current) body[key] = next;
  };

  set("symbol", form.symbol.trim().toUpperCase(), alert.symbol);
  set("timeframe", form.timeframe, alert.timeframe);
  set("frequency", form.frequency, alert.frequency);
  set("cooldownMin", form.cooldownMin, alert.cooldownMin);
  set("enabled", form.enabled, alert.enabled);
  // "" and null both mean "no note"; only a real change is worth sending.
  const note = form.note.trim() === "" ? null : form.note;
  if (note !== (alert.note === "" ? null : alert.note)) body.note = note;

  /*
   * Gates are editable on every family, so they are handled once outside the
   * switch. A per-family call is a line a new family can silently omit — which
   * presents as a gate the editor shows, lets you change, and never saves.
   *
   * The whole list is sent whenever it differs, rather than a diff: the server
   * replaces the gates outright with what it receives, and an empty list is how
   * "I removed the last one" is expressed. A diff would have no way to say that.
   */
  const before = JSON.stringify(filtersFromAlert(alert));
  if (JSON.stringify(form.filters) !== before) body.filters = form.filters;

  switch (alert.conditionKind) {
    case "price":
      set("targetPrice", Number(form.targetPrice), alert.targetPrice);
      set("priceDirection", form.priceDirection, alert.priceDirection);
      break;
    case "ma":
      set("maType", form.maType, alert.maType);
      set("maLength", form.maLength, alert.maLength);
      set("mode", form.mode, alert.mode);
      setBand(body, form, alert);
      break;
    case "ma_vs_ma":
      set("maType", form.maType, alert.maType);
      set("maLength", form.maLength, alert.maLength);
      set("ma2Type", form.ma2Type, alert.ma2Type);
      set("ma2Length", form.ma2Length, alert.ma2Length);
      set("mode", form.mode, alert.mode);
      break;
    case "sr_zone":
      set("srSide", form.srSide, alert.srSide);
      set("pivotLength", form.pivotLength, alert.srPivotLength);
      set("invalidation", form.invalidation, alert.srInvalidation);
      set("mode", form.mode, alert.mode);
      setBand(body, form, alert);
      break;
    case "pivot_level":
      set("pivotType", form.pivotType, alert.pivotType);
      set("levelName", form.levelName, alert.pivotLevelName);
      set("anchor", form.anchor, alert.pivotAnchor);
      set("mode", form.mode, alert.mode);
      setBand(body, form, alert);
      break;
    case "rsi":
      set("rsiLength", form.rsiLength, alert.rsiLength);
      set("target", form.rsiTarget, alert.indicatorTarget);
      set("rsiLevel", form.rsiLevel, alert.rsiLevel);
      set("rsiMaLength", form.rsiMaLength, alert.rsiMaLength);
      set("mode", form.mode, alert.mode);
      break;
    case "macd":
      set("macdFast", form.macdFast, alert.macdFast);
      set("macdSlow", form.macdSlow, alert.macdSlow);
      set("macdSignal", form.macdSignal, alert.macdSignal);
      set("target", form.macdTarget, alert.indicatorTarget);
      set("mode", form.mode, alert.mode);
      break;
    case "supertrend":
      set("stPeriod", form.stPeriod, alert.stPeriod);
      set("stMultiplier", form.stMultiplier, alert.stMultiplier);
      set("stAtrMethod", form.stAtrMethod, alert.stAtrMethod);
      set("mode", form.mode, alert.mode);
      break;
    case "bollinger":
      set("bbLength", form.bbLength, alert.bbLength);
      set("bbMult", form.bbMult, alert.bbMult);
      set("bbBand", form.bbBand, alert.bbBand);
      set("bbMaType", form.bbMaType, alert.bbMaType);
      set("mode", form.mode, alert.mode);
      setBand(body, form, alert);
      break;
    case "stochastic":
      set("stochKLength", form.stochKLength, alert.stochKLength);
      set("stochKSmooth", form.stochKSmooth, alert.stochKSmooth);
      set("stochDSmooth", form.stochDSmooth, alert.stochDSmooth);
      set("target", form.stochTarget, alert.indicatorTarget);
      set("stochLevel", form.stochLevel, alert.stochLevel);
      set("mode", form.mode, alert.mode);
      break;
    case "adx":
      set("adxDiLength", form.adxDiLength, alert.adxDiLength);
      set("adxSmoothing", form.adxSmoothing, alert.adxSmoothing);
      set("adxLevel", form.adxLevel, alert.adxLevel);
      set("mode", form.mode, alert.mode);
      break;
  }
  return body;
}

function setBand(body: MaAlertUpdate, form: AlertEditForm, alert: MaAlert): void {
  if (form.nearMinPct !== alert.nearMinPct) body.nearMinPct = form.nearMinPct;
  if (form.nearMaxPct !== alert.nearMaxPct) body.nearMaxPct = form.nearMaxPct;
}


/**
 * How many bars this configuration must see before it produces a first value.
 *
 * Mirrors `warmupBars` on the server, which refuses the same combinations. Only
 * the families whose warm-up can OUTRUN the window are counted; a single length
 * capped at 1000 always fits, so `ma`, `rsi` and the rest return 0 rather than
 * a number nothing reads.
 */
export function warmupBars(kind: ConditionKind, form: AlertEditForm): number {
  switch (kind) {
    case "macd":
      // The signal line is an EMA of the MACD line, so the two stack.
      return form.macdSlow + form.macdSignal;
    case "stochastic":
      // %K needs its window and its smoothing; %D smooths %K again.
      return form.stochKLength + form.stochKSmooth + form.stochDSmooth;
    case "adx":
      // DI needs `diLength`, and DX is then smoothed over `smoothing` bars.
      return form.adxDiLength + form.adxSmoothing;
    default:
      return 0;
  }
}

/** Whether this edit would actually write anything. */
export const hasAlertChanges = (body: MaAlertUpdate): boolean =>
  Object.keys(body).some((key) => key !== "conditionKind");

/**
 * Whether an edit moved the alert out of what the list is currently showing.
 *
 * The Alerts page uses it to say so, because an edited alert vanishing from a
 * filtered list looks exactly like a failed save.
 */
export const leavesFilteredView = (
  before: MaAlert, after: MaAlert, visible: (alert: MaAlert) => boolean
): boolean => visible(before) && !visible(after);

/** Unchanged default, re-exported so the editor need not import two modules. */
export { DEFAULT_ALERT_FREQUENCY };
