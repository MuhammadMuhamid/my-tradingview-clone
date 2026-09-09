"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Card, Empty, Field, Select, TextInput } from "@/components/ui";
import {
  api, type JournalResponse, type JournalRow, type JournalSource,
  type JournalSummarySlice,
} from "@/lib/api";
import { fmtDateTime, fmtNum, fmtPrice, signClass, LOCAL_TIME_NOTE } from "@/lib/format";

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

function SummaryCard({ title, scope, paper = false }: {
  title: string; scope: JournalSummarySlice; paper?: boolean;
}) {
  const known = scope.knownRealizedRows > 0;
  return (
    <Card className={paper ? "border-warn/30" : ""}>
      <div className="p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
            paper ? sourceStyle.PAPER : "border-border bg-surface-2 text-ink-muted"
          }`}>{paper ? "PAPER" : "REAL"}</span>
        </div>
        <p className={`mt-2 font-mono text-2xl font-semibold ${known ? signClass(scope.knownRealizedPnl) : "text-ink-muted"}`}>
          {known ? money(scope.knownRealizedPnl) : "Unknown"}
        </p>
        <p className="mt-1 text-xs text-ink-faint">
          {paper ? "Known realized net" : "Known realized P&L"} · {scope.knownRealizedRows} known outcome{scope.knownRealizedRows === 1 ? "" : "s"}
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div><dt className="text-ink-faint">Known fees</dt><dd className="mt-0.5 font-mono text-ink">
            {scope.feeKnownRows > 0 ? `$${fmtNum(scope.knownFees)}` : "Unknown"}
          </dd></div>
          <div><dt className="text-ink-faint">Wins / losses</dt><dd className="mt-0.5 font-mono text-ink">
            {scope.wins} / {scope.losses}
          </dd></div>
          <div><dt className="text-ink-faint">Incomplete rows</dt><dd className="mt-0.5 font-mono text-ink">
            {scope.incompleteRows}
          </dd></div>
          <div><dt className="text-ink-faint">Average duration</dt><dd className="mt-0.5 font-mono text-ink">
            {duration(scope.averageDurationMs)}
          </dd></div>
        </dl>
      </div>
    </Card>
  );
}

function Metric({ label, value, unknown = false }: { label: string; value: string; unknown?: boolean }) {
  return <div><dt className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</dt>
    <dd className={`mt-0.5 font-mono text-xs ${unknown ? "text-ink-muted" : "text-ink"}`}>{value}</dd></div>;
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
          <p className={`font-mono text-base font-semibold ${pnlKnown ? signClass(row.realizedPnl) : "text-ink-muted"}`}>
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

export default function JournalPage() {
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
    <div className="mx-auto max-w-[1200px] space-y-4 px-3 py-4 sm:px-4">
      <header>
        <h1 className="text-lg font-semibold text-ink">Journal</h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-5 text-ink-faint">
          What happened, newest first — manual orders, automated signals and paper fills, with the fill,
          the position and the result where the record proves them. The sums beneath are known realized
          performance from persisted evidence; Timeline explains what happened to one order. Unknown economics stay unknown.
        </p>
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
          <Button type="submit" variant="primary" disabled={loading} className="min-h-11">
            {loading ? "Loading…" : "Apply"}
          </Button>
        </form>
      </Card>

      {error && <div role="alert" className="rounded-md border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{error}</div>}
      {loading && !data && <div role="status" className="rounded-md border border-border bg-surface px-4 py-10 text-center text-sm text-ink-muted">Loading Journal evidence…</div>}

      {data && <>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div><h2 className="text-sm font-semibold text-ink">Activity & realizations</h2>
              <p className="mt-0.5 text-xs text-ink-faint">Newest first · {data.summary.incompleteRows} incomplete evidence row{data.summary.incompleteRows === 1 ? "" : "s"}</p></div>
            {data.summary.truncated && <span className="rounded-full border border-warn/30 bg-warn/10 px-2 py-1 text-xs text-warn">Summary bound reached</span>}
          </div>
          {data.rows.length === 0 ? <Empty>No authoritative Journal evidence matches this range.</Empty>
            : <div>{data.rows.map((row) => <JournalItem key={row.id} row={row} />)}</div>}
          <div className="flex items-center justify-between border-t border-border px-3 py-2 sm:px-4">
            <Button variant="ghost" disabled={loading || page <= 1} onClick={() => void load(page - 1)} className="min-h-11">Previous</Button>
            <span className="text-xs text-ink-faint">Page {page}</span>
            <Button variant="ghost" disabled={loading || !data.page.hasNext} onClick={() => void load(page + 1)} className="min-h-11">Next</Button>
          </div>
        </Card>

        <section aria-label="Known realized summaries" className="grid gap-3 sm:grid-cols-2">
          <SummaryCard title="Real money evidence" scope={data.summary.real} />
          {/* "Simulation" was this card's own word for what its badge, its
              filter option and the delivery mode itself all call PAPER. */}
          <SummaryCard title="Paper evidence" scope={data.summary.paper} paper />
        </section>

        {(data.summary.byPeriod.length > 0 || data.summary.bySymbol.length > 0) && <div className="grid gap-3 lg:grid-cols-2">
          <Card><div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold text-ink">
            {period === "day" ? "Daily" : period === "week" ? "Weekly" : "Monthly"} realized outcomes
          </h2></div><div className="divide-y divide-border">
            {data.summary.byPeriod.slice(0, 12).map((item) => <div key={`${item.bucket}-${item.source}`} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
              <span className="text-ink-muted">{item.bucket} · {item.source}</span>
              <span className={`font-mono ${item.summary.knownRealizedRows ? signClass(item.summary.knownRealizedPnl) : "text-ink-muted"}`}>
                {item.summary.knownRealizedRows ? money(item.summary.knownRealizedPnl) : "Unknown"}
              </span>
            </div>)}
          </div></Card>
          <Card><div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold text-ink">Per symbol</h2></div>
            <div className="divide-y divide-border">{data.summary.bySymbol.slice(0, 12).map((item) => <div key={`${item.symbol}-${item.source}`} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
              <span className="text-ink-muted">{item.symbol} · {item.source}</span>
              <span className={`font-mono ${item.summary.knownRealizedRows ? signClass(item.summary.knownRealizedPnl) : "text-ink-muted"}`}>
                {item.summary.knownRealizedRows ? money(item.summary.knownRealizedPnl) : "Unknown"}
              </span>
            </div>)}</div>
          </Card>
        </div>}

        <details className="rounded-lg border border-border bg-surface px-4 py-3 text-xs text-ink-muted">
          <summary className="cursor-pointer font-medium text-ink">Evidence limits</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">{data.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
      </>}
    </div>
  );
}
