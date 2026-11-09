"use client";
/**
 * Silent auto-refresh for the Bot pages: every 15 s, paused while the tab is
 * hidden, and once at once when it becomes visible again.
 *
 * `startPolling` is adapted from the standalone Bot dashboard
 * (bot/frontend/src/dashboardPolling.ts): injectable timers, an exact one-shot
 * cleanup. The visibility half is new: a hidden tab asking the Bot every 15 s
 * spends its control-plane limiter for nobody.
 */
import { useEffect, useRef } from "react";

export const BOT_POLL_MS = 15_000;
let pollMs = BOT_POLL_MS;

/** Tests only: poll faster than every 15 s. */
export function setBotPollMsForTests(ms: number | null): void {
  pollMs = ms ?? BOT_POLL_MS;
}

export interface PollTimers {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const browserTimers: PollTimers = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

/** Start one refresh loop; the returned cleanup stops it exactly once. */
export function startPolling(refresh: () => void | Promise<void>, timers: PollTimers = browserTimers,
  delayMs = BOT_POLL_MS): () => void {
  const handle = timers.setInterval(() => void refresh(), delayMs);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    timers.clearInterval(handle);
  };
}

/**
 * Poll `refresh` while the document is visible. `enabled` false stops it
 * (e.g. an ordinary account, or before the first load).
 */
export function useVisiblePolling(refresh: () => void, enabled = true, delayMs?: number): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    let stop: (() => void) | null = null;
    const run = () => latest.current();
    const sync = () => {
      if (document.visibilityState === "hidden") {
        stop?.();
        stop = null;
      } else if (!stop) {
        stop = startPolling(run, browserTimers, delayMs ?? pollMs);
      }
    };
    const onVisibility = () => {
      const wasStopped = stop === null;
      sync();
      if (wasStopped && stop !== null) run();
    };
    sync();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop?.();
    };
  }, [enabled, delayMs]);
}
