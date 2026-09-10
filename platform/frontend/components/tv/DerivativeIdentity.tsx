"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type DerivativeCompareResponse, type DerivativeSnapshotResponse, type QuantityUnit } from "@/lib/api";
import { canonicalDisplayParts, instrumentTypeLabel, isDerivativeInstrumentId } from "@/lib/instrument";
import { fmtPrice } from "@/lib/format";

function compact(value: number): string {
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function interval(ms: number): string {
  const hours = ms / 3_600_000;
  return Number.isInteger(hours) ? `${hours}h` : `${Math.round(ms / 60_000)}m`;
}

function unitLabel(unit: QuantityUnit, base: string, settlement: string): string {
  return unit === "base" ? base : unit === "quote" ? settlement : unit === "usd" ? "USD" : "contracts";
}

export function DerivativeIdentity({ symbol, dense }: { symbol: string; dense: boolean }) {
  const identity = useMemo(() => canonicalDisplayParts(symbol), [symbol]);
  const [snapshot, setSnapshot] = useState<DerivativeSnapshotResponse | null>(null);
  const [comparison, setComparison] = useState<DerivativeCompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isDerivativeInstrumentId(symbol)) return;
    setSnapshot(null); setComparison(null); setError(null);
    const controller = new AbortController();
    const refresh = () => void api.derivative(symbol, controller.signal)
      .then((value) => { setSnapshot(value); setError(null); })
      .catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); });
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [symbol]);

  useEffect(() => {
    if (!open || !identity || identity.type === "spot") return;
    const controller = new AbortController();
    void api.compareDerivatives(identity.base, identity.type, controller.signal)
      .then(setComparison).catch(() => setComparison(null));
    return () => controller.abort();
  }, [open, identity]);

  if (!identity || identity.type === "spot") return null;
  const observation = snapshot?.observation;
  const terms = snapshot?.instrument.derivative;
  const badge = instrumentTypeLabel(identity.type);
  const oi = observation?.openInterest;
  const settlement = snapshot?.instrument.identity.settlementAsset ?? identity.settlement;
  const unit = oi ? unitLabel(oi.unit, identity.base, settlement) : "";
  const venues = comparison?.providers.flatMap((provider) => provider.instruments.map((instrument) => {
    const quote = provider.observations.find((row) => row.canonicalInstrumentId === instrument.identity.canonicalId);
    return { providerId: provider.providerId, instrument, quote };
  })) ?? [];

  return (
    <div className="pointer-events-auto relative flex max-w-full items-center gap-1" data-derivative-identity={badge}>
      <button onClick={() => setOpen((value) => !value)} aria-expanded={open}
        className="flex h-5 shrink-0 items-center rounded bg-accent/15 px-1.5 text-[10px] font-bold tracking-wide text-accent hover:bg-accent/25"
        title={`${badge} contract details and same-underlying venue comparison`}>
        {badge}{identity.expiry ? ` ${identity.expiry.slice(2)}` : ""}
      </button>
      {!dense && observation && (
        <span role="status" aria-label="Derivative market metrics"
          className={`flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[10px] tabular ${snapshot?.health.stale || snapshot?.freshness?.state === "stale" ? "text-warn" : "text-ink-muted"}`}>
          <span title="Mark price">M <b className="font-medium text-ink">{observation.prices.mark ? fmtPrice(observation.prices.mark) : "—"}</b></span>
          <span title="Index price">I <b className="font-medium text-ink">{observation.prices.index ? fmtPrice(observation.prices.index) : "—"}</b></span>
          <span title={observation.funding ? `Funding rate per ${interval(observation.funding.intervalMs)} interval` : "Funding unavailable"}>
            F <b className="font-medium text-ink">{observation.funding ? `${observation.funding.rate >= 0 ? "+" : ""}${(observation.funding.rate * 100).toFixed(4)}%/${interval(observation.funding.intervalMs)}` : "—"}</b>
          </span>
          <span title={`Open interest in ${unit || "provider units"}`}>OI <b className="font-medium text-ink">{oi ? `${compact(oi.value)} ${unit}` : "—"}</b></span>
          <span title="Mark minus index, divided by index">B <b className="font-medium text-ink">{observation.basis ? `${observation.basis.rate >= 0 ? "+" : ""}${(observation.basis.rate * 100).toFixed(3)}%` : "—"}</b></span>
        </span>
      )}
      {!dense && error && <span className="text-[10px] text-warn" title={error}>metrics unavailable</span>}
      {open && (
        <div className="absolute left-0 top-6 z-50 w-[min(430px,calc(100vw-24px))] rounded-md border border-border bg-surface p-3 text-[11px] text-ink shadow-2xl max-sm:fixed max-sm:left-3 max-sm:right-3 max-sm:top-28 max-sm:w-auto">
          <div className="flex items-start justify-between gap-3">
            <div><p className="font-semibold">{identity.base}/{identity.quote} · {badge} · {identity.venue}</p>
              <p className="mt-0.5 text-ink-faint">Settles {settlement}{terms ? ` · ${terms.settlement}` : ""}
                {terms?.maturity.kind === "dated" ? ` · expires ${new Date(terms.maturity.expiresAt).toLocaleString()}` : ""}</p></div>
            <button onClick={() => setOpen(false)} aria-label="Close derivative details" className="h-7 w-7 rounded text-ink-muted hover:bg-surface-2">×</button>
          </div>
          {terms && <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-2 text-ink-muted">
            <dt>Contract size</dt><dd className="text-right text-ink">{terms.contractSize.value} {terms.contractSize.unit}</dd>
            <dt>Provider multiplier</dt><dd className="text-right text-ink">{terms.multiplier}</dd>
            <dt>Order quantity</dt><dd className="text-right text-ink">{terms.quantityUnit}</dd>
            <dt>Margin / position</dt><dd className="text-right text-ink">{snapshot?.instrument.execution.marginModes.join(", ") || "not published"} · {snapshot?.instrument.execution.positionModes.join(", ") || "not published"}</dd>
            <dt>Reduce-only</dt><dd className="text-right text-ink">{snapshot?.instrument.execution.reduceOnly ? "supported" : "not published"}</dd>
            <dt>Leverage ceiling</dt><dd className="text-right text-ink">{snapshot?.instrument.execution.leverage.support === "supported" ? `${snapshot.instrument.execution.leverage.maximum}×` : "not published"}</dd>
          </dl>}
          <p className="mt-3 border-t border-border pt-2 font-semibold">Same underlying across venues</p>
          {venues.length === 0 ? <p className="mt-1 text-ink-faint">Comparison unavailable or still loading.</p> : (
            <div className="mt-1 max-h-40 overflow-y-auto">
              {venues.map(({ providerId, instrument, quote }) => <div key={instrument.identity.canonicalId}
                className="grid grid-cols-[1fr_auto_auto] gap-2 border-t border-border/60 py-1.5 first:border-0">
                <span className="truncate">{instrument.identity.venueId} · {instrument.listing.providerSymbol}</span>
                <span className="tabular text-ink-muted">M {quote?.prices.mark ? fmtPrice(quote.prices.mark) : "—"}</span>
                <span className="tabular text-ink-muted">F {quote?.funding ? `${(quote.funding.rate * 100).toFixed(4)}%` : "—"}</span>
                <span className="sr-only">Provider {providerId}</span>
              </div>)}
            </div>
          )}
          <p className="mt-2 text-[10px] text-ink-faint">Market data only. No order, leverage, margin, or account mutation is enabled.</p>
        </div>
      )}
    </div>
  );
}
