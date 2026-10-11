/**
 * A backtest's trade list as a CSV file, built in the browser.
 *
 * HVBO-3: the result page showed every trade and offered no way to take them
 * anywhere — a reader checking a run in a spreadsheet re-typed the table. The
 * file is built from the same records the trade list renders, with the same
 * reading rules (`tradeNetPct` for P/L %, net of costs like the P/L beside it).
 */
import type { Trade } from "./types";
import { tradeNetPct } from "./backtestFigures";

export const TRADE_CSV_COLUMNS = [
  "trade", "side", "entry_time_utc", "exit_time_utc", "qty", "entry_price", "exit_price",
  "pnl", "pnl_pct_net", "fees", "exit_reason",
] as const;

/** RFC 4180: a field with a comma, quote or line break is quoted, quotes doubled. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value;
  /*
   * A leading =, +, - or @ makes a spreadsheet evaluate the cell as a
   * formula. Every text field here is the engine's own (side, reason), but a
   * CSV leaves this page; a text cell is prefixed so it stays text. Numbers
   * are written as numbers — a negative P/L must stay a negative number.
   */
  const safe = typeof value === "string" && /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const iso = (ms: number | null): string => (ms === null ? "" : new Date(ms).toISOString());

/**
 * The commission a closed leg paid: its exit fee and its pro-rata share of
 * the entry fee, which is how the broker books it (`engine/broker.ts`) —
 * `commissionPct` of the entry notional plus the same of the exit notional.
 */
export function tradeFees(t: Pick<Trade, "entryPrice" | "exitPrice" | "qty">, commissionPct: number): number | null {
  if (t.exitPrice === null || !Number.isFinite(commissionPct)) return null;
  return (t.entryPrice + t.exitPrice) * Math.abs(t.qty) * (commissionPct / 100);
}

/** The CSV text, header first. An open trade is a row with its exit fields empty. */
export function tradesCsv(trades: readonly Trade[], commissionPct: number): string {
  const lines = [TRADE_CSV_COLUMNS.join(",")];
  for (const t of trades) {
    const net = tradeNetPct(t);
    const fees = tradeFees(t, commissionPct);
    lines.push([
      t.tradeNo, t.direction, iso(t.entryTime), iso(t.exitTime), t.qty, t.entryPrice, t.exitPrice,
      t.pnl, net === null ? null : Number(net.toFixed(4)),
      fees === null ? null : Number(fees.toFixed(8)),
      t.exitTime === null ? "open" : t.exitReason,
    ].map(cell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** A file name that says what it holds: `SOLUSDT-1h-trades-8f6d2c1e.csv`. */
export function tradesCsvName(bt: { symbol: string; timeframe: string; id: string }): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `${safe(bt.symbol)}-${safe(bt.timeframe)}-trades-${safe(bt.id.slice(0, 8))}.csv`;
}

/** Hand the reader a text file. Returns false when the browser cannot. */
export function downloadText(name: string, text: string, mime = "text/csv;charset=utf-8"): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } finally {
    // After the click has been dispatched; revoking first can cancel it.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
