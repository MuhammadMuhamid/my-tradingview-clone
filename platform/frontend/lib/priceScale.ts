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
 * The four mappings this product offers.
 *
 * `normal` and `logarithmic` are about SPACING: the same prices, placed
 * differently. `percentage` and `indexedTo100` are about MEANING — the axis
 * stops reading in the instrument's currency and starts reading as movement
 * since the left edge of what is on screen.
 *
 * The last two were deliberately withheld until something asked for them,
 * because a menu entry whose semantics nobody has decided is worse than a
 * shorter menu. What asked for them is comparison: a pair of instruments, a
 * benchmark overlay and a ratio pane are all questions about relative
 * movement, and on a currency axis the answer to every one of them is
 * dominated by whichever instrument has the larger number.
 *
 * Both are the library's own modes, so the mapping is its arithmetic and not a
 * transform of the data: the candles handed to the chart are the canonical
 * ones under every mode, and switching modes cannot change a price, an alert,
 * a drawing's anchor or anything a study computes.
 */
export type PriceScaleMode = "normal" | "logarithmic" | "percentage" | "indexedTo100";

export interface PriceScaleState {
  mode: PriceScaleMode;
  /** The library's `autoScale`: the axis refits itself to the viewport. */
  autoScale: boolean;
  /**
   * Draw the axis upside down — high prices at the bottom.
   *
   * A real reading tool rather than a novelty: an inverted chart is how a
   * trader checks whether a pattern they believe they can see is a pattern or
   * a habit, because the eye that finds a head and shoulders finds it far less
   * often when the picture is flipped. Absent on a state written before this
   * existed, which is why every reader treats it as optional.
   */
  invert?: boolean;
}

/** What a chart opens with, and what "Reset" restores. */
export const DEFAULT_PRICE_SCALE: PriceScaleState = {
  mode: "normal", autoScale: true, invert: false,
};

export interface PriceScaleModeSpec {
  value: PriceScaleMode;
  label: string;
  hint: string;
  /** The short form on the chart's own scale control. */
  short: string;
}

export const PRICE_SCALE_MODES: readonly PriceScaleModeSpec[] = [
  {
    value: "normal", label: "Linear", short: "lin",
    hint: "Equal price differences take equal vertical space",
  },
  {
    value: "logarithmic", label: "Log", short: "log",
    hint: "Equal percentage moves take equal vertical space",
  },
  {
    value: "percentage", label: "Percent", short: "%",
    hint: "Movement since the first bar in view, in percent — what a comparison is read on",
  },
  {
    value: "indexedTo100", label: "Indexed to 100", short: "100",
    hint: "The first bar in view is 100 and everything else is relative to it",
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
  return `${priceScaleModeLabel(state.mode)} · ${state.autoScale ? "Auto" : "Manual"}`
    + (state.invert ? " · Inverted" : "");
}

/** True when the scale is exactly what a fresh chart would have. */
export function isDefaultPriceScale(state: PriceScaleState): boolean {
  return state.mode === DEFAULT_PRICE_SCALE.mode
    && state.autoScale === DEFAULT_PRICE_SCALE.autoScale
    && (state.invert ?? false) === false;
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
  return setPriceScaleMode(state, state.mode === "logarithmic" ? "normal" : "logarithmic");
}

/**
 * Flip between the currency axis and the percent axis.
 *
 * Its own toggle rather than a step through all four, because linear/log and
 * currency/percent are two independent questions and a single cycle button
 * would make choosing one of them mean passing through the other.
 */
export function togglePercentScale(state: PriceScaleState): PriceScaleState {
  return setPriceScaleMode(state, state.mode === "percentage" ? "normal" : "percentage");
}

export function setPriceScaleInvert(
  state: PriceScaleState, invert: boolean
): PriceScaleState {
  return (state.invert ?? false) === invert ? state : { ...state, invert };
}

export function togglePriceScaleInvert(state: PriceScaleState): PriceScaleState {
  return setPriceScaleInvert(state, !(state.invert ?? false));
}

/**
 * Coerce a stored or hand-edited scale onto something a chart can be given.
 *
 * Total, like every other restore in this product: a mode this build does not
 * have, a missing field or a string where a boolean belongs each fall back to
 * the default rather than reaching `applyOptions`, where an unknown mode is a
 * thrown error inside a render.
 */
export function normalizePriceScale(raw: unknown): PriceScaleState {
  if (!raw || typeof raw !== "object") return resetPriceScale();
  const value = raw as Partial<PriceScaleState>;
  return {
    mode: isPriceScaleMode(value.mode) ? value.mode : DEFAULT_PRICE_SCALE.mode,
    autoScale: typeof value.autoScale === "boolean"
      ? value.autoScale : DEFAULT_PRICE_SCALE.autoScale,
    invert: value.invert === true,
  };
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
 * Whether this scale reads in the instrument's own currency.
 *
 * The one distinction the rest of the product needs: a price readout, an
 * axis-price context menu and a click-to-arm-an-alert are all about a PRICE,
 * and under a percent or indexed axis the number beside the pointer is not
 * one. Callers ask this rather than testing for two specific modes, so a fifth
 * mode cannot be added without every one of them being reconsidered.
 */
export function scaleShowsPrices(state: PriceScaleState): boolean {
  return state.mode === "normal" || state.mode === "logarithmic";
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
