"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type OptimizerLeaderboard, type OptimizerSystem } from "@/lib/api";
import { Card, CardHeader, Empty, Select } from "@/components/ui";

type Metric = "score" | "net" | "dd" | "wr" | "pf" | "trades"
  | "oos" | "oosdd" | "ooswr" | "oostrades" | "held" | "sl" | "oossl";

/**
 * Did the in-sample edge survive on data the optimiser never saw?
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
 * The three optimizer systems that exist. The former "current" (Nov 1, 2025)
 * MA trees and the SRTrend 15m/5m trees were removed on 2026-07-30.
 */
const SYSTEMS: Array<{
  system: OptimizerSystem; timeframe: "15m" | "1h" | "5m"; strategy: string; label: string;
}> = [
  { system: "one-year", timeframe: "5m", strategy: "mtf_lean", label: "MTF Confluence Lean · 5m · Aug 10, 2025 → now" },
  { system: "one-year", timeframe: "15m", strategy: "mtf_lean", label: "MTF Confluence Lean · 15m · Aug 11, 2025 → now" },
  { system: "one-year", timeframe: "1h", strategy: "ma_rr_v9", label: "MA + R:R · 1h · Jul 20, 2025 → now" },
  { system: "one-year", timeframe: "15m", strategy: "ma_rr_v9", label: "MA + R:R · 15m · Jul 20, 2025 → now" },
  { system: "one-year", timeframe: "1h", strategy: "srtrend_v10", label: "SR+Trend v10 · 1h · Jul 20, 2025 → now" },
];

const n = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? "—" : v.toFixed(digits);

export default function OptimizersPage() {
  const [selected, setSelected] = useState(0);
  const [metric, setMetric] = useState<Metric>("score");
  const [data, setData] = useState<OptimizerLeaderboard | null>(null);
  const [error, setError] = useState("");
  const current = SYSTEMS[selected]!;

  const refresh = () => {
    setError("");
    api.optimizerLeaderboard(current.system, current.timeframe, current.strategy)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    setData(null);
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
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

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">Optimizer results</h1>
        <p className="text-xs text-ink-faint">
          In-sample leaderboards beside the out-of-sample window each row was never fitted on.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-muted">Optimizer system</span>
          <Select value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
            {SYSTEMS.map((s, i) => <option value={i} key={s.label}>{s.label}</option>)}
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
          title={current.label}
          right={<span className="text-xs text-ink-faint">
            Total backtests: {(data?.totalBacktests ?? 0).toLocaleString()}
          </span>}
        />
        <p className="px-4 pb-2 text-xs text-ink-faint">
          Left of the divider is <strong>in-sample</strong> — the window the optimiser searched.
          Right is <strong>out-of-sample</strong>, which it never saw. Only trust a row where both
          halves are green: <span className="text-down">FAILED</span> means the edge did not survive
          on unseen data.
        </p>
        {error ? <Empty>{error}</Empty> : !data ? <Empty>Loading optimizer results…</Empty> :
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
                    <td className="px-4 py-2 text-right">{row.metrics.trades ?? "—"}</td>
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
