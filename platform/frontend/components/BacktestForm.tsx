"use client";
import { useState } from "react";
import { Card, CardHeader, Button, Field, TextInput, Select } from "@/components/ui";
import { ParamForm } from "@/components/ParamForm";
import { api } from "@/lib/api";
import { shortReason } from "@/lib/errorCopy";
import { defaultParamsFor } from "@/lib/paramSchema";
import type { Interval, Strategy, StrategyParams, SymbolInfo } from "@/lib/types";
import { displaySymbol } from "@/lib/instrument";
import { researchAssumptions } from "@/lib/workstation";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h"];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

export function BacktestForm({
  symbols, strategies, onQueued,
}: {
  symbols: SymbolInfo[];
  /** Every strategy the engine can actually run, from its own registry. */
  strategies: Strategy[];
  onQueued: (id: string) => void;
}) {
  /*
   * The strategy was hard-coded to `ma_rr_v9`, and that strategy's shipped
   * defaults take no trade in any market over any window: `signals.ts` builds
   * `frameworkLongOk = priActive && priFired && fltPass`, and `priActive` only
   * becomes true when a signal family is both enabled and marked primary — all
   * six default to neither. So this page's primary action returned an
   * unexplained "0 trades" out of the box, every time, while two other
   * registered strategies trade with their defaults and could not be reached
   * from here at all.
   */
  const [strategyKey, setStrategyKey] = useState("ma_rr_v9");
  const [symbol, setSymbol] = useState(symbols[0]?.symbol ?? "SOLUSDT");
  const [timeframe, setTimeframe] = useState<Interval>("5m");
  const [start, setStart] = useState(isoDaysAgo(30));
  const [end, setEnd] = useState(isoDaysAgo(0));
  const [capital, setCapital] = useState(1000);
  const [params, setParams] = useState<StrategyParams>(defaultParamsFor("ma_rr_v9"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const bt = await api.createBacktest({
        strategyKey,
        symbol,
        timeframe,
        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),
        params,
        initialCapital: capital,
      });
      onQueued(bt.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="New backtest" />
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Strategy">
            {/*
              Re-seed the draft when the strategy changes. Carrying the previous
              strategy's values across looks harmless — the form redraws — but
              the keys the two schemas SHARE keep the old strategy's numbers,
              which is how `mtf_lean` ran with `ma_rr_v9`'s risk/reward.
              `app/chart/page.tsx` already switches this way.
            */}
            <Select
              value={strategyKey}
              onChange={(e) => {
                const next = e.target.value;
                setStrategyKey(next);
                setParams(defaultParamsFor(next));
              }}
            >
              {strategies.length === 0
                ? <option value={strategyKey}>Loading…</option>
                : strategies.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Symbol">
            <Select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {symbols.map((s) => <option key={s.symbol} value={s.symbol}>{displaySymbol(s.canonicalId ?? s.symbol)}</option>)}
            </Select>
          </Field>
          <Field label="Timeframe">
            <Select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Interval)}>
              {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
            </Select>
          </Field>
          <Field label="Start date">
            <TextInput type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="End date">
            <TextInput type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Initial capital">
            <TextInput type="number" value={capital} onChange={(e) => setCapital(parseFloat(e.target.value || "0"))} />
          </Field>
        </div>

        {/*
          The full parameter tree is the strategy's, not the everyday test's.
          A quick historical test runs with the strategy's defaults; the tree
          is there for the person who wants to change one thing before running,
          and the Backtester application is where parameter spaces, optimizers
          and walk-forward research live.
        */}
        <details className="group rounded-md border border-border/70">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-faint hover:text-ink">
            Strategy parameters — defaults apply unless changed
          </summary>
          <div className="border-t border-border/70 p-3">
            <ParamForm strategyKey={strategyKey} value={params} onChange={setParams} />
          </div>
        </details>

        <section aria-label="Research assumptions" className="rounded-md border border-border bg-surface-2/40 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Run assumptions</p>
          <p className="mt-1 text-xs leading-5 text-ink">
            {researchAssumptions(symbol).join(" · ")}
          </p>
          <p className="mt-1 text-[11px] text-ink-faint">Unsupported session, adjustment, funding, roll or execution semantics fail before a run is queued.</p>
        </section>

        {/* REV-UX-01: the cause is the tooltip; the sentence is the reader's. */}
        {err && <div title={err} className="rounded-md border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">
          The backtest could not be queued. {shortReason(err)}
        </div>}

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Queuing…" : "Run backtest"}
          </Button>
          <span className="text-xs text-ink-faint">
            Provider data is fetched through the instrument contract when supported; a new range may take a moment.
          </span>
        </div>
      </div>
    </Card>
  );
}
