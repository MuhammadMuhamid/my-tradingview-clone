"use client";

import { useCallback, useEffect, useState } from "react";

import { EMPTY_FILTERS, FilterPanel, countActive, type Filters } from "@/components/FilterPanel";
import { ScreenerTable } from "@/components/ScreenerTable";
import { COLUMNS } from "@/lib/columns";
import { api } from "@/lib/api";
import { fmtAge } from "@/lib/format";
import { TIMEFRAMES } from "@/lib/types";
import type { IndicatorKey, Snapshot } from "@/lib/types";

export default function Page() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [showExtras, setShowExtras] = useState(false);
  const [presets, setPresets] = useState<string[]>([]);
  const [newSymbol, setNewSymbol] = useState("");

  const load = useCallback(async () => {
    try {
      setSnapshot(await api.screener());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadPresets = useCallback(async () => {
    try {
      setPresets(Object.keys((await api.presets()).presets));
    } catch {
      /* presets are optional */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadPresets();
    // The backend refreshes on its own schedule; this only re-reads the cache.
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load, loadPresets]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onTimeframeChange = (indicator: IndicatorKey, timeframe: string) =>
    run(() => api.patchConfig({ indicators: { [indicator]: { timeframe } } }));

  /**
   * The three strategy slots drive most of the table now, so they are set once
   * here rather than per column group — a per-group selector cannot express
   * "1h and 15m and 5m at the same time", which is the point of the layout.
   */
  const onSlotChange = (slot: string, timeframe: string) =>
    run(() => api.patchConfig({ strategy: { timeframes: { [slot]: timeframe } } }));

  const toggleGroup = (group: string) =>
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      next.has(group) ? next.delete(group) : next.add(group);
      return next;
    });

  return (
    <main className="flex h-screen flex-col">
      <header className="border-b border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <h1 className="text-sm font-semibold">Crypto Screener</h1>

          <span className="text-[var(--color-ink-dim)]">
            {snapshot ? `${snapshot.exchange} · ${snapshot.rows.length} symbols` : "loading…"}
          </span>
          <span className="text-[var(--color-ink-dim)]">
            refreshed {fmtAge(snapshot?.last_refresh_at ?? null)}
          </span>

          <button
            disabled={busy}
            onClick={() => run(() => api.refresh(false))}
            className="rounded border border-[var(--color-line)] px-2 py-0.5 hover:bg-[var(--color-surface-3)] disabled:opacity-50"
            title="Fetch any series whose bar has closed since the last refresh"
          >
            Refresh
          </button>

          {snapshot?.strategy?.enabled && (
            <span className="flex items-center gap-1" title="The three timeframes every MTF column reads from">
              <span className="text-[var(--color-ink-dim)]">TFs</span>
              {(["1h", "15m", "5m"] as const).map((slot) => (
                <select
                  key={slot}
                  aria-label={`${slot} slot timeframe`}
                  value={snapshot.strategy.timeframes[slot] ?? slot}
                  disabled={busy}
                  onChange={(e) => onSlotChange(slot, e.target.value)}
                  className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-1 py-0.5"
                >
                  {TIMEFRAMES.map((tf) => (
                    <option key={tf} value={tf}>
                      {tf}
                    </option>
                  ))}
                </select>
              ))}
            </span>
          )}

          <button
            onClick={() => setShowExtras((v) => !v)}
            className="rounded border border-[var(--color-line)] px-2 py-0.5 hover:bg-[var(--color-surface-3)]"
            title="Secondary columns each group hides by default (cross state, DI direction, nearest EMA…)"
          >
            {showExtras ? "Fewer columns" : "More columns"}
          </button>

          <button
            onClick={() => setShowFilters((v) => !v)}
            className="rounded border border-[var(--color-line)] px-2 py-0.5 hover:bg-[var(--color-surface-3)]"
          >
            Filters{countActive(filters) > 0 ? ` (${countActive(filters)})` : ""}
          </button>

          <span className="flex items-center gap-1">
            <input
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              placeholder="ADD/USDT"
              className="w-28 rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-1 py-0.5"
            />
            <button
              disabled={busy || !newSymbol}
              onClick={() =>
                run(async () => {
                  await api.addSymbol(newSymbol);
                  setNewSymbol("");
                })
              }
              className="rounded border border-[var(--color-line)] px-2 py-0.5 hover:bg-[var(--color-surface-3)] disabled:opacity-50"
              title="Validated against the exchange before it is saved"
            >
              Add
            </button>
          </span>

          <span className="flex items-center gap-1">
            <select
              className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-1 py-0.5"
              defaultValue=""
              onChange={(e) => e.target.value && run(() => api.loadPreset(e.target.value))}
            >
              <option value="">preset…</option>
              {presets.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                const name = window.prompt("Save current indicator timeframes as:");
                if (name) void run(async () => { await api.savePreset(name); await loadPresets(); });
              }}
              className="rounded border border-[var(--color-line)] px-2 py-0.5 hover:bg-[var(--color-surface-3)]"
            >
              Save preset
            </button>
          </span>
        </div>

        {error && <p className="mt-1 text-xs text-[var(--color-neg)]">{error}</p>}
        {snapshot?.last_refresh_error && (
          <p className="mt-1 text-xs text-[var(--color-neg)]">
            last refresh: {snapshot.last_refresh_error}
          </p>
        )}
        {snapshot?.unverified_symbols?.map((u) => (
          <p key={u.raw} className="mt-1 text-xs text-[var(--color-ink-dim)]">
            unverified symbol {u.raw} — {u.note}
          </p>
        ))}
      </header>

      <div className="flex min-h-0 flex-1">
        {snapshot ? (
          <ScreenerTable
            snapshot={snapshot}
            filters={filters}
            hiddenGroups={hiddenGroups}
            showExtras={showExtras}
            onToggleGroup={toggleGroup}
            onTimeframeChange={onTimeframeChange}
            busy={busy}
          />
        ) : (
          <p className="p-6 text-sm text-[var(--color-ink-dim)]">
            {error ? "Backend unreachable." : "Loading…"}
          </p>
        )}

        {showFilters && (
          <FilterPanel
            specs={COLUMNS}
            filters={filters}
            onChange={setFilters}
            onClose={() => setShowFilters(false)}
          />
        )}
      </div>

      <footer className="border-t border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-1 text-[11px] text-[var(--color-ink-dim)]">
        This tool ranks current indicator state across a watchlist. It does not predict price.
        Colour encodes magnitude only — every value is also shown as a number.
      </footer>
    </main>
  );
}