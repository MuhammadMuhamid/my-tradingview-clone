"use client";
import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader, Button, StatusBadge, Empty } from "@/components/ui";
import { DeploymentForm } from "@/components/DeploymentForm";
import { AlertFeed } from "@/components/AlertFeed";
import { EditAlertModal } from "@/components/tv/EditAlertModal";
import { StaleNotice } from "@/components/StaleNotice";
import { api } from "@/lib/api";
import { freshAt, type Freshness } from "@/lib/freshness";
import type { Alert, Deployment, SymbolInfo } from "@/lib/types";
import { fmtAgo, fmtPrice } from "@/lib/format";

export default function DeploymentsPage() {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [deps, setDeps] = useState<Deployment[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Deployment | null>(null);
  /**
   * FE-12/FE-13: this page used `refresh().catch(() => {})`, so a backend that
   * went away left it rendering the last successful response for as long as it
   * stayed open. On a page whose whole purpose is showing whether live trading
   * is running, a frozen "active" badge is worse than no badge.
   */
  const [freshness, setFreshness] = useState<Freshness>({ lastOkAt: null, lastError: null });
  /** The most recent failed action, which is separate from a failed poll. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([api.listDeployments(), api.listAlerts(100)]);
      setDeps(d);
      setAlerts(a);
      setFreshness(freshAt(Date.now()));
    } catch (e) {
      // The data already on screen is kept — it is the last thing known to be
      // true — but the page now says how old it is.
      setFreshness((f) => ({ ...f, lastError: (e as Error).message }));
    }
  }, []);

  useEffect(() => {
    api.listSymbols().then(setSymbols).catch(() => {
      // Only used to populate the new-deployment form's symbol list; the form
      // reports its own failure when it is opened.
    });
    void refresh();
  }, [refresh]);

  // Live telemetry: poll alerts + deployment state.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  /**
   * Run one action against a deployment, and say so when it fails.
   *
   * Neither of these had a catch. Pausing a live deployment while the backend
   * was unreachable left the button looking pressed, the row still reading
   * "active" and an unhandled rejection in the console — the user believing
   * they had stopped something that was still trading.
   */
  const act = async (d: Deployment, what: string, fn: () => Promise<unknown>) => {
    setBusy(d.id);
    setActionError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setActionError(`Could not ${what} ${d.symbol}: ${(e as Error).message}`);
      // Re-read, so the row shows what the server actually holds rather than
      // what the click implied.
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const toggle = (d: Deployment) =>
    act(d, d.status === "active" ? "pause" : "activate",
      () => (d.status === "active" ? api.pauseDeployment(d.id) : api.activateDeployment(d.id)));

  const remove = (d: Deployment) => {
    if (!confirm(`Delete deployment for ${d.symbol}? Its alert history is removed too.`)) return;
    void act(d, "delete", () => api.deleteDeployment(d.id));
  };

  const activeCount = deps.filter((d) => d.status === "active").length;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Live trading</h1>
          <p className="text-sm text-ink-faint">{activeCount} active · signals fire on confirmed bar close and POST to your bot</p>
        </div>
        <Button variant={showForm ? "ghost" : "primary"} onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "+ New deployment"}
        </Button>
      </div>

      <StaleNotice state={freshness} />
      {actionError && (
        <div role="alert" className="flex items-start gap-3 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
          <span className="min-w-0 flex-1">{actionError}</span>
          <button onClick={() => setActionError(null)} aria-label="Dismiss" className="shrink-0 hover:text-ink">✕</button>
        </div>
      )}

      {showForm && <DeploymentForm symbols={symbols} onCreated={() => { setShowForm(false); void refresh(); }} />}

      <Card>
        <CardHeader title="Deployments" right={<span className="text-xs text-ink-faint">{deps.length}</span>} />
        {deps.length === 0 ? (
          <Empty>No deployments yet. Create one to start live streaming + alerting.</Empty>
        ) : (
          <div className="divide-y divide-border">
            {deps.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <StatusBadge status={d.status} />
                <span className="font-medium">{d.symbol}</span>
                <span className="text-sm text-ink-muted">{d.timeframe}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-muted">{d.delivery}</span>
                {d.buyQuoteQty != null && (
                  <span className="text-xs text-ink-muted">buy {d.buyQuoteQty} USDT</span>
                )}
                <span className={`text-xs ${d.runtimeState.position === "long" ? "text-up" : "text-ink-faint"}`}>
                  {d.runtimeState.position === "long"
                    ? `in position @ ${fmtPrice(d.runtimeState.entryPrice)}`
                    : "flat"}
                </span>
                {d.lastBarTime && <span className="text-xs text-ink-faint">last bar {fmtAgo(d.lastBarTime)}</span>}
                <div className="ml-auto flex items-center gap-2">
                  <Button onClick={() => setEditing(d)} disabled={busy !== null}>Edit</Button>
                  <Button
                    variant={d.status === "active" ? "default" : "primary"}
                    onClick={() => void toggle(d)}
                    disabled={busy !== null}
                  >
                    {busy === d.id ? "Working…" : d.status === "active" ? "Pause" : "Activate"}
                  </Button>
                  <Button variant="danger" onClick={() => remove(d)} disabled={busy !== null}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Alert telemetry" right={<span className="text-xs text-ink-faint">last {alerts.length} · auto-refresh 5s</span>} />
        <AlertFeed alerts={alerts} />
      </Card>

      <EditAlertModal
        deployment={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { void refresh(); }}
      />
    </div>
  );
}
