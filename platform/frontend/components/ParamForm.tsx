"use client";
import { useState } from "react";
import { groupsFor, Field } from "@/lib/paramSchema";
import type { StrategyParams } from "@/lib/types";

/**
 * The grouped parameter form for ONE strategy.
 *
 * It used to render `PARAM_GROUPS` — `ma_rr_v9`'s schema — whatever strategy it
 * was given, which the original docstring said outright ("the grouped ma_rr_v9
 * param form") because at the time there was only one. When a second and third
 * strategy arrived, the form did not follow.
 *
 * That is worse than showing the wrong labels. The caller seeds its draft from
 * the same wrong schema, so picking `mtf_lean` and touching nothing sent 49
 * `ma_rr_v9` keys, ELEVEN of which are real `mtf_lean` inputs carrying
 * `ma_rr_v9`'s values — `rrRatio` 3.75 -> 2, both take-profits, the trailing
 * stop, the minimum stop distance. The heading said "defaults apply unless
 * changed" while eleven defaults had already changed, and a stress run (which
 * sends no params, so it gets the engine's real defaults) was quietly not
 * comparable with a Quick backtest of the same strategy over the same window.
 *
 * `groupsFor` has been the right answer since the second strategy was
 * registered; `StrategySettingsModal` already called it to decide whether to
 * show this form at all, then rendered a form that ignored the answer.
 */
export function ParamForm({
  strategyKey, value, onChange,
}: {
  /** Which strategy's schema to render. */
  strategyKey: string;
  value: StrategyParams;
  onChange: (next: StrategyParams) => void;
}) {
  const groups = groupsFor(strategyKey) ?? [];
  // The first two groups open, whatever they are called. The previous literal
  // titles were `ma_rr_v9`'s, so every other strategy opened fully collapsed.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpenFor = (title: string, index: number): boolean => open[title] ?? index < 2;

  const set = (key: string, v: number | string | boolean) => onChange({ ...value, [key]: v });
  const visible = (f: Field) => !f.showIf || value[f.showIf] === true;

  return (
    <div className="space-y-2">
      {groups.map((g, index) => {
        const isOpen = isOpenFor(g.title, index);
        return (
          <div key={g.title} className="rounded-md border border-border bg-surface">
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [g.title]: !isOpen }))}
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-ink"
            >
              <span>{g.title}</span>
              <span className="text-ink-faint">{isOpen ? "−" : "+"}</span>
            </button>
            {isOpen && (
              <div className="grid grid-cols-1 gap-3 border-t border-border px-3 py-3 sm:grid-cols-2">
                {g.fields.filter(visible).map((f) => (
                  <FieldInput key={f.key} field={f} value={value[f.key]} onChange={(v) => set(f.key, v)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FieldInput({
  field, value, onChange,
}: {
  field: Field;
  value: number | string | boolean | undefined;
  onChange: (v: number | string | boolean) => void;
}) {
  if (field.type === "bool") {
    return (
      // The box stays 16px so the form still reads as a form; the label
      // carries a 32px hit area, which is where a user aims anyway and is what
      // makes this reachable with a thumb.
      <label className="flex min-h-[32px] cursor-pointer items-center gap-2 py-1 text-sm">
        <input
          type="checkbox"
          checked={Boolean(value ?? field.default)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-border bg-surface-2 accent-accent"
        />
        <span className="text-ink">{field.label}</span>
      </label>
    );
  }
  if (field.type === "select" || field.type === "timeframe") {
    return (
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-muted">{field.label}</span>
        <select
          value={String(value ?? field.default)}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
        >
          {field.options?.map((o) => <option key={o} value={o}>{field.type === "timeframe" ? tfLabel(o) : o}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-ink-muted">{field.label}</span>
      <input
        type="number"
        value={Number(value ?? field.default)}
        min={field.min}
        max={field.max}
        step={field.step ?? (field.type === "int" ? 1 : 0.1)}
        onChange={(e) => onChange(field.type === "int" ? parseInt(e.target.value || "0", 10) : parseFloat(e.target.value || "0"))}
        className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
      />
    </label>
  );
}

function tfLabel(tf: string): string {
  const map: Record<string, string> = {
    "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m",
    "60": "1h", "120": "2h", "240": "4h", "360": "6h", "720": "12h", "D": "1d",
  };
  return map[tf] ?? tf;
}
