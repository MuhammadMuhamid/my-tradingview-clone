"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Button, Card, CardHeader, Empty, Field, Notice, PageHeader, PageShell,
  Select, StatusBadge, TextInput,
} from "@/components/ui";
import { StressBenchmarkChart } from "@/components/StressBenchmarkChart";
import { describeAction, describeFailure, type FailureCopy } from "@/lib/errorCopy";
import { api } from "@/lib/api";
import type {
  Backtest, Interval, StressBenchmarkPath, StressDiscovery, StressMethod, StressRun,
  StressRunDetail, StressWindow, SymbolInfo,
} from "@/lib/types";
import { displaySymbol, displayTicker } from "@/lib/instrument";
import { fmtNum, fmtPct, signClass, UTC_DATE_NOTE } from "@/lib/format";
import {
  benchmarkSource, exposureNote, qualifiedBy, shortRunId, stressSourceDetail,
  stressSourceFromBacktest, stressSourceHeadline, type StressSource,
} from "@/lib/stress";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const METHODS: { value: StressMethod; label: string; hint: string }[] = [
  { value: "worst_return", label: "Worst return",
    hint: "the most negative move from the window's first open to its last close" },
  { value: "deepest_drawdown", label: "Deepest drawdown",
    hint: "the largest peak-to-trough fall inside the window" },
  { value: "highest_volatility", label: "Highest volatility",
    hint: "the most violent stretch, up or down" },
];
/*
 * The server's ceilings (`engine/stress.ts`), restated as input bounds so the
 * form does not invite a request the server will refuse. The server stays the
 * authority; these only shape the control.
 */
const MAX_TOP_N = 10;
const MAX_LENGTH_BARS = 20_000;
/*
 * The same default as an ordinary backtest (`BacktestForm`, and the backend's
 * DEFAULT_INITIAL_CAPITAL). This page defaulted to 10,000, so a default stress
 * run divided the same cash-sized trades by ten times the capital a default
 * backtest did, and its Strategy % read a tenth as large.
 */
const DEFAULT_CAPITAL = 1000;
const POLL_MS = 2500;

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

function Failure({ failure }: { failure: FailureCopy }) {
  return (
    <Notice tone="error" role="alert">
      {failure.headline}
      {failure.detail && <span className="ml-1 cursor-help text-ink-faint" title={failure.detail}>·</span>}
    </Notice>
  );
}

const DAY = 86_400_000;

function WindowTable({ detail }: { detail: StressRunDetail }) {
  const benchmark = displayTicker(detail.benchmarkSymbol);
  const traded = displayTicker(detail.symbol);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1100px] text-sm tabular">
        <thead>
          <tr className="border-b border-border text-left text-xs text-ink-muted">
            <th className="px-4 py-2 font-medium" title="Severity rank: 1 is the worst window found">Rank</th>
            <th className="px-4 py-2 font-medium" title={UTC_DATE_NOTE}>Window (UTC)</th>
            <th className="px-4 py-2 font-medium"
              title={`The statistic of ${benchmark} this window was ranked on, and its value`}>
              Qualified by
            </th>
            <th className="px-4 py-2 font-medium text-right"
              title={`${benchmark} from the window's first open to its last close`}>Benchmark %</th>
            <th className="px-4 py-2 font-medium text-right"
              title={`${benchmark}'s deepest fall inside the window`}>Benchmark DD</th>
            <th className="px-4 py-2 font-medium text-right"
              title={`${traded} bought at the window's first open and held to its last close — what the traded market did, with no strategy involved`}>
              Target %
            </th>
            <th className="px-4 py-2 font-medium text-right"
              title="Net profit over the initial capital — see the sizing note below">Strategy %</th>
            <th className="px-4 py-2 font-medium text-right">Strategy DD</th>
            <th className="px-4 py-2 font-medium text-right">Trades</th>
            <th className="px-4 py-2 font-medium text-right">Win %</th>
            <th className="px-4 py-2 font-medium">Run</th>
          </tr>
        </thead>
        <tbody>
          {detail.results.map(({ window, backtest, target }) => {
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
            const short = covered !== null
              && (covered.startMs > window.startMs + DAY || covered.endMs < window.endMs - DAY);
            const note = truth?.noEntryReason
              ? "This configuration could not have taken a trade in any window."
              : short
                ? `Data covers only ${day(covered.startMs)} to ${day(covered.endMs)} of this window.`
                : null;
            return (
              <tr key={window.backtestId} className="border-b border-border/50">
                <td className="px-4 py-2 text-ink-muted">{window.rank}</td>
                <td className="px-4 py-2 text-ink-muted">
                  {day(window.startMs)} → {day(window.endMs)}
                  {window.label && <span className="ml-1 text-ink-faint">{window.label}</span>}
                </td>
                <td className="px-4 py-2 text-ink-muted">
                  {benchmark} {qualifiedBy(window)}
                </td>
                <td className={`px-4 py-2 text-right ${signClass(window.benchmarkReturnPct)}`}>
                  {fmtPct(window.benchmarkReturnPct)}
                </td>
                <td className="px-4 py-2 text-right text-ink-muted">
                  -{fmtNum(window.benchmarkDrawdownPct)}%
                </td>
                <td className={`px-4 py-2 text-right ${target ? signClass(target.returnPct) : "text-ink-faint"}`}
                  data-stress-target>
                  {target ? fmtPct(target.returnPct) : (
                    <span title={`${traded} has no stored bars for this window yet`}>—</span>
                  )}
                  {target && !target.complete && (
                    <span className="ml-1 cursor-help text-warn"
                      title={`${traded} data covers only ${day(target.startMs)} to ${day(target.endMs)} of this window.`}>
                      !
                    </span>
                  )}
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
      <RunNotes detail={detail} />
    </div>
  );
}

/**
 * What every number in the table is a number OF.
 *
 * The old line said each window's figures were "directly comparable with any
 * other run on this install". Comparable in method, yes — same engine, same
 * warm-up, same no-lookahead rules. Comparable in magnitude only where the
 * capital, the sizing and the cost model match, because Strategy % is net
 * profit over the initial capital while each entry commits the strategy's own
 * cash size. That ratio is this run's, so it is stated here.
 */
function RunNotes({ detail }: { detail: StressRunDetail }) {
  const sizing = detail.results.find((r) => r.backtest?.executionTruth)?.backtest?.executionTruth?.sizing
    ?? null;
  const worstTarget = detail.results
    .map((r) => r.target)
    .filter((t): t is NonNullable<typeof t> => !!t && t.complete)
    .sort((a, b) => a.returnPct - b.returnPct)[0] ?? null;
  const defaults = Object.keys(detail.params ?? {}).length === 0 && detail.configId === null;
  return (
    <div className="space-y-2 px-4 py-3 text-xs text-ink-faint">
      <p data-stress-exposure>
        {exposureNote(sizing, detail.initialCapital,
          worstTarget ? { returnPct: worstTarget.returnPct, symbol: detail.symbol } : null)}
      </p>
      <p>
        {defaults
          ? <>This run used the strategy&rsquo;s default parameters.{" "}</>
          : <>This run used {detail.configId === null
            ? "the parameters it was sent, not the strategy's defaults" : "a saved configuration"}.{" "}</>}
        Each window ran as an ordinary backtest — same engine, same warm-up, same
        no-lookahead rules — at {fmtNum(detail.initialCapital, 0)} initial capital,
        {" "}{fmtNum(detail.commissionPct, 3)} % commission per fill and {detail.slippageTicks} tick
        {detail.slippageTicks === 1 ? "" : "s"} of slippage. Its Strategy % compares with another
        run&rsquo;s only where the capital, sizing and costs match. The benchmark columns describe
        {" "}{displayTicker(detail.benchmarkSymbol)} on the {detail.benchmarkInterval} series; Target %
        and the strategy columns describe {displayTicker(detail.symbol)} on {detail.timeframe}.
      </p>
    </div>
  );
}

/** The provenance line under an opened run: what was searched, from where, and how. */
function DiscoveryLine({ discovery }: { discovery: StressDiscovery }) {
  const source = benchmarkSource(discovery.benchmark);
  return (
    <div className="border-t border-border px-4 py-3 text-xs text-ink-faint">
      Discovery searched {discovery.searched.bars.toLocaleString()} bars of{" "}
      {displayTicker(discovery.benchmark.symbol)} from{" "}
      <span className="cursor-help" title={source.detail}>{source.label}</span>, ranked by{" "}
      {discovery.config.method.replace(/_/g, " ")}, keeping{" "}
      {discovery.config.topN} window(s) at least{" "}
      {discovery.config.minSeparationBars} bars apart. Stored with the run, so the
      same windows can be produced again.
    </div>
  );
}

export default function StressPage() {
  // useSearchParams needs a Suspense boundary during static prerendering.
  return (
    <Suspense fallback={null}>
      <StressWorkspace />
    </Suspense>
  );
}

type SourceState =
  | { status: "loading"; backtestId: string }
  | { status: "ready"; source: StressSource }
  | { status: "failed"; backtestId: string; failure: FailureCopy };

function StressWorkspace() {
  const searchParams = useSearchParams();
  /*
   * `?from=<backtestId>` stresses a finished run's own settings. A choice made
   * on the page — another run, or the defaults — overrides the address it was
   * opened at; `chooseSource` rewrites the address to match, and the override
   * covers the render before Next notices.
   */
  const [override, setOverride] = useState<{ id: string | null } | null>(null);
  const fromId = override ? override.id : searchParams?.get("from") ?? null;
  const runParam = searchParams?.get("run") ?? null;

  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [strategies, setStrategies] = useState<{ id: number; key: string; name: string }[]>([]);
  const [recent, setRecent] = useState<Backtest[]>([]);

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
  const [capital, setCapital] = useState(DEFAULT_CAPITAL);
  const [sourceState, setSourceState] = useState<SourceState | null>(null);

  const [preview, setPreview] = useState<
    { windows: StressWindow[]; discovery: StressDiscovery; path: StressBenchmarkPath | null } | null
  >(null);
  const [runs, setRuns] = useState<StressRun[]>([]);
  const [open, setOpen] = useState<StressRunDetail | null>(null);
  const [openPath, setOpenPath] = useState<{ id: string; path: StressBenchmarkPath } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FailureCopy | null>(null);

  useEffect(() => {
    api.listSymbols().then(setSymbols).catch(() => {});
    api.listStrategies().then((s) => setStrategies(s.map((x) => ({ id: x.id, key: x.key, name: x.name }))))
      .catch(() => {});
    api.listStressRuns().then(setRuns)
      .catch((e) => setErr(describeFailure(e, "Previous stress runs")));
    api.listBacktests().then(setRecent).catch(() => {});
  }, []);

  // `?run=<id>` opens that stress run, so a window's result page can link back to it.
  useEffect(() => {
    if (!runParam) return;
    api.getStressRun(runParam).then(setOpen)
      .catch((e) => setErr(describeFailure(e, "That stress run")));
  }, [runParam]);

  /*
   * Load the run whose settings are being stressed, and put them into the
   * form. The strategy list is read again here rather than waited for, so the
   * banner never says "loading" because of an unrelated request.
   */
  useEffect(() => {
    if (!fromId) { setSourceState(null); return; }
    let live = true;
    setSourceState({ status: "loading", backtestId: fromId });
    Promise.all([api.getBacktest(fromId), api.listStrategies()])
      .then(([backtest, list]) => {
        if (!live) return;
        const source = stressSourceFromBacktest(backtest, list);
        if ("reason" in source) {
          setSourceState({ status: "failed", backtestId: fromId, failure: { headline: source.reason, detail: "" } });
          return;
        }
        setStrategyKey(source.strategyKey);
        setSymbol(source.symbol);
        setTimeframe(source.timeframe);
        setCapital(source.initialCapital);
        setSourceState({ status: "ready", source });
      })
      .catch((e) => {
        if (live) setSourceState({ status: "failed", backtestId: fromId, failure: describeFailure(e, `Run ${shortRunId(fromId)}`) });
      });
    return () => { live = false; };
  }, [fromId]);

  const source = sourceState?.status === "ready" ? sourceState.source : null;

  const chooseSource = (backtestId: string | null): void => {
    window.history.replaceState({}, "",
      backtestId ? `/stress?from=${encodeURIComponent(backtestId)}` : "/stress");
    setOverride({ id: backtestId });
    if (backtestId === null) {
      // Back to what an unconfigured page offers, so nothing of the run lingers.
      setStrategyKey("mtf_lean");
      setSymbol("SOLUSDT");
      setTimeframe("1h");
      setCapital(DEFAULT_CAPITAL);
    }
  };

  const refreshRuns = useCallback((): void => {
    api.listStressRuns().then(setRuns).catch(() => {});
  }, []);

  /*
   * Poll while anything is still being simulated: the open run, so its rows
   * fill in, and the list, so a run that finished stops saying "Running".
   * The list used to be read once, on mount, and the server never settled a
   * run it was not asked for by id — so a finished run said "Running" until
   * the page was reloaded AND the run was opened.
   */
  const openRunning = open?.status === "running";
  const anyRunning = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!openRunning && !anyRunning) return;
    const t = setInterval(() => {
      if (openRunning && open) void api.getStressRun(open.id).then(setOpen).catch(() => {});
      if (anyRunning || openRunning) refreshRuns();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [openRunning, anyRunning, open, refreshRuns]);

  // The benchmark series is read once per opened run, not on every poll.
  const openId = open?.id ?? null;
  useEffect(() => {
    if (!openId) return;
    let live = true;
    api.getStressBenchmark(openId)
      .then((b) => { if (live) setOpenPath({ id: openId, path: b.path }); })
      .catch(() => { if (live) setOpenPath(null); });
    return () => { live = false; };
  }, [openId]);

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
      setPreview({ windows: r.windows, discovery: r.discovery, path: r.path ?? null });
    } catch (e) { setErr(describeAction(e, "find the windows")); setPreview(null); }
    finally { setBusy(false); }
  };

  const run = async (): Promise<void> => {
    setBusy(true); setErr(null);
    try {
      const created = await api.createStressRun({
        ...discovery,
        ...(source
          ? {
            // The finished run's own configuration, every field of it.
            strategyKey: source.strategyKey, symbol: source.symbol, timeframe: source.timeframe,
            params: source.params, initialCapital: source.initialCapital,
            commissionPct: source.commissionPct, slippageTicks: source.slippageTicks,
          }
          : { strategyKey, symbol, timeframe, initialCapital: capital }),
      });
      setOpen(await api.getStressRun(created.id));
      refreshRuns();
    } catch (e) { setErr(describeAction(e, "start the stress run")); }
    finally { setBusy(false); }
  };

  const methodHint = METHODS.find((m) => m.value === method)?.hint ?? "";
  const strategyName = strategies.find((s) => s.key === strategyKey)?.name ?? strategyKey;
  const strategyNameById = (id: number): string | null => strategies.find((s) => s.id === id)?.name ?? null;
  // Runs a reader can start from: finished, and not themselves a stress window.
  const startable = recent.filter((b) => b.status === "done" && b.stressRunId === null).slice(0, 50);
  const settingsLocked = sourceState !== null && sourceState.status !== "failed";

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

      {err && <Failure failure={err} />}

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
              <TextInput type="number" min={2} max={MAX_LENGTH_BARS} value={lengthBars}
                onChange={(e) => setLengthBars(Number(e.target.value))} />
            </Field>
            <Field label="How many windows"
              help={`at most ${MAX_TOP_N}, each at least one window length apart`}>
              <TextInput type="number" min={1} max={MAX_TOP_N} value={topN}
                onChange={(e) => setTopN(Number(e.target.value))} />
            </Field>
          </div>

          {/*
            Discovery is offered on its own because it genuinely is on its
            own: no strategy is named while the windows are chosen, and being
            able to see that for yourself is what makes the analysis
            believable rather than merely asserted.
          */}
          <div className="flex flex-wrap items-end gap-3">
            <Button variant="ghost" onClick={() => void findWindows()} disabled={busy}>
              {busy ? "Working…" : "Find the windows"}
            </Button>
          </div>

          {preview && (
            <div className="rounded-md border border-border">
              <div className="border-b border-border px-3 py-2 text-xs text-ink-muted">
                {preview.windows.length === 0
                  ? "No window met the configuration."
                  : `${preview.windows.length} window${preview.windows.length === 1 ? "" : "s"} of ${displayTicker(benchmarkSymbol)}, chosen from market data alone — no strategy was named.`}
              </div>
              {preview.path && (
                <StressBenchmarkChart symbol={preview.discovery.benchmark.symbol}
                  interval={preview.discovery.benchmark.interval} path={preview.path}
                  windows={preview.windows} range={preview.discovery.searched} />
              )}
              {preview.windows.map((w) => (
                <div key={w.rank}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/50 px-3 py-2 text-xs last:border-0">
                  <span className="text-ink-muted">#{w.rank}</span>
                  <span className="text-ink tabular">{day(w.startMs)} → {day(w.endMs)}</span>
                  <span className="text-ink-muted">qualified by {qualifiedBy(w)}</span>
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

      <Card>
        <CardHeader title="The strategy to run through them" />
        <div className="space-y-4 p-4">
          {/*
            Which configuration runs is the first thing said, not a footnote
            under the results. The page used to run every strategy at its
            defaults while the reader had a tuned run in mind, and admitted it
            only beneath the table.
          */}
          <div data-stress-source>
            {sourceState?.status === "ready" ? (
              <Notice tone="info" role="status">
                <span className="font-medium">{stressSourceHeadline(sourceState.source)}</span>
                <span className="block text-xs text-ink-muted">
                  {stressSourceDetail(sourceState.source)}. The strategy, symbol, interval and capital
                  are that run&rsquo;s, so they are fixed here.
                </span>
                <span className="mt-1 flex flex-wrap gap-3 text-xs">
                  <Link href={`/research/${sourceState.source.backtestId}`}
                    className="rounded text-ink underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                    Open run {shortRunId(sourceState.source.backtestId)}
                  </Link>
                  <button type="button" onClick={() => chooseSource(null)}
                    className="rounded text-ink underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                    Use the strategy&rsquo;s defaults instead
                  </button>
                </span>
              </Notice>
            ) : sourceState?.status === "loading" ? (
              <Notice tone="info" role="status">
                Loading the settings of run {shortRunId(sourceState.backtestId)}…
              </Notice>
            ) : sourceState?.status === "failed" ? (
              <Notice tone="warn" role="alert">
                {sourceState.failure.headline}
                {sourceState.failure.detail && (
                  <span className="ml-1 cursor-help text-ink-faint" title={sourceState.failure.detail}>·</span>
                )}{" "}
                Until another run is chosen, the strategy runs with its default parameters.
              </Notice>
            ) : (
              <p className="text-sm text-ink-muted">
                <span className="font-medium text-ink">{strategyName} will run with its default
                parameters</span> and the default cost model — not a configuration you have tuned.
                This page has no parameter editor; to stress a configuration, start from a run of it.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="Start from a run" help="its parameters, capital and costs">
              <Select value={fromId ?? ""} onChange={(e) => chooseSource(e.target.value || null)}>
                <option value="">Strategy defaults</option>
                {/* A run opened by link need not be among the recent ones listed. */}
                {fromId && !startable.some((b) => b.id === fromId) && (
                  <option value={fromId}>{shortRunId(fromId)}</option>
                )}
                {startable.map((b) => (
                  <option key={b.id} value={b.id}>
                    {shortRunId(b.id)} · {strategyNameById(b.strategyId) ?? "strategy"} · {displayTicker(b.symbol)} · {b.timeframe} · {day(Date.parse(b.createdAt))}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Strategy">
              <Select value={strategyKey} disabled={settingsLocked}
                onChange={(e) => setStrategyKey(e.target.value)}>
                {strategies.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Traded symbol">
              <Select value={symbol} disabled={settingsLocked} onChange={(e) => setSymbol(e.target.value)}>
                {symbols.map((s) => (
                  <option key={s.symbol} value={s.symbol}>{displaySymbol(s.symbol)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Traded interval">
              <Select value={timeframe} disabled={settingsLocked}
                onChange={(e) => setTimeframe(e.target.value as Interval)}>
                {(INTERVALS.includes(timeframe) ? INTERVALS : [...INTERVALS, timeframe]).map((i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </Select>
            </Field>
            <Field label="Initial capital">
              <TextInput type="number" min={1} value={capital} disabled={settingsLocked}
                onChange={(e) => setCapital(Number(e.target.value))} />
            </Field>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <Button onClick={() => void run()} disabled={busy || sourceState?.status === "loading"}>
              Run the strategy through them
            </Button>
          </div>
        </div>
      </Card>

      {open && (
        <Card>
          <CardHeader
            title={`${displayTicker(open.symbol)} · ${open.timeframe} through ${displayTicker(open.benchmarkSymbol)}'s worst ${open.discovery.config.lengthBars} ${open.benchmarkInterval} bars`}
            right={<StatusBadge status={open.status} />}
          />
          {openPath && openPath.id === open.id && (
            <StressBenchmarkChart symbol={open.discovery.benchmark.symbol}
              interval={open.discovery.benchmark.interval} path={openPath.path}
              windows={open.windows} range={open.discovery.searched} />
          )}
          <WindowTable detail={open} />
          <DiscoveryLine discovery={open.discovery} />
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
              <button key={r.id} type="button"
                onClick={() => void api.getStressRun(r.id).then(setOpen)
                  .catch((e) => setErr(describeFailure(e, "That stress run")))}
                className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                <span className="font-medium text-ink">
                  {strategyNameById(r.strategyId) ? `${strategyNameById(r.strategyId)} · ` : ""}
                  {displayTicker(r.symbol)} · {r.timeframe}
                </span>
                <span className="text-ink-muted">
                  vs {displayTicker(r.benchmarkSymbol)} {r.benchmarkInterval} ·{" "}
                  {r.discovery.config.method.replace(/_/g, " ")} ·{" "}
                  {r.windows.length} window{r.windows.length === 1 ? "" : "s"} ·{" "}
                  {Object.keys(r.params ?? {}).length === 0 && r.configId === null
                    ? "defaults" : "explicit parameters"}
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
