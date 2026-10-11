"use client";
/**
 * Chart settings, in the reference's row grammar.
 *
 * ── What R6 found, measured rather than argued ─────────────────────────────
 *
 * The outer box was right and everything inside it was a different product.
 * 750 wide, a 206px rail, 40px tabs, a 50px row pitch — all copied correctly —
 * and then every boolean row was drawn as `label … [checkbox at x=812]` on a
 * fixed 188px label column, where the reference's boolean is
 * `[checkbox at the content edge] label`. Eleven further tells followed from
 * that one: no sidebar glyphs, a vertical divider the reference does not have,
 * four tab-level PARAGRAPHS it does not have, a four-row identity block
 * printing `BINANCE:BTC/USDT · SPOT` and "Trading Scene market feed" at the
 * user, five native `<select>`s (OS chevron, OS popup), a native colour input
 * at 34×26, and a footer with two selects whose options were commands.
 *
 * ── The grammar, defined once, so a new row cannot invent its own ──────────
 *
 * Each tab is a two-column CSS grid: `minmax(<the tab's value column>,
 * max-content) 1fr` with a 20px gap, so the controls line up at the tab's
 * widest label + 20px — which is where the reference's land (688 Symbol, 779
 * Scales, 766 Canvas, 798 Trading, all from x=591, the content edge).
 *
 *   `CheckRow`  an 18px checkbox at the content edge, 10px, a 14px label, on a
 *               50px pitch, with any trailing controls in column two.
 *   `FieldRow`  a 14px label in column one, controls in column two.
 *   `Section`   an 11px uppercase title in a 32px row, spanning both columns.
 *   `note`      the ONE prose form: a 12px muted line under the row it
 *               qualifies, which makes that row 68px. There is no other prose
 *               in this dialog.
 *
 * Dependent rows are indented 26px and DISABLED while their parent is off —
 * never unmounted, which is what used to make the Lines row jump as it was
 * toggled.
 *
 * ── Where the controls themselves live ─────────────────────────────────────
 *
 * `components/ui.tsx`: `Checkbox`, `Dropdown`, `Swatch`, `LineStyleButton`,
 * `NumberField`. Contract §7 — the unique pages use the same primitives as the
 * workstation, and a swatch written here is a swatch the Screener cannot have.
 *
 * ── What is deliberately absent ────────────────────────────────────────────
 *
 * A control that moves nothing must not exist (contract §6). The reference
 * rows this product cannot honour are listed in the contract's §6 omissions —
 * instrument logo, open-market status, buy/sell buttons and one-click trading,
 * execution sound, alert volume, ideas, economic calendar, news, session
 * breaks, currency/unit and plus-button axis affordances, lock-price-to-bar
 * ratio, no-overlapping-labels, value-according-to-scale, navigation and pane
 * button overlays. None of them is drawn greyed out; they are simply not here.
 */
import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import type { Resolution } from "@/lib/resolution";
import {
  clearUserDefaultChartSettings, DATE_FORMATS, dateFormatExample, DEFAULT_CHART_SETTINGS,
  deleteChartSettingsTemplate, loadChartSettingsTemplates, PRECISIONS, PLACEMENTS,
  precisionLabel, saveChartSettingsTemplate, saveUserDefaultChartSettings,
  STATUS_TITLE_FORMS,
  type ChartSettingsTemplate,
  type ChartSettings, type DateFormatName,
  type PricePrecision, type ScalePlacement, type StatusTitleForm, type WatermarkMode,
} from "@/lib/chartSettings";
import { chartTransform, chartTypeLabel, renderKind, type ChartType } from "@/lib/chartType";
import {
  Button, CaretGlyph, Checkbox, Dropdown, LineStyleButton, NumberField, Swatch,
} from "@/components/ui";
import { TOOL_ICON_STROKE } from "@/components/tv/toolbarChrome";
import { TRADE_LABEL_LIMIT } from "@/components/CandleChart";
import { useAsk } from "@/components/AskDialog";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import {
  PRICE_SCALE_MODES, priceScaleModeLabel, type PriceScaleMode, type PriceScaleState,
} from "@/lib/priceScale";
import { CHART_TIME_ZONES } from "@/lib/chartClock";

/** The `Title` dropdown writes one of the three forms and nothing else. */
function statusTitleForm(value: string): StatusTitleForm {
  return STATUS_TITLE_FORMS.includes(value as StatusTitleForm)
    ? value as StatusTitleForm : "ticker";
}

type Tab = "symbol" | "status" | "scales" | "canvas" | "trading" | "alerts" | "events";
export type ChartSettingsTab = Tab;

/**
 * The sidebar's glyphs, drawn here in the product's own icon family.
 *
 * OV-K governs the family: a 24-unit viewBox, `TOOL_ICON_STROKE`, round caps,
 * the silhouette filling most of the box. The rail had no glyphs at all, which
 * left seven words in a 206px column and no way to find a tab except by
 * reading it.
 */
function TabGlyph({ children }: { children: React.ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={TOOL_ICON_STROKE} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      {children}
    </svg>
  );
}

const TABS: { id: Tab; label: string; glyph: React.ReactNode }[] = [
  {
    id: "symbol", label: "Symbol",
    // A candle: body and wick, twice.
    glyph: <TabGlyph><path d="M8 3v18M8 7h0M5 7h6v10H5zM16 3v18M13 6h6v9h-6z" /></TabGlyph>,
  },
  {
    id: "status", label: "Status line",
    glyph: <TabGlyph><path d="M4 7h16M4 12h11M4 17h7" /></TabGlyph>,
  },
  {
    id: "scales", label: "Scales and lines",
    // The axis corner, with its ticks.
    glyph: <TabGlyph><path d="M5 3v16h15M5 7h3M5 11h3M5 15h3M9 19v-2M14 19v-2M19 19v-2" /></TabGlyph>,
  },
  {
    id: "canvas", label: "Canvas",
    glyph: <TabGlyph><path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3" /></TabGlyph>,
  },
  {
    id: "trading", label: "Trading",
    glyph: <TabGlyph><path d="M4 20V10M10 20V4M16 20v-7M21 6l-5 5-3-3-4 4" /></TabGlyph>,
  },
  {
    id: "alerts", label: "Alerts",
    glyph: <TabGlyph><circle cx="12" cy="13" r="7" /><path d="M12 9v4l3 2M9 3h6" /></TabGlyph>,
  },
  {
    id: "events", label: "Events",
    glyph: <TabGlyph><path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" /></TabGlyph>,
  },
];

/**
 * Where each tab's value column starts, as a MINIMUM in pixels from x=591.
 *
 * Measured on the reference: 688 Symbol, 779 Scales, 766 Canvas, 798 Trading,
 * each of which is that tab's widest label plus 20. The grid column is
 * `minmax(this, max-content)`, so a label wider than the reference's own still
 * gets its space — the number is a floor that keeps the columns where the
 * reference puts them, not a fixed width that could clip a row.
 */
const VALUE_COLUMN: Record<Tab, number> = {
  symbol: 77,   // 688
  status: 97,   // not published; the widest label on the tab governs
  scales: 168,  // 779
  canvas: 155,  // 766
  trading: 187, // 798
  alerts: 0,
  events: 0,
};

const PLACEMENT_LABEL: Record<ScalePlacement, string> = {
  right: "Right", left: "Left", both: "Both", none: "No scale",
};

export function ChartSettingsModal(props: {
  open: boolean;
  onClose: () => void;
  /**
   * The pane's instrument.
   *
   * R6 S-1 deleted the INSTRUMENT block this used to print, so nothing in the
   * dialog reads it any more. The prop stays because the call site passes it
   * and the watermark row will want it back when the apply site lands.
   */
  symbol: string;
  interval: Resolution;
  /** Which presentation is active, so its own parameters can be filed under it. */
  chartType: ChartType;
  scale: PriceScaleState;
  onScale: (next: PriceScaleState) => void;
  /** Kept for the call site; the Reset button it drove is gone (R6 SC-2). */
  onReset: () => void;
  settings: ChartSettings;
  onSettings: (next: ChartSettings) => void;
  /**
   * Whether this pane's ticker has reported a bid and an ask.
   *
   * R6 SC-4: the Bid and ask row appears only for a feed that HAS quotes, the
   * same rule Body/Borders/Wick follow for presentations that have them. A
   * provider without quotes must not be shown a control that cannot move.
   */
  hasBidAsk?: boolean;
  /** The tab it opens on — `status` from the legend menu's `Settings…` (W2A-11). Symbol otherwise. */
  initialTab?: ChartSettingsTab;
}) {
  const {
    open, onClose, chartType, scale, onScale, settings, onSettings, hasBidAsk = false,
  } = props;
  const [tab, setTab] = useState<Tab>("symbol");
  /*
   * What the dialog was showing when it opened, so Cancel can put it back.
   *
   * The reference's footer is Cancel / Ok and both mean something: every
   * control applies live, and Cancel undoes the whole visit.
   */
  const [entry, setEntry] = useState<{ settings: ChartSettings; scale: PriceScaleState } | null>(null);
  /*
   * B-07: what THIS visit wrote, so Cancel undoes only that.
   *
   * Cancel used to write the entry scale back whether or not anything in the
   * dialog had touched it. The price scale is not the dialog's alone — the
   * chart reconciles `autoScale` with the library on every pointer move (an
   * axis drag turns it off, a double-click back on) — so a visit that changed
   * nothing on the Scales tab could still put back a stale `Auto scale` and
   * leave the axis frozen. The dialog writes the scale only when the user
   * changes a scale control, and Cancel restores only what it wrote.
   */
  const touched = useRef({ settings: false, scale: false });
  useEffect(() => {
    if (!open) { setEntry(null); return; }
    setTab(props.initialTab ?? "symbol");
    setEntry({ settings, scale });
    touched.current = { settings: false, scale: false };
    // Captured once per opening, deliberately: this must be the state on ENTRY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const writeSettings = (next: ChartSettings): void => {
    touched.current.settings = true;
    onSettings(next);
  };
  /**
   * A scale control's own write. `patch` names only the field the control
   * owns, applied to the scale AS IT IS NOW, so changing the mode can never
   * carry a stale `autoScale` along with it.
   */
  const writeScale = (patch: Partial<PriceScaleState>): void => {
    touched.current.scale = true;
    onScale({ ...scale, ...patch });
  };

  const set = <K extends keyof ChartSettings>(key: K, value: ChartSettings[K]): void =>
    writeSettings({ ...settings, [key]: value });
  /** Two keys that describe one control, written together. */
  const setMany = (patch: Partial<ChartSettings>): void => writeSettings({ ...settings, ...patch });

  /** The same condition `CandleChart`'s series-appearance effect applies. */
  /*
   * Point & figure joins the two types that draw their own bodies.
   *
   * Its columns are X and O glyphs drawn by a series primitive, and the
   * candlestick series underneath them is transparent ON PURPOSE. Offering
   * Body, Borders and Wick colour wells for it would be three controls that
   * change nothing — the same "a control that cannot act" the rest of this
   * dialog is careful to avoid.
   */
  const seriesColoursApply = renderKind(chartType) === "candles"
    && chartType !== "hollowCandles" && chartType !== "highLow"
    && chartType !== "pointAndFigure";

  /*
   * Thin bars reaches exactly one chart type — gated on the RENDER KIND rather
   * than on the type's name, so the day a second bar-drawn type exists it gets
   * the control without anyone remembering to add it here.
   */
  const thinBarsApplies = renderKind(chartType) === "bars";

  /*
   * R6b-24: ONE section per chart type, not two.
   *
   * The candle-appearance rows opened a section titled with the chart type,
   * and then each presentation's own parameters opened a SECOND section with
   * the same title — so the Symbol tab under Renko read `RENKO … RENKO`, and
   * the same under Point & figure, Line break and Range. The appearance rows
   * and the parameters are one section about one presentation; whichever block
   * comes first opens it.
   */
  const typeSectionOpen = seriesColoursApply || thinBarsApplies;

  /*
   * The two colour wells reach further than the three toggles beside them: on
   * a Line, Area, Baseline or Columns chart the volume histogram under the
   * price still takes `upColor` / `downColor`. Volume is not drawn under a
   * transform that invents its own bars — Renko, Kagi, Point & Figure, Line
   * break — and there the wells genuinely reach nothing.
   */
  const transform = chartTransform(chartType);
  const volumeTakesDirectionColours = transform === null || transform === "heikinAshi";
  const directionColoursApply = seriesColoursApply || volumeTakesDirectionColours;

  const cancel = (): void => {
    if (entry && touched.current.settings) onSettings(entry.settings);
    if (entry && touched.current.scale) onScale(entry.scale);
    onClose();
  };

  /*
   * Templates and the user's own default, which the reference puts in this
   * footer. R6 CH-4: ONE control on the left, a ghost `Template` button
   * opening a menu — not two native selects whose options were commands.
   */
  const ask = useAsk();
  const [templates, setTemplates] = useState<ChartSettingsTemplate[]>([]);
  useEffect(() => { if (open) setTemplates(loadChartSettingsTemplates()); }, [open]);

  const applyTemplate = (name: string): void => {
    const found = templates.find((t) => t.name === name);
    if (found) writeSettings(found.settings);
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

  /** The state of the reference's one `Symbol` price-label row, from two keys. */
  const priceLabelState = settings.lastValueLabel && settings.lastValueLine ? "valueLine"
    : settings.lastValueLabel ? "value"
      : settings.lastValueLine ? "line" : "hidden";

  const statusOff = !settings.showStatusLine;

  return (
    <Modal
      open={open}
      onClose={cancel}
      title="Chart settings"
      wide
      /*
       * A10: ONE size for every tab, and the tab panel scrolls.
       *
       * R6 CH-5 sized the dialog to the active tab's content, so it resized
       * and re-centred on every tab click — Symbol 750×545 at y=134, Scales
       * 750×773 at y=20, Trading 750×453 at y=180 — and the tab list jumped
       * out from under the pointer that had just clicked it. Premium's chart
       * settings is a fixed-size dialog with a scrolling body. 700px, or the
       * viewport less 40 where that is shorter; the rail and the footer stay
       * put and only the tab panel below scrolls (`scrollBody={false}`).
       */
      panelClassName="!h-[min(700px,calc(100vh-40px))] !max-h-[calc(100vh-40px)]"
      headerClassName="!h-[62px]"
      /*
       * Only the TAB PANEL scrolls. `scrollBody={false}` turns the body into a
       * flex column whose child owns the scrolling, so the rail and the footer
       * stay put while a long tab moves — which is what the reference does and
       * what this could not do while `Modal` scrolled rail and panel together.
       *
       * 30px of vertical padding rather than the default 16: it is what puts
       * the 280px rail in the 342px content band the reference measures.
       */
      /*
       * R6b-01: the rail's first tab sits at the dialog top + 76 in the
       * reference (a 62px header + 14), and the content column at + 84 (the
       * header + 22). `!py-[30px]` put both at + 92. The body's own top pad is
       * the rail's 14; the tab panel adds the remaining 8 for the content.
       */
      contentClassName="!pt-[14px] !pb-[30px]"
      /*
       * R6b-02: the reference's footer is 67px — 17 above and 16 below the
       * 34px buttons, plus the hairline. `Modal`'s own `py-3` is 12/12 → 59.
       */
      footerClassName="!py-4"
      scrollBody={false}
      footer={
        <div className="flex w-full items-center gap-2">
          <TemplateMenu
            templates={templates}
            onApply={applyTemplate}
            onSaveAs={() => void saveTemplate()}
            onDelete={(name) => void removeTemplate(name)}
            onApplyDefaults={() => {
              clearUserDefaultChartSettings();
              writeSettings(DEFAULT_CHART_SETTINGS);
            }}
            onSaveAsDefault={() => saveUserDefaultChartSettings(settings)}
          />
          <span className="flex-1" />
          {/*
            R6b-04: the reference's `Cancel` DOES carry an outline — pixel
            edges at x=945 and x=1017/1018 on the button's centre row in the
            symbol, events and alerts captures. R6 read it as a ghost and this
            file said so in a comment; the pixels say otherwise, so `default`
            (a 1px `--ts-control-border` on a transparent ground) is the
            variant and the comment in `ui.tsx` is corrected with it.
          */}
          <Button variant="default" onClick={cancel} className="w-[74px]">Cancel</Button>
          <Button variant="contrast" onClick={onClose} className="w-[44px] px-0">Ok</Button>
        </div>
      }
    >
      {/*
        ── On a phone the rail is a strip, not a column ─────────────────────
        A 206px rail beside a 366px dialog leaves a 100px content column, and
        every value in this dialog — the colour wells, Precision, Timezone —
        sat entirely outside it. The labels truncated mid-word and the only way
        to reach a control was to scroll a 100px sliver sideways. Above `sm`
        nothing changes.
      */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row sm:gap-5">
        <nav aria-label="Chart settings sections"
          className="flex w-full shrink-0 gap-1 overflow-x-auto pb-1
            sm:block sm:w-[206px] sm:overflow-x-visible sm:pb-0">
          {TABS.map((item) => (
            <button key={item.id} role="tab" aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              /*
                Selected is the neutral chip `.tvc-control[aria-selected]`
                already draws, plus the reference's weight change. It was 400
                either way, on a 42px pitch (`mb-0.5`) rather than 40.
              */
              /*
                R6b-05: the reference's rail is one step brighter on BOTH
                states — unselected 219, selected 255, against our 168/219. The
                unselected label is `--ts-ink` now; the selected one is the
                brightest ink the theme defines, which is the light half of the
                contrast pair the `Ok` button and the selected menu row already
                use (242 on dark, near-black on light). There is no 255 token
                in this product, and inventing one in `globals.css` would
                repaint more than a tab rail.
              */
              className={`tvc-control flex h-10 w-auto shrink-0 items-center gap-2 rounded-md px-3 text-left text-sm sm:w-full ${
                tab === item.id
                  ? "font-semibold text-[var(--ts-menu-selected-bg)]"
                  : "text-ink hover:text-[var(--ts-menu-selected-bg)]"
              }`}>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center">{item.glyph}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/*
          R6 CH-3: no `border-l`, no `pl-5`. The reference's content column
          starts 20px after the rail and is not fenced off from it.
        */}
        <section
          role="tabpanel"
          className="grid min-h-0 min-w-0 flex-1 auto-rows-min content-start grid-cols-1 gap-x-5
            overflow-y-auto pt-2 sm:[grid-template-columns:var(--ts-settings-cols)]"
          /*
            R6b-06: the Status tab's column is FIXED, not `max-content`.

            Every other tab's value column is a floor the widest label may
            push right; on Status the widest label is `Last day change values`
            (179px), which pushed the `Title` dropdown to x=790 against the
            reference's 714. TradingView lets that label overflow visibly into
            the empty second column instead — the labels are `whitespace-nowrap`
            already — so the column is the reference's 123px and nothing moves
            it.
          */
          /*
            Carried as a custom property rather than written to
            `gridTemplateColumns`, because an inline style cannot be undone by
            a breakpoint and the phone layout needs one column. The measured
            two-column grammar is unchanged wherever there is room for it.
          */
          style={{
            ["--ts-settings-cols" as string]: tab === "status"
              ? "103px 1fr"
              : `minmax(${VALUE_COLUMN[tab]}px, max-content) 1fr`,
          }}
        >
          {tab === "symbol" && (
            <>
              {seriesColoursApply && (
                <>
                  <Section>{chartTypeLabel(chartType)}</Section>
                  <CheckRow label="Color bars based on previous close"
                    checked={settings.colorBarsBasedOnPreviousClose}
                    onChange={(v) => set("colorBarsBasedOnPreviousClose", v)} />
                  {/*
                    R6 S-2: a colour pair per component, as the reference has.
                    Borders and wicks could be switched off but never coloured,
                    while the series has carried `borderUpColor` /
                    `wickUpColor` and their down halves the whole time.
                  */}
                  <CheckRow label="Body" checked={settings.candleBody}
                    onChange={(v) => set("candleBody", v)}>
                    <Swatch label="Body up colour" value={settings.upColor}
                      onChange={(v) => set("upColor", v)} />
                    <Swatch label="Body down colour" value={settings.downColor}
                      onChange={(v) => set("downColor", v)} />
                  </CheckRow>
                  <CheckRow label="Borders" checked={settings.candleBorders}
                    onChange={(v) => set("candleBorders", v)}>
                    <Swatch label="Border up colour" value={settings.borderUpColor}
                      onChange={(v) => set("borderUpColor", v)} />
                    <Swatch label="Border down colour" value={settings.borderDownColor}
                      onChange={(v) => set("borderDownColor", v)} />
                  </CheckRow>
                  <CheckRow label="Wick" checked={settings.candleWicks}
                    onChange={(v) => set("candleWicks", v)}>
                    <Swatch label="Wick up colour" value={settings.wickUpColor}
                      onChange={(v) => set("wickUpColor", v)} />
                    <Swatch label="Wick down colour" value={settings.wickDownColor}
                      onChange={(v) => set("wickDownColor", v)} />
                  </CheckRow>
                </>
              )}
              {thinBarsApplies && (
                <>
                  <Section>{chartTypeLabel(chartType)}</Section>
                  <CheckRow label="Thin bars" checked={settings.thinBars}
                    onChange={(v) => set("thinBars", v)} />
                </>
              )}
              {!seriesColoursApply && directionColoursApply && (
                <>
                  <Section>Volume</Section>
                  <FieldRow label="Up / down">
                    <Swatch label="Up colour" value={settings.upColor}
                      onChange={(v) => set("upColor", v)} />
                    <Swatch label="Down colour" value={settings.downColor}
                      onChange={(v) => set("downColor", v)} />
                  </FieldRow>
                </>
              )}

              {/*
                A chart type's own parameters, filed under the chart type — the
                rows where this product is honestly deeper than the reference.
                They keep every setting they had and take the new grammar:
                70×28 number fields with the unit as text after them.
              */}
              {chartType === "range" && (
                <>
                  {!typeSectionOpen && <Section>{chartTypeLabel(chartType)}</Section>}
                  <FieldRow label="Range size">
                    {/*
                      Typing a number is the decision. The field shows what is
                      actually being used either way, so "automatic" is never a
                      blank the reader has to interpret; what changes is whether
                      the size follows the instrument's price or stays put.
                    */}
                    {/*
                      `setMany`, not two `set` calls. `set` spreads the
                      `settings` PROP captured this render, so two of them in
                      one handler mean the second overwrites the first — the
                      user turned auto off and kept the old size, silently. This
                      is what `setMany` two lines below its definition exists
                      for, and it is documented there as "two keys that describe
                      one control, written together".
                    */}
                    <NumberField value={settings.rangeTicks} min={1} max={10000} unit="ticks"
                      onChange={(v) => setMany({ rangeTicks: v, rangeAuto: false })}
                      label="Range size in ticks" />
                  </FieldRow>
                  <CheckRow label="Size from price" checked={settings.rangeAuto}
                    onChange={(v) => set("rangeAuto", v)} />
                </>
              )}

              {chartType === "renko" && (
                <>
                  {!typeSectionOpen && <Section>{chartTypeLabel(chartType)}</Section>}
                  <FieldRow label="ATR length">
                    <NumberField value={settings.renkoAtrPeriod} min={2} max={200}
                      onChange={(v) => set("renkoAtrPeriod", v)} label="Renko ATR length" />
                  </FieldRow>
                </>
              )}

              {chartType === "lineBreak" && (
                <>
                  {!typeSectionOpen && <Section>{chartTypeLabel(chartType)}</Section>}
                  <FieldRow label="Number of lines">
                    <NumberField value={settings.lineBreakLines} min={2} max={10}
                      onChange={(v) => set("lineBreakLines", v)} label="Line break count" />
                  </FieldRow>
                </>
              )}

              {chartType === "kagi" && (
                <>
                  {!typeSectionOpen && <Section>{chartTypeLabel(chartType)}</Section>}
                  <FieldRow label="Reversal">
                    <NumberField value={settings.kagiReversalPercent} min={0.1} max={50} step={0.1}
                      unit="%" onChange={(v) => set("kagiReversalPercent", v)}
                      label="Kagi reversal percent" />
                  </FieldRow>
                </>
              )}

              {chartType === "pointAndFigure" && (
                <>
                  {!typeSectionOpen && <Section>{chartTypeLabel(chartType)}</Section>}
                  <FieldRow label="Box size">
                    <NumberField value={settings.pnfBoxPercent} min={0.1} max={50} step={0.1}
                      unit="%" onChange={(v) => set("pnfBoxPercent", v)}
                      label="Point and figure box size percent" />
                  </FieldRow>
                  <FieldRow label="Reversal">
                    <NumberField value={settings.pnfReversalBoxes} min={1} max={10} unit="boxes"
                      onChange={(v) => set("pnfReversalBoxes", v)}
                      label="Point and figure reversal in boxes" />
                  </FieldRow>
                </>
              )}

              {(chartType === "sessionVolumeProfile" || chartType === "tpo") && (
                <>
                  {!typeSectionOpen && <Section>{chartTypeLabel(chartType)}</Section>}
                  <FieldRow label="Rows">
                    <NumberField value={settings.profileRows} min={4} max={400}
                      onChange={(v) => set("profileRows", v)} label="Profile row count" />
                  </FieldRow>
                  <FieldRow label="Value area">
                    <NumberField value={settings.profileValueAreaPercent} min={30} max={100}
                      unit="%" onChange={(v) => set("profileValueAreaPercent", v)}
                      label="Value area percent" />
                  </FieldRow>
                  {chartType === "tpo" && (
                    <FieldRow label="Block duration">
                      <NumberField value={settings.tpoBlockMinutes} min={1} max={1440} unit="min"
                        onChange={(v) => set("tpoBlockMinutes", v)}
                        label="TPO block duration in minutes" />
                    </FieldRow>
                  )}
                  <FieldRow label="Volume placement">
                    <Dropdown value={settings.profileAllocation} label="How a bar's volume is placed"
                      width={180}
                      onChange={(v) => set("profileAllocation", v as "range" | "close")}
                      options={[
                        { value: "range", label: "Across the bar's range" },
                        { value: "close", label: "All at the close" },
                      ]} />
                  </FieldRow>
                  <FieldRow label="Rows show">
                    <Dropdown value={settings.profileSplit} label="Row split" width={180}
                      onChange={(v) => set("profileSplit", v as "total" | "upDown")}
                      options={[
                        { value: "total", label: "Total volume" },
                        { value: "upDown", label: "Up and down apart" },
                      ]} />
                  </FieldRow>
                  <FieldRow label="Placement">
                    <Dropdown value={settings.profileSide} label="Which side the profile is drawn from"
                      width={150}
                      onChange={(v) => set("profileSide", v as "left" | "right")}
                      options={[{ value: "right", label: "Right" }, { value: "left", label: "Left" }]} />
                  </FieldRow>
                  <FieldRow label="Width">
                    <NumberField value={settings.profileWidthPercent} min={5} max={90} unit="%"
                      onChange={(v) => set("profileWidthPercent", v)} label="Profile width percent" />
                  </FieldRow>
                  <CheckRow label="Point of control" checked={settings.profileShowPoc}
                    onChange={(v) => set("profileShowPoc", v)} />
                  <CheckRow label="Value area shading" checked={settings.profileShowValueArea}
                    onChange={(v) => set("profileShowValueArea", v)} />
                </>
              )}

              <Section>Data modification</Section>
              <FieldRow label="Precision">
                <Dropdown value={String(settings.precision)} label="Precision" width={150}
                  onChange={(v) => set("precision", (v === "auto" ? "auto" : Number(v)) as PricePrecision)}
                  options={PRECISIONS.map((p) => ({ value: String(p), label: precisionLabel(p) }))} />
              </FieldRow>
              <FieldRow label="Timezone">
                <Dropdown value={settings.timeZone} label="Timezone" width={150}
                  onChange={(v) => set("timeZone", v as ChartSettings["timeZone"])}
                  options={CHART_TIME_ZONES.map((zone) => ({ value: zone.value, label: zone.label }))} />
              </FieldRow>
            </>
          )}

          {tab === "status" && (
            <>
              <Section>Instrument</Section>
              {/*
                R6 SL-5: the master switch keeps its reach and loses its own
                section title — it is the first row, and everything below it is
                disabled while it is off, which is the reference's dependent-row
                idiom and explains the switch without a sentence.
              */}
              <CheckRow label="Status line" checked={settings.showStatusLine}
                onChange={(v) => set("showStatusLine", v)} />
              {/*
                R3b-24: the reference's first Instrument row is `Logo`, and the
                product already draws an asset disc in the watchlist and the
                symbol dialog. The row is the reference's; the artwork is ours
                (OV-K), because this installation ships no third-party marks.
              */}
              <CheckRow label="Logo" checked={settings.statusLogo} disabled={statusOff}
                onChange={(v) => set("statusLogo", v)} />
              <CheckRow label="Title" checked={settings.statusSymbol} disabled={statusOff}
                onChange={(v) => set("statusSymbol", v)}>
                <Dropdown value={settings.statusTitle} label="Title form" width={150}
                  disabled={statusOff || !settings.statusSymbol}
                  onChange={(v) => set("statusTitle", statusTitleForm(v))}
                  options={[
                    /*
                      R3b-25: the reference's three forms, on the two stored
                      values plus one new one — see `StatusTitleForm`.

                      `Name` is `displayName`, the descriptive name where this
                      installation knows one and the venue's listing code where
                      it does not; `Ticker` is `displayTicker` (`BTCUSDT`), the
                      form the toolbar pill and every watchlist row use;
                      `Description` is the long description, which this build
                      resolves to the same descriptive name until a provider
                      hands us a real one. `Full symbol` is GONE: it rendered
                      `BINANCE:BTC/USDT · SPOT`, which is not one of the
                      reference's forms and is exactly what §5 keeps out of
                      primary copy. None of the three can answer with a
                      canonical `instrument:v1:…` id.
                    */
                    { value: "ticker", label: "Name" },
                    { value: "symbol", label: "Ticker" },
                    { value: "description", label: "Description" },
                  ]} />
              </CheckRow>
              {/*
                R3b-24: and the market-status dot, where the reference puts its
                row — under Title. It draws nothing at all for an instrument
                whose session calendar this build does not hold, which is why
                the row says `Open market status` and not `Market open`.
              */}
              <CheckRow label="Open market status" checked={settings.statusMarketStatus}
                disabled={statusOff} onChange={(v) => set("statusMarketStatus", v)} />
              <CheckRow label="Chart values" checked={settings.statusOhlc} disabled={statusOff}
                onChange={(v) => set("statusOhlc", v)} />
              <CheckRow label="Bar change values" checked={settings.statusBarChange} disabled={statusOff}
                onChange={(v) => set("statusBarChange", v)} />
              <CheckRow label="Volume" checked={settings.statusVolume} disabled={statusOff}
                onChange={(v) => set("statusVolume", v)} />
              <CheckRow label="Last day change values" checked={settings.statusDayChange}
                disabled={statusOff} onChange={(v) => set("statusDayChange", v)} />

              <Section>Indicators</Section>
              {/*
                R6 SL-1: the legend already draws a study's title, its inputs
                and its values as separate spans; one switch hid all three.
              */}
              <CheckRow label="Titles" checked={settings.statusIndicatorTitles}
                onChange={(v) => set("statusIndicatorTitles", v)} />
              <CheckRow label="Inputs" checked={settings.statusIndicatorInputs} indent
                disabled={!settings.statusIndicatorTitles}
                onChange={(v) => set("statusIndicatorInputs", v)} />
              <CheckRow label="Values" checked={settings.statusIndicatorValues}
                onChange={(v) => set("statusIndicatorValues", v)} />
              {/*
                R3b-25: the reference's `Background` row and its opacity
                slider, which is what makes a legend readable over a dense
                candle. It is a plate behind the TEXT runs, never a box around
                the legend — the box is what R3-10 removed.
              */}
              <CheckRow label="Background" checked={settings.statusLegendBackground}
                onChange={(v) => set("statusLegendBackground", v)}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={settings.statusLegendBackgroundOpacity}
                  disabled={!settings.statusLegendBackground}
                  aria-label="Background opacity"
                  onChange={(e) => set("statusLegendBackgroundOpacity", Number(e.target.value))}
                  className="h-1 w-[120px] cursor-pointer appearance-none rounded bg-surface-3
                    accent-[var(--ts-accent)] disabled:cursor-not-allowed disabled:opacity-40"
                />
                <span className="w-9 text-right text-xs tabular text-ink-muted">
                  {settings.statusLegendBackgroundOpacity}%
                </span>
              </CheckRow>
            </>
          )}

          {tab === "scales" && (
            <>
              <Section>Price scale</Section>
              <FieldRow label="Scales placement">
                <Dropdown value={settings.scalePlacement} label="Scales placement" width={150}
                  onChange={(v) => set("scalePlacement", v as ScalePlacement)}
                  options={PLACEMENTS.map((p) => ({ value: p, label: PLACEMENT_LABEL[p] }))} />
              </FieldRow>
              <FieldRow label="Scale mode">
                <Dropdown value={scale.mode} label="Scale mode" width={150}
                  onChange={(v) => writeScale({ mode: v as PriceScaleMode })}
                  options={PRICE_SCALE_MODES.map((m) => ({ value: m.value, label: priceScaleModeLabel(m.value) }))} />
              </FieldRow>
              <CheckRow label="Auto scale" checked={scale.autoScale}
                onChange={(v) => writeScale({ autoScale: v })} />
              <CheckRow label="Invert scale" checked={scale.invert === true}
                onChange={(v) => writeScale({ invert: v })} />

              <Section>Price labels &amp; lines</Section>
              <CheckRow label="No overlapping labels" checked={settings.noOverlappingLabels}
                onChange={(v) => set("noOverlappingLabels", v)} />
              <CheckRow label="Plus button" checked={settings.plusButton}
                onChange={(v) => set("plusButton", v)} />
              <CheckRow label="Countdown to bar close" checked={settings.countdownToBarClose}
                onChange={(v) => set("countdownToBarClose", v)} />
              {/*
                R6 SC-1: one row, two controls. The same four settings were two
                rows and five controls, and the three appearance controls
                mounted and unmounted as the checkbox was toggled, so the row
                jumped. The line-style button is DISABLED when the chosen state
                has no line, never removed.
              */}
              <FieldRow label="Symbol">
                <Dropdown value={priceLabelState} label="Symbol price label and line" width={180}
                  onChange={(v) => setMany({
                    lastValueLabel: v === "valueLine" || v === "value",
                    lastValueLine: v === "valueLine" || v === "line",
                  })}
                  options={[
                    { value: "valueLine", label: "Value, Line" },
                    { value: "value", label: "Value" },
                    { value: "line", label: "Line" },
                    { value: "hidden", label: "Hidden" },
                  ]} />
                <LineStyleButton
                  label="Last value line appearance"
                  disabled={!settings.lastValueLine}
                  color={settings.lastValueLineColor}
                  width={settings.lastValueLineWidth}
                  style={settings.lastValueLineStyle}
                  onChange={(next) => setMany({
                    lastValueLineColor: next.color,
                    lastValueLineWidth: next.width,
                    lastValueLineStyle: next.style,
                  })} />
              </FieldRow>
              <FieldRow label="Indicators">
                {/* R6b-15: 180, as the reference's `Indicators and financials`. */}
                <Dropdown value={settings.indicatorLastValue ? "value" : "hidden"}
                  label="Indicator last value" width={180}
                  onChange={(v) => set("indicatorLastValue", v === "value")}
                  options={[{ value: "value", label: "Value" }, { value: "hidden", label: "Hidden" }]} />
              </FieldRow>
              <FieldRow label="Previous day close">
                <Dropdown value={settings.previousDayClose} label="Previous day close" width={150}
                  onChange={(v) => set("previousDayClose", v as ChartSettings["previousDayClose"])}
                  options={[
                    { value: "hidden", label: "Hidden" },
                    { value: "value", label: "Value" },
                    { value: "line", label: "Line" },
                  ]} />
                <Swatch label="Previous day close colour" value={settings.previousDayCloseColor}
                  onChange={(v) => set("previousDayCloseColor", v)} />
              </FieldRow>
              <FieldRow label="High and low">
                <Dropdown value={settings.highLow} label="High and low" width={150}
                  onChange={(v) => set("highLow", v as ChartSettings["highLow"])}
                  options={[
                    { value: "hidden", label: "Hidden" },
                    { value: "value", label: "Value" },
                    { value: "line", label: "Line" },
                  ]} />
                <Swatch label="High and low colour" value={settings.highLowColor}
                  onChange={(v) => set("highLowColor", v)} />
              </FieldRow>
              {hasBidAsk && (
                <FieldRow label="Bid and ask">
                  <Dropdown value={settings.bidAskLines} label="Bid and ask lines" width={150}
                    onChange={(v) => set("bidAskLines", v === "line" ? "line" : "hidden")}
                    options={[{ value: "hidden", label: "Hidden" }, { value: "line", label: "Line" }]} />
                  <Swatch label="Bid colour" value={settings.bidColor}
                    onChange={(v) => set("bidColor", v)} />
                  <Swatch label="Ask colour" value={settings.askColor}
                    onChange={(v) => set("askColor", v)} />
                </FieldRow>
              )}

              <Section>Time scale</Section>
              <CheckRow label="Day of week on labels" checked={settings.dayOfWeekOnLabels}
                onChange={(v) => set("dayOfWeekOnLabels", v)} />
              {/*
                R6 SC-5(a): the options were the LIBRARY's pattern tokens —
                `dd MMM yy` — printed at a trader. Each option is now the date
                the axis will draw, rendered through the same substitution.
              */}
              <FieldRow label="Date format">
                <Dropdown value={settings.dateFormat} label="Date format" width={150}
                  onChange={(v) => set("dateFormat", v as DateFormatName)}
                  options={DATE_FORMATS.map((f) => ({ value: f, label: dateFormatExample(f) }))} />
              </FieldRow>
              <FieldRow label="Time hours format">
                <Dropdown value={settings.timeFormat24h ? "24" : "12"} label="Time hours format"
                  width={100}
                  onChange={(v) => set("timeFormat24h", v === "24")}
                  options={[{ value: "24", label: "24-hours" }, { value: "12", label: "12-hours" }]} />
              </FieldRow>
            </>
          )}

          {tab === "canvas" && (
            <>
              <Section>Chart basic styles</Section>
              <FieldRow label="Background">
                <Dropdown value={settings.backgroundGradient ? "gradient" : "solid"}
                  label="Background" width={150}
                  onChange={(v) => set("backgroundGradient", v === "gradient")}
                  options={[{ value: "solid", label: "Solid" }, { value: "gradient", label: "Gradient" }]} />
                <Swatch label="Background colour" allowTheme value={settings.backgroundColor}
                  effectiveColor="var(--ts-surface)"
                  onChange={(v) => set("backgroundColor", v)} />
                {/*
                  R6b-18: `Gradient` shows a SECOND well, as the reference
                  does. Both wells on `Theme` is still a visible wash — see
                  `resolveBackgroundGradient`, which derives the pair from the
                  surface and the ink rather than laying 6% of accent blue over
                  transparent, which measured three points of luminance.
                */}
                {settings.backgroundGradient && (
                  <Swatch label="Background second colour" allowTheme
                    value={settings.backgroundColor2}
                    onChange={(v) => set("backgroundColor2", v)} />
                )}
              </FieldRow>
              {/*
                R6 C-1: each direction carries its own appearance, as the
                reference does and as the engine has always accepted. The
                `Grid appearance` row and its separate `Theme colour` button are
                gone — "Theme" is the first cell of the palette now.
              */}
              <CheckRow label="Vertical grid lines" checked={settings.gridVertical}
                onChange={(v) => set("gridVertical", v)}>
                <LineStyleButton label="Vertical grid line appearance" allowTheme
                  effectiveColor="var(--ts-chart-grid)"
                  disabled={!settings.gridVertical}
                  color={settings.gridVertColor} width={1} style={settings.gridVertStyle}
                  onChange={(next) => setMany({
                    gridVertColor: next.color, gridVertStyle: next.style,
                  })} />
              </CheckRow>
              <CheckRow label="Horizontal grid lines" checked={settings.gridHorizontal}
                onChange={(v) => set("gridHorizontal", v)}>
                <LineStyleButton label="Horizontal grid line appearance" allowTheme
                  effectiveColor="var(--ts-chart-grid)"
                  disabled={!settings.gridHorizontal}
                  color={settings.gridHorzColor} width={1} style={settings.gridHorzStyle}
                  onChange={(next) => setMany({
                    gridHorzColor: next.color, gridHorzStyle: next.style,
                  })} />
              </CheckRow>
              <CheckRow label="Crosshair" checked={settings.showCrosshair}
                onChange={(v) => set("showCrosshair", v)}>
                <LineStyleButton label="Crosshair appearance" allowTheme
                  effectiveColor="var(--ts-chart-crosshair)"
                  disabled={!settings.showCrosshair}
                  color={settings.crosshairColor}
                  width={settings.crosshairWidth}
                  style={settings.crosshairStyle}
                  onChange={(next) => setMany({
                    crosshairColor: next.color,
                    crosshairWidth: next.width,
                    crosshairStyle: next.style,
                  })} />
              </CheckRow>
              <FieldRow label="Pane separators">
                <Swatch label="Pane separator colour" allowTheme value={settings.paneSeparatorColor}
                  effectiveColor="var(--ts-line)"
                  onChange={(v) => set("paneSeparatorColor", v)} />
              </FieldRow>
              {/*
                R6 C-2: a mode, not a switch — hidden, the instrument's name, or
                only while the pane is replaying, which is what makes a replay
                screenshot say that it is one.
              */}
              <FieldRow label="Watermark">
                <Dropdown value={settings.watermarkMode} label="Watermark" width={180}
                  onChange={(v) => setMany({
                    watermarkMode: v as WatermarkMode,
                    // Kept in step with the boolean the apply site still reads;
                    // the two collapse into one key when it lands.
                    watermark: v === "symbol",
                  })}
                  options={[
                    { value: "hidden", label: "Hidden" },
                    { value: "symbol", label: "Symbol" },
                    { value: "replay", label: "Replay mode" },
                  ]} />
                <Swatch label="Watermark colour" allowTheme value={settings.watermarkColor}
                  effectiveColor="var(--ts-chart-muted)"
                  onChange={(v) => set("watermarkColor", v)} />
              </FieldRow>

              <Section>Scales</Section>
              <FieldRow label="Text">
                <Swatch label="Scale text colour" allowTheme value={settings.scaleTextColor}
                  effectiveColor="var(--ts-ink-muted)"
                  onChange={(v) => set("scaleTextColor", v)} />
                <Dropdown value={String(settings.scaleFontSize)} label="Scale text size" width={100}
                  onChange={(v) => set("scaleFontSize", Number(v))}
                  options={[10, 11, 12, 13, 14, 16].map((n) => ({ value: String(n), label: String(n) }))} />
              </FieldRow>
              <FieldRow label="Lines">
                <Swatch label="Scale line colour" allowTheme value={settings.scaleLineColor}
                  effectiveColor="var(--ts-line-strong)"
                  onChange={(v) => set("scaleLineColor", v)} />
              </FieldRow>

              <Section>Buttons</Section>
              <FieldRow label="Navigation">
                <Dropdown value={settings.scaleButtons} label="Navigation buttons" width={180}
                  onChange={(v) => set("scaleButtons", v as ChartSettings["scaleButtons"])}
                  options={[
                    { value: "always", label: "Always visible" },
                    { value: "hover", label: "Visible on mouse over" },
                    { value: "hidden", label: "Always hidden" },
                  ]} />
              </FieldRow>
              <FieldRow label="Pane">
                <Dropdown value={settings.paneButtons} label="Pane buttons" width={180}
                  onChange={(v) => set("paneButtons", v as ChartSettings["paneButtons"])}
                  options={[
                    { value: "always", label: "Always visible" },
                    { value: "hover", label: "Visible on mouse over" },
                    { value: "hidden", label: "Always hidden" },
                  ]} />
              </FieldRow>

              <Section>Margins</Section>
              <FieldRow label="Top">
                <NumberField value={settings.marginTopPct} min={0} max={50} unit="%"
                  onChange={(v) => set("marginTopPct", v)} label="Top margin, percent" />
              </FieldRow>
              <FieldRow label="Bottom">
                <NumberField value={settings.marginBottomPct} min={0} max={50} unit="%"
                  onChange={(v) => set("marginBottomPct", v)} label="Bottom margin, percent" />
              </FieldRow>
              {/*
                R6 SC-5(c): `Bars to the right` is a MARGIN, and the reference
                files it here with Top and Bottom rather than on the scales tab.
              */}
              <FieldRow label="Right">
                <NumberField value={settings.rightOffsetBars} min={0} max={200} unit="bars"
                  onChange={(v) => set("rightOffsetBars", v)}
                  label="Empty bars kept right of the newest bar" />
              </FieldRow>
            </>
          )}

          {tab === "trading" && (
            <>
              <Section>Appearance</Section>
              <CheckRow label="Positions and orders" checked={settings.showTrading}
                onChange={(v) => set("showTrading", v)}
                note="Orders are placed from the ticket; the chart shows them." />
              <CheckRow label="Profit and loss value" checked={settings.showPnlValue}
                onChange={(v) => set("showPnlValue", v)} />
              {/*
                R6 T-1: the arrows and their `BUY 77,600` text are a different
                thing on the chart from the position and order LINES, and were
                gated together under one switch.
              */}
              <CheckRow label="Execution marks" checked={settings.showExecutionMarks}
                onChange={(v) => set("showExecutionMarks", v)} />
              <CheckRow label="Execution labels" checked={settings.showExecutionLabels} indent
                disabled={!settings.showExecutionMarks}
                onChange={(v) => set("showExecutionLabels", v)}
                note={`Labels hide when more than ${TRADE_LABEL_LIMIT} marks are in view.`} />
            </>
          )}

          {tab === "alerts" && (
            <>
              <Section>Chart line visibility</Section>
              {/*
                R6 A-1: the pane already reads this instrument's alerts and
                already draws price lines; the LEVELS an alert is armed at were
                the one thing it did not draw. Colour comes from `alertColor`
                per alert rather than from one swatch, which is more truthful
                than the reference's single colour.
              */}
              <CheckRow label="Alert lines" checked={settings.showAlertLines}
                onChange={(v) => set("showAlertLines", v)} />
              {/*
                R6b-22: the reference does NOT indent this row — its checkbox
                is at the content edge, x=591, with `Alert lines`. It stays
                disabled while alert lines are off, because with no lines drawn
                there is nothing for it to filter.
              */}
              <CheckRow label="Only active alerts" checked={settings.onlyActiveAlerts}
                disabled={!settings.showAlertLines}
                onChange={(v) => set("onlyActiveAlerts", v)} />
              <CheckRow label="Fired-alert markers" checked={settings.showAlerts}
                onChange={(v) => set("showAlerts", v)} />
            </>
          )}

          {tab === "events" && (
            <>
              <Section>Events</Section>
              {/*
                Alerts have their own tab, so "alert" in this label was wrong:
                `showEvents` gates the markers whose category is NOT an alert.
              */}
              <CheckRow label="Strategy and script events" checked={settings.showEvents}
                onChange={(v) => set("showEvents", v)} />
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}

/* ── the dialog's grammar, once ─────────────────────────────────────────── */

/** An 11px uppercase title in a 32px row, across both columns. */
function Section({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{ gridColumn: "1 / -1" }}
      className="flex h-8 items-end pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint"
    >
      {children}
    </h3>
  );
}

/** The 12px muted line under a row — the dialog's only prose form. */
function Note({ children, indent }: { children: React.ReactNode; indent: boolean }) {
  return (
    <div
      /*
        R6b-07: the note starts at the CHECKBOX's edge, not at the label's.
        Measured on the reference: x=591 under a plain row (the content edge
        itself) and x=617 under an indented one. 28/54 put it at 619/645.
      */
      style={{ gridColumn: "1 / -1", paddingLeft: indent ? 26 : 0 }}
      className="-mt-3 pb-3 text-xs leading-[18px] text-ink-faint"
    >
      {children}
    </div>
  );
}

/**
 * `[checkbox] label` at the content edge, with any trailing controls in the
 * value column — the reference's boolean row, and the one this dialog did not
 * have. Both cells are always emitted: a grid places children in order, so a
 * row that skipped its second cell would pull the NEXT row's label into
 * column two.
 */
function CheckRow({ label, checked, onChange, children, disabled = false, indent = false, note }: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  children?: React.ReactNode;
  disabled?: boolean;
  /** A dependent row: indented 26px under its parent. */
  indent?: boolean;
  note?: string;
}) {
  return (
    <>
      <label
        style={{ paddingLeft: indent ? 26 : 0 }}
        className={`flex min-h-[50px] cursor-pointer items-center gap-2.5 text-sm ${
          disabled ? "cursor-not-allowed text-ink-faint" : "text-ink"
        }`}
      >
        <Checkbox checked={checked} onChange={onChange} label={label} disabled={disabled} />
        <span className="whitespace-nowrap">{label}</span>
      </label>
      <div className="flex min-h-[50px] items-center gap-2">{children}</div>
      {note !== undefined && <Note indent={indent}>{note}</Note>}
    </>
  );
}

/** A label in column one, controls in column two. */
function FieldRow({ label, children, indent = false, note }: {
  label: string;
  children: React.ReactNode;
  indent?: boolean;
  note?: string;
}) {
  return (
    <>
      <span
        style={{ paddingLeft: indent ? 26 : 0 }}
        className="flex min-h-[50px] items-center whitespace-nowrap text-sm text-ink"
      >
        {label}
      </span>
      <div className="flex min-h-[50px] items-center gap-2">{children}</div>
      {note !== undefined && <Note indent={indent}>{note}</Note>}
    </>
  );
}

/**
 * The footer's one control, on the left, as the reference has it.
 *
 * It was two native `<select>`s — `Template` and `Defaults` — whose options
 * were commands (`__save`, `__delete:<name>`) and whose value was always `""`:
 * a menu wearing a field's clothes, twice. E1-06's rule is kept: dismissing
 * this menu does nothing, and the destructive item is a named row rather than
 * whatever the escape key resolves to.
 */
function TemplateMenu({
  templates, onApply, onSaveAs, onApplyDefaults, onSaveAsDefault, onDelete,
}: {
  templates: readonly ChartSettingsTemplate[];
  onApply: (name: string) => void;
  onSaveAs: () => void;
  onApplyDefaults: () => void;
  onSaveAsDefault: () => void;
  onDelete: (name: string) => void;
}) {
  /*
   * The registry, not a private boolean: only one popover in the product is
   * open at a time (`lib/popoverGroup`), which is what stops this menu and a
   * swatch popover from being open together in the same footer.
   */
  const [open, setOpen] = useExclusivePopover("chart-settings-template");
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // The dialog behind must not close with it.
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, setOpen]);

  useEffect(() => { if (open) menuItems(menuRef.current)[0]?.focus(); }, [open]);

  const row = "tvc-menu-row px-2.5 text-left text-sm text-ink";
  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Chart settings template"
        onClick={() => setOpen(!open)}
        /*
          R6b-03: the reference's `Template ▾` carries a 1px outline — pixel
          edges at x=365 and x=463/464 on the button's centre row in all three
          captures. It was a borderless ghost.
        */
        className="tvc-control flex h-[34px] w-[100px] items-center justify-between rounded-md border border-control-border px-3 text-sm text-ink-muted hover:text-ink"
      >
        Template
        <CaretGlyph size={10} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Chart settings template"
          onKeyDown={(e) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              moveMenuFocus(menuItems(menuRef.current), document.activeElement, e.key);
            }
          }}
          className="tvc-menu tvc-menu--compact absolute bottom-[calc(100%+6px)] left-0 z-50 w-[240px]"
        >
          <button type="button" role="menuitem" className={row}
            onClick={() => { setOpen(false); onSaveAs(); }}>
            Save as…
          </button>
          <button type="button" role="menuitem" className={row}
            onClick={() => { setOpen(false); onApplyDefaults(); }}>
            Apply defaults
          </button>
          <button type="button" role="menuitem" className={row}
            onClick={() => { setOpen(false); onSaveAsDefault(); }}>
            Save as my default
          </button>
          {templates.length > 0 && <div className="tvc-menu-sep" />}
          {templates.map((t) => (
            <div key={t.name} className={`${row} justify-between gap-2`}>
              <button type="button" role="menuitem" className="min-w-0 flex-1 truncate text-left"
                onClick={() => { setOpen(false); onApply(t.name); }}>
                {t.name}
              </button>
              <button type="button" aria-label={`Delete ${t.name}`}
                className="tvc-control flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
                onClick={() => { setOpen(false); onDelete(t.name); }}>
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                  strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                  <path d="M2.5 3.5h9M5.5 3.5V2h3v1.5M3.8 3.5l.6 8h5.2l.6-8M6 6v4M8 6v4" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
