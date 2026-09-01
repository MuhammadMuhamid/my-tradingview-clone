"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardHeader, Button, Empty, Select, TextInput } from "@/components/ui";
import { PushSetup } from "@/components/tv/PushSetup";
import { LevelAlertModal } from "@/components/tv/LevelAlertModal";
import { AlertEditor } from "@/components/tv/AlertEditor";
import {
  api, DEFAULT_ALERT_FREQUENCY, type BulkAlertAction, type MaAlert, type MaAlertEvent,
} from "@/lib/api";
import {
  alertColor, alertInactiveReason, alertLineLabel, describeAlert,
  FREQUENCY_LABELS, isAlertActive,
} from "@/lib/alerts";
import { fmtAgo, fmtPrice } from "@/lib/format";
import {
  ALERT_STATUS_FILTERS, ALERT_TYPE_FILTERS, buildBulkRequest, bulkCompletionMessage,
  deleteConfirmation, describeAlertScope, filterAlerts, type AlertStatusFilter,
  type AlertTypeFilter,
} from "@/lib/alertManagement";
import { leavesFilteredView } from "@/lib/alertEditing";
import { parseScannerAlertTarget } from "@/lib/spotScene";

/**
 * Every alert across every coin, in one place.
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
  /** Support/resistance and pivot alerts are armed from here, not the chart. */
  const [levelOpen, setLevelOpen] = useState(false);
  const [newSymbol, setNewSymbol] = useState("SOLUSDT");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<AlertStatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<AlertTypeFilter>("all");
  /** The alert open in the shared editor, or null. */
  const [editing, setEditing] = useState<MaAlert | null>(null);

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
  useEffect(() => {
    const target = parseScannerAlertTarget(window.location.search);
    if (!target) return;
    setNewSymbol(target.symbol);
    setLevelOpen(true);
  }, []);
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

  const filters = useMemo(() => ({
    search, status: statusFilter, type: typeFilter,
  }), [search, statusFilter, typeFilter]);
  const filteredAlerts = useMemo(
    () => filterAlerts(alerts ?? [], filters),
    [alerts, filters]
  );

  /** Filtered and grouped by coin, each coin's lines ordered longest-period first. */
  const bySymbol = useMemo(() => {
    const map = new Map<string, MaAlert[]>();
    for (const a of filteredAlerts) {
      const list = map.get(a.symbol) ?? [];
      list.push(a);
      map.set(a.symbol, list);
    }
    for (const list of map.values()) {
      list.sort((x, y) =>
        (x.conditionKind === "price" ? 0 : 1) - (y.conditionKind === "price" ? 0 : 1) ||
        (y.maLength ?? 0) - (x.maLength ?? 0) ||
        (x.maType ?? "").localeCompare(y.maType ?? "") ||
        (x.targetPrice ?? 0) - (y.targetPrice ?? 0)
      );
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filteredAlerts]);

  // "Active" rather than "enabled": a spent once_only alert is still enabled
  // but will never fire again, and counting it as armed would overstate what is
  // actually being watched.
  const activeCount = (alerts ?? []).filter(isAlertActive).length;

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

  const bulkAct = async (action: BulkAlertAction) => {
    // Snapshot the exact IDs shown at click time. The server never interprets
    // search/filter semantics, so a refresh cannot widen this operation.
    const request = buildBulkRequest(action, filteredAlerts);
    if (!request) return;
    const { ids } = request;
    if (action === "delete") {
      const message = deleteConfirmation(filters, ids.length);
      if (!message || !window.confirm(message)) return;
    }
    setBusy(`bulk-${action}`);
    try {
      const result = await api.bulkMaAlerts(request.action, request.ids);
      const completion = bulkCompletionMessage(action, ids.length, result);
      await refresh();
      setToast(completion);
    } catch (e) {
      setErr((e as Error).message);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-[1100px] space-y-4 px-3 py-4 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Alerts</h1>
          <p className="text-xs text-ink-faint">
            Price levels and moving averages, evaluated server-side and pushed to your devices —
            the chart does not need to be open.
          </p>
          {/*
            These alerts NOTIFY. They cannot reach a deployment, a broker or an
            order, and that separation is asserted over the alert runner's whole
            transitive import graph in tests/alertIsolation.test.ts. Saying so
            here is what stops the two surfaces being "unified" later by someone
            who reasonably assumes an alert is an alert.
          */}
          <p className="text-xs text-ink-faint">
            These notify only. Strategy automations that place orders live on{" "}
            {/* inline-block with vertical padding, so these links clear the
                24 CSS-pixel target minimum the Phase 6 QA measures everything
                against. A 15px-tall link is a link only a mouse can hit. */}
            <a href="/deployments" className="inline-block py-1.5 underline hover:text-ink">
              Live trading
            </a>, and their delivery health is on{" "}
            <a href="/operations" className="inline-block py-1.5 underline hover:text-ink">
              Operations
            </a>.
          </p>
        </div>
        <div className="w-full sm:w-[320px]">
          <PushSetup onMessage={setToast} />
        </div>
      </div>

      {err && (
        <div role="alert" className="rounded-md border border-down/30 bg-down/10 px-3 py-2 text-xs text-down">
          {err}
        </div>
      )}

      <Card>
        <CardHeader
          title={
            alerts === null
              ? "Active alerts"
              : `Notification alerts · ${activeCount} of ${alerts.length} armed`
          }
          right={
            <div className="flex items-center gap-2">
              <input
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
                placeholder="SYMBOL"
                aria-label="Symbol for a new level alert"
                className="w-[110px] rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
              <Button variant="primary" onClick={() => setLevelOpen(true)} disabled={!newSymbol.trim()}>
                Add level alert
              </Button>
            </div>
          }
        />
        {/*
          Two rows, not one wrapping row. The bulk buttons act on whatever the
          filters above them currently select, and at a narrow width a single
          flex row put "Delete 42" beside an unrelated control — the one place
          in this page where proximity has to mean "these belong together".
        */}
        {alerts !== null && alerts.length > 0 && (
          <div className="space-y-2 border-b border-border bg-surface-2/20 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <label className="min-w-[170px] flex-1 sm:max-w-[260px]">
                <span className="sr-only">Search alert symbols</span>
                <TextInput
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search coin (BTCUSDT or btc)"
                  aria-label="Search alert symbols"
                  className="w-full"
                />
              </label>
              <Select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as AlertStatusFilter)}
                aria-label="Filter alerts by status"
                className="min-w-0 flex-1 sm:flex-none"
              >
                {ALERT_STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
              <Select
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value as AlertTypeFilter)}
                aria-label="Filter alerts by type"
                className="min-w-0 flex-1 sm:flex-none"
              >
                {ALERT_TYPE_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
              {(search.trim() !== "" || statusFilter !== "all" || typeFilter !== "all") && (
                <Button
                  variant="ghost"
                  onClick={() => { setSearch(""); setStatusFilter("all"); setTypeFilter("all"); }}
                >
                  Clear
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/*
                The count is stated before the buttons that act on it, and named
                in full, so "Delete 42" is never read without knowing what the
                42 are.
              */}
              <span className="mr-auto whitespace-nowrap text-xs text-ink-faint" aria-live="polite">
                {describeAlertScope(filters, filteredAlerts.length)} of {alerts.length}
              </span>
              <Button
                onClick={() => void bulkAct("resume")}
                disabled={busy !== null || filteredAlerts.length === 0}
                label={`Resume ${describeAlertScope(filters, filteredAlerts.length)}`}
              >
                {busy === "bulk-resume" ? "Resuming…" : `Resume ${filteredAlerts.length}`}
              </Button>
              <Button
                onClick={() => void bulkAct("pause")}
                disabled={busy !== null || filteredAlerts.length === 0}
                label={`Pause ${describeAlertScope(filters, filteredAlerts.length)}`}
              >
                {busy === "bulk-pause" ? "Pausing…" : `Pause ${filteredAlerts.length}`}
              </Button>
              <Button
                variant="danger"
                onClick={() => void bulkAct("delete")}
                disabled={busy !== null || filteredAlerts.length === 0}
                label={`Delete ${describeAlertScope(filters, filteredAlerts.length)}`}
              >
                {busy === "bulk-delete" ? "Deleting…" : `Delete ${filteredAlerts.length}`}
              </Button>
            </div>
          </div>
        )}
        {alerts === null ? (
          <Empty>Loading…</Empty>
        ) : alerts.length === 0 ? (
          <Empty>
            No alerts yet. Open a chart, click a price on the scale or the bell next to any SMA or
            EMA, and it will appear here.
          </Empty>
        ) : filteredAlerts.length === 0 ? (
          <Empty>No alerts match the current search and filters.</Empty>
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
                    className="group flex items-center gap-2 pr-2 text-[13px] hover:bg-surface-2/40">
                    {/*
                      The description is the edit affordance. Making the whole
                      row a button would swallow the pause and delete controls
                      inside it; making only a pencil icon clickable would hide
                      the primary action of the row behind a 15px target.
                    */}
                    <button
                      type="button"
                      onClick={() => setEditing(a)}
                      aria-label={`Edit alert — ${a.symbol} ${alertLineLabel(a)}, ${describeAlert(a)}`}
                      className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5 px-4 py-2 text-left"
                    >
                      <span className="inline-block h-[3px] w-4 shrink-0 rounded-full"
                        style={{ background: alertColor(a), opacity: isAlertActive(a) ? 1 : 0.3 }}
                        aria-hidden="true" />
                      <span className={`w-[84px] shrink-0 truncate font-medium ${isAlertActive(a) ? "text-ink" : "text-ink-faint"}`}>
                        {alertLineLabel(a)}
                      </span>
                      <span className={`truncate ${isAlertActive(a) ? "text-ink-muted" : "text-ink-faint"}`}>
                        {describeAlert(a)}
                      </span>
                      <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] tabular text-ink-muted">
                        {a.timeframe}
                      </span>
                      {a.frequency !== DEFAULT_ALERT_FREQUENCY && (
                        <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent">
                          {FREQUENCY_LABELS[a.frequency]}
                        </span>
                      )}
                      <span className="shrink-0 text-[11px] text-ink-faint">
                        {/* The cooldown only throttles the bar-close mode; showing
                            it beside an intrabar alert would describe a rule that
                            is not applied to it. */}
                        {a.frequency === DEFAULT_ALERT_FREQUENCY && `cooldown ${a.cooldownMin}m`}
                        {a.lastFiredAt && `${a.frequency === DEFAULT_ALERT_FREQUENCY ? " · " : ""}last fired ${fmtAgo(a.lastFiredAt)}`}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditing(a)}
                        aria-label={`Edit ${a.symbol} ${alertLineLabel(a)}`}
                        className="rounded px-2 py-1 text-[11px] text-ink-faint opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        Edit
                      </button>
                      <button
                        disabled={busy !== null}
                        // Re-enabling also re-arms a spent once_only alert, which
                        // is why "Fired once — done" is offered as a button and
                        // not merely as a label.
                        onClick={() => void act(a.id,
                          () => api.updateMaAlert(a.id, { enabled: !a.enabled }),
                          `${a.symbol} ${alertLineLabel(a)} ${a.enabled ? "paused" : "re-armed"}`)}
                        aria-label={`${isAlertActive(a) ? "Pause" : "Re-arm"} ${a.symbol} ${alertLineLabel(a)}`}
                        className={`rounded px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                          isAlertActive(a)
                            ? "bg-up/15 text-up hover:bg-up/25"
                            : "bg-surface-2 text-ink-muted hover:text-ink"
                        }`}
                      >
                        {alertInactiveReason(a) ?? "Active"}
                      </button>
                      <button
                        disabled={busy !== null}
                        onClick={() => void act(a.id,
                          () => api.deleteMaAlert(a.id),
                          `Deleted ${a.symbol} ${alertLineLabel(a)}`)}
                        aria-label={`Delete ${a.symbol} ${alertLineLabel(a)}`}
                        className="flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-down/15 hover:text-down disabled:opacity-40"
                      >
                        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                          <path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
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
            Nothing has fired yet. Alerts are checked as each candle closes — or during the candle,
            for alerts set to an intrabar frequency.
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
                {/* An alert that fired mid-candle may have fired at a price the
                    finished candle never closed at. Saying so here is the honest
                    half of offering intrabar modes at all. */}
                {e.intrabar && (
                  <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent">
                    bar still forming
                  </span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px]">
                  {/* Whether it actually reached a phone is the thing worth
                      surfacing — a fired alert nobody saw is a silent failure. */}
                  <span className={e.deliveryStatus === "delivered" ? "text-ink-faint" : "text-down"}>
                    {e.deliveryStatus === "delivered"
                      ? `sent to ${e.pushedTo} device${e.pushedTo === 1 ? "" : "s"}`
                      : e.deliveryStatus === "partial_failure"
                        ? `sent to ${e.pushedTo} · ${e.pushFailed} failed · ${e.pushPruned} pruned`
                        : e.deliveryStatus === "failed"
                          ? `delivery failed${e.pushFailed > 1 ? ` on ${e.pushFailed} devices` : ""}`
                          : e.pushPruned > 0
                            ? `no reachable device · ${e.pushPruned} pruned`
                            : "no device registered"}
                  </span>
                  <span className="text-ink-faint">{fmtAgo(e.firedAt)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <LevelAlertModal
        open={levelOpen}
        onClose={() => setLevelOpen(false)}
        symbol={newSymbol.trim().toUpperCase()}
        defaultTimeframe="1h"
        onSaved={(m) => { setToast(m); void refresh(); }}
      />

      <AlertEditor
        alert={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated, message) => {
          // An edit can move an alert out of the list it was opened from — a
          // renamed symbol under an active search, a pause under "Active".
          // Vanishing silently is indistinguishable from a failed save, so it
          // is said out loud.
          const left = editing !== null &&
            leavesFilteredView(editing, updated, (x) => filterAlerts([x], filters).length === 1);
          setToast(left ? `${message} — no longer matches the current filters` : message);
          void refresh();
        }}
        onDeleted={(_deleted, message) => { setToast(message); void refresh(); }}
      />

      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-surface px-4 py-2 text-sm text-ink shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
