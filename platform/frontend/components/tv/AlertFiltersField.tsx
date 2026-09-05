"use client";
import { useEffect, useState } from "react";
import {
  FILTER_DEFAULTS,
  type FilterSide, type MaAlert, type MaType, type StAtrMethod,
} from "@/lib/api";

/**
 * The "only fire when" gates, shared by every alert dialog.
 *
 * One component rather than a copy per dialog, because a gate is a promise
 * about when an alert stays SILENT — and five dialogs each describing that
 * promise slightly differently is how a user ends up believing an alert is
 * gated on something it is not. It also means a gate added on the server
 * appears in every dialog at once instead of in whichever ones were remembered.
 *
 * Every gate is off by default. An alert that quietly requires a trend the user
 * did not ask for is worse than one that fires too often: the first looks
 * broken, the second looks noisy, and only the second is obvious.
 */
export interface AlertFilterState {
  rsi: boolean;
  rsiLength: number;
  rsiLevel: number;
  rsiSide: FilterSide;
  ma: boolean;
  maType: MaType;
  maLength: number;
  maSide: FilterSide;
  st: boolean;
  stPeriod: number;
  stMultiplier: number;
  stAtrMethod: StAtrMethod;
  stSide: FilterSide;
}

export const emptyFilters = (): AlertFilterState => ({
  rsi: false,
  rsiLength: FILTER_DEFAULTS.rsi.length,
  rsiLevel: FILTER_DEFAULTS.rsi.level,
  rsiSide: FILTER_DEFAULTS.rsi.side,
  ma: false,
  maType: FILTER_DEFAULTS.ma.type,
  maLength: FILTER_DEFAULTS.ma.length,
  maSide: FILTER_DEFAULTS.ma.side,
  st: false,
  stPeriod: FILTER_DEFAULTS.supertrend.period,
  stMultiplier: FILTER_DEFAULTS.supertrend.multiplier,
  stAtrMethod: FILTER_DEFAULTS.supertrend.atrMethod,
  stSide: FILTER_DEFAULTS.supertrend.side,
});

/**
 * The gates a persisted alert already carries.
 *
 * A gate counts as configured only when its whole rule is present, matching the
 * server's own reconstruction: a length with no side is not half a gate, it is
 * no gate, and showing it as enabled would misreport what the alert does.
 */
export function filtersFromAlert(a: MaAlert): AlertFilterState {
  const f = emptyFilters();
  if (a.filterRsiLength !== null && a.filterRsiSide !== null) {
    f.rsi = true;
    f.rsiLength = a.filterRsiLength;
    f.rsiLevel = a.filterRsiLevel ?? f.rsiLevel;
    f.rsiSide = a.filterRsiSide as FilterSide;
  }
  if (a.filterMaType !== null && a.filterMaLength !== null && a.filterMaSide !== null) {
    f.ma = true;
    f.maType = a.filterMaType;
    f.maLength = a.filterMaLength;
    f.maSide = a.filterMaSide as FilterSide;
  }
  if (a.filterStPeriod !== null && a.filterStSide !== null) {
    f.st = true;
    f.stPeriod = a.filterStPeriod;
    f.stMultiplier = a.filterStMultiplier ?? f.stMultiplier;
    f.stAtrMethod = (a.filterStAtrMethod as StAtrMethod | null) ?? f.stAtrMethod;
    f.stSide = a.filterStSide as FilterSide;
  }
  return f;
}

/**
 * The request fields for the enabled gates only.
 *
 * A gate the user switched off is OMITTED at creation — an absent key means
 * "no gate", which is what every alert armed before gates existed has. On an
 * edit the caller must send the explicit `false` instead, which is what tells
 * the server to remove a gate the row still carries; `filterRequestForEdit`
 * exists for exactly that difference.
 */
export function filterRequest(f: AlertFilterState): Record<string, unknown> {
  return {
    ...(f.rsi
      ? {
          filterRsi: true,
          filterRsiLength: f.rsiLength,
          filterRsiLevel: f.rsiLevel,
          filterRsiSide: f.rsiSide,
        }
      : {}),
    ...(f.ma
      ? {
          filterMa: true,
          filterMaType: f.maType,
          filterMaLength: f.maLength,
          filterMaSide: f.maSide,
        }
      : {}),
    ...(f.st
      ? {
          filterSt: true,
          filterStPeriod: f.stPeriod,
          filterStMultiplier: f.stMultiplier,
          filterStAtrMethod: f.stAtrMethod,
          filterStSide: f.stSide,
        }
      : {}),
  };
}

/**
 * The same fields for a PATCH, with the off switches spelled out.
 *
 * The edit path merges the request over the row's own values, so an omitted
 * gate keeps whatever the row already had. Removing one therefore needs an
 * explicit `false` — omitting it would silently leave the gate in place while
 * the dialog showed it unchecked.
 */
export function filterRequestForEdit(f: AlertFilterState): Record<string, unknown> {
  return {
    filterRsi: f.rsi,
    filterMa: f.ma,
    filterSt: f.st,
    ...filterRequest(f),
  };
}

const BOX =
  "rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm text-ink outline-none focus:border-accent";

export function AlertFiltersField({
  value, onChange,
}: {
  value: AlertFilterState;
  onChange: (next: AlertFilterState) => void;
}) {
  const set = (patch: Partial<AlertFilterState>): void => onChange({ ...value, ...patch });
  const any = value.rsi || value.ma || value.st;
  /*
   * The gates are optional and off by default, so they open only when asked
   * for. Every dialog used to show all three gate rows (and the Supertrend
   * method, period and multiplier behind a tick) at once, which doubled the
   * control count of a price alert that needs a price and nothing else. A
   * dialog editing an alert that already carries a gate opens expanded, so
   * nothing an alert does is ever hidden from the person editing it.
   */
  const [expanded, setExpanded] = useState(any);
  useEffect(() => { if (any) setExpanded(true); }, [any]);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-expanded={false}
        className="flex items-center gap-1.5 text-left text-sm text-ink-muted hover:text-ink"
      >
        <span aria-hidden="true">＋</span>
        Add a condition (optional) — only fire when RSI, a moving average or Supertrend agrees
      </button>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-ink-muted">Only fire when</div>
        {!any && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-expanded={true}
            className="text-[11px] text-ink-faint hover:text-ink"
          >
            Hide conditions
          </button>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={value.rsi}
          onChange={(e) => set({ rsi: e.target.checked })} className="accent-accent" />
        RSI filter
      </label>
      {value.rsi && (
        <div className="flex items-center gap-2 pl-6">
          <span className="text-sm text-ink-muted">RSI</span>
          <input type="number" min="1" max="1000" value={value.rsiLength} aria-label="Filter RSI length"
            onChange={(e) => set({ rsiLength: parseInt(e.target.value || "0", 10) })}
            className={`${BOX} w-[70px]`} />
          <select value={value.rsiSide} aria-label="Filter RSI side"
            onChange={(e) => set({ rsiSide: e.target.value as FilterSide })}
            className={`${BOX} w-[90px]`}>
            <option value="above">is above</option>
            <option value="below">is below</option>
          </select>
          <input type="number" min="1" max="99" value={value.rsiLevel} aria-label="Filter RSI level"
            onChange={(e) => set({ rsiLevel: parseFloat(e.target.value || "0") })}
            className={`${BOX} w-[70px]`} />
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={value.ma}
          onChange={(e) => set({ ma: e.target.checked })} className="accent-accent" />
        Moving-average filter
      </label>
      {value.ma && (
        <div className="flex items-center gap-2 pl-6">
          <span className="text-sm text-ink-muted">Price</span>
          <select value={value.maSide} aria-label="Filter MA side"
            onChange={(e) => set({ maSide: e.target.value as FilterSide })}
            className={`${BOX} w-[90px]`}>
            <option value="above">is above</option>
            <option value="below">is below</option>
          </select>
          <select value={value.maType} aria-label="Filter MA type"
            onChange={(e) => set({ maType: e.target.value as MaType })}
            className={`${BOX} w-[80px]`}>
            <option value="ema">EMA</option>
            <option value="sma">SMA</option>
          </select>
          <input type="number" min="1" max="1000" value={value.maLength} aria-label="Filter MA length"
            onChange={(e) => set({ maLength: parseInt(e.target.value || "0", 10) })}
            className={`${BOX} w-[80px]`} />
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={value.st}
          onChange={(e) => set({ st: e.target.checked })} className="accent-accent" />
        Supertrend filter
      </label>
      {value.st && (
        <>
          <div className="flex items-center gap-2 pl-6">
            <span className="text-sm text-ink-muted">Price</span>
            <select value={value.stSide} aria-label="Filter Supertrend side"
              onChange={(e) => set({ stSide: e.target.value as FilterSide })}
              className={`${BOX} w-[100px]`}>
              <option value="above">is above</option>
              <option value="below">is below</option>
            </select>
            <span className="whitespace-nowrap text-sm text-ink-muted">Supertrend</span>
            <input type="number" min="1" max="1000" value={value.stPeriod} aria-label="Filter Supertrend ATR period"
              onChange={(e) => set({ stPeriod: parseInt(e.target.value || "0", 10) })}
              className={`${BOX} w-[64px]`} />
            <input type="number" min="0.1" max="100" step="0.1" value={value.stMultiplier}
              aria-label="Filter Supertrend multiplier"
              onChange={(e) => set({ stMultiplier: parseFloat(e.target.value || "0") })}
              className={`${BOX} w-[64px]`} />
          </div>
          <p className="pl-6 text-xs text-ink-faint">
            ATR period · multiplier. Above the Supertrend is its uptrend, below
            is its downtrend — the same green and red the study paints.
          </p>
        </>
      )}

      {any && (
        <p className="rounded-md border border-border bg-surface-2/50 px-3 py-2 text-xs text-ink-muted">
          Measured on the alert&apos;s own timeframe, on the same bar. While a
          filter is not met the alert stays silent — it does not queue up and
          fire later. A filter whose indicator has not warmed up yet counts as
          not met.
        </p>
      )}
    </>
  );
}
