"use client";
/**
 * Positions and orders under the chart — the trader-state area.
 *
 * ── What this is and is not ─────────────────────────────────────────────────
 *
 * The same data the order ticket reads (`/api/manual-trading/state`, polled by
 * the chart page), laid out where a trader glances after ordering instead of
 * inside the ticket's Orders tab. It is read-only: every action — cancel,
 * protection, a new order — stays in the ticket, which is the one place that
 * stages, confirms and submits. There is no second execution authority here.
 *
 * Nothing is derived. Entry, quantity, P&L and fill figures are the Bot's own
 * numbers as the Platform received them; a figure the Bot did not report is
 * shown as `—`, never estimated from the chart. The Journal remains the record
 * of what accumulated, and links out for history.
 */
import Link from "next/link";
import { useState } from "react";
import { StatusBadge } from "@/components/ui";
import type { ManualOrder, ManualPosition, ManualTradingState } from "@/lib/api";
import { fmtPrice } from "@/lib/format";
import { REFUSAL_TONE, toTradeEvent } from "@/lib/tradeEvents";

export type TradingStripTab = "positions" | "orders";

/**
 * The statuses the ticket calls "Working" — the same list as its filter, so
 * the strip and the ticket cannot disagree about what is still open.
 */
export const WORKING_STATUSES: readonly string[] = ["requested", "submitted", "open", "partially_filled"];

/** Orders still in flight, newest first. Everything else is history. */
export function openOrders(orders: readonly ManualOrder[]): ManualOrder[] {
  return orders
    .filter((o) => WORKING_STATUSES.includes(o.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The most recent finished orders, newest first, for the Recent column. */
export function recentHistory(orders: readonly ManualOrder[], limit = 8): ManualOrder[] {
  return orders
    .filter((o) => !WORKING_STATUSES.includes(o.status))
    .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))
    .slice(0, limit);
}

export function activePositions(positions: readonly ManualPosition[]): ManualPosition[] {
  return positions.filter((p) => p.status === "active");
}

function signed(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
}

function accountName(state: ManualTradingState, id: string): string {
  const account = state.accounts.find((a) => a.id === id);
  return account ? `${account.name}${account.mode === "testnet" ? " (testnet)" : ""}` : id;
}

export function TradingStateStrip({ state, symbol, onOpenTicket, unavailable }: {
  /** The authoritative manual-trading state, or null while unread. */
  state: ManualTradingState | null;
  /** The focused chart's instrument; its rows are listed first. */
  symbol: string;
  onOpenTicket: () => void;
  /** Why there is no state, when known (manual trading disabled, Bot unreachable). */
  unavailable?: string | null;
}) {
  const [tab, setTab] = useState<TradingStripTab>("positions");

  if (!state) {
    return (
      <div className="flex h-[120px] items-center justify-center px-6 text-center text-xs text-ink-muted">
        {unavailable
          ?? "Positions and orders come from the execution bot; nothing has been read yet."}
      </div>
    );
  }

  const positions = activePositions(state.positions)
    .sort((a, b) => Number(b.pair === symbol) - Number(a.pair === symbol));
  const open = openOrders(state.orders)
    .sort((a, b) => Number(b.symbol === symbol) - Number(a.symbol === symbol));
  const history = recentHistory(state.orders);
  const paper = state.dryRun;

  return (
    <div className="flex h-[180px] min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border/70 px-3 py-1" role="tablist" aria-label="Trading state">
        {([["positions", `Positions${positions.length ? ` ${positions.length}` : ""}`],
          ["orders", `Open orders${open.length ? ` ${open.length}` : ""}`]] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`text-[11px] font-medium ${tab === id ? "text-ink" : "text-ink-muted hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            paper ? "bg-accent/15 text-accent" : "border border-warn/40 bg-warn/15 text-warn"
          }`}
          title={paper
            ? "The execution bot is in dry-run: orders are simulated, nothing reaches the exchange."
            : "The execution bot is live: orders are real Spot orders on Binance."}
        >
          {paper ? "PAPER" : "LIVE"}
        </span>
        <span className="ml-auto flex items-center gap-3 text-[11px]">
          <Link href="/journal" className="text-ink-muted underline-offset-2 hover:text-ink hover:underline">History</Link>
          <button onClick={onOpenTicket} className="text-ink-muted hover:text-ink">Open ticket</button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
        {tab === "positions" ? (
          positions.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-ink-faint">
              No open position on any account.
            </p>
          ) : (
            <table className="w-full min-w-[640px] text-[11px] tabular">
              <thead className="sticky top-0 bg-surface text-ink-faint">
                <tr>
                  <th className="px-3 py-1 text-left font-medium">Symbol</th>
                  <th className="px-2 py-1 text-right font-medium">Qty</th>
                  <th className="px-2 py-1 text-right font-medium">Entry</th>
                  <th className="px-2 py-1 text-right font-medium">Last</th>
                  <th className="px-2 py-1 text-right font-medium">P&amp;L</th>
                  <th className="px-2 py-1 text-right font-medium">TP / SL</th>
                  <th className="px-3 py-1 text-left font-medium">Account</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id} className={`border-t border-border/50 ${p.pair === symbol ? "bg-surface-2/40" : ""}`}>
                    <td className="px-3 py-1 font-medium text-ink">{p.pair}</td>
                    <td className="px-2 py-1 text-right text-ink">{p.quantity}</td>
                    <td className="px-2 py-1 text-right text-ink">{p.entryPrice === null ? "—" : fmtPrice(p.entryPrice)}</td>
                    <td className="px-2 py-1 text-right text-ink">{p.currentPrice === null ? "—" : fmtPrice(p.currentPrice)}</td>
                    <td className={`px-2 py-1 text-right ${p.pnlUsdt >= 0 ? "text-up" : "text-down"}`}>
                      {signed(p.pnlUsdt)} USDT · {signed(p.pnlPct)}%
                    </td>
                    <td className="px-2 py-1 text-right text-ink-muted">
                      {p.manualTpPrice === null ? "—" : fmtPrice(p.manualTpPrice)} / {p.manualSlPrice === null ? "—" : fmtPrice(p.manualSlPrice)}
                    </td>
                    <td className="px-3 py-1 text-ink-faint">{accountName(state, p.exchangeAccountId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <>
            {open.length === 0 ? (
              <p className="px-3 py-3 text-center text-xs text-ink-faint">No open orders.</p>
            ) : (
              <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[11px] tabular">
                <thead className="sticky top-0 bg-surface text-ink-faint">
                  <tr>
                    <th className="px-3 py-1 text-left font-medium">Order</th>
                    <th className="px-2 py-1 text-right font-medium">Size</th>
                    <th className="px-2 py-1 text-right font-medium">Limit</th>
                    <th className="px-2 py-1 text-right font-medium">Filled</th>
                    <th className="px-2 py-1 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((o) => <OrderRow key={o.id} order={o} focused={o.symbol === symbol} />)}
                </tbody>
              </table>
              </div>
            )}
            {history.length > 0 && (
              <>
                <div className="border-t border-border/70 px-3 py-1 text-[10px] uppercase tracking-wide text-ink-faint">
                  Recent · {history.length}
                </div>
                <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-[11px] tabular">
                  <tbody>
                    {history.map((o) => <OrderRow key={o.id} order={o} focused={o.symbol === symbol} />)}
                  </tbody>
                </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function OrderRow({ order: o, focused }: { order: ManualOrder; focused: boolean }) {
  const refusal = toTradeEvent(o).refusal;
  return (
    <tr className={`border-t border-border/50 ${focused ? "bg-surface-2/40" : ""}`}>
      <td className="px-3 py-1">
        <span className={o.side === "BUY" ? "text-up" : "text-down"}>{o.side}</span>{" "}
        <span className="text-ink">{o.orderType} · {o.symbol}</span>
        {refusal && (
          <span className={`ml-1.5 rounded border px-1 py-px text-[10px] font-medium ${REFUSAL_TONE[refusal.class]}`}
            title={refusal.detail}>
            {refusal.label}
          </span>
        )}
      </td>
      <td className="px-2 py-1 text-right text-ink">
        {o.quantityType === "quote" ? `${o.requestedQuoteQty ?? "—"} USDT` : `${o.requestedBaseQty ?? "—"} base`}
      </td>
      <td className="px-2 py-1 text-right text-ink">{o.limitPrice ? fmtPrice(o.limitPrice) : "—"}</td>
      <td className="px-2 py-1 text-right text-ink">
        {o.filledBaseQty}{o.averageFillPrice ? ` @ ${fmtPrice(o.averageFillPrice)}` : ""}
      </td>
      <td className="px-2 py-1"><StatusBadge status={o.status} /></td>
    </tr>
  );
}
