"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EMPTY_FILTERS, FilterPanel, countActive, type Filters } from "@/components/scanner/FilterPanel";
import { ScreenerTable } from "@/components/scanner/ScreenerTable";
import { COLUMNS } from "@/lib/scanner/columns";
import { api } from "@/lib/scanner/api";
import { fmtAge } from "@/lib/scanner/format";
import { INDICATOR_KEYS, TIMEFRAMES, type IndicatorKey, type Snapshot } from "@/lib/scanner/types";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ScannerPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [showExtras, setShowExtras] = useState(false);
  const [presets, setPresets] = useState<string[]>([]);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [newSymbol, setNewSymbol] = useState("");

  const load = useCallback(async () => {
    try {
      setSnapshot(await api.screener());
      setError(null);
    } catch (nextError) {
      setError(message(nextError));
    }
  }, []);

  const loadPresets = useCallback(async () => {
    try { setPresets(Object.keys((await api.presets()).presets).sort()); }
    catch { /* Snapshot reads remain useful if optional preset storage fails. */ }
  }, []);

  useEffect(() => {
    void load();
    void loadPresets();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [load, loadPresets]);

  const run = async (label: string, operation: () => Promise<unknown>, after?: () => void) => {
    setBusy(label);
    setError(null);
    try {
      await operation();
      after?.();
      await Promise.all([load(), loadPresets()]);
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      setBusy(null);
    }
  };

  const changeIndicatorTimeframe = (indicator: IndicatorKey, timeframe: string) =>
    run(`Updating ${indicator}`, () => api.patchConfig({ indicators: { [indicator]: { timeframe } } }));
  const changeSlot = (slot: string, timeframe: string) =>
    run(`Updating ${slot}`, () => api.patchConfig({ strategy: { timeframes: { [slot]: timeframe } } }));
  const toggleGroup = (group: string) => setHiddenGroups((current) => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    return next;
  });
  const removeSymbol = (symbol: string) => {
    if (window.confirm(`Remove ${symbol} from the shared Scanner watchlist?`)) {
      void run(`Removing ${symbol}`, () => api.removeSymbol(symbol));
    }
  };

  const state = useMemo(() => {
    const rows = snapshot?.rows ?? [];
    return {
      partial: rows.filter((row) => row.state === "partial" || row.state === "no_data").length,
      unresolved: rows.filter((row) => row.state === "unresolved").length,
      stale: rows.filter((row) => Object.values(row.series ?? {}).some((series) => series.stale)).length,
    };
  }, [snapshot]);
  const marketLabel = snapshot?.market.spot
    ? `${snapshot.market.exchange === "binance" ? "Binance" : snapshot.market.exchange} Spot`
    : "Binance Spot";

  return (
    <div className="scanner-workspace flex h-full min-h-0 flex-col bg-bg">
      <header className="border-b border-border bg-surface px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <div className="mr-1 min-w-[220px]">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Spot Scanner</h1>
              <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-medium text-accent">
                {marketLabel}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              Exact Spot instruments · {snapshot?.market.spot ? "API provenance verified" : "market identity loading"}
            </p>
          </div>

          <span className="text-ink-muted">
            {snapshot ? `${snapshot.rows.length} symbols · refreshed ${fmtAge(snapshot.last_refresh_at)}` : "Loading cached snapshot…"}
          </span>
          {state.partial > 0 && <span className="text-warn">Partial/no data {state.partial}</span>}
          {state.unresolved > 0 && <span className="text-warn">Unresolved {state.unresolved}</span>}
          {state.stale > 0 && <span className="text-warn">Stale rows {state.stale}</span>}

          <button disabled={busy !== null} onClick={() => void run("Refreshing", () => api.refresh(false))}
            className="scanner-control" title="Fetch series with newly confirmed bars">
            {busy === "Refreshing" ? "Refreshing…" : "Refresh"}
          </button>

          {snapshot?.strategy.enabled && (
            <span className="flex items-center gap-1" title="Canonical MTF checklist slots">
              <span className="text-ink-muted">Checklist TFs</span>
              {(["1h", "15m", "5m"] as const).map((slot) => (
                <label key={slot} className="flex items-center gap-1">
                  <span className="sr-only">{slot} checklist slot</span>
                  <select aria-label={`${slot} checklist slot timeframe`}
                    value={snapshot.strategy.timeframes[slot] ?? slot} disabled={busy !== null}
                    onChange={(event) => void changeSlot(slot, event.target.value)} className="scanner-select">
                    {TIMEFRAMES.map((timeframe) => <option key={timeframe}>{timeframe}</option>)}
                  </select>
                </label>
              ))}
            </span>
          )}

          <details className="relative">
            <summary className="scanner-control cursor-pointer list-none">Indicator TFs</summary>
            <div className="absolute right-0 z-20 mt-1 grid w-56 gap-1 rounded border border-border bg-surface p-2 shadow-lg">
              {snapshot && INDICATOR_KEYS.map((indicator) => (
                <label key={indicator} className="flex items-center justify-between gap-2 text-ink-muted">
                  <span className="uppercase">{indicator}</span>
                  <select value={snapshot.indicators[indicator]?.timeframe ?? "1h"} disabled={busy !== null}
                    onChange={(event) => void changeIndicatorTimeframe(indicator, event.target.value)}
                    className="scanner-select" aria-label={`${indicator} indicator timeframe`}>
                    {TIMEFRAMES.map((timeframe) => <option key={timeframe}>{timeframe}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </details>

          <button onClick={() => setShowExtras((value) => !value)} className="scanner-control">
            {showExtras ? "Fewer columns" : "More columns"}
          </button>
          <button onClick={() => setShowFilters((value) => !value)} className="scanner-control">
            Filters{countActive(filters) ? ` (${countActive(filters)})` : ""}
          </button>

          <span className="flex items-center gap-1">
            <label className="sr-only" htmlFor="scanner-symbol">Add Spot symbol</label>
            <input id="scanner-symbol" value={newSymbol} onChange={(event) => setNewSymbol(event.target.value)}
              placeholder="ADD/USDT" className="scanner-input w-28" />
            <button disabled={busy !== null || !newSymbol.trim()} className="scanner-control"
              onClick={() => void run("Adding symbol", () => api.addSymbol(newSymbol.trim()), () => setNewSymbol(""))}>
              Add
            </button>
          </span>

          <span className="flex items-center gap-1">
            <select aria-label="Scanner preset" className="scanner-select" value={selectedPreset}
              onChange={(event) => setSelectedPreset(event.target.value)}>
              <option value="">Preset…</option>
              {presets.map((preset) => <option key={preset}>{preset}</option>)}
            </select>
            <button className="scanner-control" disabled={!selectedPreset || busy !== null}
              onClick={() => void run("Loading preset", () => api.loadPreset(selectedPreset))}>Load</button>
            <button className="scanner-control" disabled={busy !== null} onClick={() => {
              const name = window.prompt("Save current Scanner indicator configuration as:");
              if (name?.trim()) void run("Saving preset", () => api.savePreset(name.trim()), () => setSelectedPreset(name.trim()));
            }}>Save</button>
            <button className="scanner-control" disabled={!selectedPreset || busy !== null} onClick={() => {
              if (window.confirm(`Delete Scanner preset “${selectedPreset}”?`)) {
                void run("Deleting preset", () => api.deletePreset(selectedPreset), () => setSelectedPreset(""));
              }
            }}>Delete</button>
          </span>
        </div>

        {busy && busy !== "Refreshing" && <p role="status" className="mt-1 text-xs text-ink-muted">{busy}…</p>}
        {error && <p role="alert" className="mt-1 text-xs text-down">Scanner: {error}</p>}
        {snapshot?.last_refresh_error && <p className="mt-1 text-xs text-down">Last refresh: {snapshot.last_refresh_error}</p>}
        {snapshot?.unverified_symbols.map((item) => (
          <p key={item.raw} className="mt-1 text-xs text-warn">Unverified {item.raw} — {item.note}</p>
        ))}
      </header>

      <div className="flex min-h-0 flex-1">
        {snapshot ? (
          <ScreenerTable snapshot={snapshot} filters={filters} hiddenGroups={hiddenGroups}
            showExtras={showExtras} onToggleGroup={toggleGroup}
            onTimeframeChange={changeIndicatorTimeframe} busy={busy !== null}
            onRemoveSymbol={removeSymbol} />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-sm text-ink-muted">
            <div className="text-center">
              <p>{error ? "Scanner service unavailable." : "Loading cached Spot Scanner snapshot…"}</p>
              {error && <button className="scanner-control mt-3" onClick={() => void load()}>Retry</button>}
            </div>
          </div>
        )}
        {showFilters && <FilterPanel specs={COLUMNS} filters={filters} onChange={setFilters}
          onClose={() => setShowFilters(false)} />}
      </div>

      <footer className="border-t border-border bg-surface px-3 py-1 text-[11px] text-ink-muted">
        Checklist percentages are the share of conditions passing, not probabilities. Confluence Score is not a probability.
        Empirical calibration is separate and is shown only when its sample fingerprint matches current settings.
      </footer>
    </div>
  );
}
