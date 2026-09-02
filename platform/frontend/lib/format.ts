export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(digits)}%`;
}

/**
 * An asset QUANTITY or balance.
 *
 * Unlike a price, a balance must not be rounded to a fixed width: showing
 * "0.00" beside a real holding of 0.0004 BTC tells the operator they have
 * nothing. Trailing zeros are dropped so the number reads as the amount it is,
 * and up to eight decimals are kept because that is Binance's own precision.
 */
export function fmtQty(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n === 0) return "0";
  const fixed = n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return fixed === "" || fixed === "-" ? "0" : fixed;
}

export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  // Adaptive precision: more decimals for small-priced coins.
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * A price DELTA, at the precision of the price it was taken from.
 *
 * `fmtPrice` picks its decimals from the magnitude of the number it is given,
 * which is right for a price and wrong for the difference between two: a
 * 102.31 close moving by seven thousandths was printed in the chart legend as
 * "−0.006980", six decimals of noise beside a two-decimal price. The delta is
 * shown the way the reference chart headers show it — same precision as the
 * price, and always signed.
 */
export function fmtPriceDelta(
  delta: number | null | undefined, reference: number,
  /** A spread is a magnitude, not a movement, so it is shown unsigned. */
  signed = true
): string {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return "—";
  const abs = Math.abs(reference);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  const sign = !signed ? "" : delta >= 0 ? "+" : "−";
  return `${sign}${Math.abs(delta).toLocaleString(undefined, {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  })}`;
}

export function fmtDateTime(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export function fmtDate(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

export function fmtAgo(ms: number | string): string {
  const t = typeof ms === "string" ? new Date(ms).getTime() : ms;
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const signClass = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? "text-ink-muted" : n >= 0 ? "text-up" : "text-down";
