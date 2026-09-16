/**
 * Fitting a formatted number into a fixed column, by dropping trailing
 * decimals rather than letting it overflow.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * TVP8 F-01. The watchlist's numeric columns are fixed grid tracks, and the
 * values that go in them are not fixed at all: a 5-decimal instrument's change
 * (`−0.00440`) is 65px of tabular ink where a 1-decimal one's (`−202.8`) is 53.
 * The rows had no `overflow` and no `column-gap`, so a value wider than its
 * track simply PAINTED over its neighbour — which is how a reader got
 * `0.19280-0.004302.18%` as one run of digits with no way to tell where the
 * price ended and the change began.
 *
 * The grid now clips and gutters, so the overlap is structurally impossible.
 * This module is the other half: clipping a price mid-glyph is not a readable
 * price either, so a value that will not fit is re-formatted with fewer
 * decimals until it does — the reference's own answer, and the queue's
 * ("reduce decimals (drop trailing precision) rather than overflow").
 *
 * ── Why the measurement is real ────────────────────────────────────────────
 *
 * A character budget would be wrong twice over: `1` and `,` are not the same
 * width, and `tabular-nums` makes every DIGIT the width of the widest one
 * while leaving the separators alone. So the width is measured on a canvas
 * with the cell's own font, with the digits corrected to the tabular advance.
 * The correction matters — it is 12% on the system stack, which is the
 * difference between `76,024.0` fitting its track and spilling out of it.
 *
 * Where there is no canvas to measure with — jsdom, SSR — `measure` returns
 * `null` and the callers keep full precision. A test environment has no layout
 * either, so there is nothing there for a trim to protect.
 */

/** One measurer per font, because building the canvas is the expensive part. */
const CACHE = new Map<string, ((text: string) => number) | null>();

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * A text measurer for `font`, or null where the platform has no canvas.
 *
 * `measureText` honours the font but NOT `font-variant-numeric`, so every
 * digit comes back at its proportional width. Tabular numerals all take the
 * widest digit's advance, so the digits are re-priced at that advance and the
 * rest of the string is measured as it is.
 */
export function numericMeasurer(font: string): ((text: string) => number) | null {
  const cached = CACHE.get(font);
  if (cached !== undefined) return cached;
  let measurer: ((text: string) => number) | null = null;
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (context) {
      context.font = font;
      const digitWidth = Math.max(...DIGITS.map((d) => context.measureText(d).width));
      if (digitWidth > 0) {
        measurer = (text: string): number => {
          let width = 0;
          for (const char of text) {
            width += char >= "0" && char <= "9"
              ? digitWidth : context.measureText(char).width;
          }
          return width;
        };
      }
    }
  } catch { /* no canvas here; callers keep full precision */ }
  CACHE.set(font, measurer);
  return measurer;
}

/** The CSS `font` shorthand for an element, which `getComputedStyle` may not serialise. */
export function fontOf(element: Element): string {
  const style = getComputedStyle(element);
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`;
}

/**
 * The most decimals `format` can be given and still fit `width` pixels.
 *
 * Walks DOWN from the value's natural precision, so a column with room loses
 * nothing: only the instruments whose numbers genuinely do not fit are
 * shortened, and they are shortened by the least that works.
 *
 * `width <= 0` is an unmeasured column — the first render, before the layout
 * has been observed — and keeps full precision rather than guessing.
 */
export function fitDecimals(
  format: (digits: number) => string,
  digits: number,
  width: number,
  measure: ((text: string) => number) | null,
): string {
  const full = format(digits);
  if (!measure || width <= 0) return full;
  if (measure(full) <= width) return full;
  for (let d = digits - 1; d >= 0; d -= 1) {
    const text = format(d);
    if (measure(text) <= width) return text;
  }
  return format(0);
}
