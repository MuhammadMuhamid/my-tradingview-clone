"use client";
/**
 * Choosing the workspace's shape.
 *
 * One row per pane count, each row holding EVERY arrangement for that count
 * as a thumbnail — which is the reference's own menu, measured live on
 * Premium (2026-10-11): `1` beside one square, `4` beside ten grids, down to
 * `16`. The earlier menu asked for a count first and showed that count's
 * arrangements only after a second trip, with 5–16 as bare numerals; the
 * reference shows the whole space at once, so a shape is one click whatever it
 * is. Every count up to sixteen is in the same menu — this product has no
 * subscription tiers to enforce and inventing them would be a lie about the
 * software.
 *
 * Each variant draws itself from its own preset data, so a preset added to
 * `lib/layoutPresets` appears here with a correct thumbnail and no edit.
 */
import { useEdgeClamp } from "@/lib/useEdgeClamp";
import { useEffect, useRef } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import {
  availablePaneCounts, presetOrDefault, presetsForCount,
  type LayoutPreset,
} from "@/lib/layoutPresets";
import { TOOL_ICON_BUTTON, TOOL_ICON_STROKE } from "@/components/tv/toolbarChrome";

/**
 * An arrangement, drawn as line work — for the button on the bar and for
 * every cell of the menu.
 *
 * The glyph IS the control: there is no label, the button is 38px, and a
 * filled square inside a chip that also fills on hover reads as a pressed
 * state rather than as an icon — which is exactly how an earlier washed
 * thumbnail was read. TradingView draws plain outlines on the bar and in its
 * layout menu alike, and an outline still says "a frame holding panes" at one
 * pane and at sixteen.
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
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const edgeClamp = useEdgeClamp(menuRef, open);
  const buttonRef = useRef<HTMLButtonElement>(null);

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
          className="absolute right-0 top-full z-50 tvc-menu px-2">
          {counts.map((n, index) => (
            /*
              The menu's row grammar, as a row of CELLS: the count is the row,
              each arrangement a 38px target inside it. `data-cell-row` keeps
              the row itself from lighting on hover — on the reference only the
              cell under the pointer does.
            */
            <div key={n} role="group" aria-label={`${n} chart${n === 1 ? "" : "s"}`} data-cell-row=""
              className={`tvc-menu-row gap-0.5 py-0.5 ${index > 0 ? "border-t border-border" : ""}`}>
              {/* The count, muted, as the reference's row label. */}
              <span aria-hidden="true" className="tabular w-6 shrink-0 pl-1 text-[12px] text-ink-faint">{n}</span>
              {presetsForCount(n).map((preset) => {
                const isCurrent = preset.id === current.id;
                return (
                  <button
                    key={preset.id}
                    role="menuitemradio"
                    aria-checked={isCurrent}
                    aria-label={preset.label}
                    data-tooltip={preset.label}
                    onClick={() => { onChange(preset.id); setOpen(false); }}
                    /*
                      A 38px icon cell, the bar's own control grammar: the
                      chosen arrangement wears the selected chip, which is how
                      the reference marks it — no tick, no label.
                    */
                    className={`${TOOL_ICON_BUTTON} ${isCurrent ? "text-ink" : "text-ink-muted hover:text-ink"}`}
                  >
                    <LayoutGlyph preset={preset} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
