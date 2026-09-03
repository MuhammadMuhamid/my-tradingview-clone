"use client";
/**
 * Choosing the workspace's shape.
 *
 * Counts first, because that is the question a user actually has ("I want four
 * charts"), then the variants for the chosen count. One to four are one click
 * away; everything up to sixteen is reachable from the same menu rather than
 * hidden behind a plan or a settings page — this product has no subscription
 * tiers to enforce and inventing them would be a lie about the software.
 *
 * Each variant draws itself from its own preset data, so a preset added to
 * `lib/layoutPresets` appears here with a correct thumbnail and no edit.
 */
import { useEffect, useRef, useState } from "react";
import {
  availablePaneCounts, defaultPresetFor, presetOrDefault, presetsForCount,
  type LayoutPreset,
} from "@/lib/layoutPresets";

/** A miniature of the preset's grid, drawn from the same cells the host uses. */
function PresetThumbnail({ preset }: { preset: LayoutPreset }) {
  const unit = 22 / Math.max(preset.cols, preset.rows);
  const w = unit * preset.cols;
  const h = unit * preset.rows;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="shrink-0">
      {preset.cells.map((cell, index) => (
        <rect
          key={index}
          x={(cell.col - 1) * unit + 0.6}
          y={(cell.row - 1) * unit + 0.6}
          width={cell.colSpan * unit - 1.2}
          height={cell.rowSpan * unit - 1.2}
          rx="1"
          fill="currentColor"
          opacity="0.65"
        />
      ))}
    </svg>
  );
}

export function LayoutSelector({
  presetId, onChange,
}: {
  presetId: string;
  onChange: (presetId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = presetOrDefault(presetId);
  const [count, setCount] = useState(current.panes);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setCount(current.panes); }, [current.panes]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const counts = availablePaneCounts();
  const variants = presetsForCount(count);

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Chart layout"
        aria-label={`Chart layout — ${current.label}`}
        aria-expanded={open}
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors ${
          open ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
        }`}
      >
        <span className="text-ink-muted"><PresetThumbnail preset={current} /></span>
        {current.panes > 1 && (
          <span className="tabular text-[11px] text-ink">{current.panes}</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-[34px] z-50 w-[270px] rounded-md border border-border bg-surface p-2 shadow-xl">
          <div className="px-1 pb-1.5 text-[10px] uppercase tracking-wide text-ink-faint">
            Charts in this layout
          </div>
          <div className="flex flex-wrap gap-1">
            {counts.map((n) => (
              <button
                key={n}
                onClick={() => {
                  setCount(n);
                  // Picking a count applies its default shape immediately;
                  // the variants below refine it without a second trip here.
                  onChange(defaultPresetFor(n).id);
                }}
                aria-pressed={count === n}
                className={`tabular h-7 min-w-[28px] rounded px-1.5 text-[12px] transition-colors ${
                  count === n
                    ? "bg-surface-2 font-semibold text-ink"
                    : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
                }`}
              >
                {n}
              </button>
            ))}
          </div>

          <div className="px-1 pb-1.5 pt-3 text-[10px] uppercase tracking-wide text-ink-faint">
            Arrangement
          </div>
          <div className="flex flex-col gap-0.5">
            {variants.map((preset) => (
              <button
                key={preset.id}
                onClick={() => { onChange(preset.id); setOpen(false); }}
                aria-pressed={preset.id === current.id}
                className={`flex items-center gap-2.5 rounded px-2 py-1.5 text-left text-[12px] transition-colors ${
                  preset.id === current.id
                    ? "bg-surface-2 text-ink"
                    : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
                }`}
              >
                <PresetThumbnail preset={preset} />
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
