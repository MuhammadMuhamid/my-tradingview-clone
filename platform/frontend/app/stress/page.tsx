"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Button, Card, CardHeader, Empty, Field, Notice, PageHeader, PageShell,
  Select, StatusBadge, TextInput,
} from "@/components/ui";
import { shortReason } from "@/lib/errorCopy";
import { api } from "@/lib/api";
import type {
  Interval, StressMethod, StressRun, StressRunDetail, StressWindow, SymbolInfo,
} from "@/lib/types";
import { displaySymbol } from "@/lib/instrument";
import { fmtNum, fmtPct, signClass, UTC_DATE_NOTE } from "@/lib/format";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const METHODS: { value: StressMethod; label: string; hint: string }[] = [
  { value: "worst_return", label: "Worst return",
    hint: "the most negative close-to-close move over the window length" },
  { value: "deepest_drawdown", label: "Deepest drawdown",
    hint: "the largest peak-to-trough fall inside the window" },
  { value: "highest_volatility", label: "Highest volatility",
    hint: "the most violent stretch, up or down" },
];

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

/** The sentence that has to travel with every number on this page. */
function EpistemicNotice() {
  return (
    <Notice tone="warn">
      <span className="font-medium">Stress windows are chosen with hindsight.</span>{" "}
      They are found by searching the benchmark&rsquo;s history for its worst
      stretches, so a result here measures robustness against conditions we
      already know were bad. It is <span className="font-medium">not</span>{" "}
      out-of-sample evidence and it does not support a claim about future
      performance. Read it beside a run&rsquo;s development and holdout windows,
      never as though it were one of them.
    </Notice>
  );
}

function WindowTable({ detail }: { detail: StressRunDetail }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm tabular">
        <thead>
          <tr className="border-b border-border text-left text-xs text-ink-muted">
            <th className="px-4 py-2 font-medium">#</th>
            <th className="px-4 py-2 font-medium" title={UTC_DATE_NOTE}>Window (UTC)</th>
            <th className="px-4 py-2 font-medium text-right">Benchmark %</th>
            <th className="px-4 py-2 font-medium text-right">Benchmark DD</th>
            <th className="px-4 py-2 font-medium text-right">Strategy %</th>
            <th className="px-4 py-2 font-medium text-right">Strategy DD</th>
            <th className="px-4 py-2 font-medium text-right">Trades</th>
            <th className="px-4 py-2 font-medium text-right">Win %</th>
            <th className="px-4 py-2 font-medium">Run</th>
          </tr>
        </thead>
        <tbody>
          {detail.results.map(({ window, backtest }) => {
            const m = backtest?.metrics ?? null;
            /*
             * A zero is ambiguous in the worst way here.
             *
             * "0 trades" over the market's worst stretch reads as "the strategy
             * survived it". It equally means the configuration could never have
             * taken a trade at all, or that the traded instrument did not exist
             * for most of the window. Both are already on the wire —
             * `explainNoEntries` was built for the first — and this page was
             * showing none of it.
             */
            const truth = backtest?.executionTruth ?? null;
            const covered = truth?.covered ?? null;
            /*
             * Both ends. The sibling check in `RunWindows` guarded only the
             * start and was corrected; this one, written in the same commit,
             * was not. The END matters more here — a stress window running past
             * the traded symbol's stored candles shows "0 trades" in silence,
             * which reads as the strategy surviving it.
             */
            const DAY = 86_400_000;
            const short = covered !== null
              && (covered.startMs > window.startMs + DAY || covered.endMs < window.endMs - DAY);
            const note = truth?.noEntryReason
              ? "This configuration could not have taken a trade in any window."
              : short
                ? `Data covers only ${new Date(covered.startMs).toISOString().slice(0, 10)}`
                  + ` to ${new Date(covered.endMs).toISOString().slice(0, 10)} of this window.`
                : null;
            return (
              <tr key={window.backtestId} className="border-b border-border/50">
                <td className="px-4 py-2 text-ink-muted">{window.rank}</td>
                <td className="px-4 py-2 text-ink-muted">
                  {day(window.startMs)} → {day(window.endMs)}
                  {window.label && <span className="ml-1 text-ink-faint">{window.label}</span>}
                </td>
                <td className={`px-4 py-2 text-right ${signClass(window.benchmarkReturnPct)}`}>
                  {fmtPct(window.benchmarkReturnPct)}
                </td>
                <td className="px-4 py-2 text-right text-ink-muted">
                  -{fmtNum(window.benchmarkDrawdownPct)}%
                </td>
                <td className={`px-4 py-2 text-right ${m ? signClass(m.netProfitPct) : "text-ink-faint"}`}>
                  {m ? fmtPct(m.netProfitPct) : "—"}
                </td>
                <td className="px-4 py-2 text-right text-ink-muted">
                  {m ? `-${fmtNum(m.maxDrawdownPct)}%` : "—"}
                </td>
                <td className="px-4 py-2 text-right">
                  {m ? m.totalTrades : "—"}
                  {note && (
                    <span className="ml-1 cursor-help text-warn" title={
                      truth?.noEntryReason ?? note
                    }>!</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {m && m.totalTrades > 0 ? `${fmtNum(m.winRatePct, 1)}%` : "—"}
                </td>
                <td className="px-4 py-2">
                  {backtest === null ? <span className="text-ink-faint">—</span>
                    : backtest.status === "done" ? (
                      <Link href={`/research/${backtest.id}`}
                        className="rounded text-ink underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                        open
                      </Link>
                    ) : <StatusBadge status={backtest.status} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {detail.results.some((r) => r.backtest?.executionTruth?.noEntryReason) && (
        <div className="border-t border-border px-4 py-2 text-xs text-warn">
          {detail.results.find((r) => r.backtest?.executionTruth?.noEntryReason)!
            .backtest!.executionTruth!.noEntryReason}{" "}
          Every window below therefore shows no trades for that reason, not because
          the strategy weathered them.
        </div>
      )}
      <p className="px-4 py-3 text-xs text-ink-faint">
        {/*
          Said plainly: this page does not yet offer a parameter editor, so a
          run uses the strategy's own defaults. Implying it ran the reader's
          configuration would make every number on the table mean something it
          does not.
        */}
        {Object.keys(detail.params ?? {}).length === 0 && detail.configId === null
          ? <>This run used the strategy&rsquo;s default parameters — this page has no
            parameter editor yet, so it is not your saved configuration.{" "}</>
          : <>This run used {detail.configId === null
            ? "the parameters it was given" : "a saved configuration"}.{" "}</>}
        Each window ran as an ordinary backtest — same engine, same costs, same warm-up,
        same no-lookahead rules — so these numbers are directly comparable with any other
        run on this install. The benchmark columns describe {detail.benchmarkSymbol} on the{" "}
        {detail.benchmarkInterval} series; the strategy columns describe {detail.symbol} on{" "}
        {detail.timeframe}.
      </p>
    </div>
  );
}

export default function StressPage() {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [strategies, setStrategies] = useState<{ key: string; name: string }[]>([]);

  const [strategyKey, setStrategyKey] = useState("mtf_lean");
  const [symbol, setSymbol] = useState("SOLUSDT");
  const [timeframe, setTimeframe] = useState<Interval>("1h");
  const [benchmarkSymbol, setBenchmarkSymbol] = useState("BTCUSDT");
  const [benchmarkInterval, setBenchmarkInterval] = useState<Interval>("1d");
  const [start, setStart] = useState(isoDaysAgo(540));
  const [end, setEnd] = useState(isoDaysAgo(0));
  const [method, setMethod] = useState<StressMethod>("worst_return");
  const [lengthBars, setLengthBars] = useState(21);
  const [topN, setTopN] = useState(3);
  const [capital, setCapital] = useState(10_000);

  const [preview, setPreview] = useState<StressWindow[] | null>(null);
  const [runs, setRuns] = useState<StressRun[]>([]);
  const [open, setOpen] = useState<StressRunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.listSymbols().then(setSymbols).catch(() => {});
    api.listStrategies().then((s) => setStrategies(s.map((x) => ({ key: x.key, name: x.name }))))
      .catch(() => {});
    api.listStressRuns().then(setRuns).catch((e) => setErr((e as Error).message));
  }, []);

  // Poll the open run while any of its windows is still being simulated.
  useEffect(() => {
    if (!open || open.status !== "running") return;
    const t = setInterval(() => {
      void api.getStressRun(open.id).then(setOpen).catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [open]);

  const discovery = {
    benchmarkSymbol, benchmarkInterval,
    startTime: new Date(start).toISOString(),
    endTime: new Date(end).toISOString(),
    method, lengthBars, topN,
  };

  const findWindows = async (): Promise<void> => {
    setBusy(true); setErr(null);
    try {
      const r = await api.stressWindows(discovery);
      setPreview(r.windows);
    } catch (e) { setErr((e as Error).message); setPreview(null); }
    finally { setBusy(false); }
  };

  const run = async (): Promise<void> => {
    setBusy(true); setErr(null);
    try {
      const created = await api.createStressRun({
        ...discovery, strategyKey, symbol, timeframe, initialCapital: capital,
      });
      setOpen(await api.getStressRun(created.id));
      setRuns(await api.listStressRuns());
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const methodHint = METHODS.find((m) => m.value === method)?.hint ?? "";

  return (
    <PageShell>
      <PageHeader
        title="Stress analysis"
        description={<>
          Run a strategy through the periods in which the market itself behaved worst.
          The benchmark need not be the instrument you trade — a SOL strategy meets the
          market&rsquo;s stress largely through BTC, so testing it against BTC&rsquo;s worst
          stretches usually asks the better question.
        </>}
      />

      <EpistemicNotice />

      {err && (
        <Notice tone="error" role="alert">
          {shortReason(err)}
          <span className="ml-1 text-ink-faint" title={err}>·</span>
        </Notice>
      )}

      <Card>
        <CardHeader title="Define the stress" />
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="Benchmark" help="whose bad periods define the windows">
              <Select value={benchmarkSymbol} onChange={(e) => setBenchmarkSymbol(e.target.value)}>
                {symbols.map((s) => (
                  <option key={s.symbol} value={s.symbol}>{displaySymbol(s.symbol)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Benchmark interval">
              <Select value={benchmarkInterval}
                onChange={(e) => setBenchmarkInterval(e.target.value as Interval)}>
                {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
              </Select>
            </Field>
            <Field label="Search from" help={UTC_DATE_NOTE}>
              <TextInput type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Search to" help={UTC_DATE_NOTE}>
              <TextInput type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
            <Field label="Worst by" help={methodHint}>
              <Select value={method} onChange={(e) => setMethod(e.target.value as StressMethod)}>
                {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="Window length"
              help={`in ${benchmarkInterval} benchmark bars`}>
              <TextInput type="number" min={2} value={lengthBars}
                onChange={(e) => setLengthBars(Number(e.target.value))} />
            </Field>
            <Field label="How many windows"
              help="separated by at least one window length, so each is a distinct episode">
              <TextInput type="number" min={1} value={topN}
                onChange={(e) => setTopN(Number(e.target.value))} />
            </Field>
            <Field label="Strategy">
              <Select value={strategyKey} onChange={(e) => setStrategyKey(e.target.value)}>
                {strategies.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Traded symbol">
              <Select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                {symbols.map((s) => (
                  <option key={s.symbol} value={s.symbol}>{displaySymbol(s.symbol)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Traded interval">
              <Select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Interval)}>
                {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <Field label="Initial capital">
              <TextInput type="number" min={1} value={capital}
                onChange={(e) => setCapital(Number(e.target.value))} />
            </Field>
            {/*
              Discovery is offered on its own because it genuinely is on its
              own: no strategy is named while the windows are chosen, and being
              able to see that for yourself is what makes the analysis
              believable rather than merely asserted.
            */}
            <Button variant="ghost" onClick={() => void findWindows()} disabled={busy}>
              {busy ? "Working…" : "Find the windows"}
            </Button>
            <Button onClick={() => void run()} disabled={busy}>
              Run the strategy through them
            </Button>
          </div>

          {preview && (
            <div className="rounded-md border border-border">
              <div className="border-b border-border px-3 py-2 text-xs text-ink-muted">
                {preview.length === 0
                  ? "No window met the configuration."
                  : `${preview.length} window${preview.length === 1 ? "" : "s"} of ${benchmarkSymbol}, chosen from market data alone — no strategy was named.`}
              </div>
              {preview.map((w) => (
                <div key={w.rank}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/50 px-3 py-2 text-xs last:border-0">
                  <span className="text-ink-muted">#{w.rank}</span>
                  <span className="text-ink tabular">{day(w.startMs)} → {day(w.endMs)}</span>
                  <span className={signClass(w.benchmarkReturnPct)}>
                    return {fmtPct(w.benchmarkReturnPct)}
                  </span>
                  <span className="text-ink-muted">drawdown -{fmtNum(w.benchmarkDrawdownPct)}%</span>
                  <span className="text-ink-faint">volatility {fmtNum(w.benchmarkVolatilityPct)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {open && (
        <Card>
          <CardHeader
            title={`${open.symbol} · ${open.timeframe} through ${open.benchmarkSymbol}'s worst ${open.discovery.config.lengthBars} ${open.benchmarkInterval} bars`}
            right={<StatusBadge status={open.status} />}
          />
          <WindowTable detail={open} />
          <div className="border-t border-border px-4 py-3 text-xs text-ink-faint">
            Discovery searched {open.discovery.searched.bars.toLocaleString()} bars of{" "}
            {open.discovery.benchmark.symbol} from {open.discovery.benchmark.providerId}, ranked by{" "}
            {open.discovery.config.method.replace(/_/g, " ")}, keeping{" "}
            {open.discovery.config.topN} window(s) at least{" "}
            {open.discovery.config.minSeparationBars} bars apart. Stored with the run, so the
            same windows can be produced again.
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Previous stress runs"
          right={<span className="text-xs text-ink-faint">{runs.length}</span>} />
        {runs.length === 0 ? (
          <Empty>No stress runs yet. Define one above.</Empty>
        ) : (
          <div className="divide-y divide-border/50">
            {runs.map((r) => (
              <button key={r.id}
                onClick={() => void api.getStressRun(r.id).then(setOpen).catch(() => {})}
                className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                <span className="font-medium text-ink">{r.symbol} · {r.timeframe}</span>
                <span className="text-ink-muted">
                  vs {r.benchmarkSymbol} {r.benchmarkInterval} ·{" "}
                  {r.discovery.config.method.replace(/_/g, " ")} ·{" "}
                  {r.windows.length} window{r.windows.length === 1 ? "" : "s"}
                </span>
                <StatusBadge status={r.status} />
                <span className="ml-auto text-xs text-ink-faint">{day(Date.parse(r.createdAt))}</span>
              </button>
            ))}
          </div>
        )}
      </Card>
    </PageShell>
  );
}
