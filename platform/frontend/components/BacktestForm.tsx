"use client";
import { useState } from "react";
import { Card, CardHeader, Button, Field, TextInput, Select } from "@/components/ui";
import { ParamForm } from "@/components/ParamForm";
import { ApiError, api } from "@/lib/api";
import { describeAction, said, type FailureCopy } from "@/lib/errorCopy";
import { defaultParamsFor } from "@/lib/paramSchema";
import {
  DEFAULT_VALIDATION_FRACTION, RUN_LIMITS, VALIDATION_FRACTIONS, orderSizeHint, runFormProblem, strategyFor,
} from "@/lib/backtestFigures";
import type { Backtest, Interval, Strategy, StrategyParams, SymbolInfo } from "@/lib/types";
import { displaySymbol } from "@/lib/instrument";
import { researchAssumptions } from "@/lib/workstation";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h"];

/** The engine's defaults when a request states none — `backend/src/api/routes/backtests.ts`. */
const DEFAULT_COMMISSION_PCT = 0.1;
const DEFAULT_SLIPPAGE_TICKS = 2;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

export function BacktestForm({
  symbols, strategies, onQueued, preset = null,
}: {
  symbols: SymbolInfo[];
  /** Every strategy the engine can actually run, from its own registry. */
  strategies: Strategy[];
  onQueued: (id: string) => void;
  /**
   * A finished (or failed) run whose settings fill the form — "Edit and
   * re-run" on a result page. The caller remounts the form when it changes.
   */
  preset?: Backtest | null;
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
  const [strategyKey, setStrategyKey] = useState(
    (preset && strategyFor(preset, strategies)?.key) ?? "ma_rr_v9");
  const [symbol, setSymbol] = useState(preset?.symbol ?? symbols[0]?.symbol ?? "SOLUSDT");
  const [timeframe, setTimeframe] = useState<Interval>(preset?.timeframe ?? "5m");
  const [start, setStart] = useState(preset ? preset.startTime.slice(0, 10) : isoDaysAgo(30));
  const [end, setEnd] = useState(preset ? preset.endTime.slice(0, 10) : isoDaysAgo(0));
  const [capital, setCapital] = useState(preset?.initialCapital ?? 1000);
  const [commissionPct, setCommissionPct] = useState(preset?.commissionPct ?? DEFAULT_COMMISSION_PCT);
  const [slippageTicks, setSlippageTicks] = useState(preset?.slippageTicks ?? DEFAULT_SLIPPAGE_TICKS);
  /*
   * How much of the range is the validation window. The API has accepted
   * `holdoutFraction` all along and nothing on this page could set it, so
   * every quick run was silently cut at the engine's 20 %.
   */
  const [validation, setValidation] = useState(preset?.holdoutFraction ?? DEFAULT_VALIDATION_FRACTION);
  // A preset carries the run's own parameter snapshot, keys the form does not
  // render included; they ride through to the request untouched.
  const [params, setParams] = useState<StrategyParams>(
    preset ? { ...preset.params } : defaultParamsFor((preset && strategyFor(preset, strategies)?.key) ?? "ma_rr_v9"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FailureCopy | null>(null);

  const submit = async () => {
    /*
     * The server refuses these too; saying so here costs no round trip and
     * reads the parameter schema's own min/max, which the number inputs
     * carried as attributes and nothing ever checked.
     */
    const problem = runFormProblem({ capital, commissionPct, slippageTicks, start, end, params, strategyKey }, Date.now());
    if (problem) { setErr(said(problem)); return; }
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
        commissionPct,
        slippageTicks,
        holdoutFraction: validation,
      });
      onQueued(bt.id);
    } catch (e) {
      // A 400 here is this API describing the request in its own words —
      // "Initial capital must be a number greater than 0." — which is the
      // sentence the reader needs. Anything else is a cause for the tooltip.
      setErr(e instanceof ApiError && e.status === 400
        ? { headline: `The backtest could not be queued. ${e.detail}`, detail: e.detail }
        : describeAction(e, "queue the backtest"));
    } finally {
      setBusy(false);
    }
  };

  const num = (raw: string): number => (raw.trim() === "" ? Number.NaN : Number(raw));
  const hint = orderSizeHint(params, capital, strategyKey);

  return (
    <Card>
      <CardHeader title={preset ? "New backtest — from an earlier run's settings" : "New backtest"} />
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
              {/* A preset's symbol stays choosable even if the list has not arrived. */}
              {!symbols.some((s) => s.symbol === symbol) && <option value={symbol}>{symbol}</option>}
              {symbols.map((s) => <option key={s.symbol} value={s.symbol}>{displaySymbol(s.canonicalId ?? s.symbol)}</option>)}
            </Select>
          </Field>
          <Field label="Timeframe">
            <Select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Interval)}>
              {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
            </Select>
          </Field>
          <Field label="Start date">
            <TextInput type="date" value={start} max={isoDaysAgo(1)} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="End date">
            <TextInput type="date" value={end} max={isoDaysAgo(0)} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Initial capital">
            <TextInput type="number" min={1} step="any" value={Number.isFinite(capital) ? capital : ""}
              onChange={(e) => setCapital(num(e.target.value))} />
          </Field>
          <Field label="Commission % per fill">
            <TextInput type="number" min={0} max={RUN_LIMITS.maxCommissionPct} step={0.01}
              value={Number.isFinite(commissionPct) ? commissionPct : ""}
              onChange={(e) => setCommissionPct(num(e.target.value))} />
          </Field>
          <Field label="Slippage (ticks)">
            <TextInput type="number" min={0} max={RUN_LIMITS.maxSlippageTicks} step={1}
              value={Number.isFinite(slippageTicks) ? slippageTicks : ""}
              onChange={(e) => setSlippageTicks(num(e.target.value))} />
          </Field>
          <Field label="Validation window" help="The last part of the range, scored on its own.">
            <Select value={String(validation)} onChange={(e) => setValidation(Number(e.target.value))}>
              {!VALIDATION_FRACTIONS.some((f) => f === validation) && (
                <option value={String(validation)}>Last {Math.round(validation * 100)}%</option>
              )}
              {VALIDATION_FRACTIONS.map((f) => (
                <option key={f} value={String(f)}>Last {Math.round(f * 100)}%</option>
              ))}
            </Select>
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
            {preset ? "Strategy parameters — the earlier run's values" : "Strategy parameters — defaults apply unless changed"}
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

        {/* C-09: affordable once, perhaps not after a loss — said before running. */}
        {hint && (
          <p data-order-size-hint className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            {hint}
          </p>
        )}

        {/* REV-UX-01: the cause is the tooltip; the sentence is the reader's. */}
        {err && <div role="alert" title={err.detail || undefined} className="rounded-md border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">
          {err.headline}
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
