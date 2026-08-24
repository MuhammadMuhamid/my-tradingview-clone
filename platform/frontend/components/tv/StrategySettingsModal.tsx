"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui";
import { ParamForm } from "@/components/ParamForm";
import { groupsFor, defaultParamsFor } from "@/lib/paramSchema";
import type { StrategyParams } from "@/lib/types";

export interface StrategyProperties {
  initialCapital: number;
  qtyCash: number;       // legacy layouts; kept for backward compatibility
  qtyType?: "cash" | "percent_of_equity";
  qtyValue?: number;
  commissionPct: number;
  slippageTicks: number;
}

/**
 * `X-09` / `OPT-03`: commission defaulted to 0.05 % here and in the backtest
 * API, while every optimizer tree runs 0.1 % PER SIDE (0.2 % round trip, which
 * is Binance spot taker). A chart backtest at half the real friction is not
 * comparable with the leaderboard row it is meant to reproduce. Both defaults
 * now state the same figure; saved layouts keep whatever they recorded.
 */
export const DEFAULT_PROPERTIES: StrategyProperties = {
  initialCapital: 1000,
  // 930 mirrors the Pine script's own `default_qty_value = 930`; it is not
  // touched here, because changing it would silently change every cash-sized
  // chart backtest.
  qtyCash: 930,
  qtyType: "percent_of_equity",
  qtyValue: 100,
  commissionPct: 0.1,
  slippageTicks: 2,
};

/**
 * TradingView-style strategy settings dialog: Inputs | Properties tabs,
 * Defaults reset, Cancel/Ok. Edits are local until Ok, exactly like TV.
 */
export function StrategySettingsModal({
  open, onClose, strategyName, strategyKey, params, properties, onApply,
}: {
  open: boolean;
  onClose: () => void;
  strategyName: string;
  strategyKey: string;
  params: StrategyParams;
  properties: StrategyProperties;
  onApply: (params: StrategyParams, properties: StrategyProperties) => void;
}) {
  const [tab, setTab] = useState<"inputs" | "properties">("inputs");
  const [draft, setDraft] = useState<StrategyParams>(params);
  const [props, setProps] = useState<StrategyProperties>(properties);
  const [jsonDraft, setJsonDraft] = useState("");
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const groups = groupsFor(strategyKey);

  // Re-seed drafts each time the dialog opens.
  useEffect(() => {
    if (open) {
      setDraft(params);
      setProps(properties);
      setJsonDraft(JSON.stringify(params, null, 2));
      setJsonErr(null);
      setTab("inputs");
    }
  }, [open, params, properties]);

  const ok = () => {
    if (!groups) {
      try {
        onApply(JSON.parse(jsonDraft) as StrategyParams, props);
      } catch {
        setJsonErr("Invalid JSON");
        return;
      }
    } else {
      onApply(draft, props);
    }
    onClose();
  };

  const resetDefaults = () => {
    const d = defaultParamsFor(strategyKey);
    setDraft(d);
    setJsonDraft(JSON.stringify(d, null, 2));
    setProps(DEFAULT_PROPERTIES);
  };

  const num = (v: string): number => parseFloat(v || "0");

  return (
    <Modal open={open} onClose={onClose} title={strategyName} wide
      footer={
        <>
          <Button variant="ghost" onClick={resetDefaults}>Defaults</Button>
          <div className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={ok}>Ok</Button>
        </>
      }
    >
      <div className="mb-4 flex gap-5 border-b border-border">
        {(["inputs", "properties"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 pb-2 text-sm font-medium capitalize transition-colors ${
              tab === t ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "inputs" ? (
        groups ? (
          <ParamForm value={draft} onChange={setDraft} />
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-ink-faint">
              No form schema registered for this strategy yet — edit raw params (Pine input names).
            </p>
            <textarea
              value={jsonDraft}
              onChange={(e) => setJsonDraft(e.target.value)}
              rows={16}
              className="w-full rounded-md border border-border bg-surface-2 p-2 font-mono text-xs text-ink outline-none focus:border-accent"
            />
            {jsonErr && <p className="text-xs text-down">{jsonErr}</p>}
          </div>
        )
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Initial capital (USDT)</span>
            <input type="number" value={props.initialCapital}
              onChange={(e) => setProps({ ...props, initialCapital: num(e.target.value) })}
              className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Order size</span>
            <div className="flex gap-2">
              <input type="number" value={props.qtyValue ?? props.qtyCash}
                onChange={(e) => setProps({ ...props, qtyValue: num(e.target.value) })}
                className="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
              <select value={props.qtyType ?? "cash"}
                onChange={(e) => setProps({ ...props, qtyType: e.target.value as "cash" | "percent_of_equity" })}
                className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent">
                <option value="percent_of_equity">% of equity</option>
                <option value="cash">USDT cash</option>
              </select>
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Commission (% per fill)</span>
            <input type="number" step={0.01} value={props.commissionPct}
              onChange={(e) => setProps({ ...props, commissionPct: num(e.target.value) })}
              className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Slippage (ticks)</span>
            <input type="number" value={props.slippageTicks}
              onChange={(e) => setProps({ ...props, slippageTicks: num(e.target.value) })}
              className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
          </label>
          <p className="col-span-2 text-xs text-ink-faint">
            These mirror the Pine strategy() header: cash or percent-of-equity sizing, commission and tick slippage —
            the same values the backtester's broker emulator uses.
          </p>
        </div>
      )}
    </Modal>
  );
}
