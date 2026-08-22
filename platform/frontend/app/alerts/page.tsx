"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardHeader, Button, Empty } from "@/components/ui";
import { PushSetup } from "@/components/tv/PushSetup";
import { api, type MaAlert, type MaAlertEvent } from "@/lib/api";
import { maColor, maLabel } from "@/lib/movingAverages";
import { fmtAgo, fmtPrice } from "@/lib/format";

/**
 * Every moving-average alert across every coin, in one place.
 *
 * The chart's MA panel only ever shows the symbol you are looking at, which
 * stops being useful past a handful of coins. This page is the inventory: what
 * is armed, what fired, and whether it actually reached a phone.
 */
export default function AlertsPage() {
  const [alerts, setAlerts] = useState<MaAlert[] | null>(null);
  const [events, setEvents] = useState<MaAlertEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, e] = await Promise.all([api.listMaAlerts(), api.maAlertEvents(50)]);
      setAlerts(a);
      setEvents(e);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
      setAlerts((cur) => cur ?? []);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  // A fired alert should show up here without a manual reload.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  /** Grouped by coin, each coin's lines ordered longest-period first. */
  const bySymbol = useMemo(() => {
    const map = new Map<string, MaAlert[]>();
    for (const a of alerts ?? []) {
      const list = map.get(a.symbol) ?? [];
      list.push(a);
      map.set(a.symbol, list);
    }
    for (const list of map.values()) {
      list.sort((x, y) => y.maLength - x.maLength || x.maType.localeCompare(y.maType));
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [alerts]);

  const enabledCount = (alerts ?? []).filter((a) => a.enabled).length;

  const act = async (id: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(id);
    try {
      await fn();
      await refresh();
      setToast(message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const deleteAll = async () => {
    const list = alerts ?? [];
    if (list.length === 0) return;
    if (!window.confirm(
      `Delete all ${list.length} moving-average alerts?\n\n` +
      `This cannot be undone. Fired-alert history is kept.`
    )) return;
    setBusy("all");
    try {
      // Sequential rather than parallel: 80 concurrent deletes would hammer
      // the API for no benefit, and a partial failure stays easy to read.
      for (const a of list) await api.deleteMaAlert(a.id);
      await refresh();
      setToast(`Deleted ${list.length} alerts`);
    } catch (e) {
      setErr((e as Error).message);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const describe = (a: MaAlert): string => {
    switch (a.mode) {
      case "touch": return "touches";
      case "cross_up": return "crosses above";
      case "cross_down": return "crosses below";
      case "near_above": return `${a.nearMinPct}–${a.nearMaxPct}% above`;
      case "near_below": return `${a.nearMinPct}–${a.nearMaxPct}% below`;
    }
  };

  return (
    <div className="mx-auto max-w-[1100px] space-y-4 px-3 py-4 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Moving-average alerts</h1>
          <p className="text-xs text-ink-faint">
            Evaluated server-side on closed candles and pushed to your devices — the chart does not
            need to be open.
          </p>
        </div>
        <div className="w-full sm:w-[320px]">
          <PushSetup onMessage={setToast} />
        </div>
      </div>

      {err && (
        <div className="rounded-md border border-down/30 bg-down/10 px-3 py-2 text-xs text-down">
          {err}
        </div>
      )}

      <Card>
        <CardHeader
          title={
            alerts === null
              ? "Active alerts"
              : `Active alerts · ${enabledCount} of ${alerts.length} enabled · ${bySymbol.length} coin${bySymbol.length === 1 ? "" : "s"}`
          }
          right={
            <Button variant="danger" onClick={deleteAll}
              disabled={busy !== null || (alerts?.length ?? 0) === 0}>
              {busy === "all" ? "Deleting…" : "Delete all"}
            </Button>
          }
        />
        {alerts === null ? (
          <Empty>Loading…</Empty>
        ) : alerts.length === 0 ? (
          <Empty>
            No moving-average alerts yet. Open a chart, click the 🔔 next to any SMA or EMA in the
            moving-averages panel, and it will appear here.
          </Empty>
        ) : (
          <div className="divide-y divide-border">
            {bySymbol.map(([symbol, list]) => (
              <div key={symbol}>
                <div className="flex items-baseline gap-2 bg-surface-2/40 px-4 py-1.5">
                  <span className="text-xs font-semibold text-ink">{symbol}</span>
                  <span className="text-[11px] text-ink-faint">
                    {list.length} alert{list.length === 1 ? "" : "s"}
                  </span>
                </div>
                {list.map((a) => (
                  <div key={a.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px] hover:bg-surface-2/40">
                    <span className="inline-block h-[3px] w-4 shrink-0 rounded-full"
                      style={{ background: maColor(a.maLength), opacity: a.enabled ? 1 : 0.3 }} />
                    <span className={`w-[68px] shrink-0 font-medium ${a.enabled ? "text-ink" : "text-ink-faint"}`}>
                      {maLabel(a.maType, a.maLength)}
                    </span>
                    <span className={a.enabled ? "text-ink-muted" : "text-ink-faint"}>
                      price {describe(a)}
                    </span>
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-muted">
                      {a.timeframe}
                    </span>
                    <span className="text-[11px] text-ink-faint">
                      cooldown {a.cooldownMin}m
                      {a.lastFiredAt && ` · last fired ${fmtAgo(a.lastFiredAt)}`}
                    </span>
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      <button
                        disabled={busy !== null}
                        onClick={() => void act(a.id,
                          () => api.updateMaAlert(a.id, { enabled: !a.enabled }),
                          `${a.symbol} ${maLabel(a.maType, a.maLength)} ${a.enabled ? "paused" : "enabled"}`)}
                        className={`rounded px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                          a.enabled
                            ? "bg-up/15 text-up hover:bg-up/25"
                            : "bg-surface-2 text-ink-muted hover:text-ink"
                        }`}
                      >
                        {a.enabled ? "Active" : "Paused"}
                      </button>
                      <button
                        disabled={busy !== null}
                        onClick={() => void act(a.id,
                          () => api.deleteMaAlert(a.id),
                          `Deleted ${a.symbol} ${maLabel(a.maType, a.maLength)}`)}
                        aria-label="Delete alert"
                        className="rounded px-2 py-1 text-[11px] text-ink-faint hover:bg-down/15 hover:text-down disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={`Recently fired · ${events.length}`} />
        {events.length === 0 ? (
          <Empty>
            Nothing has fired yet. Alerts are checked when each candle closes on their timeframe.
          </Empty>
        ) : (
          <div className="divide-y divide-border">
            {events.map((e) => (
              <div key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-[13px]">
                <span className="w-[150px] shrink-0 font-medium text-ink">{e.title}</span>
                <span className="text-ink-muted">
                  {fmtPrice(e.price)}
                  <span className="text-ink-faint"> vs </span>
                  {fmtPrice(e.maValue)}
                </span>
                <span className={e.distancePct >= 0 ? "text-up" : "text-down"}>
                  {e.distancePct >= 0 ? "+" : ""}{e.distancePct.toFixed(2)}%
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px]">
                  {/* Whether it actually reached a phone is the thing worth
                      surfacing — a fired alert nobody saw is a silent failure. */}
                  <span className={e.pushedTo > 0 ? "text-ink-faint" : "text-down"}>
                    {e.pushedTo > 0
                      ? `sent to ${e.pushedTo} device${e.pushedTo === 1 ? "" : "s"}`
                      : "no device registered"}
                  </span>
                  <span className="text-ink-faint">{fmtAgo(e.firedAt)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-surface px-4 py-2 text-sm text-ink shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
