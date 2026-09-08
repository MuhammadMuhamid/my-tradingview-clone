"use client";
import { useId, useMemo, useState } from "react";
import type { CandleOverlayState, PatternAnalysisState } from "@/lib/useCandleOverlay";
import { patternExportCsv, patternExportJson } from "@/lib/candleOverlay";
import { api as platformApi } from "@/lib/api";
import { isInterval } from "@/lib/types";

function download(name: string, content: string, type: string): void {
  const href = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = href; link.download = name; link.click();
  URL.revokeObjectURL(href);
}

export function PatternOverlayControls(props: {
  overlay: CandleOverlayState; result: PatternAnalysisState; symbol: string; timeframe: string;
}) {
  const [query, setQuery] = useState("");
  const [alertStatus, setAlertStatus] = useState<string | null>(null);
  const searchId = useId();
  const catalog = useMemo(
    () => props.overlay.catalog?.patterns ?? [],
    [props.overlay.catalog?.patterns],
  );
  const shown = useMemo(() => {
    const text = query.trim().toLowerCase();
    return catalog.filter((p) => !text || `${p.name} ${p.id}`.toLowerCase().includes(text));
  }, [catalog, query]);
  const selected = new Set(props.overlay.selectedIds ?? []);
  const all = props.overlay.selectedIds === null;
  const safe = `${props.symbol.replace(/[^A-Za-z0-9]/g, "")}-${props.timeframe}-candlestick-patterns`;
  return (
    <details name="chart-pattern-controls"
      className="w-72 max-w-full overflow-auto rounded border border-border bg-surface/95 text-xs text-ink shadow-xl">
      <summary className="flex min-h-11 cursor-pointer select-none items-center px-2 py-1.5 font-medium">
        Patterns · {props.result.analysis?.patterns.length ?? 0}
        {props.result.loading ? " · analyzing" : ""}
      </summary>
      <div className="space-y-2 border-t border-border p-2">
        <p className="text-[11px] text-ink-muted">
          Confirmed bar-close formations. Fit describes geometry, not expected return.
        </p>
        <label className="flex items-center justify-between gap-2">
          Direction
          <select aria-label="Candlestick pattern direction" value={props.overlay.direction}
            onChange={(e) => props.overlay.setDirection(e.target.value as "both" | "bull" | "bear")}
            className="rounded border border-border bg-bg px-2 py-1">
            <option value="both">All</option><option value="bull">Bullish</option><option value="bear">Bearish</option>
          </select>
        </label>
        <label htmlFor={searchId} className="sr-only">Search candlestick patterns</label>
        <input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search 44 patterns" className="w-full rounded border border-border bg-bg px-2 py-1" />
        <div className="max-h-44 space-y-1 overflow-auto" role="group" aria-label="Visible candlestick patterns">
          <label className="flex gap-2"><input type="checkbox" checked={all}
            onChange={(event) => props.overlay.setSelectedIds(event.target.checked ? null : [])} />All catalog patterns</label>
          {shown.map((p) => <label key={p.id} className="flex gap-2">
            <input type="checkbox" checked={all || selected.has(p.id)} onChange={(event) => {
              const base = all ? catalog.map((item) => item.id) : [...selected];
              props.overlay.setSelectedIds(event.target.checked
                ? [...new Set([...base, p.id])] : base.filter((id) => id !== p.id));
            }} />
            <span className="min-w-0 flex-1">{p.name}</span>
            {isInterval(props.timeframe) && props.timeframe !== "1s" && (
              <button type="button" className="rounded border border-border px-1 text-[10px]"
                aria-label={`Arm bar-close alert for ${p.name}`} onClick={(event) => {
                  event.preventDefault();
                  setAlertStatus(`Arming ${p.name}…`);
                  void platformApi.createPatternAlert({
                    symbol: props.symbol.replace(/^BINANCE:/, ""),
                    timeframe: props.timeframe as import("@/lib/types").Interval, patternId: p.id,
                  }).then(() => setAlertStatus(`${p.name} alert armed for bar close.`))
                    .catch((error: unknown) => setAlertStatus(
                      error instanceof Error ? error.message : "Could not arm alert"));
                }}>Alert</button>
            )}
          </label>)}
        </div>
        {alertStatus && <p role="status" aria-live="polite">{alertStatus}</p>}
        {props.result.error && <p role="alert" className="text-down">{props.result.error}</p>}
        <div className="flex gap-2">
          <button type="button" disabled={!props.result.analysis} className="rounded border border-border px-2 py-1 disabled:opacity-40"
            onClick={() => props.result.analysis && download(`${safe}.json`, patternExportJson(props.result.analysis), "application/json")}>Export JSON</button>
          <button type="button" disabled={!props.result.analysis} className="rounded border border-border px-2 py-1 disabled:opacity-40"
            onClick={() => props.result.analysis && download(`${safe}.csv`, patternExportCsv(props.result.analysis), "text/csv")}>Export CSV</button>
        </div>
      </div>
    </details>
  );
}
