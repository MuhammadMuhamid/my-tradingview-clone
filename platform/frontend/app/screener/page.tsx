"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EMPTY_FILTERS, FilterPanel, countActive, type Filters } from "@/components/scanner/FilterPanel";
import { ScreenerTable } from "@/components/scanner/ScreenerTable";
import { COLUMNS } from "@/lib/scanner/columns";
import { api } from "@/lib/scanner/api";
import { fmtAge } from "@/lib/scanner/format";
import { INDICATOR_KEYS, TIMEFRAMES, type IndicatorKey, type Snapshot } from "@/lib/scanner/types";
import { shariahApi, type ShariahClassification, type ShariahMode } from "@/lib/shariah";
import { WORKSTATION_CATEGORIES, type WorkstationCategory } from "@/lib/workstation";

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
  /** baseAsset -> effective status, joined onto rows below. */
  const [shariahStatuses, setShariahStatuses] = useState<Map<string, ShariahClassification> | null>(null);
  const [shariahError, setShariahError] = useState<string | null>(null);
  const [shariahMode, setShariahMode] = useState<ShariahMode | null>(null);
  const [category, setCategory] = useState<WorkstationCategory>("crypto_spot");
  const [categoryFields, setCategoryFields] = useState<Array<{ id: string; label: string; semantic: string }>>([]);
  const spotCategory = category === "crypto_spot";

  const load = useCallback(async () => {
    try {
      setSnapshot(await api.screener());
      setError(null);
    } catch (nextError) {
      setError(message(nextError));
    }
  }, []);

  /**
   * The scanner service knows nothing about Shariah, so the status is joined in
   * here from the registry rather than pushed into that service. Read once per
   * page load, not per 15-second refresh: classifications change on publication,
   * not on price ticks.
   */
  const loadShariah = useCallback(async () => {
    try {
      const [universe, mode] = await Promise.all([shariahApi.universe(), shariahApi.mode()]);
      setShariahStatuses(new Map(universe.assets.map((a) => [a.baseAsset, a.effectiveStatus])));
      setShariahMode(mode.mode);
      setShariahError(null);
    } catch (e) {
      /*
       * The scanner stays fully usable without it — but it must SAY so.
       *
       * A silent null removed the Shariah Mode line and the whole status column
       * from the screen, on a product where "may I buy this" is the question
       * that line answers. Absence read as "not applicable". The enforcement
       * itself is the backend's and is unaffected either way; what was missing
       * was the statement that this screen cannot show it.
       */
      setShariahStatuses(null);
      setShariahError((e as Error).message);
    }
  }, []);

  const loadPresets = useCallback(async () => {
    try { setPresets(Object.keys((await api.presets()).presets).sort()); }
    catch { /* Snapshot reads remain useful if optional preset storage fails. */ }
  }, []);

  useEffect(() => {
    void load();
    void loadPresets();
    void loadShariah();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [load, loadPresets, loadShariah]);

  useEffect(() => {
    let current = true;
    void api.screenerSchema(category).then((schema) => {
      if (current) setCategoryFields(schema.fields);
    }).catch(() => { if (current) setCategoryFields([]); });
    return () => { current = false; };
  }, [category]);

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
  /**
   * The snapshot the table renders, with the Shariah status joined onto each
   * row. The base asset is the symbol minus its USDT quote — the same identity
   * the registry screens. A base asset absent from the registry reads UNKNOWN,
   * never a permitted status.
   */
  const shariahSnapshot = useMemo(() => {
    if (!snapshot || !shariahStatuses) return snapshot;
    return {
      ...snapshot,
      rows: snapshot.rows.map((row) => {
        const base = row.symbol.replace(/[/-]?USDT$/i, "").toUpperCase();
        return { ...row, shariah: shariahStatuses.get(base) ?? ("UNKNOWN" as const) };
      }),
    };
  }, [snapshot, shariahStatuses]);

  const categoryLabel = WORKSTATION_CATEGORIES.find((item) => item.id === category)?.label ?? category;
  const marketLabel = spotCategory
    ? snapshot?.market.spot
      ? `${snapshot.market.exchange === "binance" ? "Binance" : snapshot.market.exchange} Spot`
      : "Binance Spot"
    : categoryLabel;

  /*
   * The service is gone and nothing has ever loaded. One state, said once:
   * the toolbar of refresh, timeframe, preset and add-symbol controls is
   * withheld — every one of them would call the same dead service — and the
   * body explains what is unavailable and offers the one action that can
   * help. It used to render the whole toolbar over a blank table with the
   * same failure written in two places.
   */
  const unavailable = spotCategory && snapshot === null && error !== null;
  if (unavailable) {
    const unconfigured = /not configured/i.test(error);
    return (
      <div className="scanner-workspace flex h-full min-h-0 flex-col bg-bg">
        <header className="border-b border-border bg-surface px-3 py-2">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-ink">Market Screener</h1>
            <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-xs font-medium text-accent">
              {marketLabel}
            </span>
            <select value={category} onChange={(event) => setCategory(event.target.value as WorkstationCategory)}
              className="scanner-select" aria-label="Screener market category">
              {WORKSTATION_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
        </header>
        <div className="grid flex-1 place-items-center p-6">
          <div role="alert" className="max-w-md text-center">
            <p className="text-sm font-medium text-ink">
              {unconfigured ? "The Screener is not set up on this install." : "Scanner service unavailable."}
            </p>
            <p className="mt-2 text-xs leading-5 text-ink-muted">
              {unconfigured
                ? "Screening runs in a separate service that this Platform has not been pointed at. The chart, alerts, trading and the Journal do not depend on it."
                : "The screening service did not answer. The chart, alerts, trading and the Journal do not depend on it; this page will work again once the service is reachable."}
            </p>
            <p className="mt-2 font-mono text-[11px] text-ink-faint">{error}</p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button className="scanner-control" onClick={() => void load()}>Retry</button>
              {unconfigured && (
                <a href="/operations" className="scanner-control">Operations</a>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="scanner-workspace flex h-full min-h-0 flex-col bg-bg">
      <header className="border-b border-border bg-surface px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <div className="mr-1 min-w-[220px]">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Market Screener</h1>
              <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-medium text-accent">
                {marketLabel}
              </span>
            </div>
            {/*
              "market identity loading" is a claim that something is still
              happening. Once the scanner service has failed, nothing is: the
              snapshot stays null, and this line sat next to a "Scanner service
              unavailable" banner insisting it was still loading.
            */}
            <p className="mt-0.5 text-[11px] text-ink-muted">
              {spotCategory ? "Exact Spot instruments" : "Separate market semantics"} · {spotCategory && snapshot?.market.spot
                ? "API provenance verified"
                : spotCategory ? (error ? "market identity unknown" : "market identity loading")
                  : "no compatible compute snapshot installed"}
            </p>
          </div>

          <label className="flex items-center gap-1 text-ink-muted">
            <span>Category</span>
            <select value={category} onChange={(event) => setCategory(event.target.value as WorkstationCategory)}
              className="scanner-select" aria-label="Screener market category">
              {WORKSTATION_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          {!spotCategory && (
            <span role="status" className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-warn">
              {categoryLabel} fields are category-specific; this installed compute service has no compatible snapshot.
            </span>
          )}
          {spotCategory && <>
          <span className="text-ink-muted">
            {snapshot
              ? `${snapshot.rows.length} symbols · refreshed ${fmtAge(snapshot.last_refresh_at)}`
              : error ? "No snapshot loaded" : "Loading cached snapshot…"}
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
          </>}
        </div>

        {spotCategory && !shariahStatuses && shariahError && (
          <p role="alert" className="mt-1 text-xs text-warn">
            Shariah classifications could not be read, so the status column and Shariah Mode are
            not shown here. This screen only reports them — buying is gated by the server either
            way. <span className="font-mono text-ink-faint">{shariahError}</span>
          </p>
        )}
        {spotCategory && shariahStatuses && (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <span>
              Shariah Mode is {shariahMode === "enforce" ? <span className="text-up">ON</span> : "OFF"}
              {shariahMode === "enforce" ? " — only ELIGIBLE assets can be bought." : ""}
            </span>
            <button
              className="scanner-control"
              onClick={() => setFilters((old) => {
                const showingEligibleOnly = old.categorical.shariah?.length === 1
                  && old.categorical.shariah[0] === "ELIGIBLE";
                const next = { ...old.categorical };
                if (showingEligibleOnly) delete next.shariah; else next.shariah = ["ELIGIBLE"];
                return { ...old, categorical: next };
              })}
            >
              {filters.categorical.shariah?.length === 1 && filters.categorical.shariah[0] === "ELIGIBLE"
                ? "Show all statuses" : "Shariah-eligible only"}
            </button>
          </p>
        )}
        {spotCategory && busy && busy !== "Refreshing" && <p role="status" className="mt-1 text-xs text-ink-muted">{busy}…</p>}
        {spotCategory && error && <p role="alert" className="mt-1 text-xs text-down">Scanner: {error}</p>}
        {spotCategory && snapshot?.last_refresh_error && <p role="alert" className="mt-1 text-xs text-down">Last refresh: {snapshot.last_refresh_error}</p>}
        {spotCategory && (snapshot?.unverified_symbols.length ?? 0) > 0 && (
          <div role="status" aria-live="polite">
            {snapshot?.unverified_symbols.map((item) => (
              <p key={item.raw} className="mt-1 text-xs text-warn">Unverified {item.raw} — {item.note}</p>
            ))}
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {!spotCategory ? (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div><p className="text-sm font-medium text-ink">No {categoryLabel} snapshot on this installation</p>
              <p className="mt-2 max-w-lg text-xs leading-5 text-ink-muted">The workstation keeps separate field contracts for each market category. It does not reuse Spot volume, 24×7 sessions or crypto indicators where those semantics do not apply.</p>
              {categoryFields.length > 0 && <div aria-label={`${categoryLabel} field contract`} className="mt-4 flex max-w-lg flex-wrap justify-center gap-1.5">
                {categoryFields.map((field) => <span key={field.id} title={field.semantic}
                  className="rounded border border-border bg-surface px-2 py-1 text-[11px] text-ink-muted">{field.label}</span>)}
              </div>}</div>
          </div>
        ) : shariahSnapshot ? (
          <ScreenerTable snapshot={shariahSnapshot} filters={filters} hiddenGroups={hiddenGroups}
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
        {showFilters && spotCategory && <FilterPanel specs={COLUMNS} filters={filters} onChange={setFilters}
          onClose={() => setShowFilters(false)} />}
      </div>

      <footer className="border-t border-border bg-surface px-3 py-1 text-[11px] text-ink-muted">
        {spotCategory
          ? "Checklist percentages are the share of conditions passing, not probabilities. Confluence Score is not a probability. Empirical calibration is separate and appears only when its sample fingerprint matches current settings."
          : `${categoryLabel} does not reuse Spot fields. A compatible category snapshot is required before rows or filters appear.`}
      </footer>
    </div>
  );
}
