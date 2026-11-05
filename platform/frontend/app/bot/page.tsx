"use client";
import { AdminOnlyPage } from "@/components/AdminOnlyPage";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Empty, Loading, Notice, PageHeader, PageShell, Select, StatusBadge } from "@/components/ui";
import { api, ApiError, type BotSummary, type BotTradesPage, type BotViewBot, type BotViewTrade } from "@/lib/api";
import { fmtDateTime, fmtPct, fmtPrice, fmtQty, signClass, LOCAL_TIME_NOTE } from "@/lib/format";

const PAGE_SIZE = 50;

type TradeTab = "active" | "closed";

function money(value: number): string {
  return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

const dollars = (value: number) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The Platform's connection to the Bot being off is a setting, not an outage. */
const connectionIsOff = (error: unknown) =>
  error instanceof ApiError && error.status === 404 && /manual trading is disabled/i.test(error.message);

function modeLabel(mode: BotSummary["mode"]): { text: string; className: string } {
  if (mode.dryRun) return { text: "Paper simulation", className: "border-warn/30 bg-warn/10 text-warn" };
  if (mode.binanceTestnet) return { text: "Testnet", className: "border-accent/30 bg-accent/10 text-accent" };
  return { text: "Mainnet", className: "border-down/30 bg-down/10 text-down" };
}

function Figure({ label, value, className = "text-ink" }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={`mt-1 text-sm font-semibold tabular ${className}`}>{value}</div>
    </div>
  );
}

function botSettings(bot: BotViewBot): string {
  const parts = [bot.investment];
  parts.push(bot.takeProfitPct === null ? "No take profit" : `Take profit ${bot.takeProfitPct}%`);
  parts.push(bot.stopLossPct === null ? "No stop loss" : `Stop loss ${bot.stopLossPct}%`);
  if (!bot.entryEnabled) parts.push("Entries off");
  if (!bot.exitEnabled) parts.push("Exits off");
  if (bot.maxEntryOrders !== null) parts.push(`Max ${bot.maxEntryOrders} per pair`);
  if (bot.maxActiveSmartTrades !== null) parts.push(`Max ${bot.maxActiveSmartTrades} open`);
  return parts.join(" · ");
}

function BotsCard({ bots }: { bots: BotViewBot[] }) {
  return (
    <Card>
      <div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold text-ink">Bots</h2></div>
      {bots.length === 0 ? <Empty>No bots yet. Bots are created on the Bot&apos;s own dashboard.</Empty> : (
        <div className="divide-y divide-border">
          {bots.map((bot) => (
            <div key={bot.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{bot.name}</span>
                  <StatusBadge status={bot.status} />
                </div>
                <span className={`text-sm tabular ${signClass(bot.realizedPnl)}`}>{money(bot.realizedPnl)}</span>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                {bot.pairs.join(", ") || "No pairs"} · {bot.activeTrades} open · {bot.closedTrades} closed · {bot.signalCount} signals
                {" · "}{bot.account ? `${bot.account.name}${bot.account.testnet ? " (testnet)" : ""}` : "No account"}
              </p>
              <p className="mt-0.5 text-xs text-ink-faint">{botSettings(bot)}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const tradeOwner = (trade: BotViewTrade) =>
  trade.source === "manual" ? "Manual" : trade.botName ?? "Deleted bot";

function TradesTable({ tab, rows }: { tab: TradeTab; rows: BotViewTrade[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm tabular">
        <thead>
          <tr className="border-b border-border text-xs text-ink-muted">
            <th className="px-3 py-1.5 text-left">Pair</th>
            <th className="px-3 py-1.5 text-left">Bot</th>
            <th className="px-3 py-1.5 text-right">Entry</th>
            {tab === "active" && <th className="px-3 py-1.5 text-right">Current</th>}
            <th className="px-3 py-1.5 text-right">Quantity</th>
            <th className="px-3 py-1.5 text-right">Spent</th>
            <th className="px-3 py-1.5 text-right">P&amp;L</th>
            <th className="px-3 py-1.5 text-left">{tab === "active" ? "Opened" : "Closed"}</th>
            {tab === "closed" && <th className="px-3 py-1.5 text-left">Reason</th>}
            <th className="px-3 py-1.5 text-left">Order id</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((trade) => (
            <tr key={trade.id} className="border-b border-border last:border-b-0">
              <td className="px-3 py-1.5 font-medium text-ink">{trade.pair}</td>
              <td className="px-3 py-1.5 text-ink-muted">{tradeOwner(trade)}</td>
              <td className="px-3 py-1.5 text-right">{fmtPrice(trade.entryPrice)}</td>
              {tab === "active" && <td className="px-3 py-1.5 text-right">{fmtPrice(trade.currentPrice)}</td>}
              <td className="px-3 py-1.5 text-right">{fmtQty(trade.quantity)}</td>
              <td className="px-3 py-1.5 text-right">{dollars(trade.quoteSpent)}</td>
              <td className={`px-3 py-1.5 text-right ${signClass(trade.pnlUsdt)}`}>
                {money(trade.pnlUsdt)} ({fmtPct(trade.pnlPct)})
              </td>
              <td className="px-3 py-1.5 text-ink-muted">
                {fmtDateTime(tab === "active" ? trade.createdAt : trade.closedAt)}
              </td>
              {tab === "closed" && <td className="px-3 py-1.5 text-ink-muted">{trade.closedReason ?? "—"}</td>}
              <td className="px-3 py-1.5 text-ink-muted">{trade.exchangeOrderId ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BotView() {
  const [summary, setSummary] = useState<BotSummary | null>(null);
  const [bots, setBots] = useState<BotViewBot[] | null>(null);
  const [trades, setTrades] = useState<BotTradesPage | null>(null);
  const [tab, setTab] = useState<TradeTab>("active");
  const [botId, setBotId] = useState("");
  const [page, setPage] = useState(1);
  const [overviewError, setOverviewError] = useState<unknown>(null);
  const [tradesError, setTradesError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  // A slower older answer must not replace what the newest request asked for.
  const latestTrades = useRef(0);

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

  const loadAll = useCallback(async (next: { tab: TradeTab; botId: string; page: number }) => {
    setLoading(true);
    const [overview] = await Promise.all([
      Promise.all([api.botSummary(), api.botList()]).then(
        ([nextSummary, nextBots]) => ({ nextSummary, nextBots, error: null as unknown }),
        (error: unknown) => ({ nextSummary: null, nextBots: null, error }),
      ),
      loadTrades(next),
    ]);
    setOverviewError(overview.error);
    if (overview.nextSummary) setSummary(overview.nextSummary);
    if (overview.nextBots) setBots(overview.nextBots);
    setLoading(false);
  }, [loadTrades]);

  useEffect(() => { void loadAll({ tab: "active", botId: "", page: 1 }); }, [loadAll]);

  const showTrades = (next: { tab?: TradeTab; botId?: string; page?: number }) => {
    const target = { tab: next.tab ?? tab, botId: next.botId ?? botId, page: next.page ?? 1 };
    setTab(target.tab); setBotId(target.botId); setPage(target.page);
    setTrades(null);
    void loadTrades(target);
  };

  const refresh = <Button onClick={() => void loadAll({ tab, botId, page })} disabled={loading}>
    {loading ? "Loading…" : "Refresh"}
  </Button>;
  const mode = summary ? modeLabel(summary.mode) : null;
  const unreachable = overviewError && !connectionIsOff(overviewError);
  const off = connectionIsOff(overviewError);
  const lastPage = trades ? Math.max(1, Math.ceil(trades.total / trades.pageSize)) : 1;

  return (
    <PageShell width="narrow">
      <header>
        <PageHeader
          title="Bot"
          description="What the execution Bot holds: its bots, open trades and results. This page only reads. Bots, exchange keys and settings are managed on the Bot's own dashboard."
          actions={refresh}
        />
        <p className="mt-1 text-xs text-ink-faint">{LOCAL_TIME_NOTE}</p>
      </header>

      {off && <Notice>
        The Bot connection is off on this installation. Set the manual trading connection on the Platform to see the Bot here.
      </Notice>}
      {!!unreachable && <Notice tone="error" role="alert">
        <span title={messageOf(overviewError)}>
          Bot unreachable. The figures below may be out of date, or missing. Open trades keep running on the Bot.
        </span>
      </Notice>}
      {loading && !summary && !overviewError && <Loading>Reading the Bot…</Loading>}

      {summary && mode && <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Overview</h2>
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${mode.className}`}>{mode.text}</span>
        </div>
        <div className="grid grid-cols-2 divide-border sm:grid-cols-3 lg:grid-cols-6">
          <Figure label="Open P&L" value={money(summary.stats.upnl)} className={signClass(summary.stats.upnl)} />
          <Figure label="Realized P&L" value={money(summary.stats.totalRealizedPnl)} className={signClass(summary.stats.totalRealizedPnl)} />
          <Figure label="Realized today" value={money(summary.stats.todayPnl)} className={signClass(summary.stats.todayPnl)} />
          <Figure label="In open trades" value={dollars(summary.stats.locked)} />
          <Figure label="Trades" value={`${summary.stats.activeCount} open · ${summary.stats.closedCount} closed`} />
          <Figure label="Bots" value={`${summary.stats.activeBotCount} active · ${summary.stats.stoppedBotCount} stopped`} />
        </div>
      </Card>}

      {bots && <BotsCard bots={bots} />}

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
          : <TradesTable tab={tab} rows={trades.rows} />)}
        {trades && trades.total > trades.pageSize && <div className="flex items-center justify-between border-t border-border px-3 py-2 sm:px-4">
          <Button variant="ghost" disabled={page <= 1} onClick={() => showTrades({ page: page - 1 })} className="min-h-11 sm:min-h-0">Previous</Button>
          <span className="text-xs text-ink-faint">Page {page} of {lastPage}</span>
          <Button variant="ghost" disabled={page >= lastPage} onClick={() => showTrades({ page: page + 1 })} className="min-h-11 sm:min-h-0">Next</Button>
        </div>}
      </Card>}
    </PageShell>
  );
}

/** An ordinary account is told this page is the administrator's; the page is not mounted. */
export default function BotPage() {
  return <AdminOnlyPage title="Bot" width="narrow"><BotView /></AdminOnlyPage>;
}
