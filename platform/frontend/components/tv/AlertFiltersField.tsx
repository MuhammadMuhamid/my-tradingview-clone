"use client";
import {
  FILTER_DEFAULTS, FILTER_TIMEFRAMES, MAX_ALERT_FILTERS,
  type AlertFilter, type FilterSide, type MaAlert, type MacdTarget, type MaType,
  type StAtrMethod,
} from "@/lib/api";
import type { Interval } from "@/lib/types";

/**
 * The "only fire when" gates, shared by every alert dialog.
 *
 * One component rather than a copy per dialog, because a gate is a promise
 * about when an alert stays SILENT — and five dialogs each describing that
 * promise slightly differently is how a user ends up believing an alert is
 * gated on something it is not.
 *
 * ── A list, not three checkboxes ───────────────────────────────────────────
 *
 * It used to be one slot per kind, which could not express the most common
 * multi-timeframe question there is: "the 15m RSI AND the 1h RSI are both
 * above 50". Two gates of the same kind on different timeframes needs a list,
 * so that is what this is.
 *
 * Every gate carries its own timeframe. "Chart timeframe" means the alert's
 * own, which is what every gate meant before this existed.
 */

/** A new gate of each kind, with the study's own defaults. */
function blankFilter(kind: AlertFilter["kind"]): AlertFilter {
  if (kind === "rsi") {
    return {
      kind: "rsi", timeframe: null,
      length: FILTER_DEFAULTS.rsi.length,
      level: FILTER_DEFAULTS.rsi.level,
      side: FILTER_DEFAULTS.rsi.side,
    };
  }
  if (kind === "ma") {
    return {
      kind: "ma", timeframe: null,
      type: FILTER_DEFAULTS.ma.type,
      length: FILTER_DEFAULTS.ma.length,
      side: FILTER_DEFAULTS.ma.side,
    };
  }
  if (kind === "rsi_ma") {
    return {
      kind: "rsi_ma", timeframe: null,
      length: FILTER_DEFAULTS.rsi_ma.length,
      maType: FILTER_DEFAULTS.rsi_ma.maType,
      maLength: FILTER_DEFAULTS.rsi_ma.maLength,
      side: FILTER_DEFAULTS.rsi_ma.side,
    };
  }
  if (kind === "macd") {
    return {
      kind: "macd", timeframe: null,
      fastLength: FILTER_DEFAULTS.macd.fastLength,
      slowLength: FILTER_DEFAULTS.macd.slowLength,
      signalLength: FILTER_DEFAULTS.macd.signalLength,
      target: FILTER_DEFAULTS.macd.target,
      side: FILTER_DEFAULTS.macd.side,
    };
  }
  if (kind === "pivot") {
    /*
     * 0–0.5% and `either`: "within half a percent of the level, from whichever
     * side" is what "near a pivot" means to most people. Raising the floor
     * turns it into an approach band instead — coming up on the level but not
     * there yet — which is the same reading the near_above alert mode has.
     */
    return {
      kind: "pivot", timeframe: null, anchor: "1d",
      pivotType: "Fibonacci", levelName: "any",
      side: "either", minPct: 0, maxPct: 0.5,
    };
  }
  return {
    kind: "supertrend", timeframe: null,
    period: FILTER_DEFAULTS.supertrend.period,
    multiplier: FILTER_DEFAULTS.supertrend.multiplier,
    atrMethod: FILTER_DEFAULTS.supertrend.atrMethod,
    side: FILTER_DEFAULTS.supertrend.side,
  };
}

/** The gates a persisted alert already carries. */
export function filtersFromAlert(a: MaAlert): AlertFilter[] {
  if (a.filters) return a.filters;
  /*
   * A row written before migration 032 has no list, only the flat columns.
   * Reconstructed here in the same order the server reconstructs them, so the
   * editor shows what the alert actually enforces rather than an empty list
   * that would silently drop the gates on the next save.
   */
  const out: AlertFilter[] = [];
  if (a.filterRsiLength !== null && a.filterRsiSide !== null) {
    out.push({
      kind: "rsi", timeframe: null, length: a.filterRsiLength,
      level: a.filterRsiLevel ?? FILTER_DEFAULTS.rsi.level,
      side: a.filterRsiSide as FilterSide,
    });
  }
  if (a.filterMaType !== null && a.filterMaLength !== null && a.filterMaSide !== null) {
    out.push({
      kind: "ma", timeframe: null, type: a.filterMaType,
      length: a.filterMaLength, side: a.filterMaSide as FilterSide,
    });
  }
  if (a.filterStPeriod !== null && a.filterStSide !== null) {
    out.push({
      kind: "supertrend", timeframe: null, period: a.filterStPeriod,
      multiplier: a.filterStMultiplier ?? FILTER_DEFAULTS.supertrend.multiplier,
      atrMethod: (a.filterStAtrMethod as StAtrMethod | null)
        ?? FILTER_DEFAULTS.supertrend.atrMethod,
      side: a.filterStSide as FilterSide,
    });
  }
  return out;
}

/**
 * The request fields for these gates.
 *
 * Always the list, and always sent — including when it is empty, because an
 * empty list is how "remove the last gate" is expressed. Omitting it would
 * leave the server merging the row's existing gates back in.
 */
export const filterRequest = (filters: AlertFilter[]): { filters: AlertFilter[] } =>
  ({ filters });

const BOX =
  "rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent";

const KIND_LABEL: Record<AlertFilter["kind"], string> = {
  rsi: "RSI",
  ma: "Moving average",
  supertrend: "Supertrend",
  pivot: "Pivot points",
  rsi_ma: "RSI vs its average",
  macd: "MACD",
};

/** Fibonacci defines P and three levels either side — it has no R4/R5. */
const FIB_LEVELS = ["any", "P", "R1", "S1", "R2", "S2", "R3", "S3"];
const FULL_LEVELS = [
  "any", "P", "R1", "S1", "R2", "S2", "R3", "S3", "R4", "S4", "R5", "S5",
];
const levelsFor = (type: string): string[] =>
  type === "Fibonacci" ? FIB_LEVELS : FULL_LEVELS;

/** The periods pivot levels are taken from. Mirrors `PIVOT_ANCHORS`. */
const PIVOT_ANCHOR_OPTIONS = [
  { id: "1M", label: "Monthly" },
  { id: "1w", label: "Weekly" },
  { id: "1d", label: "Daily" },
  { id: "12h", label: "12 hours" },
  { id: "6h", label: "6 hours" },
  { id: "4h", label: "4 hours" },
];

export function AlertFiltersField({
  value, onChange, chartTimeframe,
}: {
  value: AlertFilter[];
  onChange: (next: AlertFilter[]) => void;
  /** Shown as what "Chart timeframe" resolves to, so the default is not a mystery. */
  chartTimeframe?: Interval;
}) {
  const patch = (index: number, changes: Partial<AlertFilter>): void =>
    onChange(value.map((f, i) => (i === index ? { ...f, ...changes } as AlertFilter : f)));
  const remove = (index: number): void => onChange(value.filter((_, i) => i !== index));
  const add = (kind: AlertFilter["kind"]): void => onChange([...value, blankFilter(kind)]);

  const timeframeSelect = (f: AlertFilter, i: number) => (
    <select
      value={f.timeframe ?? ""}
      aria-label="Filter timeframe"
      onChange={(e) =>
        patch(i, { timeframe: (e.target.value || null) as Interval | null })}
      className={`${BOX} w-[132px]`}
    >
      <option value="">
        Chart timeframe{chartTimeframe ? ` (${chartTimeframe})` : ""}
      </option>
      {FILTER_TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
    </select>
  );

  const sideSelect = (f: AlertFilter, i: number, label: string) => (
    <select
      value={f.side}
      aria-label={label}
      onChange={(e) => patch(i, { side: e.target.value as FilterSide })}
      className={`${BOX} w-[92px]`}
    >
      <option value="above">is above</option>
      <option value="below">is below</option>
    </select>
  );

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm text-ink-muted">Only fire when</span>
        {value.length > 0 && (
          <span className="text-[11px] text-ink-faint">
            {value.length} of {MAX_ALERT_FILTERS} · all must hold
          </span>
        )}
      </div>

      {value.length === 0 && (
        <p className="text-xs text-ink-faint">
          No filters — the alert fires whenever its own condition is met.
        </p>
      )}

      {value.map((f, i) => (
        <div key={i} className="space-y-1.5 rounded-md border border-border bg-surface-2/40 p-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-ink">{KIND_LABEL[f.kind]}</span>
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label={`Remove ${KIND_LABEL[f.kind]} filter`}
              className="rounded px-1.5 text-xs text-ink-faint hover:text-down"
            >
              Remove
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* A pivot gate is anchored to a completed period, so it names an
                anchor below instead of a chart timeframe. */}
            {f.kind !== "pivot" && timeframeSelect(f, i)}

            {f.kind === "rsi" && (
              <>
                <span className="text-sm text-ink-muted">RSI</span>
                <input type="number" min="1" max="1000" value={f.length}
                  aria-label="Filter RSI length"
                  onChange={(e) => patch(i, { length: parseInt(e.target.value || "0", 10) })}
                  className={`${BOX} w-[68px]`} />
                {sideSelect(f, i, "Filter RSI side")}
                <input type="number" min="1" max="99" value={f.level}
                  aria-label="Filter RSI level"
                  onChange={(e) => patch(i, { level: parseFloat(e.target.value || "0") })}
                  className={`${BOX} w-[68px]`} />
              </>
            )}

            {f.kind === "ma" && (
              <>
                <span className="text-sm text-ink-muted">Price</span>
                {sideSelect(f, i, "Filter MA side")}
                <select value={f.type} aria-label="Filter MA type"
                  onChange={(e) => patch(i, { type: e.target.value as MaType })}
                  className={`${BOX} w-[76px]`}>
                  <option value="ema">EMA</option>
                  <option value="sma">SMA</option>
                </select>
                <input type="number" min="1" max="1000" value={f.length}
                  aria-label="Filter MA length"
                  onChange={(e) => patch(i, { length: parseInt(e.target.value || "0", 10) })}
                  className={`${BOX} w-[76px]`} />
              </>
            )}

            {f.kind === "macd" && (
            <p className="text-xs text-ink-faint">
              Fast / slow / signal. This is the <span className="text-ink">state</span> a
              crossover leaves behind, not the single bar it crossed on —
              {f.target === "signal"
                ? " bullish stays true for as long as the line is above its signal,"
                : " the reading stays true for as long as it holds,"}
              {" "}which is what a filter needs. Add a second MACD filter on another
              timeframe to require both at once.
              {f.fastLength >= f.slowLength
                ? " Fast must be shorter than slow, or the line is inverted."
                : ""}
            </p>
          )}

          {f.kind === "pivot" && (
              <>
                <select value={f.anchor} aria-label="Filter pivot anchor"
                  onChange={(e) => patch(i, { anchor: e.target.value })}
                  className={`${BOX} w-[112px]`}>
                  {PIVOT_ANCHOR_OPTIONS.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>
                <select value={f.pivotType} aria-label="Filter pivot type"
                  onChange={(e) => {
                    const pivotType = e.target.value as typeof f.pivotType;
                    // Switching to Fibonacci while R4 is chosen would leave a
                    // level that type never computes, and the gate could never
                    // resolve — which fails closed and silences the alert.
                    const levelName = levelsFor(pivotType).includes(f.levelName)
                      ? f.levelName : "any";
                    patch(i, { pivotType, levelName });
                  }}
                  className={`${BOX} w-[112px]`}>
                  {["Fibonacci", "Traditional", "Classic", "Woodie", "Camarilla"].map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <select value={f.levelName} aria-label="Filter pivot level"
                  onChange={(e) => patch(i, { levelName: e.target.value })}
                  className={`${BOX} w-[104px]`}>
                  {levelsFor(f.pivotType).map((l) => (
                    <option key={l} value={l}>{l === "any" ? "Nearest" : l}</option>
                  ))}
                </select>
                <select value={f.side} aria-label="Filter pivot side"
                  onChange={(e) =>
                    patch(i, { side: e.target.value as typeof f.side })}
                  className={`${BOX} w-[104px]`}>
                  <option value="either">either side</option>
                  <option value="above">above</option>
                  <option value="below">below</option>
                </select>
                <input type="number" min="0" step="0.05" value={f.minPct}
                  aria-label="Filter pivot band start"
                  onChange={(e) => patch(i, { minPct: parseFloat(e.target.value || "0") })}
                  className={`${BOX} w-[64px]`} />
                <span className="text-sm text-ink-faint">to</span>
                <input type="number" min="0" step="0.05" value={f.maxPct}
                  aria-label="Filter pivot band end"
                  onChange={(e) => patch(i, { maxPct: parseFloat(e.target.value || "0") })}
                  className={`${BOX} w-[64px]`} />
                <span className="text-sm text-ink-muted">%</span>
              </>
            )}

            {f.kind === "rsi_ma" && (
              <>
                <span className="text-sm text-ink-muted">RSI</span>
                <input type="number" min="1" max="1000" value={f.length}
                  aria-label="Filter RSI length"
                  onChange={(e) => patch(i, { length: parseInt(e.target.value || "0", 10) })}
                  className={`${BOX} w-[68px]`} />
                {sideSelect(f, i, "Filter RSI average side")}
                <span className="text-sm text-ink-muted">its</span>
                <select value={f.maType} aria-label="Filter RSI average type"
                  onChange={(e) => patch(i, { maType: e.target.value as MaType })}
                  className={`${BOX} w-[76px]`}>
                  <option value="ema">EMA</option>
                  <option value="sma">SMA</option>
                </select>
                <input type="number" min="1" max="1000" value={f.maLength}
                  aria-label="Filter RSI average length"
                  onChange={(e) => patch(i, { maLength: parseInt(e.target.value || "0", 10) })}
                  className={`${BOX} w-[68px]`} />
              </>
            )}

            {f.kind === "macd" && (
              <>
                <span className="text-sm text-ink-muted">MACD</span>
                {/*
                  Against the signal line the two sides are named bullish and
                  bearish, because that is what they mean to a reader — "is
                  above / signal line" described the same rule but nobody could
                  tell it was the bullish-crossover filter they wanted. Against
                  ZERO the words would be wrong, so that case keeps above/below.
                */}
                <select value={f.side} aria-label="Filter MACD side"
                  onChange={(e) => patch(i, { side: e.target.value as FilterSide })}
                  className={`${BOX} w-[188px]`}>
                  {f.target === "signal" ? (
                    <>
                      <option value="above">is bullish (above signal)</option>
                      <option value="below">is bearish (below signal)</option>
                    </>
                  ) : (
                    <>
                      <option value="above">is above</option>
                      <option value="below">is below</option>
                    </>
                  )}
                </select>
                <select value={f.target} aria-label="Filter MACD target"
                  onChange={(e) => patch(i, { target: e.target.value as MacdTarget })}
                  className={`${BOX} w-[112px]`}>
                  <option value="signal">vs signal line</option>
                  <option value="zero">vs zero</option>
                </select>
                <input type="number" min="1" max="1000" value={f.fastLength}
                  aria-label="Filter MACD fast length"
                  onChange={(e) => patch(i, { fastLength: parseInt(e.target.value || "0", 10) })}
                  className={`${BOX} w-[64px]`} />
                <input type="number" min="1" max="1000" value={f.slowLength}
                  aria-label="Filter MACD slow length"
                  onChange={(e) => patch(i, { slowLength: parseInt(e.target.value || "0", 10) })}
                  className={`${BOX} w-[64px]`} />
                <input type="number" min="1" max="1000" value={f.signalLength}
                  aria-label="Filter MACD signal length"
                  onChange={(e) =>
                    patch(i, { signalLength: parseInt(e.target.value || "0", 10) })}
                  className={`${BOX} w-[64px]`} />
              </>
            )}

            {f.kind === "supertrend" && (
              <>
                <span className="text-sm text-ink-muted">Price</span>
                {sideSelect(f, i, "Filter Supertrend side")}
                <span className="whitespace-nowrap text-sm text-ink-muted">Supertrend</span>
                <input type="number" min="1" max="1000" value={f.period}
                  aria-label="Filter Supertrend ATR period"
                  onChange={(e) => patch(i, { period: parseInt(e.target.value || "0", 10) })}
                  className={`${BOX} w-[64px]`} />
                <input type="number" min="0.1" max="100" step="0.1" value={f.multiplier}
                  aria-label="Filter Supertrend multiplier"
                  onChange={(e) => patch(i, { multiplier: parseFloat(e.target.value || "0") })}
                  className={`${BOX} w-[64px]`} />
              </>
            )}
          </div>

          {f.kind === "macd" && (
            <p className="text-xs text-ink-faint">
              Fast / slow / signal. This is the <span className="text-ink">state</span> a
              crossover leaves behind, not the single bar it crossed on —
              {f.target === "signal"
                ? " bullish stays true for as long as the line is above its signal,"
                : " the reading stays true for as long as it holds,"}
              {" "}which is what a filter needs. Add a second MACD filter on another
              timeframe to require both at once.
              {f.fastLength >= f.slowLength
                ? " Fast must be shorter than slow, or the line is inverted."
                : ""}
            </p>
          )}

          {f.kind === "pivot" && (
            <p className="text-xs text-ink-faint">
              {f.minPct > 0
                ? `Price approaching the level — ${f.minPct}–${f.maxPct}% away, not yet at it.`
                : `Price within ${f.maxPct}% of the level.`}
              {" "}Levels come from the last completed {
                PIVOT_ANCHOR_OPTIONS.find((a) => a.id === f.anchor)?.label.toLowerCase()
                  ?? f.anchor
              } period, so they do not move during it.
            </p>
          )}
        </div>
      ))}

      {value.length < MAX_ALERT_FILTERS && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-faint">Add filter</span>
          {(["rsi", "rsi_ma", "ma", "macd", "supertrend", "pivot"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => add(kind)}
              className="rounded-md border border-border px-2 py-1 text-xs text-ink-muted hover:border-accent hover:text-ink"
            >
              + {KIND_LABEL[kind]}
            </button>
          ))}
        </div>
      )}

      {value.length > 0 && (
        <p className="rounded-md border border-border bg-surface-2/50 px-3 py-2 text-xs text-ink-muted">
          Every filter must hold on the same bar. A filter on the chart
          timeframe is read from the bar being judged; one on another timeframe
          is read from that timeframe&apos;s last <span className="text-ink">closed</span> bar,
          so a 1h filter on a 15m alert can be up to an hour old and never
          changes once that hour has ended. While a filter is not met the alert
          stays silent — it does not queue up and fire later, and a filter whose
          indicator has not warmed up counts as not met.
        </p>
      )}
    </>
  );
}

/** An alert with no gates, for a freshly opened dialog. */
export const emptyFilters = (): AlertFilter[] => [];
