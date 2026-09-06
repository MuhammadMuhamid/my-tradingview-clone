"use client";
/**
 * Which of the things I am watching are the same trade.
 *
 * ── Why a panel and not a study ────────────────────────────────────────────
 *
 * A rolling correlation against one benchmark is a series through time, and it
 * belongs on the chart beside the bars it rolls over — that is the compare
 * pane. This is a different question with a different shape: one number per
 * pair over one window, which is a table, and its subject is the watchlist
 * rather than the chart. So it sits beside the watchlist.
 *
 * ── What the table refuses to hide ─────────────────────────────────────────
 *
 * Each cell is computed over the bars BOTH of its instruments have, so two
 * cells may rest on different numbers of observations. That is a true fact
 * about the data — a newer listing genuinely has less history — and the
 * alternative is either inventing observations or letting the thinnest member
 * shorten every other pair's window. So the counts are shown, and a pair with
 * too few is blank rather than confident.
 */
import { useMemo, useState } from "react";
import {
  MIN_OBSERVATIONS, betaFromMatrix, correlationMatrix, strongestPairs,
} from "@/lib/correlationMatrix";
import { MAX_CORRELATION_SYMBOLS, useCorrelationSet } from "@/lib/useCorrelationSet";
import type { Resolution } from "@/lib/resolution";

/** Windows offered. Bars, so their meaning follows the chart's resolution. */
const WINDOWS = [30, 60, 120, 250, 500];

export function CorrelationPanel({
  symbols, interval, bars, selected, onSelect,
}: {
  /** The instruments to cover — the watchlist, in its own order. */
  symbols: readonly string[];
  interval: Resolution;
  /** History depth to request per instrument. */
  bars: number;
  /** The focused pane's instrument, highlighted and used as the benchmark. */
  selected: string;
  /** Clicking a row's name opens it on the chart. */
  onSelect: (symbol: string) => void;
}) {
  const [window, setWindow] = useState(120);
  const set = useCorrelationSet(symbols, interval, bars);
  const matrix = useMemo(
    () => correlationMatrix(set.series, window), [set.series, window]);
  const ranked = useMemo(() => strongestPairs(matrix, 3), [matrix]);
  const [pair, setPair] = useState<{ a: number; b: number } | null>(null);

  const detail = pair ? matrix.cells[pair.a]?.[pair.b] ?? null : null;
  const aSymbol = pair ? matrix.symbols[pair.a] ?? "" : "";
  const bSymbol = pair ? matrix.symbols[pair.b] ?? "" : "";

  return (
    <aside className="flex h-full w-[85vw] max-w-[340px] shrink-0 flex-col border-l border-border bg-surface md:w-[340px]">
      <header className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-xs font-semibold text-ink">Correlation</h2>
          <p className="truncate text-[10px] text-ink-faint">
            Log returns on {interval} bars
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-1 text-[10px] text-ink-muted">
          Window
          <select
            aria-label="Correlation window, in bars"
            className="rounded border border-border bg-surface-2 px-1 py-0.5 text-[11px] text-ink"
            value={String(window)}
            onChange={(e) => { setWindow(Number(e.target.value)); setPair(null); }}
          >
            {WINDOWS.map((n) => <option key={n} value={n}>{n} bars</option>)}
          </select>
        </label>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-2.5 py-2">
        {set.loading && matrix.symbols.length === 0 && (
          <p className="text-xs text-ink-faint">Loading these instruments&apos; bars…</p>
        )}
        {!set.loading && matrix.symbols.length < 2 && (
          <p className="text-xs text-ink-faint">
            Add at least two instruments to the watchlist to compare them.
          </p>
        )}

        {matrix.symbols.length >= 2 && (
          /*
           * The matrix is as wide as the watchlist is long, so it scrolls
           * inside its own container rather than making the panel — and on a
           * phone the page — scroll sideways. The row headings stay put.
           */
          <div className="overflow-x-auto">
          <table className="w-full min-w-[260px] border-collapse text-[10px]">
            <caption className="sr-only">
              Correlation of log returns over the last {window} bars
            </caption>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 bg-surface pb-1 text-left font-normal text-ink-faint">
                  &nbsp;
                </th>
                {matrix.symbols.map((symbol) => (
                  <th
                    key={symbol}
                    scope="col"
                    className="pb-1 text-center font-normal text-ink-faint"
                    title={symbol}
                  >
                    {shortName(symbol)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.symbols.map((rowSymbol, i) => (
                <tr key={rowSymbol}>
                  <th scope="row" className="sticky left-0 z-10 bg-surface pr-1 text-left font-normal">
                    <button
                      onClick={() => onSelect(rowSymbol)}
                      className={`truncate ${
                        rowSymbol === selected ? "text-accent" : "text-ink-muted hover:text-ink"
                      }`}
                      title={`Open ${rowSymbol} on the chart`}
                    >
                      {shortName(rowSymbol)}
                    </button>
                  </th>
                  {matrix.symbols.map((columnSymbol, j) => {
                    const cell = matrix.cells[i]![j]!;
                    return (
                      <td key={columnSymbol} className="p-[1px]">
                        <button
                          onClick={() => setPair(i === j ? null : { a: i, b: j })}
                          className="flex h-6 w-full items-center justify-center rounded-sm text-[10px] tabular-nums"
                          style={{ background: cellColor(cell.correlation), color: "#e6e9ef" }}
                          aria-label={`${rowSymbol} against ${columnSymbol}: ${
                            cell.correlation === null
                              ? `not enough overlapping bars (${cell.observations})`
                              : cell.correlation.toFixed(2)
                          }`}
                          title={cell.correlation === null
                            ? `${cell.observations} overlapping bars — fewer than the ${MIN_OBSERVATIONS} needed to say anything`
                            : `${rowSymbol} / ${columnSymbol}: ${cell.correlation.toFixed(3)} over ${cell.observations} bars`}
                        >
                          {cell.correlation === null ? "—" : cell.correlation.toFixed(2)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {detail && pair && pair.a !== pair.b && (
          <section className="mt-3 rounded border border-border bg-surface-2 p-2">
            <h3 className="text-[11px] font-semibold text-ink">
              {aSymbol} against {bSymbol}
            </h3>
            <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-[10px]">
              <Stat label="Correlation" value={format(detail.correlation, 3)} />
              {/*
                Covariance is shown as a statistic rather than plotted. Its
                units are return-squared, which is not a scale anyone reads off
                a chart — but it IS the number beta and the correlation are
                both built from, so seeing it is how the other two stop being
                magic.
              */}
              <Stat label="Covariance" value={format(detail.covariance, 8)} />
              <Stat
                label={`Beta vs ${bSymbol}`}
                value={format(betaFromMatrix(matrix, aSymbol, bSymbol), 3)}
              />
              <Stat
                label={`Beta vs ${aSymbol}`}
                value={format(betaFromMatrix(matrix, bSymbol, aSymbol), 3)}
              />
              <Stat label="σ per bar" value={
                `${format(matrix.volatility[pair.a] ?? null, 5)} / ${
                  format(matrix.volatility[pair.b] ?? null, 5)}`} />
              <Stat label="Bars used" value={String(detail.observations)} />
            </dl>
          </section>
        )}

        {ranked.length > 0 && (
          <section className="mt-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              Most related
            </h3>
            <ul className="mt-1 space-y-0.5 text-[10px] text-ink-muted">
              {ranked.map((entry) => (
                <li key={`${entry.a}/${entry.b}`} className="flex justify-between gap-2">
                  <span className="truncate">{shortName(entry.a)} · {shortName(entry.b)}</span>
                  <span className="tabular-nums text-ink">{entry.correlation.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-3 space-y-1 text-[10px] text-ink-faint">
          {matrix.symbols.length >= 2 && (
            <p>
              Each pair uses the bars both instruments have — between{" "}
              {matrix.observationRange.min} and {matrix.observationRange.max} of the
              last {window}. Missing bars are left out, never filled in, so one
              short history does not change any other pair&apos;s number.
            </p>
          )}
          {set.truncated > 0 && (
            <p className="text-warn">
              Showing the first {MAX_CORRELATION_SYMBOLS} instruments; {set.truncated}{" "}
              more are not in this table.
            </p>
          )}
          {set.errors.map((error) => (
            <p key={error.symbol} className="text-warn">
              {error.symbol} could not be loaded: {error.message}
            </p>
          ))}
        </footer>
      </div>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </>
  );
}

function format(value: number | null, digits: number): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

/** `BTCUSDT` reads as `BTC` in a grid this narrow; the full name is the title. */
function shortName(symbol: string): string {
  return symbol.replace(/(USDT|USDC|BUSD|FDUSD)$/, "") || symbol;
}

/**
 * A cell's colour, from its correlation.
 *
 * Diverging around zero rather than a single ramp, because the interesting
 * axis is "related or not" in BOTH directions: a pair at −0.9 is as much a
 * finding as one at +0.9, and a single ramp would paint it as the background.
 * A cell with no number is grey, so an absent value cannot be mistaken for a
 * weak relationship.
 */
function cellColor(correlation: number | null): string {
  if (correlation === null) return "rgba(139,147,167,0.14)";
  const strength = Math.min(1, Math.abs(correlation));
  const alpha = 0.12 + strength * 0.62;
  return correlation >= 0
    ? `rgba(46,189,133,${alpha.toFixed(3)})`
    : `rgba(246,70,93,${alpha.toFixed(3)})`;
}
