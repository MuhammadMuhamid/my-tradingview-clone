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
 *
 * ── Five states, told apart ─────────────────────────────────────────────────
 *
 * loading (no read answered yet) · unavailable (no read has ever succeeded,
 * and the reason) · current (the latest read succeeded, stamped with its
 * time) · empty (current, with nothing open) · stale (a read succeeded once,
 * the latest failed: the retained positions and orders are shown under a
 * warning that names the failure and the time they were read, with the P&L
 * colour withdrawn). Retained state is never passed off as now.
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

export type TradingStateFreshness = "loading" | "unavailable" | "current" | "stale";

/**
 * What the strip knows about its data. `unavailable` beside a retained
 * `state` is a failed refresh, not a missing feature: that is `stale`.
 */
export function tradingStateFreshness(
  state: ManualTradingState | null, unavailable: string | null | undefined,
): TradingStateFreshness {
  if (state === null) return unavailable ? "unavailable" : "loading";
  return unavailable ? "stale" : "current";
}

/** A wall-clock time as HH:MM:SS in the viewer's zone — the "read at" stamp. */
export function clockLabel(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function TradingStateStrip({ state, readAt = null, symbol, onOpenTicket, unavailable }: {
  /** The authoritative manual-trading state, or null while unread. */
  state: ManualTradingState | null;
  /** When `state` was last read successfully (ms since epoch); null until then. */
  readAt?: number | null;
  /** The focused chart's instrument; its rows are listed first. */
  symbol: string;
  onOpenTicket: () => void;
  /**
   * Why the latest read failed, when it did (manual trading disabled, Bot
   * unreachable). With no `state` it is the whole story; with one, it means
   * the state shown is retained from `readAt`, not current.
   */
  unavailable?: string | null;
}) {
  const [tab, setTab] = useState<TradingStripTab>("positions");
  const freshness = tradingStateFreshness(state, unavailable);

  if (!state) {
    return (
      <div role="status" className="flex h-[120px] items-center justify-center px-6 text-center text-xs text-ink-muted">
        {freshness === "unavailable"
          ? unavailable
          : "Reading positions and orders from the execution bot…"}
      </div>
    );
  }

  const stale = freshness === "stale";
  const positions = activePositions(state.positions)
    .sort((a, b) => Number(b.pair === symbol) - Number(a.pair === symbol));
  const open = openOrders(state.orders)
    .sort((a, b) => Number(b.symbol === symbol) - Number(a.symbol === symbol));
  const history = recentHistory(state.orders);
  const paper = state.dryRun;
  const readLabel = readAt === null ? null : clockLabel(readAt);
  const pnlTone = (value: number): string => stale ? "text-ink-muted" : value >= 0 ? "text-up" : "text-down";

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
        {readLabel && !stale && (
          <span className="text-[10px] text-ink-faint" title="When positions and orders were last read from the execution bot">
            read {readLabel}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-[11px]">
          <Link href="/journal" className="text-ink-muted underline-offset-2 hover:text-ink hover:underline">History</Link>
          <button onClick={onOpenTicket} className="text-ink-muted hover:text-ink">Open ticket</button>
        </span>
      </div>
      {stale && (
        <div role="alert" className="flex items-start gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1 text-[11px] leading-4 text-warn">
          <span aria-hidden="true">⚠</span>
          <span>
            Could not refresh positions and orders{unavailable ? `: ${unavailable}` : ""}.{" "}
            {readLabel ? `Showing the state read at ${readLabel}` : "Showing the last state read"}; it may have changed since.
          </span>
        </div>
      )}
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
                    <td className={`px-2 py-1 text-right ${pnlTone(p.pnlUsdt)}`}>
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
