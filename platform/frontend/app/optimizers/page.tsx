"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type OptimizerLeaderboard, type OptimizerTree } from "@/lib/api";
import { Card, CardHeader, Empty, Select } from "@/components/ui";

type Metric = "score" | "net" | "dd" | "wr" | "pf" | "trades"
  | "oos" | "oosdd" | "ooswr" | "oostrades" | "held" | "sl" | "oossl";

/**
 * Did the in-sample edge survive on data the optimizer never saw?
 * A row that is green in-sample and red out-of-sample was fitted to noise,
 * however good its headline numbers look.
 */
function verdict(net?: number | null, oos?: number | null):
  { label: string; cls: string } {
  if (oos === null || oos === undefined) return { label: "—", cls: "text-ink-faint" };
  if ((net ?? 0) > 0 && oos > 0) return { label: "HELD", cls: "text-up font-medium" };
  if ((net ?? 0) > 0 && oos <= 0) return { label: "FAILED", cls: "text-down font-medium" };
  return { label: "weak", cls: "text-ink-muted" };
}

/**
 * The tree list is no longer hardcoded here.
 *
 * It used to name five systems, one of which (`srtrend_v10`) resolved to a
 * directory that does not exist and rendered as a successful empty table, while
 * nine trees that DO exist had no entry at all (`X-04`). The backend registry
 * is now the single source of truth and this page renders whatever it reports.
 */
const STATUS_NOTE: Record<OptimizerTree["status"], string> = {
  current: "",
  historical: "Historical run — kept for reference. It does not describe the current parameter space.",
  "not-comparable": "Cost model differs from every other tree. Do not rank this beside them.",
};

const n = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? "—" : v.toFixed(digits);

/**
 * What these numbers are, above the numbers themselves.
 *
 * `OPT-01` is the audit's most consequential research finding and it is not a
 * bug in the engine: the way winning configurations were chosen re-used the
 * data meant to check them, and nothing on this page said so. A leaderboard
 * rendered without that context reads as measured performance. It is not.
 *
 * Collapsed by default so it does not shout on every visit, and open on first
 * load for a viewer who has not dismissed it before — the choice is remembered
 * per browser, and a browser that refuses storage simply shows it collapsed.
 */
function Methodology() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem("optimizer-methodology-seen") !== "1");
    } catch {
      // Private windows and blocked site data throw on access. Not a reason to
      // fail; just start collapsed.
    }
  }, []);

  const toggle = () => {
    setOpen((wasOpen) => {
      if (wasOpen) {
        try { window.localStorage.setItem("optimizer-methodology-seen", "1"); } catch { /* fine */ }
      }
      return !wasOpen;
    });
  };

  return (
    <Card>
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-medium text-ink">
          How these numbers were produced — read before trusting one
        </span>
        <span aria-hidden="true" className="text-xs text-ink-faint">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3 text-xs leading-relaxed text-ink-muted">
          <p className="text-ink">
            <strong>Out-of-sample is not a validation set for anything deployed.</strong> The
            selection rule gates on the out-of-sample window and maximises over it, so IS/OOS
            agreement is a selection artefact rather than evidence of robustness. The analysis
            script that produces the deploy artifact says so itself: <em>&ldquo;OOS is optimized
            here and is consumed; forward/paper validation is mandatory.&rdquo;</em>
          </p>
          <p>
            Corroborating, from inside this repository: the 1-hour hold-out report measured a mean
            rank correlation of <strong>+0.03</strong> between in-sample leaderboard rank and
            out-of-sample net, where 1.0 would be perfect. In-sample rank has essentially no
            predictive power.
          </p>
          <p>
            <strong>A maximum over an enormous search lands on its constraints.</strong> Rows
            marked <span className="rounded bg-warn/20 px-1 text-[10px] font-medium">floor</span>{" "}
            won with the fewest trades the objective allows — the fewer trades a result rests on,
            the more of its return can be luck.
          </p>
          <p>
            <strong>Trees are not comparable unless their cost models agree.</strong> Each tree
            states its own, and one tree runs zero slippage with full compounding and no IS/OOS
            split at all; it is labelled <em>not comparable</em> and its numbers must not be
            ranked beside the others&rsquo;.
          </p>
          <p>
            <strong>Historical trees describe a parameter space that was replaced.</strong> Four of
            the five walk-forward trees search a different set of parameters from the production
            tree they are cited for, so the current production space has no walk-forward evidence.
          </p>
          <p>
            <strong>Before deploying:</strong> choose on the in-sample views, then score the chosen
            configuration once on the frozen holdout. The deploy scripts refuse a configuration
            with no holdout record — absence of a result is not a pass.
          </p>
          <p className="text-ink-faint">
            The long form, with the evidence for each statement, is in
            {" "}<code>docs/RESEARCH-METHODOLOGY.md</code> and <code>docs/COST-MODELS.md</code>.
          </p>
        </div>
      )}
    </Card>
  );
}

export default function OptimizersPage() {
  const [trees, setTrees] = useState<OptimizerTree[] | null>(null);
  const [treesError, setTreesError] = useState("");
  const [selected, setSelected] = useState("");
  const [metric, setMetric] = useState<Metric>("score");
  const [data, setData] = useState<OptimizerLeaderboard | null>(null);
  const [error, setError] = useState("");
  const current = trees?.find((t) => t.id === selected) ?? null;

  useEffect(() => {
    let live = true;
    api.optimizerTrees()
      .then((res) => {
        if (!live) return;
        setTrees(res.trees);
        // Default to a tree that is actually current, not simply the first one.
        const first = res.trees.find((t) => t.kind === "search" && t.status === "current")
          ?? res.trees[0];
        setSelected(first?.id ?? "");
      })
      .catch((e: Error) => { if (live) setTreesError(e.message); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    const refresh = () => {
      api.optimizerLeaderboardByTree(selected)
        .then((res) => { if (live) { setData(res); setError(""); } })
        .catch((e: Error) => { if (live) { setData(null); setError(e.message); } });
    };
    setData(null);
    setError("");
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [selected]);

  const rows = useMemo(() => {
    const copy = [...(data?.leaderboard ?? [])];
    const value = (row: OptimizerLeaderboard["leaderboard"][number]) => {
      if (metric === "score") return row.score ?? -Infinity;
      if (metric === "net") return row.metrics.net_pct ?? -Infinity;
      if (metric === "dd") return row.metrics.dd_pct ?? Infinity;
      if (metric === "wr") return row.metrics.win_rate ?? -Infinity;
      if (metric === "pf") return row.metrics.profit_factor ?? -Infinity;
      if (metric === "oos") return row.metrics.oos_net_pct ?? -Infinity;
      if (metric === "oosdd") return row.metrics.oos_dd_pct ?? Infinity;
      if (metric === "ooswr") return row.metrics.oos_win_rate ?? -Infinity;
      if (metric === "oostrades") return row.metrics.oos_trades ?? -Infinity;
      if (metric === "sl") return row.metrics.sl_loss_rate ?? Infinity;
      if (metric === "oossl") return row.metrics.oos_sl_loss_rate ?? Infinity;
      // "held": rank by the WEAKER of the two halves — a config is worth no more
      // than its worst window, so this cannot be flattered by one strong period.
      if (metric === "held") {
        const a1 = row.metrics.net_pct, b1 = row.metrics.oos_net_pct;
        if (a1 === null || a1 === undefined || b1 === null || b1 === undefined) return -Infinity;
        return a1 > 0 && b1 > 0 ? Math.min(a1, b1) : -Infinity;
      }
      return row.metrics.trades ?? -Infinity;
    };
    const lowerIsBetter = metric === "dd" || metric === "oosdd"
      || metric === "sl" || metric === "oossl";
    copy.sort((a, b) => lowerIsBetter ? value(a) - value(b) : value(b) - value(a));
    return copy;
  }, [data, metric]);

  /*
   * No tree is registered on this server — the normal state of a Trading
   * Scene install, because optimizer runs are produced by the Backtester
   * application on the research machine. That is one quiet sentence, not a
   * methodology essay above an empty selector and an empty table.
   */
  if (trees && trees.length === 0) {
    return (
      <div className="mx-auto max-w-[1400px] px-4 py-6 space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">Optimizer results</h1>
          <p className="text-xs text-ink-faint">
            Read-only leaderboards from optimizer trees registered on this server.
          </p>
        </div>
        <Card>
          <Empty>
            No optimizer tree is registered on this server. Optimizer runs are produced and
            explored in the Backtester application; register a tree here to read its results.
          </Empty>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">Optimizer results</h1>
        <p className="text-xs text-ink-faint">
          In-sample leaderboards beside the out-of-sample window each row was never fitted on.
        </p>
      </div>

      <Methodology />
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-muted">Optimizer tree</span>
          <Select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={!trees || trees.length === 0}
          >
            {!trees && <option value="">{treesError ? "Optimizer trees unavailable" : "Loading trees…"}</option>}
            {trees?.length === 0 && <option value="">No optimizer tree is registered</option>}
            {trees?.map((t) => <option value={t.id} key={t.id}>{t.label}</option>)}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-muted">Rank leaderboard by</span>
          <Select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            <option value="score">Balanced score</option>
            <option value="net">Maximum net profit</option>
            <option value="dd">Minimum drawdown</option>
            <option value="wr">Maximum win rate</option>
            <option value="pf">Maximum profit factor</option>
            <option value="trades">Most trades</option>
            <option value="held">Held out-of-sample (weaker half)</option>
            <option value="oos">Maximum out-of-sample profit</option>
            <option value="oosdd">Minimum out-of-sample drawdown</option>
            <option value="ooswr">Maximum out-of-sample win rate</option>
            <option value="oostrades">Most out-of-sample trades</option>
            <option value="sl">Lowest stopped-at-a-loss rate</option>
            <option value="oossl">Lowest out-of-sample stopped-at-a-loss rate</option>
          </Select>
        </label>
      </div>

      <Card>
        <CardHeader
          title={current?.label ?? "Optimizer results"}
          right={<span className="text-xs text-ink-faint">
            Total backtests: {data?.testsState === "pending"
              ? "counting…"
              : data ? data.totalBacktests.toLocaleString()
              : (error || treesError) ? "unknown"
              : "…"}
          </span>}
        />
        {current && STATUS_NOTE[current.status] && (
          <p className="mx-4 mb-2 rounded border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-ink">
            {STATUS_NOTE[current.status]}
          </p>
        )}
        {current?.note && <p className="px-4 pb-2 text-xs text-ink-faint">{current.note}</p>}
        {rows.some((r) => r.atTradeFloor) && (
          <p className="mx-4 mb-2 rounded border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-ink">
            Rows marked <span className="rounded bg-warn/20 px-1 text-[10px] font-medium">floor</span> won
            with the fewest trades this tree&apos;s objective allows
            {data?.minTrades ? ` (${data.minTrades})` : ""}. A maximum taken over an enormous search space
            lands on that floor by construction — the fewer trades a result rests on, the more of its
            return can be luck.
          </p>
        )}
        {data?.stale && (
          <p className="mx-4 mb-2 rounded border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-ink">
            These numbers come from an exported snapshot
            {typeof data.ageMinutes === "number"
              ? ` taken ${Math.floor(data.ageMinutes / 60)}h ago`
              : " with no recorded export time"}
            , not from the tree itself. They may not reflect the current run.
          </p>
        )}
        <p className="px-4 pb-2 text-xs text-ink-faint">
          Left of the divider is <strong>in-sample</strong> — the window the optimizer searched.
          Right is <strong>out-of-sample</strong>, which it never saw. Only trust a row where both
          halves are green: <span className="text-down">FAILED</span> means the edge did not survive
          on unseen data.
        </p>
        {treesError ? <Empty>{treesError}</Empty> :
          error ? <Empty>{error}</Empty> :
          trees?.length === 0 ? <Empty>No optimizer tree is registered on this server.</Empty> :
          !data ? <Empty>Loading optimizer results…</Empty> :
          data.resultsAvailable === false
            ? <Empty>{`${data.tree.id} is registered but has not produced any results on this machine yet.`}</Empty> :
          rows.length === 0 ? <Empty>No completed results yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm tabular">
              <thead>
                <tr className="border-b border-border text-xs text-ink-muted">
                  <th className="px-4 py-2 text-left">Rank</th>
                  <th className="px-4 py-2 text-left">Coin</th>
                  <th className="px-4 py-2 text-right">Net %</th>
                  <th className="px-4 py-2 text-right">Max DD</th>
                  <th className="px-4 py-2 text-right">Win %</th>
                  <th className="px-4 py-2 text-right">Trades</th>
                  <th className="px-4 py-2 text-right">PF</th>
                  <th className="px-4 py-2 text-right">SL loss %</th>
                  <th className="px-2 py-2 text-center text-ink-faint border-l border-border">OOS Net %</th>
                  <th className="px-4 py-2 text-right">OOS DD</th>
                  <th className="px-4 py-2 text-right">OOS Win %</th>
                  <th className="px-4 py-2 text-right">OOS Trades</th>
                  <th className="px-4 py-2 text-right">OOS SL loss %</th>
                  <th className="px-4 py-2 text-right">Held?</th>
                  <th className="px-4 py-2 text-right">Tests</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.symbol} className="border-b border-border/50">
                    <td className="px-4 py-2 text-ink-faint">{i + 1}</td>
                    <td className="px-4 py-2 font-medium">{row.symbol}</td>
                    <td className={`px-4 py-2 text-right ${(row.metrics.net_pct ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                      {row.metrics.net_pct === null || row.metrics.net_pct === undefined ? "—" : `${row.metrics.net_pct >= 0 ? "+" : ""}${n(row.metrics.net_pct)}%`}
                    </td>
                    <td className="px-4 py-2 text-right">{n(row.metrics.dd_pct)}%</td>
                    <td className="px-4 py-2 text-right">{n(row.metrics.win_rate)}%</td>
                    <td className="px-4 py-2 text-right">
                      {row.metrics.trades ?? "—"}
                      {row.atTradeFloor && (
                        <span
                          className="ml-1 rounded bg-warn/20 px-1 text-[10px] font-medium text-ink"
                          title={
                            `This winner sits on the objective's minimum-trade floor` +
                            (data?.minTrades ? ` of ${data.minTrades}` : "") +
                            `. Maximising over an enormous search space with a hard floor produces ` +
                            `winners at the floor by construction: the fewer trades a result rests ` +
                            `on, the more of its return can be luck.`
                          }
                        >
                          floor
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">{n(row.metrics.profit_factor, 2)}</td>
                    <td className="px-4 py-2 text-right">{row.metrics.sl_loss_rate === null || row.metrics.sl_loss_rate === undefined ? "—" : `${n(row.metrics.sl_loss_rate)}%`}</td>
                    <td className={`px-2 py-2 text-right border-l border-border ${(row.metrics.oos_net_pct ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                      {row.metrics.oos_net_pct === null || row.metrics.oos_net_pct === undefined ? "—"
                        : `${row.metrics.oos_net_pct >= 0 ? "+" : ""}${n(row.metrics.oos_net_pct)}%`}
                    </td>
                    <td className="px-4 py-2 text-right">{row.metrics.oos_dd_pct === null || row.metrics.oos_dd_pct === undefined ? "—" : `${n(row.metrics.oos_dd_pct)}%`}</td>
                    <td className="px-4 py-2 text-right">{row.metrics.oos_win_rate === null || row.metrics.oos_win_rate === undefined ? "—" : `${n(row.metrics.oos_win_rate)}%`}</td>
                    <td className="px-4 py-2 text-right">{row.metrics.oos_trades ?? "—"}</td>
                    <td className="px-4 py-2 text-right">{row.metrics.oos_sl_loss_rate === null || row.metrics.oos_sl_loss_rate === undefined ? "—" : `${n(row.metrics.oos_sl_loss_rate)}%`}</td>
                    <td className={`px-4 py-2 text-right ${verdict(row.metrics.net_pct, row.metrics.oos_net_pct).cls}`}>
                      {verdict(row.metrics.net_pct, row.metrics.oos_net_pct).label}
                    </td>
                    <td className="px-4 py-2 text-right text-ink-faint">{row.tests.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
