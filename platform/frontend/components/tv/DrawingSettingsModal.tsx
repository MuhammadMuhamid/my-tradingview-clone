"use client";
/**
 * A drawing's settings, in the product's own settings grammar.
 *
 * ── What R6b measured, and what this file is now ───────────────────────────
 *
 * The reference's drawing dialog and its chart-settings dialog are the SAME
 * dialog with different rows: 20px inset, a 50px row pitch, text tabs in a
 * 32px row, `Template ▾` / `Cancel` / `Ok` in the footer, and every control
 * applying live. This one was 750px wide with a 131px left nav of chips, nine
 * round 28px colour dots, a native `<select>` for the width, a 13px native
 * checkbox for `Dashed`, a Text tab greyed out for a trendline the reference
 * gives a Text tab to, epoch SECONDS and a 14-decimal float in Coordinates,
 * thirteen timeframe checkboxes under a sentence in Visibility, and a
 * `Cancel` / `Apply`(accent) footer behind which NOTHING reached the chart
 * until Apply was pressed.
 *
 * So it is rebuilt on `components/ui`'s primitives — the same `Checkbox`,
 * `Dropdown`, `Swatch`, `LineStyleButton` and `NumberField` the chart-settings
 * dialog uses. Contract §7: one product, one set of controls.
 *
 * ── Live apply, and what Cancel therefore means ────────────────────────────
 *
 * Every control writes through `onChange` as it is touched, and `Cancel`
 * restores the drawing captured when the dialog opened. That is the reference's
 * behaviour and it is the only one that lets a user SEE what a colour does
 * before committing to it — the previous `Apply` button meant choosing a colour
 * blind.
 *
 * ── Honest omissions, stated rather than drawn greyed out ──────────────────
 *
 * Visibility has no `Ticks` or `Ranges` row, and no `Weeks` or `Months`: this
 * product's resolutions run `1s` to `1d` (`lib/resolution` refuses the calendar
 * objects on purpose), and there is no tick or range resolution to be visible
 * on. A row that could never be true is not drawn.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import {
  deleteDrawingTemplate, FILLABLE_TOOLS, loadDrawingTemplates, saveDrawingTemplate,
  TOOL_POINTS, type Drawing, type DrawingExtend, type DrawingStyle, type DrawingTemplate,
} from "@/lib/drawings";
import {
  isResolution, NATIVE_RESOLUTIONS, parseResolution, resolutionMs, type Resolution,
} from "@/lib/resolution";
import {
  Button, CaretGlyph, Checkbox, Dropdown, LineStyleButton, NumberField, Swatch, TextInput,
} from "@/components/ui";
import { useAsk } from "@/components/AskDialog";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";
import { useExclusivePopover } from "@/lib/useExclusivePopover";

type Tab = "style" | "text" | "coordinates" | "visibility";

const TABS: { id: Tab; label: string }[] = [
  { id: "style", label: "Style" },
  { id: "text", label: "Text" },
  { id: "coordinates", label: "Coordinates" },
  { id: "visibility", label: "Visibility" },
];

/** Tools whose style carries a volume-profile block. */
const PROFILE_TOOLS = new Set(["vprange", "avprofile"]);

/**
 * The name a drawing opens with, when it has not been given one.
 *
 * The rail's own labels live in `DrawingToolbar` beside its 87 cells and are
 * not exported; rather than import a component from a dialog, the few tools
 * whose id is not its own name are spelled here and everything else is its id
 * with the camel case opened up — `fibRetracement` → `Fib retracement`.
 */
const TOOL_TITLES: Readonly<Record<string, string>> = {
  trend: "Trendline",
  hline: "Horizontal line",
  vline: "Vertical line",
  ray: "Ray",
  arrow: "Arrow",
  rect: "Rectangle",
  ellipse: "Ellipse",
  text: "Text",
  vprange: "Fixed range volume profile",
  avprofile: "Anchored volume profile",
};

function toolTitle(tool: string): string {
  const known = TOOL_TITLES[tool];
  if (known) return known;
  const opened = tool.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return opened.charAt(0).toUpperCase() + opened.slice(1);
}

/**
 * The units this product's resolutions are written in.
 *
 * `lib/resolution` publishes `1s … 1d` and refuses weeks, months and quarters
 * because they are calendar objects rather than multiples of anything. The
 * reference's `Weeks`, `Months`, `Ticks` and `Ranges` rows are therefore
 * omitted rather than drawn dead — see the header.
 */
const VISIBILITY_UNITS: { unit: "s" | "m" | "h" | "d"; label: string; max: number }[] = [
  { unit: "s", label: "Seconds", max: 59 },
  { unit: "m", label: "Minutes", max: 1439 },
  { unit: "h", label: "Hours", max: 23 },
  { unit: "d", label: "Days", max: 1 },
];

export interface VisibilityRange { on: boolean; from: number; to: number }
export type VisibilityRanges = Record<"s" | "m" | "h" | "d", VisibilityRange>;

/** Every native resolution written in one unit, as its count. */
function countsIn(unit: "s" | "m" | "h" | "d"): number[] {
  return NATIVE_RESOLUTIONS
    .map((id) => parseResolution(id))
    .filter((plan): plan is NonNullable<typeof plan> => plan !== null && plan.unit === unit)
    .map((plan) => plan.count)
    .sort((a, b) => a - b);
}

/** A stored allow-list, read back as the reference's per-unit from/to rows. */
export function visibilityRanges(visibleOn: readonly Resolution[] | undefined): VisibilityRanges {
  const empty = (unit: "s" | "m" | "h" | "d"): VisibilityRange => {
    const counts = countsIn(unit);
    return { on: false, from: counts[0] ?? 1, to: counts[counts.length - 1] ?? 1 };
  };
  const ranges: VisibilityRanges = { s: empty("s"), m: empty("m"), h: empty("h"), d: empty("d") };
  /*
   * An absent or empty allow-list means EVERY timeframe, which is what the
   * drawing model has always meant by it — so every row opens ticked at its
   * full span rather than the dialog claiming the drawing is hidden
   * everywhere.
   */
  if (!visibleOn || visibleOn.length === 0) {
    for (const { unit } of VISIBILITY_UNITS) ranges[unit].on = true;
    return ranges;
  }
  for (const resolution of visibleOn) {
    const plan = parseResolution(resolution);
    if (!plan) continue;
    const row = ranges[plan.unit];
    if (!row.on) { row.on = true; row.from = plan.count; row.to = plan.count; continue; }
    row.from = Math.min(row.from, plan.count);
    row.to = Math.max(row.to, plan.count);
  }
  return ranges;
}

/**
 * The rows, written back as the allow-list the canvas already honours.
 *
 * Every unit on and spanning its whole range is "everywhere", which the model
 * spells as `undefined` — so a user who ticks every box does not end up with a
 * frozen list that a future resolution would fall outside of.
 */
export function resolutionsForRanges(ranges: VisibilityRanges): Resolution[] | undefined {
  const picked: Resolution[] = [];
  let complete = true;
  for (const { unit } of VISIBILITY_UNITS) {
    const row = ranges[unit];
    const counts = countsIn(unit);
    const kept = row.on
      ? counts.filter((count) => count >= row.from && count <= row.to)
      : [];
    if (kept.length !== counts.length) complete = false;
    for (const count of kept) picked.push(`${count}${unit}`);
  }
  if (complete) return undefined;
  return picked;
}

/** Shared advanced drawing editor, on the reference's four tabs. */
export function DrawingSettingsModal({
  open, drawing, onClose, onChange, interval, lastBarTime,
}: {
  open: boolean;
  drawing: Drawing | null;
  onClose: () => void;
  onChange: (drawing: Drawing) => void;
  interval?: Resolution;
  /**
   * The newest bar's open time in seconds, so the Coordinates tab can write a
   * bar INDEX rather than an epoch.
   *
   * Optional: without it the newest bar is taken to be the current one, which
   * is true for every live chart and off by the replay offset under replay —
   * stated here rather than silently wrong, and the price half is exact either
   * way.
   */
  lastBarTime?: number;
}) {
  const [tab, setTab] = useState<Tab>("style");
  /** What the drawing was when the dialog opened, so Cancel can put it back. */
  const entry = useRef<Drawing | null>(null);
  useEffect(() => {
    if (!open || !drawing) { entry.current = null; return; }
    entry.current = drawing;
    setTab("style");
    // Captured once per opening, deliberately: this must be the state on ENTRY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ask = useAsk();
  const [templates, setTemplates] = useState<DrawingTemplate[]>([]);
  useEffect(() => { if (open) setTemplates(loadDrawingTemplates()); }, [open]);

  const cancel = useCallback((): void => {
    if (entry.current) onChange(entry.current);
    onClose();
  }, [onChange, onClose]);

  if (!open || !drawing) return null;

  const style = drawing.style;
  const patch = (next: Partial<Drawing>): void => onChange({ ...drawing, ...next });
  const patchStyle = (next: Partial<DrawingStyle>): void =>
    onChange({ ...drawing, style: { ...style, ...next } });
  const patchProfile = (next: NonNullable<DrawingStyle["profile"]>): void =>
    onChange({ ...drawing, style: { ...style, profile: { ...style.profile, ...next } } });

  const anchors = TOOL_POINTS[drawing.tool] ?? drawing.points.length;
  /*
   * The Text tab is live for every tool the canvas can label, which is every
   * tool with a `text` style — the reference has one for the trendline and
   * this dialog greyed it out for exactly that tool.
   */
  const barSeconds = Math.max(1, Math.round(resolutionMs(interval ?? "1h") / 1000));
  const newest = lastBarTime ?? Math.floor(Date.now() / 1000 / barSeconds) * barSeconds;

  const ranges = visibilityRanges(drawing.visibleOn);
  const setRanges = (next: VisibilityRanges): void =>
    patch({ visibleOn: resolutionsForRanges(next) });

  const saveTemplate = async (): Promise<void> => {
    const name = (await ask.promptFor({
      title: "Save this drawing's style as a template",
      label: "Name", placeholder: "Thin dashed", confirmLabel: "Save",
    }))?.trim();
    if (!name) return;
    setTemplates(saveDrawingTemplate(templates, name, style));
  };

  const removeTemplate = async (name: string): Promise<void> => {
    if (!await ask.confirm({
      title: `Delete the template “${name}”?`,
      body: "Drawings already using this style keep it.",
      confirmLabel: "Delete", tone: "danger",
    })) return;
    setTemplates(deleteDrawingTemplate(templates, name));
  };

  return (
    <Modal
      open
      onClose={cancel}
      /*
       * R6b-28: the header is an editable NAME, not a `Trend settings` title.
       * The screen-reader name of the dialog is stated beside it, because an
       * `<input>` is what the heading now contains.
       */
      title={
        <span className="flex items-center gap-2">
          <span className="sr-only">{`${toolTitle(drawing.tool)} settings`}</span>
          <TextInput
            value={drawing.name ?? toolTitle(drawing.tool)}
            aria-label="Drawing name"
            onChange={(e) => patch({ name: e.target.value })}
            className="!min-h-[28px] h-[28px] w-[268px] !text-sm"
          />
        </span>
      }
      /*
       * R6b-28: content-sized at 380, and 459 on Visibility — the reference's
       * own two widths. `Modal`'s `max-w-lg` is 512 and `wide` is 750.
       */
      panelClassName={tab === "visibility" ? "!max-w-[459px]" : "!max-w-[380px]"}
      headerClassName="!h-[54px]"
      contentClassName="!px-5 !pt-0 !pb-4"
      footerClassName="!py-4"
      scrollBody={false}
      footer={
        <div className="flex w-full items-center gap-2">
          <DrawingTemplateMenu
            templates={templates}
            onApply={(name) => {
              const found = templates.find((t) => t.name === name);
              if (found) patchStyle(found.style);
            }}
            onSaveAs={() => void saveTemplate()}
            onDelete={(name) => void removeTemplate(name)}
          />
          <span className="flex-1" />
          <Button variant="default" onClick={cancel} className="w-[74px]">Cancel</Button>
          <Button variant="contrast" onClick={onClose} className="w-[44px] px-0">Ok</Button>
        </div>
      }
    >
      {/*
        R6b-28: TEXT tabs in one 32px row with an underline on the selected —
        not a 131px left nav of chips. The labels are capitalised in the DOM
        rather than by CSS, so what a test and a screen reader read is what a
        user sees.
      */}
      <div role="tablist" aria-label="Drawing settings sections"
        className="mb-2 flex h-8 items-stretch gap-4 border-b border-border">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`relative -mb-px border-b-2 px-0.5 text-sm ${
              tab === item.id
                ? "border-[var(--ts-menu-selected-bg)] font-medium text-[var(--ts-menu-selected-bg)]"
                : "border-transparent text-ink hover:text-[var(--ts-menu-selected-bg)]"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <section
        role="tabpanel"
        className="grid min-h-0 min-w-0 flex-1 auto-rows-min content-start gap-x-4 overflow-y-auto"
        style={{ gridTemplateColumns: "minmax(96px, max-content) 1fr" }}
      >
        {tab === "style" && (
          <>
            {/*
              R6b-28: ONE control for colour, width and pattern — the 75×34
              line-style button the chart-settings dialog already uses. It was
              nine round 28px dots, a native width `<select>` and a 13px native
              `Dashed` box: three controls, none of them the product's own.
            */}
            <FieldRow label="Line">
              <LineStyleButton
                label="Line appearance"
                color={style.color}
                width={style.width}
                style={style.lineStyle ?? (style.dashed ? "dashed" : "solid")}
                onChange={(next) => patchStyle({
                  color: next.color,
                  width: next.width,
                  lineStyle: next.style,
                  // Kept in step: every renderer in `DrawingCanvas` reads the
                  // boolean, and a dotted line degrades to dashed rather than
                  // to solid on a build that has not learned the new key.
                  dashed: next.style !== "solid",
                })} />
            </FieldRow>
            {anchors >= 2 && (
              <>
                <FieldRow label="Extend">
                  <Dropdown
                    value={style.extend ?? "none"}
                    label="Extend"
                    width={180}
                    onChange={(v) => patchStyle({ extend: v as DrawingExtend })}
                    options={[
                      { value: "none", label: "Don't extend" },
                      { value: "left", label: "Left" },
                      { value: "right", label: "Right" },
                      { value: "both", label: "Both" },
                    ]} />
                </FieldRow>
                <CheckRow label="Middle point" checked={style.middlePoint === true}
                  onChange={(v) => patchStyle({ middlePoint: v })} />
              </>
            )}
            <CheckRow label="Price labels" checked={style.priceLabels === true}
              onChange={(v) => patchStyle({ priceLabels: v })} />
            {FILLABLE_TOOLS.has(drawing.tool) && (
              <CheckRow label="Fill" checked={style.filled === true}
                onChange={(v) => patchStyle({ filled: v })} />
            )}

            {anchors >= 2 && (
              <>
                {/*
                  R6b-28 `INFO`: bar count, price change and angle. The maths is
                  the `Info line` tool's own, so this is a computation the
                  product already performs offered where the reference offers it.
                */}
                <Section>Info</Section>
                <FieldRow label="Stats">
                  <Dropdown
                    value={style.stats === true ? "show" : "hidden"}
                    label="Stats"
                    width={180}
                    onChange={(v) => patchStyle({ stats: v === "show" })}
                    options={[
                      { value: "hidden", label: "Hidden" },
                      { value: "show", label: "Bars, change and angle" },
                    ]} />
                </FieldRow>
                <FieldRow label="Stats position">
                  <Dropdown
                    value={style.statsPosition ?? "right"}
                    label="Stats position"
                    width={180}
                    disabled={style.stats !== true}
                    onChange={(v) => patchStyle({
                      statsPosition: v as NonNullable<DrawingStyle["statsPosition"]>,
                    })}
                    options={[
                      { value: "left", label: "Left" },
                      { value: "center", label: "Center" },
                      { value: "right", label: "Right" },
                    ]} />
                </FieldRow>
                <CheckRow label="Always show stats" checked={style.alwaysShowStats === true}
                  disabled={style.stats !== true}
                  onChange={(v) => patchStyle({ alwaysShowStats: v })} />
              </>
            )}

            {/*
              The profile block keeps every control it had and takes the same
              grammar: a 70×28 number with its unit outside, a 180 dropdown.
            */}
            {PROFILE_TOOLS.has(drawing.tool) && (
              <>
                <Section>Volume profile</Section>
                <FieldRow label="Volume placement">
                  <Dropdown
                    value={style.profile?.allocation ?? "range"}
                    label="How a bar's volume is placed"
                    width={180}
                    onChange={(v) => patchProfile({ allocation: v as "range" | "close" })}
                    options={[
                      { value: "range", label: "Across the bar's range" },
                      { value: "close", label: "All at the close" },
                    ]} />
                </FieldRow>
                <FieldRow label="Width">
                  <NumberField value={style.profile?.widthPercent ?? 30} min={5} max={90} unit="%"
                    label="Profile width percent"
                    onChange={(v) => patchProfile({ widthPercent: v })} />
                </FieldRow>
                <CheckRow label="Value area shading"
                  checked={style.profile?.showValueArea !== false}
                  onChange={(v) => patchProfile({ showValueArea: v })} />
              </>
            )}
          </>
        )}

        {tab === "text" && (
          <>
            {/*
              R6b-28: the Text tab is LIVE for the trendline, which is the one
              tool the previous dialog greyed it out for while the reference
              draws a full text block for it.
            */}
            <FieldRow label="Text">
              <Swatch label="Text colour" value={style.textColor || style.color}
                onChange={(v) => patchStyle({ textColor: v })} />
              <Dropdown
                value={String(style.fontSize ?? 14)}
                label="Text size"
                width={100}
                onChange={(v) => patchStyle({ fontSize: Number(v) })}
                options={[10, 11, 12, 14, 16, 20, 24, 32]
                  .map((n) => ({ value: String(n), label: String(n) }))} />
              <ToggleButton label="Bold" pressed={style.bold === true}
                onClick={() => patchStyle({ bold: !(style.bold === true) })}>
                <span className="text-sm font-bold">B</span>
              </ToggleButton>
              <ToggleButton label="Italic" pressed={style.italic === true}
                onClick={() => patchStyle({ italic: !(style.italic === true) })}>
                <span className="text-sm italic">I</span>
              </ToggleButton>
            </FieldRow>
            <div style={{ gridColumn: "1 / -1" }} className="pb-3">
              <textarea
                rows={4}
                aria-label="Add text"
                placeholder="Add text"
                value={style.text ?? ""}
                onChange={(e) => patchStyle({ text: e.target.value })}
                className="h-[94px] w-full resize-none rounded-md border border-control-border
                  bg-transparent px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
            </div>
            <FieldRow label="Text alignment">
              <Dropdown
                value={style.textVAlign ?? "top"}
                label="Vertical text alignment"
                width={100}
                onChange={(v) => patchStyle({
                  textVAlign: v as NonNullable<DrawingStyle["textVAlign"]>,
                })}
                options={[
                  { value: "top", label: "Top" },
                  { value: "middle", label: "Middle" },
                  { value: "bottom", label: "Bottom" },
                ]} />
              <Dropdown
                value={style.textHAlign ?? "center"}
                label="Horizontal text alignment"
                width={100}
                onChange={(v) => patchStyle({
                  textHAlign: v as NonNullable<DrawingStyle["textHAlign"]>,
                })}
                options={[
                  { value: "left", label: "Left" },
                  { value: "center", label: "Center" },
                  { value: "right", label: "Right" },
                ]} />
            </FieldRow>
          </>
        )}

        {tab === "coordinates" && (
          <>
            {/*
              R6b-28: `#1 (price, bar)` — a price at the instrument's own
              decimals and a BAR INDEX. It was an epoch in seconds
              (`1788188400`) and a fourteen-decimal float
              (`75163.90339372704`), both in 245×30 boxes, which is the engine's
              storage printed at a trader.
            */}
            {drawing.points.map((point, index) => (
              <FieldRow key={index} label={`#${index + 1} (price, bar)`}>
                <NumberField
                  value={roundPrice(point.price)}
                  min={0}
                  max={Number.MAX_SAFE_INTEGER}
                  step={priceStep(point.price)}
                  label={`#${index + 1} price`}
                  onChange={(v) => patch({
                    points: drawing.points.map((p, i) => i === index ? { ...p, price: v } : p),
                  })} />
                <NumberField
                  value={Math.round((point.time - newest) / barSeconds)}
                  min={-100000}
                  max={100000}
                  label={`#${index + 1} bar`}
                  onChange={(bars) => patch({
                    points: drawing.points.map((p, i) =>
                      i === index ? { ...p, time: newest + bars * barSeconds } : p),
                  })} />
              </FieldRow>
            ))}
          </>
        )}

        {tab === "visibility" && (
          <>
            {/*
              R6b-28: the reference's per-unit rows — `[☑] unit from [70×28] to
              [70×28]` — against thirteen native checkboxes under a sentence.
              `Ticks`, `Ranges`, `Weeks` and `Months` are absent because this
              product has no such resolution (`lib/resolution` refuses the
              calendar objects); a row that could never be true is not drawn.
            */}
            {VISIBILITY_UNITS.map(({ unit, label, max }) => {
              const row = ranges[unit];
              return (
                <CheckRow
                  key={unit}
                  label={label}
                  checked={row.on}
                  onChange={(on) => setRanges({ ...ranges, [unit]: { ...row, on } })}
                >
                  <span className="text-sm text-ink-faint">from</span>
                  <NumberField value={row.from} min={1} max={max} disabled={!row.on}
                    label={`${label} from`}
                    onChange={(v) => setRanges({
                      ...ranges, [unit]: { ...row, from: Math.min(v, row.to) },
                    })} />
                  <span className="text-sm text-ink-faint">to</span>
                  <NumberField value={row.to} min={1} max={max} disabled={!row.on}
                    label={`${label} to`}
                    onChange={(v) => setRanges({
                      ...ranges, [unit]: { ...row, to: Math.max(v, row.from) },
                    })} />
                </CheckRow>
              );
            })}
            {interval !== undefined && isResolution(interval) && (
              <Note>{`This chart is on ${interval}.`}</Note>
            )}
          </>
        )}
      </section>
    </Modal>
  );
}

/* ── the same row grammar the chart-settings dialog states ───────────────── */

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

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ gridColumn: "1 / -1" }} className="pt-1 text-xs leading-[18px] text-ink-faint">
      {children}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="flex min-h-[50px] items-center whitespace-nowrap text-sm text-ink">
        {label}
      </span>
      <div className="flex min-h-[50px] items-center gap-2">{children}</div>
    </>
  );
}

function CheckRow({ label, checked, onChange, children, disabled = false }: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  children?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <>
      <label
        className={`flex min-h-[50px] cursor-pointer items-center gap-2.5 text-sm ${
          disabled ? "cursor-not-allowed text-ink-faint" : "text-ink"
        }`}
      >
        <Checkbox checked={checked} onChange={onChange} label={label} disabled={disabled} />
        <span className="whitespace-nowrap">{label}</span>
      </label>
      <div className="flex min-h-[50px] items-center gap-2">{children}</div>
    </>
  );
}

/** A 34×34 two-state glyph button — the Text tab's `B` and `I`. */
function ToggleButton({ label, pressed, onClick, children }: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`tvc-control flex h-[34px] w-[34px] items-center justify-center rounded-md
        border border-control-border ${pressed ? "text-ink" : "text-ink-muted hover:text-ink"}`}
    >
      {children}
    </button>
  );
}

/**
 * Enough decimals for the price, and not fourteen of them.
 *
 * The anchor is a float the chart computed from a pixel, so `75163.90339372704`
 * is genuinely what is stored — and is not a price anybody typed or can read.
 * The field shows the instrument's own scale of decimals and writes back what
 * it shows, which is what makes the box editable rather than merely full.
 */
function roundPrice(price: number): number {
  const abs = Math.abs(price);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return Math.round(price * 10 ** digits) / 10 ** digits;
}

function priceStep(price: number): number {
  const abs = Math.abs(price);
  return abs >= 100 ? 0.01 : abs >= 1 ? 0.0001 : 0.000001;
}

/**
 * The footer's one control on the left, as the reference has it.
 *
 * The same shape as the chart-settings dialog's `Template ▾`: a menu, not a
 * `<select>` whose options are commands, and a named delete row rather than
 * whatever the escape key resolves to (E1-06).
 */
function DrawingTemplateMenu({ templates, onApply, onSaveAs, onDelete }: {
  templates: readonly DrawingTemplate[];
  onApply: (name: string) => void;
  onSaveAs: () => void;
  onDelete: (name: string) => void;
}) {
  const [open, setOpen] = useExclusivePopover("drawing-settings-template");
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
        aria-label="Drawing template"
        onClick={() => setOpen(!open)}
        className="tvc-control flex h-[34px] w-[100px] items-center justify-between rounded-md border border-control-border px-3 text-sm text-ink-muted hover:text-ink"
      >
        Template
        <CaretGlyph size={10} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Drawing template"
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
