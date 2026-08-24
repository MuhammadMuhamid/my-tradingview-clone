/**
 * How stale is the data on screen, and is that worth saying?
 *
 * ── FE-12 / FE-13 ──────────────────────────────────────────────────────────
 *
 * Several pages poll the backend on a timer and swallow the failure:
 * `refresh().catch(() => {})`. When the backend goes away — restarted, crashed,
 * network dropped — the page keeps rendering the last successful response
 * indefinitely, with no indication that it is frozen.
 *
 * On the pages that show whether live trading is running, that is not a cosmetic
 * problem. A user looks at a deployment marked "active", believes orders are
 * being placed, and is reading a snapshot from twenty minutes ago.
 *
 * One failed poll is not worth interrupting anyone over — transient failures
 * are normal and a banner that flickers is a banner people learn to ignore. The
 * threshold below is what separates the two.
 */

/** A poll can miss this long before the screen is called stale. */
export const STALE_AFTER_MS = 30_000;

export interface Freshness {
  /** Last successful load, or null if none has succeeded yet. */
  lastOkAt: number | null;
  /** Message from the most recent failure, or null if the last poll succeeded. */
  lastError: string | null;
}

export const freshAt = (now: number): Freshness => ({ lastOkAt: now, lastError: null });

export type FreshnessNotice =
  | { show: false }
  | { show: true; message: string; severity: "warn" | "down" };

/**
 * What to tell the user, if anything.
 *
 * `severity` distinguishes "this is behind" from "this never loaded": a page
 * that has shown nothing since it opened is a different situation from one
 * holding a stale but real answer, and only the second is safe to keep reading.
 */
export function freshnessNotice(state: Freshness, now: number): FreshnessNotice {
  if (state.lastError === null) return { show: false };

  if (state.lastOkAt === null) {
    return {
      show: true,
      severity: "down",
      message: `Could not load: ${state.lastError}`,
    };
  }

  const staleFor = now - state.lastOkAt;
  if (staleFor < STALE_AFTER_MS) return { show: false };

  return {
    show: true,
    severity: "warn",
    message: `Not updating — showing data from ${describeAge(staleFor)} ago. ${state.lastError}`,
  };
}

/** Coarse, because the exact second is not the point and precision implies more than is known. */
export function describeAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
