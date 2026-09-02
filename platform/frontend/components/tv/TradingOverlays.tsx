"use client";
import Link from "next/link";
import type { TradingOverlayItem, TradingOverlayPreferences, TradingOverlayResponse } from "@/lib/tradingOverlays";

const LABELS: Record<keyof TradingOverlayPreferences, string> = {
  activity: "Trading activity", activeOrders: "Active orders", positions: "Positions",
  manual: "Manual", automated: "Automated", paper: "Paper",
};

export function TradingOverlayMenu({ open, onOpen, value, onChange, data, loading, error,
  items, onSelect }: {
  open: boolean; onOpen: (open: boolean) => void; value: TradingOverlayPreferences;
  onChange: (value: TradingOverlayPreferences) => void;
  data: TradingOverlayResponse | null; loading: boolean; error: string | null;
  items: readonly TradingOverlayItem[]; onSelect: (id: string) => void;
}) {
  const toggle = (key: keyof TradingOverlayPreferences) =>
    onChange({ ...value, [key]: !value[key] });
  return <div className="relative shrink-0">
    <button onClick={() => onOpen(!open)} aria-expanded={open} aria-haspopup="menu"
      className={`flex h-11 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors md:h-7 ${
        open ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
      }`} title="Show or hide read-only trading evidence">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M4 7h10M4 17h16M14 4v6M10 14v6" />
      </svg>
      Overlays
      {data && data.items.length > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-semibold text-accent">{data.items.length}</span>}
    </button>
    {open && <div role="menu" aria-label="Trading overlay visibility"
      className="absolute right-0 top-full z-50 mt-1 w-[min(19rem,calc(100vw-1rem))] rounded-lg border border-border bg-surface p-3 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-xs font-semibold text-ink">Read-only trading overlays</p>
          <p className="mt-0.5 text-[11px] leading-4 text-ink-faint">Display preferences only. No chart execution.</p></div>
        {loading && <span role="status" className="text-[11px] text-ink-faint">Loading…</span>}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {(Object.keys(LABELS) as Array<keyof TradingOverlayPreferences>).map((key) => <label key={key}
          className="flex min-h-11 cursor-pointer items-center gap-2 rounded border border-border px-2 text-xs text-ink-muted hover:bg-surface-2">
          <input type="checkbox" checked={value[key]} onChange={() => toggle(key)} />{LABELS[key]}
        </label>)}
      </div>
      {error && <p role="alert" className="mt-2 rounded border border-down/30 bg-down/10 px-2 py-1.5 text-[11px] text-down">{error}</p>}
      {items.length > 0 && <details className="mt-2 border-t border-border pt-2">
        <summary className="cursor-pointer text-xs text-ink-muted">Evidence in range ({items.length})</summary>
        <div className="mt-1 max-h-44 overflow-y-auto">
          {items.map((item) => <button key={item.id} onClick={() => { onSelect(item.id); onOpen(false); }}
            className="flex min-h-11 w-full items-center justify-between gap-2 border-b border-border/60 px-1 text-left text-[11px] last:border-b-0 hover:bg-surface-2">
            <span className="min-w-0 truncate text-ink">{item.source} · {item.side ?? "POSITION"}</span>
            <span className={item.environment === "PAPER" ? "shrink-0 text-warn" : "shrink-0 text-ink-faint"}>{item.environment}</span>
          </button>)}
        </div>
      </details>}
      {data?.truncated && <p className="mt-2 rounded border border-warn/30 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
        This range reached the server rendering bound; shown evidence is explicitly truncated.
      </p>}
    </div>}
  </div>;
}

const ID_LABELS: Record<string, string> = {
  manualOrderId: "Manual order", manualPositionId: "Manual position", requestId: "Request",
  clientOrderId: "Client order", exchangeOrderId: "Exchange order", executionId: "Execution",
  alertId: "Alert", paperFillId: "Paper fill", realizedPnlId: "Realization",
  deploymentId: "Deployment", strategyId: "Strategy", configId: "Config",
};

export function TradingOverlayDetails({ item, onClose }: {
  item: TradingOverlayItem; onClose: () => void;
}) {
  const time = item.eventTime ?? item.observedAt;
  return <aside aria-label="Selected trading overlay evidence"
    className="fixed bottom-16 left-2 right-2 z-30 max-h-[55%] overflow-auto rounded-lg border border-border bg-surface/95 p-3 shadow-xl backdrop-blur sm:absolute sm:bottom-2 sm:right-auto sm:w-[390px]">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap gap-1.5 text-[10px] font-semibold">
          <span className="rounded border border-border px-1.5 py-0.5 text-ink">{item.source}</span>
          <span className={`rounded border px-1.5 py-0.5 ${item.environment === "PAPER" ? "border-warn/40 text-warn" : "border-border text-ink-muted"}`}>{item.environment}</span>
          {item.side && <span className="rounded border border-border px-1.5 py-0.5 text-ink-muted">{item.side}</span>}
          <span className="rounded border border-border px-1.5 py-0.5 text-ink-muted">{item.evidenceClass === "CURRENT_AUTHORITATIVE_STATE" ? "CURRENT STATE" : "HISTORICAL EVENT"}</span>
        </div>
        <h2 className="mt-1.5 text-sm font-semibold text-ink">{item.evidenceKind.replaceAll("_", " ")}</h2>
      </div>
      <button onClick={onClose} aria-label="Close overlay details" className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-surface-2 hover:text-ink md:h-8 md:w-8">×</button>
    </div>
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      <div><dt className="text-ink-faint">Price</dt><dd className="font-mono text-ink">{item.price.toLocaleString(undefined, { maximumFractionDigits: 8 })}</dd></div>
      <div><dt className="text-ink-faint">Quantity</dt><dd className="font-mono text-ink-muted">{item.quantity ?? "Unknown"}</dd></div>
      <div className="col-span-2"><dt className="text-ink-faint">{item.eventTime ? "Original event time" : "Observed current state"}</dt>
        <dd className="text-ink-muted">{time ? new Date(time).toLocaleString() : "Unknown"}</dd></div>
      {item.state && <div><dt className="text-ink-faint">State</dt><dd className="uppercase text-ink-muted">{item.state.replaceAll("_", " ")}</dd></div>}
      <div><dt className="text-ink-faint">Completeness</dt><dd className="text-ink-muted">{item.completeness}</dd></div>
    </dl>
    <p className="mt-2 border-t border-border pt-2 text-[11px] leading-4 text-ink-muted">{item.detail}</p>
    {(item.provenance.strategy || item.provenance.deploymentId) && <p className="mt-1.5 break-words text-[11px] text-ink-faint">
      {item.provenance.strategy ? `Strategy ${item.provenance.strategy.name ?? item.provenance.strategy.key ?? item.provenance.strategy.id}` : ""}
      {item.provenance.config ? ` · Config ${item.provenance.config.name ?? item.provenance.config.id}` : ""}
      {item.provenance.deploymentId ? ` · Deployment ${item.provenance.deploymentId}` : ""}
    </p>}
    {Object.keys(item.identifiers).length > 0 && <details className="mt-2 text-[11px] text-ink-faint">
      <summary className="cursor-pointer py-1 text-ink-muted">Exact identifiers</summary>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 rounded border border-border/70 p-2">
        {Object.entries(item.identifiers).map(([key, value]) => <div className="contents" key={key}>
          <dt>{ID_LABELS[key] ?? key}</dt><dd className="break-all font-mono text-ink-muted">{value}</dd>
        </div>)}
      </dl>
    </details>}
    <div className="mt-2 flex flex-wrap gap-3 border-t border-border pt-2 text-xs">
      <Link href="/journal" className="inline-flex min-h-11 items-center underline text-ink-muted hover:text-ink">Open Trade Journal</Link>
      {item.provenance.deploymentId && <Link href="/deployments" className="inline-flex min-h-11 items-center underline text-ink-muted hover:text-ink">Open deployment Timeline</Link>}
    </div>
  </aside>;
}
