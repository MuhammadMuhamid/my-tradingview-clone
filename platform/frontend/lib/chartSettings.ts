/** Preferences owned by one chart pane and persisted with the workspace. */
export interface ChartSettings {
  /** The instrument/OHLC status line over the plot. */
  showStatusLine: boolean;
  /** Lightweight-charts grid lines. */
  showGrid: boolean;
  /** Lightweight-charts crosshair. */
  showCrosshair: boolean;
  /** Paper/trading position and order decorations. */
  showTrading: boolean;
  /** Fired-alert markers recorded by the alert runner. */
  showAlerts: boolean;
  /** Strategy, script and pattern event markers. */
  showEvents: boolean;
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  showStatusLine: true,
  showGrid: true,
  showCrosshair: true,
  showTrading: true,
  showAlerts: true,
  showEvents: true,
};

export function normalizeChartSettings(raw: unknown): ChartSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CHART_SETTINGS };
  const value = raw as Partial<ChartSettings>;
  return {
    showStatusLine: typeof value.showStatusLine === "boolean" ? value.showStatusLine : true,
    showGrid: typeof value.showGrid === "boolean" ? value.showGrid : true,
    showCrosshair: typeof value.showCrosshair === "boolean" ? value.showCrosshair : true,
    showTrading: typeof value.showTrading === "boolean" ? value.showTrading : true,
    showAlerts: typeof value.showAlerts === "boolean" ? value.showAlerts : true,
    showEvents: typeof value.showEvents === "boolean" ? value.showEvents : true,
  };
}

export function isDefaultChartSettings(value: ChartSettings): boolean {
  return (Object.keys(DEFAULT_CHART_SETTINGS) as (keyof ChartSettings)[])
    .every((key) => value[key] === DEFAULT_CHART_SETTINGS[key]);
}
