"use client";
/**
 * The workspace's keyboard, attached once.
 *
 * ── One listener, one table ────────────────────────────────────────────────
 *
 * Every shortcut in the product resolves through `lib/shortcuts`, which is
 * pure: a described key event and a context go in, an action name comes out.
 * This hook is the only thing that listens, so there is exactly one place
 * where a keystroke can be swallowed and exactly one place where the typing
 * guard is applied.
 *
 * That guard is the whole reason this is centralised. `t` is the trend-line
 * tool; a `t` taken from the middle of a strategy name is a keystroke the user
 * has to notice is missing. Worse, Cmd+Z with the Pine editor focused must
 * undo the EDITOR, not a drawing on a chart the user is not looking at. The
 * guard is evaluated from the event's own target rather than from any
 * component's idea of what has focus, because the second is routinely wrong.
 *
 * ── Interval typing ────────────────────────────────────────────────────────
 *
 * Type `15`, press Enter, the chart is on 15m. The buffer accepts digits and
 * the unit letters, times out so a number typed a minute ago is not still
 * waiting, and resolves only against intervals the backend actually serves —
 * an unsupported `7m` clears the buffer rather than silently doing nothing or,
 * worse, picking the nearest one.
 */
import { useEffect, useRef, useState } from "react";
import {
  appendIntervalKey, EMPTY_INTERVAL_BUFFER, isTypingTarget, resolveShortcut,
  resolveTypedInterval, type IntervalBuffer, type ShortcutAction,
} from "./shortcuts";
import { INTERVAL_VALUES, isInterval, type Interval } from "./types";

export interface ShortcutHandlers {
  /** Return true when the action was handled; false leaves the key to the page. */
  onAction: (action: ShortcutAction) => boolean | void;
  /** A complete interval was typed and confirmed with Enter. */
  onInterval: (interval: Interval) => void;
}

export interface ShortcutOptions {
  replayActive: boolean;
  /** Off while a modal owns the keyboard entirely. */
  enabled?: boolean;
}

/**
 * Is this the platform where the modifier is Cmd?
 *
 * Read once, from the user agent's platform string, because it cannot change
 * during a session and reading it per keystroke is a needless touch of a
 * deprecated API.
 */
function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform);
}

export interface ShortcutState {
  /** What has been typed toward an interval, for the toolbar's echo. */
  intervalBuffer: string;
}

export function useShortcuts(
  handlers: ShortcutHandlers, options: ShortcutOptions
): ShortcutState {
  const enabled = options.enabled !== false;
  const [buffer, setBuffer] = useState<IntervalBuffer>(EMPTY_INTERVAL_BUFFER);
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const replayRef = useRef(options.replayActive);
  replayRef.current = options.replayActive;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const mac = isMacPlatform();

    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const described = {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        target: target ? {
          tagName: target.tagName,
          isContentEditable: target.isContentEditable,
          // The Pine editor owns every key aimed at it, including Cmd+Z.
          closestEditor: target.closest?.("[data-owns-keys]") !== null
            && target.closest?.("[data-owns-keys]") !== undefined,
        } : null,
      };
      if (isTypingTarget(described.target)) return;

      // Interval typing is checked BEFORE the table, because `1`..`9` and `d`,
      // `h`, `m` are digits and letters the table does not claim — and Enter
      // must confirm a buffer rather than reach the page.
      if (event.key === "Enter") {
        const resolved = resolveTypedInterval(
          bufferRef.current, INTERVAL_VALUES, Date.now());
        if (resolved && isInterval(resolved)) {
          event.preventDefault();
          setBuffer(EMPTY_INTERVAL_BUFFER);
          handlersRef.current.onInterval(resolved);
          return;
        }
        // A buffer that resolves to nothing is cleared rather than left to
        // combine with the next thing typed.
        if (bufferRef.current.text.length > 0) setBuffer(EMPTY_INTERVAL_BUFFER);
      }

      const action = resolveShortcut(described, { mac, replayActive: replayRef.current });
      if (action) {
        const handled = handlersRef.current.onAction(action);
        if (handled !== false) {
          event.preventDefault();
          // A tool selection is not part of an interval; typing `1`, `5`, `t`
          // must not leave `15` waiting behind the tool change.
          if (bufferRef.current.text.length > 0) setBuffer(EMPTY_INTERVAL_BUFFER);
          return;
        }
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        const next = appendIntervalKey(bufferRef.current, event.key, Date.now());
        if (next !== bufferRef.current) {
          event.preventDefault();
          setBuffer(next);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);

  return { intervalBuffer: buffer.text };
}
