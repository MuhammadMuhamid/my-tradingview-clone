"use client";
/**
 * Chart-workspace fullscreen, over the browser's own Fullscreen API.
 *
 * ── Why the real API and not a fixed-position clone ────────────────────────
 *
 * A `position: fixed; inset: 0` "fullscreen" keeps the browser's own chrome —
 * tab strip, address bar, bookmarks — which is most of what a trader wants
 * gone, and it silently diverges from the user's expectations in three ways
 * that are expensive to rediscover: Escape does not exit it, the OS
 * fullscreen affordance does not enter it, and nothing tells the page when the
 * user leaves by some other route. The standard API gives all three for free.
 *
 * ── The state that has to be tracked ───────────────────────────────────────
 *
 * `document.fullscreenElement` is the only truth. A component that stores its
 * own boolean and flips it on click is wrong the moment the user presses
 * Escape — the page then shows an "Exit fullscreen" button while not being
 * fullscreen. So every reader here derives from the document, and the hook
 * subscribes to `fullscreenchange` rather than assuming its own request stuck.
 *
 * ── Injectable, because there is no browser in the test environment ────────
 *
 * The functions take the document and element as parameters typed to the
 * narrow surface they actually use, so a test can hand them a fake with a
 * `requestFullscreen` that rejects, or one that reports the API as disabled,
 * and check the fallbacks without a DOM.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** The part of `Document` this module touches. */
export interface FullscreenDocument {
  fullscreenElement: Element | null;
  fullscreenEnabled?: boolean;
  exitFullscreen?: () => Promise<void>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/** The part of `Element` this module touches. */
export interface FullscreenTarget {
  requestFullscreen?: () => Promise<void>;
}

/**
 * Whether entering fullscreen can work at all.
 *
 * `fullscreenEnabled` is false inside an iframe without `allow="fullscreen"`,
 * and the method is simply absent on older engines. Either way the control
 * must not be offered: a button that does nothing is worse than no button.
 */
export function fullscreenSupported(
  doc: FullscreenDocument | null | undefined,
  target?: FullscreenTarget | null
): boolean {
  if (!doc) return false;
  if (doc.fullscreenEnabled === false) return false;
  if (typeof doc.exitFullscreen !== "function") return false;
  if (target !== undefined && (!target || typeof target.requestFullscreen !== "function")) {
    return false;
  }
  return true;
}

/** True when this element — or anything at all, when none is given — is fullscreen. */
export function isFullscreen(
  doc: FullscreenDocument | null | undefined,
  target?: FullscreenTarget | null
): boolean {
  if (!doc) return false;
  if (target === undefined) return doc.fullscreenElement !== null;
  return target !== null && (doc.fullscreenElement as unknown) === target;
}

/**
 * Ask for fullscreen. Resolves false rather than throwing.
 *
 * A rejection here is normal, not exceptional: browsers refuse the request
 * when it did not come from a user gesture, and some refuse it outright under
 * a permissions policy. The caller shows the chart either way.
 */
export async function enterFullscreen(
  target: FullscreenTarget | null | undefined,
  doc: FullscreenDocument | null | undefined
): Promise<boolean> {
  if (!target || typeof target.requestFullscreen !== "function") return false;
  if (!fullscreenSupported(doc)) return false;
  try {
    await target.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

/** Leave fullscreen if this document is in it. Resolves false when it was not. */
export async function exitFullscreen(
  doc: FullscreenDocument | null | undefined
): Promise<boolean> {
  if (!doc || doc.fullscreenElement === null) return false;
  if (typeof doc.exitFullscreen !== "function") return false;
  try {
    await doc.exitFullscreen();
    return true;
  } catch {
    return false;
  }
}

/**
 * Toggle, resolving to the state actually reached.
 *
 * "Actually reached" matters: a refused request must report false so the
 * caller does not render an exit affordance for a fullscreen it never entered.
 */
export async function toggleFullscreen(
  target: FullscreenTarget | null | undefined,
  doc: FullscreenDocument | null | undefined
): Promise<boolean> {
  if (isFullscreen(doc, target ?? null)) {
    await exitFullscreen(doc);
    return false;
  }
  return enterFullscreen(target, doc);
}

/** Subscribe to every way fullscreen can change, including Escape. Returns an unsubscribe. */
export function watchFullscreen(
  doc: FullscreenDocument | null | undefined,
  onChange: () => void
): () => void {
  if (!doc) return () => { /* nothing to unsubscribe */ };
  doc.addEventListener("fullscreenchange", onChange);
  return () => doc.removeEventListener("fullscreenchange", onChange);
}

export interface FullscreenApi<T extends HTMLElement> {
  ref: React.RefObject<T>;
  /** The element is fullscreen right now, according to the document. */
  active: boolean;
  /** The API exists and is permitted. Resolved after mount, so SSR renders nothing. */
  supported: boolean;
  toggle: () => void;
}

/**
 * Fullscreen for one element.
 *
 * `supported` starts false and is settled in an effect rather than read during
 * render: `document` does not exist on the server, and a control whose presence
 * differed between the server and the first client render would be a hydration
 * mismatch.
 */
export function useFullscreen<T extends HTMLElement>(): FullscreenApi<T> {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    const doc = typeof document === "undefined" ? null : (document as unknown as FullscreenDocument);
    /*
     * Captured once. Effects run after the DOM is committed, so this is the
     * element for the whole of this component's life — and reading the ref in
     * the cleanup instead would read it after React has already detached it,
     * which is the difference between "we were fullscreen" and "null".
     */
    const element = ref.current;
    setSupported(fullscreenSupported(doc));
    const sync = (): void => setActive(isFullscreen(doc, element));
    sync();
    const stop = watchFullscreen(doc, sync);
    return () => {
      stop();
      /*
       * State cleanup. A page that unmounts while fullscreen — a route change,
       * an error boundary — would otherwise leave the browser fullscreen on a
       * document whose element is gone, and the only way out would be the
       * keyboard shortcut the user has just been given no reason to press.
       */
      if (isFullscreen(doc, element)) void exitFullscreen(doc);
    };
  }, []);

  const toggle = useCallback(() => {
    const doc = typeof document === "undefined" ? null : (document as unknown as FullscreenDocument);
    void toggleFullscreen(ref.current, doc).then((next) => setActive(next));
  }, []);

  return { ref, active, supported, toggle };
}
