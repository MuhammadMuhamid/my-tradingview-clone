import { Card, CardHeader, Notice } from "@/components/ui";
import type { BacktestMetrics, BacktestSegments, ExecutionTruth, SegmentWindow } from "@/lib/types";
import { fmtNum, fmtPct, signClass, UTC_DATE_NOTE } from "@/lib/format";

/** A window's dates, in the product's own UTC grammar. */
function windowLabel(w: SegmentWindow): string {
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return `${day(w.startMs)} → ${day(w.endMs)}`;
}

function days(w: SegmentWindow): number {
  return Math.max(0, Math.round((w.endMs - w.startMs) / 86_400_000));
}

function SegmentRow({ name, note, window, m }: {
  name: string; note: string; window: SegmentWindow; m: BacktestMetrics;
}) {
  return (
    <tr className="border-b border-border/50">
      <td className="px-4 py-2">
        <div className="font-medium text-ink">{name}</div>
        <div className="text-xs text-ink-faint">{note}</div>
      </td>
      <td className="px-4 py-2 text-ink-muted" title={UTC_DATE_NOTE}>
        {windowLabel(window)}
        <span className="ml-1 text-ink-faint">({days(window)}d)</span>
      </td>
      <td className={`px-4 py-2 text-right ${signClass(m.netProfitPct)}`}>{fmtPct(m.netProfitPct)}</td>
      <td className="px-4 py-2 text-right">-{fmtNum(m.maxDrawdownPct)}%</td>
      <td className="px-4 py-2 text-right">{m.totalTrades}</td>
      <td className="px-4 py-2 text-right">
        {m.totalTrades === 0 ? "—" : `${fmtNum(m.winRatePct, 1)}%`}
      </td>
      <td className="px-4 py-2 text-right">
        {/*
          `profitFactor` is null both for "no losses" and for "no trades", and
          the second is common here — the holdout is a fifth of every run. A
          window that took nothing showed the same ∞ as a window that lost
          nothing, which is the strongest possible claim about the weakest
          possible evidence.
        */}
        {m.totalTrades === 0 ? "—" : m.profitFactor === null ? "∞" : fmtNum(m.profitFactor)}
      </td>
    </tr>
  );
}

/**
 * Where a run's development data ends, and what it actually ran on.
 *
 * ── Why this panel exists ─────────────────────────────────────────────────
 *
 * A backtest used to be one contiguous number. The engine has had a
 * three-window splitter and a segment scorer for some time, both tested and
 * neither reachable from any screen, so a reader could not tell which part of
 * a result the strategy had been developed against and which part it had never
 * seen. That is the difference between a measurement and a hope, and it was
 * invisible.
 *
 * The holdout is FROZEN: it is reported once and never selected on. The
 * distinction is worth the words because the out-of-sample window in this
 * product's own optimizer history was consumed by selection — gated and
 * maximised over — which is how an apparently validated configuration can be a
 * selection artefact.
 */
export function RunWindows({ segments, execution, initialCapital }: {
  segments: BacktestSegments | null;
  execution: ExecutionTruth | null;
  initialCapital: number;
}) {
  if (!segments && !execution) {
    return (
      <Card>
        <CardHeader title="Windows and execution" />
        <div className="px-4 py-6 text-sm text-ink-faint">
          This run predates the window split, so it has none recorded. That is not a
          statement that it had no holdout — the run simply did not store one. Re-run it
          to see the division.
        </div>
      </Card>
    );
  }

  /*
   * Both ends, not just the start. A run whose data STOPS months before the
   * requested end is just as narrow, and the segments and the holdout are
   * computed over the truncated window either way — so it needs the same
   * notice. Guarding only the start was arbitrary.
   */
  const DAY_MS = 86_400_000;
  const short = execution !== null
    && execution.covered !== null
    && (execution.covered.startMs > execution.requested.startMs + DAY_MS
      || execution.covered.endMs < execution.requested.endMs - DAY_MS);

  return (
    <Card>
      <CardHeader
        title="Windows and execution"
        right={<span className="text-xs text-ink-faint">
          {execution ? `${execution.barsProcessed.toLocaleString()} bars simulated` : ""}
        </span>}
      />

      {execution && (
        <div className="grid gap-x-6 gap-y-2 border-b border-border px-4 py-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-xs text-ink-muted">Window covered</div>
            <div className="text-ink tabular" title={UTC_DATE_NOTE}>
              {execution.covered ? windowLabel(execution.covered) : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-ink-muted">Window requested</div>
            <div className="text-ink-muted tabular" title={UTC_DATE_NOTE}>
              {windowLabel(execution.requested)}
            </div>
          </div>
          <div>
            {/*
              Two shipped surfaces defaulted to different sizing and two shipped
              strategies default to different fill timing, and neither difference
              was disclosed anywhere. Two results are not comparable across
              either, so both are stated on the result rather than left in the
              parameters for a reader to reconstruct.
            */}
            <div className="text-xs text-ink-muted">Position size</div>
            <div className="text-ink tabular">
              {execution.sizing.mode === "fixed_cash"
                ? `${fmtNum(execution.sizing.value, 0)} cash per entry`
                : `${fmtNum(execution.sizing.value, 0)}% of equity (compounds)`}
              <span className="ml-1 text-xs text-ink-faint">
                of {fmtNum(initialCapital, 0)}
              </span>
            </div>
          </div>
          <div>
            <div className="text-xs text-ink-muted">Entry fills</div>
            <div className="text-ink">
              {execution.fillTiming === "next_bar_open"
                ? "at the next bar's open"
                : "at the signal bar's close"}
              {execution.fillTiming === "signal_bar_close" && (
                <span className="ml-1 text-xs text-warn" title="TradingView's process_orders_on_close: the fill price is the price that produced the signal.">
                  zero latency
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {execution?.noEntryReason && (
        <div className="px-4 pt-3">
          {/*
            A structural zero, said out loud. Without this the page reports the
            same "0 trades" for a configuration that CANNOT trade and for one
            that simply found nothing to do, and the reader has no way to tell
            which — on the one screen whose whole job is to say what happened.
          */}
          <Notice tone="warn">
            <span className="font-medium">This run could not have taken a trade.</span>{" "}
            {execution.noEntryReason}
          </Notice>
        </div>
      )}
      {short && (
        <div className="px-4 pt-3">
          <Notice tone="warn">
            This run simulated a narrower window than was requested — the instrument's
            history begins later, or the stored candles do. Every figure on this page
            describes the covered window, not the requested one.
          </Notice>
        </div>
      )}

      {segments?.available === false ? (
        <div className="px-4 py-4 text-sm text-ink-muted">{segments.reason}</div>
      ) : segments?.available ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm tabular">
            <thead>
              <tr className="border-b border-border text-left text-xs text-ink-muted">
                <th className="px-4 py-2 font-medium">Window</th>
                <th className="px-4 py-2 font-medium" title={UTC_DATE_NOTE}>Dates (UTC)</th>
                <th className="px-4 py-2 font-medium text-right">Net %</th>
                <th className="px-4 py-2 font-medium text-right">Max DD</th>
                <th className="px-4 py-2 font-medium text-right">Trades</th>
                <th className="px-4 py-2 font-medium text-right">Win %</th>
                <th className="px-4 py-2 font-medium text-right">PF</th>
              </tr>
            </thead>
            <tbody>
              <SegmentRow name="Development" note="the strategy was built against this"
                window={segments.split.inSample} m={segments.inSample} />
              <SegmentRow name="Out of sample" note="not developed on — but often selected on"
                window={segments.split.outOfSample} m={segments.outOfSample} />
              <SegmentRow name="Holdout (frozen)"
                note={`the last ${Math.round(segments.holdoutFraction * 100)}% — report it, never select on it`}
                window={segments.split.holdout} m={segments.holdout} />
            </tbody>
          </table>
          <p className="px-4 py-3 text-xs text-ink-faint">
            The three windows come from one simulation, divided by date; a trade belongs to
            the window that closed it. The holdout is the only one of the three that nothing
            may be chosen on — an out-of-sample window that has been gated or ranked against
            has become a second selection criterion, and its agreement with the development
            window is then an artefact rather than evidence.
          </p>
        </div>
      ) : null}
    </Card>
  );
}
