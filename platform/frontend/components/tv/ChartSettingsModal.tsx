"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import type { Resolution } from "@/lib/resolution";
import type { ChartSettings } from "@/lib/chartSettings";
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
  open, onClose, symbol, interval, scale, onScale, onReset, settings, onSettings,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  interval: Resolution;
  scale: PriceScaleState;
  onScale: (next: PriceScaleState) => void;
  onReset: () => void;
  settings: ChartSettings;
  onSettings: (next: ChartSettings) => void;
}) {
  const [tab, setTab] = useState<Tab>("symbol");
  useEffect(() => { if (open) setTab("symbol"); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Chart settings" wide
      footer={<button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-sm text-ink hover:bg-state-hover">Done</button>}>
      <div className="flex min-h-[420px] gap-5">
        <nav aria-label="Chart settings sections" className="w-40 shrink-0 border-r border-border pr-3">
          {TABS.map((item) => (
            <button key={item.id} role="tab" aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`mb-0.5 flex min-h-8 w-full items-center rounded px-2.5 text-left text-sm ${tab === item.id ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:bg-state-hover hover:text-ink"}`}>
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
          {tab === "status" && <div className="space-y-4"><Info title="Status line">Control the instrument and OHLC readout rendered over the focused chart.</Info><Toggle label="Show status line" checked={settings.showStatusLine} onChange={(checked) => onSettings({ ...settings, showStatusLine: checked })} /></div>}
          {tab === "canvas" && <div className="space-y-4"><Info title="Canvas">Canvas colours follow the active Trading Scene theme. These switches apply to this chart and persist with its workspace.</Info><Toggle label="Show grid lines" checked={settings.showGrid} onChange={(checked) => onSettings({ ...settings, showGrid: checked })} /><Toggle label="Show crosshair" checked={settings.showCrosshair} onChange={(checked) => onSettings({ ...settings, showCrosshair: checked })} /><label className="flex items-center justify-between gap-4 text-sm"><span>Range size (ticks)</span><input type="number" min={1} max={10000} step={1} value={settings.rangeTicks} onChange={(e) => onSettings({ ...settings, rangeTicks: Math.max(1, Math.min(10000, Number(e.target.value) || 1)) })} className="w-24 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink" /></label></div>}
          {tab === "trading" && <div className="space-y-4"><Info title="Trading">Trading overlays are read-only chart annotations. Orders remain prepared in the paper/demo ticket and are never submitted from chart settings.</Info><Toggle label="Show positions and orders" checked={settings.showTrading} onChange={(checked) => onSettings({ ...settings, showTrading: checked })} /></div>}
          {tab === "alerts" && <div className="space-y-4"><Info title="Alerts">Alert creation and automation remain available from their normal toolbar and rail actions.</Info><Toggle label="Show fired-alert markers" checked={settings.showAlerts} onChange={(checked) => onSettings({ ...settings, showAlerts: checked })} /></div>}
          {tab === "events" && <div className="space-y-4"><Info title="Events">Events are sourced from the alert runner and strategy results; this switch controls their chart annotations.</Info><Toggle label="Show strategy and alert events" checked={settings.showEvents} onChange={(checked) => onSettings({ ...settings, showEvents: checked })} /></div>}
          {tab === "scales" && <div className="space-y-4">
            <div><h3 className="text-sm font-semibold text-ink">Price scale</h3><p className="mt-1 text-xs text-ink-muted">These controls update the focused pane immediately and persist with its layout.</p></div>
            <label className="flex items-center justify-between gap-4 text-sm"><span>Scale mode</span>
              <select value={scale.mode} onChange={(e) => onScale({ ...scale, mode: e.target.value as PriceScaleMode })} className="rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink">
                {PRICE_SCALE_MODES.map((mode) => <option key={mode.value} value={mode.value}>{priceScaleModeLabel(mode.value)}</option>)}
              </select>
            </label>
            <Toggle label="Auto scale" checked={scale.autoScale} onChange={(checked) => onScale({ ...scale, autoScale: checked })} />
            <Toggle label="Invert scale" checked={scale.invert === true} onChange={(checked) => onScale({ ...scale, invert: checked })} />
            <button onClick={onReset} className="rounded border border-border px-3 py-1.5 text-sm text-ink-muted hover:bg-state-hover hover:text-ink">Reset scale</button>
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
