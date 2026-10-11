/**
 * A colour's opacity, carried in the colour itself.
 *
 * W2A-06: the reference's colour picker ends in an `Opacity` slider, and a
 * drawing's colour is one string (`DrawingStyle.color`) that every renderer
 * already hands straight to the canvas. So opacity travels in that string as
 * an eight-digit `#rrggbbaa` — which `CanvasRenderingContext2D` reads natively,
 * and which multiplies correctly with the `globalAlpha` a fill or a highlighter
 * already sets — rather than as a second style key every one of the eighty-odd
 * paint paths would have to learn to read.
 *
 * Fully opaque is spelled with six digits, exactly as before, so a drawing
 * nobody has made translucent stores byte-for-byte what it always stored.
 *
 * Pure strings, no DOM: `tests/colorAlpha.test.ts` runs in node.
 */

const SIX = /^#[0-9a-f]{6}$/i;
const EIGHT = /^#[0-9a-f]{8}$/i;

/** The opaque `#rrggbb` and the opacity 0–100 of a colour; anything else is opaque as-is. */
export function splitAlpha(color: string): { hex: string; opacity: number } {
  const value = color.trim();
  if (EIGHT.test(value)) {
    return {
      hex: value.slice(0, 7).toLowerCase(),
      opacity: Math.round((parseInt(value.slice(7, 9), 16) / 255) * 100),
    };
  }
  return { hex: value, opacity: 100 };
}

/**
 * `hex` at `opacity` percent.
 *
 * 100 (or anything that is not a six-digit hex — a theme token, `""`) comes
 * back unchanged, so this can never turn a colour it does not understand into
 * one it invented.
 */
export function withAlpha(hex: string, opacity: number): string {
  const base = splitAlpha(hex).hex;
  if (!SIX.test(base)) return hex;
  const percent = Math.max(0, Math.min(100, Math.round(opacity)));
  if (percent >= 100) return base.toLowerCase();
  const byte = Math.round((percent / 100) * 255).toString(16).padStart(2, "0");
  return `${base.toLowerCase()}${byte}`;
}

/** The colour with its opacity dropped — for a chip whose text must stay readable. */
export function opaque(color: string): string {
  return splitAlpha(color).hex;
}
