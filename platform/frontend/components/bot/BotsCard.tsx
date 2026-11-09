"use client";
/**
 * The bots, as the Classic dashboard's "Your Bots" table showed them: status,
 * pairs, account, investment, profit, open trades against the cap, signals
 * and age, with All / Active / Stopped chips. A table on a wide screen, cards
 * on a phone (both in the document; CSS shows one).
 *
 * Adapted from bot/frontend/src/pages/Dashboard.tsx (`BotRow`, the filter
 * chips and the empty state), restyled onto the Platform's tokens.
 */
import Link from "next/link";
import { useState } from "react";
import { Button, Card, CardHeader, Empty, StatusBadge } from "@/components/ui";
import type { BotViewBot } from "@/lib/api";
import { signClass } from "@/lib/format";
import { fmtDuration, pairsPreview, tradesCap } from "./botLogic";
import { money } from "./BotTrades";

export type BotFilter = "all" | "active" | "stopped";

export function botSettings(bot: BotViewBot): string {
  const parts: string[] = [];
  parts.push(bot.takeProfitPct === null ? "No take profit" : `Take profit ${bot.takeProfitPct}%`);
  parts.push(bot.stopLossPct === null ? "No stop loss" : `Stop loss ${bot.stopLossPct}%`);
  if (!bot.entryEnabled) parts.push("Entries off");
  if (!bot.exitEnabled) parts.push("Exits off");
  if (bot.maxEntryOrders !== null) parts.push(`Max ${bot.maxEntryOrders} per pair`);
  return parts.join(" · ");
}

const accountOf = (bot: BotViewBot) =>
  bot.account ? `${bot.account.name}${bot.account.testnet ? " (testnet)" : " (mainnet)"}` : "No account";

export function BotsCard({ bots, isAdmin, canCommand, commandsBlocked, canManage, manageNote, onToggle }: {
  bots: BotViewBot[];
  isAdmin: boolean;
  canCommand: boolean;
  commandsBlocked: string | null;
  /** The Bot supports create/edit (`bots.v1`). */
  canManage: boolean;
  manageNote: string | null;
  onToggle: (bot: BotViewBot) => void;
}) {
  const [filter, setFilter] = useState<BotFilter>("all");
  const counts = { all: bots.length, active: bots.filter((b) => b.status === "active").length,
    stopped: bots.filter((b) => b.status !== "active").length };
  const shown = bots.filter((b) => filter === "all" || (filter === "active" ? b.status === "active" : b.status !== "active"));
  const toggle = (bot: BotViewBot) => isAdmin && <Button disabled={!canCommand} title={commandsBlocked ?? undefined}
    label={`${bot.status === "active" ? "Stop" : "Start"} ${bot.name}`} onClick={() => onToggle(bot)}>
    {bot.status === "active" ? "Stop…" : "Start…"}</Button>;
  const edit = (bot: BotViewBot) => canManage
    ? <Link href={`/bot/bots/${encodeURIComponent(bot.id)}`} aria-label={`Edit ${bot.name}`}
      className="inline-flex min-h-11 items-center text-sm text-ink-muted underline hover:text-ink sm:min-h-0">Edit</Link>
    : null;

  return (
    <Card>
      <CardHeader title={`Bots (${bots.length})`} right={<div className="flex flex-wrap items-center gap-2">
        {bots.length > 0 && <div role="group" aria-label="Show bots" className="flex gap-1">
          {(["all", "active", "stopped"] as const).map((value) => (
            <Button key={value} variant="ghost" pressed={filter === value} onClick={() => setFilter(value)} className="min-h-11 sm:min-h-0"
              label={`Show ${value === "all" ? "all" : value} bots (${counts[value]})`}>
              {value === "all" ? "All" : value === "active" ? "Active" : "Stopped"} ({counts[value]})
            </Button>
          ))}
        </div>}
        {canManage && <Link href="/bot/bots/new" className="inline-flex h-[34px] items-center rounded-md border border-control-border px-3 text-sm font-medium text-ink tvc-control">Create bot</Link>}
      </div>} />
      {bots.length === 0 ? (
        <Empty>
          <span className="block">No bots yet.</span>
          {canManage
            ? <Link href="/bot/bots/new" className="mt-2 inline-flex h-[34px] items-center rounded-md border border-control-border px-3 text-sm font-medium text-ink tvc-control">Create a signal bot</Link>
            : <span className="mt-1 block text-xs">{manageNote ?? "Bots are created on the Bot's own dashboard."}</span>}
        </Empty>
      ) : shown.length === 0 ? <Empty>No {filter} bots.</Empty> : (
        <>
          <div className="relative hidden overflow-x-auto sm:block" data-bots-layout="desktop">
            <table className="w-full min-w-[760px] text-sm tabular">
              <thead>
                <tr className="border-b border-border text-xs text-ink-muted">
                  <th className="px-3 py-1.5 text-left">Bot</th>
                  <th className="px-3 py-1.5 text-left">Exchange</th>
                  <th className="px-3 py-1.5 text-left">Investment</th>
                  <th className="px-3 py-1.5 text-right">Total profit</th>
                  <th className="px-3 py-1.5 text-right">Trades</th>
                  <th className="px-3 py-1.5 text-right">Signals</th>
                  <th className="px-3 py-1.5 text-right">Age</th>
                  <th className="px-3 py-1.5 text-left">Status</th>
                  <th className="px-3 py-1.5 text-right"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((bot) => (
                  <tr key={bot.id} className="border-b border-border align-top last:border-b-0" data-bot-row={bot.id}>
                    <td className="px-3 py-1.5">
                      <span className="font-medium text-ink">{bot.name}</span>
                      <span className="block text-xs text-ink-muted">{pairsPreview(bot.pairs)}</span>
                      <span className="block text-xs text-ink-faint">{botSettings(bot)}</span>
                    </td>
                    <td className={`px-3 py-1.5 ${bot.account ? "text-ink-muted" : "text-warn"}`}>{accountOf(bot)}</td>
                    <td className="px-3 py-1.5 text-ink-muted">{bot.investment}</td>
                    <td className={`px-3 py-1.5 text-right ${signClass(bot.realizedPnl)}`}>{money(bot.realizedPnl)}</td>
                    <td className="px-3 py-1.5 text-right text-ink">{tradesCap(bot)}<span className="block text-xs text-ink-faint">{bot.closedTrades} closed</span></td>
                    <td className="px-3 py-1.5 text-right text-ink-muted">{bot.signalCount}</td>
                    <td className="px-3 py-1.5 text-right text-ink-muted" title={`Created ${bot.createdAt}`}>{fmtDuration(bot.createdAt)}</td>
                    <td className="px-3 py-1.5"><StatusBadge status={bot.status === "active" ? "active" : "stopped"} /></td>
                    <td className="px-3 py-1.5 text-right"><span className="inline-flex items-center gap-3">{edit(bot)}{toggle(bot)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border sm:hidden" data-bots-layout="phone" aria-label="Bots">
            {shown.map((bot) => (
              <li key={bot.id} className="space-y-1.5 px-4 py-3" data-bot-card={bot.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-medium text-ink">{bot.name}</span>
                    <StatusBadge status={bot.status === "active" ? "active" : "stopped"} /></span>
                  <span className={`text-sm font-semibold tabular ${signClass(bot.realizedPnl)}`}>{money(bot.realizedPnl)}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs tabular">
                  <dt className="text-ink-muted">Pairs</dt><dd className="truncate text-right text-ink">{pairsPreview(bot.pairs)}</dd>
                  <dt className="text-ink-muted">Exchange</dt><dd className="truncate text-right text-ink">{accountOf(bot)}</dd>
                  <dt className="text-ink-muted">Investment</dt><dd className="text-right text-ink">{bot.investment}</dd>
                  <dt className="text-ink-muted">Trades</dt><dd className="text-right text-ink">{tradesCap(bot)} · {bot.closedTrades} closed</dd>
                  <dt className="text-ink-muted">Signals · age</dt><dd className="text-right text-ink">{bot.signalCount} · {fmtDuration(bot.createdAt)}</dd>
                </dl>
                <p className="text-xs text-ink-faint">{botSettings(bot)}</p>
                <div className="flex items-center gap-3">{edit(bot)}{toggle(bot)}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
