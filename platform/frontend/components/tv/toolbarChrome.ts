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

/**
 * Every secondary toolbar control, at one height.
 *
 * TVP8 R1b-01: `text-ink` at REST, with no muted→ink hover shift. Measured on
 * the reference, every glyph, caret and unarmed chip on the bar peaks at the
 * same rgb(219) as the ticker and the layout name; ours peaked at rgb(168) and
 * only reached 219 under the pointer. Fifty-one luminance levels on twenty
 * controls is what made our bar read as a greyed-out bar with two bright words
 * on it. The hover state is the CHIP (`.tvc-control::before`), never the ink.
 */
/**
 * The line box every word on the 38px row shares (R1c-19).
 *
 * Measured on the reference, an interval chip's `1m` inks rows 15–24 and `4h`
 * 14–24; ours inked 14–23 and 13–23 — a whole pixel high, on every label on
 * the bar at once, which is the kind of difference that reads as "not quite
 * the same product" without ever being nameable. An 18px line box pinned with
 * one pixel of top padding puts the caps where the reference's are, and it is
 * one constant so the chips, the layout name and the More strip's worded
 * buttons cannot drift a pixel apart from each other again.
 */
export const TEXT_BASELINE = "leading-[18px] pt-px";

export const TOOL_BUTTON =
  `${TOOL_STATE} flex ${TOOLBAR_H} shrink-0 items-center gap-1.5 px-1.5 text-sm ` +
  `text-ink ${TEXT_BASELINE}`;

/**
 * The hairline between groups of controls.
 *
 * A short centred rule rather than a gap: with full-bleed hit zones there is
 * no gap left to group by, and TradingView divides the same bar the same way.
 * Measured live: 1px wide, 22px tall, `--ts-line-strong`, sitting inside 4px of
 * clearance on each side.
 */
export const SEPARATOR = "mx-1 !h-[22px] w-px self-center !bg-border-strong";

/**
 * The glyph inside a 38×38 control.
 *
 * ── TVP8 R1c-02: one unit is one pixel, and one pixel is the stroke ────────
 *
 * The reference's toolbar glyphs are CRISP 1px line work sitting on the pixel
 * grid. Measured at the pixel level: its layout glyph carries 68 ink px, of
 * which 56 are fully lit and 12 half-lit — that is the exact perimeter of a
 * 19×17 rectangle drawn at one device pixel. Its fullscreen glyph is 52 (four
 * 13px brackets), templates 112, settings 116, indicators 109, alert 114,
 * replay 74, quick search 110, snapshot 112, compare 101.
 *
 * Ours were 1.5-wide strokes in a 24-unit viewBox rendered at 22px, so every
 * stroke landed 1.375 device pixels wide and, being off the grid, was drawn as
 * two half-lit rows instead of one lit row: layout 128 ink px (56 lit / 72
 * half-lit), fullscreen 76, templates 220, settings 164 — 1.4–2.0× the
 * reference's ink at the same silhouette size. That is why our bar read as a
 * heavier icon family even after the silhouettes were corrected in wave 2.
 *
 * The fix is arithmetic, not taste. A 28-unit viewBox rendered at 28px makes
 * one user unit exactly one CSS pixel, so a rectilinear segment placed on an
 * `x.5` coordinate with a 1px stroke covers exactly one pixel column and
 * nothing bleeds into its neighbours. Every silhouette in
 * `ChartToolbar.Glyph` and `ChartTypeMenu.ICONS` is drawn on that grid.
 *
 * The two constants must move together: the viewBox is `0 0 ${TOOL_ICON_SIZE}
 * ${TOOL_ICON_SIZE}`, and the whole 1:1 property is lost the moment they
 * disagree.
 */
export const TOOL_ICON_SIZE = 28;
/** One device pixel (R1c-02). See `TOOL_ICON_SIZE` for why this is not 1.5. */
export const TOOL_ICON_STROKE = 1;

/**
 * A pill with a word in it — `Trade`, at the right end of the reference's
 * bar. 28px tall, 1px border, no fill: it is the one outline control on the
 * row, the way the symbol pill is the one filled one.
 */
export const TOOL_PILL_OUTLINE =
  // R1c-19: `px-[11px]`, not `px-3`. The reference's pill is 61px wide and
  // ours measured 62.8 — one pixel of padding a side is the whole difference,
  // and the pill is the row's last control, so it sets where the row ends.
  "flex h-7 shrink-0 items-center rounded-full border border-border-strong px-[11px] text-sm " +
  "text-ink hover:bg-state-hover disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * An icon-only control on the bar: square, the bar's own height.
 *
 * Full ink at rest (R1b-01). See `TOOL_BUTTON`.
 */
export const TOOL_ICON_BUTTON =
  `${TOOL_STATE} flex ${TOOLBAR_H} w-[38px] shrink-0 items-center justify-center ` +
  "text-ink";

/**
 * A disclosure caret on its own: the second half of a split button.
 *
 * TradingView pairs a 38px action button with a 24px caret rather than putting
 * the caret inside the action, so clicking the icon applies the current value
 * and clicking the caret opens the list. 24 is the measured width.
 *
 * Full ink at rest (R1b-01): the reference's three carets all measure rgb(219),
 * ours measured 140. The caret GLYPH is the shared 8×4 chevron — see
 * `TOOL_CARET_GLYPH`.
 */
export const TOOL_CARET_BUTTON =
  `${TOOL_STATE} flex ${TOOLBAR_H} w-6 shrink-0 items-center justify-center ` +
  "text-ink";

/**
 * The disclosure chevron every split control draws.
 *
 * One shape, one size: measured on the reference, the interval caret, the
 * chart-style caret and the saved-layout caret are the same 8×4 hairline
 * chevron at full ink. Ours were three different SVGs at three sizes and two
 * stroke weights, and the layout one was the smallest and faintest of them
 * (R1b-06).
 */
export const TOOL_CARET_GLYPH = {
  width: 10,
  height: 6,
  viewBox: "0 0 10 6",
  /** Ink extent 8.3 × 4.1 at stroke 1.5 — the measured 8×4. */
  d: "M1.6 1.7L5 4.3 8.4 1.7",
  stroke: 1.5,
} as const;
