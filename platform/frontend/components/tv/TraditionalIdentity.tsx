"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type TraditionalInstrumentResponse } from "@/lib/api";
import { canonicalDisplayParts, instrumentTypeLabel, isTraditionalInstrumentId } from "@/lib/instrument";

const date = (value: string | null | undefined) => value ?? "not applicable / unavailable";

export function TraditionalIdentity({ symbol, dense }: { symbol: string; dense: boolean }) {
  const identity = useMemo(() => canonicalDisplayParts(symbol), [symbol]);
  const [metadata, setMetadata] = useState<TraditionalInstrumentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!isTraditionalInstrumentId(symbol)) return;
    const controller = new AbortController(); setMetadata(null); setError(null);
    void api.traditionalInstrument(symbol, controller.signal).then(setMetadata)
      .catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [symbol]);
  if (!identity || !isTraditionalInstrumentId(symbol)) return null;
  const item = metadata?.instrument; const fx = item?.fx; const futures = item?.futures;
  const continuous = item?.derivative.kind === "continuous_series" ? item.derivative : null;
  const reference = item?.referenceIndex;
  const type = instrumentTypeLabel(identity.type);
  const summary = fx ? "MID · OTC BID/ASK · practice gated"
    : continuous ? `${continuous.selection.toUpperCase()} · ${continuous.adjustment.replaceAll("_", " ")} · RESEARCH ONLY`
      : reference ? "REFERENCE · READ-ONLY" : futures ? `${futures.contractCode} · ${futures.chainPosition.toUpperCase()} · ${date(futures.expiry)}` : "metadata pending";
  return <div className="pointer-events-auto relative flex max-w-full items-center gap-1" data-traditional-identity={type}>
    <button onClick={() => setOpen((value) => !value)} aria-expanded={open}
      className="flex h-5 shrink-0 items-center rounded bg-warn/15 px-1.5 text-[10px] font-bold tracking-wide text-warn hover:bg-warn/25"
      title={`${type} price, contract, session and feed details`}>{type}</button>
    {!dense && <span role="status" aria-label="Traditional market-data semantics"
      className="max-w-[440px] truncate whitespace-nowrap text-[10px] font-medium text-ink-muted">{summary}</span>}
    {!dense && error && <span className="text-[10px] text-warn" title={error}>metadata unavailable</span>}
    {open && <section aria-label={`${type} market details`}
      className="absolute left-0 top-6 z-50 w-[min(470px,calc(100vw-24px))] rounded-md border border-border bg-surface p-3 text-[11px] text-ink shadow-2xl max-sm:fixed max-sm:left-3 max-sm:right-3 max-sm:top-28 max-sm:w-auto">
      <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{identity.base}/{identity.quote} · {type} · {identity.venue}</p>
        <p className="mt-0.5 text-ink-faint">Provider {metadata?.providerId ?? "pending"} · {metadata?.providerSymbol ?? "metadata pending"}</p></div>
        <button onClick={() => setOpen(false)} aria-label="Close market details" className="h-7 w-7 rounded text-ink-muted hover:bg-surface-2">×</button></div>
      {fx && <><dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-border pt-2 text-ink-muted">
        <dt>Market structure</dt><dd className="text-right font-medium text-ink">OTC provider quote · not consolidated</dd>
        <dt>Chart / backtest basis</dt><dd className="text-right font-medium text-ink">MID (explicit)</dd>
        <dt>Execution sides</dt><dd className="text-right text-ink">BUY at ask · SELL at bid</dd>
        <dt>Pip / price tick</dt><dd className="text-right text-ink">{fx.pipSize}</dd>
        <dt>Provider hours</dt><dd className="text-right text-ink">Sun–Fri 17:05–16:59 ET · 6m daily break · DST-aware</dd>
        <dt>Rollover boundary</dt><dd className="text-right text-ink">{fx.rollover.boundaryTime} {fx.rollover.timezone}</dd>
        <dt>Feed</dt><dd className="text-right text-ink">{fx.feed.status.replaceAll("_", " ")} · delay unknown</dd>
      </dl><p className="mt-2 border-t border-border pt-2 text-[10px] text-ink-faint">Spread is ask − bid. Mid charts do not imply executable fills. Swap/financing is account and instrument dependent and is not estimated here.</p></>}
      {futures && <><dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-border pt-2 text-ink-muted">
        <dt>Root / contract</dt><dd className="text-right font-medium text-ink">{futures.root} / {futures.contractCode ?? "continuous research series"}</dd>
        <dt>Month / expiry</dt><dd className="text-right text-ink">{date(futures.contractMonth)} / {date(futures.expiry)}</dd>
        <dt>First / last trade</dt><dd className="text-right text-ink">{date(futures.firstTradeDate)} / {date(futures.lastTradeDate)}</dd>
        <dt>First notice / last delivery</dt><dd className="text-right text-ink">{date(futures.firstNoticeDate)} / {date(futures.lastDeliveryDate)}</dd>
        <dt>Multiplier</dt><dd className="text-right text-ink">{futures.multiplier} {identity.base}</dd>
        <dt>Tick size / value</dt><dd className="text-right font-medium text-ink">{futures.tickSize} / {futures.tickValue} {futures.settlementCurrency}</dd>
        <dt>Session</dt><dd className="text-right text-ink">CME Globex overnight · daily break · CT/DST</dd>
        <dt>Chain / OI</dt><dd className="text-right text-ink">{futures.chainPosition} / provider entitlement</dd>
        <dt>Feed</dt><dd className="text-right text-ink">{futures.feed.status.replaceAll("_", " ")} · delay unknown</dd>
      </dl>{continuous && <p className="mt-2 border-t border-border pt-2 text-[10px] font-medium text-warn">CONTINUOUS RESEARCH SERIES — not directly tradable. Roll: {continuous.methodologyId}; adjustment: {continuous.adjustment.replaceAll("_", " ")}.</p>}</>}
      {reference && <p className="mt-2 border-t border-border pt-2 text-[10px] font-medium text-warn">CASH/REFERENCE INDEX · READ-ONLY · never routed to orders. Feed: {reference.feed.status.replaceAll("_", " ")} · delay unknown. Choose a separately listed futures contract to trade in paper.</p>}
    </section>}
  </div>;
}
