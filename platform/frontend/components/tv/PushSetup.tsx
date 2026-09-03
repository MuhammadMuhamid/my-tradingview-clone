"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  disablePush, enablePush, iosNeedsInstall, pushState, pushSupported,
  refreshSubscription, subscribedHere,
} from "@/lib/push";

/**
 * Notification enrolment. Alerts are useless if the phone was never
 * registered, so this sits at the bottom of the MA panel where alerts are
 * created rather than buried in a settings page.
 */
export function PushSetup({ onMessage }: { onMessage: (m: string) => void }) {
  const [state, setState] = useState<ReturnType<typeof pushState> | null>(null);
  /**
   * Whether THIS browser is enrolled. Permission alone is not enrolment: a
   * desktop browser can hold a granted permission with no subscription, and
   * reading only the permission left it showing Test/Off with no way back to
   * Enable.
   */
  const [here, setHere] = useState<boolean | null>(null);
  /** Server-wide subscription count — every device, not this one. */
  const [devices, setDevices] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Permission state is only readable in the browser, so resolve after mount
  // to keep the server-rendered markup stable.
  useEffect(() => {
    setState(pushState());
    void subscribedHere().then(async (enrolled) => {
      setHere(enrolled);
      // Heartbeat. The server ages out subscriptions that stop re-registering,
      // because that is the only thing a dead endpoint cannot do — so a live
      // device has to say hello or it will eventually be pruned.
      if (enrolled) await refreshSubscription();
    });
    api.vapidKey().then((r) => setDevices(r.devices)).catch(() => setDevices(null));
  }, []);

  const refresh = async () => {
    setState(pushState());
    setHere(await subscribedHere());
    try { setDevices((await api.vapidKey()).devices); } catch { /* offline */ }
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Both facts are resolved after mount. Rendering on the permission alone
  // would flash "Enable" at an already-enrolled device on every load.
  if (state === null || here === null) return null;

  if (state === "needs-install") {
    return (
      <Box>
        <p className="text-xs text-ink-muted">
          On iPhone, notifications require the app to be installed: tap
          <strong className="text-ink"> Share → Add to Home Screen</strong>, open it from the
          Home Screen, then enable notifications here.
        </p>
      </Box>
    );
  }

  if (!pushSupported() && !iosNeedsInstall()) {
    return (
      <Box>
        <p className="text-xs text-ink-faint">
          This browser cannot receive push notifications. Alerts still fire and are listed in the
          alert feed.
        </p>
      </Box>
    );
  }

  return (
    <Box>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-ink">Notifications on this device</div>
          <div className="text-[11px] text-ink-faint">
            {state === "denied"
              ? "Blocked in browser settings"
              : here
                ? `On · ${devices ?? "?"} device${devices === 1 ? "" : "s"} registered in total`
                : `Not enabled here${devices ? ` · ${devices} elsewhere` : ""}`}
          </div>
        </div>
        {state === "granted" && here ? (
          <div className="flex shrink-0 gap-1">
            <button disabled={busy}
              onClick={() => void run(async () => {
                const r = await api.testPush();
                onMessage(r.sent > 0
                  ? `Test sent to ${r.sent} device${r.sent === 1 ? "" : "s"}`
                  : "No device received the test — try enabling again");
              })}
              className="rounded border border-border px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40">
              Test
            </button>
            <button disabled={busy}
              onClick={() => void run(async () => { await disablePush(); onMessage("Notifications disabled on this device"); })}
              className="rounded border border-border px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40">
              Off
            </button>
          </div>
        ) : (
          <button disabled={busy || state === "denied"}
            onClick={() => void run(async () => {
              const r = await enablePush();
              onMessage(`Notifications enabled — ${r.devices} device${r.devices === 1 ? "" : "s"} registered`);
            })}
            className="shrink-0 rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40">
            {busy ? "…" : "Enable"}
          </button>
        )}
      </div>
      {state === "denied" && (
        <p className="mt-1.5 text-[11px] text-ink-faint">
          Re-allow notifications for this site in your browser settings, then reload.
        </p>
      )}
      {err && <p className="mt-1.5 text-[11px] text-down">{err}</p>}
    </Box>
  );
}

const Box = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-md border border-border bg-surface-2/40 p-2.5">{children}</div>
);
