"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { PALETTE, type Drawing, type DrawingTool } from "@/lib/drawings";
import { isResolution, NATIVE_RESOLUTIONS, type Resolution } from "@/lib/resolution";

type Tab = "style" | "text" | "coordinates" | "visibility";
const TEXT_TOOLS: ReadonlySet<DrawingTool> = new Set([
  "text", "note", "priceNote", "comment", "callout", "signpost", "flagMark",
]);

/** Shared advanced drawing editor. The quick floating toolbar remains intact. */
export function DrawingSettingsModal({
  open, drawing, onClose, onChange, interval,
}: {
  open: boolean;
  drawing: Drawing | null;
  onClose: () => void;
  onChange: (drawing: Drawing) => void;
  interval?: Resolution;
}) {
  const [tab, setTab] = useState<Tab>("style");
  const [draft, setDraft] = useState<Drawing | null>(drawing);
  useEffect(() => { if (open && drawing) { setDraft(drawing); setTab("style"); } }, [open, drawing]);
  if (!open || !draft) return null;

  const patchStyle = (patch: Partial<Drawing["style"]>) => setDraft((current) => current ? { ...current, style: { ...current.style, ...patch } } : current);
  const updatePoint = (index: number, key: "time" | "price", value: number) => setDraft((current) => current ? { ...current, points: current.points.map((point, i) => i === index ? { ...point, [key]: value } : point) } : current);

  return <Modal open onClose={onClose} title={`${draft.tool[0]?.toUpperCase() ?? "Drawing"}${draft.tool.slice(1)} settings`} wide
    footer={<><button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-2">Cancel</button><button onClick={() => { onChange(draft); onClose(); }} className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90">Apply</button></>}>
    <div className="flex min-h-[340px] gap-5">
      <nav aria-label="Drawing settings sections" className="w-36 shrink-0 border-r border-border pr-3">
        {(["style", "text", "coordinates", "visibility"] as Tab[]).map((id) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} disabled={id === "text" && !TEXT_TOOLS.has(draft.tool)} className={`mb-0.5 flex min-h-8 w-full items-center rounded px-2.5 text-left text-sm capitalize ${tab === id ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"}`}>{id}</button>)}
      </nav>
      <section role="tabpanel" className="min-w-0 flex-1">
        {tab === "style" && <div className="space-y-4"><h3 className="text-sm font-semibold text-ink">Style</h3><div><p className="mb-2 text-xs text-ink-muted">Color</p><div className="flex flex-wrap gap-2">{PALETTE.map((color) => <button key={color} onClick={() => patchStyle({ color })} aria-label={`Use ${color}`} aria-pressed={draft.style.color === color} className={`h-7 w-7 rounded-full border-2 ${draft.style.color === color ? "border-ink" : "border-transparent"}`} style={{ backgroundColor: color }} />)}</div></div><label className="flex max-w-xs items-center justify-between gap-4 text-sm">Line width<select value={draft.style.width} onChange={(e) => patchStyle({ width: Number(e.target.value) })} className="rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink">{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}px</option>)}</select></label><Toggle label="Dashed" checked={Boolean(draft.style.dashed)} onChange={(v) => patchStyle({ dashed: v })} /><Toggle label="Fill" checked={Boolean(draft.style.filled)} onChange={(v) => patchStyle({ filled: v })} /></div>}
        {tab === "text" && <div className="space-y-3"><h3 className="text-sm font-semibold text-ink">Text</h3><label className="block text-sm"><span className="mb-1 block text-xs text-ink-muted">Caption</span><textarea rows={4} value={draft.style.text ?? ""} onChange={(e) => patchStyle({ text: e.target.value })} className="w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink" /></label><p className="text-xs text-ink-faint">Text is stored with this drawing and follows it when moved.</p></div>}
        {tab === "coordinates" && <div className="space-y-3"><h3 className="text-sm font-semibold text-ink">Coordinates</h3><p className="text-xs text-ink-muted">Edit chart-space anchors directly. Changes are applied only after pressing Apply.</p>{draft.points.map((point, index) => <div key={index} className="grid grid-cols-[auto_1fr_1fr] items-center gap-2"><span className="text-xs text-ink-faint">Point {index + 1}</span><label className="text-xs text-ink-muted">Time<input type="number" value={point.time} onChange={(e) => updatePoint(index, "time", Number(e.target.value))} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1 text-sm text-ink" /></label><label className="text-xs text-ink-muted">Price<input type="number" step="any" value={point.price} onChange={(e) => updatePoint(index, "price", Number(e.target.value))} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1 text-sm text-ink" /></label></div>)}</div>}
        {tab === "visibility" && <VisibilityEditor draft={draft} interval={interval} onChange={(visibleOn) => setDraft((current) => current ? { ...current, visibleOn: visibleOn.length === 0 ? undefined : visibleOn } : current)} />}
      </section>
    </div>
  </Modal>;
}

function VisibilityEditor({ draft, interval, onChange }: {
  draft: Drawing; interval?: Resolution; onChange: (visibleOn: Resolution[]) => void;
}) {
  const selected = draft.visibleOn ?? [];
  const resolutions = interval && isResolution(interval) && !NATIVE_RESOLUTIONS.includes(interval)
    ? [interval, ...NATIVE_RESOLUTIONS]
    : NATIVE_RESOLUTIONS;
  const toggle = (resolution: Resolution) => onChange(
    selected.includes(resolution) ? selected.filter((item) => item !== resolution) : [...selected, resolution]
  );
  return <div className="space-y-3"><h3 className="text-sm font-semibold text-ink">Visibility</h3><p className="text-sm leading-relaxed text-ink-muted">Show this drawing only on selected chart timeframes. Leave every box clear to show it everywhere.</p><div className="grid grid-cols-2 gap-2">{resolutions.map((resolution) => <label key={resolution} className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${interval === resolution ? "border-accent/60" : "border-border"}`}><input type="checkbox" checked={selected.includes(resolution)} onChange={() => toggle(resolution)} />{resolution}{interval === resolution ? <span className="text-[10px] text-accent">current</span> : null}</label>)}</div><div className="rounded border border-border bg-surface-2 px-3 py-2 text-xs text-ink-faint">{selected.length === 0 ? "Visibility: Every timeframe" : `Visible on ${selected.length} timeframe${selected.length === 1 ? "" : "s"}`}</div></div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex max-w-xs items-center justify-between gap-4 text-sm"><span>{label}</span><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /></label>;
}
