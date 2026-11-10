"use client";
/**
 * Execution notifications (P-81): a push notification to this admin for each
 * CONFIRMED Bot BUY/SELL execution, meaning a fill the Bot's ledger booked.
 * A submitted, rejected or unknown order is never announced.
 *
 * Two separate switches, both shown:
 *   - "Notify me" is this account's preference (server-side, admins only);
 *   - "This device" is the browser's own push permission and subscription,
 *     the same one chart alerts use (`lib/push.ts`). Without it, nothing
 *     arrives on this device, whatever the preference says.
 * The Bot must also advertise its execution feed; an older Bot is said so.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Card, CardHeader, Checkbox, Notice } from "@/components/ui";
import { api, type BotNotificationStatus } from "@/lib/api";
import { describeAction, type FailureCopy } from "@/lib/errorCopy";
import { fmtDateTime } from "@/lib/format";
import { enablePush, pushState, subscribedHere } from "@/lib/push";

type DeviceState = ReturnType<typeof pushState>;

export const ENV_LABEL: Record<BotNotificationStatus["recent"][number]["environment"], string> = {
  MAINNET: "REAL", TESTNET: "TESTNET", DRY_RUN: "DRY RUN", UNKNOWN: "UNKNOWN",
};

const FEED_TEXT: Record<BotNotificationStatus["botFeed"], string | null> = {
  yes: null,
  no: "The connected Bot is an older version without the execution feed. Update the Bot to receive these notifications.",
  unreachable: "The Bot can't be reached right now. Notifications resume when it is back; the Bot keeps trading either way.",
  not_configured: "No Bot connection is configured on this Platform, so there is nothing to notify about.",
};

function deviceText(state: DeviceState | null, here: boolean | null): string {
  if (state === null || here === null) return "Checking this device…";
  if (state === "unsupported") return "This browser can't receive push notifications. Executions still appear below.";
  if (state === "needs-install") return "On iPhone or iPad, add Trading Scene to the Home Screen first (Share → Add to Home Screen), then enable here from the installed app.";
  if (state === "denied") return "Notifications are blocked for this site in the browser settings. Re-allow them, then reload.";
  return here ? "This device is registered for push." : "This device is not registered yet.";
}

export function ExecutionNotificationsCard() {
  const [status, setStatus] = useState<BotNotificationStatus | null>(null);
  const [error, setError] = useState<FailureCopy | null>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [here, setHere] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await api.botNotifications()); setError(null); }
    catch (e) { setError(describeAction(e, "read the notification settings")); }
    setDevice(pushState());
    setHere(await subscribedHere());
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(describeAction(e, "change execution notifications")); }
    finally { setBusy(false); }
  };

  const feedNote = status ? (status.featureEnabled ? FEED_TEXT[status.botFeed]
    : "Execution notifications are turned off on this Platform (BOT_EXECUTION_NOTIFICATIONS_ENABLED=false).") : null;
  const canEnableDevice = device === "default" || (device === "granted" && here === false);

  return (
    <Card>
      <CardHeader title="Execution notifications" />
      <div className="space-y-3 px-4 pb-4 text-sm">
        <p className="text-ink-muted">
          A push notification for every <strong className="text-ink">confirmed</strong> Bot BUY or SELL: strategy,
          TP/SL, partial and manual fills. Each one shows the symbol, quantity, price and environment
          (REAL, TESTNET, DRY RUN or UNKNOWN). Submitted, rejected or unknown orders are never announced.
          A manual order that fills in pieces sends one notification per fill.
        </p>
        {feedNote && <Notice tone="warn">{feedNote}</Notice>}
        {error && <Notice tone="error"><span title={error.detail || undefined}>{error.headline}</span></Notice>}
        {status && (
          <label className="flex items-center gap-2 text-ink">
            <Checkbox
              label="Notify me about confirmed Bot executions"
              checked={status.enabled}
              disabled={busy || !status.featureEnabled}
              onChange={(checked: boolean) => void run(async () => { await api.setBotNotifications(checked); })}
            />
            <span>Notify me about confirmed Bot executions</span>
          </label>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-2/40 p-2.5">
          <span className="text-xs text-ink-muted" data-testid="exec-notify-device">{deviceText(device, here)}</span>
          {canEnableDevice && (
            <Button variant="primary" disabled={busy} onClick={() => void run(async () => { await enablePush(); })}>
              {busy ? "…" : "Enable on this device"}
            </Button>
          )}
        </div>
        {status?.enabled && status.devices === 0 && (
          <Notice tone="warn">You opted in, but no device is registered for push yet, so nothing will arrive.</Notice>
        )}
        {status && status.recent.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-ink-muted">Recent confirmed executions</div>
            <ul className="divide-y divide-border text-xs" data-testid="exec-notify-recent">
              {status.recent.map((r) => (
                <li key={r.eventId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
                  <span className={r.side === "BUY" ? "font-medium text-up" : "font-medium text-down"}>{r.side}</span>
                  <span className="text-ink">{r.symbol}</span>
                  <span className="tabular-nums text-ink-muted">{r.executedBaseQty} @ {r.averagePrice}</span>
                  <span className="rounded border border-border px-1 text-[10px] text-ink-muted">{ENV_LABEL[r.environment]}</span>
                  {!r.orderComplete && <span className="text-[10px] text-ink-faint">partial fill</span>}
                  <span className="ml-auto text-ink-faint">{fmtDateTime(r.executedAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
