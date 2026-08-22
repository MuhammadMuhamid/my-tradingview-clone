"use client";
import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader, Button, StatusBadge, Empty } from "@/components/ui";
import { DeploymentForm } from "@/components/DeploymentForm";
import { AlertFeed } from "@/components/AlertFeed";
import { EditAlertModal } from "@/components/tv/EditAlertModal";
import { api } from "@/lib/api";
import type { Alert, Deployment, SymbolInfo } from "@/lib/types";
import { fmtAgo, fmtPrice } from "@/lib/format";

export default function DeploymentsPage() {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [deps, setDeps] = useState<Deployment[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Deployment | null>(null);

  const refresh = useCallback(async () => {
    const [d, a] = await Promise.all([api.listDeployments(), api.listAlerts(100)]);
    setDeps(d);
    setAlerts(a);
  }, []);

  useEffect(() => {
    api.listSymbols().then(setSymbols).catch(() => {});
    refresh().catch(() => {});
  }, [refresh]);

  // Live telemetry: poll alerts + deployment state.
  useEffect(() => {
    const t = setInterval(() => refresh().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const toggle = async (d: Deployment) => {
    if (d.status === "active") await api.pauseDeployment(d.id);
    else await api.activateDeployment(d.id);
    await refresh();
  };
  const remove = async (d: Deployment) => {
    if (!confirm(`Delete deployment for ${d.symbol}? Its alert history is removed too.`)) return;
    await api.deleteDeployment(d.id);
    await refresh();
  };

  const activeCount = deps.filter((d) => d.status === "active").length;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Live deployments & alerts</h1>
          <p className="text-sm text-ink-faint">{activeCount} active · signals fire on confirmed bar close and POST to your bot</p>
        </div>
        <Button variant={showForm ? "ghost" : "primary"} onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "+ New deployment"}
        </Button>
      </div>

      {showForm && <DeploymentForm symbols={symbols} onCreated={() => { setShowForm(false); refresh(); }} />}

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
                  <Button onClick={() => setEditing(d)}>Edit</Button>
                  <Button variant={d.status === "active" ? "default" : "primary"} onClick={() => toggle(d)}>
                    {d.status === "active" ? "Pause" : "Activate"}
                  </Button>
                  <Button variant="danger" onClick={() => remove(d)}>Delete</Button>
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
        onSaved={() => { refresh().catch(() => {}); }}
      />
    </div>
  );
}
