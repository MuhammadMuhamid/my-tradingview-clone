/**
 * The price scale's mode, as a value rather than as a chart mutation.
 *
 * ── Why this is a module and not four `applyOptions` calls ─────────────────
 *
 * lightweight-charts already implements every behaviour offered here:
 * `mode` switches the axis between a linear and a logarithmic mapping,
 * `autoScale` refits the axis to whatever is in the viewport, and dragging or
 * double-clicking the axis is handled by the library's own
 * `handleScale.axisPressedMouseMove.price` / `axisDoubleClickReset.price`,
 * both of which are on by default and are deliberately left alone.
 *
 * What the library does NOT have is a *state*: `priceScale().options()` can be
 * read, but the chart is recreated-adjacent often enough — a presentation
 * change swaps the main series out from under the scale — that "what did the
 * user choose" has to be owned somewhere that a redraw cannot touch. That is
 * this file, and it holds a value with no chart in it, so the rule
 * "a candle update must not silently reset the scale" is a property a test can
 * assert without a browser.
 *
 * NOTHING here changes a price. The scale decides where a price is drawn; the
 * prices themselves come from the canonical candles and are untouched by every
 * function below.
 */

/**
 * The two mappings this product offers.
 *
 * Percentage and indexed-to-100 exist in the library and are deliberately not
 * exposed: they change what the axis *means* rather than how it is spaced, and
 * nothing in this wave asked for them. A menu that offers a mode nobody has
 * decided the semantics of is worse than a menu with two entries that work.
 */
export type PriceScaleMode = "normal" | "logarithmic";

export interface PriceScaleState {
  mode: PriceScaleMode;
  /** The library's `autoScale`: the axis refits itself to the viewport. */
  autoScale: boolean;
}

/** What a chart opens with, and what "Reset" restores. */
export const DEFAULT_PRICE_SCALE: PriceScaleState = { mode: "normal", autoScale: true };

export interface PriceScaleModeSpec {
  value: PriceScaleMode;
  label: string;
  hint: string;
}

export const PRICE_SCALE_MODES: readonly PriceScaleModeSpec[] = [
  {
    value: "normal", label: "Linear",
    hint: "Equal price differences take equal vertical space",
  },
  {
    value: "logarithmic", label: "Log",
    hint: "Equal percentage moves take equal vertical space",
  },
];

export function isPriceScaleMode(value: unknown): value is PriceScaleMode {
  return PRICE_SCALE_MODES.some((m) => m.value === value);
}

export function priceScaleModeLabel(mode: PriceScaleMode): string {
  return (PRICE_SCALE_MODES.find((m) => m.value === mode) ?? PRICE_SCALE_MODES[0]!).label;
}

/**
 * The one-line description of the scale as it currently stands.
 *
 * Requirement: the active mode must be identifiable at a glance. "Linear"
 * alone would not be — a chart that is linear and NOT auto-fitting behaves
 * visibly differently from one that is — so both halves are always stated.
 */
export function priceScaleLabel(state: PriceScaleState): string {
  return `${priceScaleModeLabel(state.mode)} · ${state.autoScale ? "Auto" : "Manual"}`;
}

/** True when the scale is exactly what a fresh chart would have. */
export function isDefaultPriceScale(state: PriceScaleState): boolean {
  return state.mode === DEFAULT_PRICE_SCALE.mode
    && state.autoScale === DEFAULT_PRICE_SCALE.autoScale;
}

export function setPriceScaleMode(
  state: PriceScaleState, mode: PriceScaleMode
): PriceScaleState {
  return state.mode === mode ? state : { ...state, mode };
}

/**
 * Flip between linear and logarithmic.
 *
 * Switching mapping does not switch auto-fit off: they are independent
 * choices, and silently changing the one the user did not touch is exactly the
 * kind of surprise that makes a scale control feel unreliable.
 */
export function togglePriceScaleMode(state: PriceScaleState): PriceScaleState {
  return setPriceScaleMode(state, state.mode === "normal" ? "logarithmic" : "normal");
}

export function setPriceScaleAuto(
  state: PriceScaleState, autoScale: boolean
): PriceScaleState {
  return state.autoScale === autoScale ? state : { ...state, autoScale };
}

export function togglePriceScaleAuto(state: PriceScaleState): PriceScaleState {
  return setPriceScaleAuto(state, !state.autoScale);
}

/**
 * Back to the default.
 *
 * Returns a fresh object rather than the shared constant so a caller cannot
 * mutate `DEFAULT_PRICE_SCALE` through it.
 */
export function resetPriceScale(): PriceScaleState {
  return { ...DEFAULT_PRICE_SCALE };
}

/**
 * A user drag of the price axis turns auto-fit off, because it has to.
 *
 * The library's own axis drag sets an explicit range; leaving `autoScale` on
 * in our state would mean the next re-application of that state — a
 * presentation change, a new series — silently threw the drag away. This is
 * the state transition that keeps our record honest about what the chart is
 * actually doing.
 */
export function priceScaleAfterManualScale(state: PriceScaleState): PriceScaleState {
  return setPriceScaleAuto(state, false);
}
