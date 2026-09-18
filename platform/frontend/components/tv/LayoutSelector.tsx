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
import { useEdgeClamp } from "@/lib/useEdgeClamp";
import { useEffect, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import {
  availablePaneCounts, defaultPresetFor, presetOrDefault, presetsForCount,
  type LayoutPreset,
} from "@/lib/layoutPresets";
import { TOOL_ICON_BUTTON, TOOL_ICON_STROKE } from "@/components/tv/toolbarChrome";

/** The pane counts that get a first-class button with a thumbnail. */
const COMMON_COUNTS = [1, 2, 3, 4];

/**
 * A miniature of the preset's grid, drawn from the same cells the host uses.
 *
 * Outlined panes with a faint wash, not solid blocks: at 0.65 fill the
 * single-pane preset was a featureless light-grey square, which looks like a
 * rendering fault rather than an icon. The wash is what separates one row's
 * shape from the next inside the menu; the BAR uses `LayoutGlyph` below, with
 * no fill at all, because there the glyph sits in a chip that fills on hover.
 */
function PresetThumbnail({ preset, size = 18 }: { preset: LayoutPreset; size?: number }) {
  const unit = size / Math.max(preset.cols, preset.rows);
  const w = unit * preset.cols;
  const h = unit * preset.rows;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="shrink-0">
      {preset.cells.map((cell, index) => (
        <rect
          key={index}
          x={(cell.col - 1) * unit + 1}
          y={(cell.row - 1) * unit + 1}
          width={cell.colSpan * unit - 2}
          height={cell.rowSpan * unit - 2}
          rx="1"
          fill="currentColor"
          fillOpacity="0.18"
          stroke="currentColor"
          strokeWidth="1.2"
        />
      ))}
    </svg>
  );
}

/**
 * The same arrangement, drawn as line work, for the button on the bar.
 *
 * `PresetThumbnail` washes each pane at 0.18 because in a menu row it sits
 * beside a label and only has to be told apart from the row above it. On the
 * bar the glyph IS the control: there is no label, the button is 38px, and a
 * filled 22px square inside a chip that also fills on hover reads as a pressed
 * state rather than as an icon — which is exactly how it was read. TradingView
 * draws a plain outline square here, and an outline still says "a frame holding
 * panes" at one pane and at sixteen.
 *
 * The stroke thins and the panes close up past a 2×2 grid, because 1.5px of
 * stroke on a 3.4px cell is a blob rather than a cell.
 *
 * ── TVP8 R1b-03: the BOX is 19×17, not a 22px square ──────────────────────
 *
 * Measured on the reference, this cell's glyph is a 19×17 rounded rectangle —
 * wider than it is tall, like the window it stands for. Ours drew a 22×22
 * square, the largest glyph on the bar where the reference's is one of the
 * smaller ones. The grid inside it is a SCHEMATIC, so the cells are scaled to
 * the box on each axis independently rather than kept square: a 3×1 preset is
 * three columns of the same window, not a 3:1 letterbox.
 */
const LAYOUT_GLYPH_W = 19;
const LAYOUT_GLYPH_H = 17;

function LayoutGlyph(props: { preset: LayoutPreset; w?: number; h?: number }) {
  const { preset, w = LAYOUT_GLYPH_W, h = LAYOUT_GLYPH_H } = props;
  const unitX = w / preset.cols;
  const unitY = h / preset.rows;
  const dense = Math.max(preset.cols, preset.rows) > 2;
  const stroke = dense ? 1.1 : TOOL_ICON_STROKE;
  const inset = dense ? 0.7 : stroke / 2;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {preset.cells.map((cell, index) => (
        <rect
          key={index}
          x={(cell.col - 1) * unitX + inset}
          y={(cell.row - 1) * unitY + inset}
          width={cell.colSpan * unitX - inset * 2}
          height={cell.rowSpan * unitY - inset * 2}
          rx="1.5"
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
    <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
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
  const edgeClamp = useEdgeClamp(menuRef, open);
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
          // the variants can be chosen on a later trip. Close now so the new
          // pane is immediately reachable instead of sitting under this menu.
          onChange(defaultPresetFor(n).id);
          setOpen(false);
        }}
        aria-pressed={isBrowsing}
        aria-label={`${n} chart${n === 1 ? "" : "s"}${isCurrent ? " — current layout" : ""}`}
        data-tooltip={defaultPresetFor(n).label}
        className={`tabular flex h-7 shrink-0 items-center justify-center gap-1.5 rounded px-1.5 text-[12px] ${
          withThumbnail ? "min-w-[46px]" : "min-w-[28px]"
        } tvc-control ${
          isBrowsing ? "font-semibold text-ink" : "text-ink-muted hover:text-ink"
        }`}
      >
        {withThumbnail && (
          <span className={isCurrent ? "text-ink" : "text-ink-faint"}>
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
        data-tooltip="Chart layout"
        aria-label={`Chart layout — ${current.label}`}
        aria-expanded={open}
        aria-haspopup="menu"
        /*
          A 38x38 icon cell, like every other icon on the bar. It carried a
          pane-count DIGIT beside the thumbnail, which made it the one control
          whose width changed with its value — and the count is already the
          thing the glyph draws.
        */
        className={`${TOOL_ICON_BUTTON} ${open ? "text-ink" : ""}`}
      >
        <LayoutGlyph preset={current} />
      </button>

      {open && (
        <div ref={menuRef} role="menu" aria-label="Chart layout"
          style={edgeClamp}
          className="absolute right-0 top-full z-50 w-[276px] tvc-menu px-2">
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
                  /*
                    The row grammar, not a hand-rolled one. These sat at ~28px
                    inside a popover whose whole contract is 40px rows, and
                    painted their own selection — `aria-checked` above has been
                    announcing it all along, so `.tvc-menu-row` can read it.
                  */
                  className={`tvc-menu-row gap-2.5 px-2 text-left text-[12px] ${
                    isCurrent ? "text-ink" : "text-ink-muted"
                  }`}
                >
                  <span className={isCurrent ? "text-ink" : undefined}>
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
