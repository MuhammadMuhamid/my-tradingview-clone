import type { BacktestMetrics } from "@/lib/types";
import { fmtNum, fmtPct, signClass } from "@/lib/format";

function Tile({ label, value, valueClass = "text-ink", sub }: {
  label: string; value: string; valueClass?: string; sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular ${valueClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-faint tabular">{sub}</div>}
    </div>
  );
}

/**
 * TradingView-style headline metrics. Win rate and R:R are shown together —
 * win rate alone is meaningless (a low win rate with high R:R can still win).
 */
export function Metrics({ m, initialCapital }: { m: BacktestMetrics; initialCapital: number }) {
  const pf = m.profitFactor;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Tile
        label="Net profit"
        value={fmtPct(m.netProfitPct)}
        valueClass={signClass(m.netProfitPct)}
        sub={`${fmtNum(m.netProfit)} / ${fmtNum(initialCapital, 0)}`}
      />
      <Tile
        label="Profit factor"
        value={pf === null ? "∞" : fmtNum(pf)}
        valueClass={pf === null || pf >= 1 ? "text-up" : "text-down"}
        sub={pf !== null && pf < 1.3 ? "below 1.3 bar" : pf !== null && pf >= 1.5 ? "good" : ""}
      />
      <Tile
        label="Max drawdown"
        value={`-${fmtNum(m.maxDrawdownPct)}%`}
        valueClass={m.maxDrawdownPct < 20 ? "text-ink" : "text-down"}
      />
      <Tile
        label="Win rate"
        value={`${fmtNum(m.winRatePct, 1)}%`}
        sub={`${m.winningTrades}W / ${m.losingTrades}L`}
      />
      <Tile
        label="Total trades"
        value={String(m.totalTrades)}
        valueClass={m.totalTrades >= 100 ? "text-ink" : "text-ink-muted"}
        sub={m.totalTrades < 100 ? "< 100 = low sample" : `avg ${fmtNum(m.avgBarsInTrade, 0)} bars`}
      />
      <Tile
        label="Avg trade"
        value={fmtPct(m.avgTradePct)}
        valueClass={signClass(m.avgTradePct)}
        sub={`comm ${fmtNum(m.commissionPaid)}`}
      />
    </div>
  );
}
