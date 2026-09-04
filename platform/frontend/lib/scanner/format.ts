/** Formatting and the colour scale. Colour never carries meaning on its own. */

export function fmtNum(value: unknown, digits = 2): string {
  if (value === null || value === undefined || typeof value !== "number") return "—";
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return value.toFixed(digits);
}

export function fmtPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  // Crypto spans nine orders of magnitude; fixed decimals would be useless.
  const digits = value >= 1000 ? 1 : value >= 1 ? 3 : value >= 0.01 ? 5 : 8;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Signed value with a digit count chosen from its own magnitude.
 *
 * A MACD line is ~400 on BTC and ~0.00001 on a sub-cent coin. One fixed decimal
 * count renders one of those as noise and the other as "0.00", so the column has
 * to adapt per cell.
 */
export function fmtAdaptive(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 100) return sign + abs.toFixed(0);
  if (abs >= 1) return sign + abs.toFixed(2);
  if (abs >= 0.01) return sign + abs.toFixed(4);
  return sign + abs.toExponential(1);
}

export function fmtSigned(value: unknown, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function fmtAge(ms: number | null | undefined): string {
  if (!ms) return "—";
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

/**
 * Diverging colour for a signed value.
 *
 * Teal for positive, rose for negative — deliberately not red/green. Roughly
 * 8% of men have a red-green deficiency, and a table whose entire meaning is
 * carried by that one axis is unreadable for them. Teal is blue-shifted enough
 * to stay separable from rose under both protanopia and deuteranopia.
 *
 * Colour encodes magnitude only. The number is always rendered next to it, so
 * nothing here is load-bearing on its own.
 */
export function divergingStyle(
  value: unknown,
  saturateAt: number,
): { backgroundColor?: string; color?: string } {
  if (typeof value !== "number" || !Number.isFinite(value) || saturateAt <= 0) return {};
  const t = Math.min(Math.abs(value) / saturateAt, 1);
  if (t < 0.04) return {};
  const alpha = 0.10 + t * 0.42;
  const rgb = value > 0 ? "13, 148, 136" : "190, 18, 60";
  return { backgroundColor: `rgba(${rgb}, ${alpha})` };
}

/**
 * Full-saturation colour from the sign alone, magnitude deliberately ignored.
 *
 * For columns whose question is "which side of zero is this on", magnitude is
 * not comparable across coins — a MACD line of 400 on BTC and 0.0001 on a
 * sub-cent coin can be equally significant. Encoding magnitude there would make
 * the whole column read as "BTC is the only thing happening".
 */
export function signStyle(value: unknown): { backgroundColor?: string } {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return {};
  return {
    backgroundColor: value > 0 ? "rgba(13, 148, 136, 0.28)" : "rgba(190, 18, 60, 0.28)",
  };
}

export const DIRECTION_LABEL: Record<string, string> = {
  bull: "Bull",
  bear: "Bear",
  none: "—",
  mixed: "Mixed",
  ranging: "Ranging",
  transitional: "Transitional",
  trending: "Trending",
  oversold: "Oversold",
  neutral: "Neutral",
  overbought: "Overbought",
};

export function categoricalStyle(value: unknown): { backgroundColor?: string } {
  if (value === "bull" || value === "trending" || value === "oversold") {
    return { backgroundColor: "rgba(13, 148, 136, 0.22)" };
  }
  if (value === "bear" || value === "ranging" || value === "overbought") {
    return { backgroundColor: "rgba(190, 18, 60, 0.22)" };
  }
  return {};
}

