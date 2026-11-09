"use client";
/**
 * The Bot's risk limits (C3 read, C4 change), with their units and bounds.
 *
 * Two facts are said every time, because both have surprised operators:
 * changing a limit never clears a halt that is already latched, and turning
 * the daily-loss limit off (or raising it) is what makes a latched daily-loss
 * halt resumable (contract Adv / Fable 13).
 */
import { useState } from "react";
import { Button, Card, CardHeader, Field, Notice, TextInput } from "@/components/ui";
import type { BotCredential, BotRiskLimitsView, BotRiskView } from "@/lib/api";
import { signClass } from "@/lib/format";
import { LATCH_NOTE, LOSS_LIMIT_WARNING, countedLoss, signedUsdt } from "./botCopy";
import type { DialogResult } from "./commandRunner";
import { StepUpDialog } from "./StepUpDialog";

const usd = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT`;

type Draft = Record<keyof BotRiskLimitsView, string>;
const toDraft = (limits: BotRiskLimitsView): Draft => ({
  maxTotalExposureQuote: limits.maxTotalExposureQuote === null ? "" : String(limits.maxTotalExposureQuote),
  maxConcurrentTrades: limits.maxConcurrentTrades === null ? "" : String(limits.maxConcurrentTrades),
  maxDailyLossQuote: limits.maxDailyLossQuote === null ? "" : String(limits.maxDailyLossQuote),
  dailyLossWindowHours: String(limits.dailyLossWindowHours),
});

/** The changed fields, or the first problem. Empty means "no limit" (except the window). */
export function riskPatch(limits: BotRiskLimitsView, draft: Draft):
  { patch: Partial<BotRiskLimitsView> } | { error: string } {
  const patch: Partial<BotRiskLimitsView> = {};
  const nullable = (key: "maxTotalExposureQuote" | "maxConcurrentTrades" | "maxDailyLossQuote", integer: boolean, name: string) => {
    const raw = draft[key].trim();
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value)))) {
      return `${name} must be ${integer ? "a whole number" : "a number"} of 0 or more, or empty for no limit.`;
    }
    if (value !== limits[key]) patch[key] = value;
    return null;
  };
  const problem = nullable("maxTotalExposureQuote", false, "Max total exposure")
    ?? nullable("maxConcurrentTrades", true, "Max open trades")
    ?? nullable("maxDailyLossQuote", false, "Daily-loss limit");
  if (problem) return { error: problem };
  const hours = Number(draft.dailyLossWindowHours.trim());
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) return { error: "The daily-loss window is a whole number of hours from 1 to 720." };
  if (hours !== limits.dailyLossWindowHours) patch.dailyLossWindowHours = hours;
  return { patch };
}

export function RiskLimitsCard({ risk, disabled, disabledReason, onSubmit }: {
  risk: BotRiskView | null;
  disabled: boolean;
  disabledReason?: string;
  onSubmit: (patch: Partial<BotRiskLimitsView>, credential: BotCredential) => Promise<DialogResult>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const checked = risk && draft ? riskPatch(risk.limits, draft) : null;
  const patch = checked && "patch" in checked ? checked.patch : null;
  const changed = patch !== null && Object.keys(patch).length > 0;
  const loosensLoss = !!risk && !!patch && "maxDailyLossQuote" in patch
    && (patch.maxDailyLossQuote === null
      || (risk.limits.maxDailyLossQuote !== null && (patch.maxDailyLossQuote ?? 0) > risk.limits.maxDailyLossQuote));

  const field = (key: keyof Draft, label: string, unit: string, help: string) => (
    <Field label={`${label} (${unit})`} help={help}>
      <TextInput type="number" inputMode="decimal" min={key === "dailyLossWindowHours" ? 1 : 0}
        max={key === "dailyLossWindowHours" ? 720 : undefined}
        step={key === "maxConcurrentTrades" || key === "dailyLossWindowHours" ? 1 : "any"}
        value={draft?.[key] ?? ""} className="w-40 tabular"
        onChange={(e) => setDraft((d) => d && { ...d, [key]: e.target.value })} />
    </Field>
  );

  return (
    <Card>
      <CardHeader title="Risk limits" right={
        <Button disabled={disabled || !risk} title={disabled ? disabledReason : undefined}
          onClick={() => risk && setDraft(toDraft(risk.limits))}>Edit limits…</Button>
      } />
      <div className="space-y-2 px-4 py-3">
        {!risk ? <p className="text-sm text-ink-faint">The Bot's limits could not be read.</p> : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-ink-muted">Total exposure (incl. pending entries)</dt>
              <dd className="tabular text-ink">{usd(risk.snapshot.openExposureQuote)} of {risk.limits.maxTotalExposureQuote === null ? "no limit" : usd(risk.limits.maxTotalExposureQuote)}</dd></div>
            <div><dt className="text-xs text-ink-muted">Open trades (incl. pending entries)</dt>
              <dd className="tabular text-ink">{risk.snapshot.openTrades} of {risk.limits.maxConcurrentTrades ?? "no limit"}</dd></div>
            <div><dt className="text-xs text-ink-muted">Daily loss counted by the limit (rolling {risk.limits.dailyLossWindowHours} h)</dt>
              <dd className="tabular text-ink">{usd(countedLoss(risk.snapshot.realisedPnlInWindow))} of {risk.limits.maxDailyLossQuote === null ? "no limit (off)" : usd(risk.limits.maxDailyLossQuote)}</dd></div>
            <div><dt className="text-xs text-ink-muted">Realised P&amp;L (rolling {risk.limits.dailyLossWindowHours} h, signed)</dt>
              <dd className={`tabular ${signClass(risk.snapshot.realisedPnlInWindow)}`}>{signedUsdt(risk.snapshot.realisedPnlInWindow)}</dd></div>
            <div><dt className="text-xs text-ink-muted">Daily-loss latch</dt>
              <dd className={risk.latched ? "text-down" : "text-ink"}>{risk.latched ? "Latched: the Bot is halted by the daily-loss limit" : "Not latched"}</dd></div>
          </dl>
        )}
        <p className="text-xs text-ink-faint">
          Pending entries are unfilled manual BUY orders and strategy BUYs whose outcome the Bot is still
          reconciling; the limits count them, the trades list shows booked trades only.
        </p>
        <p className="text-xs text-ink-faint">{LATCH_NOTE} {LOSS_LIMIT_WARNING}</p>
      </div>

      <StepUpDialog open={draft !== null} title="Change the Bot's risk limits" confirmLabel="Save limits" tier="fresh" autoSubmit
        canConfirm={changed} onCancel={() => setDraft(null)}
        intro={<p>Empty means no limit. The Bot applies these to new entries; exits are never capped.</p>}
        onConfirm={async (credential) => {
          if (!patch) return { close: false, error: "Check the values." };
          const result = await onSubmit(patch, credential);
          if (result.close) setDraft(null);
          return result;
        }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {field("maxTotalExposureQuote", "Max total exposure", "USDT", "Across every open trade.")}
          {field("maxConcurrentTrades", "Max open trades", "count", "Whole number.")}
          {field("maxDailyLossQuote", "Daily-loss limit", "USDT", "Empty turns it off.")}
          {field("dailyLossWindowHours", "Daily-loss window", "hours", "1 to 720.")}
        </div>
        {checked && "error" in checked && <Notice tone="error">{checked.error}</Notice>}
        {risk?.latched && loosensLoss && <Notice tone="warn">{LOSS_LIMIT_WARNING} The halt itself stays until you resume.</Notice>}
        <p className="text-xs text-ink-faint">{LATCH_NOTE}</p>
      </StepUpDialog>
    </Card>
  );
}
