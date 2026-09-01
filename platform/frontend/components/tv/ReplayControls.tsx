"use client";
import { useEffect, useState } from "react";
import {
  REPLAY_SPEEDS,
  canStepReplay,
  type ReplaySession,
  type ReplaySpeed,
} from "@/lib/replay";
import type { Candle } from "@/lib/types";

function localDateTimeValue(time: number): string {
  const date = new Date(time);
  const shifted = new Date(time - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

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
  const [requested, setRequested] = useState("");

  useEffect(() => {
    if (pickerOpen && suggested)
      setRequested(localDateTimeValue(suggested.closeTime));
  }, [pickerOpen, suggested]);

  if (!pickerOpen && !session) return null;
  const button =
    "flex h-7 items-center rounded-md border border-border bg-surface px-2 text-xs " +
    "text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40";

  if (!session) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-accent/30 bg-accent/10 px-3 py-1.5">
        <span className="text-xs font-semibold text-accent">
          Choose replay point
        </span>
        <input
          type="datetime-local"
          value={requested}
          min={first ? localDateTimeValue(first.closeTime) : undefined}
          max={last ? localDateTimeValue(last.closeTime) : undefined}
          onChange={(event) => setRequested(event.target.value)}
          aria-label="Historical replay date and time"
          className="h-7 rounded-md border border-border bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
        />
        <button
          className={`${button} border-accent bg-accent text-white hover:bg-accent/90`}
          disabled={!requested || !last}
          onClick={() => onStart(new Date(requested).getTime())}
        >
          Start Replay
        </button>
        <button className={button} onClick={onCancel}>
          Cancel
        </button>
        <span className="text-[11px] text-ink-muted">
          Existing saved drawings and live actions are isolated while replay is
          active.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-accent/40 bg-accent/10 px-3 py-1.5">
      <span className="mr-1 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
        Replay
      </span>
      <time
        className="mr-1 font-mono text-[11px] text-ink"
        dateTime={new Date(session.horizonCloseTime).toISOString()}
      >
        {new Date(session.horizonCloseTime).toLocaleString()}
      </time>
      <button
        className={button}
        onClick={onPrevious}
        disabled={!canStepReplay(session, candles, -1)}
        aria-label="Previous replay candle"
      >
        Previous
      </button>
      <button
        className={button}
        onClick={onNext}
        disabled={!canStepReplay(session, candles, 1)}
        aria-label="Next replay candle"
      >
        Next
      </button>
      <button
        className={button}
        onClick={() => onPlaying(!session.playing)}
        disabled={!session.playing && !canStepReplay(session, candles, 1)}
      >
        {session.playing ? "Pause" : "Play"}
      </button>
      <label className="flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[11px] text-ink-muted">
        Speed
        <select
          value={session.speed}
          onChange={(event) =>
            onSpeed(Number(event.target.value) as ReplaySpeed)
          }
          className="bg-transparent font-semibold text-ink outline-none"
          aria-label="Replay speed"
        >
          {REPLAY_SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {speed}×
            </option>
          ))}
        </select>
      </label>
      <button
        className={`${button} ml-auto border-down/40 text-down hover:bg-down/10`}
        onClick={onExit}
      >
        Exit Replay
      </button>
    </div>
  );
}
