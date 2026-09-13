"use client";
/**
 * Bar Replay's own control strip.
 *
 * ── What this used to be, and why it moved ─────────────────────────────────
 *
 * A full-width accent-tinted banner rendered ABOVE the panes, immediately after
 * the toolbar — a sibling of the page's error banner and its deep-link consent
 * notice, and read as one of them. It announced the mode with a solid blue
 * `REPLAY` pill, stated the horizon as a `toLocaleString()` timestamp, and
 * offered five bordered text buttons.
 *
 * Measured against the live reference, replay is not a banner at all. It is a
 * 38px strip of CHART CHROME below the time axis and above the date-range row:
 * no radius, no shadow, controls centred as one group with the exit pinned
 * right. The mode is stated by the toolbar's replay button taking the ordinary
 * selected chip — which it already does — not by colouring a row of the
 * workspace blue.
 *
 * One deliberate difference, and it is a consequence of layout rather than of
 * taste. The reference's strip floats INSIDE the chart area, so it is
 * transparent and needs no edge. This one is a sibling row between the pane
 * grid and the bottom workstation, so it carries `bg-surface` — the same
 * colour as the chart canvas it continues, which is why it still reads as
 * chrome — and a `border-t` hairline, which is the same separator the
 * date-range row below it uses. Transparent here would not look like the
 * reference; it would look like a row that forgot to paint.
 *
 * Two consequences beyond appearance. The banner pushed every pane down by its
 * own height for the whole session, so entering replay moved the chart. And
 * spending the product's primary-action colour on "you are in a mode" is the
 * same spend as an order button, on a surface a replay user stares at
 * continuously.
 *
 * ── What is kept that the reference does not have ──────────────────────────
 *
 * A PREVIOUS-bar control: the reference steps forward only. Stepping back is
 * the more useful half of studying a setup and the engine has always supported
 * it (`canStepReplay(session, candles, -1)`), so it stays — inside the group
 * rather than leading it.
 *
 * The explicit horizon timestamp, because a replay session that does not say
 * where it is standing is a chart with no date on it.
 *
 * The isolation sentence on the picker: saved drawings and live actions are
 * genuinely quarantined during a session, and that is worth one line of
 * screen once, at the moment the user commits to it.
 */
import { useEffect, useState } from "react";
import { CalendarField } from "./CalendarField";
import {
  REPLAY_SPEEDS,
  canStepReplay,
  type ReplaySession,
  type ReplaySpeed,
} from "@/lib/replay";
import type { Candle } from "@/lib/types";



/** The strip's own controls: 38px, transparent, state on the ::before chip. */
const CTL = "tvc-control flex h-[30px] shrink-0 items-center px-1.5 text-[13px] "
  + "text-ink-muted hover:text-ink disabled:hover:text-ink-muted";

export function ReplayControls({
  candles,
  session,
  pickerOpen,
  onStart,
  onCancel,
  onPrevious,
  onNext,
  onPlaying,
  onSpeed,
  onExit,
}: {
  candles: Candle[];
  session: ReplaySession | null;
  pickerOpen: boolean;
  onStart: (requestedTime: number) => void;
  onCancel: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onPlaying: (playing: boolean) => void;
  onSpeed: (speed: ReplaySpeed) => void;
  onExit: () => void;
}) {
  const completed = candles.filter((bar) => bar.closeTime <= Date.now());
  const first = completed[0];
  const last = completed[completed.length - 1];
  const suggested = completed[Math.max(0, completed.length - 100)] ?? first;
  const [requested, setRequested] = useState<number | null>(null);

  useEffect(() => {
    if (pickerOpen && suggested) setRequested(suggested.closeTime);
  }, [pickerOpen, suggested]);

  if (!pickerOpen && !session) return null;

  /* ── choosing a point ─────────────────────────────────────────────────── */
  if (!session) {
    return (
      <div
        role="group"
        aria-label="Choose a replay point"
        className="flex h-[38px] shrink-0 flex-wrap items-center gap-1.5 border-t border-border bg-surface px-2"
      >
        {/*
          TVP8: this was `<input type="datetime-local">` — the BROWSER's
          control. Chrome drew its own calendar in the platform's font and
          Safari drew a stepper with no calendar at all, and neither could know
          which days this chart actually has bars for. `CalendarField` dims the
          days outside the loaded window instead of leaving it to `min`/`max`.
        */}
        <CalendarField
          id="replay-start"
          label="Historical replay date and time"
          value={requested}
          onChange={setRequested}
          min={first?.closeTime}
          max={last?.closeTime}
        />
        <button
          className="flex h-[26px] shrink-0 items-center rounded bg-accent px-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          disabled={requested === null || !last}
          onClick={() => { if (requested !== null) onStart(requested); }}
          aria-label="Start Replay"
        >
          Start
        </button>
        <button className={CTL} onClick={onCancel}>Cancel</button>
        <span className="ml-2 hidden truncate text-[11px] text-ink-faint lg:inline">
          Saved drawings and live actions are isolated while replay is active.
        </span>
        <button
          onClick={onCancel}
          aria-label="Cancel Replay"
          title="Close replay"
          className={`${CTL} ml-auto w-[30px] justify-center px-0`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
            strokeWidth="1.6" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" /></svg>
        </button>
      </div>
    );
  }

  /* ── an active session ────────────────────────────────────────────────── */
  const atEnd = !canStepReplay(session, candles, 1);
  return (
    <div
      role="group"
      aria-label="Bar replay"
      className="flex h-[38px] shrink-0 items-center border-t border-border bg-surface px-2"
    >
      {/* The controls are one centred group, as they are in the reference. */}
      <div className="mx-auto flex items-center gap-0.5">
        <time
          className="mr-1 shrink-0 px-1 text-[13px] tabular text-ink-muted"
          dateTime={new Date(session.horizonCloseTime).toISOString()}
          title="The bar this session is standing on"
        >
          {new Date(session.horizonCloseTime).toLocaleString()}
        </time>

        <span aria-hidden="true" className="mx-1 h-[22px] w-px shrink-0 bg-border-strong" />

        <button
          className={`${CTL} w-[30px] justify-center px-0`}
          onClick={onPrevious}
          disabled={!canStepReplay(session, candles, -1)}
          aria-label="Previous replay candle"
          title="Step back one bar"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M18 5v14l-10-7z" /><rect x="5" y="5" width="2" height="14" rx="0.5" />
          </svg>
        </button>
        <button
          className={`${CTL} w-[30px] justify-center px-0`}
          onClick={() => onPlaying(!session.playing)}
          disabled={!session.playing && atEnd}
          aria-pressed={session.playing}
          aria-label={session.playing ? "Pause replay" : "Play replay"}
          title={session.playing ? "Pause" : atEnd ? "At the end of the session" : "Play"}
        >
          {session.playing ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" rx="0.5" />
              <rect x="14" y="5" width="4" height="14" rx="0.5" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 5v14l12-7z" />
            </svg>
          )}
        </button>
        <button
          className={`${CTL} w-[30px] justify-center px-0`}
          onClick={onNext}
          disabled={atEnd}
          aria-label="Next replay candle"
          title="Step forward one bar"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M6 5v14l10-7z" /><rect x="17" y="5" width="2" height="14" rx="0.5" />
          </svg>
        </button>

        <span aria-hidden="true" className="mx-1 h-[22px] w-px shrink-0 bg-border-strong" />

        {/*
          Speed as a bare value, the way the reference shows `1x` — the word
          "Speed" beside a four-item list is a label on something already
          legible, and it cost more of the strip than the control.
        */}
        <select
          value={session.speed}
          onChange={(event) => onSpeed(Number(event.target.value) as ReplaySpeed)}
          className="tvc-control h-[30px] shrink-0 bg-transparent px-1.5 text-[13px] font-medium text-ink outline-none"
          aria-label="Replay speed"
          title="Replay speed"
        >
          {REPLAY_SPEEDS.map((speed) => (
            <option key={speed} value={speed}>{speed}&times;</option>
          ))}
        </select>
      </div>

      <button
        className={`${CTL} w-[30px] justify-center px-0 hover:!text-down`}
        onClick={onExit}
        aria-label="Exit Replay"
        title="Exit Replay and return to live"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
          strokeWidth="1.6" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" /></svg>
      </button>
    </div>
  );
}
