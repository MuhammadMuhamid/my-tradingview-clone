"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type PineScript } from "@/lib/api";
import type { IndicatorsApi } from "@/lib/useIndicators";
import type { AppliedIndicator } from "@/lib/indicators";

/**
 * TradingView's "Indicators" dialog, as a side panel: a library of saved Pine
 * scripts on top, and the studies currently on the chart below.
 *
 * Scripts enter the library either from the Pine Editor (Save) or by importing
 * a `.pine` file here — importing is the path for scripts written elsewhere,
 * which is most of them.
 */
export function IndicatorsPanel({
  indicators, onOpenInEditor, onEditIndicator, focusKey = null,
}: {
  indicators: IndicatorsApi;
  /** load a saved script into the Pine Editor tab for editing */
  onOpenInEditor: (script: PineScript) => void;
  /** edit one applied instance without changing its stable chart identity */
  onEditIndicator: (indicator: AppliedIndicator) => void;
  /**
   * Open this instance's settings when the panel appears. Set by the gear on a
   * pane, so "settings" from the chart lands on the fields rather than on a
   * panel the user then has to search.
   */
  focusKey?: string | null;
}) {
  const [library, setLibrary] = useState<PineScript[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // A second click of the same pane's gear should re-open it, so this follows
  // the prop rather than only seeding from it.
  useEffect(() => { if (focusKey) setExpanded(focusKey); }, [focusKey]);

  const refresh = useCallback(async () => {
    try { setLibrary(await api.listPineScripts()); } catch { /* backend offline */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? library.filter((s) => s.name.toLowerCase().includes(needle)) : library;
  }, [library, q]);

  /** Import one or more .pine files straight into the library. */
  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setStatus(null);
    const added: string[] = [];
    const failed: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const source = await file.text();
        const name = file.name.replace(/\.(pine|txt)$/i, "");
        await api.savePineScript(name, source);
        added.push(name);
      } catch (e) {
        failed.push(`${file.name}: ${(e as Error).message}`);
      }
    }
    await refresh();
    setBusy(false);
    setStatus([
      added.length > 0 ? `Imported ${added.length} script${added.length === 1 ? "" : "s"}` : "",
      ...failed,
    ].filter(Boolean).join(" · "));
    if (fileRef.current) fileRef.current.value = "";
  };

  const addToChart = async (s: PineScript) => {
    setBusy(true);
    try {
      // The list endpoint returns source too, but re-fetch so a script edited
      // in another tab is applied as it stands now.
      const full = await api.getPineScript(s.id);
      indicators.add({ scriptId: full.id, name: full.name, source: full.source });
      setStatus(`Added “${full.name}”`);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeFromLibrary = async (s: PineScript) => {
    if (!window.confirm(`Delete “${s.name}” from the library? Studies already on the chart stay.`)) return;
    try {
      await api.deletePineScript(s.id);
      await refresh();
      setStatus(`Deleted “${s.name}”`);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  const btn = "rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-ink hover:border-accent";

  return (
    <div className="flex h-full w-[300px] shrink-0 flex-col border-l border-border bg-surface">
      {/* ── library ── */}
      <div className="border-b border-border px-3 py-2">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Indicator library
          </span>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className={`${btn} ml-auto disabled:opacity-40`}
            title="Import .pine files from disk"
          >
            Import .pine
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pine,.txt"
            multiple
            hidden
            onChange={(e) => void onFiles(e.target.files)}
          />
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search scripts…"
          className="mb-2 w-full rounded border border-border bg-surface-2 px-2 py-1 text-xs text-ink outline-none focus:border-accent"
        />
        <div className="max-h-[190px] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="py-2 text-[11px] text-ink-faint">
              {library.length === 0
                ? "No saved scripts yet — import a .pine file or save one from the Pine Editor."
                : "No script matches that search."}
            </div>
          )}
          {filtered.map((s) => (
            <div key={s.id} className="group flex items-center gap-1.5 rounded px-1 py-1 hover:bg-surface-2">
              <button
                onClick={() => void addToChart(s)}
                disabled={busy}
                className="min-w-0 flex-1 truncate text-left text-xs text-ink disabled:opacity-40"
                title={`Add “${s.name}” to the chart`}
              >
                {s.name}
              </button>
              <span className={`rounded px-1 text-[9px] font-semibold uppercase ${
                s.kind === "strategy" ? "bg-accent/15 text-accent" : "bg-border text-ink-muted"
              }`}>
                {s.kind === "strategy" ? "str" : "ind"}
              </span>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <RowButton
                  onClick={() => void api.getPineScript(s.id).then(onOpenInEditor)}
                  label={`Open ${s.name} in the Pine Editor`}
                  title="Open in the Pine Editor"
                >
                  <path d="M8.6 2.4l3 3L5 12H2V9l6.6-6.6Z" />
                </RowButton>
                <RowButton
                  onClick={() => void removeFromLibrary(s)}
                  label={`Delete ${s.name} from the library`}
                  title="Delete from the library"
                  danger
                >
                  <path d="M3 3l8 8M11 3l-8 8" />
                </RowButton>
              </span>
            </div>
          ))}
        </div>
        {status && <div className="mt-1.5 truncate text-[10px] text-ink-faint" title={status}>{status}</div>}
      </div>

      {/* ── studies on the chart ── */}
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            On chart ({indicators.list.length})
          </span>
          {indicators.list.length > 0 && (
            <button onClick={indicators.clear} className={`${btn} ml-auto`}>Remove all</button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {indicators.list.length === 0 && (
            <div className="text-[11px] text-ink-faint">
              Nothing applied. Click a script above to add it to the chart.
            </div>
          )}
          {indicators.list.map((ind) => (
            <IndicatorRow
              key={ind.key}
              ind={ind}
              open={expanded === ind.key}
              onToggleOpen={() => setExpanded((k) => (k === ind.key ? null : ind.key))}
              indicators={indicators}
              onEdit={() => onEditIndicator(ind)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** One applied study: visibility, error state, and its input() settings. */
function IndicatorRow({
  ind, open, onToggleOpen, indicators, onEdit,
}: {
  ind: AppliedIndicator;
  open: boolean;
  onToggleOpen: () => void;
  indicators: IndicatorsApi;
  onEdit: () => void;
}) {
  const overridden = Object.keys(ind.params).length;
  return (
    <div className="mb-1 rounded border border-border bg-surface-2/40">
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          onClick={() => indicators.toggleVisible(ind.key)}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
            ind.visible ? "text-ink hover:bg-border" : "text-ink-faint hover:bg-border hover:text-ink"
          }`}
          aria-pressed={ind.visible}
          aria-label={`${ind.visible ? "Hide" : "Show"} ${ind.shortTitle || ind.name}`}
          title={ind.visible ? "Hide" : "Show"}
        >
          {/*
            Filled versus outlined, not merely a different shade: visibility was
            a ● and a ○ in two greys, which is a state told by colour alone and
            unreadable at a glance on a dark panel.
          */}
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="6" cy="6" r="4.2" fill={ind.visible ? "currentColor" : "none"}
              stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button onClick={onToggleOpen} className="min-w-0 flex-1 truncate text-left text-xs text-ink">
          {ind.shortTitle || ind.name} · {ind.key.slice(-5)}
          {ind.loading && <span className="ml-1 text-[10px] text-ink-faint">running…</span>}
          {!ind.loading && !ind.error && (
            <span className="ml-1 text-[10px] text-ink-faint">
              {ind.overlays.length} plot{ind.overlays.length === 1 ? "" : "s"}
              {ind.markers.length > 0 ? ` · ${ind.markers.length} marks` : ""}
            </span>
          )}
        </button>
        <RowButton
          onClick={onEdit}
          label={`Edit ${ind.shortTitle || ind.name} source in the Pine Editor`}
          title="Edit source in Pine Editor"
        >
          <path d="M8.6 2.4l3 3L5 12H2V9l6.6-6.6Z" />
        </RowButton>
        <RowButton
          onClick={() => indicators.rerun(ind.key)}
          label={`Re-run ${ind.shortTitle || ind.name}`}
          title="Re-run"
        >
          <path d="M12 7a5 5 0 1 1-1.5-3.5" />
          <path d="M12 1.6V4H9.6" />
        </RowButton>
        <RowButton
          onClick={() => indicators.remove(ind.key)}
          label={`Remove ${ind.shortTitle || ind.name} from the chart`}
          title="Remove from chart"
          danger
        >
          <path d="M3 3l8 8M11 3l-8 8" />
        </RowButton>
      </div>

      {ind.error && (
        <div className="border-t border-down/25 bg-down/10 px-2 py-1 font-mono text-[10px] text-down">
          {ind.error}
        </div>
      )}

      {ind.warnings.length > 0 && (
        <div className="border-t border-warn/25 bg-warn/10 px-2 py-1 font-mono text-[10px] text-warn">
          {ind.warnings.map((warning) => (
            <div key={`${warning.line}:${warning.message}`}>
              line {warning.line}: {warning.message}
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="border-t border-border px-2 py-1.5">
          {ind.inputs.length === 0 ? (
            <div className="text-[10px] text-ink-faint">No input() declarations.</div>
          ) : (
            ind.inputs.map((inp) => {
              const value = ind.params[inp.key] ?? inp.defval;
              return (
                <label key={inp.key} className="mb-1.5 block" title={inp.tooltip}>
                  <span className="mb-0.5 block truncate text-[10px] text-ink-muted">{inp.title}</span>
                  {inp.type === "bool" ? (
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(e) => indicators.setParam(ind.key, inp.key, e.target.checked)}
                      className="h-3.5 w-3.5 accent-accent"
                    />
                  ) : inp.options ? (
                    <select
                      value={String(value)}
                      onChange={(e) => indicators.setParam(ind.key, inp.key, e.target.value)}
                      className="w-full rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink outline-none"
                    >
                      {inp.options.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                    </select>
                  ) : (
                    <input
                      type={inp.type === "int" || inp.type === "float" ? "number" : "text"}
                      value={String(value)}
                      step={inp.step ?? (inp.type === "int" ? 1 : "any")}
                      min={inp.minval}
                      max={inp.maxval}
                      onChange={(e) => indicators.setParam(
                        ind.key, inp.key,
                        inp.type === "int" || inp.type === "float" ? Number(e.target.value) : e.target.value
                      )}
                      className="w-full rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] tabular text-ink outline-none focus:border-accent"
                    />
                  )}
                </label>
              );
            })
          )}
          {overridden > 0 && (
            <button
              onClick={() => indicators.resetParams(ind.key)}
              className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-0.5 text-[10px] text-ink hover:border-accent"
            >
              Reset {overridden} override{overridden === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One icon action on an applied study.
 *
 * These were `✎`, `↻` and `✕` typed as text: three different glyph widths, no
 * accessible name beyond a tooltip, and a size decided by whichever font the
 * platform substituted.
 */
function RowButton({
  onClick, label, title, danger = false, children,
}: {
  onClick: () => void;
  label: string;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint transition-colors ${
        danger ? "hover:bg-down/20 hover:text-down" : "hover:bg-border hover:text-ink"
      }`}
    >
      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor"
        strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
