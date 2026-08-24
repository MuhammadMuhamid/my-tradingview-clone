"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type OpsStatus, type UnresolvedIntents } from "@/lib/api";
import { Button, Card, CardHeader, Empty, Field, TextInput } from "@/components/ui";

/**
 * The operator console.
 *
 * `BE-11`: there was no kill switch, no exposure cap, no daily-loss limit and
 * no way to see whether a feed was live. The controls were added to the API in
 * Phase 2; until now there was no way to reach them except by curl, which means
 * that in the situation they exist for — something is wrong and it is 3am —
 * they did not exist.
 *
 * Every number here is read from `/api/ops/status`. Nothing is computed in the
 * browser, so the screen cannot disagree with the process that enforces it.
 */

const MODE_STYLE: Record<OpsStatus["mode"], { badge: string; note: string }> = {
  LIVE: {
    badge: "bg-up/15 text-up border-up/30",
    note: "This process holds the emitter lease and will send real buy and sell signals.",
  },
  STANDBY: {
    badge: "bg-accent/15 text-accent border-accent/30",
    note: "The live runner is enabled but another process holds the emitter lease. This one will not emit.",
  },
  HALTED: {
    badge: "bg-down/15 text-down border-down/30",
    note: "Every emission is refused — entries and exits alike — until trading is resumed.",
  },
  DISABLED: {
    badge: "bg-ink-faint/15 text-ink-muted border-border",
    note: "LIVE_RUNNER_ENABLED is not \"true\", so this process emits nothing. That is the default (X-06).",
  },
};

const FEED_STYLE: Record<string, string> = {
  live: "text-up",
  lagging: "text-warn",
  stale: "text-down",
  gapped: "text-down",
  unknown: "text-ink-faint",
};

const DELIVERY_STYLE: Record<string, string> = {
  healthy: "text-up",
  idle: "text-ink-muted",
  degraded: "text-warn",
  failing: "text-down",
  stalled: "text-down",
};

const when = (iso: string | null): string =>
  iso === null ? "—" : new Date(iso).toLocaleString();

/** A limit and what is currently used against it, as one readable line. */
function LimitRow(
  { label, used, limit, unit, invert }:
  { label: string; used: number; limit: number | null; unit: string; invert?: boolean }
) {
  const breached = limit !== null && (invert ? used >= limit : used >= limit);
  const pct = limit === null || limit === 0 ? 0 : Math.min(100, (used / limit) * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ink-muted">{label}</span>
        <span className={breached ? "font-medium text-down" : "text-ink"}>
          {used.toLocaleString(undefined, { maximumFractionDigits: 2 })}{unit}
          <span className="text-ink-faint"> / {limit === null ? "off" : `${limit}${unit}`}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-surface-2" aria-hidden="true">
        <div
          className={`h-full ${breached ? "bg-down" : "bg-accent"}`}
          style={{ width: `${limit === null ? 0 : pct}%` }}
        />
      </div>
    </div>
  );
}

export default function OperationsPage() {
  const [status, setStatus] = useState<OpsStatus | null>(null);
  const [intents, setIntents] = useState<UnresolvedIntents | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [haltReason, setHaltReason] = useState("");
  const [confirmResume, setConfirmResume] = useState(false);

  const refresh = useCallback(() => {
    api.opsStatus()
      .then((s) => { setStatus(s); setError(""); })
      .catch((e: Error) => setError(e.message));
    api.opsUnresolvedIntents().then(setIntents).catch(() => setIntents(null));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true);
    setNotice("");
    try {
      await fn();
      setNotice(done);
      setHaltReason("");
      setConfirmResume(false);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // The heading belongs to the ROUTE, not to a successful load: a page that
  // renders only an error message has no heading for a screen reader to
  // announce as the page's subject, and the Phase 6 QA measures exactly that.
  if (!status) {
    return (
      <div className="mx-auto max-w-[1100px] space-y-4 px-4 py-6">
        <div>
          <h1 className="text-lg font-semibold text-ink">Operations</h1>
          <p className="text-xs text-ink-faint">
            Trading mode, risk limits, feed freshness and signal delivery.
          </p>
        </div>
        <Card><Empty>{error || "Loading operator status…"}</Empty></Card>
      </div>
    );
  }

  const mode = MODE_STYLE[status.mode];
  const risk = status.risk;

  return (
    <div className="mx-auto max-w-[1100px] space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Operations</h1>
          <p className="text-xs text-ink-faint">
            Read from the process that enforces these limits. Refreshed every 10 seconds;
            last read {when(status.time)}.
          </p>
        </div>
        <span className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-semibold ${mode.badge}`}>
          {status.mode}
        </span>
      </div>

      {notice && (
        <p role="status" className="rounded border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded border border-down/30 bg-down/10 px-3 py-2 text-sm text-ink">
          {error}
        </p>
      )}

      {/* ── The control ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Trading" right={<span className="text-xs text-ink-faint">{mode.note}</span>} />
        <div className="space-y-3 px-4 pb-4">
          {risk.tradingHalted ? (
            <>
              <p className="rounded border border-down/30 bg-down/10 px-3 py-2 text-sm text-ink">
                <strong>Halted</strong>{risk.haltedBy ? ` by ${risk.haltedBy}` : ""}
                {risk.haltedAt ? ` at ${when(risk.haltedAt)}` : ""}.
                {risk.haltedReason ? ` Reason: ${risk.haltedReason}` : ""}
              </p>
              {confirmResume ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink">
                    Resuming re-arms real order flow. Is the reason for the halt gone?
                  </span>
                  <Button variant="danger" disabled={busy}
                    onClick={() => void act(() => api.opsResume(), "Trading resumed.")}>
                    Yes, resume trading
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmResume(false)}>Cancel</Button>
                </div>
              ) : (
                <Button variant="default" onClick={() => setConfirmResume(true)}>Resume trading…</Button>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label="Reason for halting"
                help="Required. Whoever finds the system halted needs to know why."
              >
                <TextInput
                  value={haltReason}
                  onChange={(e) => setHaltReason(e.target.value)}
                  placeholder="e.g. exchange outage, unexplained fills"
                  className="w-80"
                />
              </Field>
              <Button
                variant="danger"
                disabled={busy || haltReason.trim().length < 3}
                onClick={() => void act(() => api.opsHalt(haltReason.trim()), "Trading halted.")}
              >
                Halt all trading
              </Button>
            </div>
          )}
          <p className="text-xs text-ink-faint">
            Halting refuses every emission, entries and exits alike. It does <strong>not</strong> close
            open positions: the platform cannot flatten a position it does not hold, and inventing an
            exit price would put real money behind a guess. Close positions in the bot or on the
            exchange.
          </p>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* ── Risk ─────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Risk limits" />
          <div className="space-y-4 px-4 pb-4">
            <LimitRow
              label="Configured exposure"
              used={risk.snapshot.currentExposureQuote}
              limit={risk.maxTotalExposureQuote}
              unit=" USDT"
            />
            <LimitRow
              label="Concurrent positions"
              used={risk.snapshot.openPositions}
              limit={risk.maxConcurrentPositions}
              unit=""
            />
            <LimitRow
              label={`Realised loss (rolling ${risk.dailyLossWindowHours}h)`}
              used={Math.max(0, -risk.snapshot.realisedPnlInWindow)}
              limit={risk.maxDailyLossQuote}
              unit=" USDT"
              invert
            />
            <p className="text-xs text-ink-faint">{risk.summary}</p>
            <p className="text-xs text-ink-faint">
              Exposure is what the deployments are <em>configured</em> to spend, not a balance read
              from the exchange. The platform does not hold the credentials.
            </p>
          </div>
        </Card>

        {/* ── Delivery ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Signal delivery"
            right={
              <span className={`text-xs font-medium uppercase ${DELIVERY_STYLE[status.delivery.state] ?? ""}`}>
                {status.delivery.state}
              </span>
            }
          />
          <div className="space-y-2 px-4 pb-4 text-sm">
            <p className="text-ink">{status.delivery.summary}</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-muted">
              <dt>Delivered</dt><dd className="text-right text-ink">{status.delivery.counts.sent}</dd>
              <dt>Refused by the bot</dt><dd className="text-right text-ink">{status.delivery.counts.blocked}</dd>
              <dt>Failed</dt><dd className="text-right text-ink">{status.delivery.counts.failed}</dd>
              <dt>Skipped (duplicate)</dt><dd className="text-right text-ink">{status.delivery.counts.skipped}</dd>
              <dt>Needed a retry</dt><dd className="text-right text-ink">{status.delivery.retried}</dd>
              <dt>Last delivered</dt><dd className="text-right text-ink">{when(status.delivery.lastSentAt)}</dd>
              <dt>Last failure</dt><dd className="text-right text-ink">{when(status.delivery.lastFailureAt)}</dd>
            </dl>
          </div>
        </Card>
      </div>

      {/* ── Feeds ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Candle and WebSocket freshness"
          right={
            <span className={`text-xs font-medium uppercase ${FEED_STYLE[status.feeds.worst] ?? ""}`}>
              worst: {status.feeds.worst}
            </span>
          }
        />
        {status.feeds.rows.length === 0 ? (
          <Empty>No feed has been assessed yet. An unassessed feed is never reported as live.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm tabular">
              <thead>
                <tr className="border-b border-border text-xs text-ink-muted">
                  <th className="px-4 py-2 text-left">Symbol</th>
                  <th className="px-4 py-2 text-left">Interval</th>
                  <th className="px-4 py-2 text-left">State</th>
                  <th className="px-4 py-2 text-right">Bars behind</th>
                  <th className="px-4 py-2 text-right">Gaps</th>
                  <th className="px-4 py-2 text-right">Newest bar</th>
                  <th className="px-4 py-2 text-right">Checked</th>
                </tr>
              </thead>
              <tbody>
                {status.feeds.rows.map((f) => (
                  <tr key={`${f.symbol}-${f.interval}`} className="border-b border-border/50">
                    <td className="px-4 py-2 font-medium">{f.symbol}</td>
                    <td className="px-4 py-2">{f.interval}</td>
                    <td className={`px-4 py-2 font-medium ${FEED_STYLE[f.state] ?? ""}`}>{f.state}</td>
                    <td className="px-4 py-2 text-right">{f.barsBehind ?? "—"}</td>
                    <td className="px-4 py-2 text-right">{f.gapCount ?? "—"}</td>
                    <td className="px-4 py-2 text-right text-ink-faint">{when(f.lastBarTime)}</td>
                    <td className="px-4 py-2 text-right text-ink-faint">{when(f.lastCheckedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* ── Emitter ──────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Emitter" />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 pb-4 text-xs text-ink-muted">
            <dt>This process</dt>
            <dd className="text-right font-mono text-ink">{status.emitter.thisProcess}</dd>
            <dt>Live runner enabled</dt>
            <dd className="text-right text-ink">{status.emitter.liveRunnerEnabled ? "yes" : "no"}</dd>
            <dt>Holds the lease</dt>
            <dd className="text-right text-ink">{status.emitter.holdsLease ? "yes" : "no"}</dd>
            <dt>Lease holder</dt>
            <dd className="text-right font-mono text-ink">{status.emitter.lease?.holder ?? "—"}</dd>
            <dt>Lease expires</dt>
            <dd className="text-right text-ink">{when(status.emitter.lease?.expiresAt ?? null)}</dd>
            <dt>Binance testnet configured</dt>
            <dd className="text-right text-ink">{status.exchange.testnetConfigured ? "yes" : "no"}</dd>
            <dt>Deployments</dt>
            <dd className="text-right text-ink">
              {status.deployments.active} active · {status.deployments.long} long ·{" "}
              {status.deployments.paused} paused
            </dd>
          </dl>
          <p className="px-4 pb-4 text-xs text-ink-faint">{status.exchange.note}</p>
        </Card>

        {/* ── Unresolved intents ───────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Unresolved order intents"
            right={<span className="text-xs text-ink-faint">{intents?.count ?? 0}</span>}
          />
          {!intents || intents.count === 0 ? (
            <Empty>None. Every order this system started has a recorded outcome.</Empty>
          ) : (
            <div className="space-y-2 px-4 pb-4 text-sm">
              <p className="rounded border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-ink">
                These are orders whose outcome is unknown — the process died between sending and
                recording. The order may or may not have been placed. Reconcile each against the bot
                before resuming.
              </p>
              <ul className="space-y-1 text-xs">
                {intents.intents.slice(0, 10).map((i) => (
                  <li key={i.id} className="flex justify-between gap-2">
                    <span className="font-mono">{i.deploymentId.slice(0, 8)} {i.action}</span>
                    <span className="text-ink-faint">{i.state} · bar {when(i.barTime)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
