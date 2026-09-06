"use client";
/**
 * The candlestick-pattern overlay's state: whether it is on, and what the
 * Screener currently reports.
 *
 * Off by default and remembered per browser. Pattern marks are opinions about
 * bars, drawn on top of the bars themselves, and a chart that arrives already
 * covered in them has made a choice on the user's behalf about what matters.
 *
 * The snapshot is polled, not streamed: the Screener recomputes on its own
 * cadence and a pattern is a statement about closed bars, so a mark that
 * appears within a minute of the bar closing is as timely as the fact is.
 */
import { useEffect, useState } from "react";
import { api as scannerApi } from "@/lib/scanner/api";
import type { Snapshot } from "@/lib/scanner/types";
import { CANDLE_OVERLAY_KEY } from "@/lib/candleOverlay";

const POLL_MS = 60_000;

export function loadCandleOverlayEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(CANDLE_OVERLAY_KEY) === "1"; }
  catch { return false; }
}

export function saveCandleOverlayEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(CANDLE_OVERLAY_KEY, "1");
    else window.localStorage.removeItem(CANDLE_OVERLAY_KEY);
  } catch { /* the toggle still works for this session */ }
}

export interface CandleOverlayState {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  /** The Screener's own answer, or null while it has not given one. */
  snapshot: Snapshot | null;
}

export function useCandleOverlay(): CandleOverlayState {
  const [enabled, setEnabledState] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  // After mount, so the server-rendered markup and the first client render
  // agree about a value only the browser knows.
  useEffect(() => { setEnabledState(loadCandleOverlayEnabled()); }, []);

  useEffect(() => {
    if (!enabled) { setSnapshot(null); return; }
    let live = true;
    const load = (): void => {
      void scannerApi.screener()
        .then((next) => { if (live) setSnapshot(next); })
        // A Screener that is not running leaves the overlay with no snapshot,
        // which `overlayNotice` reports as exactly that rather than as "no
        // patterns" — the two mean very different things.
        .catch(() => { if (live) setSnapshot(null); });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [enabled]);

  return {
    enabled,
    snapshot,
    setEnabled: (next: boolean) => {
      setEnabledState(next);
      saveCandleOverlayEnabled(next);
    },
  };
}
