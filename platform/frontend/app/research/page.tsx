"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardHeader, StatusBadge, Empty } from "@/components/ui";
import { BacktestForm } from "@/components/BacktestForm";
import { api } from "@/lib/api";
import type { Backtest, SymbolInfo } from "@/lib/types";
import { fmtPct, fmtDate, fmtAgo, signClass, UTC_DATE_NOTE } from "@/lib/format";

export default function BacktestsPage() {
  const router = useRouter();
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [rows, setRows] = useState<Backtest[]>([]);
  /*
   * Null until the list has been answered once.
   *
   * The failure was swallowed (`.catch(() => {})`), so `rows` stayed `[]` and a
   * backend that was down rendered as "No backtests yet. Configure one above" —
   * a confident empty state for a question that was never answered. An operator
   * reading that concludes their runs are gone.
   */
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = () => api.listBacktests()
    .then((r) => { setRows(r); setError(null); })
    .catch((e) => setError((e as Error).message))
    .finally(() => setLoaded(true));

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
      <div>
        <h1 className="text-lg font-semibold text-ink">Quick backtest</h1>
        <p className="text-xs text-ink-faint">
          Run the strategy (MA + R:R v9) over one symbol and window and inspect every trade it took.
          Parameter spaces, optimizers, walk-forward and research trees belong to the Backtester
          application; this page is the quick historical check.
        </p>
      </div>
      <BacktestForm symbols={symbols} onQueued={() => refresh()} />

      <Card>
        <CardHeader title="Recent runs" right={<span className="text-xs text-ink-faint">{rows.length} runs</span>} />
        {error && rows.length === 0 ? (
          <div role="alert" className="px-4 py-8 text-center text-sm text-down">
            The backtest list could not be loaded, so this is not a statement that you have none.
            <span className="mt-1 block font-mono text-xs text-ink-faint">{error}</span>
          </div>
        ) : !loaded ? (
          <div role="status" className="px-4 py-8 text-center text-sm text-ink-faint">Loading backtests…</div>
        ) : rows.length === 0 ? (
          <Empty>No backtests yet. Configure one above and hit “Run backtest”.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm tabular">
              <thead>
                <tr className="border-b border-border text-left text-xs text-ink-muted">
                  <th className="px-4 py-2 font-medium">Symbol</th>
                  <th className="px-4 py-2 font-medium">TF</th>
                  <th className="px-4 py-2 font-medium" title={UTC_DATE_NOTE}>Window (UTC)</th>
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
                      onClick={() => clickable && router.push(`/research/${r.id}`)}
                      className={`border-b border-border/50 ${clickable ? "hover:bg-surface-2 cursor-pointer" : ""}`}
                    >
                      {/*
                        The symbol is the link, not just the row.

                        Row click stays — it is the pointer affordance the table
                        was built around — but a `<tr onClick>` has no tab stop
                        and no Enter handler, so opening a result was impossible
                        without a mouse, and this is the ONLY route to one.
                      */}
                      <td className="px-4 py-2 font-medium">
                        {clickable ? (
                          <Link href={`/research/${r.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded text-ink underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                            {r.symbol}
                          </Link>
                        ) : r.symbol}
                      </td>
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
