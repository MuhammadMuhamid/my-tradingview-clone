"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type PineInputDef, type PineRunResult, type PineScript } from "@/lib/api";
import type { Interval } from "@/lib/types";
import { PINE_TEMPLATE, TOKEN_COLOR, highlightLine } from "@/lib/pineHighlight";
import { fmtNum, fmtPct, signClass } from "@/lib/format";

/** What the editor hands the chart when you press "Add to chart". */
export interface PineChartPayload {
  name: string;
  source: string;
  params: Record<string, number | string | boolean>;
}

/**
 * TradingView-style Pine Editor: write a script, compile it, and add it to the
 * chart. Compiled `input.*` declarations become an editable settings column;
 * changing one re-runs the script.
 *
 * The engine executes a documented subset of Pine (single timeframe; no maps)
 * — anything outside it comes back as a normal compile error naming the line,
 * never a silent no-op.
 */
export function PineEditor({
  symbol, timeframe, startTime, endTime, onApplyToChart, appliedCount,
  openScript, onOpenScriptConsumed,
}: {
  symbol: string;
  timeframe: Interval;
  startTime: string;
  endTime: string;
  onApplyToChart: (payload: PineChartPayload) => void;
  /** how many studies the chart currently holds, for the toolbar hint */
  appliedCount: number;
  /** a script the Indicators panel asked to open here */
  openScript?: PineScript | null;
  onOpenScriptConsumed?: () => void;
}) {
  const [scripts, setScripts] = useState<PineScript[]>([]);
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [name, setName] = useState("My Strategy");
  const [source, setSource] = useState(PINE_TEMPLATE);
  const [result, setResult] = useState<PineRunResult | null>(null);
  const [inputs, setInputs] = useState<PineInputDef[]>([]);
  const [params, setParams] = useState<Record<string, number | string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [showConsole, setShowConsole] = useState(true);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try { setScripts(await api.listPineScripts()); } catch { /* backend offline */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // The Indicators panel can hand a library script over for editing.
  useEffect(() => {
    if (!openScript) return;
    setScriptId(openScript.id);
    setName(openScript.name);
    setSource(openScript.source);
    setParams({});
    setStatus(`Opened “${openScript.name}”`);
    onOpenScriptConsumed?.();
  }, [openScript, onOpenScriptConsumed]);

  const errors = result?.errors ?? [];
  const errorLines = useMemo(() => new Set(errors.map((e) => e.line)), [errors]);
  const lines = useMemo(() => source.split("\n"), [source]);

  // Compile (no data fetch) as you type, so the console tracks the source.
  useEffect(() => {
    const t = setTimeout(() => {
      api.compilePine(source)
        .then((r) => {
          setInputs(r.meta.inputs);
          setResult((prev) => (r.errors.length > 0 || !prev ? { ...r, ok: r.errors.length === 0 } : prev));
          // Drop overrides whose input no longer exists.
          setParams((p) => {
            const keys = new Set(r.meta.inputs.map((i) => i.key));
            return Object.fromEntries(Object.entries(p).filter(([k]) => keys.has(k)));
          });
        })
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [source]);

  const run = useCallback(async (apply: boolean) => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.runPine({
        source, symbol, timeframe,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(`${endTime}T23:59:59Z`).toISOString(),
        params,
      });
      setResult(r);
      if (!r.ok) {
        setStatus(`${r.errors.length} error${r.errors.length === 1 ? "" : "s"}`);
        setShowConsole(true);
        return;
      }
      setInputs(r.meta.inputs);
      if (apply) {
        onApplyToChart({ name: r.meta.title || name, source, params });
        setStatus(`Added to chart — ${r.plots?.length ?? 0} plot(s)`);
      } else {
        setStatus(`Compiled OK — ${r.times?.length ?? 0} bars`);
      }
    } catch (e) {
      setStatus((e as Error).message);
      setShowConsole(true);
    } finally {
      setBusy(false);
    }
  }, [source, symbol, timeframe, startTime, endTime, params, onApplyToChart, name]);

  const save = async () => {
    const clean = name.trim();
    if (!clean) return;
    try {
      const saved = scriptId
        ? await api.updatePineScript(scriptId, { name: clean, source })
        : await api.savePineScript(clean, source);
      setScriptId(saved.id);
      setStatus(`Saved “${saved.name}”`);
      await refresh();
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  const open = async (id: string) => {
    if (!id) {
      setScriptId(null);
      setName("My Strategy");
      setSource(PINE_TEMPLATE);
      return;
    }
    try {
      const s = await api.getPineScript(id);
      setScriptId(s.id);
      setName(s.name);
      setSource(s.source);
      setParams({});
      setStatus(`Opened “${s.name}”`);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  const remove = async () => {
    if (!scriptId || !window.confirm(`Delete “${name}”?`)) return;
    await api.deletePineScript(scriptId);
    setScriptId(null);
    await refresh();
    setStatus("Deleted");
  };

  // Tab inserts spaces; Pine blocks are indentation-based so this matters.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget;
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t } = el;
      const next = `${source.slice(0, s)}    ${source.slice(t)}`;
      setSource(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 4; });
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void run(true);
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  };

  const syncScroll = (): void => {
    const el = taRef.current;
    if (!el) return;
    if (preRef.current) {
      preRef.current.scrollTop = el.scrollTop;
      preRef.current.scrollLeft = el.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
  };

  const setParam = (key: string, v: number | string | boolean): void =>
    setParams((p) => ({ ...p, [key]: v }));

  const m = result?.metrics;
  const btn = "rounded border border-border bg-surface-2 px-2 py-1 text-xs text-ink hover:border-accent";

  return (
    <div className="flex h-full min-h-0">
      {/* ── editor column ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
          <select
            value={scriptId ?? ""}
            onChange={(e) => void open(e.target.value)}
            className="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-ink outline-none"
          >
            <option value="">＋ New script</option>
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {s.kind}</option>
            ))}
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-40 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-ink outline-none focus:border-accent"
            placeholder="Script name"
          />
          <button onClick={() => void save()} className={btn} title="⌘S">Save</button>
          <button onClick={() => void remove()} disabled={!scriptId}
            className={`${btn} disabled:opacity-30`}>Delete</button>
          <span className="text-ink-faint">·</span>
          <button onClick={() => void run(false)} disabled={busy} className={`${btn} disabled:opacity-40`}>
            {busy ? "Running…" : "Compile"}
          </button>
          <button
            onClick={() => void run(true)}
            disabled={busy}
            title="⌘↵"
            className="rounded bg-accent px-2.5 py-1 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-40"
          >
            Add to chart
          </button>
          {appliedCount > 0 && (
            <span className="text-[11px] text-ink-faint" title="Manage them in the Indicators panel">
              {appliedCount} on chart
            </span>
          )}
          {result?.meta?.kind && (
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
              result.meta.kind === "strategy" ? "bg-accent/15 text-accent" : "bg-surface-2 text-ink-muted"
            }`}>
              {result.meta.kind}
            </span>
          )}
          <span className="ml-auto text-[11px] text-ink-faint">{symbol} · {timeframe}</span>
        </div>

        {/* code surface */}
        <div className="relative flex min-h-0 flex-1 font-mono text-[12.5px] leading-[18px]">
          <div ref={gutterRef}
            className="select-none overflow-hidden border-r border-border bg-surface px-2 py-2 text-right text-ink-faint">
            {lines.map((_, i) => (
              <div key={i} className={errorLines.has(i + 1) ? "text-down" : undefined}>{i + 1}</div>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            <pre
              ref={preRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-auto whitespace-pre px-3 py-2"
            >
              {lines.map((line, i) => (
                <div key={i} className={errorLines.has(i + 1) ? "bg-down/10" : undefined}>
                  {highlightLine(line).map((tk, k) => (
                    <span key={k} style={{ color: TOKEN_COLOR[tk.cls] }}>{tk.text}</span>
                  ))}
                  {line === "" ? "​" : ""}
                </div>
              ))}
            </pre>
            <textarea
              ref={taRef}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={onKeyDown}
              onScroll={syncScroll}
              spellCheck={false}
              className="absolute inset-0 resize-none overflow-auto whitespace-pre bg-transparent px-3 py-2 text-transparent caret-ink outline-none"
            />
          </div>
        </div>

        {/* console */}
        <div className="border-t border-border">
          <button
            onClick={() => setShowConsole((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] text-ink-muted hover:text-ink"
          >
            <span>{showConsole ? "▾" : "▸"}</span>
            <span>Console</span>
            {errors.length > 0
              ? <span className="rounded bg-down/20 px-1.5 text-down">{errors.length}</span>
              : <span className="text-up">no errors</span>}
            {status && <span className="ml-auto text-ink-faint">{status}</span>}
          </button>
          {showConsole && (
            <div className="max-h-[110px] overflow-y-auto px-3 pb-2 font-mono text-[11px]">
              {errors.length === 0 && (
                <div className="text-ink-faint">
                  Script compiled. Engine supports arrays, matrices, types,
                  methods and line/box/label/table drawings. Not supported:
                  maps, and request.security for a different timeframe.
                </div>
              )}
              {errors.map((e, i) => (
                <button
                  key={i}
                  onClick={() => {
                    const el = taRef.current;
                    if (!el) return;
                    const pos = lines.slice(0, e.line - 1).reduce((a, l) => a + l.length + 1, 0) + (e.col - 1);
                    el.focus();
                    el.setSelectionRange(pos, pos);
                  }}
                  className="block w-full text-left text-down hover:underline"
                >
                  line {e.line}:{e.col} — {e.message}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── inputs / results column ── */}
      <div className="w-[280px] shrink-0 overflow-y-auto border-l border-border bg-surface px-3 py-2">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Inputs</div>
        {inputs.length === 0 && <div className="text-xs text-ink-faint">No input() declarations.</div>}
        {inputs.map((inp) => {
          const value = params[inp.key] ?? inp.defval;
          return (
            <label key={inp.key} className="mb-2 block" title={inp.tooltip}>
              <span className="mb-0.5 block truncate text-[11px] text-ink-muted">{inp.title}</span>
              {inp.type === "bool" ? (
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) => setParam(inp.key, e.target.checked)}
                  className="h-3.5 w-3.5 accent-[#4f8cff]"
                />
              ) : inp.options ? (
                <select
                  value={String(value)}
                  onChange={(e) => setParam(inp.key, e.target.value)}
                  className="w-full rounded border border-border bg-surface-2 px-2 py-1 text-xs text-ink outline-none"
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
                  onChange={(e) => setParam(
                    inp.key,
                    inp.type === "int" || inp.type === "float" ? Number(e.target.value) : e.target.value
                  )}
                  className="w-full rounded border border-border bg-surface-2 px-2 py-1 text-xs tabular text-ink outline-none focus:border-accent"
                />
              )}
            </label>
          );
        })}
        {Object.keys(params).length > 0 && (
          <button onClick={() => setParams({})} className={`${btn} mb-3 w-full`}>Reset to defaults</button>
        )}

        {m && (
          <>
            <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              Strategy result
            </div>
            <dl className="space-y-1 text-xs">
              {[
                ["Net profit", fmtPct(m.netProfitPct), signClass(m.netProfitPct)],
                ["Max drawdown", `${fmtNum(m.maxDrawdownPct)}%`, "text-ink"],
                ["Trades", String(m.totalTrades), "text-ink"],
                ["Win rate", `${fmtNum(m.winRatePct, 1)}%`, "text-ink"],
                ["Profit factor", m.profitFactor === null ? "∞" : fmtNum(m.profitFactor),
                  m.profitFactor === null || m.profitFactor >= 1 ? "text-up" : "text-down"],
              ].map(([label, value, cls]) => (
                <div key={label} className="flex justify-between gap-2">
                  <dt className="text-ink-muted">{label}</dt>
                  <dd className={`tabular ${cls}`}>{value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </div>
  );
}
