"use client";
import { useState } from "react";
import { PARAM_GROUPS, Field } from "@/lib/paramSchema";
import type { StrategyParams } from "@/lib/types";

/** Renders the grouped ma_rr_v9 param form; controlled via value/onChange. */
export function ParamForm({
  value, onChange,
}: {
  value: StrategyParams;
  onChange: (next: StrategyParams) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({ General: true, "MA trend (MTF)": true, "R:R — swing-low stop + ratio TP": true });

  const set = (key: string, v: number | string | boolean) => onChange({ ...value, [key]: v });
  const visible = (f: Field) => !f.showIf || value[f.showIf] === true;

  return (
    <div className="space-y-2">
      {PARAM_GROUPS.map((g) => {
        const isOpen = open[g.title] ?? false;
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
