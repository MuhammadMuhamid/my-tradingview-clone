"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { fmtChartMinute, instantOfWallClock, wallClockOf } from "@/lib/chartClock";
import type { ChartTimeZone } from "@/lib/chartSettings";

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

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

/*
 * ── W2D-08: every date here is read in ONE zone ─────────────────────────────
 *
 * The grid, the chosen day, the time field and the trigger's label all used
 * the browser's zone, while the surface Replay shows them beside — its clock,
 * the time axis — uses the chart's. `timeZone` is that zone, and every helper
 * below reads and writes wall clocks in it; omitted, it is the browser's own,
 * which is what Go to… has always used.
 */

/** Midnight, in `timeZone`, of the day `time` falls in. */
function startOfDay(time: number, timeZone?: string): number {
  const w = wallClockOf(time, timeZone);
  return instantOfWallClock({ ...w, hour: 0, minute: 0 }, timeZone);
}

/** The midnight `days` calendar days after the day `day` falls in. */
function addDays(day: number, days: number, timeZone?: string): number {
  const w = wallClockOf(day, timeZone);
  return instantOfWallClock({ ...w, day: w.day + days, hour: 0, minute: 0 }, timeZone);
}

/** `Monday = 0`, which is the column order above. */
function mondayIndex(day: number, timeZone?: string): number {
  const w = wallClockOf(day, timeZone);
  return (new Date(Date.UTC(w.year, w.month, w.day)).getUTCDay() + 6) % 7;
}

function sameDay(a: number, b: number, timeZone?: string): boolean {
  return startOfDay(a, timeZone) === startOfDay(b, timeZone);
}

/** `HH:MM` in `timeZone`, for the time field beside the grid. */
function timeValue(time: number, timeZone?: string): string {
  const w = wallClockOf(time, timeZone);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

/** The days a month grid covers, padded to whole weeks. */
export function monthGrid(monthAnchor: number, timeZone?: string): number[] {
  const anchor = wallClockOf(monthAnchor, timeZone);
  const first = instantOfWallClock({ ...anchor, day: 1, hour: 0, minute: 0 }, timeZone);
  const start = addDays(first, -mondayIndex(first, timeZone), timeZone);
  const next = instantOfWallClock(
    { ...anchor, month: anchor.month + 1, day: 1, hour: 0, minute: 0 }, timeZone);
  const cells: number[] = [];
  for (let t = start; t < next || cells.length % 7 !== 0; t = addDays(t, 1, timeZone)) {
    cells.push(t);
    // A month can need six rows; nothing needs seven, and an unbounded loop
    // here would hang the tab rather than draw a wrong calendar.
    if (cells.length >= 42) break;
  }
  return cells;
}

export function CalendarField({
  value, onChange, min, max, id, label, disabled = false, className = "", timeZone,
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
  /**
   * The zone the calendar, the time field and the label read and write in —
   * the chart's display zone where there is one (W2D-08). Omitted, the
   * browser's own.
   */
  timeZone?: ChartTimeZone;
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

  const cells = useMemo(() => monthGrid(month, timeZone), [month, timeZone]);
  const monthWall = wallClockOf(month, timeZone);
  const monthLabel = new Date(month).toLocaleDateString(undefined, {
    month: "long", year: "numeric", ...(timeZone ? { timeZone } : {}),
  });
  const inRange = (day: number): boolean =>
    (min === undefined || day >= startOfDay(min, timeZone))
    && (max === undefined || day <= startOfDay(max, timeZone));

  /** Keep the time of day when the day changes, so picking a date is one click. */
  const chooseDay = (day: number): void => {
    const keep = wallClockOf(value ?? max ?? Date.now(), timeZone);
    const picked = instantOfWallClock(
      { ...wallClockOf(day, timeZone), hour: keep.hour, minute: keep.minute }, timeZone);
    const clamped = Math.min(Math.max(picked, min ?? -Infinity), max ?? Infinity);
    onChange(clamped);
    setOpen(false);
  };

  const shiftMonth = (by: number): void => {
    setMonth(instantOfWallClock(
      { ...monthWall, month: monthWall.month + by, day: 1, hour: 0, minute: 0 }, timeZone));
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
          {value === null ? "Pick a date" : timeZone
            // The chart's own form, so it reads exactly as the replay clock does.
            ? fmtChartMinute(value, timeZone)
            : new Date(value).toLocaleString(undefined, {
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
              const dayWall = wallClockOf(day, timeZone);
              const outside = dayWall.month !== monthWall.month;
              const pickable = inRange(day);
              const chosen = value !== null && sameDay(day, value, timeZone);
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
                    sameDay(day, Date.now(), timeZone) && !chosen ? "border border-border-strong" : ""
                  }`}
                >
                  {dayWall.day}
                </button>
              );
            })}
          </div>

          <label className="mt-2 flex items-center gap-2">
            <span className="text-[11px] text-ink-muted">Time</span>
            <input
              type="time"
              value={value === null ? "" : timeValue(value, timeZone)}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return;
                // The hour and minute TYPED are the chart zone's, on the day shown.
                const base = wallClockOf(value ?? max ?? Date.now(), timeZone);
                const picked = instantOfWallClock({ ...base, hour: h, minute: m }, timeZone);
                onChange(Math.min(Math.max(picked, min ?? -Infinity), max ?? Infinity));
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
