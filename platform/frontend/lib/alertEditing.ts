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
  DEFAULT_ALERT_FREQUENCY, FILTER_DEFAULTS, MACD_DEFAULTS, RSI_DEFAULTS,
  type AlertFrequency, type ConditionKind, type FilterSide, type MaAlert,
  type MaAlertMode, type MaAlertUpdate, type MacdTarget, type MaType,
  type PivotType, type PriceDirection, type RsiTarget, type SrSide,
} from "@/lib/api";
import type { Interval } from "@/lib/types";

/** Every timeframe the backend supports, in toolbar order. */
export const EDIT_INTERVALS: Interval[] = [
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d",
];

/** Pivot anchors the platform stores candles for. Mirrors LevelAlertModal. */
export const PIVOT_ANCHORS: { id: string; label: string }[] = [
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
 * `rsi`, `macd` and `ma_vs_ma` are crosses of one series against another, and
 * the evaluator offers no touch or band for them — showing those would be a
 * control that cannot do anything.
 */
export const modesFor = (kind: ConditionKind): MaAlertMode[] =>
  kind === "rsi" || kind === "macd" || kind === "ma_vs_ma"
    ? ["cross_up", "cross_down"]
    : ["near_above", "near_below", "touch", "cross_up", "cross_down"];

/** Whether the percentage approach band is meaningful for this state. */
export const usesBand = (kind: ConditionKind, mode: MaAlertMode): boolean =>
  (kind === "ma" || kind === "sr_zone" || kind === "pivot_level") &&
  (mode === "near_above" || mode === "near_below");

/** Whether this family supports the optional trend gates. */
export const usesGates = (kind: ConditionKind): boolean =>
  kind === "sr_zone" || kind === "pivot_level";

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
  filterRsi: boolean;
  filterRsiLength: number;
  filterRsiLevel: number;
  filterRsiSide: FilterSide;
  filterMa: boolean;
  filterMaType: MaType;
  filterMaLength: number;
  filterMaSide: FilterSide;
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
    filterRsi: alert.filterRsiLength !== null && alert.filterRsiSide !== null,
    filterRsiLength: alert.filterRsiLength ?? FILTER_DEFAULTS.rsi.length,
    filterRsiLevel: alert.filterRsiLevel ?? FILTER_DEFAULTS.rsi.level,
    filterRsiSide: (alert.filterRsiSide as FilterSide | null) ?? FILTER_DEFAULTS.rsi.side,
    filterMa: alert.filterMaType !== null && alert.filterMaLength !== null,
    filterMaType: alert.filterMaType ?? FILTER_DEFAULTS.ma.type,
    filterMaLength: alert.filterMaLength ?? FILTER_DEFAULTS.ma.length,
    filterMaSide: (alert.filterMaSide as FilterSide | null) ?? FILTER_DEFAULTS.ma.side,
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
  }
  return null;
}

const isLength = (v: number): boolean => Number.isInteger(v) && v >= 1 && v <= 1000;

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
      setGates(body, form, alert);
      break;
    case "pivot_level":
      set("pivotType", form.pivotType, alert.pivotType);
      set("levelName", form.levelName, alert.pivotLevelName);
      set("anchor", form.anchor, alert.pivotAnchor);
      set("mode", form.mode, alert.mode);
      setBand(body, form, alert);
      setGates(body, form, alert);
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
  }
  return body;
}

function setBand(body: MaAlertUpdate, form: AlertEditForm, alert: MaAlert): void {
  if (form.nearMinPct !== alert.nearMinPct) body.nearMinPct = form.nearMinPct;
  if (form.nearMaxPct !== alert.nearMaxPct) body.nearMaxPct = form.nearMaxPct;
}

/**
 * A gate is all-or-nothing: switching it off sends the explicit `false` the
 * server needs to clear the columns, and switching it on sends every part of it
 * so a half-written gate can never be stored.
 */
function setGates(body: MaAlertUpdate, form: AlertEditForm, alert: MaAlert): void {
  const hadRsi = alert.filterRsiLength !== null && alert.filterRsiSide !== null;
  if (!form.filterRsi) {
    if (hadRsi) body.filterRsi = false;
  } else if (
    !hadRsi ||
    form.filterRsiLength !== alert.filterRsiLength ||
    form.filterRsiLevel !== alert.filterRsiLevel ||
    form.filterRsiSide !== alert.filterRsiSide
  ) {
    body.filterRsi = true;
    body.filterRsiLength = form.filterRsiLength;
    body.filterRsiLevel = form.filterRsiLevel;
    body.filterRsiSide = form.filterRsiSide;
  }

  const hadMa = alert.filterMaType !== null && alert.filterMaLength !== null;
  if (!form.filterMa) {
    if (hadMa) body.filterMa = false;
  } else if (
    !hadMa ||
    form.filterMaType !== alert.filterMaType ||
    form.filterMaLength !== alert.filterMaLength ||
    form.filterMaSide !== alert.filterMaSide
  ) {
    body.filterMa = true;
    body.filterMaType = form.filterMaType;
    body.filterMaLength = form.filterMaLength;
    body.filterMaSide = form.filterMaSide;
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
