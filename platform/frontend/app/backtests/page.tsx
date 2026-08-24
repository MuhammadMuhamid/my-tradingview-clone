"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, StatusBadge, Empty } from "@/components/ui";
import { BacktestForm } from "@/components/BacktestForm";
import { api } from "@/lib/api";
import type { Backtest, SymbolInfo } from "@/lib/types";
import { fmtPct, fmtDate, fmtAgo, signClass } from "@/lib/format";

export default function BacktestsPage() {
  const router = useRouter();
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [rows, setRows] = useState<Backtest[]>([]);

  const refresh = () => api.listBacktests().then(setRows).catch(() => {});

  useEffect(() => {
    api.listSymbols().then(setSymbols).catch(() => {});
    refresh();
  }, []);

  // Poll while any run is queued/running.
  useEffect(() => {
    const anyPending = rows.some((r) => r.status === "queued" || r.status === "running");
    if (!anyPending) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [rows]);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 space-y-6">
      <BacktestForm symbols={symbols} onQueued={() => refresh()} />

      <Card>
        <CardHeader title="Backtests" right={<span className="text-xs text-ink-faint">{rows.length} runs</span>} />
        {rows.length === 0 ? (
          <Empty>No backtests yet. Configure one above and hit “Run backtest”.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm tabular">
              <thead>
                <tr className="border-b border-border text-left text-xs text-ink-muted">
                  <th className="px-4 py-2 font-medium">Symbol</th>
                  <th className="px-4 py-2 font-medium">TF</th>
                  <th className="px-4 py-2 font-medium">Window</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium text-right">Net %</th>
                  <th className="px-4 py-2 font-medium text-right">PF</th>
                  <th className="px-4 py-2 font-medium text-right">Trades</th>
                  <th className="px-4 py-2 font-medium text-right">Win %</th>
                  <th className="px-4 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const m = r.metrics;
                  const clickable = r.status === "done";
                  return (
                    <tr
                      key={r.id}
                      onClick={() => clickable && router.push(`/backtests/${r.id}`)}
                      className={`border-b border-border/50 ${clickable ? "hover:bg-surface-2 cursor-pointer" : ""}`}
                    >
                      <td className="px-4 py-2 font-medium">{r.symbol}</td>
                      <td className="px-4 py-2 text-ink-muted">{r.timeframe}</td>
                      <td className="px-4 py-2 text-ink-muted">{fmtDate(r.startTime)} → {fmtDate(r.endTime)}</td>
                      <td className="px-4 py-2">
                        <StatusBadge status={r.status} />
                        {r.error && <div className="mt-1 text-xs text-down">{r.error}</div>}
                      </td>
                      <td className={`px-4 py-2 text-right ${m ? signClass(m.netProfitPct) : "text-ink-faint"}`}>{m ? fmtPct(m.netProfitPct) : "—"}</td>
                      <td className="px-4 py-2 text-right">{m ? (m.profitFactor === null ? "∞" : m.profitFactor.toFixed(2)) : "—"}</td>
                      <td className="px-4 py-2 text-right">{m ? m.totalTrades : "—"}</td>
                      <td className="px-4 py-2 text-right">{m ? `${m.winRatePct.toFixed(1)}%` : "—"}</td>
                      <td className="px-4 py-2 text-ink-faint">{fmtAgo(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
