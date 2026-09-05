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
 * ── Why the counts are split into two rows ─────────────────────────────────
 *
 * Sixteen equally-weighted number buttons is a keypad, not a choice: the four
 * layouts a trader actually switches between all day sat in the same grey wrap
 * as "thirteen". The common four are now a labelled row with real thumbnails,
 * and the rest are a second row underneath, still one click and still
 * unrestricted. Nothing became unreachable; the frequent cases stopped being
 * as expensive to find as the rare ones.
 *
 * Each variant draws itself from its own preset data, so a preset added to
 * `lib/layoutPresets` appears here with a correct thumbnail and no edit.
 */
import { useEffect, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import {
  availablePaneCounts, defaultPresetFor, presetOrDefault, presetsForCount,
  type LayoutPreset,
} from "@/lib/layoutPresets";

/** The pane counts that get a first-class button with a thumbnail. */
const COMMON_COUNTS = [1, 2, 3, 4];

/** A miniature of the preset's grid, drawn from the same cells the host uses. */
function PresetThumbnail({ preset, size = 22 }: { preset: LayoutPreset; size?: number }) {
  const unit = size / Math.max(preset.cols, preset.rows);
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

/**
 * The mark on the arrangement this workspace is actually in.
 *
 * A tick rather than a background tint alone: "which layout am I in" is state,
 * and state told only by a slightly lighter grey is unreadable on a dark panel
 * and invisible to anyone who cannot separate the two greys at all.
 */
function CurrentMark() {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-accent">
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 6.5l2.5 2.5 4.5-5.5" />
      </svg>
      Current
    </span>
  );
}

export function LayoutSelector({
  presetId, onChange,
}: {
  presetId: string;
  onChange: (presetId: string) => void;
}) {
  // One popover open at a time across the whole toolbar — these menus
  // hang off buttons a few pixels apart, so two open at once overlap and
  // compete for the same clicks. See `lib/popoverGroup`.
  const [open, setOpen] = useExclusivePopover("layout-preset");
  const current = presetOrDefault(presetId);
  const [count, setCount] = useState(current.panes);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { setCount(current.panes); }, [current.panes]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Escape must return the keyboard to the control that opened the menu,
      // or the next Tab starts from the top of the document.
      buttonRef.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open, setOpen]);

  // Move the keyboard into the menu when it opens, so the counts are reachable
  // without tabbing back through the whole toolbar.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open, setOpen]);

  const counts = availablePaneCounts();
  const common = counts.filter((n) => COMMON_COUNTS.includes(n));
  const rest = counts.filter((n) => !COMMON_COUNTS.includes(n));
  const variants = presetsForCount(count);

  const countButton = (n: number, withThumbnail: boolean) => {
    const isCurrent = current.panes === n;
    const isBrowsing = count === n;
    return (
      <button
        key={n}
        onClick={() => {
          setCount(n);
          // Picking a count applies its default shape immediately;
          // the variants below refine it without a second trip here.
          onChange(defaultPresetFor(n).id);
        }}
        aria-pressed={isBrowsing}
        aria-label={`${n} chart${n === 1 ? "" : "s"}${isCurrent ? " — current layout" : ""}`}
        title={defaultPresetFor(n).label}
        className={`tabular flex h-7 shrink-0 items-center justify-center gap-1.5 rounded px-1.5 text-[12px] transition-colors ${
          withThumbnail ? "min-w-[46px]" : "min-w-[28px]"
        } ${
          isBrowsing
            ? "bg-surface-2 font-semibold text-ink border border-accent/60"
            : "border border-transparent text-ink-muted hover:bg-surface-2/60 hover:text-ink"
        }`}
      >
        {withThumbnail && (
          <span className={isCurrent ? "text-accent" : "text-ink-faint"}>
            <PresetThumbnail preset={defaultPresetFor(n)} size={14} />
          </span>
        )}
        {n}
      </button>
    );
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        title="Chart layout"
        aria-label={`Chart layout — ${current.label}`}
        aria-expanded={open}
        aria-haspopup="menu"
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
        <div ref={menuRef} role="menu" aria-label="Chart layout"
          className="absolute right-0 top-[34px] z-50 w-[276px] rounded-md border border-border bg-surface p-2 shadow-xl">
          <div className="px-1 pb-1.5 text-[10px] uppercase tracking-wide text-ink-faint">
            Charts in this layout
          </div>
          <div className="flex flex-wrap gap-1">
            {common.map((n) => countButton(n, true))}
          </div>

          {rest.length > 0 && (
            <>
              <div className="px-1 pb-1.5 pt-2.5 text-[10px] uppercase tracking-wide text-ink-faint">
                More charts
              </div>
              <div className="flex flex-wrap gap-1">
                {rest.map((n) => countButton(n, false))}
              </div>
            </>
          )}

          <div className="px-1 pb-1.5 pt-3 text-[10px] uppercase tracking-wide text-ink-faint">
            Arrangement
          </div>
          <div className="flex flex-col gap-0.5">
            {variants.map((preset) => {
              const isCurrent = preset.id === current.id;
              return (
                <button
                  key={preset.id}
                  role="menuitemradio"
                  aria-checked={isCurrent}
                  onClick={() => { onChange(preset.id); setOpen(false); }}
                  className={`flex items-center gap-2.5 rounded px-2 py-1.5 text-left text-[12px] transition-colors ${
                    isCurrent
                      ? "bg-surface-2 text-ink"
                      : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
                  }`}
                >
                  <span className={isCurrent ? "text-accent" : undefined}>
                    <PresetThumbnail preset={preset} />
                  </span>
                  {preset.label}
                  {isCurrent && <CurrentMark />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
