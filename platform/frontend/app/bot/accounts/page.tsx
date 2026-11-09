"use client";
/**
 * The Bot's exchange accounts (C15), their balances (C19), removing one
 * (C16), and adding one or replacing its keys on the Bot's own page (C17,
 * OD-4). API keys never pass through Trading Scene: the Platform asks the
 * Bot for a one-time link and the browser goes there; the Bot sends it back
 * here with `?enrollment=<id>&status=…`, which this page reads from the Bot
 * (C18) and then removes from the address bar.
 *
 * Adapted from the standalone Bot dashboard's Settings page
 * (bot/frontend/src/pages/Settings.tsx: the security notice, the account list
 * and the MAINNET confirmation), with its stale parts fixed: the MAINNET
 * confirmation is checked by the Bot too, the API key is never typed here, and
 * "Remove" no longer claims bots "lose their credentials" — the Bot refuses
 * to remove an account anything still uses.
 */
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminOnlyPage } from "@/components/AdminOnlyPage";
import { Button, Card, CardHeader, Checkbox, Empty, Field, Loading, Notice, TextInput } from "@/components/ui";
import { botControlApi, type BotControlPanel } from "@/lib/api";
import { botManageApi, type ExchangeAccountView } from "@/lib/botManageApi";
import { fmtDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { BotShell } from "@/components/bot/BotShell";
import { OutcomeNotices } from "@/components/bot/OutcomeNotices";
import { StepUpDialog } from "@/components/bot/StepUpDialog";
import { TwoFactorBanner } from "@/components/bot/TwoFactorBanner";
import { useBotCommands } from "@/components/bot/commandRunner";
import { openBotPage } from "@/components/bot/navigate";
import { capability, capabilityNote } from "@/components/bot/botLogic";
import { useAccountBalance, useExchangeAccounts } from "@/components/bot/useAccounts";
import { SECURITY_NOTICE, enrollmentResult } from "@/components/bot/accountsCopy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Dialog =
  | { type: "add" }
  | { type: "replace"; account: ExchangeAccountView }
  | { type: "remove"; account: ExchangeAccountView };

const usd = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function BalanceCell({ accountId, enabled }: { accountId: string; enabled: boolean }) {
  const balance = useAccountBalance(accountId, enabled);
  if (!enabled) return <span className="text-ink-faint">—</span>;
  if (balance.state === "loading" || balance.state === "idle") return <span className="text-ink-faint">Reading…</span>;
  if (balance.state === "error") {
    return <span className="text-warn">{balance.code === "exchange_unavailable" ? "Exchange unavailable" : "Could not read"}</span>;
  }
  return <span className="tabular text-ink">{usd(balance.data.totalUsdt)} USDT<span className="block text-xs text-ink-faint">
    {usd(balance.data.usdtFree)} USDT free</span></span>;
}

function AccountsView() {
  const session = useSession();
  const search = useSearchParams();
  const [panel, setPanel] = useState<BotControlPanel | null>(null);
  const [panelError, setPanelError] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState("My Binance");
  const [testnet, setTestnet] = useState(true);
  const [mainnetTyped, setMainnetTyped] = useState("");
  const [landing, setLanding] = useState<{ tone: "success" | "warn" | "error"; text: string } | null>(null);
  const handledReturn = useRef(false);

  useEffect(() => {
    botControlApi.status().then((p) => { setPanel(p); setPanelError(false); }, () => setPanelError(true));
  }, []);
  const accountsCap = capability(panel, "accounts.v1");
  const enroll = capability(panel, "enroll.v1");
  const [accounts, reload] = useExchangeAccounts(accountsCap === "yes");
  const commands = useBotCommands(useCallback(() => { void reload(); }, [reload]));

  // The Bot's return: read the enrollment's real outcome, then take the query off the address bar.
  const enrollmentId = search?.get("enrollment") ?? null;
  useEffect(() => {
    if (!enrollmentId || handledReturn.current) return;
    handledReturn.current = true;
    const strip = () => {
      try { window.history.replaceState(window.history.state, "", window.location.pathname); } catch { /* best effort */ }
    };
    if (!UUID.test(enrollmentId)) { strip(); setLanding({ tone: "error", text: "That return link is not one the Bot issues." }); return; }
    void botManageApi.enrollment(enrollmentId).then(async (result) => {
      strip();
      if (!result.ok) {
        setLanding({ tone: "error", text: result.code === "enrollment_not_found"
          ? "The Bot has no record of that enrollment." : "The enrollment's outcome could not be read from the Bot. Refresh the list." });
        return;
      }
      const list = await botManageApi.accounts();
      setLanding(enrollmentResult(result.data, list.ok ? list.data.accounts : []));
      void reload();
    });
  }, [enrollmentId, reload]);

  const authOff = session !== null && !session.authEnabled;
  const channelOff = panel !== null && !panel.channel.configured;
  const blocked = authOff ? "Bot commands need sign-in to be turned on for this installation."
    : channelOff ? "Bot control channel not configured." : null;
  const twoFactorOff = session?.user ? !session.user.twoFactorEnabled : false;
  const canEnroll = blocked === null && enroll === "yes";
  const canRemove = blocked === null && accountsCap === "yes";
  const mainnetOk = mainnetTyped === "MAINNET";
  const nameOk = name.trim().length >= 1 && name.trim().length <= 64;
  const close = () => setDialog(null);

  const leave = (label: string) => (result: Record<string, unknown>) =>
    typeof result.enrollUrl === "string" && openBotPage(result.enrollUrl)
      ? `Opening the Bot's page to ${label}…`
      : "The link was issued but cannot be shown again (it is used once). Start again.";

  return (
    <BotShell section="accounts" title="Exchange accounts"
      description="The Binance accounts the Bot trades with. Keys are kept, encrypted, by the Bot only.">
      {twoFactorOff && !authOff && <TwoFactorBanner />}
      {landing && <Notice tone={landing.tone} role={landing.tone === "error" ? "alert" : "status"} onDismiss={() => setLanding(null)}>{landing.text}</Notice>}
      <OutcomeNotices outcomes={commands.outcomes} onRecheck={commands.recheck} onDismiss={commands.dismiss} />
      <Notice tone="warn"><strong>Security.</strong> {SECURITY_NOTICE}</Notice>
      {!panel && !panelError && <Loading>Reading the Bot&apos;s status…</Loading>}
      {panelError && <Notice tone="error" role="alert">The Bot&apos;s status could not be read. Reload to try again.</Notice>}
      {blocked && <Notice tone="warn">{blocked}</Notice>}
      {panel && accountsCap !== "yes" && <Notice tone="warn">{capabilityNote(accountsCap, "Listing exchange accounts from Trading Scene")}</Notice>}

      <Card>
        <CardHeader title={accounts.state === "ok" ? `Connected accounts (${accounts.data.length})` : "Connected accounts"} />
        {accounts.state === "loading" && <Loading>Reading the accounts…</Loading>}
        {accounts.state === "error" && <div className="p-3"><Notice tone="error" role="alert">The accounts could not be read from the Bot. Reload to try again.</Notice></div>}
        {accounts.state === "ok" && accounts.data.length === 0 && <Empty>No accounts connected yet.</Empty>}
        {accounts.state === "ok" && accounts.data.length > 0 && <ul className="divide-y divide-border" aria-label="Exchange accounts">
          {accounts.data.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3" data-account={a.id}>
              <div className="min-w-0">
                <span className="text-sm font-medium text-ink">{a.name}</span>{" "}
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${a.testnet ? "border-warn/30 bg-warn/10 text-warn" : "border-down/30 bg-down/10 text-down"}`}>
                  {a.testnet ? "Testnet" : "Mainnet"}</span>
                <span className="block text-xs text-ink-muted">Binance Spot · key {a.keyHint ?? "hint not recorded"} · added {fmtDateTime(a.createdAt)}</span>
                <span className="block text-xs text-ink-faint">{a.botsUsing} bot{a.botsUsing === 1 ? "" : "s"} · {a.openTrades} open trade{a.openTrades === 1 ? "" : "s"}</span>
              </div>
              <div className="text-right text-sm"><BalanceCell accountId={a.id} enabled={accountsCap === "yes"} /></div>
              <div className="flex basis-full flex-wrap gap-2 sm:basis-auto">
                <Button disabled={!canEnroll} title={!canEnroll ? blocked ?? capabilityNote(enroll, "Replacing keys") ?? undefined : undefined}
                  label={`Replace keys for ${a.name}`} onClick={() => { setMainnetTyped(""); setDialog({ type: "replace", account: a }); }}>Replace keys…</Button>
                <Button variant="danger" disabled={!canRemove} label={`Remove ${a.name}`}
                  onClick={() => setDialog({ type: "remove", account: a })}>Remove…</Button>
              </div>
            </li>
          ))}
        </ul>}
      </Card>

      <Card>
        <CardHeader title="Add an account" />
        <div className="space-y-3 px-4 py-3">
          {enroll !== "yes" && panel && <Notice tone="warn">{capabilityNote(enroll, "Adding an account through the Bot's page")}</Notice>}
          <Field label="Account name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="My Binance" className="w-64" />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink">
            <Checkbox checked={testnet} onChange={(v) => { setTestnet(v); setMainnetTyped(""); }} label="Use Binance testnet" />
            Use Binance testnet
          </label>
          {!testnet && <MainnetConfirm value={mainnetTyped} onChange={setMainnetTyped} />}
          <Button variant="primary" disabled={!canEnroll || !nameOk || (!testnet && !mainnetOk)}
            onClick={() => setDialog({ type: "add" })}>Continue on the Bot…</Button>
          <p className="text-xs text-ink-faint">You leave Trading Scene for the Bot&apos;s own page, paste the key there, and come back here.</p>
        </div>
      </Card>

      <StepUpDialog open={dialog?.type === "add"} title="Add an exchange account" confirmLabel="Open the Bot's page" tier="fresh" autoSubmit
        onCancel={close}
        intro={<><p>{name.trim()} · {testnet ? "testnet" : "MAINNET (real money)"}. Trading Scene asks the Bot for a one-time link
          (valid five minutes) and opens it.</p><p className="text-ink-muted">{SECURITY_NOTICE}</p></>}
        onConfirm={(credential) => commands.run({
          intent: `enroll:create:${name.trim()}:${testnet}`, label: "Add an exchange account",
          send: (requestId) => botManageApi.mintEnrollment(requestId, { purpose: "create", name: name.trim(), testnet,
            ...(testnet ? {} : { mainnetConfirmation: "MAINNET" as const }) }, credential),
          describe: leave("add the account"),
        })} />

      {dialog?.type === "replace" && <StepUpDialog open title={`Replace keys for ${dialog.account.name}`} confirmLabel="Open the Bot's page"
        tier="fresh" autoSubmit onCancel={close} canConfirm={dialog.account.testnet || mainnetOk}
        intro={<><p>The account keeps its network ({dialog.account.testnet ? "testnet" : "MAINNET"}) and its bots. The new key is checked
          by the Bot before the old one is replaced.</p><p className="text-ink-muted">{SECURITY_NOTICE}</p></>}
        onConfirm={(credential) => commands.run({
          intent: `enroll:replace:${dialog.account.id}`, label: `Replace keys for ${dialog.account.name}`,
          send: (requestId) => botManageApi.mintEnrollment(requestId, { purpose: "replace", accountId: dialog.account.id,
            ...(dialog.account.testnet ? {} : { mainnetConfirmation: "MAINNET" as const }) }, credential),
          describe: leave("replace the keys"),
        })}>
        {!dialog.account.testnet && <MainnetConfirm value={mainnetTyped} onChange={setMainnetTyped} />}
      </StepUpDialog>}

      {dialog?.type === "remove" && <StepUpDialog open title={`Remove ${dialog.account.name}`} confirmLabel="Remove account" danger
        tier="grant" autoSubmit onCancel={close}
        intro={<><p>The Bot deletes this account and its encrypted keys. It refuses while any bot, order or open trade still uses
          the account, so nothing is left without credentials.</p>
          {dialog.account.botsUsing > 0 && <p className="text-warn">{dialog.account.botsUsing === 1 ? "1 bot uses it" : `${dialog.account.botsUsing} bots use it`}: the Bot will refuse.</p>}</>}
        onConfirm={(credential) => commands.run({
          intent: `account_delete:${dialog.account.id}`, label: `Remove ${dialog.account.name}`,
          send: (requestId) => botManageApi.deleteAccount(requestId, dialog.account.id, credential),
          describe: () => "Removed. Its keys are deleted from the Bot.",
        })} />}
    </BotShell>
  );
}

/** The Classic dashboard's typed MAINNET confirmation; the Bot checks it again. */
function MainnetConfirm({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1 rounded-md border border-down/40 bg-down/10 p-3">
      <p className="text-sm text-down">Mainnet trades real money. Type MAINNET to confirm.</p>
      <Field label="Type MAINNET to confirm">
        <TextInput value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} className="w-40" />
      </Field>
    </div>
  );
}

export default function AccountsPage() {
  return <AdminOnlyPage title="Exchange accounts" width="narrow"><AccountsView /></AdminOnlyPage>;
}
