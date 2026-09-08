"use client";
import { useId, useMemo, useState } from "react";
import {
  classicalExportCsv, classicalExportJson, type ClassicalStatus,
} from "@/lib/classicalPatterns";
import type {
  ClassicalAnalysisState, ClassicalOverlayState,
} from "@/lib/useClassicalPatterns";

function download(name: string, content: string, type: string): void {
  const href = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = href; link.download = name; link.click();
  URL.revokeObjectURL(href);
}

export function ClassicalPatternControls(props: {
  overlay: ClassicalOverlayState;
  result: ClassicalAnalysisState;
  symbol: string;
  timeframe: string;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const catalog = useMemo(() => props.overlay.catalog?.patterns ?? [], [props.overlay.catalog]);
  const shown = useMemo(() => {
    const text = query.trim().toLowerCase();
    return catalog.filter((pattern) =>
      !text || `${pattern.name} ${pattern.family} ${pattern.id}`.toLowerCase().includes(text));
  }, [catalog, query]);
  const selected = new Set(props.overlay.selectedIds ?? []);
  const all = props.overlay.selectedIds === null;
  const counts = useMemo(() => {
    const patterns = props.result.analysis?.patterns ?? [];
    return {
      total: patterns.length,
      developing: patterns.filter((item) => item.state === "developing").length,
      completed: patterns.filter((item) => item.state === "completed").length,
    };
  }, [props.result.analysis]);
  const safe = `${props.symbol.replace(/[^A-Za-z0-9]/g, "")}-${props.timeframe}-classical-patterns`;
  return (
    <details name="chart-pattern-controls"
      className="w-80 max-w-full overflow-auto rounded border border-border bg-surface/95 text-xs text-ink shadow-xl">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2 py-1.5 font-medium">
        <span>Chart patterns · {counts.total}</span>
        <span className="text-[10px] font-normal text-ink-muted">
          {props.result.loading ? "scanning…" : `${counts.developing} live · ${counts.completed} formed`}
        </span>
      </summary>
      <div className="space-y-2 border-t border-border p-2">
        <p className="text-[11px] leading-4 text-ink-muted">
          Confirmed 5/5 pivots and close breakouts. Targets are measured geometry, not return forecasts.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-ink-muted">Pattern status</span>
            <select aria-label="Classical pattern status" value={props.overlay.status}
              onChange={(event) => props.overlay.setStatus(
                event.target.value as "all" | ClassicalStatus | "completed")}
              className="h-11 w-full rounded border border-border bg-bg px-2">
              <option value="all">All</option>
              <option value="developing">Developing</option>
              <option value="completed">Completed</option>
              <option value="awaiting">Awaiting target</option>
              <option value="reached">Target reached</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <div className="space-y-1 text-ink-muted">
            <span>Visibility</span>
            <label className="flex min-h-11 items-center gap-2 rounded border border-border px-2 text-ink">
              <input type="checkbox" checked={props.overlay.showTargets}
                onChange={(event) => props.overlay.setShowTargets(event.target.checked)} />
              Measured targets
            </label>
          </div>
        </div>
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={props.overlay.includeDeveloping}
            onChange={(event) => props.overlay.setIncludeDeveloping(event.target.checked)} />
          Include developing patterns
        </label>
        <label htmlFor={searchId} className="sr-only">Search classical chart patterns</label>
        <input id={searchId} type="search" value={query}
          onChange={(event) => setQuery(event.target.value)} placeholder="Search 16 patterns"
          className="h-11 w-full rounded border border-border bg-bg px-2" />
        <div className="max-h-44 space-y-1 overflow-auto" role="group"
          aria-label="Visible classical chart patterns">
          <label className="flex min-h-7 items-center gap-2">
            <input type="checkbox" checked={all}
              onChange={(event) => props.overlay.setSelectedIds(event.target.checked ? null : [])} />
            All 16 catalog patterns
          </label>
          {shown.map((pattern) => (
            <label key={pattern.id} className="flex min-h-7 items-center gap-2">
              <input type="checkbox" checked={all || selected.has(pattern.id)}
                onChange={(event) => {
                  const base = all ? catalog.map((item) => item.id) : [...selected];
                  props.overlay.setSelectedIds(event.target.checked
                    ? [...new Set([...base, pattern.id])]
                    : base.filter((id) => id !== pattern.id));
                }} />
              <span className="min-w-0 flex-1">{pattern.name}</span>
              <span className="text-[10px] text-ink-faint">{pattern.direction}</span>
            </label>
          ))}
        </div>
        {props.result.error && <p role="alert" className="text-down">{props.result.error}</p>}
        {!props.result.loading && !props.result.error && counts.total === 0 && (
          <p role="status" className="text-ink-muted">No qualifying pattern in these completed bars.</p>
        )}
        <div className="flex gap-2">
          <button type="button" disabled={!props.result.analysis}
            className="min-h-11 rounded border border-border px-2 disabled:opacity-40"
            onClick={() => props.result.analysis && download(
              `${safe}.json`, classicalExportJson(props.result.analysis), "application/json")}>Export JSON</button>
          <button type="button" disabled={!props.result.analysis}
            className="min-h-11 rounded border border-border px-2 disabled:opacity-40"
            onClick={() => props.result.analysis && download(
              `${safe}.csv`, classicalExportCsv(props.result.analysis), "text/csv")}>Export CSV</button>
        </div>
      </div>
    </details>
  );
}
