"use client";
import { useState } from "react";
import { Card, CardHeader, Button, Field, TextInput, Select } from "@/components/ui";
import { ParamForm } from "@/components/ParamForm";
import { api } from "@/lib/api";
import { defaultParams } from "@/lib/paramSchema";
import type { Interval, StrategyParams, SymbolInfo } from "@/lib/types";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h"];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

export function BacktestForm({
  symbols, onQueued,
}: {
  symbols: SymbolInfo[];
  onQueued: (id: string) => void;
}) {
  const [symbol, setSymbol] = useState(symbols[0]?.symbol ?? "SOLUSDT");
  const [timeframe, setTimeframe] = useState<Interval>("5m");
  const [start, setStart] = useState(isoDaysAgo(30));
  const [end, setEnd] = useState(isoDaysAgo(0));
  const [capital, setCapital] = useState(1000);
  const [params, setParams] = useState<StrategyParams>(defaultParams());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const bt = await api.createBacktest({
        strategyKey: "ma_rr_v9",
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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Symbol">
            <Select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {symbols.map((s) => <option key={s.symbol} value={s.symbol}>{s.symbol}</option>)}
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

        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">Strategy parameters</div>
          <ParamForm value={params} onChange={setParams} />
        </div>

        {err && <div className="rounded-md border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{err}</div>}

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Queuing…" : "Run backtest"}
          </Button>
          <span className="text-xs text-ink-faint">
            Data is auto-fetched from Binance if not cached — first run on a new range may take a moment.
          </span>
        </div>
      </div>
    </Card>
  );
}
