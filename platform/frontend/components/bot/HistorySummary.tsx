"use client";
/**
 * A summary of the closed trades on the page being shown.
 *
 * Adapted from the standalone Bot dashboard's `HistoryStatsBar`
 * (bot/frontend/src/pages/Dashboard.tsx). Two corrections: it covers only the
 * rows loaded (the history is paginated here) and says so, and the figure the
 * Classic dashboard called "Max drawdown" — the single worst losing trade —
 * is called "Worst trade", which is what it is.
 */
import { useState } from "react";
import type { BotViewTrade } from "@/lib/api";
import { fmtPct } from "@/lib/format";
import { calcHistoryStats, signedUsdtFixed } from "./botLogic";

/** Feature B: said wherever archived trades are left out of a figure. */
export const ARCHIVED_HIDDEN_NOTE =
  "Archived trades are hidden from this list. Realized P&L in the Overview, and the daily-loss limit, still count them.";

export function HistorySummary({ rows, total, archivedHidden = false }: {
  rows: BotViewTrade[]; total: number;
  /** Feature B: archived trades are hidden from this list (they still count in the Overview's Realized P&L). */
  archivedHidden?: boolean;
}) {
  const [open, setOpen] = useState(true);
  if (rows.length === 0) return null;
  const stats = calcHistoryStats(rows);
  return (
    <section aria-label="History summary" className="border-b border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <span className="text-xs text-ink-muted">
          Summary of the {rows.length} trade{rows.length === 1 ? "" : "s"} on this page{total > rows.length ? ` (of ${total})` : ""}
          {archivedHidden && <span className="block text-ink-faint">{ARCHIVED_HIDDEN_NOTE}</span>}
        </span>
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
          className="tvc-control rounded-md border border-control-border px-2 py-0.5 text-xs text-ink-muted hover:text-ink">
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 pb-3 text-sm tabular sm:grid-cols-4">
        <div><dt className="text-xs text-ink-muted">Total profit ({stats.winners})</dt>
          <dd className="font-semibold text-up">{signedUsdtFixed(stats.totalProfitUsdt)}</dd></div>
        <div><dt className="text-xs text-ink-muted">Total loss ({stats.losers})</dt>
          <dd className="font-semibold text-down">{signedUsdtFixed(stats.totalLossUsdt)}</dd></div>
        <div><dt className="text-xs text-ink-muted">Net P&amp;L</dt>
          <dd className={`font-semibold ${stats.netUsdt >= 0 ? "text-up" : "text-down"}`}>{signedUsdtFixed(stats.netUsdt)}</dd></div>
        <div><dt className="text-xs text-ink-muted">Worst trade</dt>
          <dd className="font-semibold text-down">{stats.worstTrade
            ? <>{signedUsdtFixed(stats.worstTrade.pnlUsdt)} <span className="text-xs font-normal text-ink-muted">({fmtPct(stats.worstTrade.pnlPct)}, {stats.worstTrade.pair})</span></>
            : <span className="font-normal text-ink-muted">No losing trade</span>}</dd></div>
      </dl>}
    </section>
  );
}
