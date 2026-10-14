"use client";
import { useEffect, useMemo, useState } from "react";
import { FIELD } from "@/components/ui";
import { api, type MaAlert, type ServerWatchlist } from "@/lib/api";
import { displayTicker } from "@/lib/instrument";
import type { Interval, SymbolInfo } from "@/lib/types";
import {
  ALERT_FEED_CAP, allAlertableSymbols, feedBudget, parseScope, planArming,
  scopeTargets, scopeValue, type AlertScope,
} from "@/lib/alertScope";

export interface AlertScopeStatus {
  scope: AlertScope;
  /** The coins Save will arm. One entry — the chart's — for "this coin only". */
  symbols: string[];
  /** False while a multi-coin scope is still loading, or when it cannot be armed. */
  ready: boolean;
}

/**
 * Which coins this alert is armed on: this one, a watchlist, or every coin.
 *
 * "The same 15m RSI alert on every coin in my watchlist" is one decision, not
 * forty repetitions of the dialog. Everything Save will do is stated here
 * BEFORE it is pressed — how many alerts, how many existing ones it updates
 * rather than duplicates, and whether the alert engine can watch the result —
 * because a bulk action whose consequences are only visible afterwards is one
 * the user cannot meaningfully approve.
 */
export function AlertScopeField({
  symbol, timeframes, armed, value, onChange, sameAlert,
}: {
  symbol: string;
  timeframes: readonly Interval[];
  /** Saved paused, the alerts take no live feed, so the budget does not apply. */
  armed: boolean;
  value: AlertScope;
  onChange: (status: AlertScopeStatus) => void;
  /** The dialog's own rule for "the alert you already have", per coin. */
  sameAlert: (alert: MaAlert, timeframe: Interval) => boolean;
}) {
  const [watchlists, setWatchlists] = useState<ServerWatchlist[] | null>(null);
  const [tracked, setTracked] = useState<SymbolInfo[] | null>(null);
  const [alerts, setAlerts] = useState<MaAlert[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The lists that populate the menu. A failure here never blocks arming the
  // chart's own coin, which needs neither.
  useEffect(() => {
    let live = true;
    Promise.all([api.listWatchlists(), api.listSymbols(true)])
      .then(([w, s]) => { if (live) { setWatchlists(w); setTracked(s); } })
      .catch((e: Error) => { if (live) setLoadError(e.message || "could not load watchlists"); });
    return () => { live = false; };
  }, []);

  // Every alert, so each coin's existing alert can be matched and the feed
  // budget counted the way the runner counts it. Re-read on every scope
  // change rather than cached, so the numbers shown are current.
  const multi = value.kind !== "symbol";
  useEffect(() => {
    if (!multi) { setAlerts(null); return; }
    let live = true;
    setAlerts(null);
    api.listMaAlerts()
      .then((rows) => { if (live) setAlerts(rows); })
      .catch((e: Error) => { if (live) setLoadError(e.message || "could not load your alerts"); });
    return () => { live = false; };
  }, [multi, value]);

  const targets = useMemo(
    () => scopeTargets(value, symbol, watchlists ?? [], tracked ?? []),
    [value, symbol, watchlists, tracked],
  );
  const plan = useMemo(
    () => (alerts ? planArming(targets.symbols, timeframes, alerts, sameAlert) : null),
    [alerts, targets.symbols, timeframes, sameAlert],
  );
  const budget = useMemo(
    () => (alerts && plan ? feedBudget(alerts, plan, armed) : null),
    [alerts, plan, armed],
  );

  const ready = !multi || (
    plan !== null && budget !== null && budget.fits && targets.symbols.length > 0
  );
  useEffect(() => {
    onChange({ scope: value, symbols: targets.symbols, ready });
    // `onChange` is the parent's setter; its identity is not a reason to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, targets.symbols, ready]);

  const allCount = tracked ? allAlertableSymbols(tracked).length : null;
  const updates = plan ? plan.filter((p) => p.existingId !== null).length : 0;

  return (
    <>
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <span className="text-sm text-ink-muted">Apply to</span>
        <select
          value={scopeValue(value)}
          onChange={(e) => onChange({
            scope: parseScope(e.target.value), symbols: [], ready: false,
          })}
          aria-label="Which coins to arm this alert on"
          className={`w-full ${FIELD}`}
        >
          <option value="">{displayTicker(symbol)} only</option>
          {(watchlists ?? []).map((w) => (
            <option key={w.id} value={`wl:${w.id}`} disabled={w.symbols.length === 0}>
              Watchlist: {w.name} ({w.symbols.length} coin{w.symbols.length === 1 ? "" : "s"})
            </option>
          ))}
          <option value="all" disabled={!allCount}>
            All tracked coins{allCount !== null ? ` (${allCount})` : ""}
          </option>
        </select>
      </div>

      {loadError && (
        <p role="note" className="text-xs text-warn">
          Could not load {multi ? "everything needed to arm several coins" : "your watchlists"}:
          {" "}{loadError}. Arming {displayTicker(symbol)} alone still works.
        </p>
      )}

      {multi && !loadError && (
        plan === null || budget === null ? (
          <p className="text-xs text-ink-faint">Counting your existing alerts…</p>
        ) : targets.symbols.length === 0 ? (
          <p role="alert" className="text-xs text-warn">That watchlist has no coins to arm.</p>
        ) : (
          <div className="space-y-1">
            <p className="text-xs text-ink-faint">
              Creates <span className="text-ink">{plan.length}</span> alert{plan.length === 1 ? "" : "s"}:
              {" "}{timeframes.length} timeframe{timeframes.length === 1 ? "" : "s"} ×
              {" "}{targets.symbols.length} coin{targets.symbols.length === 1 ? "" : "s"}.
              {updates > 0 && (
                <> {updates} of them already exist{updates === 1 ? "s" : ""} on
                  {" "}{updates === 1 ? "its" : "their"} coin and will be
                  {" "}<span className="text-ink">updated</span>, not duplicated.</>
              )}
            </p>
            {targets.excluded.length > 0 && (
              <p className="text-xs text-ink-faint">
                Left out — not Binance spot, so the alert engine cannot watch them:
                {" "}{targets.excluded.map(displayTicker).join(", ")}.
              </p>
            )}
            {armed ? (
              <p role={budget.fits ? undefined : "alert"}
                className={`text-xs ${budget.fits ? "text-ink-faint" : "text-down"}`}>
                Live feeds: {budget.inUse} in use → {budget.after} of {budget.cap}.
                {!budget.fits && (
                  <> The alert engine watches at most {ALERT_FEED_CAP} coin × timeframe feeds at once;
                    {" "}past that, alerts would show as armed and never fire. Choose fewer coins or
                    {" "}timeframes, or save them paused.</>
                )}
              </p>
            ) : (
              <p className="text-xs text-ink-faint">
                Saved paused, so they take no live feed until you arm them.
              </p>
            )}
          </div>
        )
      )}
    </>
  );
}
