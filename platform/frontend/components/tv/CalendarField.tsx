"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useExclusivePopover } from "@/lib/useExclusivePopover";

/*
 * ── A date and time the product draws itself ───────────────────────────────
 *
 * TVP8: Replay picked its starting bar with `<input type="datetime-local">`.
 *
 * That is the browser's control, not the product's. Chrome draws its own
 * calendar in the platform's font, on the platform's ground, with the
 * platform's own today-marker and its own idea of what a month looks like;
 * Safari draws a stepper instead and no calendar at all. It also cannot know
 * which days this chart HAS bars for, so the one question the picker exists to
 * answer — where can I start? — was left to a `min`/`max` pair and a shrug.
 *
 * The reference opens a calendar. So does this: one month at a time, the days
 * outside the data dimmed and unclickable, today ringed, the chosen day a
 * neutral chip, and the time beside it. It is used by Replay's "start here"
 * and by the time axis's "Go to…", which is the second half of why it exists
 * — two surfaces that both needed a calendar, and neither of which should
 * have grown its own.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

/** Local midnight of the day `time` falls in. */
function startOfDay(time: number): number {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `Monday = 0`, which is the column order above. */
function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** `HH:MM` in local time, for the time field beside the grid. */
function timeValue(time: number): string {
  const d = new Date(time);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The days a month grid covers, padded to whole weeks. */
export function monthGrid(monthAnchor: number): number[] {
  const anchor = new Date(monthAnchor);
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = first.getTime() - mondayIndex(first) * DAY_MS;
  const next = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1).getTime();
  const cells: number[] = [];
  for (let t = start; t < next || cells.length % 7 !== 0; t += DAY_MS) {
    cells.push(startOfDay(t));
    // A month can need six rows; nothing needs seven, and an unbounded loop
    // here would hang the tab rather than draw a wrong calendar.
    if (cells.length >= 42) break;
  }
  return cells;
}

export function CalendarField({
  value, onChange, min, max, id, label, disabled = false, className = "",
}: {
  /** Epoch ms, or null for "nothing chosen yet". */
  value: number | null;
  onChange: (time: number) => void;
  /** The first and last instants the data covers; days outside are unpickable. */
  min?: number;
  max?: number;
  /** Distinct per instance — it is the exclusive-popover key. */
  id: string;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useExclusivePopover(`calendar:${id}`);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [month, setMonth] = useState(() => value ?? max ?? Date.now());

  /*
   * ── TVP8: the calendar is a PORTAL ────────────────────────────────────────
   *
   * It was `absolute bottom-full` inside its anchor. That works in the Replay
   * strip and is invisible in the Go-to dialog: `Modal`'s body is
   * `overflow-y-auto`, so a popover positioned above a control near the top of
   * an 80px-tall body is clipped into scroll space the user cannot reach. The
   * whole "Go to…" feature was unreachable by its only route.
   *
   * Portalled to `document.body` and positioned against the trigger's viewport
   * rect, it escapes every `overflow` ancestor. It opens BELOW when there is
   * room and flips above when there is not, which is what the control does in
   * the toolbar strip where it opens upward.
   */
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const PANEL = { width: 248, height: 300 };
  useLayoutEffect(() => {
    if (!open) { setAt(null); return; }
    const place = (): void => {
      const trigger = anchorRef.current?.firstElementChild;
      if (!trigger) return;
      const box = trigger.getBoundingClientRect();
      const below = window.innerHeight - box.bottom;
      const top = below >= PANEL.height + 8
        ? box.bottom + 4
        : Math.max(8, box.top - PANEL.height - 4);
      const left = Math.min(
        Math.max(8, box.left),
        Math.max(8, window.innerWidth - PANEL.width - 8));
      setAt({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, PANEL.height, PANEL.width]);

  // Reopening on a chosen date shows that date's month, not the last one browsed.
  useEffect(() => { if (open) setMonth(value ?? max ?? Date.now()); }, [open, value, max]);

  useEffect(() => {
    if (!open) return;
    const inside = (node: Node | null): boolean =>
      Boolean(anchorRef.current?.contains(node) || popoverRef.current?.contains(node));
    const onDown = (e: MouseEvent): void => {
      if (!inside(e.target as Node)) setOpen(false);
    };
    /*
     * TVP8: capture, and stop it.
     *
     * `Modal` binds Escape on `document` in the CAPTURE phase, so a bubbling
     * listener here never ran first: pressing Escape with the calendar open
     * closed the whole Go-to dialog instead of the calendar. Escape closes the
     * innermost thing, which is the only behaviour anyone expects.
     */
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, setOpen]);

  const cells = useMemo(() => monthGrid(month), [month]);
  const monthLabel = new Date(month).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const inRange = (day: number): boolean =>
    (min === undefined || day >= startOfDay(min)) && (max === undefined || day <= startOfDay(max));

  /** Keep the time of day when the day changes, so picking a date is one click. */
  const chooseDay = (day: number): void => {
    const base = value ?? max ?? Date.now();
    const d = new Date(day);
    const keep = new Date(base);
    d.setHours(keep.getHours(), keep.getMinutes(), 0, 0);
    const clamped = Math.min(Math.max(d.getTime(), min ?? -Infinity), max ?? Infinity);
    onChange(clamped);
    setOpen(false);
  };

  const shiftMonth = (by: number): void => {
    const d = new Date(month);
    setMonth(new Date(d.getFullYear(), d.getMonth() + by, 1).getTime());
  };

  return (
    <div ref={anchorRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        className="tvc-control flex h-[26px] items-center gap-1.5 rounded border border-control-border px-1.5 text-[13px] text-ink disabled:opacity-40"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.7" className="shrink-0 text-ink-faint" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
        <span className="tabular">
          {value === null ? "Pick a date" : new Date(value).toLocaleString(undefined, {
            year: "numeric", month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit",
          })}
        </span>
      </button>

      {open && at && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={label}
          style={{ left: at.left, top: at.top, width: PANEL.width }}
          className="tvc-popover ts-app fixed z-[60] border border-border p-2"
        >
          <div className="mb-1 flex items-center justify-between">
            <button type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month"
              className="tvc-control flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:text-ink">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
                strokeWidth="1.8" aria-hidden="true"><path d="M7.5 2L3.5 6l4 4" /></svg>
            </button>
            <span className="text-[13px] font-medium text-ink">{monthLabel}</span>
            <button type="button" onClick={() => shiftMonth(1)} aria-label="Next month"
              className="tvc-control flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:text-ink">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
                strokeWidth="1.8" aria-hidden="true"><path d="M4.5 2l4 4-4 4" /></svg>
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5" role="grid">
            {WEEKDAYS.map((d) => (
              <span key={d} className="py-0.5 text-center text-[10px] text-ink-faint">{d}</span>
            ))}
            {cells.map((day) => {
              const outside = new Date(day).getMonth() !== new Date(month).getMonth();
              const pickable = inRange(day);
              const chosen = value !== null && sameDay(day, value);
              return (
                <button
                  key={day}
                  type="button"
                  role="gridcell"
                  disabled={!pickable}
                  aria-selected={chosen}
                  onClick={() => chooseDay(day)}
                  title={!pickable ? "No bars loaded for this day" : undefined}
                  className={`h-6 rounded text-[12px] tabular ${
                    chosen ? "bg-state-active text-ink"
                      : outside ? "text-ink-faint" : "text-ink-muted"
                  } ${pickable ? "hover:bg-state-hover hover:text-ink" : "cursor-not-allowed opacity-30"} ${
                    sameDay(day, Date.now()) && !chosen ? "border border-border-strong" : ""
                  }`}
                >
                  {new Date(day).getDate()}
                </button>
              );
            })}
          </div>

          <label className="mt-2 flex items-center gap-2">
            <span className="text-[11px] text-ink-muted">Time</span>
            <input
              type="time"
              value={value === null ? "" : timeValue(value)}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return;
                const d = new Date(value ?? max ?? Date.now());
                d.setHours(h, m, 0, 0);
                onChange(Math.min(Math.max(d.getTime(), min ?? -Infinity), max ?? Infinity));
              }}
              className="h-[26px] flex-1 rounded border border-control-border bg-transparent px-1.5 text-[13px] tabular text-ink outline-none focus:border-accent"
            />
          </label>
        </div>,
        document.body,
      )}
    </div>
  );
}
