"use client";
/**
 * The Bot's trades, as a table on a wide screen and as cards on a phone.
 *
 * At 390 px the table used to keep `min-w-[720px]` and scroll sideways inside
 * its card, so P&L and the order id were off-screen. Both layouts are in the
 * document and CSS shows one: `sm:hidden` cards below 640 px, the table above.
 *
 * Actions follow ownership. A strategy trade whose bot still exists can be
 * closed or partly closed here, through the Bot's own exit path. A manual
 * trade belongs to the chart's Trade panel, where its ledger and TP/SL live,
 * so it gets a link there and never a Close (contract U3). A trade whose bot
 * was deleted says it cannot be closed here, and does not pretend otherwise.
 */
import Link from "next/link";
import { Button } from "@/components/ui";
import type { BotViewTrade } from "@/lib/api";
import { fmtDateTime, fmtPct, fmtPrice, fmtQty, signClass } from "@/lib/format";
import { tradePanelHref } from "./botCopy";

export type TradeTab = "active" | "closed";

export function money(value: number): string {
  return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

export const dollars = (value: number) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const tradeOwner = (trade: BotViewTrade) =>
  trade.source === "manual" ? "Manual" : trade.botName ?? "Deleted bot";

export interface TradeActions {
  /** False when commands cannot be sent at all (no channel, sign-in off). */
  enabled: boolean;
  disabledReason?: string;
  close: (trade: BotViewTrade) => void;
  partial: (trade: BotViewTrade) => void;
}

function Actions({ trade, actions }: { trade: BotViewTrade; actions: TradeActions }) {
  if (trade.status !== "active") return null;
  if (trade.source === "manual") {
    const href = tradePanelHref(trade.pair);
    return href ? (
      <Link href={href} className="inline-flex min-h-11 items-center text-sm text-ink-muted underline hover:text-ink sm:min-h-0">
        Close from the Trade panel
      </Link>
    ) : <span className="text-xs text-ink-faint">Close from the Trade panel</span>;
  }
  if (!trade.botId) return <span className="text-xs text-ink-faint">Bot deleted: not closable here</span>;
  return (
    <span className="inline-flex flex-wrap gap-2">
      <Button disabled={!actions.enabled} title={actions.enabled ? undefined : actions.disabledReason}
        label={`Partial close ${trade.pair}`} onClick={() => actions.partial(trade)}>Partial…</Button>
      <Button variant="danger" disabled={!actions.enabled} title={actions.enabled ? undefined : actions.disabledReason}
        label={`Close ${trade.pair}`} onClick={() => actions.close(trade)}>Close…</Button>
    </span>
  );
}

export function TradesTable({ tab, rows, actions }: { tab: TradeTab; rows: BotViewTrade[]; actions: TradeActions }) {
  return (
    /*
     * `relative`: the "Actions" header is `sr-only` (position: absolute). With no
     * positioned ancestor it was placed against the page, outside this scroll
     * container, and lengthened the document so the whole app shell scrolled
     * past the Nav (walkthrough D-5). Positioned here, it is clipped by the
     * container like every other cell.
     */
    <div className="relative hidden overflow-x-auto sm:block" data-layout="desktop">
      <table className="w-full min-w-[600px] text-sm tabular">
        <thead>
          <tr className="border-b border-border text-xs text-ink-muted">
            <th className="px-3 py-1.5 text-left">Pair</th>
            <th className="px-3 py-1.5 text-left">Bot</th>
            <th className="px-3 py-1.5 text-right">Entry</th>
            {tab === "active" && <th className="px-3 py-1.5 text-right">Current</th>}
            <th className="px-3 py-1.5 text-right">Quantity</th>
            <th className="px-3 py-1.5 text-right">P&amp;L</th>
            <th className="px-3 py-1.5 text-left">{tab === "active" ? "Opened" : "Closed"}</th>
            {tab === "closed" && <th className="px-3 py-1.5 text-left">Reason</th>}
            <th className="px-3 py-1.5 text-left">Order id</th>
            {tab === "active" && <th className="px-3 py-1.5 text-right"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((trade) => (
            <tr key={trade.id} className="border-b border-border last:border-b-0">
              <td className="px-3 py-1.5 font-medium text-ink">{trade.pair}</td>
              <td className="px-3 py-1.5 text-ink-muted">{tradeOwner(trade)}</td>
              <td className="px-3 py-1.5 text-right">{fmtPrice(trade.entryPrice)}</td>
              {tab === "active" && <td className="px-3 py-1.5 text-right">{fmtPrice(trade.currentPrice)}</td>}
              <td className="px-3 py-1.5 text-right">{fmtQty(trade.quantity)}<span className="block text-xs text-ink-faint">{dollars(trade.quoteSpent)}</span></td>
              <td className={`px-3 py-1.5 text-right ${signClass(trade.pnlUsdt)}`}>
                {money(trade.pnlUsdt)} ({fmtPct(trade.pnlPct)})
              </td>
              <td className="px-3 py-1.5 text-ink-muted">{fmtDateTime(tab === "active" ? trade.createdAt : trade.closedAt)}</td>
              {tab === "closed" && <td className="px-3 py-1.5 text-ink-muted">{trade.closedReason ?? "—"}</td>}
              <td className="px-3 py-1.5 text-ink-muted">{trade.exchangeOrderId ?? "—"}</td>
              {tab === "active" && <td className="px-3 py-1.5 text-right"><Actions trade={trade} actions={actions} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The phone layout: one card per trade, P&L beside the pair, nothing off-screen. */
export function TradeCards({ tab, rows, actions }: { tab: TradeTab; rows: BotViewTrade[]; actions: TradeActions }) {
  return (
    <ul className="divide-y divide-border sm:hidden" data-layout="phone" aria-label="Trades">
      {rows.map((trade) => (
        <li key={trade.id} className="space-y-1.5 px-4 py-3" data-trade-card={trade.id}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-medium text-ink">{trade.pair}
              <span className="ml-2 text-xs font-normal text-ink-muted">{tradeOwner(trade)}</span></span>
            <span className={`shrink-0 text-sm font-semibold tabular ${signClass(trade.pnlUsdt)}`}>
              {money(trade.pnlUsdt)} ({fmtPct(trade.pnlPct)})
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs tabular">
            <dt className="text-ink-muted">Entry</dt><dd className="text-right text-ink">{fmtPrice(trade.entryPrice)}</dd>
            {tab === "active" && <><dt className="text-ink-muted">Current</dt><dd className="text-right text-ink">{fmtPrice(trade.currentPrice)}</dd></>}
            <dt className="text-ink-muted">Quantity</dt><dd className="text-right text-ink">{fmtQty(trade.quantity)} · {dollars(trade.quoteSpent)}</dd>
            <dt className="text-ink-muted">{tab === "active" ? "Opened" : "Closed"}</dt>
            <dd className="text-right text-ink">{fmtDateTime(tab === "active" ? trade.createdAt : trade.closedAt)}</dd>
            {tab === "closed" && <><dt className="text-ink-muted">Reason</dt><dd className="text-right text-ink">{trade.closedReason ?? "—"}</dd></>}
            <dt className="text-ink-muted">Order id</dt><dd className="truncate text-right text-ink">{trade.exchangeOrderId ?? "—"}</dd>
          </dl>
          {tab === "active" && <div><Actions trade={trade} actions={actions} /></div>}
        </li>
      ))}
    </ul>
  );
}
