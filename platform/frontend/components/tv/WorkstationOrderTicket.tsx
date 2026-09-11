"use client";

import { useEffect, useState } from "react";
import { api, type TraditionalInstrumentResponse } from "@/lib/api";
import { canonicalDisplayParts, instrumentTypeLabel } from "@/lib/instrument";

/**
 * Capability-aware ticket boundary for canonical markets.  X3-X5 order APIs
 * require a durable deployment/dedupe/bar identity, so this panel never
 * fabricates an ad-hoc intent. It states the exact sandbox surface and rejects
 * products that cannot be ordered before any Bot request can exist.
 */
export function WorkstationOrderTicket({ instrument }: { instrument: string }) {
  const identity = canonicalDisplayParts(instrument);
  const [metadata, setMetadata] = useState<TraditionalInstrumentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setMetadata(null);
    setError(null);
    void api.traditionalInstrument(instrument, controller.signal).then(setMetadata)
      .catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [instrument]);
  if (!identity) return null;
  const item = metadata?.instrument;
  const continuous = identity.type === "continuous_future";
  const reference = identity.type === "index";
  const expired = item?.listing.status === "delisted" || (identity.expiry ? Date.parse(identity.expiry) < Date.now() : false);
  const sandbox = item?.execution.availability.paper === true || item?.execution.availability.testnet === true;
  const cryptoContract = item?.identity.assetClass === "crypto";
  const environment = identity.type === "fx_pair" ? "OANDA PRACTICE"
    : identity.type === "stock" || identity.type === "etf" ? "ALPACA PAPER"
      : identity.type === "spot" || identity.type === "perpetual" || (identity.type === "future" && cryptoContract)
        ? `${identity.venue} PAPER / TESTNET`
        : identity.type === "future" ? "IBKR PAPER / PROVIDER SANDBOX" : "READ ONLY";
  const blocker = error ? `Capability could not be verified: ${error}`
    : reference ? "Reference indices are not orderable instruments."
    : continuous ? "Continuous futures are research series; choose a specific contract."
      : expired ? "This contract/listing is expired or delisted."
        : item && !sandbox ? "The provider reports no paper/demo/testnet capability for this instrument." : null;
  return <aside className="flex h-full w-[85vw] max-w-[294px] shrink-0 flex-col border-l border-border bg-surface p-4 md:w-[294px]">
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold text-ink">Order ticket</h2>
      <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold text-accent">{environment}</span></div>
    <p className="mt-2 text-xs font-medium text-ink">{identity.venue}:{identity.base}/{identity.quote} · {instrumentTypeLabel(identity.type)}</p>
    <p className="mt-1 break-all text-[10px] text-ink-faint">{instrument}</p>
    {blocker ? <p role="alert" className="mt-3 rounded border border-warn/40 bg-warn/10 p-2 text-xs leading-5 text-warn">{blocker} No request was sent to Bot.</p>
      : <div className="mt-3 rounded border border-border bg-surface-2/50 p-2 text-xs leading-5 text-ink-muted">
        <p className="font-medium text-ink">Sandbox capability {item ? (sandbox ? "available" : "unavailable") : "loading…"}</p>
        <p>{identity.type === "fx_pair" ? "Buy uses ask; sell uses bid. Market/limit only while the provider session is open."
          : identity.type === "stock" || identity.type === "etf" ? "Regular-session market/limit; extended hours requires an eligible limit order."
            : identity.type === "future" ? "Whole contracts, valid tick, active contract and open exchange session required."
              : identity.type === "spot" ? "Base/quote quantity, order type and tick/lot rules must match the selected sandbox provider."
              : "Order type, quantity unit, margin mode, leverage and reduce-only must match provider capability."}</p>
      </div>}
    <p className="mt-auto border-t border-border pt-3 text-[10px] leading-4 text-ink-faint">Canonical X3-X5 order routes accept only durable deployment-owned identities. Ad-hoc production activation is intentionally unavailable.</p>
  </aside>;
}
