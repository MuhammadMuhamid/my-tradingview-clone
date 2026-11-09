"use client";
/**
 * One bot: edit every field (C12), link it to a deployment, rotate its
 * webhook secret (C14), show the TradingView exit alert on the Bot's own page
 * (C17 reveal_webhook), and delete it (C13).
 *
 * Tiers (OD-2): an edit that loosens protection, a rotation and a reveal need
 * a fresh authenticator code; any other edit, a link and a delete accept a
 * recent one. The server decides; the page says which to expect.
 * The webhook secret is never shown here: the reveal happens on the Bot's
 * origin, once, and this page only navigates there.
 */
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminOnlyPage } from "@/components/AdminOnlyPage";
import { Button, Card, CardHeader, Loading, Notice, StatusBadge } from "@/components/ui";
import { botControlApi, type BotControlPanel } from "@/lib/api";
import { botManageApi, type BotDetail } from "@/lib/botManageApi";
import { fmtDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { BotShell } from "@/components/bot/BotShell";
import { BotForm } from "@/components/bot/BotFormFields";
import { LinkDeploymentPanel } from "@/components/bot/LinkDeploymentPanel";
import { OutcomeNotices } from "@/components/bot/OutcomeNotices";
import { StepUpDialog } from "@/components/bot/StepUpDialog";
import { TwoFactorBanner } from "@/components/bot/TwoFactorBanner";
import { useBotCommands } from "@/components/bot/commandRunner";
import { openBotPage } from "@/components/bot/navigate";
import { capability, capabilityNote } from "@/components/bot/botLogic";
import {
  changedFields, formFromBot, validateBotForm, weakensProtection, type BotFormState,
} from "@/components/bot/botForm";
import { useAccountBalance, useExchangeAccounts } from "@/components/bot/useAccounts";

type Dialog = "save" | "rotate" | "reveal" | "delete" | null;

const FIELD_NAMES: Record<string, string> = {
  name: "name", alertType: "alert type", pairs: "pairs", maxInvestmentPct: "investment", maxInvestmentUnit: "investment unit",
  exchangeAccountId: "exchange account", entryEnabled: "entries", entryVolumePct: "volume per order", entryOrderType: "order type",
  exitEnabled: "exits", takeProfitEnabled: "take profit", takeProfitPct: "take profit %", stopLossEnabled: "stop loss",
  stopLossPct: "stop loss %", maxEntryOrders: "entry orders per pair", maxActiveSmartTradesEnabled: "open-trade cap",
  maxActiveSmartTrades: "max open trades",
};

function BotDetailView() {
  const id = useParams<{ id: string }>().id;
  const router = useRouter();
  const session = useSession();
  const [panel, setPanel] = useState<BotControlPanel | null>(null);
  const [detail, setDetail] = useState<BotDetail | null>(null);
  const [readError, setReadError] = useState<{ code: string; message: string } | null>(null);
  const [initial, setInitial] = useState<BotFormState | null>(null);
  const [form, setForm] = useState<BotFormState | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  const load = useCallback(async () => {
    const result = await botManageApi.bot(id);
    if (!result.ok) { setReadError({ code: result.code, message: result.message }); return; }
    setReadError(null);
    setDetail(result.data);
    const next = formFromBot(result.data.bot);
    setInitial(next);
    setForm(next);
    setShowErrors(false);
  }, [id]);

  useEffect(() => {
    botControlApi.status().then(setPanel, () => setPanel(null));
    void load();
  }, [load]);

  const commands = useBotCommands(useCallback(() => { void load(); }, [load]));
  const bots = capability(panel, "bots.v1");
  const enroll = capability(panel, "enroll.v1");
  const accountsCap = capability(panel, "accounts.v1");
  const [accounts] = useExchangeAccounts(accountsCap === "yes");
  const balance = useAccountBalance(form?.exchangeAccountId ?? "", accountsCap === "yes");

  const authOff = session !== null && !session.authEnabled;
  const channelOff = panel !== null && !panel.channel.configured;
  const blocked = authOff ? "Bot commands need sign-in to be turned on for this installation."
    : channelOff ? "Bot control channel not configured." : null;
  const canCommand = blocked === null && bots === "yes";
  const twoFactorOff = session?.user ? !session.user.twoFactorEnabled : false;

  const bot = detail?.bot ?? null;
  const errors = form ? validateBotForm(form, bot?.pairs ?? []) : {};
  const changed = useMemo(() => (initial && form ? changedFields(initial, form) : {}), [initial, form]);
  const changedNames = Object.keys(changed).map((k) => FIELD_NAMES[k] ?? k);
  const weakening = bot ? weakensProtection(changed, bot) : true;
  const valid = Object.keys(errors).length === 0;

  if (readError) {
    return (
      <BotShell section="bot" title="Bot">
        <Notice tone="error" role="alert">{readError.code === "bot_not_found" ? "The Bot has no bot with this id. It may have been deleted."
          : readError.code === "invalid_target_id" ? "That is not a bot id."
            : "The bot could not be read from the Bot. Reload to try again."}</Notice>
        <Link href="/bot" className="text-sm underline">Back to the overview</Link>
      </BotShell>
    );
  }
  if (!bot || !form || !detail) {
    return <BotShell section="bot" title="Bot"><Loading>Reading the bot…</Loading></BotShell>;
  }

  const secret = detail.platform.secret;
  return (
    <BotShell section="bot" title={bot.name}
      leading={<Link href="/bot" aria-label="Back to the Bot overview" className="text-sm text-ink-muted underline hover:text-ink">← Bot</Link>}
      description={<span className="inline-flex flex-wrap items-center gap-2">
        <StatusBadge status={bot.status === "active" ? "active" : "stopped"} />
        <span>{bot.activeTrades} open trade{bot.activeTrades === 1 ? "" : "s"} · {bot.unresolvedIntents} unresolved order{bot.unresolvedIntents === 1 ? "" : "s"}</span>
      </span>}>
      {twoFactorOff && !authOff && <TwoFactorBanner />}
      <OutcomeNotices outcomes={commands.outcomes} onRecheck={commands.recheck} onDismiss={commands.dismiss} />
      {panel && bots !== "yes" && <Notice tone="warn">{capabilityNote(bots, "Editing bots from Trading Scene")}</Notice>}
      {blocked && <Notice tone="warn">{blocked}</Notice>}

      <form noValidate aria-label="Bot settings" className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); setShowErrors(true); if (valid && canCommand && changedNames.length) setDialog("save"); }}>
        <BotForm form={form} onChange={setForm} errors={errors} showErrors={showErrors} accounts={accounts}
          currentAccount={bot.exchangeAccount} balance={balance} keptPairs={bot.pairs} disabled={!canCommand} />
        {showErrors && !valid && <Notice tone="error" role="alert">Some fields need attention before saving.</Notice>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={!canCommand || changedNames.length === 0}>Save changes…</Button>
          <Button onClick={() => { setForm(initial); setShowErrors(false); }} disabled={changedNames.length === 0}>Discard changes</Button>
          <span className="text-xs text-ink-faint" aria-live="polite">{changedNames.length === 0 ? "No changes."
            : `Changed: ${changedNames.join(", ")}.${weakening ? " This loosens protection, so it needs a fresh authenticator code." : ""}`}</span>
        </div>
      </form>

      <Card>
        <CardHeader title="Webhook" />
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-ink-muted">Webhook path on the Bot</dt><dd className="break-all text-ink">{bot.webhookPath}</dd>
          <dt className="text-ink-muted">Secret</dt><dd className="text-ink tabular">{bot.webhookSecretMasked}</dd>
          <dt className="text-ink-muted">Held by Trading Scene</dt>
          <dd className="text-ink">{secret.stored ? `Yes, encrypted (since ${fmtDateTime(secret.updatedAt)})` : "No"}</dd>
        </dl>
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <Button disabled={!canCommand} title={blocked ?? undefined} onClick={() => setDialog("rotate")}>Rotate secret…</Button>
          <span className="text-xs text-ink-faint">Issues a new secret, stores it here and updates linked deployments. Anything still using the old one stops working.</span>
        </div>
      </Card>

      <LinkDeploymentPanel botId={bot.id} botName={bot.name} webhookPath={bot.webhookPath} secretStored={secret.stored}
        canCommand={canCommand} disabledReason={blocked ?? undefined} onLinked={() => void load()} />

      <Card>
        <CardHeader title="TradingView exit alert (legacy)" />
        <div className="space-y-2 px-4 py-3 text-sm text-ink">
          <p>For a TradingView alert that sends exits straight to the Bot, the alert needs the secret. It is shown once, on the Bot&apos;s
            own page, never in Trading Scene. Opening it leaves this page.</p>
          {enroll !== "yes" && <Notice tone="warn">{capabilityNote(enroll, "Showing the exit alert on the Bot's page")}</Notice>}
          <Button disabled={!canCommand || enroll !== "yes"} onClick={() => setDialog("reveal")}>Show on the Bot…</Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Delete" />
        <div className="space-y-2 px-4 py-3 text-sm text-ink">
          <p>Its trade history is kept. The Bot refuses while it has open trades or orders still being reconciled.</p>
          {bot.activeTrades > 0 && <p className="text-warn">This bot has {bot.activeTrades} open trade{bot.activeTrades === 1 ? "" : "s"}: close them first.</p>}
          <Button variant="danger" disabled={!canCommand} onClick={() => setDialog("delete")}>Delete bot…</Button>
        </div>
      </Card>

      <StepUpDialog open={dialog === "save"} title={`Save ${bot.name}`} confirmLabel="Save changes" tier={weakening ? "fresh" : "grant"}
        autoSubmit onCancel={() => setDialog(null)}
        intro={<><p>Changes: {changedNames.join(", ")}.</p>
          {weakening && <p className="text-warn">This loosens the bot&apos;s protection, so a fresh authenticator code is needed.</p>}</>}
        onConfirm={(credential) => commands.run({
          intent: `bot_update:${bot.id}:${JSON.stringify(changed)}`, label: `Save ${bot.name}`,
          send: (requestId) => botManageApi.updateBot(requestId, bot.id, changed, credential),
          describe: () => "Saved.",
        })} />

      <StepUpDialog open={dialog === "rotate"} title={`Rotate ${bot.name}'s secret`} confirmLabel="Rotate secret" danger tier="fresh"
        autoSubmit onCancel={() => setDialog(null)}
        intro={<><p>The Bot issues a new webhook secret; Trading Scene stores it (encrypted) and updates
          {detail.platform.linkedDeployments.length ? ` ${detail.platform.linkedDeployments.length} linked deployment(s)` : " linked deployments"}.</p>
          <p className="text-ink-muted">A TradingView alert or anything else using the old secret stops working. The Bot refuses while exits are still being reconciled.</p></>}
        onConfirm={(credential) => commands.run({
          intent: `bot_rotate_secret:${bot.id}`, label: `Rotate ${bot.name}'s secret`,
          send: (requestId) => botManageApi.rotateSecret(requestId, bot.id, credential),
          describe: (result) => {
            const p = result.platformSecret as { secretCaptured?: boolean; linkedDeploymentsUpdated?: number } | undefined;
            return p?.secretCaptured === true
              ? `New secret stored in Trading Scene; ${p.linkedDeploymentsUpdated ?? 0} linked deployment(s) updated.`
              : "The Bot issued a new secret, but Trading Scene did not capture it. Rotate again to store one here.";
          },
        })} />

      <StepUpDialog open={dialog === "reveal"} title="Show the exit alert on the Bot" confirmLabel="Open the Bot's page" tier="fresh"
        autoSubmit onCancel={() => setDialog(null)}
        intro={<p>Trading Scene asks the Bot for a one-time link (valid five minutes) and opens it. The Bot shows the secret and the
          TradingView exit JSON once, then sends you back here.</p>}
        onConfirm={(credential) => commands.run({
          intent: `reveal_webhook:${bot.id}`, label: "Exit alert",
          send: (requestId) => botManageApi.mintEnrollment(requestId, { purpose: "reveal_webhook", botId: bot.id }, credential),
          describe: (result) => typeof result.enrollUrl === "string" && openBotPage(result.enrollUrl)
            ? "Opening the Bot's page…"
            : "The link was issued but cannot be shown again (it is used once). Ask for a new one.",
        })} />

      <StepUpDialog open={dialog === "delete"} title={`Delete ${bot.name}`} confirmLabel="Delete bot" danger tier="grant"
        autoSubmit onCancel={() => setDialog(null)}
        intro={<p>The bot is removed from the Bot; its trade history stays. Its stored secret is forgotten here.</p>}
        onConfirm={(credential) => commands.run({
          intent: `bot_delete:${bot.id}`, label: `Delete ${bot.name}`,
          send: (requestId) => botManageApi.deleteBot(requestId, bot.id, credential),
          describe: () => { router.push("/bot"); return "Deleted. Its trade history is kept."; },
        })} />
    </BotShell>
  );
}

export default function BotDetailPage() {
  return <AdminOnlyPage title="Bot" width="narrow"><BotDetailView /></AdminOnlyPage>;
}
