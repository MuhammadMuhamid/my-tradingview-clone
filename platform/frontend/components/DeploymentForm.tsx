"use client";
import { useState } from "react";
import { Card, CardHeader, Button, Field, TextInput, Select } from "@/components/ui";
import { ParamForm } from "@/components/ParamForm";
import { api } from "@/lib/api";
import { defaultParams } from "@/lib/paramSchema";
import type { DeliveryMode, Interval, StrategyParams, SymbolInfo } from "@/lib/types";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h"];

export function DeploymentForm({
  symbols, onCreated,
}: {
  symbols: SymbolInfo[];
  onCreated: () => void;
}) {
  const [symbol, setSymbol] = useState(symbols[0]?.symbol ?? "SOLUSDT");
  const [timeframe, setTimeframe] = useState<Interval>("5m");
  const [delivery, setDelivery] = useState<DeliveryMode>("custom");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [botUuid, setBotUuid] = useState("");
  const [buyQuoteQty, setBuyQuoteQty] = useState(800);
  const [params, setParams] = useState<StrategyParams>(defaultParams());
  const [showParams, setShowParams] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.createDeployment({
        strategyKey: "ma_rr_v9",
        symbol, timeframe, params, delivery,
        webhookUrl: delivery === "off" ? undefined : webhookUrl || undefined,
        secret: secret || undefined,
        botUuid: delivery === "3commas" ? botUuid || undefined : undefined,
        buyQuoteQty,
      });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="New live deployment" />
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
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
          <Field label="Delivery" help="How signals reach your bot">
            <Select value={delivery} onChange={(e) => setDelivery(e.target.value as DeliveryMode)}>
              <option value="custom">Custom bot (FastAPI)</option>
              <option value="3commas">3Commas Signal bot</option>
              <option value="off">Off (dry run — log only)</option>
            </Select>
          </Field>
          <Field label="Buy size (quote USDT)">
            <TextInput type="number" value={buyQuoteQty} onChange={(e) => setBuyQuoteQty(parseFloat(e.target.value || "0"))} />
          </Field>
        </div>

        {delivery !== "off" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={delivery === "3commas" ? "3Commas webhook URL" : "Bot webhook URL"} help={delivery === "3commas" ? "leave blank for the default 3Commas signal endpoint" : "your FastAPI bot endpoint"}>
              <TextInput value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder={delivery === "3commas" ? "https://api.3commas.io/signal_bots/webhooks" : "http://your-bot/webhook"} />
            </Field>
            <Field label="Secret">
              <TextInput value={secret} onChange={(e) => setSecret(e.target.value)}
                placeholder="bot webhook secret" type="password" autoComplete="off" autoCorrect="off" spellCheck={false} data-1p-ignore />
            </Field>
            {delivery === "3commas" && (
              <Field label="Bot UUID">
                <TextInput value={botUuid} onChange={(e) => setBotUuid(e.target.value)} placeholder="3Commas signal bot uuid" />
              </Field>
            )}
          </div>
        )}

        <div>
          <button onClick={() => setShowParams((s) => !s)} className="text-xs font-medium uppercase tracking-wide text-ink-faint hover:text-ink">
            {showParams ? "− Hide" : "+ Configure"} strategy parameters
          </button>
          {showParams && <div className="mt-2"><ParamForm value={params} onChange={setParams} /></div>}
        </div>

        {err && <div className="rounded-md border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{err}</div>}

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create deployment"}</Button>
          <span className="text-xs text-ink-faint">Created paused. Activate it to start streaming and firing alerts.</span>
        </div>
      </div>
    </Card>
  );
}
