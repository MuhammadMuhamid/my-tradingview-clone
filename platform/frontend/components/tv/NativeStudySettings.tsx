"use client";
/**
 * Inputs, Style and Visibility for a built-in study.
 *
 * ── Generated, not written ─────────────────────────────────────────────────
 *
 * Nothing here knows what any study computes. The fields come from the
 * definition's `inputs`, the style rows come from its `plots`, and both are
 * rendered by kind. That is the whole point of having a registry: adding a
 * study must not mean writing a settings dialog for it, because a
 * hand-written dialog is where a study ends up with an input the maths
 * ignores, or a plot with no way to recolour it.
 *
 * ── What R6b measured, and what this file is now ───────────────────────────
 *
 * Against the reference's own study dialog this was 512 wide with a 12px
 * description paragraph the reference does not have, two 28px CHIP tabs, 310×34
 * native number and `<select>` controls, a 16px ACCENT-filled switch (the one
 * use of accent the contract forbids, and a second definition of "checkbox" in
 * a product that already has one), a ten-cell 20px palette, two 22px native
 * selects, no Visibility tab at all, and a `Reset to defaults` / `Done` footer
 * with no Cancel — every keystroke committed, nothing revertible.
 *
 * It is now the same dialog as Chart settings with different rows: 550 wide
 * (459 on Visibility), text tabs in a 32px row, a 50px pitch at a 20px inset,
 * `NumberField` 70×28 / `Dropdown` 100×34 / `Swatch` 34×34 / `LineStyleButton`
 * 75×34 / `Checkbox` 18 from `components/ui`, and `Defaults ▾` / `Cancel` /
 * `Ok` in the footer with live apply and a real revert.
 *
 * ── Values are normalised on the way in, not on the way out ────────────────
 *
 * A number field is a text box until it is not empty, so a half-typed `1` on
 * the way to `14` must not be clamped to the minimum and leave the user
 * fighting the field. `useNativeStudies` normalises again regardless — an
 * out-of-range value must never reach a study's arithmetic, whatever the UI
 * did.
 *
 * ── Honest omissions ───────────────────────────────────────────────────────
 *
 * The reference's Style tab ends with `OUTPUT VALUES` (`Precision`, `Labels on
 * price scale`, `Values in status line`) and `INPUT VALUES` (`Inputs in status
 * line`). Those are four settings the applied-study model does not carry and
 * the pane legend does not read per study — the product has ONE answer for
 * each, on the chart-settings dialog's Scales and Status-line tabs, and it
 * reaches every study. Four per-study switches whose value nothing reads would
 * be four controls that move nothing; they are absent rather than drawn.
 *
 * Visibility has no `Ticks`, `Ranges`, `Weeks` or `Months` row for the same
 * reason the drawing dialog has none: `lib/resolution` publishes `1s … 1d` and
 * refuses the calendar objects, so there is no such resolution to be visible on.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "@/components/Modal";
import { studyById } from "@/lib/native/catalog";
import {
  PRICE_SOURCES, PRICE_SOURCE_LABELS, defaultParams, normalizeParams,
  type NativeInput, type NativeInputValue, type PlotDef,
} from "@/lib/native/registry";
import type { AppliedNativeStudy, PlotStyleOverride } from "@/lib/native/compute";
import type { SourceOption } from "@/lib/native/graph";
import type { Resolution } from "@/lib/resolution";
import {
  Button, CaretGlyph, Checkbox, Dropdown, LineStyleButton, NumberField, Swatch,
} from "@/components/ui";
import {
  resolutionsForRanges, visibilityRanges, type VisibilityRanges,
} from "@/components/tv/DrawingSettingsModal";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";
import { useExclusivePopover } from "@/lib/useExclusivePopover";

type Tab = "inputs" | "style" | "visibility";

const TABS: { id: Tab; label: string }[] = [
  { id: "inputs", label: "Inputs" },
  { id: "style", label: "Style" },
  { id: "visibility", label: "Visibility" },
];

const PLOT_STYLES: { value: PlotDef["style"]; label: string }[] = [
  { value: "line", label: "Line" },
  { value: "stepline", label: "Step line" },
  { value: "histogram", label: "Histogram" },
  { value: "columns", label: "Columns" },
  { value: "area", label: "Area" },
  { value: "circles", label: "Circles" },
];

/** The same per-unit rows the drawing dialog's Visibility tab draws. */
const VISIBILITY_UNITS: { unit: "s" | "m" | "h" | "d"; label: string; max: number }[] = [
  { unit: "s", label: "Seconds", max: 59 },
  { unit: "m", label: "Minutes", max: 1439 },
  { unit: "h", label: "Hours", max: 23 },
  { unit: "d", label: "Days", max: 1 },
];

export interface NativeStudySettingsProps {
  /** The instance being edited, or null when the dialog is closed. */
  study: AppliedNativeStudy | null;
  onClose: () => void;
  onParam: (key: string, param: string, value: NativeInputValue) => void;
  onStyle: (key: string, plotId: string, style: PlotStyleOverride) => void;
  onReset: (key: string) => void;
  /**
   * R6b-29: the study's own timeframe allow-list.
   *
   * Optional so a surface that has no study store — a preview, the strategy
   * tester — simply does not offer the tab, rather than offering one whose
   * answer nothing would read.
   */
  onVisibleOn?: (key: string, visibleOn: Resolution[] | undefined) => void;
  /** Current value per plot id, so the dialog shows what it is changing. */
  values?: Record<string, number | null>;
  /**
   * Every source this study may legally be given, asked for at the moment the
   * dialog opens.
   *
   * A function of the whole pane rather than of this study, because whether
   * reading another study would close a cycle depends on what else is applied.
   * Omitted — the strategy tester's chart, a preview — the dropdown offers the
   * prices, which is what it always offered.
   */
  sourceOptions?: (key: string) => SourceOption[];
}

export function NativeStudySettings(props: NativeStudySettingsProps) {
  const { study, onClose } = props;
  const [tab, setTab] = useState<Tab>("inputs");
  /*
   * R6b-29: what the study was when the dialog opened, so `Cancel` means
   * something.
   *
   * There was no Cancel at all: every keystroke was committed through
   * `onParam` as it was typed, so a user who opened the dialog to look had no
   * way back. The reference applies live AND reverts, which is only possible
   * with the entry state held.
   */
  const entry = useRef<AppliedNativeStudy | null>(null);
  useEffect(() => {
    if (!study) { entry.current = null; return; }
    entry.current = study;
    setTab("inputs");
    // Captured once per study, deliberately: this must be the state on ENTRY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study?.key]);

  const def = study ? studyById(study.defId) : null;
  const params = useMemo(
    () => (def && study ? normalizeParams(def, study.params) : {}), [def, study]);

  const cancel = useCallback((): void => {
    const was = entry.current;
    if (was) {
      for (const [key, value] of Object.entries(was.params)) {
        props.onParam(was.key, key, value);
      }
      const def0 = studyById(was.defId);
      for (const plot of def0?.plots ?? []) {
        props.onStyle(was.key, plot.id, was.styles[plot.id] ?? {
          // An absent override is the definition's own answer; writing the
          // definition's values back is how "no override" is restored through
          // an API that only takes overrides.
          color: plot.color,
          width: plot.width ?? 1,
          style: plot.style,
          visible: !plot.hiddenByDefault,
        });
      }
      props.onVisibleOn?.(was.key, was.visibleOn);
    }
    onClose();
    // `props` is read through the ref-stable callbacks the pane hands us.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, props]);

  if (!study || !def) return null;

  /*
   * Asked for once per open dialog rather than memoised across the pane.
   *
   * The legal set changes when any study is added, removed or repointed, and a
   * dropdown that offered a stale option would let the user pick something the
   * graph then refuses — which is the exact failure the filtering exists to
   * prevent.
   */
  const offered = props.sourceOptions?.(study.key);
  // An empty answer is "this surface has no pane to ask", not "no sources
  // exist" — a dropdown with nothing in it would be worse than the prices.
  const sources = offered && offered.length > 0 ? offered : undefined;

  const isDefault = JSON.stringify(params) === JSON.stringify(defaultParams(def))
    && Object.keys(study.styles).length === 0;

  const tabs = props.onVisibleOn ? TABS : TABS.filter((t) => t.id !== "visibility");
  const ranges = visibilityRanges(study.visibleOn);
  const setRanges = (next: VisibilityRanges): void =>
    props.onVisibleOn?.(study.key, resolutionsForRanges(next));

  return (
    <Modal
      open
      onClose={cancel}
      title={def.name}
      /*
       * R6b-29: 550 wide, 459 on Visibility — the reference's own two widths,
       * content-sized per tab. `max-w-lg` is 512.
       */
      panelClassName={tab === "visibility" ? "!max-w-[459px]" : "!max-w-[550px]"}
      headerClassName="!h-[54px]"
      contentClassName="!px-5 !pt-0 !pb-4"
      footerClassName="!py-4"
      scrollBody={false}
      footer={
        <div className="flex w-full items-center gap-2">
          <DefaultsMenu disabled={isDefault} onReset={() => props.onReset(study.key)} />
          <span className="flex-1" />
          <Button variant="default" onClick={cancel} className="w-[74px]">Cancel</Button>
          <Button variant="contrast" onClick={onClose} className="w-[44px] px-0">Ok</Button>
        </div>
      }
    >
      {/*
        R6b-29: text tabs in one 32px row with an underline on the selected —
        not 28px chips, and not a 12px description paragraph above them. The
        description is the tooltip on the title now: the reference's study
        dialog carries no prose at all.
      */}
      <div role="tablist" aria-label="Settings sections"
        className="mb-2 flex h-8 items-stretch gap-4 border-b border-border">
        {tabs.map((item) => (
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
        className="grid min-h-0 min-w-0 flex-1 auto-rows-min content-start gap-x-5 overflow-y-auto"
        style={{ gridTemplateColumns: "minmax(150px, max-content) 1fr" }}
      >
        {tab === "inputs" && (
          <>
            {def.inputs.map((input) => (
              <InputRow
                key={input.key}
                input={input}
                value={params[input.key]!}
                sources={input.kind === "source" ? sources : undefined}
                onChange={(value) => props.onParam(study.key, input.key, value)}
              />
            ))}
            {def.inputs.length === 0 && (
              <Note>This study has no inputs.</Note>
            )}
          </>
        )}

        {tab === "style" && def.plots.map((plot) => (
          <StyleRow
            key={plot.id}
            plot={plot}
            override={study.styles[plot.id] ?? {}}
            value={props.values?.[plot.id] ?? null}
            onChange={(style) => props.onStyle(study.key, plot.id, style)}
          />
        ))}

        {tab === "visibility" && VISIBILITY_UNITS.map(({ unit, label, max }) => {
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
      </section>
    </Modal>
  );
}

/* ── the settings-row grammar, shared with the chart-settings dialog ─────── */

function Note({ children }: { children: ReactNode }) {
  return (
    <div style={{ gridColumn: "1 / -1" }} className="py-3 text-xs leading-[18px] text-ink-faint">
      {children}
    </div>
  );
}

function Row({ label, hint, children }: {
  label: string; hint?: string; children: ReactNode;
}) {
  return (
    <>
      <span className="flex min-h-[50px] items-center whitespace-nowrap text-sm text-ink"
        title={hint}>
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
  children?: ReactNode;
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

function InputRow({ input, value, sources, onChange }: {
  input: NativeInput;
  value: NativeInputValue;
  /** For a source input: everything this study may legally read. */
  sources?: SourceOption[];
  onChange: (value: NativeInputValue) => void;
}) {
  switch (input.kind) {
    case "number":
      /*
       * R6b-29: a 70×28 `NumberField`, not a 310×34 native box.
       *
       * The draft-text dance the previous version did — commit on blur, resync
       * only while unfocused — was there because committing on every keystroke
       * ran each digit through `coerceInput`'s CLAMP and rewrote it under the
       * cursor. `NumberField` clamps to the row's own min/max on change, which
       * is the same protection with one control instead of two states, and
       * `useNativeStudies` normalises again regardless.
       */
      return (
        <Row
          label={input.title}
          hint={input.min !== undefined || input.max !== undefined
            ? `${input.min ?? "—"} to ${input.max ?? "—"}` : undefined}
        >
          <NumberField
            value={Number(value)}
            min={input.min ?? 1}
            max={input.max ?? 100000}
            step={input.step ?? (input.integer === false ? 0.1 : 1)}
            label={input.title}
            onChange={onChange}
          />
        </Row>
      );
    case "select":
      return (
        <Row label={input.title}>
          <Dropdown
            value={String(value)}
            label={input.title}
            width={100}
            onChange={onChange}
            options={input.options.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Row>
      );
    case "source": {
      /*
       * Two groups, because they are two different kinds of answer: a price
       * this instrument has, and a line another study on this pane is already
       * drawing. The grouping survived the move off `<optgroup>` as a prefix on
       * the study rows' labels, which is what a `.tvc-menu` can carry.
       *
       * A stored source naming a study that has since been removed is still
       * SHOWN — as itself, at the top — because silently displaying `Close`
       * over a broken reference is how a user comes to believe an average of
       * an RSI is an average of price.
       */
      const options = sources ?? PRICE_SOURCES.map((source) => ({
        value: source, label: PRICE_SOURCE_LABELS[source], group: "price" as const,
      }));
      const current = String(value);
      const dangling = !options.some((option) => option.value === current);
      return (
        <Row label={input.title}>
          <Dropdown
            value={current}
            label={input.title}
            width={100}
            onChange={onChange}
            options={[
              ...(dangling ? [{
                value: current,
                label: current.startsWith("study:")
                  ? "A study that is no longer applied" : current,
              }] : []),
              ...options.filter((o) => o.group === "price")
                .map((o) => ({ value: o.value, label: o.label })),
              ...options.filter((o) => o.group === "study")
                .map((o) => ({ value: o.value, label: `Study · ${o.label}` })),
            ]}
          />
        </Row>
      );
    }
    case "boolean":
      /*
       * R6b-29: the product's own `Checkbox`, not an `On`/`Off` chip wearing a
       * `role="switch"`. One product, one boolean control.
       */
      return (
        <CheckRow
          label={input.title}
          checked={value === true}
          onChange={(next) => onChange(next)}
        />
      );
  }
}

function StyleRow({ plot, override, value, onChange }: {
  plot: PlotDef;
  override: PlotStyleOverride;
  value: number | null;
  onChange: (style: PlotStyleOverride) => void;
}) {
  const visible = override.visible ?? !plot.hiddenByDefault;
  const color = override.color ?? plot.color;
  const width = override.width ?? plot.width ?? 1;
  const style = override.style ?? plot.style;

  /*
   * R6b-29: `[☑] plot … [swatch 34×34][line-style 75×34]` on one 50px row.
   *
   * It was a bordered CARD per plot holding a 16px accent-filled switch, ten
   * 20px palette buttons and two 22px native selects — a second grammar for
   * the same four settings the chart-settings dialog already draws as a
   * checkbox, a swatch and one button. The plot STYLE (line, histogram, …) has
   * no home on the line-style button, so it keeps its own 100×34 dropdown,
   * which is the reference's second control on this row.
   */
  return (
    <CheckRow
      label={plot.title}
      checked={visible}
      onChange={(next) => onChange({ visible: next })}
    >
      <Swatch
        label={`${plot.title} colour`}
        id={`study-plot-color:${plot.id}`}
        value={color}
        onChange={(next) => onChange({ color: next })}
      />
      <LineStyleButton
        label={`${plot.title} line`}
        id={`study-plot-line:${plot.id}`}
        color={color}
        width={Math.max(1, Math.min(4, width))}
        style={plot.dashed ? "dashed" : "solid"}
        onChange={(next) => onChange({ color: next.color, width: next.width })}
      />
      <Dropdown
        value={style}
        label={`${plot.title} plot style`}
        width={100}
        onChange={(next) => onChange({ style: next as PlotDef["style"] })}
        options={PLOT_STYLES.map((o) => ({ value: o.value, label: o.label }))}
      />
      {value !== null && (
        <span className="tabular shrink-0 text-xs text-ink-muted">{value.toFixed(4)}</span>
      )}
    </CheckRow>
  );
}

/**
 * `Defaults ▾` — the footer's one control on the left, as the reference has it.
 *
 * A menu rather than a 135×30 `Reset to defaults` button, so it is the same
 * shape and the same width as the chart-settings dialog's `Template ▾` beside
 * it in the same product.
 */
function DefaultsMenu({ disabled, onReset }: { disabled: boolean; onReset: () => void }) {
  const [open, setOpen] = useExclusivePopover("study-settings-defaults");
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

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Study defaults"
        onClick={() => setOpen(!open)}
        className="tvc-control flex h-[34px] w-[100px] items-center justify-between rounded-md border border-control-border px-3 text-sm text-ink-muted hover:text-ink"
      >
        Defaults
        <CaretGlyph size={10} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Study defaults"
          onKeyDown={(e) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              moveMenuFocus(menuItems(menuRef.current), document.activeElement, e.key);
            }
          }}
          className="tvc-menu tvc-menu--compact absolute bottom-[calc(100%+6px)] left-0 z-50 w-[240px]"
        >
          <button
            type="button"
            role="menuitem"
            aria-disabled={disabled}
            disabled={disabled}
            className="tvc-menu-row px-2.5 text-left text-sm text-ink disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => { setOpen(false); onReset(); }}
          >
            Reset to defaults
          </button>
        </div>
      )}
    </div>
  );
}
