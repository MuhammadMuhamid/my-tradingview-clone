"use client";
/**
 * Every dialog the chart workspace can open, and the toast it answers with.
 *
 * These are modal surfaces that belong to the workspace rather than to any one
 * pane: an alert is armed on an instrument and a timeframe, not on a chart
 * position. Grouping them here keeps the page's own render to the layout —
 * toolbar, panes, panels — instead of ninety lines of dialog mounting.
 *
 * Every one of them renders through `components/Modal`, which is what carries
 * the focus trap, the Escape handler and the dialog role; a hand-rolled
 * overlay here would silently miss all three.
 */
import { AlertEditor } from "@/components/tv/AlertEditor";
import { AlertModal } from "@/components/tv/AlertModal";
import { IndicatorAlertModal, type IndicatorKind } from "@/components/tv/IndicatorAlertModal";
import { LevelAlertModal } from "@/components/tv/LevelAlertModal";
import { MaAlertModal } from "@/components/tv/MaAlertModal";
import { PriceAlertModal } from "@/components/tv/PriceAlertModal";
import { StrategySettingsModal, type StrategyProperties } from "@/components/tv/StrategySettingsModal";
import { SymbolSearch } from "@/components/tv/SymbolSearch";
import type { MaAlert } from "@/lib/api";
import type { MaType } from "@/lib/movingAverages";
import type { Interval, Strategy, StrategyParams } from "@/lib/types";

export interface ChartDialogsProps {
  /** The focused pane's instrument and timeframe — what an alert is armed on. */
  symbol: string;
  interval: Interval;

  settingsOpen: boolean;
  onCloseSettings: () => void;
  strategy: Strategy | null;
  strategyKey: string;
  strategies: Strategy[];
  params: StrategyParams;
  properties: StrategyProperties;
  onApplyStrategy: (params: StrategyParams, properties: StrategyProperties) => void;

  /** Which pane the symbol dialog retargets, or null when it is closed. */
  searchPaneId: string | null;
  /** The symbol that pane is currently on. */
  searchSymbol: string;
  onCloseSearch: () => void;
  onSelectSymbol: (symbol: string) => void;
  onSymbolAdded: () => void;

  maAlerts: MaAlert[];
  priceAlertOpen: boolean;
  onClosePriceAlert: () => void;
  priceAlertLevel: number | null;
  lastPrice: number | null;
  onPickFromChart: () => void;

  levelKind: "sr_zone" | "pivot_level" | null;
  onCloseLevel: () => void;
  oscillatorKind: IndicatorKind | null;
  onCloseOscillator: () => void;

  editingAlert: MaAlert | null;
  onCloseEditingAlert: () => void;
  armLine: { type: MaType; length: number } | null;
  onCloseArmLine: () => void;

  alertOpen: boolean;
  onCloseAlert: () => void;
  onAutomationCreated: (name: string) => void;

  onAlertSaved: (message: string) => void;
  toast: string | null;
  onDismissToast: () => void;
}

export function ChartDialogs(props: ChartDialogsProps) {
  const {
    symbol, interval, strategy, strategyKey, params, properties, maAlerts,
    armLine, onAlertSaved,
  } = props;
  return (
    <>
    <StrategySettingsModal
      open={props.settingsOpen}
      onClose={props.onCloseSettings}
      strategyName={strategy?.name ?? strategyKey}
      strategyKey={strategyKey}
      params={params}
      properties={properties}
      onApply={props.onApplyStrategy}
    />
    <SymbolSearch
      open={props.searchPaneId !== null}
      current={props.searchSymbol}
      onClose={props.onCloseSearch}
      onSelect={props.onSelectSymbol}
      onSymbolAdded={props.onSymbolAdded}
    />
    <PriceAlertModal
      open={props.priceAlertOpen}
      onClose={props.onClosePriceAlert}
      symbol={symbol}
      chartTimeframe={interval}
      initialPrice={props.priceAlertLevel}
      lastPrice={props.lastPrice}
      existing={maAlerts.filter((a) => a.conditionKind === "price")}
      onPickFromChart={props.onPickFromChart}
      onSaved={onAlertSaved}
    />
    <LevelAlertModal
      open={props.levelKind !== null}
      onClose={props.onCloseLevel}
      symbol={symbol}
      defaultTimeframe={interval}
      initialKind={props.levelKind ?? "sr_zone"}
      onSaved={onAlertSaved}
    />
    <IndicatorAlertModal
      open={props.oscillatorKind !== null}
      onClose={props.onCloseOscillator}
      symbol={symbol}
      defaultTimeframe={interval}
      kind={props.oscillatorKind ?? "rsi"}
      onSaved={onAlertSaved}
    />
    <AlertEditor
      alert={props.editingAlert}
      onClose={props.onCloseEditingAlert}
      onSaved={(_updated, message) => onAlertSaved(message)}
      onDeleted={(_deleted, message) => onAlertSaved(message)}
    />
    <MaAlertModal
      open={armLine !== null}
      onClose={props.onCloseArmLine}
      symbol={symbol}
      chartTimeframe={interval}
      maType={armLine?.type ?? "sma"}
      maLength={armLine?.length ?? 200}
      existing={maAlerts.filter(
        (a) => a.conditionKind === "ma" &&
               a.maType === armLine?.type && a.maLength === armLine?.length
      )}
      onSaved={onAlertSaved}
    />
    <AlertModal
      open={props.alertOpen}
      onClose={props.onCloseAlert}
      symbol={symbol}
      timeframe={interval}
      strategy={strategy}
      strategies={props.strategies}
      params={params}
      onCreated={props.onAutomationCreated}
    />
    {props.toast && (
      <div className="fixed bottom-4 right-16 z-50 flex items-center gap-3 rounded-md border border-up/30 bg-surface px-4 py-2.5 text-sm shadow-xl">
        <span className="h-2 w-2 rounded-full bg-up" />
        {props.toast}
        <button
          onClick={props.onDismissToast}
          aria-label="Dismiss"
          className="flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
    )}
    </>
  );
}
