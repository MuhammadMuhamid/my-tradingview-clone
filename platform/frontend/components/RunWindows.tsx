import Link from "next/link";
import { Card, CardHeader, Notice } from "@/components/ui";
import type { BacktestMetrics, BacktestSegments, ExecutionTruth, SegmentWindow } from "@/lib/types";
import { fmtNum, fmtPct, signClass, UTC_DATE_NOTE } from "@/lib/format";
import {
  LOW_SAMPLE_WINDOW, profitFactorText, tradeFigures, unitOf, validationLabel, winRateText,
} from "@/lib/backtestFigures";

/** A window's dates, in the product's own UTC grammar. */
function windowLabel(w: SegmentWindow): string {
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return `${day(w.startMs)} → ${day(w.endMs)}`;
}

function days(w: SegmentWindow): number {
  return Math.max(0, Math.round((w.endMs - w.startMs) / 86_400_000));
}

function SegmentRow({ name, note, window, m, tone }: {
  name: string; note: string; window: SegmentWindow; m: BacktestMetrics;
  /** The validation row is set apart, so the eye lands on the split. */
  tone: "development" | "validation";
}) {
  const f = tradeFigures(m);
  const low = f.count > 0 && f.count < LOW_SAMPLE_WINDOW;
  return (
    <tr className={`border-b border-border/50 ${tone === "validation" ? "bg-state-hover" : ""}`}
      data-window={tone}>
      <td className={`border-l-2 px-4 py-2 ${tone === "validation" ? "border-l-ink-faint" : "border-l-transparent"}`}>
        <div className="font-medium text-ink">{name}</div>
        <div className="text-xs text-ink-faint">{note}</div>
      </td>
      <td className="px-4 py-2 text-ink-muted" title={UTC_DATE_NOTE}>
        {windowLabel(window)}
        <span className="ml-1 text-ink-faint">({days(window)}d)</span>
      </td>
      <td className={`px-4 py-2 text-right ${signClass(m.netProfitPct)}`}>{fmtPct(m.netProfitPct)}</td>
      <td className="px-4 py-2 text-right">-{fmtNum(m.maxDrawdownPct)}%</td>
      <td className="px-4 py-2 text-right"
        title={f.basis === "entries" ? `${f.count} ${unitOf(f.basis, f.count)} closed as ${f.legs} exit legs` : "exit legs"}>
        {f.count}
        {/*
          A rate over twenty entries is twelve wins and eight losses; one more
          loss moves it five points. The validation window — a fifth of the
          run by default — is where this is common, and it is the window a
          reader most wants to believe.
        */}
        {low && <div className="text-xs text-warn">low sample</div>}
      </td>
      <td className="px-4 py-2 text-right">{winRateText(f)}</td>
      <td className="px-4 py-2 text-right">
        {/*
          `profitFactor` is null both for "no losses" and for "no trades", and
          the second is common here. A window that took nothing showed the same
          ∞ as a window that lost nothing — `profitFactorText` holds that rule
          for every surface now.
        */}
        {profitFactorText(f)}
      </td>
    </tr>
  );
}

/**
 * The run's range as one bar, divided where the windows divide it.
 *
 * Three rows of dates do not show proportion, and proportion is the point: a
 * validation window that is a fifth of the range reads very differently from
 * one that is a twentieth. Neutral fills only — this is a statement about
 * dates, not a direction or an action — with the validation part set apart by
 * its own weight and its label.
 */
function SplitBar({ split, fraction }: {
  split: { inSample: SegmentWindow; outOfSample: SegmentWindow; holdout: SegmentWindow };
  fraction: number;
}) {
  const total = Math.max(1, split.holdout.endMs - split.inSample.startMs);
  const pct = (w: SegmentWindow): string => `${((w.endMs - w.startMs) / total) * 100}%`;
  return (
    <div className="px-4 pt-3" aria-hidden="true">
      <div className="flex h-2 overflow-hidden rounded-md border border-border">
        <div className="bg-state-hover" style={{ width: pct(split.inSample) }} />
        <div className="border-l border-border bg-state-active" style={{ width: pct(split.outOfSample) }} />
        <div className="border-l border-ink-faint bg-ink-faint/50" style={{ width: pct(split.holdout) }} />
      </div>
      <div className="mt-1 flex text-[11px] text-ink-faint">
        <span style={{ width: `${(1 - fraction) * 100}%` }}>Development</span>
        <span className="font-medium text-ink-muted">Validation</span>
      </div>
    </div>
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
 * ── What the last window is, and is not ────────────────────────────────────
 *
 * It was labelled "Holdout (frozen) — report it, never select on it". It is
 * neither frozen nor withheld: the engine takes the last fraction of WHATEVER
 * range was chosen, on every run, and the headline and the equity curve
 * include it. Re-running over a later range moves it; tuning a parameter and
 * re-running consumes it. So it is named for what it is — the validation
 * window, the last N% of this run — and the reader is told that it is only a
 * check on the development window if they did not tune against it. Nothing in
 * this product enforces that, and the copy no longer implies that something
 * does.
 */
export function RunWindows({ segments, execution, initialCapital, stressRunId = null }: {
  segments: BacktestSegments | null;
  execution: ExecutionTruth | null;
  initialCapital: number;
  /** Set when this run answers one window of a stress analysis. */
  stressRunId?: string | null;
}) {
  /*
   * ── A stress window has no validation split, and must not be shown one ───
   *
   * `engine/stress.ts` opens by forbidding exactly this: "The product must
   * never present a stress score beside a holdout score as though the two were
   * the same kind of number." A stress window is selected BECAUSE of what
   * happened in it; a validation window is simply the last part of a range
   * chosen for some other reason.
   *
   * A stress window nevertheless executes as an ordinary backtest — that is
   * deliberate, so its numbers are comparable — so this panel would happily
   * carve its last fifth off and label it a validation window over four days
   * of a hand-picked crash. The split is suppressed and the run says what it
   * is instead.
   */
  if (stressRunId !== null) {
    return (
      <Card>
        <CardHeader title="Windows and execution" />
        <div className="px-4 py-4 text-sm text-ink-muted">
          <span className="font-medium text-ink">This run is one window of a stress analysis.</span>{" "}
          Its dates were chosen by searching history for the benchmark&rsquo;s worst stretches, so
          they are selected with hindsight — there is no development, out-of-sample or validation
          split to make of them, and showing one would invite exactly the reading the analysis
          cannot support.{" "}
          <Link href="/stress" className="rounded text-ink underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            Open the stress run
          </Link>{" "}
          to see it beside the other windows and the benchmark it was chosen from.
        </div>
        {execution && (
          <div className="grid gap-x-6 gap-y-2 border-t border-border px-4 py-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="text-xs text-ink-muted">Window covered</div>
              <div className="text-ink tabular" title={UTC_DATE_NOTE}>
                {execution.covered ? windowLabel(execution.covered) : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-ink-muted">Bars simulated</div>
              <div className="text-ink tabular">{execution.barsProcessed.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-xs text-ink-muted">Position size</div>
              <div className="text-ink tabular">
                {execution.sizing.mode === "fixed_cash"
                  ? `${fmtNum(execution.sizing.value, 0)} cash per entry`
                  : `${fmtNum(execution.sizing.value, 0)}% of equity (compounds)`}
              </div>
            </div>
            <div>
              <div className="text-xs text-ink-muted">Entry fills</div>
              <div className="text-ink">
                {execution.fillTiming === "next_bar_open"
                  ? "at the next bar's open" : "at the signal bar's close"}
              </div>
            </div>
          </div>
        )}
        {execution?.noEntryReason && (
          <div className="px-4 pb-4">
            <Notice tone="warn">
              <span className="font-medium">This run could not have taken a trade.</span>{" "}
              {execution.noEntryReason}
            </Notice>
          </div>
        )}
      </Card>
    );
  }

  if (!segments && !execution) {
    return (
      <Card>
        <CardHeader title="Windows and execution" />
        <div className="px-4 py-6 text-sm text-ink-faint">
          This run predates the window split, so it has none recorded. That is not a
          statement that it had no validation window — the run simply did not store one.
          Re-run it to see the division.
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

  /*
   * One unit for the whole table. Every row of a run recorded since the
   * engine counted windows per entry is in entries; a column header that said
   * "Trades" above an entry count was half of the original defect.
   */
  const rows = segments?.available ? [segments.inSample, segments.outOfSample, segments.holdout] : [];
  const allEntries = rows.every((m) => tradeFigures(m).basis === "entries");
  const countHeader = allEntries ? "Entries" : "Trades";
  const countUnit = allEntries ? "entries" : "exit legs";

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
          <SplitBar split={segments.split} fraction={segments.holdoutFraction} />
          <table className="w-full min-w-[760px] text-sm tabular">
            <thead>
              <tr className="border-b border-border text-left text-xs text-ink-muted">
                <th className="px-4 py-2 font-medium">Window</th>
                <th className="px-4 py-2 font-medium" title={UTC_DATE_NOTE}>Dates (UTC)</th>
                <th className="px-4 py-2 font-medium text-right">Net %</th>
                <th className="px-4 py-2 font-medium text-right">Max DD</th>
                <th className="px-4 py-2 font-medium text-right">{countHeader}</th>
                <th className="px-4 py-2 font-medium text-right">Win %</th>
                <th className="px-4 py-2 font-medium text-right">PF</th>
              </tr>
            </thead>
            <tbody>
              <SegmentRow name="Development · in sample" note="the first half of the development window"
                tone="development" window={segments.split.inSample} m={segments.inSample} />
              <SegmentRow name="Development · out of sample" note="the second half of the development window"
                tone="development" window={segments.split.outOfSample} m={segments.outOfSample} />
              <SegmentRow name="Validation"
                note={validationLabel(segments.holdoutFraction)}
                tone="validation" window={segments.split.holdout} m={segments.holdout} />
            </tbody>
          </table>
          <p className="px-4 py-3 text-xs text-ink-faint">
            The three windows come from one simulation over the range you chose, divided by date.
            A trade belongs to the window that closed it, so an entry whose exits straddle a
            boundary is counted in each window it closed in. The validation window is the{" "}
            {validationLabel(segments.holdoutFraction)}, and it is not withheld: the headline
            figures and the equity curve include it, and a different range moves it. It is a check
            on the development windows only if you did not tune the strategy against it. Every
            count and rate in a row is over the same {countUnit}.
          </p>
        </div>
      ) : null}
    </Card>
  );
}
