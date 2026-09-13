"use client";
/**
 * Chart settings, at the depth the reference actually has.
 *
 * ── What was wrong, measured rather than assumed ───────────────────────────
 *
 * The previous version had seven sidebar labels matching TradingView's seven,
 * and the parity claim rested on that. Enumerated control by control against
 * the live dialog, the seven labels covered ELEVEN controls: six toggles, one
 * select, one number field, one button — and a "Symbol" tab that was a
 * read-only definition list whose first row printed
 * `instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot` at the user. The reference's
 * Symbol tab is where candle colours, body/border/wick visibility and price
 * precision live; it is the tab with the MOST controls, and it had none.
 *
 * ── The rule for what is here ──────────────────────────────────────────────
 *
 * Every control writes a setting `CandleChart` applies to the engine or to its
 * own markup. Nothing here is decorative. Three things the reference offers
 * are deliberately ABSENT rather than faked, because lightweight-charts 4.2
 * exposes no equivalent and a switch that moves nothing is worse than a
 * missing one: locking the price-to-bar ratio, suppressing overlapping axis
 * labels, and per-instrument timezone (this chart is UTC throughout, and
 * `lib/chartClock` says so beside the axis).
 *
 * ── Layout ─────────────────────────────────────────────────────────────────
 *
 * Measured off the live dialog: a 206x40 tab rail at radius 8, a content
 * column whose rows are label-left / control-right on a 50px pitch, uppercase
 * section headings, 34px controls at radius 6 with a 1px #575757 border, and a
 * Cancel/Ok footer. `Row`, `Toggle`, `Select`, `NumberField` and `Swatch`
 * below are that grammar, once, so a new setting cannot invent its own.
 */
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import type { Resolution } from "@/lib/resolution";
import {
  clearUserDefaultChartSettings, DATE_FORMATS, DEFAULT_CHART_SETTINGS,
  deleteChartSettingsTemplate, loadChartSettingsTemplates, PRECISIONS, PLACEMENTS,
  precisionLabel, saveChartSettingsTemplate, saveUserDefaultChartSettings,
  type ChartSettingsTemplate,
  type ChartSettings, type DateFormatName, type LineStyleName,
  type PricePrecision, type ScalePlacement,
} from "@/lib/chartSettings";
import { chartTransform, chartTypeLabel, renderKind, type ChartType } from "@/lib/chartType";
import { displaySymbol, displayTicker } from "@/lib/instrument";
import { Button } from "@/components/ui";
import { useAsk } from "@/components/AskDialog";
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

const PLACEMENT_LABEL: Record<ScalePlacement, string> = {
  right: "Right", left: "Left", both: "Both", none: "No scale",
};

export function ChartSettingsModal({
  open, onClose, symbol, interval, chartType, scale, onScale, onReset, settings, onSettings,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  interval: Resolution;
  /** Which presentation is active, so its own parameters can be filed under it. */
  chartType: ChartType;
  scale: PriceScaleState;
  onScale: (next: PriceScaleState) => void;
  onReset: () => void;
  settings: ChartSettings;
  onSettings: (next: ChartSettings) => void;
}) {
  const [tab, setTab] = useState<Tab>("symbol");
  /*
   * What the dialog was showing when it opened, so Cancel can put it back.
   *
   * The reference's footer is Cancel / Ok and both mean something: every
   * control applies live, and Cancel undoes the whole visit. This dialog used
   * to have one "Done" button, so a user who changed six things to see what
   * they did had no way back except changing them back.
   */
  const [entry, setEntry] = useState<{ settings: ChartSettings; scale: PriceScaleState } | null>(null);
  useEffect(() => {
    if (!open) { setEntry(null); return; }
    setTab("symbol");
    setEntry({ settings, scale });
    // Captured once per opening, deliberately: this must be the state on ENTRY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = <K extends keyof ChartSettings>(key: K, value: ChartSettings[K]): void =>
    onSettings({ ...settings, [key]: value });

  /** The same condition `CandleChart`'s series-appearance effect applies. */
  const seriesColoursApply = renderKind(chartType) === "candles"
    && chartType !== "hollowCandles" && chartType !== "highLow";

  /*
   * The two colour wells reach further than the three toggles beside them.
   *
   * They were gated together, on the reasoning that a Line chart has no body
   * to colour — true of the toggles, and it stopped being true of the wells
   * the moment the volume histogram started deriving its palette from them.
   * On a Line, Area, Baseline or Columns chart the volume under the price is
   * still drawn and still takes `upColor` / `downColor`, so hiding the wells
   * there removed the only way to recolour it.
   *
   * Volume is not drawn under a transform that invents its own bars — Renko,
   * Kagi, Point & Figure, Line break — and there the wells genuinely reach
   * nothing, so they stay hidden.
   */
  const transform = chartTransform(chartType);
  const volumeTakesDirectionColours = transform === null || transform === "heikinAshi";
  const directionColoursApply = seriesColoursApply || volumeTakesDirectionColours;

  const cancel = (): void => {
    if (entry) { onSettings(entry.settings); onScale(entry.scale); }
    onClose();
  };

  /*
   * TVP8: Template and Defaults, which the reference puts in this footer and
   * which this was the only settings dialog in the product without —
   * `StrategySettingsModal` and `NativeStudySettings` both have a Defaults.
   *
   * A per-user default reaches further than it looks: every new pane starts
   * from the product's defaults, so a trader who wants a 3px crosshair and no
   * grid was setting it again on every pane they opened.
   */
  const ask = useAsk();
  const [templates, setTemplates] = useState<ChartSettingsTemplate[]>([]);
  useEffect(() => { if (open) setTemplates(loadChartSettingsTemplates()); }, [open]);

  const applyTemplate = (name: string): void => {
    const found = templates.find((t) => t.name === name);
    if (found) onSettings(found.settings);
  };

  const saveTemplate = async (): Promise<void> => {
    const name = (await ask.promptFor({
      title: "Save chart settings as a template",
      label: "Name", placeholder: "Dark, no grid", confirmLabel: "Save",
    }))?.trim();
    if (!name) return;
    setTemplates(saveChartSettingsTemplate(templates, name, settings));
  };

  const removeTemplate = async (name: string): Promise<void> => {
    if (!await ask.confirm({
      title: `Delete the template “${name}”?`,
      body: "Charts already using these settings keep them.",
      confirmLabel: "Delete", tone: "danger",
    })) return;
    setTemplates(deleteChartSettingsTemplate(templates, name));
  };

  return (
    <Modal
      open={open}
      onClose={cancel}
      title="Chart settings"
      wide
      footer={
        <div className="flex w-full items-center gap-2">
          {/* TVP8: Template and Defaults, on the left as the reference has them. */}
          <Select
            value=""
            label="Chart settings template"
            onChange={(v) => {
              if (v === "__save") void saveTemplate();
              else if (v.startsWith("__delete:")) void removeTemplate(v.slice("__delete:".length));
              else if (v) applyTemplate(v);
            }}
            options={[
              { value: "", label: "Template" },
              ...templates.map((t) => ({ value: t.name, label: t.name })),
              { value: "__save", label: "Save current settings as…" },
              ...templates.map((t) => ({ value: `__delete:${t.name}`, label: `Delete “${t.name}”` })),
            ]}
          />
          <Button
            onClick={() => void (async () => {
              if (!await ask.confirm({
                title: "Chart defaults",
                body: "Save these settings as the defaults every new pane starts from, "
                  + "or reset this chart back to the product's own.",
                confirmLabel: "Save as default",
                cancelLabel: "Reset this chart",
              })) {
                clearUserDefaultChartSettings();
                onSettings(DEFAULT_CHART_SETTINGS);
                return;
              }
              saveUserDefaultChartSettings(settings);
            })()}
            className="px-3"
          >
            Defaults
          </Button>
          <span className="flex-1" />
          <Button onClick={cancel} className="px-4">Cancel</Button>
          <Button variant="primary" onClick={onClose} className="px-4">Ok</Button>
        </div>
      }
    >
      <div className="flex min-h-[440px] gap-5">
        <nav aria-label="Chart settings sections" className="w-[206px] shrink-0">
          {TABS.map((item) => (
            <button key={item.id} role="tab" aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              /*
                Selected was `bg-state-hover` — the HOVER neutral — so hovering
                any sibling painted it identically to the open tab and the only
                thing left telling them apart was #fff against #dbdbdb ink. The
                two-neutral rule exists precisely for this, and `aria-selected`
                is already announced, so the chip reads it.
              */
              className={`tvc-control mb-0.5 flex h-10 w-full items-center rounded-md px-3 text-left text-sm ${
                tab === item.id ? "text-ink" : "text-ink-muted hover:text-ink"
              }`}>
              {item.label}
            </button>
          ))}
        </nav>

        <section role="tabpanel" className="min-w-0 flex-1 border-l border-border pl-5">
          {tab === "symbol" && (
            <>
              <Head>{chartTypeLabel(chartType)}</Head>
              {/*
                Body / Borders / Wick only for the presentations that HAVE
                them. They were rendered for every chart type, so a Line or a
                Kagi chart offered three toggles and two colour wells whose
                applying effect returns early — controls that move nothing,
                which is the exact thing this dialog's own header forbids.
                Hollow candles and High-low are excluded for a different
                reason: their identity IS those colour slots.
              */}
              {seriesColoursApply && (
                <>
              <Row label="Body">
                <Toggle checked={settings.candleBody} onChange={(v) => set("candleBody", v)} label="Body" />
              </Row>
              <Row label="Borders">
                <Toggle checked={settings.candleBorders} onChange={(v) => set("candleBorders", v)} label="Borders" />
              </Row>
              <Row label="Wick">
                <Toggle checked={settings.candleWicks} onChange={(v) => set("candleWicks", v)} label="Wick" />
              </Row>
                </>
              )}
              {directionColoursApply && (
                <Row label={seriesColoursApply ? "Up / down" : "Up / down (volume)"}>
                  <Swatch value={settings.upColor} onChange={(v) => set("upColor", v)} label="Up colour" />
                  <Swatch value={settings.downColor} onChange={(v) => set("downColor", v)} label="Down colour" />
                </Row>
              )}

              {/*
                ── A chart type's own parameters, filed under the chart type ──
                `rangeTicks` used to sit under "Canvas" — a parameter of ONE
                presentation, on the tab about the drawing surface, visible on
                the twenty charts that ignore it. The other four were not
                anywhere: Renko's ATR period, Line break's count, Kagi's
                reversal and Point & figure's box and reversal were constants
                welded into the chart-type token AND into its label, so the
                menu read "Renko · ATR(14)" and no user could make it say
                anything else. The transform functions accepted all five as
                arguments the whole time.
              */}
              {chartType === "range" && (
                <>
                  <Head>Range</Head>
                  <Row label="Range size (ticks)">
                    <NumberField value={settings.rangeTicks} min={1} max={10000}
                      onChange={(v) => set("rangeTicks", v)} label="Range size in ticks" />
                  </Row>
                </>
              )}

              {chartType === "renko" && (
                <>
                  <Head>Renko</Head>
                  <Row label="ATR length">
                    <NumberField value={settings.renkoAtrPeriod} min={2} max={200}
                      onChange={(v) => set("renkoAtrPeriod", v)} label="Renko ATR length" />
                  </Row>
                </>
              )}

              {chartType === "lineBreak" && (
                <>
                  <Head>Line break</Head>
                  <Row label="Number of lines">
                    <NumberField value={settings.lineBreakLines} min={2} max={10}
                      onChange={(v) => set("lineBreakLines", v)} label="Line break count" />
                  </Row>
                </>
              )}

              {chartType === "kagi" && (
                <>
                  <Head>Kagi</Head>
                  <Row label="Reversal" suffix="%">
                    <NumberField value={settings.kagiReversalPercent} min={0.1} max={50} step={0.1}
                      onChange={(v) => set("kagiReversalPercent", v)} label="Kagi reversal percent" />
                  </Row>
                </>
              )}

              {chartType === "pointAndFigure" && (
                <>
                  <Head>Point &amp; figure</Head>
                  <Row label="Box size" suffix="%">
                    <NumberField value={settings.pnfBoxPercent} min={0.1} max={50} step={0.1}
                      onChange={(v) => set("pnfBoxPercent", v)} label="Point and figure box size percent" />
                  </Row>
                  <Row label="Reversal (boxes)">
                    <NumberField value={settings.pnfReversalBoxes} min={1} max={10}
                      onChange={(v) => set("pnfReversalBoxes", v)} label="Point and figure reversal in boxes" />
                  </Row>
                </>
              )}

              {(chartType === "sessionVolumeProfile" || chartType === "tpo") && (
                <>
                  <Head>{chartType === "tpo" ? "Time price opportunity" : "Session volume profile"}</Head>
                  {/*
                    The renderer branched on every one of these already —
                    `side`, `split`, `showPoc`, `widthRatio`, `rowSize`,
                    `valueAreaPercent`, `allocation`. The pane passed literals,
                    so a fully parameterised profile had no parameters. The
                    asymmetry that made it obvious: the DRAWING-based Fixed
                    Range Volume Profile has a five-control quick bar for the
                    same knobs, reading the same type through the same
                    function.
                  */}
                  <Row label="Rows">
                    <NumberField value={settings.profileRows} min={4} max={400}
                      onChange={(v) => set("profileRows", v)} label="Profile row count" />
                  </Row>
                  <Row label="Value area" suffix="%">
                    <NumberField value={settings.profileValueAreaPercent} min={30} max={100}
                      onChange={(v) => set("profileValueAreaPercent", v)} label="Value area percent" />
                  </Row>
                  {chartType === "tpo" && (
                    <Row label="Block duration" suffix="min">
                      <NumberField value={settings.tpoBlockMinutes} min={1} max={1440}
                        onChange={(v) => set("tpoBlockMinutes", v)} label="TPO block duration in minutes" />
                    </Row>
                  )}
                  <Row label="Volume placement">
                    <Select value={settings.profileAllocation} label="How a bar's volume is placed"
                      onChange={(v) => set("profileAllocation", v as "range" | "close")}
                      options={[
                        { value: "range", label: "Across the bar's range" },
                        { value: "close", label: "All at the close" },
                      ]} />
                  </Row>
                  <Row label="Rows show">
                    <Select value={settings.profileSplit} label="Row split"
                      onChange={(v) => set("profileSplit", v as "total" | "upDown")}
                      options={[
                        { value: "total", label: "Total volume" },
                        { value: "upDown", label: "Up and down apart" },
                      ]} />
                  </Row>
                  <Row label="Placement">
                    <Select value={settings.profileSide} label="Which side the profile is drawn from"
                      onChange={(v) => set("profileSide", v as "left" | "right")}
                      options={[{ value: "right", label: "Right" }, { value: "left", label: "Left" }]} />
                  </Row>
                  <Row label="Width" suffix="%">
                    <NumberField value={settings.profileWidthPercent} min={5} max={90}
                      onChange={(v) => set("profileWidthPercent", v)} label="Profile width percent" />
                  </Row>
                  <Row label="Point of control">
                    <Toggle checked={settings.profileShowPoc}
                      onChange={(v) => set("profileShowPoc", v)} label="Point of control" />
                  </Row>
                  <Row label="Value area shading">
                    <Toggle checked={settings.profileShowValueArea}
                      onChange={(v) => set("profileShowValueArea", v)} label="Value area shading" />
                  </Row>
                </>
              )}

              <Head>Data modification</Head>
              <Row label="Precision">
                <Select value={String(settings.precision)} label="Price precision"
                  onChange={(v) => set("precision", (v === "auto" ? "auto" : Number(v)) as PricePrecision)}
                  options={PRECISIONS.map((p) => ({ value: String(p), label: precisionLabel(p) }))} />
              </Row>
              <Row label="Timezone">
                <span className="text-sm text-ink-faint" title="Every axis, legend and alert time in this workspace is UTC. It is not per-chart.">
                  UTC
                </span>
              </Row>

              <Head>Instrument</Head>
              <dl className="grid grid-cols-[130px_1fr] gap-y-2 py-1 text-sm">
                <dt className="text-ink-faint">Symbol</dt>
                {/* The canonical identity is the tooltip, not the headline. */}
                <dd className="truncate font-medium text-ink" title={symbol}>{displayTicker(symbol)}</dd>
                <dt className="text-ink-faint">Identity</dt>
                <dd className="truncate text-ink-muted" title={symbol}>{displaySymbol(symbol)}</dd>
                <dt className="text-ink-faint">Interval</dt><dd className="text-ink">{interval}</dd>
                <dt className="text-ink-faint">Data source</dt><dd className="text-ink">Trading Scene market feed</dd>
              </dl>
            </>
          )}

          {tab === "status" && (
            <>
              <Head>Status line</Head>
              <Row label="Show status line">
                <Toggle checked={settings.showStatusLine} onChange={(v) => set("showStatusLine", v)} label="Show status line" />
              </Row>
              <Head>Instrument</Head>
              <Row label="Symbol and interval">
                <Toggle checked={settings.statusSymbol} onChange={(v) => set("statusSymbol", v)} label="Symbol and interval" />
              </Row>
              <Row label="Chart values">
                <Toggle checked={settings.statusOhlc} onChange={(v) => set("statusOhlc", v)} label="Chart values" />
              </Row>
              <Row label="Bar change values">
                <Toggle checked={settings.statusBarChange} onChange={(v) => set("statusBarChange", v)} label="Bar change values" />
              </Row>
              <Row label="Volume">
                <Toggle checked={settings.statusVolume} onChange={(v) => set("statusVolume", v)} label="Volume" />
              </Row>
              <Head>Indicators</Head>
              <Row label="Titles and values">
                <Toggle checked={settings.statusIndicatorValues} onChange={(v) => set("statusIndicatorValues", v)} label="Indicator titles and values" />
              </Row>
            </>
          )}

          {tab === "scales" && (
            <>
              <Head>Price scale</Head>
              <Row label="Scales placement">
                <Select value={settings.scalePlacement} label="Scales placement"
                  onChange={(v) => set("scalePlacement", v as ScalePlacement)}
                  options={PLACEMENTS.map((p) => ({ value: p, label: PLACEMENT_LABEL[p] }))} />
              </Row>
              <Row label="Scale mode">
                <Select value={scale.mode} label="Scale mode"
                  onChange={(v) => onScale({ ...scale, mode: v as PriceScaleMode })}
                  options={PRICE_SCALE_MODES.map((m) => ({ value: m.value, label: priceScaleModeLabel(m.value) }))} />
              </Row>
              <Row label="Auto scale">
                <Toggle checked={scale.autoScale} onChange={(v) => onScale({ ...scale, autoScale: v })} label="Auto scale" />
              </Row>
              <Row label="Invert scale">
                <Toggle checked={scale.invert === true} onChange={(v) => onScale({ ...scale, invert: v })} label="Invert scale" />
              </Row>
              <Row label="">
                <button onClick={onReset}
                  className="tvc-control flex h-[34px] items-center rounded-md border border-control-border px-3 text-sm text-ink-muted hover:text-ink">
                  Reset scale
                </button>
              </Row>

              {/*
                TVP8: the tab named "Scales and lines" had seven controls and
                every one of them was a scale. These are the lines it is named
                for, and each maps to a lightweight-charts series option, so
                none of them is a switch that moves nothing.
              */}
              <Head>Lines</Head>
              <Row label="Last value line">
                <Toggle checked={settings.lastValueLine} onChange={(v) => set("lastValueLine", v)}
                  label="Last value line" />
                {settings.lastValueLine && (
                  <>
                    <Swatch value={settings.lastValueLineColor}
                      onChange={(v) => set("lastValueLineColor", v)} label="Last value line colour" />
                    <NumberField value={settings.lastValueLineWidth} min={1} max={4}
                      onChange={(v) => set("lastValueLineWidth", v)} label="Last value line width" />
                    <Select value={settings.lastValueLineStyle} label="Last value line style"
                      onChange={(v) => set("lastValueLineStyle", v as LineStyleName)}
                      options={[{ value: "solid", label: "Solid" }, { value: "dotted", label: "Dotted" }, { value: "dashed", label: "Dashed" }]} />
                  </>
                )}
              </Row>
              <Row label="Last price label">
                <Toggle checked={settings.lastValueLabel} onChange={(v) => set("lastValueLabel", v)}
                  label="Last price label on the scale" />
              </Row>

              <Head>Time scale</Head>
              <Row label="Date format">
                <Select value={settings.dateFormat} label="Date format"
                  onChange={(v) => set("dateFormat", v as DateFormatName)}
                  options={DATE_FORMATS.map((f) => ({ value: f, label: f }))} />
              </Row>
              <Row label="Time hours format">
                <Select value={settings.timeFormat24h ? "24" : "12"} label="Time hours format"
                  onChange={(v) => set("timeFormat24h", v === "24")}
                  options={[{ value: "24", label: "24-hours" }, { value: "12", label: "12-hours" }]} />
              </Row>
              <Row label="Bars to the right">
                <NumberField value={settings.rightOffsetBars} min={0} max={200}
                  onChange={(v) => set("rightOffsetBars", v)} label="Empty bars kept right of the newest bar" />
              </Row>
            </>
          )}

          {tab === "canvas" && (
            <>
              <Head>Grid lines</Head>
              <Row label="Vertical grid lines">
                <Toggle checked={settings.gridVertical} onChange={(v) => set("gridVertical", v)} label="Vertical grid lines" />
              </Row>
              <Row label="Horizontal grid lines">
                <Toggle checked={settings.gridHorizontal} onChange={(v) => set("gridHorizontal", v)} label="Horizontal grid lines" />
              </Row>
              {/*
                TVP8: the grid had two on/off switches and no appearance at
                all. An empty colour means the theme's own, which is what every
                chart had before this existed.
              */}
              <Row label="Grid appearance">
                <Swatch value={settings.gridColor || "#2a2a2a"}
                  onChange={(v) => set("gridColor", v)} label="Grid colour" />
                <Select value={settings.gridStyle} label="Grid line style"
                  onChange={(v) => set("gridStyle", v as LineStyleName)}
                  options={[{ value: "solid", label: "Solid" }, { value: "dotted", label: "Dotted" }, { value: "dashed", label: "Dashed" }]} />
                {settings.gridColor && (
                  <button onClick={() => set("gridColor", "")}
                    className="tvc-control flex h-[26px] items-center rounded px-2 text-xs text-ink-muted hover:text-ink">
                    Theme colour
                  </button>
                )}
              </Row>
              <Row label="Crosshair">
                <Toggle checked={settings.showCrosshair} onChange={(v) => set("showCrosshair", v)} label="Crosshair" />
                {settings.showCrosshair && (
                  <>
                    <Swatch value={settings.crosshairColor || "#9598a1"}
                      onChange={(v) => set("crosshairColor", v)} label="Crosshair colour" />
                    <NumberField value={settings.crosshairWidth} min={1} max={4}
                      onChange={(v) => set("crosshairWidth", v)} label="Crosshair width" />
                    <Select value={settings.crosshairStyle} label="Crosshair style"
                      onChange={(v) => set("crosshairStyle", v as LineStyleName)}
                      options={[{ value: "solid", label: "Solid" }, { value: "dotted", label: "Dotted" }, { value: "dashed", label: "Dashed" }]} />
                  </>
                )}
              </Row>

              <Head>Background</Head>
              <Row label="Gradient background"
                suffix="A vertical wash instead of the pane's flat surface">
                <Toggle checked={settings.backgroundGradient}
                  onChange={(v) => set("backgroundGradient", v)} label="Gradient background" />
              </Row>
              <Row label="Symbol watermark"
                suffix="The ticker behind the bars, as the reference draws it">
                <Toggle checked={settings.watermark}
                  onChange={(v) => set("watermark", v)} label="Symbol watermark" />
              </Row>

              <Head>Scales</Head>
              <Row label="Text size">
                <Select value={String(settings.scaleFontSize)} label="Axis text size"
                  onChange={(v) => set("scaleFontSize", Number(v))}
                  options={[10, 11, 12, 13, 14, 16].map((n) => ({ value: String(n), label: String(n) }))} />
              </Row>

              <Head>Margins</Head>
              <Row label="Top" suffix="%">
                <NumberField value={settings.marginTopPct} min={0} max={50}
                  onChange={(v) => set("marginTopPct", v)} label="Top margin, percent" />
              </Row>
              <Row label="Bottom" suffix="%">
                <NumberField value={settings.marginBottomPct} min={0} max={50}
                  onChange={(v) => set("marginBottomPct", v)} label="Bottom margin, percent" />
              </Row>
              <p className="pt-2 text-xs leading-relaxed text-ink-faint">
                Canvas and grid colours follow the active Trading Scene theme, so light
                and dark stay consistent across the whole workspace rather than per chart.
              </p>
            </>
          )}

          {tab === "trading" && (
            <>
              <Head>Appearance</Head>
              <Row label="Positions and orders">
                <Toggle checked={settings.showTrading} onChange={(v) => set("showTrading", v)} label="Positions and orders" />
              </Row>
              <p className="pt-2 text-xs leading-relaxed text-ink-faint">
                Trading overlays are read-only chart annotations. Orders remain prepared in
                the paper / demo ticket and are never submitted from chart settings.
              </p>
            </>
          )}

          {tab === "alerts" && (
            <>
              <Head>Chart line visibility</Head>
              <Row label="Fired-alert markers">
                <Toggle checked={settings.showAlerts} onChange={(v) => set("showAlerts", v)} label="Fired-alert markers" />
              </Row>
              <p className="pt-2 text-xs leading-relaxed text-ink-faint">
                Alert creation and automation remain available from their normal toolbar
                and rail actions.
              </p>
            </>
          )}

          {tab === "events" && (
            <>
              <Head>Events</Head>
              <Row label="Strategy and alert events">
                <Toggle checked={settings.showEvents} onChange={(v) => set("showEvents", v)} label="Strategy and alert events" />
              </Row>
              <p className="pt-2 text-xs leading-relaxed text-ink-faint">
                Events come from the alert runner and from strategy results. Trading Scene
                does not carry an economic calendar or a news feed, so those rows the
                reference offers are not shown rather than shown empty.
              </p>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}

/* ── the dialog's grammar, once ─────────────────────────────────────────── */

function Head({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-faint first:pt-0">
      {children}
    </h3>
  );
}

/** Label left, controls right, on the reference's 50px pitch. */
function Row({ label, suffix, children }: {
  label: string; suffix?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[50px] items-center gap-3">
      <span className="min-w-[188px] shrink-0 text-sm text-ink">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
      {suffix && <span className="text-sm text-ink-faint">{suffix}</span>}
    </div>
  );
}

function Toggle({ checked, onChange, label }: {
  checked: boolean; onChange: (value: boolean) => void; label: string;
}) {
  return (
    <input type="checkbox" checked={checked} aria-label={label}
      onChange={(e) => onChange(e.target.checked)} className="h-[18px] w-[18px] accent-accent" />
  );
}

function Select({ value, onChange, options, label }: {
  value: string; onChange: (value: string) => void; label: string;
  options: { value: string; label: string }[];
}) {
  return (
    <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}
      className="h-[34px] w-[180px] rounded-md border border-control-border bg-transparent px-2 text-sm text-ink">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function NumberField({ value, onChange, min, max, step = 1, label }: {
  value: number; onChange: (value: number) => void;
  min: number; max: number; step?: number; label: string;
}) {
  return (
    <input type="number" value={value} min={min} max={max} step={step} aria-label={label}
      onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))}
      className="h-[34px] w-[86px] rounded-md border border-control-border bg-transparent px-2 text-sm tabular text-ink" />
  );
}

/**
 * A colour, as a colour.
 *
 * `<input type="color">` rather than a palette popover: it is the platform's
 * own picker, it is keyboard-reachable without any code here, and the reference
 * opens a picker from a swatch of exactly this size.
 */
function Swatch({ value, onChange, label }: {
  value: string; onChange: (value: string) => void; label: string;
}) {
  return (
    <input type="color" value={value} aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className="h-[26px] w-[34px] cursor-pointer rounded border border-control-border bg-transparent p-0.5" />
  );
}
