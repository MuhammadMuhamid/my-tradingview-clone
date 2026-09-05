/**
 * Keyboard shortcuts, and the one rule that decides whether any of them fire.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * A global shortcut must never act while the user is typing. Not while they
 * are in an input, a textarea, a select, a contenteditable region, the Pine
 * editor or any modal text field. This is not a nicety: `t` is the trend-line
 * tool, and a `t` swallowed from the middle of a strategy name is a keystroke
 * the user has to notice is missing. Worse, Cmd/Ctrl+Z with the editor focused
 * must undo the EDITOR, not the drawing on a chart the user is not looking at.
 *
 * The guard is therefore evaluated first, for every binding, from the event's
 * own target — never from a component's idea of what has focus.
 *
 * ── Platform ───────────────────────────────────────────────────────────────
 *
 * `Cmd` on a Mac, `Ctrl` everywhere else, expressed once as `mod`. A binding
 * that named `ctrlKey` directly would be dead on the platform this product is
 * developed and used on.
 *
 * ── Pure ───────────────────────────────────────────────────────────────────
 *
 * Everything here maps a described key event to an action name. Nothing
 * listens, nothing dispatches and nothing touches a chart, so the whole table
 * — including the guard and the interval-typing buffer — is testable without a
 * browser.
 */

export type ShortcutAction =
  | "undo" | "redo" | "clone" | "copy" | "paste" | "delete"
  | "tool:cursor" | "tool:trend" | "tool:horizontal" | "tool:vertical" | "tool:fib"
  | "tool:text" | "magnet" | "lock-drawings" | "hide-drawings"
  | "symbol-search" | "indicators" | "chart-settings" | "shortcuts-sheet"
  | "fullscreen" | "replay-step-back" | "replay-step-forward" | "replay-play-pause"
  | "reset-view" | "toggle-log" | "toggle-auto";

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Enough of the event target to judge whether the user is typing. */
  target?: EditableTargetLike | null;
}

export interface EditableTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  /** `true` on a container the app marks as owning its own keys (the editor). */
  closestEditor?: boolean;
}

/** Tag names that own every keystroke aimed at them. */
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Is the user typing?
 *
 * Total and deliberately conservative: an unknown or missing target counts as
 * NOT typing, because the alternative — swallowing every shortcut whenever the
 * target is unfamiliar — makes the keyboard layer silently stop working.
 */
export function isTypingTarget(target: EditableTargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable === true) return true;
  if (target.closestEditor === true) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return TYPING_TAGS.has(tag);
}

export interface Binding {
  action: ShortcutAction;
  /** The `key` value, compared case-insensitively. */
  key: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  /** Only meaningful while a Replay session is running. */
  replayOnly?: boolean;
  /** What the shortcuts sheet says this does. */
  label: string;
  group: "Edit" | "Drawing tools" | "Chart" | "Replay" | "Navigation";
}

/**
 * The table.
 *
 * Single letters are tool selections, matching what a chart user expects from
 * every other charting product. Everything destructive or stateful takes a
 * modifier, so nothing irreversible is one keystroke away from a stray press.
 */
export const BINDINGS: readonly Binding[] = [
  { action: "undo", key: "z", mod: true, label: "Undo", group: "Edit" },
  { action: "redo", key: "z", mod: true, shift: true, label: "Redo", group: "Edit" },
  { action: "redo", key: "y", mod: true, label: "Redo", group: "Edit" },
  { action: "clone", key: "d", mod: true, label: "Duplicate the selected drawing", group: "Edit" },
  { action: "copy", key: "c", mod: true, label: "Copy the selected drawing", group: "Edit" },
  { action: "paste", key: "v", mod: true, label: "Paste a drawing", group: "Edit" },
  { action: "delete", key: "Delete", label: "Delete the selected drawing", group: "Edit" },
  { action: "delete", key: "Backspace", label: "Delete the selected drawing", group: "Edit" },

  { action: "tool:cursor", key: "Escape", label: "Back to the cursor", group: "Drawing tools" },
  { action: "tool:trend", key: "t", label: "Trend line", group: "Drawing tools" },
  { action: "tool:horizontal", key: "h", label: "Horizontal line", group: "Drawing tools" },
  { action: "tool:vertical", key: "v", label: "Vertical line", group: "Drawing tools" },
  { action: "tool:fib", key: "f", label: "Fibonacci retracement", group: "Drawing tools" },
  { action: "tool:text", key: "x", label: "Text", group: "Drawing tools" },
  { action: "magnet", key: "m", label: "Magnet", group: "Drawing tools" },
  { action: "lock-drawings", key: "l", label: "Lock drawings", group: "Drawing tools" },
  { action: "hide-drawings", key: "j", label: "Hide drawings", group: "Drawing tools" },

  { action: "symbol-search", key: "/", label: "Symbol search", group: "Navigation" },
  { action: "indicators", key: "i", label: "Indicators", group: "Navigation" },
  { action: "chart-settings", key: ",", mod: true, label: "Chart settings", group: "Navigation" },
  { action: "shortcuts-sheet", key: "?", label: "Keyboard shortcuts", group: "Navigation" },
  { action: "fullscreen", key: "F", shift: true, label: "Fullscreen", group: "Chart" },
  { action: "reset-view", key: "r", mod: true, shift: true, label: "Reset the view", group: "Chart" },
  { action: "toggle-log", key: "l", mod: true, shift: true, label: "Logarithmic scale", group: "Chart" },
  { action: "toggle-auto", key: "a", mod: true, shift: true, label: "Auto scale", group: "Chart" },

  { action: "replay-step-back", key: "ArrowLeft", replayOnly: true, label: "Step back", group: "Replay" },
  { action: "replay-step-forward", key: "ArrowRight", replayOnly: true, label: "Step forward", group: "Replay" },
  { action: "replay-play-pause", key: " ", replayOnly: true, label: "Play / pause", group: "Replay" },
];

export interface ShortcutContext {
  /** macOS uses Cmd where every other platform uses Ctrl. */
  mac: boolean;
  /** A Replay session is running. */
  replayActive: boolean;
}

/**
 * Which action this key press means, or null.
 *
 * The typing guard runs FIRST, for every binding without exception. A binding
 * with `replayOnly` is inert outside Replay — Space must scroll a page and the
 * arrow keys must move a cursor when there is no Replay to step.
 */
export function resolveShortcut(
  event: KeyEventLike, context: ShortcutContext
): ShortcutAction | null {
  if (isTypingTarget(event.target)) return null;
  const mod = context.mac ? event.metaKey : event.ctrlKey;
  // A modifier this table never uses means the press belongs to the browser
  // or the OS: Alt+ArrowLeft is Back, and must stay Back.
  if (event.altKey) return null;
  for (const binding of BINDINGS) {
    if (binding.replayOnly && !context.replayActive) continue;
    if (binding.key.length === 1
      ? binding.key.toLowerCase() !== event.key.toLowerCase()
      : binding.key !== event.key) continue;
    if ((binding.mod ?? false) !== mod) continue;
    if ((binding.shift ?? false) !== event.shiftKey) continue;
    // A bare letter that arrives with the platform modifier held is not a
    // tool selection; it is a browser command this app has no business taking.
    if (!binding.mod && mod) continue;
    return binding.action;
  }
  return null;
}

/**
 * Typing an interval and pressing Enter.
 *
 * TradingView's single most-used keyboard affordance: type `15`, press Enter,
 * the chart is on 15m. The buffer accepts digits and the unit letters, times
 * out so a number typed a minute ago is not still waiting, and resolves only
 * against intervals the backend actually serves — an unsupported `7m` clears
 * the buffer rather than silently doing nothing or, worse, picking the nearest.
 *
 * A bare number means minutes below 60 and… still minutes at 60 and above,
 * because that is what the shorthand means: `60` is an hour expressed in
 * minutes, and `240` is four hours. Mapping them to the hour intervals is the
 * whole point of allowing a bare number.
 */
export interface IntervalBuffer {
  text: string;
  /** When the buffer was last appended to. */
  at: number;
}

export const INTERVAL_BUFFER_TIMEOUT_MS = 2_000;

export const EMPTY_INTERVAL_BUFFER: IntervalBuffer = { text: "", at: 0 };

/** Accept a keystroke into the buffer, or reject it and leave the buffer alone. */
export function appendIntervalKey(
  buffer: IntervalBuffer, key: string, now: number
): IntervalBuffer {
  if (!/^[0-9dhmDHM]$/.test(key)) return buffer;
  const fresh = now - buffer.at <= INTERVAL_BUFFER_TIMEOUT_MS ? buffer.text : "";
  return { text: (fresh + key).slice(0, 5), at: now };
}

/**
 * Resolve a typed interval against the ones actually served.
 *
 * `supported` is passed in rather than imported so this stays pure and so the
 * caller cannot end up offering an interval the backend does not have.
 */
export function resolveTypedInterval(
  buffer: IntervalBuffer, supported: readonly string[], now: number
): string | null {
  if (now - buffer.at > INTERVAL_BUFFER_TIMEOUT_MS) return null;
  const text = buffer.text.trim().toLowerCase();
  if (text.length === 0) return null;

  const explicit = /^(\d+)([dhm])$/.exec(text);
  if (explicit) {
    const candidate = `${Number(explicit[1])}${explicit[2]}`;
    return supported.includes(candidate) ? candidate : null;
  }
  if (!/^\d+$/.test(text)) return null;

  const minutes = Number(text);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  // Minutes first, then the hour and day forms the same count of minutes means.
  const candidates = [`${minutes}m`];
  if (minutes % 60 === 0) candidates.push(`${minutes / 60}h`);
  if (minutes % 1440 === 0) candidates.push(`${minutes / 1440}d`);
  for (const candidate of candidates) {
    if (supported.includes(candidate)) return candidate;
  }
  return null;
}
