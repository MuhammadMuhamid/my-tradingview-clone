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
import { type Resolution } from "@/lib/resolution";
import { AlertModal } from "@/components/tv/AlertModal";
import { IndicatorAlertModal, type IndicatorKind } from "@/components/tv/IndicatorAlertModal";
import { IndicatorBrowser } from "@/components/tv/IndicatorBrowser";
import { LevelAlertModal } from "@/components/tv/LevelAlertModal";
import { MaAlertModal } from "@/components/tv/MaAlertModal";
import { PriceAlertModal } from "@/components/tv/PriceAlertModal";
import { StrategySettingsModal, type StrategyProperties } from "@/components/tv/StrategySettingsModal";
import { SymbolSearch } from "@/components/tv/SymbolSearch";
import type { MaAlert, PineScript } from "@/lib/api";
import type { MaType } from "@/lib/movingAverages";
import type { IndicatorsApi } from "@/lib/useIndicators";
import type { NativeStudiesApi } from "@/lib/useNativeStudies";
import type { Interval, Strategy, StrategyParams } from "@/lib/types";
import { alertIntervalFor, nativeOnlyNotice, storedFallbackFor } from "@/lib/timeframes";

export interface ChartDialogsProps {
  /** The focused pane's instrument and timeframe — what an alert is armed on. */
  symbol: string;
  interval: Resolution;

  settingsOpen: boolean;
  onCloseSettings: () => void;
  strategy: Strategy | null;
  strategyKey: string;
  strategies: Strategy[];
  params: StrategyParams;
  properties: StrategyProperties;
  onApplyStrategy: (params: StrategyParams, properties: StrategyProperties) => void;

  /** The indicator library dialog, and the focused pane's studies it adds to. */
  indicatorBrowserOpen: boolean;
  /** The focused pane's built-in studies, for the Built-in library section. */
  nativeStudies: NativeStudiesApi | null;
  onCloseIndicatorBrowser: () => void;
  indicators: IndicatorsApi | null;
  onOpenInEditor: (script: PineScript) => void;

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
  /**
   * Why the prefilled price is not a live one, when it is not. Passed through
   * so the dialog can qualify the number rather than let a stored close pass
   * for the market — see `lib/lastPrice`.
   */
  lastPriceNotice?: string | null;
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
  /*
   * What an alert armed from this chart is actually armed ON.
   *
   * The chart's own resolution whenever the alert runner can evaluate it. When
   * it cannot — a derived `45m`, or `1s`, which the runner's two-second
   * intrabar floor cannot honour once per bar — the dialog opens on the stored
   * interval underneath and SAYS SO, through `ResolutionNotice`. The timeframe
   * control is right there, so this is a stated default rather than a
   * substitution; see `components/tv/ResolutionNotice.tsx` for why the
   * difference matters more than it looks.
   */
  const alertTimeframe: Interval =
    alertIntervalFor(interval) ?? storedFallbackFor(interval) ?? "15m";
  const alertNotice = nativeOnlyNotice(interval, "alerts");
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
    <IndicatorBrowser
      open={props.indicatorBrowserOpen}
      onClose={props.onCloseIndicatorBrowser}
      symbol={symbol}
      interval={interval}
      indicators={props.indicators}
      nativeStudies={props.nativeStudies}
      onOpenInEditor={props.onOpenInEditor}
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
      chartTimeframe={alertTimeframe}
      resolutionNotice={alertNotice}
      initialPrice={props.priceAlertLevel}
      lastPrice={props.lastPrice}
      lastPriceNotice={props.lastPriceNotice ?? null}
      existing={maAlerts.filter((a) => a.conditionKind === "price")}
      onPickFromChart={props.onPickFromChart}
      onSaved={onAlertSaved}
    />
    <LevelAlertModal
      open={props.levelKind !== null}
      onClose={props.onCloseLevel}
      symbol={symbol}
      defaultTimeframe={alertTimeframe}
      resolutionNotice={alertNotice}
      initialKind={props.levelKind ?? "sr_zone"}
      onSaved={onAlertSaved}
    />
    <IndicatorAlertModal
      open={props.oscillatorKind !== null}
      onClose={props.onCloseOscillator}
      symbol={symbol}
      defaultTimeframe={alertTimeframe}
      resolutionNotice={alertNotice}
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
      chartTimeframe={alertTimeframe}
      resolutionNotice={alertNotice}
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
