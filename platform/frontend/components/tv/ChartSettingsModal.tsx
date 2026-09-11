"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import type { Resolution } from "@/lib/resolution";
import {
  PRICE_SCALE_MODES, priceScaleModeLabel, type PriceScaleMode, type PriceScaleState,
} from "@/lib/priceScale";

type Tab = "symbol" | "status" | "scales" | "canvas" | "trading" | "alerts" | "events";
const TABS: { id: Tab; label: string }[] = [
  { id: "symbol", label: "Symbol" },
  { id: "status", label: "Status line" },
  { id: "scales", label: "Scales and lines" },
  { id: "canvas", label: "Canvas" },
  { id: "trading", label: "Trading" },
  { id: "alerts", label: "Alerts" },
  { id: "events", label: "Events" },
];

/** A real chart-settings entry point, separate from strategy properties. */
export function ChartSettingsModal({
  open, onClose, symbol, interval, scale, onScale, onReset,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  interval: Resolution;
  scale: PriceScaleState;
  onScale: (next: PriceScaleState) => void;
  onReset: () => void;
}) {
  const [tab, setTab] = useState<Tab>("symbol");
  useEffect(() => { if (open) setTab("symbol"); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Chart settings" wide
      footer={<button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-sm text-ink hover:bg-surface-2">Done</button>}>
      <div className="flex min-h-[420px] gap-5">
        <nav aria-label="Chart settings sections" className="w-40 shrink-0 border-r border-border pr-3">
          {TABS.map((item) => (
            <button key={item.id} role="tab" aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`mb-0.5 flex min-h-8 w-full items-center rounded px-2.5 text-left text-sm ${tab === item.id ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink"}`}>
              {item.label}
            </button>
          ))}
        </nav>
        <section role="tabpanel" className="min-w-0 flex-1">
          {tab === "symbol" && <div className="space-y-3">
            <h3 className="text-sm font-semibold text-ink">Instrument</h3>
            <p className="text-xs text-ink-muted">The focused chart is showing the canonical market identity below.</p>
            <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
              <dt className="text-ink-faint">Symbol</dt><dd className="font-medium text-ink">{symbol}</dd>
              <dt className="text-ink-faint">Interval</dt><dd className="text-ink">{interval}</dd>
              <dt className="text-ink-faint">Data source</dt><dd className="text-ink">Trading Scene market feed</dd>
            </dl>
            <p className="pt-2 text-xs text-ink-faint">Use the symbol control in the toolbar to change instruments.</p>
          </div>}
          {tab === "status" && <Info title="Status line">
            The status line is always visible on the chart and reports the active instrument, interval, OHLC readout and feed state. There are no hidden status-line toggles in this build.
          </Info>}
          {tab === "canvas" && <Info title="Canvas">
            Canvas colours, grid and crosshair follow the active Trading Scene theme. Use the theme control in the shell to switch between light and dark.
          </Info>}
          {tab === "trading" && <Info title="Trading">
            Orders are prepared in the paper/demo ticket and are never submitted from chart settings. Trading Scene keeps this safety boundary explicit.
          </Info>}
          {tab === "alerts" && <Info title="Alerts">
            Alert levels and automation are managed from the Alert and Automate controls. Existing levels remain scoped to the focused instrument and timeframe.
          </Info>}
          {tab === "events" && <Info title="Events">
            Strategy, alert and market events are rendered from their authoritative sources when available. No event display preferences are hidden here.
          </Info>}
          {tab === "scales" && <div className="space-y-4">
            <div><h3 className="text-sm font-semibold text-ink">Price scale</h3><p className="mt-1 text-xs text-ink-muted">These controls update the focused pane immediately and persist with its layout.</p></div>
            <label className="flex items-center justify-between gap-4 text-sm"><span>Scale mode</span>
              <select value={scale.mode} onChange={(e) => onScale({ ...scale, mode: e.target.value as PriceScaleMode })} className="rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink">
                {PRICE_SCALE_MODES.map((mode) => <option key={mode.value} value={mode.value}>{priceScaleModeLabel(mode.value)}</option>)}
              </select>
            </label>
            <Toggle label="Auto scale" checked={scale.autoScale} onChange={(checked) => onScale({ ...scale, autoScale: checked })} />
            <Toggle label="Invert scale" checked={scale.invert === true} onChange={(checked) => onScale({ ...scale, invert: checked })} />
            <button onClick={onReset} className="rounded border border-border px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">Reset scale</button>
          </div>}
        </section>
      </div>
    </Modal>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-center justify-between gap-4 text-sm"><span>{label}</span><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /></label>;
}

function Info({ title, children }: { title: string; children: string }) {
  return <div className="space-y-2"><h3 className="text-sm font-semibold text-ink">{title}</h3><p className="max-w-lg text-sm leading-relaxed text-ink-muted">{children}</p></div>;
}
