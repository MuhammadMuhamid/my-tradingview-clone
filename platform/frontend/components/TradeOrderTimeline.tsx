"use client";
import { useEffect, useState } from "react";
import { api, type TimelineItem, type TradingTimeline } from "@/lib/api";

const CLASS_LABELS = {
  AUTHORITATIVE_EVENT: "Persisted event",
  AUTHORITATIVE_HISTORICAL_EVENT: "Persisted event",
  CURRENT_AUTHORITATIVE_STATE: "Current known state",
  SAFE_DERIVATION: "Derived display",
} as const;

const ID_LABELS: Record<string, string> = {
  requestId: "Request ID",
  clientOrderId: "Client order ID",
  exchangeOrderId: "Exchange order ID",
  deploymentId: "Deployment ID",
  strategyId: "Strategy ID",
  signalId: "Signal ID",
  alertId: "Alert ID",
  intentId: "Intent ID",
  strategyOrderIntentId: "Strategy order intent ID",
  sourceKey: "Bot source key",
  callerDedupeKey: "Platform dedupe key",
  botId: "Bot ID",
  manualOrderId: "Manual order ID",
  manualCommandId: "Manual command ID",
  commandRequestId: "Command request ID",
  targetManualOrderId: "Target manual order ID",
  partialCloseId: "Partial close ID",
};

const QUANTITY_LABELS: Record<string, string> = {
  requestedBase: "Requested base",
  requestedQuote: "Requested quote",
  filledBase: "Filled base",
  filledQuote: "Filled quote",
  price: "Price",
  averagePrice: "Average price",
  reportedQuantity: "Reported quantity",
  baseQuantity: "Accounting base quantity",
  quoteRevenue: "Accounting quote revenue",
  realizedPnlQuote: "Realized P&L (quote)",
  cumulativeExecutedBaseQuantity: "Cumulative executed base",
  cumulativeExecutedQuoteQuantity: "Cumulative executed quote",
};

function Details({ event }: { event: TimelineItem }) {
  const identifiers = Object.entries(event.identifiers).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string");
  const quantities = Object.entries(event.quantity ?? {}).filter((entry): entry is [string, number] =>
    typeof entry[1] === "number");
  return (
    <details className="mt-1.5 text-[11px] text-ink-faint">
      <summary className="cursor-pointer select-none py-1 text-ink-muted">Evidence &amp; identifiers</summary>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 rounded border border-border/70 bg-surface px-2 py-1.5">
        <dt>Evidence</dt><dd className="min-w-0 break-words text-ink-muted">{event.evidenceSource}</dd>
        {event.linkageEvidenceClass && <div className="contents">
          <dt>Linkage</dt><dd className="min-w-0 break-words text-ink-muted">Authoritative linkage</dd>
        </div>}
        {identifiers.map(([key, value]) => <div className="contents" key={key}>
          <dt>{ID_LABELS[key] ?? key}</dt><dd className="min-w-0 break-all font-mono text-ink-muted">{value}</dd>
        </div>)}
        {quantities.map(([key, value]) => <div className="contents" key={key}>
          <dt>{QUANTITY_LABELS[key] ?? key}</dt><dd className="tabular text-ink-muted">{value}</dd>
        </div>)}
      </dl>
    </details>
  );
}

export function TradeOrderTimeline({ kind, id }: {
  kind: "manual-order" | "deployment";
  id: string;
}) {
  const [timeline, setTimeline] = useState<TradingTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setTimeline(null);
    setError(null);
    const request = kind === "manual-order" ? api.manualOrderTimeline(id) : api.deploymentTimeline(id);
    void request.then((result) => { if (active) setTimeline(result); })
      .catch((reason) => { if (active) setError((reason as Error).message); });
    return () => { active = false; };
  }, [kind, id]);

  if (error) return <div role="alert" className="border-t border-down/30 bg-down/10 px-3 py-2 text-xs text-down">
    Timeline unavailable: {error}
  </div>;
  if (!timeline) return <div role="status" className="border-t border-border px-3 py-3 text-xs text-ink-faint">
    Loading persisted timeline…
  </div>;

  return <TradeOrderTimelineView timeline={timeline} />;
}

export function TradeOrderTimelineView({ timeline }: { timeline: TradingTimeline }) {
  return (
    <section className="border-t border-border bg-surface-2/30 px-3 py-3" aria-label="Trade and order timeline">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-ink">Trade / Order Timeline</h3>
          <p className="mt-0.5 text-[11px] leading-4 text-ink-muted">{timeline.scope.executionMode}</p>
          {timeline.finalKnownState && <p className="mt-0.5 text-[11px] text-ink-muted">
            Final known state: <strong className="uppercase text-ink">{timeline.finalKnownState.replaceAll("_", " ")}</strong>
          </p>}
        </div>
        <span className="rounded border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-muted">
          {timeline.scope.source}
        </span>
      </div>

      {timeline.gaps.length > 0 && (
        <div className="mb-3 rounded border border-warn/30 bg-warn/10 px-2.5 py-2 text-[11px] leading-4 text-ink-muted">
          <strong className="text-warn">Historical evidence is incomplete.</strong>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {timeline.gaps.map((gap) => <li key={gap}>{gap}</li>)}
          </ul>
        </div>
      )}

      {timeline.items.length === 0 ? (
        <p className="py-3 text-center text-xs text-ink-faint">No timestamped persisted evidence is available.</p>
      ) : (
        <ol className="space-y-0">
          {timeline.items.map((event, index) => (
            <li key={event.key} className="relative grid grid-cols-[82px_12px_minmax(0,1fr)] gap-2 pb-3 last:pb-0">
              <time dateTime={event.timestamp} className="pt-0.5 text-right text-[10px] leading-4 tabular text-ink-faint">
                {new Date(event.timestamp).toLocaleString([], {
                  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
                })}
              </time>
              <span className="relative flex justify-center" aria-hidden="true">
                {index < timeline.items.length - 1 && <span className="absolute bottom-[-12px] top-2 w-px bg-border" />}
                <span className={`relative mt-1 h-2 w-2 rounded-full border ${
                  event.evidenceClass === "CURRENT_AUTHORITATIVE_STATE"
                    ? "border-warn bg-surface" : "border-accent bg-accent"
                }`} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="text-xs text-ink">{event.title}</strong>
                  {event.state && <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase text-ink-muted">
                    {event.state.replaceAll("_", " ")}
                  </span>}
                </div>
                <p className="mt-0.5 text-[11px] leading-4 text-ink-muted">{event.description}</p>
                <span className="mt-1 inline-block text-[10px] uppercase tracking-wide text-ink-faint">
                  {CLASS_LABELS[event.evidenceClass]}
                </span>
                <Details event={event} />
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 border-t border-border/70 pt-2 text-[10px] leading-4 text-ink-faint">
        Projection only: persisted evidence is read in chronological order; missing transitions remain missing.
        Equal timestamps use stable display ordering without invented precision.
      </p>
    </section>
  );
}
