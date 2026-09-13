/**
 * `localStorage.setItem` throws, and this product calls it forty-one times.
 *
 * ── What throws, and when ──────────────────────────────────────────────────
 *
 * Two failures, neither rare and neither the same shape:
 *
 *   QUOTA. Safari gives an origin about 5 MB, and this product spends it on
 *   drawings, the workspace, chart settings, watchlists and per-pane studies.
 *   A `QuotaExceededError` from one write is not a reason to lose the page.
 *
 *   ACCESS. Safari's Private Browsing, Firefox's `dom.storage.enabled=false`,
 *   Chrome's "block third-party cookies" inside an iframe, and a locked-down
 *   corporate profile all make the ACCESSOR throw — `window.localStorage`
 *   itself, before any method is called. A `typeof window === "undefined"`
 *   guard does not help: the window is there, the storage is not.
 *
 * ── Why a module rather than a rule ────────────────────────────────────────
 *
 * TVP8 round two. Thirty-six of the forty-one writes already sat inside a
 * `try`, each with its own comment explaining the same thing. Five did not, and
 * an uncaught throw from any of them takes down whatever rendered the control
 * that called it — toggling the bottom panel, switching watchlists, turning
 * autosave off. The odds of the thirty-seventh author remembering are not
 * good enough for something that fails only on other people's machines.
 *
 * So the failure is handled ONCE, here, and the product says what it means:
 * `remember(key, value)` — try to, and carry on if this browser will not.
 *
 * It deliberately does not report. A user in a private window has chosen a
 * browser that forgets, and telling them so on every preference they change is
 * noise. What matters is that the SESSION still works; `recall` simply returns
 * the default, which is the same state a first visit has.
 */

type Store = "local" | "session";

/**
 * The accessor itself, in a try.
 *
 * Not cached: Chrome's storage permission can be granted or revoked while the
 * page is open, and a cache would hold the answer from before.
 */
function storage(which: Store): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return which === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Whether this browser will remember anything at all. */
export function canRemember(which: Store = "local"): boolean {
  return storage(which) !== null;
}

/** Store `value`, or carry on unchanged if this browser will not. */
export function remember(key: string, value: string, which: Store = "local"): boolean {
  const store = storage(which);
  if (!store) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Store `value` as JSON. A value that cannot be serialised is not stored. */
export function rememberJson(key: string, value: unknown, which: Store = "local"): boolean {
  try {
    return remember(key, JSON.stringify(value), which);
  } catch {
    return false;
  }
}

/** What was stored under `key`, or `fallback` if nothing was or nothing can be. */
export function recall(key: string, fallback: string | null = null, which: Store = "local"): string | null {
  const store = storage(which);
  if (!store) return fallback;
  try {
    return store.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * What was stored under `key`, parsed, or `fallback`.
 *
 * A record this build cannot read is `fallback` rather than a throw: storage
 * outlives the code that wrote it, and a stale shape must degrade to a first
 * visit rather than to a blank page.
 */
export function recallJson<T>(key: string, fallback: T, which: Store = "local"): T {
  const raw = recall(key, null, which);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Remove `key`. Removing something that is not there is not an error. */
export function forget(key: string, which: Store = "local"): void {
  const store = storage(which);
  if (!store) return;
  try {
    store.removeItem(key);
  } catch { /* the same browsers that refuse to write refuse to delete */ }
}
