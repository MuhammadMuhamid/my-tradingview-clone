"use client";
import { AdminOnlyPage } from "@/components/AdminOnlyPage";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Card, Empty, ErrorNotice, Field, Loading, PageShell, Select, TextInput, PageHeader } from "@/components/ui";
import {
  api, type JournalEnvironment, type JournalResponse, type JournalRow, type JournalSource,
  type JournalSummarySlice,
} from "@/lib/api";
import { fmtDateTime, fmtNum, fmtPrice, signClass, LOCAL_TIME_NOTE } from "@/lib/format";
import { EXECUTION_ENVIRONMENT_LABEL, EXECUTION_ENVIRONMENT_TONE } from "@/lib/executionEnvironment";

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const today = () => {
  const end = new Date();
  const start = new Date(end.getTime() - 29 * 86_400_000);
  return { from: dateOnly(start), to: dateOnly(end) };
};

function money(value: number | null): string {
  if (value === null) return "Unknown";
  return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

function duration(ms: number | null): string {
  if (ms === null) return "Unknown";
  const hours = ms / 3_600_000;
  if (hours < 24) return `${hours.toFixed(hours < 1 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

const sourceStyle: Record<JournalSource, string> = {
  MANUAL: "border-accent/30 bg-accent/10 text-accent",
  AUTOMATED: "border-up/30 bg-up/10 text-up",
  PAPER: "border-warn/30 bg-warn/10 text-warn",
};

/*
 * Which money a row is about. The backend decides it from the row's own
 * evidence (journal/environment): REAL only on proof, UNKNOWN otherwise. The
 * words and colours are the chart chip's own (lib/executionEnvironment):
 * `warn` where it could be real money (REAL, UNKNOWN), neutral where it cannot
 * (TESTNET, DRY RUN). PAPER keeps the page's existing PAPER style.
 */
const ENVIRONMENT_LABEL: Record<JournalEnvironment, string> = {
  ...EXECUTION_ENVIRONMENT_LABEL, PAPER: "PAPER",
};
const ENVIRONMENT_STYLE: Record<JournalEnvironment, string> = {
  ...EXECUTION_ENVIRONMENT_TONE, PAPER: sourceStyle.PAPER,
};
const ENVIRONMENT_MEANING: Record<JournalEnvironment, string> = {
  REAL: "Real money: this row's own evidence proves a mainnet exchange order.",
  PAPER: "Paper: simulated by the Platform's paper engine. No exchange order was sent.",
  TESTNET: "Testnet account: not real funds.",
  DRY_RUN: "Dry run: simulated by the execution bot. Nothing reached the exchange.",
  UNKNOWN: "Environment unknown: nothing in this row's evidence proves which exchange it reached, so it is never counted as real money.",
};

function EnvironmentBadge({ environment }: { environment: JournalEnvironment }) {
  return (
    <span data-environment={environment} title={ENVIRONMENT_MEANING[environment]}
      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${ENVIRONMENT_STYLE[environment]}`}>
      <span className="sr-only">Environment: </span>{ENVIRONMENT_LABEL[environment]}
    </span>
  );
}

/** Every row is counted once: as a known result or as unknown economics. */
const rowsIn = (scope: JournalSummarySlice): number => scope.knownRealizedRows + scope.unknownEconomicRows;

/**
 * The rows the real card does NOT count, named — "1 unknown-environment and 2
 * testnet rows below" — or null when there are none.
 */
function notCountedAsReal(counts: { unknown: number; testnet: number; dryRun: number }): string | null {
  const parts = [
    counts.unknown ? `${counts.unknown} unknown-environment` : null,
    counts.testnet ? `${counts.testnet} testnet` : null,
    counts.dryRun ? `${counts.dryRun} dry-run` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const total = counts.unknown + counts.testnet + counts.dryRun;
  const list = parts.length === 1 ? parts[0]
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${list} row${total === 1 ? "" : "s"} below`;
}

function SummaryCard({ title, scope, environment, notCounted = null }: {
  title: string; scope: JournalSummarySlice; environment: JournalEnvironment;
  /** Real card only: the unproven rows it excludes. */
  notCounted?: string | null;
}) {
  const known = scope.knownRealizedRows > 0;
  // Nothing in range is not the same fact as "economics unknown": the first is
  // an empty period, the second is activity whose cost basis is missing.
  const empty = !known && scope.realizationRows === 0 && scope.unknownEconomicRows === 0
    && scope.incompleteRows === 0;
  const paper = environment === "PAPER";
  return (
    <Card className={environment === "REAL" ? "" : "border-warn/30"}>
      <div className="p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
          <EnvironmentBadge environment={environment} />
        </div>
        <p className={`mt-2 tabular text-2xl font-semibold ${known ? signClass(scope.knownRealizedPnl) : "text-ink-muted"}`}>
          {known ? money(scope.knownRealizedPnl) : empty ? "—" : "Unknown"}
        </p>
        {/* Contract §7: could not read is not "you have none". An empty real
            slice beside unknown-environment results is not an empty range. */}
        <p className="mt-1 text-xs text-ink-faint">
          {empty
            ? notCounted ? `No result in this range is proven real money · ${notCounted}` : "No realized results in this range"
            : <>{paper ? "Known realized net" : "Known realized P&L"} · {scope.knownRealizedRows} known outcome{scope.knownRealizedRows === 1 ? "" : "s"}</>}
        </p>
        {!empty && notCounted && <p className="mt-0.5 text-xs text-ink-muted">Not counted here: {notCounted}</p>}
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div><dt className="text-ink-faint">Known fees</dt><dd className="mt-0.5 tabular text-ink">
            {scope.feeKnownRows > 0 ? `$${fmtNum(scope.knownFees)}` : empty ? "—" : "Unknown"}
          </dd></div>
          <div><dt className="text-ink-faint">Wins / losses</dt><dd className="mt-0.5 tabular text-ink">
            {scope.wins} / {scope.losses}
          </dd></div>
          <div><dt className="text-ink-faint">Incomplete rows</dt><dd className="mt-0.5 tabular text-ink">
            {scope.incompleteRows}
          </dd></div>
          <div><dt className="text-ink-faint">Average duration</dt><dd className="mt-0.5 tabular text-ink">
            {empty ? "—" : duration(scope.averageDurationMs)}
          </dd></div>
        </dl>
      </div>
    </Card>
  );
}

function Metric({ label, value, unknown = false }: { label: string; value: string; unknown?: boolean }) {
  return <div><dt className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</dt>
    <dd className={`mt-0.5 tabular text-xs ${unknown ? "text-ink-muted" : "text-ink"}`}>{value}</dd></div>;
}

function JournalItem({ row }: { row: JournalRow }) {
  const pnlKnown = row.realizedPnl !== null;
  return (
    <article className="border-b border-border px-3 py-3 last:border-b-0 sm:px-4" aria-labelledby={`${row.id}-title`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${sourceStyle[row.source]}`}>
              {row.source}
            </span>
            <EnvironmentBadge environment={row.environment} />
            <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted">
              {row.kind.replaceAll("_", " ")}
            </span>
            {row.evidenceState === "INCOMPLETE" && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-ink-muted">
              INCOMPLETE
            </span>}
          </div>
          <h3 id={`${row.id}-title`} className="mt-1.5 text-sm font-semibold text-ink">
            {row.symbol} · {row.title}
          </h3>
          <p className="mt-0.5 text-xs text-ink-faint">{fmtDateTime(row.occurredAt)}{row.side ? ` · ${row.side}` : ""}</p>
        </div>
        <div className="text-right">
          <p className={`tabular text-base font-semibold ${pnlKnown ? signClass(row.realizedPnl) : "text-ink-muted"}`}>
            {money(row.realizedPnl)}
          </p>
          <p className="text-[11px] text-ink-faint">known realized P&amp;L</p>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 lg:grid-cols-8">
        <Metric label="Quantity" value={row.quantity === null ? "Unknown" : fmtNum(row.quantity, 6)} unknown={row.quantity === null} />
        <Metric label="Entry" value={row.entryPrice === null ? "Unknown" : fmtPrice(row.entryPrice)} unknown={row.entryPrice === null} />
        <Metric label="Exit" value={row.exitPrice === null ? "Unknown" : fmtPrice(row.exitPrice)} unknown={row.exitPrice === null} />
        <Metric label="Gross P&L" value={money(row.grossRealizedPnl)} unknown={row.grossRealizedPnl === null} />
        <Metric label="Fees" value={row.fees === null ? "Unknown" : `$${fmtNum(row.fees)}`} unknown={row.fees === null} />
        <Metric label="Known P&L" value={money(row.realizedPnl)} unknown={row.realizedPnl === null} />
        <Metric label="Net P&L" value={money(row.netRealizedPnl)} unknown={row.netRealizedPnl === null} />
        <Metric label="Duration" value={duration(row.durationMs)} unknown={row.durationMs === null} />
      </dl>

      <div className="mt-3 flex flex-col gap-2 border-t border-border/70 pt-2 text-xs sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="leading-5 text-ink-muted">{row.evidenceDetail}</p>
          {(row.strategy || row.deploymentId) && <p className="mt-0.5 truncate text-ink-faint">
            {row.strategy ? `Strategy ${row.strategy.name ?? row.strategy.key ?? row.strategy.id}` : ""}
            {row.config ? ` · Config ${row.config.name ?? row.config.id}` : ""}
            {row.deploymentId ? ` · Deployment ${row.deploymentId}` : ""}
          </p>}
        </div>
        {row.deploymentId ? <Link href="/trading" className="inline-flex min-h-11 shrink-0 items-center underline text-ink-muted hover:text-ink">
          Open deployment timeline
        </Link> : row.source === "MANUAL" ? <Link href="/chart" className="inline-flex min-h-11 shrink-0 items-center underline text-ink-muted hover:text-ink">
          Open manual trading
        </Link> : null}
      </div>
    </article>
  );
}

function JournalView() {
  const defaults = today();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [source, setSource] = useState<JournalSource | "">("");
  const [symbol, setSymbol] = useState("");
  const [period, setPeriod] = useState<"day" | "week" | "month">("day");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<JournalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialLoad = useRef(false);

  const load = useCallback(async (pageNumber: number) => {
    setLoading(true);
    try {
      const next = await api.journal({ from, to, source, symbol: symbol.trim().toUpperCase(),
        period, page: pageNumber, limit: 50 });
      setData(next); setError(null); setPage(pageNumber);
    } catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  }, [from, to, source, symbol, period]);

  useEffect(() => {
    if (initialLoad.current) return;
    initialLoad.current = true;
    void load(1);
  }, [load]);
  const submit = (event: FormEvent) => { event.preventDefault(); void load(1); };

  return (
    <PageShell width="narrow">
      <header>
        <PageHeader
          title="Journal"
          description="What happened, newest first — manual orders, automated signals and paper fills, with the fill, the position and the result where the record proves them. The sums beneath are known realized performance from persisted evidence; Timeline explains what happened to one order. Unknown economics stay unknown."
        />
        {/*
          The one zone statement this page needs.

          Row times are the reader's own — that is the right authority for "when
          did this happen to me" and it is not being changed here — but the
          From/Through filter is built from the UTC date, and the chart this
          product ships states that its own axis is UTC. Two zones on one screen
          are fine; two unlabelled zones are not.
        */}
        <p className="mt-1 text-xs text-ink-faint">
          {LOCAL_TIME_NOTE} The From / Through filter is inclusive and uses the UTC date, matching
          the exchange bar timestamps on the chart.
        </p>
      </header>

      <Card>
        <form onSubmit={submit} className="grid min-w-0 grid-cols-1 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-6 lg:items-end">
          <Field label="From"><TextInput className="min-h-11 min-w-0 w-full" type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></Field>
          <Field label="Through"><TextInput className="min-h-11 min-w-0 w-full" type="date" value={to} onChange={(event) => setTo(event.target.value)} required /></Field>
          <Field label="Source"><Select className="min-h-11 min-w-0 w-full" value={source} onChange={(event) => setSource(event.target.value as JournalSource | "")}>
            <option value="">All · separated</option><option value="MANUAL">Manual</option>
            <option value="AUTOMATED">Automated</option><option value="PAPER">Paper</option>
          </Select></Field>
          <Field label="Symbol"><TextInput className="min-h-11 min-w-0 w-full" value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="All symbols" maxLength={20} /></Field>
          <Field label="Summary"><Select className="min-h-11 min-w-0 w-full" value={period} onChange={(event) => setPeriod(event.target.value as typeof period)}>
            <option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option>
          </Select></Field>
          {/* 44px is the phone touch target; from `sm` up the row is one
              height — 34px, like the fields beside it. */}
          <Button type="submit" variant="primary" disabled={loading} className="min-h-11 sm:min-h-0">
            {loading ? "Loading…" : "Apply"}
          </Button>
        </form>
      </Card>

      {/* TVP8: the raw thrown message was the whole of this banner. */}
      {error && <ErrorNotice error={error} what="the Journal evidence" />}
      {loading && !data && <Loading>Loading Journal evidence…</Loading>}

      {data && <>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div><h2 className="text-sm font-semibold text-ink">Activity & realizations</h2>
              <p className="mt-0.5 text-xs text-ink-faint">Newest first · {data.summary.incompleteRows} incomplete evidence row{data.summary.incompleteRows === 1 ? "" : "s"}</p></div>
            {data.summary.truncated && <span className="rounded-full border border-warn/30 bg-warn/10 px-2 py-1 text-xs text-warn">Summary bound reached</span>}
          </div>
          {data.rows.length === 0 ? <Empty>
              Nothing recorded between these dates. The Journal fills from manual orders placed through the
              Trading Scene order ticket, realization events the execution Bot reports for automated deployments,
              and paper deployment fills. Widen the dates, or open a deployment&apos;s Timeline under Trading for
              one order&apos;s exact history.
            </Empty>
            : <div>{data.rows.map((row) => <JournalItem key={row.id} row={row} />)}</div>}
          <div className="flex items-center justify-between border-t border-border px-3 py-2 sm:px-4">
            <Button variant="ghost" disabled={loading || page <= 1} onClick={() => void load(page - 1)} className="min-h-11 sm:min-h-0">Previous</Button>
            <span className="text-xs text-ink-faint">Page {page}</span>
            <Button variant="ghost" disabled={loading || !data.page.hasNext} onClick={() => void load(page + 1)} className="min-h-11 sm:min-h-0">Next</Button>
          </div>
        </Card>

        <section aria-label="Known realized summaries" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SummaryCard title="Real money evidence" scope={data.summary.real} environment="REAL"
              notCounted={notCountedAsReal({ unknown: rowsIn(data.summary.unknownEnvironment),
                testnet: rowsIn(data.summary.testnet), dryRun: rowsIn(data.summary.dryRun) })} />
            {/* "Simulation" was this card's own word for what its badge, its
                filter option and the delivery mode itself all call PAPER. */}
            <SummaryCard title="Paper evidence" scope={data.summary.paper} environment="PAPER" />
          </div>
          {/* D3: testnet, dry-run and unproven rows used to be counted in the
              real card. Each now has its own, and none is ever added to it. */}
          <p className="text-xs text-ink-faint">
            Testnet, dry-run and unknown-environment rows are kept apart here and never counted as real money.
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            <SummaryCard title="Testnet evidence" scope={data.summary.testnet} environment="TESTNET" />
            <SummaryCard title="Dry-run evidence" scope={data.summary.dryRun} environment="DRY_RUN" />
            <SummaryCard title="Unknown environment" scope={data.summary.unknownEnvironment} environment="UNKNOWN" />
          </div>
        </section>

        {(data.summary.byPeriod.length > 0 || data.summary.bySymbol.length > 0) && <div className="grid gap-3 lg:grid-cols-2">
          <Card><div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold text-ink">
            {period === "day" ? "Daily" : period === "week" ? "Weekly" : "Monthly"} realized outcomes
          </h2></div><div className="divide-y divide-border">
            {data.summary.byPeriod.slice(0, 12).map((item) => <div key={`${item.bucket}-${item.source}-${item.environment}`} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
              <span className="text-ink-muted">{item.bucket} · {item.source} · {ENVIRONMENT_LABEL[item.environment]}</span>
              <span className={`tabular ${item.summary.knownRealizedRows ? signClass(item.summary.knownRealizedPnl) : "text-ink-muted"}`}>
                {item.summary.knownRealizedRows ? money(item.summary.knownRealizedPnl) : "Unknown"}
              </span>
            </div>)}
          </div></Card>
          <Card><div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold text-ink">Per symbol</h2></div>
            <div className="divide-y divide-border">{data.summary.bySymbol.slice(0, 12).map((item) => <div key={`${item.symbol}-${item.source}-${item.environment}`} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
              <span className="text-ink-muted">{item.symbol} · {item.source} · {ENVIRONMENT_LABEL[item.environment]}</span>
              <span className={`tabular ${item.summary.knownRealizedRows ? signClass(item.summary.knownRealizedPnl) : "text-ink-muted"}`}>
                {item.summary.knownRealizedRows ? money(item.summary.knownRealizedPnl) : "Unknown"}
              </span>
            </div>)}</div>
          </Card>
        </div>}

        <details className="rounded-md border border-border bg-surface px-4 py-3 text-xs text-ink-muted">
          <summary className="cursor-pointer font-medium text-ink">Evidence limits</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">{data.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
      </>}
    </PageShell>
  );
}

/** An ordinary account is told this page is the administrator's; the page is not mounted. */
export default function JournalPage() {
  return <AdminOnlyPage title="Journal" width="narrow"><JournalView /></AdminOnlyPage>;
}
