"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type EquityInstrumentResponse } from "@/lib/api";
import { canonicalDisplayParts, instrumentTypeLabel, isEquityInstrumentId } from "@/lib/instrument";

export function EquityIdentity({ symbol, dense }: { symbol: string; dense: boolean }) {
  const identity = useMemo(() => canonicalDisplayParts(symbol), [symbol]);
  const [metadata, setMetadata] = useState<EquityInstrumentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isEquityInstrumentId(symbol)) return;
    const controller = new AbortController();
    setMetadata(null); setError(null);
    void api.equityInstrument(symbol, controller.signal).then(setMetadata)
      .catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [symbol]);

  if (!identity || (identity.type !== "stock" && identity.type !== "etf")) return null;
  const equity = metadata?.instrument.equity;
  const type = instrumentTypeLabel(identity.type);
  const feed = equity?.marketData;
  const delay = feed ? `${feed.feedDelaySeconds}s delay` : "feed pending";

  return (
    <div className="pointer-events-auto relative flex max-w-full items-center gap-1" data-equity-identity={type}>
      <button onClick={() => setOpen((value) => !value)} aria-expanded={open}
        className="flex h-5 shrink-0 items-center rounded bg-accent/15 px-1.5 text-[10px] font-bold tracking-wide text-accent hover:bg-accent/25"
        title={`${type} listing, session, feed and adjustment details`}>
        {type}
      </button>
      {!dense && <span role="status" aria-label="Equity market-data semantics"
        className="flex min-w-0 items-center gap-1 whitespace-nowrap text-[10px] font-medium text-ink-muted">
        <span>{identity.venue}</span><span aria-hidden="true">·</span>
        <span title="Regular session only">REG</span><span aria-hidden="true">·</span>
        <span title="Unadjusted provider prices; execution-compatible">RAW</span><span aria-hidden="true">·</span>
        <span title={feed?.feedCoverage === "single_venue" ? "Single-venue coverage, not the consolidated tape" : undefined}>
          {feed?.defaultFeed.toUpperCase() ?? "IEX"} {delay}
        </span>
      </span>}
      {!dense && error && <span className="text-[10px] text-warn" title={error}>metadata unavailable</span>}
      {open && (
        <section aria-label={`${type} market details`}
          className="absolute left-0 top-6 z-50 w-[min(430px,calc(100vw-24px))] rounded-md border border-border bg-surface p-3 text-[11px] text-ink shadow-2xl max-sm:fixed max-sm:left-3 max-sm:right-3 max-sm:top-28 max-sm:w-auto">
          <div className="flex items-start justify-between gap-3">
            <div><p className="font-semibold">{identity.base} · {type} · {identity.venue}</p>
              <p className="mt-0.5 text-ink-faint">USD · primary listing {equity?.primaryListing.mic ?? "MIC pending"}</p></div>
            <button onClick={() => setOpen(false)} aria-label="Close equity details"
              className="h-7 w-7 rounded text-ink-muted hover:bg-surface-2">×</button>
          </div>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-border pt-2 text-ink-muted">
            <dt>Chart session</dt><dd className="text-right font-medium text-ink">Regular · 09:30–16:00 ET</dd>
            <dt>Extended availability</dt><dd className="text-right text-ink">Pre 04:00–09:30 · After 16:00–20:00</dd>
            <dt>Calendar</dt><dd className="text-right text-ink">US_EQUITIES · holidays/early closes</dd>
            <dt>Adjustment</dt><dd className="text-right font-medium text-ink">RAW · execution-compatible</dd>
            <dt>Feed entitlement</dt><dd className="text-right text-ink">{feed?.feedEntitlement ?? "Alpaca Basic"}</dd>
            <dt>Feed coverage</dt><dd className="text-right text-ink">{feed?.feedCoverage === "single_venue" ? "IEX only" : "Consolidated"}</dd>
            <dt>Data delay</dt><dd className="text-right text-ink">{delay}</dd>
            <dt>Historical embargo</dt><dd className="text-right text-ink">{feed ? `${feed.historicalEmbargoSeconds / 60} minutes` : "pending"}</dd>
            <dt>Corporate actions</dt><dd className="text-right text-ink">Explicit split/dividend events</dd>
            <dt>Short / borrow</dt><dd className="text-right text-ink">{equity
              ? `${equity.borrow.shortable} · ${equity.borrow.status.replaceAll("_", " ")}` : "unknown · never assumed"}</dd>
          </dl>
          <p className="mt-2 border-t border-border pt-2 text-[10px] leading-relaxed text-ink-faint">
            Extended-hours bars are excluded from this regular-session study set. Adjusted history is analysis-only and never substitutes for raw order/fill prices. Overnight BOATS data is not mixed into IEX.
          </p>
        </section>
      )}
    </div>
  );
}

