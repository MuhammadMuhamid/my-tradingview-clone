export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(digits)}%`;
}

export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  // Adaptive precision: more decimals for small-priced coins.
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
