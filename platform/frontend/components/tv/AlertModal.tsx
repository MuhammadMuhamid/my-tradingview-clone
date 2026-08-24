"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import type { DeliveryMode, Interval, Strategy, StrategyParams } from "@/lib/types";
import { defaultParamsFor } from "@/lib/paramSchema";

/**
 * Start automated trading on a strategy.
 *
 * This is NOT a notification. It creates a deployment and activates it: the
 * strategy runs server-side on confirmed bar closes and every buy/sell POSTs
 * your bot's webhook payload, which places real orders with real money.
 *
 * FE-01: this dialog used to be reached from a bell labelled "Alert" and
 * created a live 800 USDT deployment on the first click. A bell means "tell me
 * when" — a user asking to be notified about a price could arm live trading
 * instead, and only find out when an order filled. The bell now opens the price
 * alert dialog; this one is behind a button that says "Automate", says what it
 * does in its own title, and requires the consequence to be acknowledged before
 * Create is enabled.
 */
export function AlertModal({
  open, onClose, symbol, timeframe, strategy, strategies, params, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  timeframe: Interval;
  strategy: Strategy | null;
  strategies: Strategy[];
  params: StrategyParams;
  onCreated: (strategyName: string) => void;
}) {
  const [delivery, setDelivery] = useState<DeliveryMode>("custom");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [botUuid, setBotUuid] = useState("");
  const [buyQuoteQty, setBuyQuoteQty] = useState(800);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conditionKey, setConditionKey] = useState(strategy?.key ?? "ma_rr_v9");
  /**
   * Explicit consent to live order placement.
   *
   * Deliberately not remembered between openings: this dialog activates the
   * deployment on Create, so every activation is its own decision.
   */
  const [acknowledged, setAcknowledged] = useState(false);

  // Reopening, or changing what the consent is FOR, clears it. A checkbox left
  // ticked from a dry run must not carry over into a live one.
  useEffect(() => { setAcknowledged(false); }, [open, delivery, buyQuoteQty]);

  const create = async () => {
    const selected = strategies.find((s) => s.key === conditionKey) ?? strategy;
    if (!selected) return;
    setBusy(true);
    setErr(null);
    try {
      const dep = await api.createDeployment({
        strategyKey: selected.key,
        symbol, timeframe, params: selected.key === strategy?.key ? params : defaultParamsFor(selected.key), delivery,
        webhookUrl: delivery === "off" ? undefined : webhookUrl || undefined,
        secret: secret || undefined,
        botUuid: delivery === "3commas" ? botUuid || undefined : undefined,
        buyQuoteQty,
      });
      await api.activateDeployment(dep.id);
      onCreated(selected.name);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="grid grid-cols-[110px_1fr] items-center gap-3">
      <span className="text-sm text-ink-muted">{label}</span>
      {children}
    </div>
  );
  const box = "w-full rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm text-ink outline-none focus:border-accent";

  return (
    <Modal open={open} onClose={onClose}
      title={<>Automate trading on <span className="text-accent">{symbol}</span></>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create} disabled={busy || !strategy || !acknowledged}>
            {busy ? "Starting…" : "Start trading"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-md border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
          This is not a notification. It starts the strategy immediately and every signal it
          produces sends a real order to your bot. To be told when a price is reached without
          trading, use the bell in the toolbar instead.
        </div>

        <Row label="Condition">
          <select value={conditionKey} onChange={(e) => setConditionKey(e.target.value)} className={box}>
            {strategies.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        </Row>
        <Row label="">
          <div className={`${box} bg-surface-2/60 text-ink-muted`}>Order fills only (buy / sell signals on bar close)</div>
        </Row>
        <Row label="Interval">
          <div className={`${box} bg-surface-2/60`}>Same as chart <span className="text-ink-faint">· {timeframe}</span></div>
        </Row>

        <div className="my-1 border-t border-border" />

        <Row label="Delivery">
          <select value={delivery} onChange={(e) => setDelivery(e.target.value as DeliveryMode)} className={box}>
            <option value="custom">Custom webhook bot</option>
            <option value="3commas">3Commas Signal Bot</option>
            <option value="off">Off — log signals only (dry run)</option>
          </select>
        </Row>
        {delivery !== "off" && (
          <>
            <Row label="Webhook URL">
              <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} className={box}
                placeholder={delivery === "3commas" ? "blank = api.3commas.io/signal_bots/webhooks" : "http://your-bot/webhook"} />
            </Row>
            <Row label="Secret">
              <input value={secret} onChange={(e) => setSecret(e.target.value)} className={box}
                placeholder="webhook secret" type="password" autoComplete="off" autoCorrect="off" spellCheck={false} data-1p-ignore />
            </Row>
            {delivery === "3commas" && (
              <Row label="Bot UUID">
                <input value={botUuid} onChange={(e) => setBotUuid(e.target.value)} className={box} placeholder="signal bot uuid" />
              </Row>
            )}
          </>
        )}
        <Row label="Buy size">
          <input type="number" value={buyQuoteQty} onChange={(e) => setBuyQuoteQty(parseFloat(e.target.value || "0"))} className={box} />
        </Row>

        <p className="pt-1 text-xs text-ink-faint">
          Message payload is fixed to your bot&apos;s exact JSON format (dedupe-keyed, idempotent).
          The automation never expires and survives restarts. Manage it on the Deployments page.
        </p>

        <div className="my-1 border-t border-border" />
        <label className="flex items-start gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent,#f0b90b)]"
          />
          <span>
            {delivery === "off"
              ? "I understand this starts the strategy. Delivery is off, so signals are logged and no orders are sent."
              : `I understand this starts trading immediately and sends real ${buyQuoteQty} USDT buy orders to my bot.`}
          </span>
        </label>
        {err && <p className="text-sm text-down" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}
