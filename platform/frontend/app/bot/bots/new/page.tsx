"use client";
/**
 * New bot (C10). The form has every Classic field and refuses, before anything
 * is sent, what the Bot would refuse (incl. the 50 % unprotected-size rule).
 * A bot that can open positions widens exposure, so creating one with entries
 * on needs a fresh authenticator code; with entries off, a recent one will do.
 *
 * The webhook secret the Bot issues never reaches this page: Trading Scene
 * stores it encrypted and the next step is "Link to deployment" (P-57).
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminOnlyPage } from "@/components/AdminOnlyPage";
import { Button, Card, CardHeader, Loading, Notice } from "@/components/ui";
import { botControlApi, type BotControlPanel } from "@/lib/api";
import { useSession } from "@/lib/session";
import { BotShell } from "@/components/bot/BotShell";
import { BotForm } from "@/components/bot/BotFormFields";
import { LinkDeploymentPanel } from "@/components/bot/LinkDeploymentPanel";
import { StepUpDialog } from "@/components/bot/StepUpDialog";
import { TwoFactorBanner } from "@/components/bot/TwoFactorBanner";
import { OutcomeNotices } from "@/components/bot/OutcomeNotices";
import { useBotCommands } from "@/components/bot/commandRunner";
import { buildBotPayload, defaultBotForm, validateBotForm, type BotFormState } from "@/components/bot/botForm";
import { capability, capabilityNote } from "@/components/bot/botLogic";
import { useAccountBalance, useExchangeAccounts } from "@/components/bot/useAccounts";
import { botManageApi } from "@/lib/botManageApi";

interface Created {
  id: string;
  name: string;
  webhookPath: string;
  /** null: the answer came from the Bot's record (C8 or a replay), so the Platform did not capture it. */
  captured: boolean;
}

function readCreated(result: Record<string, unknown>): Created | null {
  const bot = result.bot as Record<string, unknown> | undefined;
  if (!bot || typeof bot.id !== "string") return null;
  const platform = result.platformSecret as Record<string, unknown> | undefined;
  return { id: bot.id, name: typeof bot.name === "string" ? bot.name : "The bot",
    webhookPath: typeof bot.webhookPath === "string" ? bot.webhookPath : "/api/webhooks/signal_bots",
    captured: platform?.secretCaptured === true };
}

function NewBotView() {
  const session = useSession();
  const [panel, setPanel] = useState<BotControlPanel | null>(null);
  const [panelError, setPanelError] = useState(false);
  const [form, setForm] = useState<BotFormState>(defaultBotForm);
  const [showErrors, setShowErrors] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  useEffect(() => {
    botControlApi.status().then((p) => { setPanel(p); setPanelError(false); }, () => setPanelError(true));
  }, []);
  const bots = capability(panel, "bots.v1");
  const accountsCap = capability(panel, "accounts.v1");
  const [accounts] = useExchangeAccounts(accountsCap === "yes");
  const balance = useAccountBalance(form.exchangeAccountId, accountsCap === "yes");
  const commands = useBotCommands(useCallback(() => {}, []));

  const errors = validateBotForm(form);
  const valid = Object.keys(errors).length === 0;
  const authOff = session !== null && !session.authEnabled;
  const channelOff = panel !== null && !panel.channel.configured;
  const blocked = authOff ? "Bot commands need sign-in to be turned on for this installation."
    : channelOff ? "Bot control channel not configured." : null;
  const twoFactorOff = session?.user ? !session.user.twoFactorEnabled : false;
  const payload = buildBotPayload(form);

  return (
    <BotShell section="new" title="New bot"
      description="A signal bot on the Bot: which pairs it trades, how much, and how it is protected.">
      {twoFactorOff && !authOff && <TwoFactorBanner />}
      <OutcomeNotices outcomes={commands.outcomes} onRecheck={commands.recheck} onDismiss={commands.dismiss} />
      {!panel && !panelError && <Loading>Reading the Bot&apos;s status…</Loading>}
      {panelError && <Notice tone="error" role="alert">The Bot&apos;s status could not be read, so creating a bot is unavailable. Reload to try again.</Notice>}
      {panel && bots !== "yes" && <Notice tone="warn">{capabilityNote(bots, "Creating bots from Trading Scene")}</Notice>}
      {blocked && <Notice tone="warn">{blocked}</Notice>}

      {created ? (
        <>
          <Card>
            <CardHeader title={`${created.name} created`} />
            <div className="space-y-2 px-4 py-3 text-sm text-ink">
              {created.captured
                ? <p>Its webhook secret is stored in Trading Scene (encrypted) and was never shown. Link it to a deployment below.</p>
                : <Notice tone="warn">The Bot issued a webhook secret, but Trading Scene did not capture it (the answer was replayed or lost).
                  Rotate the secret on the bot&apos;s page to store a new one here before linking.</Notice>}
              <p><Link href={`/bot/bots/${encodeURIComponent(created.id)}`} className="underline">Open {created.name}</Link>{" · "}
                <Link href="/bot" className="underline">Back to the overview</Link></p>
            </div>
          </Card>
          <LinkDeploymentPanel botId={created.id} botName={created.name} webhookPath={created.webhookPath}
            secretStored={created.captured} canCommand={blocked === null} disabledReason={blocked ?? undefined} />
        </>
      ) : panel && bots === "yes" && (
        <form noValidate onSubmit={(e) => { e.preventDefault(); setShowErrors(true); if (valid && !blocked) setConfirming(true); }}
          className="space-y-4" aria-label="New bot">
          <BotForm form={form} onChange={setForm} errors={errors} showErrors={showErrors} accounts={accounts} balance={balance} />
          {showErrors && !valid && <Notice tone="error" role="alert">Some fields need attention before the bot can be created.</Notice>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={blocked !== null}>Create bot…</Button>
            <Link href="/bot" className="text-sm text-ink-muted underline hover:text-ink">Cancel</Link>
            <span className="text-xs text-ink-faint">{form.entryEnabled
              ? "A bot that can open positions needs a fresh authenticator code."
              : "Entries are off: a recent confirmation is enough."}</span>
          </div>
        </form>
      )}

      <StepUpDialog open={confirming} title={`Create ${form.name.trim() || "bot"}`} confirmLabel="Create bot"
        tier={form.entryEnabled ? "fresh" : "grant"} autoSubmit onCancel={() => setConfirming(false)}
        intro={<>
          <p>{form.pairs.join(", ")} · {form.maxInvestmentPct} {form.maxInvestmentUnit.startsWith("pct") ? "%" : "USDT"} ·
            {form.stopLossEnabled ? ` stop loss ${form.stopLossPct}%` : " NO STOP LOSS"} · entries {form.entryEnabled ? "on" : "off"} ·
            exits {form.exitEnabled ? "on" : "OFF"}</p>
          <p className="text-ink-muted">The bot starts active. It acts only on signals signed with its webhook secret, which Trading Scene keeps.</p>
        </>}
        onConfirm={(credential) => commands.run({
          intent: `bot_create:${JSON.stringify(payload)}`, label: `Create ${form.name.trim()}`,
          send: (requestId) => botManageApi.createBot(requestId, payload, credential),
          describe: (result) => {
            const done = readCreated(result);
            if (done) setCreated(done);
            return done?.captured ? "Created. Its webhook secret is stored in Trading Scene."
              : "Created. Its webhook secret was not captured by Trading Scene; rotate it before linking.";
          },
        })} />
    </BotShell>
  );
}

export default function NewBotPage() {
  return <AdminOnlyPage title="New bot" width="narrow"><NewBotView /></AdminOnlyPage>;
}
