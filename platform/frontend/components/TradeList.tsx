import type { Trade } from "@/lib/types";
import { fmtPrice, fmtPct, fmtNum, fmtDateTime, signClass } from "@/lib/format";

export function TradeList({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-ink-faint">No trades in this backtest.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular">
        <thead>
          <tr className="border-b border-border text-left text-xs text-ink-muted">
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Entry time</th>
            <th className="px-3 py-2 font-medium text-right">Entry</th>
            <th className="px-3 py-2 font-medium">Exit time</th>
            <th className="px-3 py-2 font-medium text-right">Exit</th>
            <th className="px-3 py-2 font-medium">Reason</th>
            <th className="px-3 py-2 font-medium text-right">P/L %</th>
            <th className="px-3 py-2 font-medium text-right">P/L</th>
            <th className="px-3 py-2 font-medium text-right">Cumulative</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const open = t.exitTime === null;
            return (
            <tr key={t.tradeNo}
                className={`border-b border-border/50 hover:bg-surface-2 ${open ? "bg-warn/5" : ""}`}>
              <td className="px-3 py-1.5 text-ink-faint">{t.tradeNo}</td>
              <td className="px-3 py-1.5 text-ink-muted">{fmtDateTime(t.entryTime)}</td>
              <td className="px-3 py-1.5 text-right">{fmtPrice(t.entryPrice)}</td>
              <td className="px-3 py-1.5 text-ink-muted">{open ? "—" : fmtDateTime(t.exitTime)}</td>
              <td className="px-3 py-1.5 text-right">{open ? "—" : fmtPrice(t.exitPrice)}</td>
              <td className="px-3 py-1.5">
                {open
                  ? <span className="rounded bg-warn/15 px-1.5 py-0.5 text-xs font-medium text-warn">OPEN</span>
                  : <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-muted">{t.exitReason ?? "—"}</span>}
              </td>
              <td className={`px-3 py-1.5 text-right ${signClass(t.pnlPct)}`}>{fmtPct(t.pnlPct)}</td>
              <td className={`px-3 py-1.5 text-right ${signClass(t.pnl)}`}>{fmtNum(t.pnl)}</td>
              <td className={`px-3 py-1.5 text-right ${signClass(t.cumProfit)}`}>{fmtNum(t.cumProfit)}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
