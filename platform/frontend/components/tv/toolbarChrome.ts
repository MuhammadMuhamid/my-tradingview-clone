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
 * FC2-M1: this row used to be 37px of padding around 28px controls with
 * 4-6px corner radii, so each button read as a discrete chip floating on a
 * bar — a web-app register. TradingView's are 38px, `border-radius: 0`,
 * `padding: 0 6px`, full-bleed within the bar, which is why its toolbar reads
 * as one continuous surface divided into hit zones rather than as a tray of
 * pills. Ten pixels of every control's height were being spent on air, and the
 * hit area of a control a trader hits hundreds of times a day was a third
 * smaller than it needed to be.
 *
 * `h-[38px]` and not `h-9`/`h-10` because 38 is the measured number and the
 * whole point of the change is that the two products' toolbars are the same
 * height. Under `sm` the global touch rule in `globals.css` raises this to 44px
 * with `!important`, which is correct and deliberate — a finger is not a mouse.
 */
export const TOOLBAR_H = "h-[38px]";

/**
 * Every secondary toolbar control, at one height.
 *
 * They were a mixture of `py-1` and `py-1.5` with three different text sizes,
 * so the row's baseline stepped up and down across it — the single most
 * visible difference between this toolbar and a professional one.
 *
 * No `transition-colors` (FC2-L1). 28 of 40 sampled controls carried a 150ms
 * hover fade where TradingView's carry 60ms or none; at the rate a trader
 * scans across a dense bar that reads as softness rather than as polish. The
 * popovers and panels that open FROM these controls still animate — that is
 * motion describing a change of state, which is a different thing from a tint
 * catching up with the pointer.
 */
export const TOOL_BUTTON =
  `flex ${TOOLBAR_H} shrink-0 items-center gap-1.5 px-1.5 text-sm ` +
  "text-ink-muted hover:bg-surface-2 hover:text-ink " +
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted";

/**
 * The hairline between groups of controls.
 *
 * A short centred rule rather than a gap: with full-bleed hit zones there is
 * no gap left to group by, and TradingView divides the same bar the same way.
 * It reads as a division of one surface instead of a space between two objects.
 */
export const SEPARATOR = "mx-1 !h-[22px] self-center";

/** An icon-only control on the bar: square, the bar's own height. */
export const TOOL_ICON_BUTTON =
  `flex ${TOOLBAR_H} w-[38px] shrink-0 items-center justify-center ` +
  "text-ink-muted hover:bg-surface-2 hover:text-ink";

