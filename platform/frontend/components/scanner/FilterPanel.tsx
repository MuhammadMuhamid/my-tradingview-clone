"use client";

import { CATEGORY_OPTIONS, type ColumnSpec } from "@/lib/scanner/columns";

export interface NumericFilter { min: string; max: string }
export type Filters = {
  numeric: Record<string, NumericFilter>;
  categorical: Record<string, string[]>;
};

export const EMPTY_FILTERS: Filters = { numeric: {}, categorical: {} };

const NUMERIC_KINDS = new Set(["number", "signed", "int", "price"]);

/** Filters compose with AND, per §7. A row must satisfy every active clause. */
export function applyFilters<T>(
  rows: T[],
  specs: ColumnSpec[],
  filters: Filters,
  value: (spec: ColumnSpec, row: T) => unknown,
): T[] {
  const byId = new Map(specs.map((s) => [s.id, s]));

  return rows.filter((row) => {
    for (const [id, range] of Object.entries(filters.numeric)) {
      const spec = byId.get(id);
      if (!spec) continue;
      const v = value(spec, row);
      const min = range.min === "" ? null : Number(range.min);
      const max = range.max === "" ? null : Number(range.max);
      if (min === null && max === null) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) return false;
      if (min !== null && !Number.isNaN(min) && v < min) return false;
      if (max !== null && !Number.isNaN(max) && v > max) return false;
    }
    for (const [id, allowed] of Object.entries(filters.categorical)) {
      if (allowed.length === 0) continue;
      const spec = byId.get(id);
      if (!spec) continue;
      if (!allowed.includes(String(value(spec, row)))) return false;
    }
    return true;
  });
}

export function countActive(filters: Filters): number {
  const numeric = Object.values(filters.numeric).filter(
    (r) => r.min !== "" || r.max !== "",
  ).length;
  const categorical = Object.values(filters.categorical).filter((v) => v.length > 0).length;
  return numeric + categorical;
}

interface Props {
  specs: ColumnSpec[];
  filters: Filters;
  onChange: (next: Filters) => void;
  onClose: () => void;
}

export function FilterPanel({ specs, filters, onChange, onClose }: Props) {
  const numeric = specs.filter((s) => NUMERIC_KINDS.has(s.kind) && s.id !== "symbol");
  const categorical = specs.filter((s) => s.kind === "category" || s.kind === "bool");

  const setNumeric = (id: string, part: Partial<NumericFilter>) => {
    const current = filters.numeric[id] ?? { min: "", max: "" };
    onChange({
      ...filters,
      numeric: { ...filters.numeric, [id]: { ...current, ...part } },
    });
  };

  const toggleCategory = (id: string, option: string) => {
    const current = filters.categorical[id] ?? [];
    const next = current.includes(option)
      ? current.filter((o) => o !== option)
      : [...current, option];
    onChange({ ...filters, categorical: { ...filters.categorical, [id]: next } });
  };

  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 text-xs">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold uppercase tracking-wide">Filters</h2>
        <div className="flex gap-2">
          <button
            className="rounded border border-[var(--color-line)] px-2 py-0.5 hover:bg-[var(--color-surface-3)]"
            onClick={() => onChange(EMPTY_FILTERS)}
          >
            Clear
          </button>
          <button
            className="rounded border border-[var(--color-line)] px-2 py-0.5 hover:bg-[var(--color-surface-3)]"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>

      <p className="mb-3 text-[10px] leading-tight text-[var(--color-ink-dim)]">
        Clauses combine with AND. A row must satisfy every one. Rows whose value is missing
        are excluded by an active numeric range.
      </p>

      <section className="mb-4">
        <h3 className="mb-1 font-semibold text-[var(--color-ink-dim)]">Categorical</h3>
        {categorical.map((spec) => {
          const options = CATEGORY_OPTIONS[spec.id] ?? ["true", "false"];
          const active = filters.categorical[spec.id] ?? [];
          return (
            <div key={spec.id} className="mb-2">
              <div className="mb-0.5 text-[var(--color-ink-dim)]">
                {spec.group} · {spec.header}
              </div>
              <div className="flex flex-wrap gap-1">
                {options.map((o) => (
                  <button
                    key={o}
                    onClick={() => toggleCategory(spec.id, o)}
                    className={`rounded border px-1.5 py-0.5 ${
                      active.includes(o)
                        ? "border-[var(--color-pos)] bg-[rgba(13,148,136,0.25)]"
                        : "border-[var(--color-line)] hover:bg-[var(--color-surface-3)]"
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <section>
        <h3 className="mb-1 font-semibold text-[var(--color-ink-dim)]">Numeric ranges</h3>
        {numeric.map((spec) => {
          const range = filters.numeric[spec.id] ?? { min: "", max: "" };
          return (
            <div key={spec.id} className="mb-1.5 flex items-center gap-1">
              <span
                className="w-32 shrink-0 truncate text-[var(--color-ink-dim)]"
                title={`${spec.group} · ${spec.header}`}
              >
                {spec.group} · {spec.header}
              </span>
              <input
                aria-label={`${spec.id} min`}
                value={range.min}
                onChange={(e) => setNumeric(spec.id, { min: e.target.value })}
                placeholder="min"
                inputMode="decimal"
                className="w-14 rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-1 py-0.5"
              />
              <input
                aria-label={`${spec.id} max`}
                value={range.max}
                onChange={(e) => setNumeric(spec.id, { max: e.target.value })}
                placeholder="max"
                inputMode="decimal"
                className="w-14 rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-1 py-0.5"
              />
            </div>
          );
        })}
      </section>
    </aside>
  );
}

