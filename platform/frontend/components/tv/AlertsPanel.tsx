"use client";
import { useCallback, useEffect, useState } from "react";
import { StaleNotice } from "@/components/StaleNotice";
import { api } from "@/lib/api";
import { freshAt, type Freshness } from "@/lib/freshness";
import type { Alert, Deployment } from "@/lib/types";
import { fmtAgo, fmtPrice } from "@/lib/format";
import { StatusBadge } from "@/components/ui";
import { EditAlertModal } from "./EditAlertModal";

/**
 * The automation sidebar: running strategy deployments with
 * pause/resume/delete, and the log of every signal they sent and how the bot
 * answered.
 *
 * FE-01: this was called "Alerts", which is also what the price and moving
 * average notifications are called. Two very different things sharing one word
 * is how a user ends up believing a live 800 USDT deployment will merely buzz
 * their phone. Notifications live on the /alerts page and in the MA panel;
 * everything in here places orders.
 */
export function AlertsPanel({ onCreateAlert }: { onCreateAlert: () => void }) {
  const [tab, setTab] = useState<"alerts" | "log">("alerts");
  const [deps, setDeps] = useState<Deployment[]>([]);
  const [log, setLog] = useState<Alert[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Deployment | null>(null);
  /**
   * A swallowed poll failure left this panel showing a deployment as "active"
   * for as long as the chart stayed open, which on the panel that says whether
   * money is moving is the one place a frozen answer is unacceptable.
   */
  const [freshness, setFreshness] = useState<Freshness>({ lastOkAt: null, lastError: null });
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([api.listDeployments(), api.listAlerts(100)]);
      setDeps(d);
      setLog(a);
      setFreshness(freshAt(Date.now()));
    } catch (e) {
      setFreshness((f) => ({ ...f, lastError: (e as Error).message }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const depSymbol = (id: string): string => deps.find((d) => d.id === id)?.symbol ?? "";

  /**
   * FE-12: pausing or deleting had `finally { setBusy(null) }` and no catch, so
   * a failure spun the button, restored it, and changed nothing — the user
   * believing they had stopped a strategy that was still running.
   */
  const act = async (d: Deployment, what: string, fn: () => Promise<unknown>) => {
    setBusy(d.id);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(`Could not ${what} ${d.symbol}: ${(e as Error).message}`);
    } finally {
      // Always re-read: the row must show what the server holds, not what the
      // click intended.
      await refresh();
      setBusy(null);
    }
  };

  const toggle = (d: Deployment) =>
    act(d, d.status === "active" ? "pause" : "activate",
      () => (d.status === "active" ? api.pauseDeployment(d.id) : api.activateDeployment(d.id)));

  const remove = (d: Deployment) => {
    if (!window.confirm(`Stop and delete the automation on ${d.symbol} ${d.timeframe}?`)) return;
    void act(d, "delete", () => api.deleteDeployment(d.id));
  };

  return (
    <aside className="flex h-full w-[85vw] max-w-[290px] shrink-0 flex-col border-l border-border bg-surface md:w-[290px]">
      {/* tabs */}
      <div className="flex items-center gap-1 border-b border-border p-2">
        {([["alerts", "Running"], ["log", "Order log"]] as const).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {(freshness.lastError || actionError) && (
        <div className="space-y-1.5 border-b border-border px-2 py-2">
          <StaleNotice state={freshness} />
          {actionError && (
            <div role="alert" className="rounded-md border border-down/40 bg-down/10 px-2.5 py-1.5 text-[11px] text-down">
              {actionError}
            </div>
          )}
        </div>
      )}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <button onClick={onCreateAlert} className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink" title="Automate a strategy — sends live orders">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M7.5 2v11M2 7.5h11" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
        <span className="text-xs text-ink-faint">
          {tab === "alerts" ? `${deps.filter((d) => d.status === "active").length} active` : `${log.length} events`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "alerts" ? (
          deps.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#6b7486" strokeWidth="1.2">
                <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
              </svg>
              <p className="text-sm text-ink-muted">
                An automation runs a strategy server-side and sends every buy and sell to your bot
                as a real order.
              </p>
              <p className="text-xs text-ink-faint">
                Looking to be notified about a price instead? That is the bell in the toolbar.
              </p>
              <button onClick={onCreateAlert} className="rounded-md bg-ink px-4 py-1.5 text-sm font-semibold text-bg hover:bg-ink/90">
                Automate a strategy
              </button>
            </div>
          ) : (
            deps.map((d) => (
              <div key={d.id} className="group border-b border-border/50 px-3 py-2.5 hover:bg-surface-2/60">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-ink">{d.symbol} <span className="text-ink-faint">· {d.timeframe}</span></span>
                  <StatusBadge status={d.status} />
                </div>
                <div className="mt-0.5 flex items-center justify-between">
                  <span className="text-xs text-ink-faint">
                    {d.delivery === "off" ? "log only" : d.delivery === "paper" ? "paper" : d.delivery}
                    {d.buyQuoteQty != null && <> · {d.buyQuoteQty} USDT</>}
                    {" · "}{d.runtimeState.position === "long" ? "in position" : "flat"}
                  </span>
                  <span className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      onClick={() => setEditing(d)}
                      disabled={busy === d.id}
                      className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-border hover:text-ink"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => void toggle(d)}
                      disabled={busy === d.id}
                      className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-border hover:text-ink"
                    >
                      {d.status === "active" ? "Pause" : "Resume"}
                    </button>
                    <button
                      onClick={() => remove(d)}
                      disabled={busy === d.id}
                      className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-down/20 hover:text-down"
                    >
                      Delete
                    </button>
                  </span>
                </div>
              </div>
            ))
          )
        ) : log.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink-faint">
            No orders sent yet. Every signal an automation produces appears here with the
            answer your bot gave.
          </div>
        ) : (
          log.map((a) => (
            <div key={a.id} className="border-b border-border/50 px-3 py-2">
              <div className="flex items-center justify-between text-[13px]">
                <span>
                  <span className={`font-semibold ${a.action === "buy" ? "text-up" : "text-down"}`}>
                    {a.action.toUpperCase()}
                  </span>{" "}
                  <span className="text-ink">{depSymbol(a.deploymentId)}</span>
                </span>
                <span className="tabular text-ink-muted">{fmtPrice(a.triggerPrice)}</span>
              </div>
              <div className="mt-0.5 flex items-center justify-between text-xs text-ink-faint">
                <span>{a.reason ?? "signal"} · {fmtAgo(a.firedAt)}</span>
                <StatusBadge status={a.deliveryStatus} />
              </div>
            </div>
          ))
        )}
      </div>

      <EditAlertModal
        deployment={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { void refresh(); }}
      />
    </aside>
  );
}
