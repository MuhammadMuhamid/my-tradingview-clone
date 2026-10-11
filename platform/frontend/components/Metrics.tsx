import type { BacktestMetrics } from "@/lib/types";
import { fmtNum, fmtPct, signClass } from "@/lib/format";
import {
  LOW_SAMPLE_RUN, avgIsLegMean, profitFactorText, profitFactorTone, tradeFigures, unitOf, winRateText,
} from "@/lib/backtestFigures";

function Tile({ label, value, valueClass = "text-ink", sub, title }: {
  label: string; value: string; valueClass?: string; sub?: string; title?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3" title={title}>
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular ${valueClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-faint tabular">{sub}</div>}
    </div>
  );
}

/**
 * TradingView-style headline metrics. Win rate and R:R are shown together —
 * win rate alone is meaningless (a low win rate with high R:R can still win).
 *
 * ── One population, named ──────────────────────────────────────────────────
 *
 * The trade count, win rate, profit factor and average trade are all over the
 * same population — ENTRIES wherever the run recorded them — and the unit is
 * printed on the count. These tiles printed a LEG count and leg win rate above
 * a windows table whose rates were over entries, so the headline and the rows
 * beneath it could not be added up or compared. See `lib/backtestFigures.ts`.
 *
 * ── What the headline covers ───────────────────────────────────────────────
 *
 * The WHOLE requested window, validation included. The validation window is
 * the last part of this same simulation, not a withheld one; saying so here is
 * what stops a reader taking the headline for a development-only figure.
 */
export function Metrics({ m, initialCapital }: { m: BacktestMetrics; initialCapital: number }) {
  const f = tradeFigures(m);
  const unit = unitOf(f.basis);
  const tone = profitFactorTone(f);
  const pf = f.profitFactor;
  return (
    <section aria-label="Headline metrics" className="space-y-1.5">
      <p className="text-xs text-ink-faint">
        Whole window, including the validation window. Trade figures are per {unit === "entries" ? "entry" : "exit leg"}.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile
          label="Net profit"
          value={fmtPct(m.netProfitPct)}
          valueClass={signClass(m.netProfitPct)}
          sub={`${fmtNum(m.netProfit)} / ${fmtNum(initialCapital, 0)}`}
        />
        <Tile
          label="Profit factor"
          value={profitFactorText(f)}
          valueClass={tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-ink-muted"}
          sub={f.count === 0 ? "no trades"
            : pf !== null && pf < 1.3 ? "below 1.3 bar" : pf !== null && pf >= 1.5 ? "good" : ""}
        />
        <Tile
          label="Max drawdown"
          value={`-${fmtNum(m.maxDrawdownPct)}%`}
          valueClass={m.maxDrawdownPct < 20 ? "text-ink" : "text-down"}
        />
        <Tile
          label="Win rate"
          value={winRateText(f)}
          sub={`${f.wins}W / ${f.losses}L ${unit}`}
        />
        <Tile
          label={f.basis === "entries" ? "Trades (entries)" : "Trades (exit legs)"}
          value={String(f.count)}
          valueClass={f.count >= LOW_SAMPLE_RUN ? "text-ink" : "text-ink-muted"}
          sub={f.count < LOW_SAMPLE_RUN ? `< ${LOW_SAMPLE_RUN} = low sample` : `avg ${fmtNum(m.avgBarsPerEntry ?? m.avgBarsInTrade, 0)} bars`}
          title={f.basis === "entries"
            ? `${f.count} entries closed as ${f.legs} exit legs — a partial take-profit closes one entry as several. The trade list has one row per leg.`
            : "This run was recorded before entries were counted separately, so its trades are exit legs."}
        />
        <Tile
          label={f.basis === "entries" && !avgIsLegMean(m) ? "Avg entry" : "Avg trade"}
          value={fmtPct(f.avgPct)}
          valueClass={signClass(f.avgPct)}
          sub={`comm ${fmtNum(m.commissionPaid)}`}
          {...(avgIsLegMean(m) ? { title: "Per exit leg: this run did not record a per-entry mean." } : {})}
        />
      </div>
    </section>
  );
}
