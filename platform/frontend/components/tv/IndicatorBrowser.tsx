"use client";
/**
 * The Indicators dialog: everything this installation can put on a chart.
 *
 * ── What it is a browser OVER ──────────────────────────────────────────────
 *
 * The actual Trading Scene indicator library, and nothing else. That library is
 * the Pine scripts stored by this installation — written in the Pine editor or
 * imported as `.pine` files — plus the study TEMPLATES an operator has saved
 * from a chart. Both are user-owned, which is why "Saved" is a truthful
 * heading here where "Built-in" would not be: this product ships no bundled
 * scripts, so a Built-in tab would be an empty promise, and Community,
 * Marketplace, Purchased and Trending would be promises about a marketplace
 * that does not exist.
 *
 * The categories below are therefore derived from real data: the `kind` the
 * Pine compiler reports for each script, what is currently applied to the
 * focused chart, and the templates in local storage. Nothing is invented and
 * no new indicator is added.
 *
 * ── Which chart it adds to ─────────────────────────────────────────────────
 *
 * The focused pane's study list, handed in as `indicators`. The page resolves
 * that from `workspace.activePaneId`, so this component cannot add to the
 * wrong chart, and the footer names the chart it will land on rather than
 * leaving the user to assume.
 *
 * The side panel (`IndicatorsPanel`) remains what it was: the manager for what
 * is ALREADY on the chart, with each instance's inputs. This dialog is the
 * library; that panel is the chart. They act on the same list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { api, type PineScript } from "@/lib/api";
import type { AppliedIndicator } from "@/lib/indicators";
import {
  deleteTemplate, findTemplate, loadTemplates, saveTemplates, templateFromIndicators,
  upsertTemplate, type IndicatorTemplate,
} from "@/lib/indicatorTemplates";
import type { IndicatorsApi } from "@/lib/useIndicators";
import type { Interval } from "@/lib/types";

type Category = "all" | "indicator" | "strategy" | "onChart" | "templates";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "all", label: "All scripts" },
  { id: "indicator", label: "Indicators" },
  { id: "strategy", label: "Strategies" },
  { id: "onChart", label: "On this chart" },
  { id: "templates", label: "Templates" },
];

export interface IndicatorBrowserProps {
  open: boolean;
  onClose: () => void;
  /** The chart this dialog adds to — the focused pane. */
  symbol: string;
  interval: Interval;
  /** The focused pane's studies, or null while that pane is still mounting. */
  indicators: IndicatorsApi | null;
  /** Load a saved script into the Pine Editor tab for editing. */
  onOpenInEditor: (script: PineScript) => void;
}

const CHIP = "rounded-full px-3 py-1 text-[12px] transition-colors";
const ACTION =
  "shrink-0 rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-ink " +
  "transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-40";

export function IndicatorBrowser(props: IndicatorBrowserProps) {
  const { open, onClose, indicators } = props;
  const [library, setLibrary] = useState<PineScript[]>([]);
  const [templates, setTemplates] = useState<IndicatorTemplate[]>([]);
  const [category, setCategory] = useState<Category>("all");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const applied: AppliedIndicator[] = useMemo(() => indicators?.list ?? [], [indicators]);

  const refresh = useCallback(async () => {
    try {
      setLibrary(await api.listPineScripts());
      setLibraryError(null);
    } catch (e) {
      // The library is the whole point of this dialog, so its absence is said
      // rather than rendered as "no scripts yet" — which would read as an
      // empty library and invite the user to import what they already have.
      setLibraryError((e as Error).message);
    }
  }, []);

  // Fresh every open: a script saved in the editor since last time should be
  // here, and a stale status line from a previous visit should not.
  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setQ("");
    setTemplateName("");
    setTemplates(loadTemplates());
    void refresh();
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, refresh]);

  const persistTemplates = useCallback((next: IndicatorTemplate[]) => {
    setTemplates(next);
    saveTemplates(next);
  }, []);

  /** How many instances of this script are on the chart right now. */
  const appliedCount = useCallback((script: PineScript): number =>
    applied.filter((i) => i.scriptId === script.id).length, [applied]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matches = (s: PineScript): boolean =>
      needle.length === 0 || s.name.toLowerCase().includes(needle);
    if (category === "indicator") return library.filter((s) => s.kind === "indicator" && matches(s));
    if (category === "strategy") return library.filter((s) => s.kind === "strategy" && matches(s));
    if (category === "onChart") {
      const ids = new Set(applied.map((i) => i.scriptId).filter((id): id is string => id !== null));
      return library.filter((s) => ids.has(s.id) && matches(s));
    }
    return library.filter(matches);
  }, [library, applied, category, q]);

  const filteredTemplates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle.length === 0
      ? templates
      : templates.filter((t) => t.name.toLowerCase().includes(needle));
  }, [templates, q]);

  const addScript = async (s: PineScript): Promise<void> => {
    if (!indicators) return;
    setBusy(true);
    try {
      // The list endpoint returns source too, but re-fetch so a script edited
      // in another tab is applied as it stands now.
      const full = await api.getPineScript(s.id);
      indicators.add({ scriptId: full.id, name: full.name, source: full.source });
      setStatus(`Added “${full.name}” to ${props.symbol} ${props.interval}`);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeScript = async (s: PineScript): Promise<void> => {
    if (!window.confirm(`Delete “${s.name}” from the library? Studies already on a chart stay.`)) return;
    try {
      await api.deletePineScript(s.id);
      await refresh();
      setStatus(`Deleted “${s.name}” from the library`);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  /** Import one or more .pine files straight into the library. */
  const onFiles = async (files: FileList | null): Promise<void> => {
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

  // ── templates ────────────────────────────────────────────────────────────

  const saveTemplate = (): void => {
    const name = templateName.trim();
    if (name.length === 0 || applied.length === 0) return;
    const template = templateFromIndicators(name, applied);
    let result = upsertTemplate(templates, template);
    if (!result.ok && result.reason === "exists") {
      // Overwriting a template the operator built earlier is a decision, not a
      // side effect of reusing a name.
      if (!window.confirm(`A template called “${name}” already exists. Replace it?`)) return;
      result = upsertTemplate(templates, template, { overwrite: true });
    }
    if (!result.ok) {
      setStatus(result.reason === "full"
        ? "Template not saved: this browser is holding the maximum number of templates."
        : "Template not saved: give it a name and put at least one study on the chart first.");
      return;
    }
    persistTemplates(result.list);
    setTemplateName("");
    setStatus(`Saved template “${name}” — ${template.indicators.length} stud${
      template.indicators.length === 1 ? "y" : "ies"}`);
  };

  /**
   * Put a template's studies on the chart.
   *
   * `replace` clears what is there first and says so before doing it. Adding is
   * the default because it cannot lose anything.
   */
  const applyTemplate = (template: IndicatorTemplate, replace: boolean): void => {
    if (!indicators) return;
    if (replace && applied.length > 0) {
      const ok = window.confirm(
        `Replace the ${applied.length} stud${applied.length === 1 ? "y" : "ies"} on `
        + `${props.symbol} ${props.interval} with the ${template.indicators.length} in `
        + `“${template.name}”?`
      );
      if (!ok) return;
      indicators.clear();
    }
    for (const row of template.indicators) {
      const key = indicators.add({
        scriptId: row.scriptId, name: row.name, source: row.source, params: row.params,
      });
      // `add` always starts visible; a template that stored a hidden study
      // restores it hidden.
      if (!row.visible) indicators.toggleVisible(key);
    }
    setStatus(`Applied “${template.name}” to ${props.symbol} ${props.interval}`);
  };

  const removeTemplate = (template: IndicatorTemplate): void => {
    if (!window.confirm(`Delete the template “${template.name}”? Studies on the chart stay.`)) return;
    persistTemplates(deleteTemplate(templates, template.name));
    setStatus(`Deleted template “${template.name}”`);
  };

  const nameTaken = templateName.trim().length > 0
    && findTemplate(templates, templateName) !== null;

  return (
    <Modal open={open} onClose={onClose} wide title="Indicators">
      {/* ── search ── */}
      <input
        ref={searchRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search this installation’s scripts and templates…"
        aria-label="Search indicators"
        className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
      />

      {/* ── categories, all derived from real data ── */}
      <div role="group" aria-label="Indicator category" className="mt-3 flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => {
          const active = category === c.id;
          const count = c.id === "templates"
            ? templates.length
            : c.id === "onChart"
              ? applied.length
              : c.id === "all"
                ? library.length
                : library.filter((s) => s.kind === c.id).length;
          return (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              aria-pressed={active}
              className={`${CHIP} ${
                active ? "bg-ink font-medium text-bg" : "bg-surface-2 text-ink-muted hover:text-ink"
              }`}
            >
              {c.label}
              <span className={`ml-1.5 tabular ${active ? "text-bg/70" : "text-ink-faint"}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {libraryError && (
        <p role="alert" className="mt-3 rounded border border-down/30 bg-down/10 px-3 py-2 text-[12px] text-down">
          The script library could not be read: {libraryError}. Nothing on the chart changed.
        </p>
      )}

      {category === "templates" ? (
        <TemplateList
          templates={filteredTemplates}
          totalTemplates={templates.length}
          canApply={indicators !== null}
          onApply={applyTemplate}
          onDelete={removeTemplate}
        />
      ) : (
        <div className="mt-3 flex flex-col gap-1">
          {filtered.length === 0 && !libraryError && (
            <p className="py-6 text-center text-[12px] text-ink-faint">
              {library.length === 0
                ? "No scripts saved yet. Import a .pine file below, or write one in the Pine Editor."
                : "No script matches that search."}
            </p>
          )}
          {filtered.map((s) => {
            const count = appliedCount(s);
            return (
              <div key={s.id} className="flex items-center gap-2 rounded border border-border px-2 py-1.5 hover:bg-surface-2">
                <span className={`shrink-0 rounded px-1 text-[9px] font-semibold uppercase ${
                  s.kind === "strategy" ? "bg-accent/15 text-accent" : "bg-border text-ink-muted"
                }`}>
                  {s.kind === "strategy" ? "Str" : "Ind"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{s.name}</span>
                  <span className="block truncate text-[11px] text-ink-faint">
                    {/*
                      Truthful state: how many copies of THIS script are on the
                      focused chart, not a generic "added" flag — the same script
                      can be applied twice with different inputs.
                    */}
                    {count > 0
                      ? `On this chart · ${count} instance${count === 1 ? "" : "s"}`
                      : `Saved ${s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : "locally"}`}
                  </span>
                </span>
                <button
                  onClick={() => void addScript(s)}
                  disabled={busy || !indicators}
                  className={ACTION}
                  title={indicators
                    ? `Add “${s.name}” to ${props.symbol} ${props.interval}`
                    : "The focused chart is still preparing"}
                >
                  Add
                </button>
                <button
                  onClick={() => void api.getPineScript(s.id).then(props.onOpenInEditor).then(onClose)}
                  className={ACTION}
                  title="Open in the Pine Editor"
                >
                  Edit
                </button>
                <button
                  onClick={() => void removeScript(s)}
                  className={`${ACTION} hover:border-down hover:text-down`}
                  title="Delete from the library"
                  aria-label={`Delete ${s.name} from the library`}
                >
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── save the focused chart's studies as a template ── */}
      <div className="mt-4 border-t border-border pt-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Save these studies as a template
        </div>
        <p className="mt-0.5 text-[11px] leading-tight text-ink-faint">
          Studies and their inputs only — not the symbol, timeframe or chart layout. Stored in this
          browser.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveTemplate(); } }}
            placeholder="Template name"
            aria-label="Template name"
            className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
          />
          <button
            onClick={saveTemplate}
            disabled={templateName.trim().length === 0 || applied.length === 0}
            className={ACTION}
          >
            {nameTaken ? "Replace…" : "Save template"}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-ink-faint">
          {applied.length === 0
            ? "Nothing is on this chart yet, so there is nothing to save."
            : `${applied.length} stud${applied.length === 1 ? "y" : "ies"} on ${props.symbol} ${props.interval}.`}
          {nameTaken && " That name already exists — saving asks before replacing it."}
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".pine,.txt"
        multiple
        hidden
        onChange={(e) => void onFiles(e.target.files)}
      />

      {status && (
        <p role="status" className="mt-3 truncate text-[11px] text-ink-muted" title={status}>{status}</p>
      )}

      <div className="mt-3 border-t border-border pt-3 text-[11px] text-ink-faint">
        Adds land on the focused chart — <span className="font-semibold text-ink-muted">
          {props.symbol} {props.interval}</span>.
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className={`${ACTION} ml-2`}
          title="Import .pine files from disk"
        >
          Import .pine
        </button>
      </div>
    </Modal>
  );
}

function TemplateList({
  templates, totalTemplates, canApply, onApply, onDelete,
}: {
  templates: IndicatorTemplate[];
  totalTemplates: number;
  canApply: boolean;
  onApply: (template: IndicatorTemplate, replace: boolean) => void;
  onDelete: (template: IndicatorTemplate) => void;
}) {
  if (templates.length === 0) {
    return (
      <p className="py-6 text-center text-[12px] text-ink-faint">
        {totalTemplates === 0
          ? "No templates yet. Put the studies you want on a chart, then name and save them below."
          : "No template matches that search."}
      </p>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-1">
      {templates.map((t) => (
        <div key={t.name} className="flex items-center gap-2 rounded border border-border px-2 py-1.5 hover:bg-surface-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-ink">{t.name}</span>
            <span className="block truncate text-[11px] text-ink-faint">
              {t.indicators.length} stud{t.indicators.length === 1 ? "y" : "ies"}
              {t.createdAt ? ` · saved ${new Date(t.createdAt).toLocaleDateString()}` : ""}
            </span>
          </span>
          <button onClick={() => onApply(t, false)} disabled={!canApply} className={ACTION}
            title="Add this template's studies to the focused chart">
            Add
          </button>
          <button onClick={() => onApply(t, true)} disabled={!canApply} className={ACTION}
            title="Clear the focused chart's studies and apply this template instead">
            Replace
          </button>
          <button onClick={() => onDelete(t)} className={`${ACTION} hover:border-down hover:text-down`}
            aria-label={`Delete the template ${t.name}`}>
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
