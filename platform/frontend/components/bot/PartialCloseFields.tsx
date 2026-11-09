"use client";
/**
 * The Partial close controls: 25 / 50 / 75 % presets, a 1-99 slider and a
 * preview of what selling that share would mean.
 *
 * Adapted from the standalone Bot dashboard's `PartialCloseModal`
 * (bot/frontend/src/pages/Dashboard.tsx), without its `confirm()` (the
 * step-up dialog confirms) and with the fee called what it is: an estimate.
 * The Bot takes whole percentages from 1 to 99.
 */
import { useId } from "react";
import type { BotViewTrade } from "@/lib/api";
import { fmtQty } from "@/lib/format";
import { ESTIMATED_FEE_RATE, PARTIAL_PRESETS, formatPair, partialPreview } from "./botLogic";
import { dollars, money } from "./BotTrades";

export function PartialCloseFields({ trade, pct, onChange }: {
  trade: BotViewTrade;
  pct: number;
  onChange: (pct: number) => void;
}) {
  const sliderId = useId();
  const pair = formatPair(trade.pair);
  const base = pair.split("/")[0];
  const preview = partialPreview(trade, pct);
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border p-3 text-xs tabular">
        <dt className="text-ink-muted">Pair</dt><dd className="text-right text-ink">{pair}</dd>
        <dt className="text-ink-muted">Full position</dt><dd className="text-right text-ink">{fmtQty(trade.quantity)} {base}</dd>
        <dt className="text-ink-muted">Cost basis</dt><dd className="text-right text-ink">{dollars(trade.quoteSpent)}</dd>
      </dl>
      <div role="group" aria-label="Preset share" className="flex gap-2">
        {PARTIAL_PRESETS.map((preset) => (
          <button key={preset} type="button" aria-pressed={pct === preset} onClick={() => onChange(preset)}
            className={`tvc-control h-[34px] flex-1 rounded-md border text-sm font-medium ${pct === preset
              ? "border-transparent bg-[var(--ts-menu-selected-bg)] text-[var(--ts-menu-selected-ink)]"
              : "border-control-border text-ink-muted hover:text-ink"}`}>{preset}%</button>
        ))}
      </div>
      <div>
        <label htmlFor={sliderId} className="text-xs font-medium text-ink-muted">Share of the position to sell: <span className="text-ink tabular">{pct}%</span></label>
        <input id={sliderId} type="range" min={1} max={99} step={1} value={pct}
          onChange={(e) => onChange(Math.round(Number(e.target.value)))}
          aria-valuetext={`${pct} percent`} className="mt-1 w-full accent-[var(--ts-ink)]" />
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border p-3 text-xs tabular" aria-label="Preview">
        <dt className="text-ink-muted">Selling</dt><dd className="text-right text-ink">{fmtQty(preview.sellQty)} {base}</dd>
        <dt className="text-ink-muted">Estimated revenue</dt>
        <dd className="text-right text-ink">{preview.priceKnown ? dollars(preview.estRevenue) : "—"}</dd>
        <dt className="text-ink-muted">Estimated P&amp;L of this part</dt>
        <dd className={`text-right ${preview.estPnl >= 0 ? "text-up" : "text-down"}`}>{preview.priceKnown ? money(preview.estPnl) : "—"}</dd>
      </dl>
      <p className="text-xs text-ink-faint">
        An estimate at the last price, assuming a {(ESTIMATED_FEE_RATE * 100).toFixed(1)}% fee on each side. The market sell fills at
        whatever the exchange gives; the Bot records the real fee from the fills. The remaining {preview.remainingPct}% stays open.
      </p>
    </div>
  );
}
