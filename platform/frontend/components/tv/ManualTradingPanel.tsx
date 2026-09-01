"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button, Field, Select, StatusBadge, TextInput } from "@/components/ui";
import { api, type ManualAccount, type ManualPosition, type ManualTradingState } from "@/lib/api";
import { fmtPrice } from "@/lib/format";

const newRequestId = (): string => window.crypto.randomUUID();
const n = (raw: string): number | undefined => raw.trim() ? Number(raw) : undefined;

export function ManualTradingPanel({ symbol, onStateChange }: {
  symbol: string; onStateChange: (state: ManualTradingState | null) => void;
}) {
  const [state, setState] = useState<ManualTradingState | null>(null);
  const [accountId, setAccountId] = useState("");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
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
  const [edit, setEdit] = useState<Record<string, { tp: string; sl: string }>>({});

  const refresh = useCallback(async () => {
    try {
      const next = await api.manualState(symbol);
      setState(next); onStateChange(next); setError(null);
      if (!accountId && next.accounts[0]) setAccountId(next.accounts[0].id);
    } catch (e) { setError((e as Error).message); }
  }, [symbol, accountId, onStateChange]);

  useEffect(() => { void refresh(); const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id); }, [refresh]);

  const account = state?.accounts.find((a) => a.id === accountId) ?? null;
  const activePositions = useMemo(() => state?.positions.filter((p) =>
    p.status === "active" && p.exchangeAccountId === accountId) ?? [], [state, accountId]);
  const valid = !!account && (account.testnet || !!state?.mainnetEnabled) && Number(amount) > 0 &&
    (orderType === "MARKET" || Number(limitPrice) > 0)
    && (side === "BUY" || !positionId || activePositions.some((p) => p.id === positionId));
  const mode = account ? `${state?.dryRun ? "dry run · " : ""}${account.mode}` : "unknown";
  const accountLabel = (id: string): string => {
    const found = state?.accounts.find((item) => item.id === id);
    return found ? ` · ${found.name} (${found.mode})` : "";
  };

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

  return <aside className="flex h-full w-[90vw] max-w-[330px] shrink-0 flex-col border-l border-border bg-surface md:w-[330px]">
    <div className="flex gap-1 border-b border-border p-2" role="tablist" aria-label="Manual trading">
      {(["ticket", "orders"] as const).map((id) => <button key={id} onClick={() => setTab(id)}
        role="tab" aria-selected={tab === id}
        className={`flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
          tab === id ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink"}`}>
        {id === "ticket" ? "Order ticket" : "Orders & positions"}</button>)}
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
      <Field label="Connected account"><Select value={accountId} onChange={(e) => { setAccountId(e.target.value); setMainnetConfirmed(false); }}>
        {state.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.mode}</option>)}</Select></Field>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Order side">{(["BUY", "SELL"] as const).map((v) => <button key={v}
        onClick={() => { setSide(v); setPositionId(""); }} aria-pressed={side === v}
        className={`rounded-md border py-2 text-sm font-semibold transition-colors ${side === v
          ? v === "BUY" ? "border-up bg-up/15 text-up" : "border-down bg-down/15 text-down"
          : "border-border text-ink-muted hover:text-ink"}`}>{v}</button>)}</div>
      <Field label="Order type"><Select value={orderType} onChange={(e) => setOrderType(e.target.value as "MARKET" | "LIMIT")}>
        <option value="MARKET">Market</option><option value="LIMIT">Limit (GTC)</option></Select></Field>
      {side === "SELL" && activePositions.length > 0 && <Field label="Manual position (required when tracked)">
        <Select value={positionId} onChange={(e) => { setPositionId(e.target.value);
          const p = activePositions.find((x) => x.id === e.target.value); if (p) setAmount(String(p.quantity)); }}>
          <option value="">Unassociated wallet sell</option>{activePositions.map((p) => <option key={p.id} value={p.id}>
            {p.quantity} {p.pair.replace(/USDT$/, "")} · entry {p.entryPrice ? fmtPrice(p.entryPrice) : "—"}</option>)}</Select></Field>}
      <Field label={side === "BUY" ? "Quote amount (USDT)" : `Base quantity (${symbol.replace(/USDT$/, "")})`}>
        <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      {orderType === "LIMIT" && <Field label="Limit price"><TextInput inputMode="decimal" value={limitPrice}
        onChange={(e) => setLimitPrice(e.target.value)} /></Field>}
      {side === "BUY" && <div className="grid grid-cols-2 gap-2"><Field label="Take profit (optional)">
        <TextInput inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} /></Field>
        <Field label="Stop loss (optional)"><TextInput inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} /></Field></div>}
      <p className="rounded-md border border-border bg-surface-2/50 px-2.5 py-2 text-[11px] leading-4 text-ink-muted">
        TP/SL here is <span className="text-ink">bot-managed</span>: it activates only after an entry
        fill and is <span className="text-ink">not resting on the exchange</span>. If the bot is
        down, nothing protects the position.</p>
      <Button variant={side === "BUY" ? "primary" : "danger"} disabled={!valid || pending}
        onClick={() => { setOrderRequestId(newRequestId()); setConfirming(true); }} className="w-full py-2">Review {side} order</Button>
    </div> : <div className="min-h-0 flex-1 overflow-y-auto">
      {activePositions.map((p) => { const values = edit[p.id] ?? { tp: p.manualTpPrice?.toString() ?? "", sl: p.manualSlPrice?.toString() ?? "" };
        return <div key={p.id} className="space-y-2 border-b border-border p-3 text-xs">
          <div className="flex justify-between"><strong>{p.pair} · {p.quantity}</strong><StatusBadge status={p.status} /></div>
          <div className="text-ink-faint">Entry {p.entryPrice ? fmtPrice(p.entryPrice) : "—"} · {p.protectionType ?? "no protection"} {p.protectionState ?? ""}</div>
          <div className="grid grid-cols-2 gap-2"><TextInput aria-label="Take profit" placeholder="TP" value={values.tp}
            onChange={(e) => setEdit((old) => ({ ...old, [p.id]: { ...values, tp: e.target.value } }))} />
            <TextInput aria-label="Stop loss" placeholder="SL" value={values.sl}
            onChange={(e) => setEdit((old) => ({ ...old, [p.id]: { ...values, sl: e.target.value } }))} /></div>
          <div className="flex gap-2"><Button disabled={pending} onClick={() => void protection(p)}>Save TP/SL</Button>
            <Button variant="ghost" disabled={pending} onClick={() => void protection(p, true)}>Remove</Button></div>
        </div>; })}
      {state.orders.map((o) => <div key={o.id} className="border-b border-border/60 px-3 py-2.5 text-xs">
        <div className="flex items-center justify-between"><span className="font-medium">{o.side} {o.orderType} · {o.symbol}</span><StatusBadge status={o.status} /></div>
        <div className="mt-1 text-ink-faint">{o.quantityType === "quote" ? `${o.requestedQuoteQty} USDT` : `${o.requestedBaseQty} base`}
          {o.limitPrice ? ` @ ${fmtPrice(o.limitPrice)}` : ""} · filled {o.filledBaseQty}
          {accountLabel(o.exchangeAccountId)}</div>
        {o.error && <div className="mt-1 text-down">{o.error}</div>}
        {o.orderType === "LIMIT" && ["requested", "submitted", "open", "partially_filled"].includes(o.status) &&
          <Button variant="danger" disabled={pending} className="mt-2" onClick={() => void cancel(o.id)}>Cancel limit</Button>}
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
