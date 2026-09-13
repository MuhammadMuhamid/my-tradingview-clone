/**
 * The chart toolbar's shared geometry, as class names.
 *
 * A module of its own, under `components/`, for two reasons. Tailwind's
 * `content` globs only scan `app/` and `components/`, so a class name written
 * in `lib/` emits no CSS at all — that is why this is not in
 * `lib/toolbarLayout` beside the breakpoint arithmetic. And the controls that
 * sit ON this bar (`ChartTypeMenu`, `SyncMenu`, `LayoutSelector`,
 * `TimeframePicker`) each own their own popover but must share the bar's
 * height, radius and hover behaviour with everything beside them; importing
 * that from `ChartToolbar` would make four import cycles, because the bar
 * imports all four of them.
 */

/**
 * The bar's height. Every control is exactly this tall.
 *
 * TradingView's are 38px with `padding: 0 6px`, full-bleed within the bar,
 * which is why its toolbar reads as one continuous surface divided into hit
 * zones rather than as a tray of pills.
 *
 * `h-[38px]` and not `h-9`/`h-10` because 38 is the measured number and the
 * whole point of the change is that the two products' toolbars are the same
 * height. Under `sm` the global touch rule in `globals.css` raises this to 44px
 * with `!important`, which is correct and deliberate — a finger is not a mouse.
 */
export const TOOLBAR_H = "h-[38px]";

/**
 * The header ROW's height.
 *
 * TVP7: 38, not 42. The previous value came from a screenshot reading; measured
 * off the live DOM the row and its controls are the same 38px, with the left
 * rail and the chart column starting 4px below it. Carrying 42 here put a 4px
 * band of bar above and below every control — half a line of chart, on every
 * pane, permanently.
 */
export const TOOLBAR_ROW_H = "h-[38px]";

/**
 * The state grammar every chrome control shares.
 *
 * The colour lives on a ::before chip inset 2px with a 6px radius (see
 * `.tvc-control` in `app/globals.css`) rather than on the button's own
 * background, and "selected" is read from `aria-pressed` / `aria-checked` /
 * `aria-expanded` / `data-active` rather than from a utility class. Two things
 * follow that are worth the indirection:
 *
 *   A full-bleed tint on a 38px button butts against its neighbour, so running
 *   the pointer along a row of icon buttons drags one continuous block of grey
 *   and no single control ever resolves. Inset by two pixels there is always a
 *   hairline of bar between two lit controls.
 *
 *   The visible state and the announced state are the same fact. A control
 *   cannot look active while reporting `aria-pressed="false"`.
 *
 * No `transition-colors`. 28 of 40 sampled controls carried a 150ms hover fade
 * where TradingView's carry 60ms or none; at the rate a trader scans across a
 * dense bar that reads as softness rather than as polish. The popovers that
 * open FROM these controls still animate — motion describing a change of state
 * is a different thing from a tint catching up with the pointer.
 */
export const TOOL_STATE = "tvc-control";

/** Every secondary toolbar control, at one height. */
export const TOOL_BUTTON =
  `${TOOL_STATE} flex ${TOOLBAR_H} shrink-0 items-center gap-1.5 px-1.5 text-sm ` +
  "text-ink-muted hover:text-ink disabled:hover:text-ink-muted";

/**
 * The hairline between groups of controls.
 *
 * A short centred rule rather than a gap: with full-bleed hit zones there is
 * no gap left to group by, and TradingView divides the same bar the same way.
 * Measured live: 1px wide, 22px tall, `--ts-line-strong`, sitting inside 4px of
 * clearance on each side.
 */
export const SEPARATOR = "mx-1 !h-[22px] w-px self-center !bg-border-strong";

/** An icon-only control on the bar: square, the bar's own height. */
export const TOOL_ICON_BUTTON =
  `${TOOL_STATE} flex ${TOOLBAR_H} w-[38px] shrink-0 items-center justify-center ` +
  "text-ink-muted hover:text-ink";

/**
 * A disclosure caret on its own: the second half of a split button.
 *
 * TradingView pairs a 38px action button with a 24px caret rather than putting
 * the caret inside the action, so clicking the icon applies the current value
 * and clicking the caret opens the list. 24 is the measured width.
 */
export const TOOL_CARET_BUTTON =
  `${TOOL_STATE} flex ${TOOLBAR_H} w-6 shrink-0 items-center justify-center ` +
  "text-ink-faint hover:text-ink";
