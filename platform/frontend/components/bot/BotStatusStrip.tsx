"use client";
/**
 * Every Bot fact under its own name (contract §7, U1).
 *
 * There is deliberately no overall badge. "Connected" used to stand in for
 * "ready", and a Bot can be connected and halted, connected and simulated,
 * connected with its daily-loss latch set, reachable on one path and refused
 * on the other. Each line here is one fact, and a fact that could not be read
 * says "Unknown", never "off" or "none".
 */
import type { BotControlPanel } from "@/lib/api";
import { countedLoss, haltLabel, routingLabel, signedLabel, signedUsdt, webhookLabel } from "./botCopy";

type Tone = "ink" | "warn" | "down";
const TONE: Record<Tone, string> = { ink: "text-ink", warn: "text-warn", down: "text-down" };

function Item({ label, value, tone = "ink", detail }: { label: string; value: string; tone?: Tone; detail?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={`text-sm font-medium ${TONE[tone]}`}>{value}</dd>
      {detail && <dd className="text-xs text-ink-faint">{detail}</dd>}
    </div>
  );
}

const usd = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT`;
const UNKNOWN = "Unknown (status not read)";

export function BotStatusStrip({ panel }: { panel: BotControlPanel }) {
  const facts = panel.facts;
  const signedTone: Tone = panel.signed.state === "CONNECTED" ? "ink"
    : panel.signed.state === "NOT_CONFIGURED" ? "warn" : "down";
  const halt = haltLabel(panel);
  const risk = facts?.risk;
  return (
    <dl aria-label="Bot status" className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      <Item label="Control channel (this Platform)" value={panel.channel.configured ? "Set up" : "Not set up"}
        tone={panel.channel.configured ? "ink" : "warn"}
        detail={panel.channel.configured ? undefined : "The Bot URL and control key are not configured on this Platform."} />
      <Item label="Signed connection" value={signedLabel(panel.signed.state, panel.signed.cause)} tone={signedTone} />
      <Item label="Webhook-credential path" value={webhookLabel(panel.webhook)}
        tone={panel.webhook.state === "UNAVAILABLE" ? "down" : "ink"}
        detail="A separate path: a deployment's webhook secret." />
      <Item label="Execution" value={facts ? (facts.dryRun ? "Dry run (simulated)" : "Live orders") : UNKNOWN}
        tone={facts ? "ink" : "warn"}
        detail={facts?.dryRun ? "Orders are simulated by the Bot; not the Platform's PAPER mode." : undefined} />
      <Item label="Bot halt" value={halt ?? UNKNOWN} tone={!facts ? "warn" : facts.halt.halted ? "down" : "ink"}
        detail={facts?.halt.halted && facts.halt.haltedReason ? `Reason: ${facts.halt.haltedReason}` : undefined} />
      <Item label="Exchange routing" value={facts ? routingLabel(facts.exchange.routing) : UNKNOWN}
        tone={!facts ? "warn" : facts.exchange.routing === "MIXED" ? "warn" : "ink"}
        detail={facts ? `${facts.exchange.accounts.testnet} testnet · ${facts.exchange.accounts.mainnet} mainnet account(s)` : undefined} />
      <Item label="Risk limits"
        value={risk
          ? `Exposure incl. pending entries ${usd(risk.snapshot.openExposureQuote)} / ${risk.limits.maxTotalExposureQuote === null ? "no limit" : usd(risk.limits.maxTotalExposureQuote)}`
          : UNKNOWN}
        tone={!risk ? "warn" : risk.latched ? "down" : "ink"}
        detail={risk
          ? `Open trades incl. pending entries ${risk.snapshot.openTrades} / ${risk.limits.maxConcurrentTrades ?? "no limit"} · Daily loss `
            + `${usd(countedLoss(risk.snapshot.realisedPnlInWindow))} of `
            + `${risk.limits.maxDailyLossQuote === null ? "no limit (off)" : usd(risk.limits.maxDailyLossQuote)} over `
            + `${risk.limits.dailyLossWindowHours}h (realised P&L ${signedUsdt(risk.snapshot.realisedPnlInWindow)})`
            + `${risk.latched ? " · latched" : ""}`
          : undefined} />
      <Item label="Shariah floor"
        value={!facts ? UNKNOWN : facts.shariahFloor.mode === "enforce"
          ? `Enforced${facts.shariahFloor.policyVersion ? ` (policy ${facts.shariahFloor.policyVersion})` : ""}` : "Off"}
        tone={facts ? "ink" : "warn"} />
      <Item label="TP/SL protection"
        value={!facts ? UNKNOWN : facts.halt.halted ? "NOT being checked (Bot halted)" : `Checked every ${facts.protection.intervalSec}s`}
        tone={!facts ? "warn" : facts.halt.halted ? "down" : "ink"}
        detail={facts ? (facts.protection.exchangeResting
          ? "Resting orders on the exchange."
          : "Checked by the Bot while it runs; nothing rests on the exchange, so nothing is checked while the Bot is down.")
          : undefined} />
      <Item label="Manual trading"
        value={!facts ? UNKNOWN : facts.manual.enabled ? "On" : "Off"} tone={facts ? "ink" : "warn"}
        detail={facts ? `Mainnet manual trading ${facts.manual.mainnetEnabled ? "on" : "off"}` : undefined} />
    </dl>
  );
}
