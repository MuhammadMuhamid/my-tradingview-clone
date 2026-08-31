"use client";
import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader, Button, StatusBadge, Empty } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { DeploymentForm } from "@/components/DeploymentForm";
import { AlertFeed } from "@/components/AlertFeed";
import { EditAlertModal } from "@/components/tv/EditAlertModal";
import { StaleNotice } from "@/components/StaleNotice";
import { api, type PaperResult } from "@/lib/api";
import { freshAt, type Freshness } from "@/lib/freshness";
import { deliversLiveOrders } from "@/lib/types";
import { activationAcknowledgement } from "@/lib/deploymentConsent";
import type { Alert, Deployment, SymbolInfo } from "@/lib/types";
import { fmtAgo, fmtPrice } from "@/lib/format";

export default function DeploymentsPage() {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [deps, setDeps] = useState<Deployment[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Deployment | null>(null);
  const [paper, setPaper] = useState<PaperResult | null>(null);
  const [activationTarget, setActivationTarget] = useState<Deployment | null>(null);
  const [activationAcknowledged, setActivationAcknowledged] = useState(false);
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

  /** Load a paper deployment's simulated fills into the panel. */
  const openPaper = async (id: string): Promise<void> => {
    setActionError(null);
    try {
      setPaper(await api.paperResult(id));
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

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

  const toggle = (d: Deployment) => {
    // Pausing is a safety action and stays one click. Starting any mode requires
    // a fresh acknowledgement; it is never remembered between activations.
    if (d.status === "active") {
      void act(d, "pause", () => api.pauseDeployment(d.id));
      return;
    }
    setActivationAcknowledged(false);
    setActivationTarget(d);
  };

  const confirmActivation = async () => {
    const d = activationTarget;
    if (!d || !activationAcknowledged) return;
    await act(d, "activate", () => api.activateDeployment(d.id));
    setActivationTarget(null);
    setActivationAcknowledged(false);
  };

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

      {paper && (
        <Card>
          <CardHeader
            title={`Paper results — ${paper.symbol} ${paper.timeframe}`}
            right={
              <button
                onClick={() => setPaper(null)}
                aria-label="Close paper results"
                className="text-xs text-ink-faint hover:text-ink"
              >
                ✕
              </button>
            }
          />
          <div className="space-y-3 px-4 pb-4">
            <p className="rounded border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-ink">
              {paper.caveat}
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <dt className="text-ink-muted">Realised</dt>
              <dd className={`text-right tabular ${paper.summary.realisedPnl >= 0 ? "text-up" : "text-down"}`}>
                {paper.summary.realisedPnl >= 0 ? "+" : ""}
                {paper.summary.realisedPnl.toFixed(2)} USDT
              </dd>
              <dt className="text-ink-muted">Commission</dt>
              <dd className="text-right tabular text-ink">
                {paper.summary.commissionPaid.toFixed(2)} USDT
              </dd>
              <dt className="text-ink-muted">Closed trades</dt>
              <dd className="text-right tabular text-ink">{paper.summary.sells}</dd>
              <dt className="text-ink-muted">Win rate</dt>
              <dd className="text-right tabular text-ink">
                {paper.summary.winRatePct === null ? "—" : `${paper.summary.winRatePct.toFixed(1)}%`}
              </dd>
              <dt className="text-ink-muted">Open position</dt>
              <dd className="text-right tabular text-ink">
                {paper.summary.openPosition.qty > 0
                  ? `${paper.summary.openPosition.qty.toFixed(6)} @ ${paper.summary.openPosition.entryPrice ?? "—"}`
                  : "flat"}
              </dd>
              <dt className="text-ink-muted">Simulated size</dt>
              <dd className="text-right tabular text-ink">{paper.buyQuoteQty ?? "—"} USDT</dd>
            </dl>
            {paper.fills.length === 0 ? (
              <Empty>No simulated fills yet. The strategy has not signalled since paper mode was set.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm tabular">
                  <thead>
                    <tr className="border-b border-border text-xs text-ink-muted">
                      <th className="px-2 py-1.5 text-left">Bar</th>
                      <th className="px-2 py-1.5 text-left">Action</th>
                      <th className="px-2 py-1.5 text-right">Price</th>
                      <th className="px-2 py-1.5 text-right">Qty</th>
                      <th className="px-2 py-1.5 text-right">Fee</th>
                      <th className="px-2 py-1.5 text-right">Realised</th>
                      <th className="px-2 py-1.5 text-left">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paper.fills.slice(0, 50).map((f) => (
                      <tr key={f.id} className="border-b border-border/50">
                        <td className="px-2 py-1.5 text-ink-faint">{new Date(f.barTime).toLocaleString()}</td>
                        <td className="px-2 py-1.5 font-medium">{f.action}</td>
                        <td className="px-2 py-1.5 text-right">{f.price}</td>
                        <td className="px-2 py-1.5 text-right">{f.qty.toFixed(6)}</td>
                        <td className="px-2 py-1.5 text-right">{f.commission.toFixed(4)}</td>
                        <td className={`px-2 py-1.5 text-right ${(f.realisedPnl ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                          {f.realisedPnl === null ? "—" : f.realisedPnl.toFixed(2)}
                        </td>
                        <td className="px-2 py-1.5 text-ink-faint">{f.reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      )}

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
                <span
                  className={
                    d.delivery === "paper"
                      ? "rounded bg-accent/15 px-1.5 py-0.5 text-xs font-medium text-accent"
                      : deliversLiveOrders(d.delivery)
                        ? "rounded bg-warn/15 px-1.5 py-0.5 text-xs font-medium text-ink"
                        : "rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-muted"
                  }
                  title={
                    d.delivery === "paper"
                      ? "Paper: fills are simulated at the live cost model. No order is sent anywhere."
                      : deliversLiveOrders(d.delivery)
                        ? "Live: this deployment sends real buy and sell orders."
                        : "Off: signals are recorded and nothing is sent or simulated."
                  }
                >
                  {d.delivery === "paper" ? "paper (simulated)" : d.delivery}
                </span>
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
                  {d.delivery === "paper" && (
                    <Button onClick={() => void openPaper(d.id)} disabled={busy !== null}>
                      Paper results
                    </Button>
                  )}
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

      <Modal
        open={activationTarget !== null}
        onClose={() => {
          setActivationTarget(null);
          setActivationAcknowledged(false);
        }}
        title="Activate deployment"
        footer={
          <>
            <Button onClick={() => {
              setActivationTarget(null);
              setActivationAcknowledged(false);
            }}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void confirmActivation()}
              disabled={busy !== null || !activationAcknowledged}
            >
              {busy ? "Activating…" : "Activate"}
            </Button>
          </>
        }
      >
        {activationTarget && (
          <div className="space-y-3">
            <p className="rounded-md border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
              Activation starts this deployment immediately. Live delivery can place real orders;
              confirm the exact mode and size below.
            </p>
            <label className="flex items-start gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={activationAcknowledged}
                onChange={(e) => setActivationAcknowledged(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent,#f0b90b)]"
              />
              <span>{activationAcknowledgement(activationTarget)}</span>
            </label>
          </div>
        )}
      </Modal>

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
