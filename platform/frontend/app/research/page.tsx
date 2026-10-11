"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardHeader, Checkbox, Empty, PageHeader, PageShell, StatusBadge } from "@/components/ui";
import { shortReason } from "@/lib/errorCopy";
import { BacktestForm } from "@/components/BacktestForm";
import { CompareRuns } from "@/components/CompareRuns";
import { api } from "@/lib/api";
import type { Backtest, Strategy, SymbolInfo } from "@/lib/types";
import { fmtPct, fmtDate, fmtAgo, signClass, UTC_DATE_NOTE } from "@/lib/format";
import {
  profitFactorText, profitFactorTone, runFailure, strategyFor, tradeFigures, winRateText,
} from "@/lib/backtestFigures";

/** At most this many runs are compared at once — a side-by-side, not a table. */
const COMPARE_MAX = 2;

export default function BacktestsPage() {
  const router = useRouter();
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
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
  /** Runs ticked for comparison, in the order they were ticked. */
  const [picked, setPicked] = useState<string[]>([]);
  /*
   * "Edit and re-run" on a result page lands here as `?from=<id>`. Read from
   * `window.location` once on mount rather than `useSearchParams`, which would
   * oblige a Suspense boundary around the whole page for one optional value.
   */
  const [preset, setPreset] = useState<Backtest | null>(null);

  const refresh = () => api.listBacktests()
    .then((r) => { setRows(r); setError(null); })
    .catch((e) => setError((e as Error).message))
    .finally(() => setLoaded(true));

  useEffect(() => {
    api.listSymbols().then(setSymbols).catch(() => {});
    api.listStrategies().then(setStrategies).catch(() => {});
    refresh();
    const from = new URLSearchParams(window.location.search).get("from");
    // An unreadable source run leaves the form on its defaults, which is what
    // the reader would have had without the link.
    if (from) api.getBacktest(from).then(setPreset).catch(() => {});
  }, []);

  // Poll while any run is queued/running.
  useEffect(() => {
    const anyPending = rows.some((r) => r.status === "queued" || r.status === "running");
    if (!anyPending) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [rows]);

  return (
    <PageShell>
      <PageHeader
        title="Quick backtest"
        description={<>
          Run one of the engine&rsquo;s strategies over a symbol and window and inspect every trade it took.
          Parameter spaces, optimizers, walk-forward and research trees belong to the Backtester
          application; this page is the quick historical check.
        </>}
      />
      {/*
        Keyed on the preset AND, for a preset, on whether the strategy list has
        arrived: the form reads both into its initial state, and a strategy key
        resolved against an empty list would fall back to the default strategy.
        A blank form is never remounted, so nothing a reader has typed is lost.
      */}
      <BacktestForm key={preset ? `${preset.id}:${strategies.length > 0}` : "new"}
        symbols={symbols} strategies={strategies} preset={preset} onQueued={() => refresh()} />

      <Card>
        <CardHeader title="Recent runs" right={<span className="text-xs text-ink-faint">{rows.length} runs</span>} />
        {error && rows.length === 0 ? (
          <div role="alert" className="px-4 py-8 text-center text-sm text-down">
            The backtest list could not be loaded, so this is not a statement that you have none.
            {/* REV-UX-01: the cause is the tooltip, not a second line of prose. */}
            <span className="mt-1 block text-xs text-ink-faint" title={error}>{shortReason(error)}</span>
          </div>
        ) : !loaded ? (
          <div role="status" className="px-4 py-8 text-center text-sm text-ink-faint">Loading backtests…</div>
        ) : rows.length === 0 ? (
          <Empty>No backtests yet. Configure one above and hit “Run backtest”.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm tabular">
              <thead>
                <tr className="border-b border-border text-left text-xs text-ink-muted">
                  <th className="w-8 py-2 pl-4 font-medium"><span className="sr-only">Compare</span></th>
                  <th className="px-4 py-2 font-medium">Symbol</th>
                  <th className="px-4 py-2 font-medium">Strategy</th>
                  <th className="px-4 py-2 font-medium">TF</th>
                  <th className="px-4 py-2 font-medium" title={UTC_DATE_NOTE}>Window (UTC)</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium text-right">Net %</th>
                  <th className="px-4 py-2 font-medium text-right">PF</th>
                  <th className="px-4 py-2 font-medium text-right"
                    title="Entries. A run recorded before entries were counted separately shows exit legs, and says so.">Trades</th>
                  <th className="px-4 py-2 font-medium text-right">Win %</th>
                  <th className="px-4 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const m = r.metrics;
                  const f = m ? tradeFigures(m) : null;
                  const pfTone = f ? profitFactorTone(f) : "none";
                  const clickable = r.status === "done";
                  const strategy = strategyFor(r, strategies);
                  const isPicked = picked.includes(r.id);
                  const failure = r.status === "error" ? runFailure(r.error) : null;
                  return (
                    <tr
                      key={r.id}
                      onClick={() => clickable && router.push(`/research/${r.id}`)}
                      className={`border-b border-border/50 ${clickable ? "hover:bg-state-hover cursor-pointer" : ""}`}
                    >
                      {/*
                        The symbol is the link, not just the row.

                        Row click stays — it is the pointer affordance the table
                        was built around — but a `<tr onClick>` has no tab stop
                        and no Enter handler, so opening a result was impossible
                        without a mouse, and this is the ONLY route to one.
                      */}
                      <td className="py-2 pl-4" onClick={(e) => e.stopPropagation()}>
                        {clickable && (
                          <Checkbox checked={isPicked}
                            disabled={!isPicked && picked.length >= COMPARE_MAX}
                            label={`Compare ${r.symbol} ${r.timeframe} run from ${fmtDate(r.createdAt)}`}
                            onChange={(on) => setPicked((p) => on ? [...p, r.id].slice(-COMPARE_MAX) : p.filter((x) => x !== r.id))} />
                        )}
                      </td>
                      <td className="px-4 py-2 font-medium">
                        {clickable ? (
                          <Link href={`/research/${r.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded text-ink underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                            {r.symbol}
                          </Link>
                        ) : r.symbol}
                        {/*
                          A stress window is an ordinary backtest row, chosen
                          with hindsight. Unmarked, it reads as one more quick
                          run over a strangely short window.
                        */}
                        {r.stressRunId !== null && (
                          <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[11px] font-normal text-ink-muted"
                            title="One window of a stress analysis — its dates were chosen with hindsight">
                            Stress
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-ink-muted" title={strategy ? `key ${strategy.key}` : undefined}>
                        {strategy ? strategy.name : strategies.length === 0 ? "—" : `#${r.strategyId}`}
                      </td>
                      <td className="px-4 py-2 text-ink-muted">{r.timeframe}</td>
                      <td className="px-4 py-2 text-ink-muted">{fmtDate(r.startTime)} → {fmtDate(r.endTime)}</td>
                      <td className="px-4 py-2">
                        <StatusBadge status={r.status} />
                        {/*
                          The engine's own words (`invalid SOLUSDT 1h backfill:
                          empty_series`) were this cell's body. They are the
                          tooltip now; the cell says what happened.
                        */}
                        {failure && <div className="mt-1 max-w-[260px] text-xs text-down" title={failure.detail}>{failure.headline}</div>}
                      </td>
                      <td className={`px-4 py-2 text-right ${m ? signClass(m.netProfitPct) : "text-ink-faint"}`}>{m ? fmtPct(m.netProfitPct) : "—"}</td>
                      <td className={`px-4 py-2 text-right ${pfTone === "up" ? "text-up" : pfTone === "down" ? "text-down" : ""}`}>
                        {f ? profitFactorText(f) : "—"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {f ? f.count : "—"}
                        {f?.basis === "legs" && <span className="ml-1 text-xs text-ink-faint">legs</span>}
                      </td>
                      <td className="px-4 py-2 text-right">{f ? winRateText(f) : "—"}</td>
                      <td className="px-4 py-2 text-ink-faint">{fmtAgo(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {picked.length < COMPARE_MAX && rows.some((r) => r.status === "done") && (
              <p className="px-4 py-2 text-xs text-ink-faint">
                Tick two finished runs to compare them side by side.
              </p>
            )}
          </div>
        )}
      </Card>

      {(() => {
        const [a, b] = picked.map((id) => rows.find((r) => r.id === id)).filter((r): r is Backtest => r !== undefined);
        return a && b ? <CompareRuns a={a} b={b} strategies={strategies} onClear={() => setPicked([])} /> : null;
      })()}
    </PageShell>
  );
}
