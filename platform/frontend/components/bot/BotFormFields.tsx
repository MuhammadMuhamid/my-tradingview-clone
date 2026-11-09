"use client";
/**
 * Every field of a bot, as the Classic dashboard's form has them: alert type,
 * name, exchange account (with its free USDT), direction, pairs, investment
 * and its unit, the open-trade cap, entries, volume, order type, exits, take
 * profit, stop loss, and the per-pair entry-order cap.
 *
 * Adapted from the standalone Bot dashboard's `BotFormFields`
 * (bot/frontend/src/components/BotFormFields.tsx), restyled onto the Platform's
 * primitives, controlled from outside (the page owns the data), and with the
 * stale copy corrected: direct TradingView BUY alerts are disabled on the Bot,
 * limit entries are never executed, and the stop loss is checked by the Bot
 * while it runs (not a resting exchange order).
 */
import { useId, useState, type ReactNode } from "react";
import { Card, CardHeader, Checkbox, Field, Notice, Select, TextInput } from "@/components/ui";
import type { AccountBalance, ExchangeAccountView, InvestmentUnit } from "@/lib/botManageApi";
import {
  INVESTMENT_UNIT_LABELS, PAIRS, PAIR_RE, investmentEstimate, normalizePair, type BotFormState, type FormErrors,
} from "./botForm";
import type { Loaded } from "./useAccounts";

function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return <span id={id} className="text-xs text-down">{text}</span>;
}

function Toggle({ checked, onChange, label, help, disabled }: {
  checked: boolean; onChange: (next: boolean) => void; label: string; help?: ReactNode; disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2.5 text-sm text-ink">
      <span className="mt-0.5"><Checkbox checked={checked} onChange={onChange} label={label} disabled={disabled} /></span>
      <span><span className="font-medium">{label}</span>{help && <span className="block text-xs text-ink-faint">{help}</span>}</span>
    </label>
  );
}

function NumberInput({ value, onChange, invalid, describedBy, className = "w-32", ...rest }: {
  value: string; onChange: (text: string) => void; invalid: boolean; describedBy?: string; className?: string;
  min?: number; max?: number; step?: number | "any";
}) {
  return <TextInput type="number" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)}
    aria-invalid={invalid || undefined} aria-describedby={invalid ? describedBy : undefined}
    className={`${className} tabular`} {...rest} />;
}

export interface BotFormProps {
  form: BotFormState;
  onChange: (next: BotFormState) => void;
  /** Shown only once the operator has tried to save. */
  errors: FormErrors;
  showErrors: boolean;
  accounts: Loaded<ExchangeAccountView[]>;
  /** The account the bot has now, kept selectable even when the list could not be read. */
  currentAccount?: { id: string; name: string; testnet: boolean } | null;
  balance: Loaded<AccountBalance>;
  /** Pairs the bot already has: not re-judged (the Bot keeps them editable). */
  keptPairs?: string[];
  disabled?: boolean;
}

export function BotForm({ form, onChange, errors, showErrors, accounts, currentAccount = null, balance, keptPairs = [],
  disabled = false }: BotFormProps) {
  const ids = useId();
  const id = (name: string) => `${ids}-${name}`;
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const set = <K extends keyof BotFormState>(key: K, value: BotFormState[K]) => onChange({ ...form, [key]: value });
  const err = (key: keyof FormErrors) => (showErrors ? errors[key] : undefined);
  const usdtFree = balance.state === "ok" ? balance.data.usdtFree : null;

  const togglePair = (pair: string) =>
    set("pairs", form.pairs.includes(pair) ? form.pairs.filter((p) => p !== pair) : [...form.pairs, pair]);
  const addCustom = () => {
    const pair = normalizePair(custom);
    if (!pair) return;
    if (!PAIR_RE.test(pair)) { setCustomError("A Binance Spot symbol quoted in USDT or USDC, e.g. WIFUSDT."); return; }
    setCustomError(null);
    if (!form.pairs.includes(pair)) set("pairs", [...form.pairs, pair]);
    setCustom("");
  };

  const accountOptions: { id: string; name: string; testnet: boolean }[] =
    accounts.state === "ok" ? accounts.data : currentAccount ? [currentAccount] : [];

  return (
    <fieldset disabled={disabled} className="space-y-4">
      <legend className="sr-only">Bot settings</legend>
      {/* ── main ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Main" />
        <div className="space-y-4 px-4 py-3">
          <div role="radiogroup" aria-label="Alert type" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {([["custom", "Custom signal", "Any signal source posting webhook JSON. Trading Scene deployments use this."],
              ["tradingview", "TradingView strategy", "TradingView alerts. Direct TradingView BUY alerts are disabled on the Bot; its exit alerts work."]] as const)
              .map(([value, title, desc]) => (
                <button key={value} type="button" role="radio" aria-checked={form.alertType === value} onClick={() => set("alertType", value)}
                  className={`tvc-control rounded-md border p-3 text-left ${form.alertType === value
                    ? "border-[var(--ts-menu-selected-bg)] bg-surface-2" : "border-control-border"}`}>
                  <span className="block text-sm font-medium text-ink">{title}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">{desc}</span>
                </button>
              ))}
          </div>
          <Field label="Bot name">
            <TextInput value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} placeholder="e.g. NEAR/TIA Spot Bot"
              aria-invalid={!!err("name") || undefined} aria-describedby={err("name") ? id("name") : undefined} className="w-full" />
            <FieldError id={id("name")} text={err("name")} />
          </Field>
          <Field label="Exchange account">
            <Select value={form.exchangeAccountId} onChange={(e) => set("exchangeAccountId", e.target.value)} className="w-full">
              <option value="">No account (add one under Exchange accounts)</option>
              {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.name} · Binance Spot ({a.testnet ? "testnet" : "MAINNET"})</option>)}
            </Select>
            {accounts.state === "error" && <span className="text-xs text-warn">The account list could not be read from the Bot.</span>}
            {form.exchangeAccountId && <span className="text-xs text-ink-muted" aria-live="polite">
              {balance.state === "loading" ? "Fetching balance…"
                : balance.state === "ok" ? `Available: ${balance.data.usdtFree.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT`
                  : balance.state === "error" ? "Could not fetch the balance." : ""}
            </span>}
          </Field>
          <div>
            <span className="text-xs font-medium text-ink-muted">Direction</span>
            <p className="text-sm text-ink">Long (spot). Shorts are not implemented on the Bot.</p>
          </div>
          <div>
            <span id={id("pairs-label")} className="text-xs font-medium text-ink-muted">Trading pairs</span>
            <div role="group" aria-labelledby={id("pairs-label")} className="mt-1 flex flex-wrap gap-1.5">
              {PAIRS.map((pair) => (
                <button key={pair} type="button" aria-pressed={form.pairs.includes(pair)} onClick={() => togglePair(pair)}
                  className={`tvc-control h-[30px] rounded-md border px-2 text-xs font-medium ${form.pairs.includes(pair)
                    ? "border-transparent bg-[var(--ts-menu-selected-bg)] text-[var(--ts-menu-selected-ink)]"
                    : "border-control-border text-ink-muted"}`}>{pair}</button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-start gap-2">
              <TextInput value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Another pair, e.g. WIFUSDT"
                aria-label="Add a pair" className="w-48"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }} />
              <button type="button" onClick={addCustom} className="tvc-control h-[34px] rounded-md border border-control-border px-3 text-sm text-ink">Add</button>
            </div>
            {customError && <span className="block text-xs text-down">{customError}</span>}
            {form.pairs.filter((p) => !PAIRS.includes(p)).length > 0 && <ul aria-label="Other pairs" className="mt-2 flex flex-wrap gap-1.5">
              {form.pairs.filter((p) => !PAIRS.includes(p)).map((pair) => (
                <li key={pair} className="inline-flex items-center gap-1 rounded-md border border-control-border px-2 py-0.5 text-xs text-ink">
                  {pair}{keptPairs.includes(pair) && !PAIR_RE.test(pair) ? " (kept)" : ""}
                  <button type="button" aria-label={`Remove ${pair}`} onClick={() => togglePair(pair)} className="text-ink-muted hover:text-ink">×</button>
                </li>
              ))}
            </ul>}
            <span className="block text-xs text-ink-faint">{form.pairs.length} selected</span>
            <FieldError id={id("pairs")} text={err("pairs")} />
          </div>
        </div>
      </Card>

      {/* ── investment ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Investment" />
        <div className="space-y-4 px-4 py-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Max investment">
              <NumberInput value={form.maxInvestmentPct} onChange={(v) => set("maxInvestmentPct", v)} min={0.01} step="any"
                invalid={!!err("maxInvestmentPct")} describedBy={id("invest")} />
            </Field>
            <Field label="Unit">
              <Select value={form.maxInvestmentUnit} onChange={(e) => set("maxInvestmentUnit", e.target.value as InvestmentUnit)}>
                {(Object.keys(INVESTMENT_UNIT_LABELS) as InvestmentUnit[]).map((u) => <option key={u} value={u}>{INVESTMENT_UNIT_LABELS[u]}</option>)}
              </Select>
            </Field>
          </div>
          <FieldError id={id("invest")} text={err("maxInvestmentPct")} />
          {investmentEstimate(form, usdtFree) && <p className="text-xs text-ink-muted">{investmentEstimate(form, usdtFree)}</p>}
          <Toggle checked={form.maxActiveSmartTradesEnabled} onChange={(v) => set("maxActiveSmartTradesEnabled", v)}
            label="Cap concurrent trades" help="Limit how many open trades this bot can have at once." />
          {form.maxActiveSmartTradesEnabled && <Field label="Max open trades" help="e.g. 2 = at most 2 open trades at once">
            <NumberInput value={form.maxActiveSmartTrades} onChange={(v) => set("maxActiveSmartTrades", v)} min={1} step={1}
              invalid={!!err("maxActiveSmartTrades")} describedBy={id("cap")} />
            <FieldError id={id("cap")} text={err("maxActiveSmartTrades")} />
          </Field>}
        </div>
      </Card>

      {/* ── orders ───────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Orders and protection" />
        <div className="space-y-4 px-4 py-3">
          <Toggle checked={form.entryEnabled} onChange={(v) => set("entryEnabled", v)} label="Entry orders"
            help="Allow BUY signals (Trading Scene deployments, webhooks) to open new positions." />
          {form.entryEnabled && <div className="space-y-3 pl-7">
            <Field label="Volume per order (%)" help="Share of the max investment each entry uses (default 100).">
              <NumberInput value={form.entryVolumePct} onChange={(v) => set("entryVolumePct", v)} min={1} max={100} step="any"
                invalid={!!err("entryVolumePct")} describedBy={id("volume")} />
              <FieldError id={id("volume")} text={err("entryVolumePct")} />
            </Field>
            <div>
              <span className="text-xs font-medium text-ink-muted">Order type</span>
              <p className="text-sm text-ink">Market</p>
              {form.entryOrderType === "limit"
                ? <span className="text-xs text-warn">This bot has &quot;limit&quot; stored. Limit entries are never executed; it stays as it is until changed on the Bot.</span>
                : <span className="text-xs text-ink-faint">Limit entries are not implemented on the Bot.</span>}
            </div>
            <Field label="Max entry orders per pair" help="Leave empty for no limit.">
              <NumberInput value={form.maxEntryOrders} onChange={(v) => set("maxEntryOrders", v)} min={1} step={1}
                invalid={!!err("maxEntryOrders")} describedBy={id("entries")} />
              <FieldError id={id("entries")} text={err("maxEntryOrders")} />
            </Field>
          </div>}
          <Toggle checked={form.exitEnabled} onChange={(v) => set("exitEnabled", v)} label="Exit orders"
            help="Allow SELL signals to close positions." />
          <Toggle checked={form.takeProfitEnabled} onChange={(v) => set("takeProfitEnabled", v)} label="Take profit"
            help="Close when the trade's P&L reaches this percentage." />
          {form.takeProfitEnabled && <Field label="Take profit (%)" help="e.g. 3 = close when P&L ≥ +3%">
            <NumberInput value={form.takeProfitPct} onChange={(v) => set("takeProfitPct", v)} min={0.1} step="any"
              invalid={!!err("takeProfitPct")} describedBy={id("tp")} />
            <FieldError id={id("tp")} text={err("takeProfitPct")} />
          </Field>}
          <Toggle checked={form.stopLossEnabled} onChange={(v) => set("stopLossEnabled", v)} label="Stop loss"
            help="Checked by the Bot about every 30 seconds while it runs. It is not a resting order at the exchange: while the Bot is down or halted, it is not checked." />
          {form.stopLossEnabled && <Field label="Stop loss (%)" help="e.g. 3 = close when P&L ≤ −3%">
            <NumberInput value={form.stopLossPct} onChange={(v) => set("stopLossPct", v)} min={0.1} step="any"
              invalid={!!err("stopLossPct")} describedBy={id("sl")} />
            <FieldError id={id("sl")} text={err("stopLossPct")} />
          </Field>}
          {!form.stopLossEnabled && <Notice tone="warn">No stop loss: a position has no automated loss exit.</Notice>}
          {errors.form && <Notice tone="error" role="alert">{errors.form}</Notice>}
        </div>
      </Card>
    </fieldset>
  );
}
