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
  | "tool:horizontal-ray" | "tool:crossline" | "tool:rectangle"
  | "tool:text" | "magnet" | "stay-in-drawing-mode" | "lock-drawings" | "hide-drawings"
  | "symbol-search" | "indicators" | "chart-settings" | "shortcuts-sheet"
  | "command-palette" | "snapshot-save" | "snapshot-copy"
  | "fullscreen" | "replay-toggle" | "bottom-panel"
  | "replay-step-back" | "replay-step-forward" | "replay-play-pause"
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
  /** The target's ARIA role, which can make a `div` a text box or a button. */
  role?: string | null;
}

/** Tag names that own every keystroke aimed at them. */
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Elements that own Space, Enter and the arrow keys because ACTIVATING them is
 * what those keys do.
 *
 * Only for those keys — a button does not own `t` or `/`. During a Replay,
 * Space is bound to play/pause and the handler always claims it, so a
 * keyboard-only user could not press any focused button at all while a session
 * was running; the arrow keys are taken from radio groups and tab lists the
 * same way.
 */
const ACTIVATABLE_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);
const ACTIVATABLE_ROLES = new Set([
  "button", "switch", "checkbox", "radio", "tab", "menuitem", "option", "link",
  "menuitemcheckbox", "menuitemradio", "slider", "spinbutton",
]);
const ACTIVATION_KEYS = new Set([
  " ", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
]);

function ownsActivationKeys(target: EditableTargetLike | null | undefined): boolean {
  if (!target) return false;
  const role = (target.role ?? "").toLowerCase();
  if (ACTIVATABLE_ROLES.has(role)) return true;
  return ACTIVATABLE_TAGS.has((target.tagName ?? "").toUpperCase());
}

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
  // A `div` carrying `role="textbox"` is a text box to every assistive
  // technology and to the user typing into it, whatever its tag says.
  if ((target.role ?? "").toLowerCase() === "textbox") return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return TYPING_TAGS.has(tag);
}

/**
 * Is this the platform where the modifier is Cmd?
 *
 * Here rather than beside the hook because three surfaces need the same
 * answer — the key resolver, the shortcuts sheet and the drawing context menu
 * — and three copies of a user-agent sniff is three chances to disagree about
 * whether to print ⌘ or Ctrl.
 *
 * Read once per call site, from the user agent's platform string, because it
 * cannot change during a session.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform);
}

export interface Binding {
  action: ShortcutAction;
  /** The `key` value, compared case-insensitively. */
  key: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  /**
   * Option / Alt.
   *
   * The reference's drawing rail advertises ⌥-chords on its flyout rows — ⌥T
   * for the trendline, ⌥F for the Fibonacci retracement — so the table has to
   * be able to express one. It is opt-in per binding, and `resolveShortcut`
   * still refuses every Alt press that no binding here claims, which is what
   * keeps Alt+← as the browser's Back.
   */
  alt?: boolean;
  /** Only meaningful while a Replay session is running. */
  replayOnly?: boolean;
  /**
   * An action with NO keyboard chord.
   *
   * TVP8: it is still listed here, because this table is what the command
   * palette and the shortcut sheet are built from — leaving it out would take
   * the action out of the palette too, and a hand-written second list is the
   * thing this table exists to prevent. `resolveShortcut` never matches one,
   * and the sheet and the palette show no key cap.
   */
  chordless?: boolean;
  /** What the shortcuts sheet says this does. */
  label: string;
  group: "Edit" | "Drawing tools" | "Chart" | "Replay" | "Navigation";
}

/**
 * The table.
 *
 * ── TVP8 R4b-05: a bare letter belongs to the SYMBOL, not to a tool ────────
 *
 * This table used to give single letters to tool selections — `t` trendline,
 * `h` horizontal, `f` fib, `x` text, `m` magnet, `l` lock, `j` hide, `i`
 * indicators, `b` replay, `r` reset, `p` panel, `d` stay-in-drawing-mode.
 * TradingView gives EVERY bare letter to one thing: it opens the symbol
 * search with that letter already typed ("Change symbol: any letter"), and
 * puts the drawing tools on ⌥-chords — ⌥T, ⌥H, ⌥J, ⌥V, ⌥C, ⌥F, ⇧⌥R — which
 * this table has advertised on the rail's flyout rows since TVP7.
 *
 * Since the owner's rule is that live TradingView is the spec for a shared
 * surface, the bare letters are gone and each tool keeps the ⌥ chord it was
 * already printing. Actions the reference has no chord for keep their letter
 * under ⌥ (⌥X text, ⌥M magnet, ⌥B replay), and the three whose same-letter ⌥
 * chord the reference has already spent go one modifier further (⇧⌥D stay in
 * drawing mode, ⇧⌥L lock, ⇧⌥P bottom panel) rather than taking a chord the
 * reference means for something else. `hide-drawings` takes the reference's
 * own ⌘⌥H. `/` moves to Indicators and `,`-style number typing still means
 * the interval, both as the reference has them.
 *
 * `docs/TRADING_SCENE_UI_UX_CONTRACT.md` §7c holds the policy; this table is
 * what implements it, and the rail, the sheet and the palette all read it.
 *
 * Everything destructive or stateful still takes a modifier, so nothing
 * irreversible is one keystroke away from a stray press.
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
  /*
   * One chord per tool, and it is the reference's.
   *
   * The bare twins (`t`, `h`, `v`, `f`) are gone: a bare letter now opens the
   * symbol search with that letter in the box, which is what TradingView does
   * with every letter of the alphabet. The rail reads its printed cap off
   * THIS table rather than hard-coding a string, so its flyout rows follow.
   */
  { action: "tool:trend", key: "t", alt: true, label: "Trendline", group: "Drawing tools" },
  { action: "tool:horizontal", key: "h", alt: true, label: "Horizontal line", group: "Drawing tools" },
  { action: "tool:vertical", key: "v", alt: true, label: "Vertical line", group: "Drawing tools" },
  { action: "tool:fib", key: "f", alt: true, label: "Fibonacci retracement", group: "Drawing tools" },
  { action: "tool:horizontal-ray", key: "j", alt: true, label: "Horizontal ray", group: "Drawing tools" },
  { action: "tool:crossline", key: "c", alt: true, label: "Crossline", group: "Drawing tools" },
  { action: "tool:rectangle", key: "r", alt: true, shift: true, label: "Rectangle", group: "Drawing tools" },
  // No reference chord: the letter this product taught, promoted to ⌥.
  { action: "tool:text", key: "x", alt: true, label: "Text", group: "Drawing tools" },
  { action: "magnet", key: "m", alt: true, label: "Magnet", group: "Drawing tools" },
  // ⌥D is the reference's data window and ⌥L its log scale, so these two go
  // one modifier further rather than taking a chord that means something else
  // to a user arriving from it.
  { action: "stay-in-drawing-mode", key: "d", alt: true, shift: true, label: "Stay in drawing mode", group: "Drawing tools" },
  { action: "lock-drawings", key: "l", alt: true, shift: true, label: "Lock drawings", group: "Drawing tools" },
  // The reference's own chord for this one.
  { action: "hide-drawings", key: "h", mod: true, alt: true, label: "Hide drawings", group: "Drawing tools" },

  /*
   * The symbol search has no chord of its own, because its chord is EVERY
   * letter: `app/chart/page.tsx` opens it, seeded, on any bare printable
   * letter this table does not claim. Declared here so the command palette
   * and the shortcuts sheet still offer it — that is what `chordless` is for.
   */
  { action: "symbol-search", key: "", chordless: true, label: "Symbol search — type any letter", group: "Navigation" },
  { action: "indicators", key: "/", label: "Indicators", group: "Navigation" },
  { action: "chart-settings", key: ",", mod: true, label: "Chart settings", group: "Navigation" },
  /*
   * R8: the reference opens this sheet with ⌘/, from its own product menu row.
   *
   * `?` stays as an alias — the reference binds nothing to it, so it collides
   * with nothing, and it is what this product taught. Both are declared, so
   * the sheet prints both caps and `resolveShortcut` answers to both.
   */
  { action: "shortcuts-sheet", key: "/", mod: true, label: "Keyboard shortcuts", group: "Navigation" },
  { action: "shortcuts-sheet", key: "?", label: "Keyboard shortcuts", group: "Navigation" },
  { action: "command-palette", key: "k", mod: true, label: "Search tool or function", group: "Navigation" },
  /*
   * FG-04: the way back to a collapsed bottom panel.
   *
   * Until this existed there was exactly one — the panel's own tab strip — so
   * the strip could not be hidden when the panel was closed, and the product
   * carried two stacked grey bars under every chart where the reference
   * carries one. Read directly off a signed-in TradingView at 1440×900:
   * `.layout__area--bottom` is 0px tall with the panel closed and NO panel tab
   * is on screen at all.
   *
   * One binding rather than three, because the palette, the shortcuts sheet
   * and the keyboard handler all read this table — so the reopen path is
   * discoverable in three places from one line, which is the property this
   * file's own docstring says it exists to have.
   *
   * `p`, not `b`: `b` is Bar Replay, and the replay tests caught the collision
   * on the first run — which is what a keyboard table that two suites read is
   * for.
   *
   * TVP8 R4b-05: ⇧⌥P rather than the bare `p`, because a bare letter is the
   * symbol search now. ⌥P alone is the reference's percent scale.
   */
  { action: "bottom-panel", key: "p", alt: true, shift: true, label: "Positions, tester and Pine editor", group: "Navigation" },
  /*
   * TVP8 round two: ⌘⇧C was Chrome's element inspector.
   *
   * A shortcut the browser eats is worse than none — the user presses it,
   * DevTools opens, and they conclude the feature is broken — and it was
   * advertised in both the shortcut sheet and the palette. Copying an image
   * now has the two routes the reference gives it, the camera's own menu and
   * the palette, and no chord the browser will take first. ⌘⇧S is free and
   * stays.
   *
   * TVP8 R1c-12: the reference's camera menu prints ⌥⌘S beside `Download
   * image` and ⇧⌘S beside `Copy image`, and the menu now reads THIS table to
   * draw those caps — so a cap it prints is a chord that works, or there is no
   * cap. Both are available: ⌥⌘S was unreachable while the sentence above this
   * one was true, and it no longer is. `resolveShortcut` claims Alt binding by
   * binding rather than rejecting every Alt press, so Alt+ArrowLeft is still
   * the browser's Back — see the comment in that function. ⌘⇧S moves from Save
   * to Copy, which is where the reference has it, and neither is a chord
   * Chrome takes first (⌘⇧C, the obvious copy chord, is the element inspector
   * and is the reason this pair was broken in the first place).
   */
  { action: "snapshot-save", key: "s", mod: true, alt: true, label: "Save a chart image", group: "Chart" },
  { action: "snapshot-copy", key: "s", mod: true, shift: true, label: "Copy a chart image", group: "Chart" },
  { action: "fullscreen", key: "F", shift: true, label: "Fullscreen", group: "Chart" },
  // The reference's own ⌥R and ⌥L. `r` and `l` used to be bare; a bare letter
  // is the symbol search now (R4b-05).
  { action: "reset-view", key: "r", alt: true, label: "Reset the view", group: "Chart" },
  { action: "toggle-log", key: "l", alt: true, label: "Logarithmic scale", group: "Chart" },
  { action: "toggle-auto", key: "a", mod: true, shift: true, label: "Auto scale", group: "Chart" },

  /*
   * TVP8 round two: the three Replay actions were all `replayOnly`, so there
   * was no keyboard or palette route INTO a session and none out of one. The
   * only way to leave was a 12px × at the end of a strip below the chart.
   *
   * ⌥B for Bar Replay. The reference has no chord for entering a session at
   * all, and `b` was bare here until R4b-05 gave every bare letter to the
   * symbol search; ⌥B is free on the reference's own sheet. Not `replayOnly`,
   * because it is the way in.
   */
  { action: "replay-toggle", key: "b", alt: true, label: "Bar Replay", group: "Replay" },
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
/**
 * Whether Shift is a MODIFIER of this key, or part of producing it.
 *
 * `Shift+F` and `F` are two different presses, so the table distinguishes
 * them. `?` is not: on a US or UK layout it IS Shift+`/`, so the browser
 * reports `{ key: "?", shiftKey: true }` and a binding declared without
 * `shift` could never match. The shortcuts sheet — the discovery surface for
 * the whole keyboard layer — was unreachable by keyboard for exactly this
 * reason, and the test that claimed every binding was reachable synthesised
 * `shiftKey: false` for it, an event no keyboard emits.
 *
 * Declaring `shift: true` on the binding would fix `?` on those layouts and
 * break it on the ones where `?` is unshifted. Ignoring the flag for a key
 * that is already punctuation is correct on every layout.
 */
const shiftIsAModifier = (key: string): boolean =>
  key.length > 1 || /^[a-z0-9]$/i.test(key);

export function resolveShortcut(
  event: KeyEventLike, context: ShortcutContext
): ShortcutAction | null {
  if (isTypingTarget(event.target)) return null;
  // Space on a focused button presses the button. See `ownsActivationKeys`.
  if (ACTIVATION_KEYS.has(event.key) && ownsActivationKeys(event.target)) return null;
  const mod = context.mac ? event.metaKey : event.ctrlKey;
  /*
   * Alt is claimed binding by binding, never by default.
   *
   * This used to be `if (event.altKey) return null` — every Alt press rejected
   * outright, so the ⌥ chords the reference prints on its drawing rows could
   * not exist. Alt+ArrowLeft is still Back and Alt+F still opens a menu,
   * because no binding below declares `alt` for them and the loop's
   * `binding.alt !== event.altKey` test drops them all the same. The
   * difference is that the refusal is now a CONSEQUENCE of the table rather
   * than a rule above it.
   */
  /*
   * And the modifier that is NOT this platform's.
   *
   * `mod` is Cmd on macOS and Ctrl everywhere else, so a macOS Ctrl+T matched
   * the bare `t` binding and was preventDefault-ed — the app taking a chord it
   * never claimed. Rejecting the other modifier outright also makes the old
   * `if (!binding.mod && mod)` guard below unnecessary.
   */
  if (context.mac ? event.ctrlKey : event.metaKey) return null;
  for (const binding of BINDINGS) {
    if (binding.chordless) continue;
    if (binding.replayOnly && !context.replayActive) continue;
    if (binding.key.length === 1
      ? binding.key.toLowerCase() !== event.key.toLowerCase()
      : binding.key !== event.key) continue;
    if ((binding.mod ?? false) !== mod) continue;
    if ((binding.alt ?? false) !== event.altKey) continue;
    if (shiftIsAModifier(binding.key) && (binding.shift ?? false) !== event.shiftKey) continue;
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
