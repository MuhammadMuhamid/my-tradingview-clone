"use client";

import { CalibrationPanel } from "./CalibrationPanel";
import { StrategyPanel } from "./StrategyPanel";
import { fmtNum, fmtPrice, fmtTime } from "@/lib/scanner/format";
import type { CandlePattern, RowScore, ScreenerRow, SrLevel } from "@/lib/scanner/types";

/**
 * Expanded row: the confluence sub-score breakdown, the full candle-pattern
 * list, and every S&R level.
 *
 * §6.1 requires the breakdown to be visible. A single number with no sub-scores
 * is unauditable — the user cannot tell a genuine multi-bucket agreement from
 * one trend move counted several times, which is the failure the bucketing
 * exists to prevent in the first place.
 */
function Bar({ value }: { value: number }) {
  // -1..+1 drawn from a centre line, so the sign is visible as position and the
  // magnitude as length. The number is printed beside it regardless.
  const pct = Math.min(Math.abs(value), 1) * 50;
  return (
    <span className="relative inline-block h-2 w-24 rounded-sm bg-[var(--color-surface)] align-middle">
      <span className="absolute left-1/2 top-0 h-full w-px bg-[var(--color-line)]" />
      <span
        className="absolute top-0 h-full rounded-sm"
        style={{
          left: value >= 0 ? "50%" : `${50 - pct}%`,
          width: `${pct}%`,
          backgroundColor: value >= 0 ? "var(--color-pos)" : "var(--color-neg)",
        }}
      />
    </span>
  );
}

function ScoreBreakdown({ score }: { score: RowScore | null }) {
  if (!score || score.score === null) {
    return (
      <>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
          Confluence Score
        </h3>
        <p className="text-xs text-[var(--color-ink-dim)]">
          {score?.note ?? "Not scored — no bucket had usable inputs."}
        </p>
      </>
    );
  }

  const gate = score.gate;
  const gated = gate.multiplier !== 1;

  return (
    <>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
        {score.label}{" "}
        <span className="ml-1 font-normal normal-case text-[var(--color-ink)]">
          {score.score.toFixed(1)}
        </span>
        <span className="ml-1 font-normal normal-case text-[var(--color-ink-dim)]">
          ({score.signed !== null && score.signed > 0 ? "+" : ""}
          {score.signed?.toFixed(1)} signed)
        </span>
      </h3>

      <p className="mb-2 text-[10px] leading-tight text-[var(--color-ink-dim)]">
        {score.disclaimer}
      </p>

      <div className="overflow-x-auto">
      <table className="min-w-max w-full text-xs">
        <tbody>
          {Object.entries(score.buckets).map(([name, b]) => (
            <tr key={name} title={
              Object.entries(b.components)
                .map(([k, v]) => `${k}: ${v.toFixed(3)}`)
                .join("\n") || "no inputs"
            }>
              <td className="pr-2 capitalize">{name}</td>
              <td className="pr-2">
                {b.available ? <Bar value={b.sub_score ?? 0} /> : null}
              </td>
              <td className="pr-2 num">
                {b.available ? (b.sub_score ?? 0).toFixed(2) : "n/a"}
              </td>
              <td className="num text-[var(--color-ink-dim)]">
                ×{b.effective_weight}
                {b.effective_weight !== b.weight ? ` (of ${b.weight})` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <p className="mt-1 text-[10px] leading-tight text-[var(--color-ink-dim)]">
        ADX regime <strong>{gate.regime ?? "—"}</strong>
        {gated
          ? ` scales Trend and Trigger by ${gate.multiplier}. ADX is a gate, not a sixth vote.`
          : " — no gating applied. ADX is a gate, not a sixth vote."}
        {gate.di_conflicts_with_trend ? " DI direction disagrees with the trend bucket." : ""}
        {score.coverage < 1
          ? ` Coverage ${(score.coverage * 100).toFixed(0)}% — some buckets had no inputs and the weights were renormalised.`
          : ""}
      </p>
      <p className="mt-1 text-[10px] leading-tight text-[var(--color-ink-dim)]">
        Hover a bucket for the raw components behind its sub-score.
      </p>
    </>
  );
}

const FUTURE_ACTIONS = [
  ["Open Chart", "USD-M Futures charting is not available; no Spot chart will be opened."],
  ["Create Alert", "USD-M Futures alert evaluation is not available; no Spot alert will be created."],
  ["Trade", "Manual Trading V1 is Spot-only; this Futures result cannot create an order."],
  ["Backtest", "The checklist has no exact USD-M Futures backtest path; calibration is not a backtest."],
] as const;

export function RowDetail({ row, span, onRemove, busy }: {
  row: ScreenerRow;
  span: number;
  onRemove?: (symbol: string) => void;
  busy?: boolean;
}) {
  const patterns = (row.indicators.candles?.patterns ?? []) as CandlePattern[];
  const levels = (row.indicators.sr?.levels ?? []) as SrLevel[];

  return (
    <tr>
      <td colSpan={span} className="row-detail bg-[var(--color-surface-3)] p-0">
        {/* The table scrolls horizontally and is far wider than the viewport, so
            the panel is pinned to the left edge — otherwise the breakdown sits
            off-screen and the whole point of showing it is lost. */}
        <div className="sticky left-0 grid w-[min(1180px,100vw)] gap-6 px-4 py-3 md:grid-cols-3">
          <section className="min-w-0 md:col-span-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 text-xs font-semibold">{row.symbol} · Binance USD-M Perpetual</span>
              {FUTURE_ACTIONS.map(([label, reason]) => (
                <span key={label} title={reason}>
                  <button disabled aria-label={`${label} unavailable: ${reason}`}
                    className="rounded border border-[var(--color-line)] px-2 py-1 text-xs text-[var(--color-ink-dim)] opacity-60">
                    {label} · unavailable
                  </button>
                </span>
              ))}
              {onRemove && (
                <button disabled={busy} onClick={() => onRemove(row.symbol)}
                  className="ml-auto rounded border border-[var(--color-line)] px-2 py-1 text-xs text-[var(--color-neg)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
                  Remove symbol
                </button>
              )}
            </div>
            <p className="mt-1 text-[10px] text-[var(--color-ink-dim)]">
              Cross-product actions stay disabled until each destination supports this exact Futures market.
            </p>
          </section>
          <section className="min-w-0 md:col-span-2">
            <StrategyPanel strategy={row.strategy} />
          </section>

          <section className="min-w-0">
            <ScoreBreakdown score={row.score} />

            <CalibrationPanel symbol={row.symbol} empirical={row.empirical} />

            <h3 className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
              Data provenance
            </h3>
            <ul className="space-y-0.5 text-xs text-[var(--color-ink-dim)]">
              {Object.values(row.series).map((s) => (
                <li key={s.timeframe}>
                  <span className="inline-block w-10">{s.timeframe}</span>
                  {s.bars} bars · last close {fmtTime(s.last_close_ts)}
                  {s.stale ? " · STALE" : ""}
                </li>
              ))}
            </ul>
            {Object.keys(row.errors).length > 0 && (
              <p className="mt-2 text-xs text-[var(--color-neg)]">
                {Object.entries(row.errors)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ")}
              </p>
            )}
          </section>
          <section className="min-w-0">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
              Candle patterns ({patterns.length})
            </h3>
            {patterns.length === 0 ? (
              <p className="text-xs text-[var(--color-ink-dim)]">None in the lookback window.</p>
            ) : (
              <ul className="space-y-1 text-xs break-words">
                {patterns.map((p) => (
                  <li key={p.name} title={`strength basis: ${p.basis}`}>
                    <span
                      className="inline-block w-14 tabular-nums"
                      style={{
                        color:
                          p.direction === "bull"
                            ? "var(--color-pos)"
                            : p.direction === "bear"
                              ? "var(--color-neg)"
                              : "var(--color-ink-dim)",
                      }}
                    >
                      {p.direction}
                    </span>
                    <span className="mr-2">{p.name}</span>
                    <span className="text-[var(--color-ink-dim)]">
                      {p.bars_ago === 0 ? "this bar" : `${p.bars_ago} bars ago`} · strength{" "}
                      {p.strength.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[10px] leading-tight text-[var(--color-ink-dim)]">
              Strength is 0.0 at the detection threshold and 1.0 at the ideal form of the
              pattern. Hover a row for the exact ratio it comes from.
            </p>
          </section>

          <section className="min-w-0">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
              S&amp;R levels ({levels.length})
            </h3>
            {levels.length === 0 ? (
              <p className="text-xs text-[var(--color-ink-dim)]">No surviving levels.</p>
            ) : (
              <div className="overflow-x-auto">
              <table className="min-w-max text-xs">
                <tbody>
                  {levels.map((l) => (
                    <tr key={`${l.price}-${l.formed_at}`}>
                      <td className="pr-3 num">{fmtPrice(l.price)}</td>
                      <td
                        className="pr-3"
                        style={{
                          color:
                            l.side === "support" ? "var(--color-pos)" : "var(--color-neg)",
                        }}
                      >
                        {l.side}
                      </td>
                      <td className="pr-3 num text-[var(--color-ink-dim)]">
                        ×{l.strength}
                      </td>
                      <td className="num text-[var(--color-ink-dim)]">
                        {fmtNum(l.dist_atr, 2)} ATR
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </section>

        </div>
      </td>
    </tr>
  );
}
