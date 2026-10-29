"use client";
import { useEffect, useState } from "react";
import { Dropdown, FIELD, PlusGlyph } from "@/components/ui";
import {
  FILTER_KINDS, FILTER_TIMEFRAMES, MAX_ALERT_FILTERS, defaultGate,
  type AlertGate, type FilterKind, type FilterSide, type FilterTimeframe,
  type MaType, type MacdTarget,
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
 * ── Why this is a list ────────────────────────────────────────────────────
 *
 * It used to be three checkboxes — one RSI, one moving average, one Supertrend,
 * all on the alert's own timeframe. That shape cannot express two gates of the
 * same kind, so "the 1h RSI above its EMA 14 and the 4h RSI above its EMA 21"
 * had nowhere to go. Gates are now rows the user adds, up to
 * `MAX_ALERT_FILTERS`, each free to name its own timeframe.
 *
 * Every alert starts with NO gates. An alert that quietly requires a trend the
 * user did not ask for is worse than one that fires too often: the first looks
 * broken, the second looks noisy, and only the second is obvious.
 */
export type AlertFilterState = AlertGate[];

export const emptyFilters = (): AlertFilterState => [];

/** How each kind names itself in the picker. */
const KIND_LABEL: Record<FilterKind, string> = {
  rsi: "RSI vs level",
  rsi_ma: "RSI vs its own EMA / SMA",
  ma: "Price vs moving average",
  supertrend: "Price vs Supertrend",
  macd: "MACD",
  sr_touch: "Recent S/R touch",
};

/**
 * The gates a persisted alert already carries — defined beside the editor
 * form in `lib/alertEditing`, which is built from it, and re-exported here so
 * every dialog keeps importing its gate helpers from one place.
 */
export { filtersFromAlert } from "@/lib/alertEditing";

/**
 * The request field for the gates, at CREATION.
 *
 * An empty list is omitted rather than sent: an absent key means "no gate",
 * which is exactly what every alert armed before gates existed has, and
 * keeping the payload identical to the pre-gate one means a create request is
 * not quietly reshaped by a feature the user did not use.
 */
export function filterRequest(gates: AlertFilterState): Record<string, unknown> {
  return gates.length > 0 ? { filters: gates } : {};
}

/**
 * The same field for a PATCH, where the empty list is spelled out.
 *
 * The edit path merges the request over the row's own values, so an omitted
 * list keeps whatever gates the row already had. Removing the last one
 * therefore needs an explicit `[]` — omitting it would silently leave the
 * gates in place while the dialog showed none.
 *
 * The server REPLACES the list rather than merging it, because "add this to
 * whatever each alert already has" cannot be shown honestly for a selection
 * whose alerts carry different gates.
 */
export function filterRequestForEdit(gates: AlertFilterState): Record<string, unknown> {
  return { filters: gates };
}

const BOX = FIELD;

/**
 * Every control in a gate row is named for the row it belongs to.
 *
 * Two gates of the same kind are the whole reason this is a list, so "Gate RSI
 * side" was a name two controls in one dialog could share. That is an
 * accessible-name collision on its own, and once these are `Dropdown`s it is
 * also a popover-registry collision — `Dropdown` keys its exclusivity on the
 * accessible name unless told otherwise, so opening the second gate's side
 * picker would close the first's by appearing to BE it.
 */
const gateName = (index: number, control: string): string => `Gate ${index + 1} ${control}`;

const SAME_TIMEFRAME = "";

/** A gate row's timeframe picker. Empty value means the alert's own. */
function TimeframeSelect({
  gate, index, onChange,
}: {
  gate: AlertGate;
  index: number;
  onChange: (tf: FilterTimeframe | undefined) => void;
}) {
  return (
    <Dropdown
      value={gate.timeframe ?? SAME_TIMEFRAME}
      label={gateName(index, "timeframe")}
      width={92}
      options={[
        { value: SAME_TIMEFRAME, label: "same TF" },
        ...FILTER_TIMEFRAMES.map((tf) => ({ value: tf, label: tf })),
      ]}
      onChange={(next) => onChange((next || undefined) as FilterTimeframe | undefined)}
    />
  );
}

function SideSelect({
  value, onChange, label, words, width = 150,
}: {
  value: FilterSide;
  onChange: (side: FilterSide) => void;
  label: string;
  words?: readonly [string, string];
  width?: number;
}) {
  const [above, below] = words ?? ["is above", "is below"];
  return (
    <Dropdown
      value={value}
      label={label}
      width={width}
      options={[
        { value: "above", label: above },
        { value: "below", label: below },
      ]}
      onChange={(next) => onChange(next as FilterSide)}
    />
  );
}

const Num = ({
  value, onChange, label, width = 70, min = "1", max = "1000", step,
}: {
  value: number; onChange: (n: number) => void; label: string;
  width?: number; min?: string; max?: string; step?: string;
}) => (
  <input
    type="number" min={min} max={max} step={step} value={value} aria-label={label}
    onChange={(e) => onChange(step ? parseFloat(e.target.value || "0") : parseInt(e.target.value || "0", 10))}
    className={`${BOX}`} style={{ width }}
  />
);

/** The two moving-average shapes a gate can measure against. */
const MA_TYPE_OPTIONS = [
  { value: "ema", label: "EMA" },
  { value: "sma", label: "SMA" },
] as const;

/** The fields a single gate needs, after its kind and timeframe. */
function GateFields({
  gate, index, onChange,
}: {
  gate: AlertGate;
  index: number;
  onChange: (next: AlertGate) => void;
}) {
  const name = (control: string): string => gateName(index, control);
  switch (gate.kind) {
    case "rsi":
      return (
        <>
          <span className="text-sm text-ink-muted">RSI</span>
          <Num value={gate.length} label={name("RSI length")}
            onChange={(length) => onChange({ ...gate, length })} />
          <SideSelect value={gate.side} label={name("RSI side")}
            onChange={(side) => onChange({ ...gate, side })} />
          <Num value={gate.level} label={name("RSI level")} min="1" max="99" step="0.1"
            onChange={(level) => onChange({ ...gate, level })} />
        </>
      );
    case "rsi_ma":
      return (
        <>
          <span className="text-sm text-ink-muted">RSI</span>
          <Num value={gate.length} label={name("RSI length")}
            onChange={(length) => onChange({ ...gate, length })} />
          <SideSelect value={gate.side} label={name("RSI-MA side")}
            words={["is above its", "is below its"]}
            onChange={(side) => onChange({ ...gate, side })} />
          <Dropdown
            value={gate.maType} label={name("RSI MA type")} width={76}
            options={MA_TYPE_OPTIONS}
            onChange={(next) => onChange({ ...gate, maType: next as MaType })}
          />
          <Num value={gate.maLength} label={name("RSI MA length")}
            onChange={(maLength) => onChange({ ...gate, maLength })} />
        </>
      );
    case "ma":
      return (
        <>
          <span className="text-sm text-ink-muted">Price</span>
          <SideSelect value={gate.side} label={name("MA side")}
            onChange={(side) => onChange({ ...gate, side })} />
          <Dropdown
            value={gate.type} label={name("MA type")} width={76}
            options={MA_TYPE_OPTIONS}
            onChange={(next) => onChange({ ...gate, type: next as MaType })}
          />
          <Num value={gate.length} label={name("MA length")} width={80}
            onChange={(length) => onChange({ ...gate, length })} />
        </>
      );
    case "supertrend":
      return (
        <>
          <span className="text-sm text-ink-muted">Price</span>
          <SideSelect value={gate.side} label={name("Supertrend side")}
            onChange={(side) => onChange({ ...gate, side })} />
          <span className="whitespace-nowrap text-sm text-ink-muted">Supertrend</span>
          <Num value={gate.period} label={name("Supertrend ATR period")} width={62}
            onChange={(period) => onChange({ ...gate, period })} />
          <Num value={gate.multiplier} label={name("Supertrend multiplier")} width={62}
            min="0.1" max="100" step="0.1"
            onChange={(multiplier) => onChange({ ...gate, multiplier })} />
        </>
      );
    case "macd":
      return (
        <>
          <span className="text-sm text-ink-muted">MACD</span>
          <Num value={gate.fastLength} label={name("MACD fast length")} width={58}
            onChange={(fastLength) => onChange({ ...gate, fastLength })} />
          <Num value={gate.slowLength} label={name("MACD slow length")} width={58}
            onChange={(slowLength) => onChange({ ...gate, slowLength })} />
          <Num value={gate.signalLength} label={name("MACD signal length")} width={58}
            onChange={(signalLength) => onChange({ ...gate, signalLength })} />
          <Dropdown
            value={gate.target} label={name("MACD target")} width={92}
            options={[
              { value: "signal", label: "vs signal" },
              { value: "zero", label: "vs zero" },
            ]}
            onChange={(next) => onChange({ ...gate, target: next as MacdTarget })}
          />
          {/*
            * Against the SIGNAL the sides are named for the mood they describe,
            * because "MACD is above signal line" is the same rule wearing a
            * name nobody recognises. Against ZERO they stay above/below: there
            * the mood words would be wrong, since the centreline says which way
            * the trend leans rather than whether momentum turned.
            */}
          <SideSelect
            value={gate.side} label={name("MACD side")}
            words={gate.target === "signal"
              ? ["is bullish (above signal)", "is bearish (below signal)"]
              : ["is above zero", "is below zero"]}
            onChange={(side) => onChange({ ...gate, side })}
          />
        </>
      );
    case "sr_touch":
      return (
        <>
          <SideSelect
            value={gate.side} label={name("S/R touch side")}
            words={["support bounce", "resistance rejection"]} width={176}
            onChange={(side) => onChange({ ...gate, side })}
          />
          <span className="basis-full" aria-hidden="true" />
          <span className="whitespace-nowrap text-sm text-ink-muted">in last</span>
          <Num value={gate.lookback} label={name("S/R touch lookback bars")} width={58}
            max="500" onChange={(lookback) => onChange({ ...gate, lookback })} />
          <span className="whitespace-nowrap text-sm text-ink-muted">bars · within</span>
          <Num value={gate.tolerancePct} label={name("S/R touch tolerance percent")} width={62}
            min="0" max="10" step="0.05"
            onChange={(tolerancePct) => onChange({ ...gate, tolerancePct })} />
          <span className="text-sm text-ink-muted">% of the level</span>
          <span className="basis-full" aria-hidden="true" />
          {/*
            * The Flux Charts indicator's own General and Breaks settings, so the
            * levels this gate reads are the zones the chart draws with them.
            */}
          <span className="whitespace-nowrap text-sm text-ink-muted">Flux S/R: pivot</span>
          <Num value={gate.pivotLength} label={name("Flux pivot length")} width={58}
            min="3" max="50" onChange={(pivotLength) => onChange({ ...gate, pivotLength })} />
          <span className="text-sm text-ink-muted">strength</span>
          <Dropdown
            value={String(gate.strength)} label={name("Flux strength")} width={58}
            options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }]}
            onChange={(next) => onChange({ ...gate, strength: Number(next) })}
          />
          <span className="whitespace-nowrap text-sm text-ink-muted">break on</span>
          <Dropdown
            value={gate.invalidation} label={name("Flux invalidation")} width={84}
            options={[
              { value: "close", label: "Close" },
              { value: "wick", label: "Wick" },
            ]}
            onChange={(next) => onChange({ ...gate, invalidation: next as "close" | "wick" })}
          />
          <span className="basis-full" aria-hidden="true" />
          <label className="flex items-center gap-1.5 whitespace-nowrap text-sm text-ink-muted">
            <input type="checkbox" checked={gate.avoidFalseBreaks} aria-label={name("Flux avoid false breaks")}
              onChange={(e) => onChange({ ...gate, avoidFalseBreaks: e.target.checked })} />
            Avoid false breaks
          </label>
          <Num value={gate.breakVolumeThreshold} label={name("Flux break volume threshold")} width={62}
            min="0.1" max="2" step="0.1"
            onChange={(breakVolumeThreshold) => onChange({ ...gate, breakVolumeThreshold })} />
          <label className="flex items-center gap-1.5 whitespace-nowrap text-sm text-ink-muted">
            <input type="checkbox" checked={gate.inverseBroken} aria-label={name("Flux inverse after broken")}
              onChange={(e) => onChange({ ...gate, inverseBroken: e.target.checked })} />
            Broken level flips
          </label>
        </>
      );
  }
}

export function AlertFiltersField({
  value, onChange,
}: {
  value: AlertFilterState;
  onChange: (next: AlertFilterState) => void;
}) {
  const any = value.length > 0;
  const full = value.length >= MAX_ALERT_FILTERS;

  /*
   * The gates are optional and off by default, so they open only when asked
   * for. Every dialog used to show all three gate rows at once, which doubled
   * the control count of a price alert that needs a price and nothing else. A
   * dialog editing an alert that already carries a gate opens expanded, so
   * nothing an alert does is ever hidden from the person editing it.
   */
  const [expanded, setExpanded] = useState(any);
  useEffect(() => { if (any) setExpanded(true); }, [any]);

  const replace = (i: number, gate: AlertGate): void =>
    onChange(value.map((g, n) => (n === i ? gate : g)));
  const remove = (i: number): void => onChange(value.filter((_, n) => n !== i));
  const add = (): void => onChange([...value, defaultGate("rsi")]);

  /**
   * Changing a gate's KIND starts it from that kind's defaults rather than
   * carrying the old fields across. The two share almost no fields, and a
   * half-carried rule would look configured while meaning something the user
   * never chose. Only the timeframe survives, because that is the one choice
   * the kinds genuinely share.
   */
  const changeKind = (i: number, kind: FilterKind): void => {
    const timeframe = value[i]?.timeframe;
    const fresh = defaultGate(kind);
    replace(i, timeframe ? { ...fresh, timeframe } : fresh);
  };

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-expanded={false}
        className="flex items-center gap-1.5 text-left text-sm text-ink-muted hover:text-ink"
      >
        <PlusGlyph />
        Add a condition (optional) — only fire when RSI, a moving average,
        Supertrend, MACD or a recent S/R touch agrees
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

      {value.map((gate, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Dropdown
            value={gate.kind}
            label={gateName(i, "kind")}
            width={172}
            options={FILTER_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
            onChange={(next) => changeKind(i, next as FilterKind)}
          />
          <TimeframeSelect
            gate={gate}
            index={i}
            onChange={(timeframe) => {
              const next = { ...gate };
              if (timeframe) next.timeframe = timeframe;
              else delete next.timeframe;
              replace(i, next);
            }}
          />
          <GateFields gate={gate} index={i} onChange={(next) => replace(i, next)} />
          <button
            type="button"
            onClick={() => remove(i)}
            aria-label={`Remove gate ${i + 1}`}
            className="ml-auto rounded px-1.5 text-ink-faint hover:text-ink"
          >
            ×
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={add}
        disabled={full}
        className="flex items-center gap-1.5 text-left text-sm text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
      >
        <PlusGlyph />
        {full ? `At the limit of ${MAX_ALERT_FILTERS} conditions` : "Add condition"}
      </button>

      {any && (
        <p className="rounded-md border border-border bg-surface-2/50 px-3 py-2 text-xs text-ink-muted">
          A condition set to <span className="text-ink">same TF</span> is measured
          on the alert&apos;s own timeframe, on the same bar; one naming a
          timeframe is measured there. While a condition is not met the alert
          stays silent — it does not queue up and fire later. A condition whose
          indicator has not warmed up, or whose timeframe cannot be read, counts
          as not met. A recent S/R touch uses the Flux Charts Support &amp;
          Resistance levels: in the last N bars a candle retested a live support
          (its wick reached the level, or came within the % you allow, and it
          closed back above — the chart&apos;s &quot;R&quot;), the support is
          still unbroken, and price is above it. Resistance is the mirror image.
        </p>
      )}
    </>
  );
}
