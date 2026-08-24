"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import type { DeliveryMode, Deployment } from "@/lib/types";

/**
 * TradingView-style "Edit alert" dialog. Edits the delivery side of a live
 * deployment: buy amount, webhook URL, secret, bot UUID, delivery mode.
 * Changes take effect on the next confirmed bar — no pause needed. Strategy
 * identity (symbol/timeframe/params) is fixed; recreate the alert to change it.
 */
export function EditAlertModal({
  deployment, onClose, onSaved,
}: {
  deployment: Deployment | null;
  onClose: () => void;
  onSaved: (d: Deployment) => void;
}) {
  const [delivery, setDelivery] = useState<DeliveryMode>("custom");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [botUuid, setBotUuid] = useState("");
  const [buyQuoteQty, setBuyQuoteQty] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Refill the form each time a deployment is opened for editing. Secret and
  // bot UUID are stored encrypted and never returned by the API — blank means
  // "keep the current value".
  useEffect(() => {
    if (!deployment) return;
    setDelivery(deployment.delivery);
    setWebhookUrl(deployment.webhookUrl ?? "");
    setSecret("");
    setBotUuid("");
    setBuyQuoteQty(deployment.buyQuoteQty ?? 0);
    setErr(null);
  }, [deployment]);

  const save = async () => {
    if (!deployment) return;
    setBusy(true);
    setErr(null);
    try {
      const body: Parameters<typeof api.updateDeployment>[1] = {};
      if (delivery !== deployment.delivery) body.delivery = delivery;
      if ((webhookUrl || null) !== deployment.webhookUrl && webhookUrl) body.webhookUrl = webhookUrl;
      if (secret) body.secret = secret;
      if (botUuid) body.botUuid = botUuid;
      if (buyQuoteQty !== (deployment.buyQuoteQty ?? 0)) body.buyQuoteQty = buyQuoteQty;
      const updated = Object.keys(body).length > 0
        ? await api.updateDeployment(deployment.id, body)
        : deployment;
      onSaved(updated);
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
    <Modal
      open={deployment !== null}
      onClose={onClose}
      title={deployment ? <>Edit alert on <span className="text-accent">{deployment.symbol}</span></> : "Edit alert"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !deployment}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      {deployment && (
        <div className="space-y-3">
          <Row label="Condition">
            <div className={`${box} bg-surface-2/60 text-ink-muted`}>
              {deployment.symbol} · {deployment.timeframe} <span className="text-ink-faint">(not editable — recreate the alert to change)</span>
            </div>
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
                  placeholder={delivery === "3commas" ? "blank = api.3commas.io/signal_bots/webhooks" : "https://your-bot/webhook"} />
              </Row>
              <Row label="Secret">
                <input value={secret} onChange={(e) => setSecret(e.target.value)} className={box}
                  placeholder="leave blank to keep the current secret" type="password" autoComplete="off" autoCorrect="off" spellCheck={false} data-1p-ignore />
              </Row>
              {delivery === "3commas" && (
                <Row label="Bot UUID">
                  <input value={botUuid} onChange={(e) => setBotUuid(e.target.value)} className={box}
                    placeholder="leave blank to keep the current UUID" />
                </Row>
              )}
            </>
          )}
          <Row label="Buy size">
            <input type="number" value={buyQuoteQty}
              onChange={(e) => setBuyQuoteQty(parseFloat(e.target.value || "0"))} className={box} />
          </Row>

          <p className="pt-1 text-xs text-ink-faint">
            Changes apply from the next confirmed bar — the alert keeps running while you edit.
            {deployment.runtimeState.position === "long" &&
              " This alert is currently in a position; the new buy size applies to the next entry."}
          </p>
          {err && <p className="text-sm text-down">{err}</p>}
        </div>
      )}
    </Modal>
  );
}
