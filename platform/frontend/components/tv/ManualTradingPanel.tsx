"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button, StatusBadge } from "@/components/ui";
import { TradeOrderTimeline } from "@/components/TradeOrderTimeline";
import { api, type ManualAccount, type ManualOrder, type ManualPosition, type ManualTradingState } from "@/lib/api";
import { fmtPrice } from "@/lib/format";
import { shariahApi, type ShariahSymbolStatus } from "@/lib/shariah";

const newRequestId = (): string => window.crypto.randomUUID();
const n = (raw: string): number | undefined => raw.trim() ? Number(raw) : undefined;

/** Order types this product actually supports. Nothing else is offered. */
const ORDER_TYPES = [
  { id: "MARKET", label: "Market" },
  { id: "LIMIT", label: "Limit" },
] as const;

/**
 * Status buckets for the order list.
 *
 * These are the statuses the manual-trading API already reports; the tabs
 * only filter what is on screen. A full list of 100 orders is unreadable as
 * one undifferentiated stack, and "is my limit still working?" is the question
 * this panel is opened to answer.
 */
const ORDER_FILTERS = [
  { id: "all", label: "All", match: () => true },
  { id: "working", label: "Working", match: (o: ManualOrder) => ["requested", "submitted", "open", "partially_filled"].includes(o.status) },
  { id: "filled", label: "Filled", match: (o: ManualOrder) => o.status === "filled" },
  { id: "cancelled", label: "Cancelled", match: (o: ManualOrder) => o.status === "canceled" },
  { id: "rejected", label: "Rejected", match: (o: ManualOrder) => o.status === "rejected" || o.status === "error" },
] as const;

type OrderFilter = (typeof ORDER_FILTERS)[number]["id"];

/** A labelled input with the unit printed inside it, as the reference does. */
function UnitField({
  label, unit, value, onChange, invalid = false, error, id, placeholder,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  error?: string | null;
  id: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[11px] font-medium text-ink-muted">{label}</label>
      {/*
        The message sits against the field it is about, not at the top of the
        panel. A rejected amount used to be explained six controls away from
        the amount box, above the account picker.
      */}
      {error && (
        <p id={`${id}-error`} role="alert"
          className="mb-1 rounded border border-down/40 bg-down/10 px-2 py-1 text-[11px] leading-4 text-down">
          {error}
        </p>
      )}
      <div className={`flex items-center rounded-md border bg-surface-2 transition-colors focus-within:border-accent ${
        invalid ? "border-down" : "border-border"
      }`}>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 text-sm tabular text-ink outline-none"
        />
        <span aria-hidden="true" className="shrink-0 px-2.5 text-[11px] font-medium text-ink-faint">{unit}</span>
      </div>
    </div>
  );
}

export function ManualTradingPanel({ symbol, lastPrice = null, onClose, onStateChange }: {
  symbol: string;
  /** Latest close from the chart. Presentational context only — never submitted. */
  lastPrice?: number | null;
  onClose?: () => void;
  onStateChange: (state: ManualTradingState | null) => void;
}) {
  const [state, setState] = useState<ManualTradingState | null>(null);
  const [accountId, setAccountId] = useState("");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  /**
   * The backend gate's own answer for this symbol, not a locally derived one.
   * It is refreshed whenever the symbol changes, and it is only ever used to
   * EXPLAIN and to disable — the backend refuses the order regardless, so a
   * stale badge here can mislead but can never permit.
   */
  const [shariah, setShariah] = useState<ShariahSymbolStatus | null>(null);
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [positionId, setPositionId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [orderRequestId, setOrderRequestId] = useState<string | null>(null);
  const [actionRequestIds, setActionRequestIds] = useState<Record<string, string>>({});
  const [mainnetConfirmed, setMainnetConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"ticket" | "orders">("ticket");
  const [orderFilter, setOrderFilter] = useState<OrderFilter>("all");
  const [edit, setEdit] = useState<Record<string, { tp: string; sl: string }>>({});
  const [timelineOrderId, setTimelineOrderId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.manualState(symbol);
      setState(next); onStateChange(next); setError(null);
      if (!accountId && next.accounts[0]) setAccountId(next.accounts[0].id);
    } catch (e) { setError((e as Error).message); }
  }, [symbol, accountId, onStateChange]);

  useEffect(() => { void refresh(); const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id); }, [refresh]);

  // Re-asked on every symbol change, and again after a successful order, so the
  // badge cannot go on claiming ELIGIBLE after a re-screening. A failure here
  // leaves it null: unknown, which shows nothing and blocks nothing, because
  // the authority is the backend.
  useEffect(() => {
    let cancelled = false;
    shariahApi.status(symbol)
      .then((status) => { if (!cancelled) setShariah(status); })
      .catch(() => { if (!cancelled) setShariah(null); });
    return () => { cancelled = true; };
  }, [symbol]);

  const account = state?.accounts.find((a) => a.id === accountId) ?? null;
  const activePositions = useMemo(() => state?.positions.filter((p) =>
    p.status === "active" && p.exchangeAccountId === accountId) ?? [], [state, accountId]);
  const base = symbol.replace(/USDT$/, "");
  const amountUnit = side === "BUY" ? "USDT" : base;
  const amountLabel = side === "BUY" ? "Quote amount" : "Base quantity";
  const amountInvalid = amount.trim() !== "" && !(Number(amount) > 0);
  const priceInvalid = orderType === "LIMIT" && limitPrice.trim() !== "" && !(Number(limitPrice) > 0);
  /**
   * SELL is never gated — an asset that has just been re-screened EXCLUDED must
   * still be exitable, and this panel must never be the reason a position is
   * stuck. Only a BUY consults the gate, and only to stop a pointless round
   * trip to a backend that would refuse it anyway.
   */
  const shariahBlocksBuy = side === "BUY" && shariah !== null && !shariah.buyAllowed;
  const valid = !!account && (account.testnet || !!state?.mainnetEnabled) && Number(amount) > 0 &&
    (orderType === "MARKET" || Number(limitPrice) > 0)
    && !shariahBlocksBuy
    && (side === "BUY" || !positionId || activePositions.some((p) => p.id === positionId));
  const mode = account ? `${state?.dryRun ? "dry run · " : ""}${account.mode}` : "unknown";
  const accountLabel = (id: string): string => {
    const found = state?.accounts.find((item) => item.id === id);
    return found ? ` · ${found.name} (${found.mode})` : "";
  };
  /**
   * The exact order the primary button will put up for confirmation, or null
   * while the ticket is still empty — a summary reading "— USDT SOLUSDT
   * MARKET" states nothing and only makes the disabled button taller.
   */
  const orderSummary = amount.trim() === "" ? null
    : `${amount} ${amountUnit} ${symbol}${
      orderType === "LIMIT" ? ` @ ${limitPrice || "—"} LIMIT` : " MARKET"}`;

  const commandBody = (selected: ManualAccount, requestId: string) => ({ requestId, accountId: selected.id,
    symbol, side, orderType, ...(side === "BUY" ? { quoteQuantity: n(amount) } : { baseQuantity: n(amount) }),
    ...(orderType === "LIMIT" ? { limitPrice: n(limitPrice) } : {}),
    ...(side === "BUY" && n(tp) !== undefined ? { takeProfitPrice: n(tp) } : {}),
    ...(side === "BUY" && n(sl) !== undefined ? { stopLossPrice: n(sl) } : {}),
    ...(side === "SELL" && positionId ? { positionId } : {}),
    ...(!selected.testnet ? { mainnetConfirmation: "PLACE_MAINNET_ORDER" } : {}) });

  const submit = async () => {
    if (!account || pending) return;
    const requestId = orderRequestId ?? newRequestId();
    if (!orderRequestId) setOrderRequestId(requestId);
    setPending(true); setError(null); setNotice(null);
    try { await api.submitManualOrder(commandBody(account, requestId)); setConfirming(false); setOrderRequestId(null); setAmount("");
      setTp(""); setSl(""); setMainnetConfirmed(false); setNotice("Order accepted by the execution bot.");
      await refresh(); setTab("orders"); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };

  const cancel = async (id: string) => {
    const order = state?.orders.find((o) => o.id === id);
    const selected = state?.accounts.find((a) => a.id === order?.exchangeAccountId);
    if (!selected || pending) return;
    if (!selected.testnet && !window.confirm("Cancel this real-funds Binance mainnet limit order?")) return;
    const key = `cancel:${id}`; const requestId = actionRequestIds[key] ?? newRequestId();
    if (!actionRequestIds[key]) setActionRequestIds((old) => ({ ...old, [key]: requestId }));
    setPending(true); setError(null); setNotice(null);
    try { await api.cancelManualOrder(id, { requestId,
      ...(!selected.testnet ? { mainnetConfirmation: "PLACE_MAINNET_ORDER" } : {}) });
      setActionRequestIds((old) => { const next = { ...old }; delete next[key]; return next; });
      setNotice("Limit cancellation confirmed by the execution bot."); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setPending(false); }
  };

  const protection = async (position: ManualPosition, remove = false) => {
    const selected = state?.accounts.find((a) => a.id === position.exchangeAccountId);
    if (!selected || pending) return;
    if (!selected.testnet && !window.confirm(
      `${remove ? "Remove" : "Update"} bot-managed protection for a Binance mainnet position?`)) return;
    const key = `protection:${position.id}:${remove ? "remove" : "edit"}`;
    const requestId = actionRequestIds[key] ?? newRequestId();
    if (!actionRequestIds[key]) setActionRequestIds((old) => ({ ...old, [key]: requestId }));
    const values = edit[position.id] ?? { tp: position.manualTpPrice?.toString() ?? "",
      sl: position.manualSlPrice?.toString() ?? "" };
    setPending(true); setError(null); setNotice(null);
    try { await api.updateManualProtection(position.id, { requestId,
      takeProfitPrice: remove ? null : n(values.tp) ?? null,
      stopLossPrice: remove ? null : n(values.sl) ?? null,
      ...(!selected.testnet ? { mainnetConfirmation: "PLACE_MAINNET_ORDER" } : {}) });
      setActionRequestIds((old) => { const next = { ...old }; delete next[key]; return next; });
      setNotice(remove ? "TP/SL removed on the server." : "TP/SL updated on the server."); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setPending(false); }
  };

  const orders = useMemo(() => state?.orders ?? [], [state]);
  const counts = useMemo(() => Object.fromEntries(
    ORDER_FILTERS.map((f) => [f.id, orders.filter(f.match).length])
  ) as Record<OrderFilter, number>, [orders]);
  const shownOrders = orders.filter(
    ORDER_FILTERS.find((f) => f.id === orderFilter)?.match ?? (() => true));

  return <aside className="flex h-full w-[90vw] max-w-[340px] shrink-0 flex-col border-l border-border bg-surface md:w-[340px]"
    aria-label="Manual Binance Spot trading">
    {/*
      Instrument header. The panel used to open with no statement of which
      symbol it would trade — it follows the chart, but the chart's symbol is
      in a toolbar the panel covers on a narrow window — and with no way to
      close itself except the icon rail on the far side of the screen.
    */}
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-warn" />
      <span className="truncate text-sm font-semibold text-ink">{symbol}</span>
      {lastPrice !== null && (
        <span className="tabular text-[11px] text-ink-muted">{fmtPrice(lastPrice)}</span>
      )}
      {onClose && (
        <button onClick={onClose} aria-label="Close the trading panel" title="Close"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      )}
    </div>
    <div className="flex gap-1 border-b border-border p-2" role="tablist" aria-label="Manual trading">
      {(["ticket", "orders"] as const).map((id) => <button key={id} onClick={() => setTab(id)}
        role="tab" aria-selected={tab === id}
        className={`flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
          tab === id ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink"}`}>
        {id === "ticket" ? "Order" : `Orders${orders.length ? ` ${orders.length}` : ""}`}</button>)}
    </div>
    {error && <div role="alert" className="border-b border-down/30 bg-down/10 px-3 py-2 text-xs text-down">{error}</div>}
    {notice && <div role="status" className="border-b border-up/30 bg-up/10 px-3 py-2 text-xs text-up">{notice}</div>}
    {!state ? <div className="p-4 text-sm text-ink-faint">Loading manual trading…</div>
    : !state.enabled ? <div className="p-4 text-sm text-ink-faint">Manual trading is disabled by server configuration.</div>
    : tab === "ticket" ? <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {/*
        Real funds versus testnet is the single most consequential fact in this
        panel, and it was one word in a thin outline. `mainnet` now reads as a
        filled warning; every other mode stays quiet.
      */}
      <div className="flex items-center justify-between text-xs"><span className="text-ink-muted">Binance Spot</span>
        <span className={`rounded border px-2 py-0.5 font-medium ${
          account && !account.testnet
            ? "border-down/50 bg-down/15 text-down"
            : "border-warn/40 bg-warn/10 text-warn"}`}>
          {account && !account.testnet ? `${mode} · real funds` : mode}</span></div>
      {state.mixed && <p className="text-xs text-warn">Mixed account modes: verify the selected account.</p>}
      {state.accounts.length === 0 && <p role="alert" className="text-xs text-warn">
        No connected Binance Spot account is available. Add credentials in the execution bot.</p>}
      {account && !account.testnet && !state.mainnetEnabled &&
        <p role="alert" className="text-xs text-down">Mainnet manual trading is disabled on the execution bot.</p>}
      <div>
        <label htmlFor="manual-account" className="mb-1 block text-[11px] font-medium text-ink-muted">Connected account</label>
        <select id="manual-account" value={accountId}
          onChange={(e) => { setAccountId(e.target.value); setMainnetConfirmed(false); }}
          className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent">
          {state.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.mode}</option>)}
        </select>
      </div>
      {/* Side: two halves of one control, the chosen one carrying its colour. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border"
        role="group" aria-label="Order side">
        {(["BUY", "SELL"] as const).map((v) => <button key={v}
          onClick={() => { setSide(v); setPositionId(""); }} aria-pressed={side === v}
          className={`py-2 text-sm font-semibold transition-colors ${side === v
            ? v === "BUY" ? "bg-up/20 text-up" : "bg-down/20 text-down"
            : "bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink"}`}>{v}</button>)}
      </div>
      {/* Order type: the reference's underlined tab row, over the two types
          this product supports. Nothing here offers an unsupported type. */}
      <div className="flex border-b border-border" role="tablist" aria-label="Order type">
        {ORDER_TYPES.map((t) => <button key={t.id} role="tab" aria-selected={orderType === t.id}
          onClick={() => setOrderType(t.id)}
          className={`-mb-px flex-1 border-b-2 pb-1.5 text-[13px] font-medium transition-colors ${
            orderType === t.id ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink"}`}>
          {t.label}</button>)}
      </div>
      {side === "SELL" && activePositions.length > 0 && (
        <div>
          <label htmlFor="manual-position" className="mb-1 block text-[11px] font-medium text-ink-muted">
            Manual position (required when tracked)
          </label>
          <select id="manual-position" value={positionId}
            onChange={(e) => { setPositionId(e.target.value);
              const p = activePositions.find((x) => x.id === e.target.value); if (p) setAmount(String(p.quantity)); }}
            className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent">
            <option value="">Unassociated wallet sell</option>
            {activePositions.map((p) => <option key={p.id} value={p.id}>
              {p.quantity} {p.pair.replace(/USDT$/, "")} · entry {p.entryPrice ? fmtPrice(p.entryPrice) : "—"}</option>)}
          </select>
        </div>
      )}
      {orderType === "LIMIT" && (
        <UnitField id="manual-limit" label="Limit price" unit="USDT" value={limitPrice} onChange={setLimitPrice}
          invalid={priceInvalid} error={priceInvalid ? "Enter a limit price above zero." : null} />
      )}
      <UnitField id="manual-amount" label={amountLabel} unit={amountUnit} value={amount} onChange={setAmount}
        invalid={amountInvalid} error={amountInvalid ? `Enter an amount above zero in ${amountUnit}.` : null} />
      {side === "BUY" && <div className="grid grid-cols-2 gap-2">
        <UnitField id="manual-tp" label="Take profit" unit="USDT" value={tp} onChange={setTp} placeholder="optional" />
        <UnitField id="manual-sl" label="Stop loss" unit="USDT" value={sl} onChange={setSl} placeholder="optional" />
      </div>}
      <p className="rounded-md border border-border bg-surface-2/50 px-2.5 py-2 text-[11px] leading-4 text-ink-muted">
        TP/SL here is <span className="text-ink">bot-managed</span>: it activates only after an entry
        fill and is <span className="text-ink">not resting on the exchange</span>. If the bot is
        down, nothing protects the position.</p>
      {/*
        The primary action names the order it is about to put up for review,
        the way the reference does. Nothing is sent from here — the review
        dialog is still the only place an order can be confirmed.
      */}
      {shariah && shariah.mode === "enforce" && (
        <div className={`rounded-md border px-2.5 py-2 text-[11px] leading-4 ${
          shariah.buyAllowed
            ? "border-up/30 bg-up/10 text-up"
            : "border-warn/30 bg-warn/10 text-warn"}`}>
          <span className="font-semibold">
            Shariah {shariah.shariah.effectiveStatus}
          </span>
          {shariah.buyBlockedReason
            ? <span className="block text-ink-muted">{shariah.buyBlockedReason}</span>
            : <span className="block text-ink-muted">
                New exposure is allowed under {shariah.shariah.policyVersion}.
              </span>}
        </div>
      )}
      <button
        type="button"
        disabled={!valid || pending}
        onClick={() => { setOrderRequestId(newRequestId()); setConfirming(true); }}
        className={`w-full rounded-md px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          side === "BUY" ? "bg-up/20 text-up hover:bg-up/30" : "bg-down/20 text-down hover:bg-down/30"}`}
      >
        Review {side}
        {orderSummary && (
          <span className="mt-0.5 block text-[11px] font-normal tabular opacity-80">{orderSummary}</span>
        )}
      </button>
    </div> : <div className="min-h-0 flex-1 overflow-y-auto">
      {activePositions.map((p) => { const values = edit[p.id] ?? { tp: p.manualTpPrice?.toString() ?? "", sl: p.manualSlPrice?.toString() ?? "" };
        return <div key={p.id} className="space-y-2 border-b border-border bg-surface-2/30 p-3 text-xs">
          <div className="flex items-center justify-between">
            <strong className="text-ink">{p.pair} · <span className="tabular">{p.quantity}</span></strong>
            <StatusBadge status={p.status} />
          </div>
          <div className="tabular text-ink-faint">Entry {p.entryPrice ? fmtPrice(p.entryPrice) : "—"} · {p.protectionType ?? "no protection"} {p.protectionState ?? ""}</div>
          <div className="grid grid-cols-2 gap-2">
            <input aria-label="Take profit" placeholder="TP" value={values.tp} inputMode="decimal"
              onChange={(e) => setEdit((old) => ({ ...old, [p.id]: { ...values, tp: e.target.value } }))}
              className="min-w-0 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs tabular text-ink outline-none focus:border-accent" />
            <input aria-label="Stop loss" placeholder="SL" value={values.sl} inputMode="decimal"
              onChange={(e) => setEdit((old) => ({ ...old, [p.id]: { ...values, sl: e.target.value } }))}
              className="min-w-0 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs tabular text-ink outline-none focus:border-accent" />
          </div>
          <div className="flex gap-2"><Button disabled={pending} onClick={() => void protection(p)}>Save TP/SL</Button>
            <Button variant="ghost" disabled={pending} onClick={() => void protection(p, true)}>Remove</Button></div>
        </div>; })}
      {/* Status tabs over the existing order list — the reference's Orders /
          Order history split, over the statuses this product reports. */}
      <div className="sticky top-0 z-10 flex flex-wrap gap-1 border-b border-border bg-surface px-2 py-1.5"
        role="tablist" aria-label="Filter orders by status">
        {ORDER_FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={orderFilter === f.id}
            onClick={() => setOrderFilter(f.id)}
            className={`flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-colors ${
              orderFilter === f.id ? "bg-surface-2 text-ink" : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"}`}>
            {f.label}
            {counts[f.id] > 0 && <span className="tabular text-ink-faint">{counts[f.id]}</span>}
          </button>
        ))}
      </div>
      {shownOrders.length === 0 ? (
        <p className="px-3 py-8 text-center text-xs text-ink-faint">
          {orders.length === 0 ? "No manual orders yet." : "No orders in this state."}
        </p>
      ) : shownOrders.map((o) => <div key={o.id} className="border-b border-border/60">
        <div className="px-3 py-2 text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate font-medium text-ink">
              <span className={o.side === "BUY" ? "text-up" : "text-down"}>{o.side}</span>{" "}
              {o.orderType} · {o.symbol}
            </span>
            <StatusBadge status={o.status} />
          </div>
          <div className="mt-1 tabular text-ink-faint">{o.quantityType === "quote" ? `${o.requestedQuoteQty} USDT` : `${o.requestedBaseQty} base`}
            {o.limitPrice ? ` @ ${fmtPrice(o.limitPrice)}` : ""} · filled {o.filledBaseQty}
            {o.averageFillPrice ? ` @ ${fmtPrice(o.averageFillPrice)}` : ""}
            {accountLabel(o.exchangeAccountId)}</div>
          {o.error && <div className="mt-1 text-down">{o.error}</div>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={() => setTimelineOrderId((current) => current === o.id ? null : o.id)}
              aria-expanded={timelineOrderId === o.id}>
              {timelineOrderId === o.id ? "Hide timeline" : "Timeline"}
            </Button>
            {o.orderType === "LIMIT" && ["requested", "submitted", "open", "partially_filled"].includes(o.status) &&
              <Button variant="danger" disabled={pending} onClick={() => void cancel(o.id)}>Cancel limit</Button>}
          </div>
        </div>
        {timelineOrderId === o.id && <TradeOrderTimeline kind="manual-order" id={o.id} />}
      </div>)}
    </div>}
    <Modal title="Confirm manual Spot order" open={confirming} onClose={() => !pending && setConfirming(false)} footer={<>
      <Button onClick={() => setConfirming(false)} disabled={pending}>Back</Button>
      <Button variant={side === "BUY" ? "primary" : "danger"} onClick={() => void submit()}
        disabled={pending || (!!account && !account.testnet && !mainnetConfirmed)}>{pending ? "Submitting…" : `Confirm ${side}`}</Button></>}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-ink-muted">Account</dt><dd>{account?.name ?? "—"}</dd><dt className="text-ink-muted">Mode</dt><dd>{mode}</dd>
        <dt className="text-ink-muted">Symbol</dt><dd>{symbol}</dd><dt className="text-ink-muted">Side / type</dt><dd>{side} · {orderType}</dd>
        <dt className="text-ink-muted">Amount</dt><dd>{amount} {side === "BUY" ? "USDT quote" : "base"}</dd>
        {orderType === "LIMIT" && <><dt className="text-ink-muted">Limit price</dt><dd>{limitPrice}</dd></>}
        <dt className="text-ink-muted">TP / SL</dt><dd>{tp || "none"} / {sl || "none"}</dd>
        <dt className="text-ink-muted">Protection</dt><dd>{side === "BUY" && (tp || sl)
          ? "bot-managed · not exchange-resting" : "none"}</dd>
      </dl>
      {account && !account.testnet && <label className="mt-4 flex items-start gap-2 rounded-md border border-down/40 bg-down/10 p-3 text-sm text-down">
        <input type="checkbox" checked={mainnetConfirmed} onChange={(e) => setMainnetConfirmed(e.target.checked)} />
        I confirm this order uses real funds on Binance mainnet.</label>}
    </Modal>
  </aside>;
}
