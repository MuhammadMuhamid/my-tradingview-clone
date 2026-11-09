"use client";
/**
 * The Bot: the administrator's operating surface for the separately deployed
 * execution Bot (BOT_CONTROL_CONTRACT v1.2).
 *
 * Every command goes browser → this Platform's admin route → a signed request
 * → the Bot, with the credential re-entered each time (`StepUpDialog`). The
 * Bot keeps the exchange keys; nothing secret ever reaches this page.
 *
 * Three habits the page keeps:
 *   - each Bot fact is shown under its own name (`BotStatusStrip`), never as
 *     one "connected = ready" badge;
 *   - an outcome nobody knows is shown as unknown and checked, never as a
 *     success or a failure (`useBotCommands`);
 *   - the Platform halt and the Bot halt are two different switches, and the
 *     page says what each one blocks.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminOnlyPage } from "@/components/AdminOnlyPage";
import {
  Button, Card, CardHeader, Checkbox, Empty, Field, Loading, Notice, Select, TextInput,
} from "@/components/ui";
import {
  api, ApiError, botControlApi,
  type BotControlPanel, type BotSummary, type BotTradesPage, type BotViewBot, type BotViewTrade,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { signClass } from "@/lib/format";
import { BotStatusStrip } from "@/components/bot/BotStatusStrip";
import { TradeCards, TradesTable, dollars, money, type TradeActions, type TradeTab } from "@/components/bot/BotTrades";
import { RiskLimitsCard } from "@/components/bot/RiskLimitsCard";
import { StepUpDialog } from "@/components/bot/StepUpDialog";
import { useBotCommands } from "@/components/bot/commandRunner";
import { useClassicBotAppearance, useLightTheme } from "@/components/bot/classicAppearance";
import {
  BOT_HALT_BLOCKS, HALT_SCOPE_TEXT, PLATFORM_HALT_BLOCKS, RECOVERY_NOTE, routingLabel, tradePanelHref,
} from "@/components/bot/botCopy";
import { BotShell } from "@/components/bot/BotShell";
import { OutcomeNotices } from "@/components/bot/OutcomeNotices";
import { BotsCard } from "@/components/bot/BotsCard";
import { EntriesCard } from "@/components/bot/EntriesCard";
import { HistorySummary } from "@/components/bot/HistorySummary";
import { PartialCloseFields } from "@/components/bot/PartialCloseFields";
import { TwoFactorBanner } from "@/components/bot/TwoFactorBanner";
import { capability, capabilityNote, closeBlockReason, startSummary } from "@/components/bot/botLogic";
import { useVisiblePolling } from "@/components/bot/polling";

const PAGE_SIZE = 50;

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The Platform's connection to the Bot being off is a setting, not an outage. */
const connectionIsOff = (error: unknown) =>
  error instanceof ApiError && error.status === 404 && /manual trading is disabled/i.test(error.message);

export function Figure({ label, value, className = "text-ink" }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={`mt-1 text-sm font-semibold tabular ${className}`}>{value}</div>
    </div>
  );
}

function Pill({ children, tone }: { children: string; tone: "warn" | "down" | "neutral" }) {
  const skin = tone === "warn" ? "border-warn/30 bg-warn/10 text-warn"
    : tone === "down" ? "border-down/30 bg-down/10 text-down" : "border-border bg-surface-2 text-ink-muted";
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${skin}`}>{children}</span>;
}

type Dialog =
  | { type: "halt" }
  | { type: "resume" }
  | { type: "bot"; bot: BotViewBot; target: "active" | "paused" }
  | { type: "close"; trade: BotViewTrade }
  | { type: "partial"; trade: BotViewTrade };

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function BotView() {
  const session = useSession();
  const [classic, setClassic] = useClassicBotAppearance();
  const lightTheme = useLightTheme();
  const [summary, setSummary] = useState<BotSummary | null>(null);
  const [bots, setBots] = useState<BotViewBot[] | null>(null);
  const [trades, setTrades] = useState<BotTradesPage | null>(null);
  const [panel, setPanel] = useState<BotControlPanel | null>(null);
  const [panelError, setPanelError] = useState<unknown>(null);
  const [tab, setTab] = useState<TradeTab>("active");
  const [botId, setBotId] = useState("");
  const [page, setPage] = useState(1);
  const [overviewError, setOverviewError] = useState<unknown>(null);
  const [tradesError, setTradesError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reason, setReason] = useState("");
  const [pct, setPct] = useState(50);
  // A slower older answer must not replace what the newest request asked for.
  const latestTrades = useRef(0);
  const view = useRef({ tab, botId, page });
  view.current = { tab, botId, page };

  const loadTrades = useCallback(async (next: { tab: TradeTab; botId: string; page: number }) => {
    const request = ++latestTrades.current;
    try {
      const result = await api.botTrades({ status: next.tab, botId: next.botId || undefined, page: next.page, pageSize: PAGE_SIZE });
      if (request !== latestTrades.current) return;
      setTrades(result);
      setTradesError(null);
    } catch (error) {
      if (request === latestTrades.current) setTradesError(error);
    }
  }, []);

  const loadPanel = useCallback(async () => {
    try {
      setPanel(await botControlApi.status());
      setPanelError(null);
    } catch (error) {
      setPanelError(error);
    }
  }, []);

  /** `silent`: the 15 s auto-refresh, which never shows "Loading…" or clears what is shown. */
  const loadAll = useCallback(async (next: { tab: TradeTab; botId: string; page: number }, silent = false) => {
    if (!silent) setLoading(true);
    const [overview] = await Promise.all([
      Promise.all([api.botSummary(), api.botList()]).then(
        ([nextSummary, nextBots]) => ({ nextSummary, nextBots, error: null as unknown }),
        (error: unknown) => ({ nextSummary: null, nextBots: null, error }),
      ),
      loadTrades(next),
      loadPanel(),
    ]);
    setOverviewError(overview.error);
    if (overview.nextSummary) setSummary(overview.nextSummary);
    if (overview.nextBots) setBots(overview.nextBots);
    if (!silent) setLoading(false);
  }, [loadTrades, loadPanel]);

  useEffect(() => { void loadAll({ tab: "active", botId: "", page: 1 }); }, [loadAll]);

  const refreshAfterCommand = useCallback(() => { void loadAll(view.current); }, [loadAll]);
  const commands = useBotCommands(refreshAfterCommand);
  // P-21: silent, every 15 s, only while the tab is visible.
  useVisiblePolling(() => { void loadAll(view.current, true); }, session !== null);

  const showTrades = (next: { tab?: TradeTab; botId?: string; page?: number }) => {
    const target = { tab: next.tab ?? tab, botId: next.botId ?? botId, page: next.page ?? 1 };
    setTab(target.tab); setBotId(target.botId); setPage(target.page);
    setTrades(null);
    void loadTrades(target);
  };

  // ── can commands be sent at all? ─────────────────────────────────────────
  const authOff = session !== null && !session.authEnabled;
  const isAdmin = session?.user?.role === "admin" || authOff;
  const channelOff = panel !== null && !panel.channel.configured;
  const commandsBlocked = authOff ? "Bot commands need sign-in to be turned on for this installation."
    : channelOff ? "Bot control channel not configured." : null;
  const canCommand = isAdmin && commandsBlocked === null && panel !== null;

  const facts = panel?.facts ?? null;
  const halted = facts?.halt.halted ?? null;
  const unreachable = overviewError && !connectionIsOff(overviewError);
  const off = connectionIsOff(overviewError);
  const lastPage = trades ? Math.max(1, Math.ceil(trades.total / trades.pageSize)) : 1;
  const close = () => setDialog(null);

  const operatorExit = capability(panel, "operatorExit.v1");
  const manageBots = capability(panel, "bots.v1");
  const twoFactorOff = session?.user ? !session.user.twoFactorEnabled : false;
  const tradeActions: TradeActions = {
    enabled: canCommand, disabledReason: commandsBlocked ?? undefined,
    close: (trade) => setDialog({ type: "close", trade }),
    partial: (trade) => { setPct(50); setDialog({ type: "partial", trade }); },
    closeBlocked: (trade) => closeBlockReason(trade, bots, trades?.rows ?? [], operatorExit),
  };

  const pctValid = Number.isInteger(pct) && pct >= 1 && pct <= 99;

  return (
    /*
     * The classic preference recolours this wrapper and nothing outside it: the
     * Nav keeps the Platform skin, and an account that is not the
     * administrator never mounts it.
     */
    <BotShell section="overview" classic={classic} title="Bot"
      description="Operate the execution Bot: its halt, new entries, risk limits, bots and strategy trades. Exchange keys stay on the Bot. Refreshes every 15 seconds while this tab is open."
      actions={<Button onClick={() => void loadAll({ tab, botId, page })} disabled={loading}>
        {loading ? "Loading…" : "Refresh"}
      </Button>}>
      {isAdmin && twoFactorOff && !authOff && <TwoFactorBanner />}

      <OutcomeNotices outcomes={commands.outcomes} onRecheck={commands.recheck} onDismiss={commands.dismiss} />

      {/* ── status ───────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Bot status" right={panel ? <span className="text-xs text-ink-faint">Read {new Date(panel.readAt).toLocaleTimeString()}</span> : undefined} />
        <div className="px-4 py-3">
          {panel ? <BotStatusStrip panel={panel} />
            : panelError ? <Notice tone="error" role="alert"><span title={messageOf(panelError)}>The Bot's status could not be read. Refresh to try again.</span></Notice>
              : <Loading>Reading the Bot's status…</Loading>}
        </div>
      </Card>

      {commandsBlocked && <Notice tone="warn">{commandsBlocked} The controls below are off; everything is still shown.</Notice>}

      {/* ── the two halt switches ────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Halt" right={isAdmin ? <div className="flex flex-wrap gap-2">
          {halted !== false && <Button disabled={!canCommand} title={commandsBlocked ?? undefined}
            onClick={() => setDialog({ type: "resume" })}>Resume Bot…</Button>}
          <Button variant="danger" disabled={!canCommand} title={commandsBlocked ?? undefined}
            onClick={() => { setReason(""); setDialog({ type: "halt" }); }}>Halt Bot…</Button>
        </div> : undefined} />
        <div className="space-y-3 px-4 py-3">
          {halted && <Notice tone="error" role="status">
            The Bot is halted{facts?.halt.haltedBy ? ` by ${facts.halt.haltedBy === "daily_loss" ? "the daily-loss limit" : facts.halt.haltedBy}` : ""}.
            {" "}TP/SL protection is NOT being checked.
          </Notice>}
          <p className="text-sm text-ink">{HALT_SCOPE_TEXT}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <h3 className="text-sm font-semibold text-ink">Bot halt <span className="font-normal text-ink-muted">· {halted === null ? "unknown" : halted ? "halted" : "not halted"}</span></h3>
              <p className="mt-1 text-xs text-ink-muted">{BOT_HALT_BLOCKS}</p>
              <p className="mt-1 text-xs text-ink-faint">Switched here.</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <h3 className="text-sm font-semibold text-ink">Platform halt <span className="font-normal text-ink-muted">· {panel?.platformHalt ? (panel.platformHalt.halted ? "halted" : "not halted") : "unknown"}</span></h3>
              <p className="mt-1 text-xs text-ink-muted">{PLATFORM_HALT_BLOCKS}</p>
              <p className="mt-1 text-xs text-ink-faint">A separate switch, on <Link href="/operations" className="underline">Operations</Link>.</p>
            </div>
          </div>
        </div>
      </Card>

      <EntriesCard panel={panel} isAdmin={isAdmin} canCommand={canCommand} commandsBlocked={commandsBlocked}
        twoFactorEnabled={!twoFactorOff} onChanged={refreshAfterCommand} />

      <RiskLimitsCard risk={facts?.risk ?? null} disabled={!canCommand} disabledReason={commandsBlocked ?? undefined}
        onSubmit={(patch, credential) => commands.run({
          intent: `risk_limits:bot:${JSON.stringify(patch)}`, label: "Risk limits",
          send: (requestId) => botControlApi.setRiskLimits(requestId, patch, credential),
          describe: (result) => `Limits saved.${result.latched === true ? " The daily-loss latch is still set; resume separately." : ""}`,
        })} />

      {off && <Notice>
        The Bot&apos;s read-only views are off on this installation (manual trading connection). Status, halt and limits above still work.
      </Notice>}
      {!!unreachable && <Notice tone="error" role="alert">
        <span title={messageOf(overviewError)}>
          Bot unreachable. The figures below may be out of date, or missing. Open trades keep running on the Bot.
        </span>
      </Notice>}
      {loading && !summary && !overviewError && <Loading>Reading the Bot…</Loading>}

      {summary && <Card>
        <CardHeader title="Overview" right={<div className="flex flex-wrap gap-1.5">
          {(facts?.dryRun ?? summary.mode.dryRun) && <Pill tone="warn">Dry run (simulated)</Pill>}
          {facts ? <Pill tone={facts.exchange.routing === "MAINNET" ? "down" : facts.exchange.routing === "MIXED" ? "warn" : "neutral"}>
            {routingLabel(facts.exchange.routing)}</Pill>
            : <span title={`The per-account routing could not be read. The Bot's process default is ${summary.mode.binanceTestnet ? "testnet" : "mainnet"}.`}>
              <Pill tone="warn">Routing unknown</Pill></span>}
        </div>} />
        <div className="grid grid-cols-2 divide-border sm:grid-cols-3 lg:grid-cols-6">
          <Figure label="Open P&L" value={money(summary.stats.upnl)} className={signClass(summary.stats.upnl)} />
          <Figure label="Realized P&L" value={money(summary.stats.totalRealizedPnl)} className={signClass(summary.stats.totalRealizedPnl)} />
          <Figure label="Realized today" value={money(summary.stats.todayPnl)} className={signClass(summary.stats.todayPnl)} />
          <Figure label="In open trades" value={dollars(summary.stats.locked)} />
          <Figure label="Trades" value={`${summary.stats.activeCount} open · ${summary.stats.closedCount} closed`} />
          <Figure label="Bots" value={`${summary.stats.activeBotCount} active · ${summary.stats.stoppedBotCount} stopped`} />
        </div>
      </Card>}

      {bots && <BotsCard bots={bots} isAdmin={isAdmin} canCommand={canCommand} commandsBlocked={commandsBlocked}
        canManage={manageBots === "yes"} manageNote={capabilityNote(manageBots, "Creating and editing bots from Trading Scene")}
        onToggle={(bot) => setDialog({ type: "bot", bot, target: bot.status === "active" ? "paused" : "active" })} />}

      {!off && <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div role="group" aria-label="Trades" className="flex gap-1">
            {(["active", "closed"] as const).map((value) => (
              <Button key={value} pressed={tab === value} variant="ghost"
                onClick={() => showTrades({ tab: value })} className="min-h-11 sm:min-h-0">
                {value === "active" ? "Open trades" : "Trade history"}
              </Button>
            ))}
          </div>
          {bots && bots.length > 1 && <label className="flex items-center gap-2 text-xs text-ink-muted">
            Bot
            <Select className="min-h-11 sm:min-h-0" value={botId} onChange={(event) => showTrades({ botId: event.target.value })}>
              <option value="">All bots</option>
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </Select>
          </label>}
        </div>
        {!!tradesError && !unreachable && <div className="p-3"><Notice tone="error" role="alert">
          <span title={messageOf(tradesError)}>The trades could not be read from the Bot. Refresh to try again.</span>
        </Notice></div>}
        {!trades && !tradesError && <div className="p-3"><Loading>Reading trades…</Loading></div>}
        {trades && (trades.rows.length === 0
          ? <Empty>{tab === "active" ? "No open trades." : "No closed trades yet."}</Empty>
          : <>
            {tab === "closed" && <HistorySummary rows={trades.rows} total={trades.total} />}
            <TradesTable tab={tab} rows={trades.rows} actions={tradeActions} />
            <TradeCards tab={tab} rows={trades.rows} actions={tradeActions} />
          </>)}
        {trades && trades.total > trades.pageSize && <div className="flex items-center justify-between border-t border-border px-3 py-2 sm:px-4">
          <Button variant="ghost" disabled={page <= 1} onClick={() => showTrades({ page: page - 1 })} className="min-h-11 sm:min-h-0">Previous</Button>
          <span className="text-xs text-ink-faint">Page {page} of {lastPage}</span>
          <Button variant="ghost" disabled={page >= lastPage} onClick={() => showTrades({ page: page + 1 })} className="min-h-11 sm:min-h-0">Next</Button>
        </div>}
      </Card>}

      <footer className="space-y-2 border-t border-border pt-3 text-xs text-ink-faint">
        <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
          <Checkbox checked={classic} onChange={setClassic} label="Classic Bot appearance" disabled={lightTheme} />
          <span>Classic Bot appearance</span>
          <span className="text-xs text-ink-faint">
            {lightTheme ? "Dark theme only: no effect in the light theme. Your choice is kept." : "(this page, dark theme only)"}
          </span>
        </label>
        <p>{RECOVERY_NOTE}</p>
        {trades && trades.rows.length > 0 && <p>{trades.total} {tab === "active" ? "open" : "closed"} trade{trades.total === 1 ? "" : "s"} ·
          P&amp;L is net of the fees the Bot recorded from the fills · refreshed every 15 seconds while this tab is open.</p>}
      </footer>

      {/* ── dialogs ──────────────────────────────────────────────────────── */}
      <StepUpDialog open={dialog?.type === "halt"} title="Halt the Bot" confirmLabel="Halt Bot" danger allowsPassword tier="grant" autoSubmit
        canConfirm={reason.trim().length >= 3 && reason.trim().length <= 200} onCancel={close}
        intro={<><p>{HALT_SCOPE_TEXT}</p><p className="text-ink-muted">An existing halt is never overwritten; a daily-loss latch stays a daily-loss latch.</p></>}
        onConfirm={(credential) => commands.run({
          intent: `halt:bot:${reason.trim()}`, label: "Halt the Bot",
          send: (requestId) => botControlApi.halt(requestId, reason.trim(), credential),
          describe: (result) => result.alreadyHalted === true
            ? "The Bot was already halted; the existing halt was kept."
            : "The Bot is halted. TP/SL protection is not being checked until you resume.",
        })}>
        <Field label="Reason for halting" help="3 to 200 characters. Whoever finds the Bot halted needs to know why.">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className="w-full" />
        </Field>
      </StepUpDialog>

      <StepUpDialog open={dialog?.type === "resume"} title="Resume the Bot" confirmLabel="Resume Bot" tier="grant" autoSubmit onCancel={close}
        intro={<><p>Automation starts again in both directions: signals, TradingView exits and the TP/SL monitors.</p>
          {facts?.risk.latched && <p className="text-warn">The daily-loss limit latched this halt. The Bot refuses to resume while the loss is still at the limit.</p>}</>}
        onConfirm={(credential) => commands.run({
          intent: "resume:bot", label: "Resume the Bot",
          send: (requestId) => botControlApi.resume(requestId, credential),
          describe: () => "The Bot resumed. TP/SL protection is being checked again.",
        })} />

      {dialog?.type === "bot" && <StepUpDialog open tier="grant" autoSubmit title={`${dialog.target === "active" ? "Start" : "Stop"} ${dialog.bot.name}`}
        confirmLabel={dialog.target === "active" ? "Start bot" : "Stop bot"} danger={dialog.target === "paused"} onCancel={close}
        intro={dialog.target === "active"
          ? <StartIntro bot={dialog.bot} dryRun={facts?.dryRun ?? null} />
          : <p>The bot stops acting on signals. Its open trades keep their TP/SL. {operatorExit === "yes"
            ? "Close and Partial still work on its trades from here."
            : "Closing one of its trades from here needs the bot running; Partial still works."}</p>}
        onConfirm={(credential) => commands.run({
          intent: `bot_status:${dialog.bot.id}:${dialog.target}`, label: `${dialog.target === "active" ? "Start" : "Stop"} ${dialog.bot.name}`,
          send: (requestId) => botControlApi.setBotStatus(requestId, dialog.bot.id, dialog.target, credential),
          describe: (result) => {
            const pending = num(result.unresolvedIntents);
            if (result.changed === false) return `It was already ${dialog.target === "active" ? "running" : "stopped"}.`;
            return dialog.target === "active"
              ? `Started. ${pending === null ? "The Bot did not report" : pending} unresolved intent${pending === 1 ? "" : "s"} for this bot.`
              : "Stopped.";
          },
        })} />}

      {dialog?.type === "close" && <StepUpDialog open tier="grant" autoSubmit title={`Close ${dialog.trade.pair}`} confirmLabel="Close trade" danger onCancel={close}
        intro={<><p>Sells this strategy trade&apos;s whole quantity at market through the Bot&apos;s normal exit path. It works while the Bot is halted.</p>
          <p className="text-ink-muted">{dialog.trade.botName ?? "Bot"} · {dialog.trade.pair} · quantity {dialog.trade.quantity}</p></>}
        onConfirm={(credential) => commands.run({
          intent: `trade_close:${dialog.trade.id}`, label: `Close ${dialog.trade.pair}`,
          chartHref: tradePanelHref(dialog.trade.pair),
          send: (requestId) => botControlApi.closeTrade(requestId, dialog.trade.id, credential),
          describe: (result) => result.status === "ignored_duplicate"
            ? "A close for this trade was already under way; no new order was placed."
            : "The close went through the Bot's exit path.",
        })} />}

      {dialog?.type === "partial" && <StepUpDialog open tier="grant" autoSubmit title={`Partial close ${dialog.trade.pair}`} confirmLabel={`Sell ${pct}%`} danger
        canConfirm={pctValid} onCancel={close}
        intro={<p>Sells part of this strategy trade at market through the Bot&apos;s partial-close path. It works while the Bot is halted.</p>}
        onConfirm={(credential) => commands.run({
          intent: `trade_partial_close:${dialog.trade.id}:${pct}`, label: `Partial close ${dialog.trade.pair}`,
          chartHref: tradePanelHref(dialog.trade.pair),
          send: (requestId) => botControlApi.partialCloseTrade(requestId, dialog.trade.id, pct, credential),
          describe: (result) => {
            const executed = num(result.executedQty);
            const requested = num(result.requestedQty);
            return executed !== null && requested !== null ? `Sold ${executed} of the ${requested} requested.` : "The partial close went through.";
          },
        })}>
        <PartialCloseFields trade={dialog.trade} pct={pct} onChange={setPct} />
      </StepUpDialog>}
    </BotShell>
  );
}

/** What starting a bot arms (the Classic confirmation's summary, without `window.confirm`). */
function StartIntro({ bot, dryRun }: { bot: BotViewBot; dryRun: boolean | null }) {
  const summary = startSummary(bot);
  return (
    <>
      <p>The bot acts on signals again. Signals queued while it was stopped (unresolved intents) may run once it starts; the Bot reports how many.</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border p-3 text-xs" aria-label="What starting arms">
        <dt className="text-ink-muted">Pairs</dt><dd className="text-ink">{summary.pairs}</dd>
        <dt className="text-ink-muted">Size</dt><dd className="text-ink">{summary.size}</dd>
        <dt className="text-ink-muted">Guards</dt>
        <dd className="text-ink">{summary.guards.map((g, i) => <span key={g.text} className={g.missing ? "font-semibold text-down" : undefined}>
          {i > 0 ? ", " : ""}{g.text}</span>)}</dd>
      </dl>
      <p className={dryRun === false ? "text-warn" : "text-ink-muted"}>
        {dryRun === true ? "The Bot is in dry run: signals are simulated, no exchange order is placed."
          : dryRun === false ? "Once started, an incoming signal places a real Binance Spot order."
            : "The Bot's mode could not be read: assume an incoming signal places a real Binance Spot order."}
      </p>
    </>
  );
}

/** An ordinary account is told this page is the administrator's; the page is not mounted. */
export default function BotPage() {
  return <AdminOnlyPage title="Bot" width="narrow"><BotView /></AdminOnlyPage>;
}
