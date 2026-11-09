"use client";
/**
 * Pause new entries (OD-3): one action, two halves, shown separately.
 *
 * The Platform half stops this Platform's own BUYs (strategy emissions, the
 * test signal, manual BUYs). The Bot half (C9) stops BUYs at the Bot, and may
 * also cancel working manual entry orders, but only when the operator ticks
 * that box. Exits, TP/SL and cancels are never paused.
 *
 * Truth rules: each half is reported from its own answer. A Bot half whose
 * outcome is unknown is shown as unknown and checked through C8 with the same
 * request id; it is never shown as paused because the Platform half was.
 */
import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, CardHeader, Checkbox, Field, Notice, TextInput } from "@/components/ui";
import { botControlApi, type BotControlPanel } from "@/lib/api";
import { botManageApi, type EntriesBotHalf } from "@/lib/botManageApi";
import { fmtDateTime } from "@/lib/format";
import { StepUpDialog } from "./StepUpDialog";
import { OpenIntents, settleUncertain, type DialogResult } from "./commandRunner";
import { STEP_UP_CODES, explainRefusal } from "./botCopy";
import { capability, capabilityNote } from "./botLogic";

type BotHalfView = EntriesBotHalf | { state: "checking" } | { state: "not_found" } | { state: "not_sent"; reason: string };

interface Result {
  action: "pause" | "resume";
  requestId: string;
  platform: { paused: boolean; at: string | null; changed: boolean } | null;
  bot: BotHalfView;
}

const pausedWord = (paused: boolean | undefined | null) => paused === undefined || paused === null ? "unknown" : paused ? "paused" : "not paused";

function botHalfText(half: BotHalfView, action: "pause" | "resume"): { text: string; tone: "success" | "warn" | "error" } {
  const verb = action === "pause" ? "paused" : "resumed";
  switch (half.state) {
    case "succeeded":
      return { tone: "success", text: half.changed === false ? `Bot half: already ${verb === "paused" ? "paused" : "running"}.` : `Bot half: ${verb}.` };
    case "pending":
    case "checking":
      return { tone: "warn", text: "Bot half: outcome unknown, checking…" };
    case "uncertain":
      return { tone: "warn", text: `Bot half: outcome still unknown. The Bot may or may not have ${verb} entries; check its status before trying again. Doing it again is answered from the Bot's record, never run twice.` };
    case "not_found":
      return { tone: "error", text: "Bot half: not applied. The Bot has no record of this command." };
    case "not_sent":
      return { tone: "error", text: `Bot half: not sent. ${half.reason}` };
    default:
      return { tone: "error", text: `Bot half: refused. ${explainRefusal(half.code, half.message).text}` };
  }
}

export function EntriesCard({ panel, isAdmin, canCommand, commandsBlocked, twoFactorEnabled, onChanged }: {
  panel: BotControlPanel | null;
  isAdmin: boolean;
  canCommand: boolean;
  commandsBlocked: string | null;
  twoFactorEnabled: boolean;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<"pause" | "resume" | null>(null);
  const [reason, setReason] = useState("");
  const [cancelWorking, setCancelWorking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const intents = useRef(new OpenIntents());

  const platformHalf = panel?.platformEntries ?? null;
  const botEntries = panel?.facts?.entries ?? null;
  const supported = capability(panel, "entries.v1");
  const note = capabilityNote(supported, "Pausing new entries");
  const working = botEntries?.workingEntryLimits;
  const latched = panel?.facts?.risk.latched === true || panel?.facts?.risk.dailyLossBreached === true;
  const disabled = !canCommand || supported !== "yes";
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 200;
  const anyPaused = platformHalf?.paused === true || botEntries?.paused === true;
  const anyRunning = platformHalf?.paused !== true || botEntries?.paused !== true;

  const check = useCallback(async (requestId: string, action: "pause" | "resume", intent: string,
    platform: Result["platform"]) => {
    setResult({ action, requestId, platform, bot: { state: "checking" } });
    const verdict = await settleUncertain(requestId, { lookup: botControlApi.command });
    let bot: BotHalfView;
    if (verdict.state === "succeeded") {
      intents.current.close(intent);
      const r = verdict.record.result && typeof verdict.record.result === "object" ? verdict.record.result as Record<string, unknown> : {};
      bot = { state: "succeeded", changed: typeof r.changed === "boolean" ? r.changed : null, canceled: null };
    } else if (verdict.state === "failed") {
      intents.current.close(intent);
      bot = { state: "refused", code: verdict.code ?? "failed", message: verdict.message };
    } else if (verdict.state === "not_found") {
      intents.current.close(intent);
      bot = { state: "not_found" };
    } else {
      bot = { state: "uncertain" };
    }
    setResult({ action, requestId, platform, bot });
    onChanged();
  }, [onChanged]);

  const confirm = async (credential: { code?: string; password?: string }): Promise<DialogResult> => {
    const action = dialog!;
    const pausing = action === "pause";
    const intent = pausing ? `entries:pause:${reason.trim()}:${cancelWorking}` : "entries:resume";
    const requestId = intents.current.idFor(intent);
    const answer = await botManageApi.setEntries(requestId,
      pausing ? { paused: true, reason: reason.trim(), cancelWorkingEntries: cancelWorking } : { paused: false }, credential);
    if (answer.kind === "refused") {
      if (STEP_UP_CODES.has(answer.code)) return { close: false, error: answer.message, ...(answer.method ? { method: answer.method } : {}) };
      intents.current.close(intent);
      setResult({ action, requestId, platform: null, bot: { state: "not_sent", reason: explainRefusal(answer.code, answer.message).text } });
      return { close: true };
    }
    if (answer.kind === "uncertain") {
      // Nothing came back at all: neither half is known. Ask C8 about the Bot half.
      intents.current.keepOpen(intent, requestId);
      void check(requestId, action, intent, null);
      return { close: true };
    }
    if (answer.bot.state === "uncertain" || answer.bot.state === "pending") {
      intents.current.keepOpen(intent, requestId);
      void check(requestId, action, intent, answer.platform);
    } else {
      intents.current.close(intent);
      setResult({ action, requestId, platform: answer.platform, bot: answer.bot });
      onChanged();
    }
    return { close: true };
  };

  const botText = result ? botHalfText(result.bot, result.action) : null;

  return (
    <Card>
      <CardHeader title="New entries" right={isAdmin ? <div className="flex flex-wrap gap-2">
        {anyPaused && <Button disabled={disabled} title={commandsBlocked ?? note ?? undefined}
          onClick={() => setDialog("resume")}>Resume new entries…</Button>}
        {anyRunning && <Button variant="danger" disabled={disabled} title={commandsBlocked ?? note ?? undefined}
          onClick={() => { setReason(""); setCancelWorking(false); setDialog("pause"); }}>Pause new entries…</Button>}
      </div> : undefined} />
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm text-ink">
          Pausing stops new BUYs only. Exits, TP/SL, Close and Partial keep working. It is separate from the halt.
        </p>
        {note && <Notice tone="warn">{note}</Notice>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border p-3" data-entries-half="platform">
            <h3 className="text-sm font-semibold text-ink">Platform half <span className="font-normal text-ink-muted">· {platformHalf ? pausedWord(platformHalf.paused) : "unknown"}</span></h3>
            <p className="mt-1 text-xs text-ink-muted">This Platform&apos;s strategy BUYs, the test signal and manual BUYs from the Trade panel.</p>
            {platformHalf?.paused && <p className="mt-1 text-xs text-ink-faint">
              Since {fmtDateTime(platformHalf.pausedAt)}{platformHalf.reason ? ` · ${platformHalf.reason}` : ""}</p>}
          </div>
          <div className="rounded-md border border-border p-3" data-entries-half="bot">
            <h3 className="text-sm font-semibold text-ink">Bot half <span className="font-normal text-ink-muted">· {botEntries ? pausedWord(botEntries.paused) : "unknown"}</span></h3>
            <p className="mt-1 text-xs text-ink-muted">BUYs at the Bot: webhook signals and manual BUYs sent through it.</p>
            {botEntries?.paused && <p className="mt-1 text-xs text-ink-faint">
              Since {fmtDateTime(botEntries.pausedAt)}{botEntries.reason ? ` · ${botEntries.reason}` : ""}</p>}
            {botEntries && <p className="mt-1 text-xs text-ink-faint">
              {working === undefined ? "Working entry orders: not reported" : `${working} working entry order${working === 1 ? "" : "s"}`}
              {botEntries.unresolvedBuyIntents !== undefined ? ` · ${botEntries.unresolvedBuyIntents} unresolved BUY intent${botEntries.unresolvedBuyIntents === 1 ? "" : "s"}` : ""}
            </p>}
            {!botEntries && panel?.facts && <p className="mt-1 text-xs text-ink-faint">This Bot does not report a pause (an older version).</p>}
          </div>
        </div>
        {latched && <Notice tone="warn">The daily-loss limit is {panel?.facts?.risk.latched ? "latched" : "at its limit"}. Pausing or resuming entries does not clear it; resuming the Bot does that separately.</Notice>}
        {result && <section aria-label="Pause outcome" aria-live="polite" className="space-y-1.5">
          <Notice tone={result.platform ? "success" : "warn"} role="status">
            {result.platform
              ? `Platform half: ${result.platform.paused ? "paused" : "resumed"}${result.platform.changed ? "" : " (it already was)"}.`
              : result.bot.state === "not_sent" ? "Neither half ran." : "Platform half: the answer did not arrive. Refresh to read it."}
          </Notice>
          {botText && result.bot.state !== "not_sent" && <Notice tone={botText.tone} role={botText.tone === "error" ? "alert" : "status"}>{botText.text}</Notice>}
          {result.bot.state === "not_sent" && <Notice tone="error" role="alert">{result.bot.reason}</Notice>}
          {result.bot.state === "succeeded" && result.bot.canceled && <ul className="text-xs text-ink-muted" aria-label="Entry orders">
            {result.bot.canceled.length === 0 ? <li>No working entry orders were open.</li>
              : result.bot.canceled.map((c) => <li key={c.orderId}>{c.symbol} order {c.orderId}: {c.outcome === "canceled" ? "cancelled"
                : c.outcome === "already_terminal" ? "already finished" : c.outcome === "unknown" ? "outcome unknown (being checked by the Bot)" : "cancel failed"}</li>)}
          </ul>}
        </section>}
        {!twoFactorEnabled && <p className="text-xs text-ink-faint">Pausing accepts your password while two-factor is off; resuming needs two-factor (<Link href="/profile" className="underline">profile</Link>).</p>}
      </div>

      <StepUpDialog open={dialog === "pause"} title="Pause new entries" confirmLabel="Pause entries" danger allowsPassword
        canConfirm={reasonOk} onCancel={() => setDialog(null)} onConfirm={confirm}
        intro={<><p>Stops new BUYs on this Platform and at the Bot. Exits, TP/SL, Close and Partial keep working.</p>
          {latched && <p className="text-warn">The daily-loss limit is latched; this does not change it.</p>}</>}>
        <Field label="Reason for pausing" help="3 to 200 characters.">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className="w-full" />
        </Field>
        <label className="flex items-start gap-2 text-sm text-ink">
          <Checkbox checked={cancelWorking} onChange={setCancelWorking}
            label={working === undefined ? "Also cancel working entry orders" : `Also cancel ${working} working entry order${working === 1 ? "" : "s"}`} />
          <span>{working === undefined ? "Also cancel working entry orders (the Bot did not say how many)"
            : `Also cancel ${working} working entry order${working === 1 ? "" : "s"}`}
            <span className="block text-xs text-ink-faint">Off by default. Manual LIMIT BUYs still open at the exchange; a cancel the exchange does not confirm is reported as unknown.</span></span>
        </label>
      </StepUpDialog>

      <StepUpDialog open={dialog === "resume"} title="Resume new entries" confirmLabel="Resume entries"
        onCancel={() => setDialog(null)} onConfirm={confirm}
        intro={<p>New BUYs are allowed again on this Platform and at the Bot.{latched ? " The daily-loss limit stays latched until the Bot is resumed separately." : ""}</p>} />
    </Card>
  );
}
