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
 * native number and `<select>` controls, a 16px switch in the accent colour (the one
 * use of accent the contract forbids, and a second definition of "checkbox" in
 * a product that already has one), a ten-cell 20px palette, two 22px native
 * selects, no Visibility tab at all, and a `Reset to defaults` / `Done` footer
 * with no Cancel — every keystroke committed, nothing revertible.
 *
 * It is now the same dialog as Chart settings with different rows: 550 × 489
 * on every tab (W2D-09, `STUDY_DIALOG_PANEL`), text tabs in a 32px row, a
 * 50px pitch at a 20px inset,
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
  Button, CaretGlyph, Checkbox, Dropdown, LineStyleButton, NumberField, Swatch, TextInput,
} from "@/components/ui";
import type { AppliedIndicator, PineParams } from "@/lib/indicators";
import type { PineInputDef } from "@/lib/api";
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
  onDisplay: (key: string, patch: Pick<AppliedNativeStudy,
    "precision" | "labelsOnPriceScale" | "valuesInStatusLine" | "inputsInStatusLine">) => void;
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

/**
 * W2D-09: ONE size for every tab of every study dialog, and the tab panel scrolls.
 *
 * R6b-29 sized this to the active tab: RSI's Inputs measured 550×277 at
 * (445,312), its Style 550×489 at (445,206) and its Visibility 459×377 at
 * (491,262), so the dialog re-centred on every tab click and Cancel / Ok
 * jumped out from under the pointer. Chart settings fixed the same defect
 * (A10) the same way: a fixed panel, capped by the viewport, with only the
 * tab panel scrolling (`scrollBody={false}` and the panel's own
 * `overflow-y-auto`). 550 wide everywhere; 489 tall, which is the tallest tab
 * the measurement saw, so RSI's Style still opens without a scrollbar.
 * The Pine study dialog is the same family and takes the same box.
 */
const STUDY_DIALOG_PANEL =
  "!max-w-[550px] !h-[min(489px,calc(100vh-40px))] !max-h-[calc(100vh-40px)]";

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
  /*
   * ── B-06: ONE draft for every tab, submitted whole on Ok ────────────────
   *
   * The dialog drew each tab from the study PROP and relied on every edit's
   * live write having stuck. Live, it did not always: ATR → Length 30 → the
   * Style tab → Ok left the legend and the plot at the old length (and so did
   * leaving the field for `Defaults`), while Inputs → Ok applied. Whatever
   * took the write — a re-render from a list that had not yet folded it in, a
   * server reconciliation landing between keystroke and Ok — the dialog had
   * nothing of its own to say what the user had chosen.
   *
   * So the dialog holds the draft: every tab reads it, every edit writes it
   * (and still applies live, so the chart previews), and Ok submits the WHOLE
   * draft, every field, whichever tab it was typed on. Cancel submits the
   * entry state the same way, which is the revert R6b-29 introduced.
   */
  const [draft, setDraft] = useState<AppliedNativeStudy | null>(null);
  useEffect(() => {
    if (!study) { entry.current = null; setDraft(null); return; }
    entry.current = study;
    setDraft(study);
    setTab("inputs");
    // Captured once per study, deliberately: this must be the state on ENTRY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study?.key]);
  /** What every tab draws: the draft once it exists, the study until then. */
  const view = draft && study && draft.key === study.key ? draft : study;

  const def = study ? studyById(study.defId) : null;
  const params = useMemo(
    () => (def && view ? normalizeParams(def, view.params) : {}), [def, view]);

  /**
   * Write every field of `target` to the pane, as one submission.
   *
   * `restoreAbsent` is Cancel's: a plot with no override in the entry state
   * gets the definition's values written back, which is how an edit made
   * during the visit is undone. Ok leaves an un-overridden plot alone, so
   * pressing Ok on an untouched dialog does not turn every default into an
   * explicit override.
   */
  const submit = useCallback((target: AppliedNativeStudy, restoreAbsent: boolean): void => {
    for (const [key, value] of Object.entries(target.params)) {
      props.onParam(target.key, key, value);
    }
    const def0 = studyById(target.defId);
    for (const plot of def0?.plots ?? []) {
      if (!target.styles[plot.id] && !restoreAbsent) continue;
      props.onStyle(target.key, plot.id, target.styles[plot.id] ?? {
        // An absent override is the definition's own answer; writing the
        // definition's values back is how "no override" is restored through
        // an API that only takes overrides.
        color: plot.color,
        width: plot.width ?? 1,
        style: plot.style,
        visible: !plot.hiddenByDefault,
      });
    }
    props.onVisibleOn?.(target.key, target.visibleOn);
    props.onDisplay(target.key, {
      precision: target.precision,
      labelsOnPriceScale: target.labelsOnPriceScale,
      valuesInStatusLine: target.valuesInStatusLine,
      inputsInStatusLine: target.inputsInStatusLine,
    });
    // `props` is read through the ref-stable callbacks the pane hands us.
  }, [props]);

  const cancel = useCallback((): void => {
    if (entry.current) submit(entry.current, true);
    onClose();
  }, [onClose, submit]);

  const ok = useCallback((): void => {
    if (view) submit(view, false);
    onClose();
  }, [onClose, submit, view]);

  if (!study || !def || !view) return null;

  /* Each edit lands in the draft AND reaches the pane live, as a preview. */
  const editParam = (param: string, value: NativeInputValue): void => {
    setDraft((d) => (d ? { ...d, params: { ...d.params, [param]: value } } : d));
    props.onParam(study.key, param, value);
  };
  const editStyle = (plotId: string, style: PlotStyleOverride): void => {
    setDraft((d) => (d
      ? { ...d, styles: { ...d.styles, [plotId]: { ...d.styles[plotId], ...style } } } : d));
    props.onStyle(study.key, plotId, style);
  };
  const editDisplay = (patch: Pick<AppliedNativeStudy, "precision" | "labelsOnPriceScale"
    | "valuesInStatusLine" | "inputsInStatusLine">): void => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    props.onDisplay(study.key, patch);
  };
  const editVisibleOn = (visibleOn: Resolution[] | undefined): void => {
    setDraft((d) => (d ? { ...d, visibleOn } : d));
    props.onVisibleOn?.(study.key, visibleOn);
  };
  const reset = (): void => {
    props.onReset(study.key);
    // What `useNativeStudies.resetParams` writes, so the draft agrees with it.
    setDraft((d) => (d ? {
      ...d, params: normalizeParams(def, undefined), styles: {}, precision: undefined,
      labelsOnPriceScale: undefined, valuesInStatusLine: undefined, inputsInStatusLine: undefined,
    } : d));
  };

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
    && Object.keys(view.styles).length === 0
    && view.precision === undefined
    && view.labelsOnPriceScale === undefined
    && view.valuesInStatusLine === undefined
    && view.inputsInStatusLine === undefined;

  const tabs = props.onVisibleOn ? TABS : TABS.filter((t) => t.id !== "visibility");
  const ranges = visibilityRanges(view.visibleOn);
  const setRanges = (next: VisibilityRanges): void =>
    editVisibleOn(resolutionsForRanges(next));

  return (
    <Modal
      open
      onClose={cancel}
      title={def.name}
      panelClassName={STUDY_DIALOG_PANEL}
      headerClassName="!h-[54px]"
      contentClassName="!px-5 !pt-0 !pb-4"
      footerClassName="!py-4"
      scrollBody={false}
      footer={
        <div className="flex w-full items-center gap-2">
          <DefaultsMenu disabled={isDefault} onReset={reset} />
          <span className="flex-1" />
          <Button variant="default" onClick={cancel} className="w-[74px]">Cancel</Button>
          <Button variant="contrast" onClick={ok} className="w-[44px] px-0">Ok</Button>
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
                onChange={(value) => editParam(input.key, value)}
              />
            ))}
            {def.inputs.length === 0 && (
              <Note>This study has no inputs.</Note>
            )}
          </>
        )}

        {tab === "style" && (
          <>
            {def.plots.map((plot) => (
              <StyleRow
                key={plot.id}
                plot={plot}
                override={view.styles[plot.id] ?? {}}
                value={props.values?.[plot.id] ?? null}
                onChange={(style) => editStyle(plot.id, style)}
              />
            ))}
            <Section>Output values</Section>
            <Row label="Precision">
              <Dropdown
                value={view.precision === undefined ? "default" : String(view.precision)}
                label="Precision"
                width={100}
                onChange={(value) => editDisplay({
                  precision: value === "default" ? undefined : Number(value),
                })}
                options={[
                  { value: "default", label: "Default" },
                  ...Array.from({ length: 9 }, (_, precision) => ({
                    value: String(precision), label: String(precision),
                  })),
                ]}
              />
            </Row>
            <CheckRow
              label="Labels on price scale"
              checked={view.labelsOnPriceScale !== false}
              onChange={(value) => editDisplay({ labelsOnPriceScale: value })}
            />
            <CheckRow
              label="Values in status line"
              checked={view.valuesInStatusLine !== false}
              onChange={(value) => editDisplay({ valuesInStatusLine: value })}
            />
            <Section>Input values</Section>
            <CheckRow
              label="Inputs in status line"
              checked={view.inputsInStatusLine !== false}
              onChange={(value) => editDisplay({ inputsInStatusLine: value })}
            />
          </>
        )}

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

/* ── the same dialog, for a Pine study ───────────────────────────────────── */

/**
 * The series a Pine `input.source` may name — exactly the interpreter's
 * `builtinSeries` set (`backend/src/pine/interpreter.ts`), so the dropdown
 * cannot offer a name the engine would resolve to nothing.
 */
const PINE_SOURCES = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4", "hlcc4"];

/** No bounds declared: the field must not clamp what the script allows. */
const PINE_NUMBER_LIMIT = 1_000_000_000;

export interface PineStudySettingsProps {
  /** The instance being edited, or null when the dialog is closed. */
  study: AppliedIndicator | null;
  onClose: () => void;
  onParam: (key: string, param: string, value: PineParams[string]) => void;
  /** Drop every override, so each input reads its `defval` again. */
  onReset: (key: string) => void;
}

/**
 * Inputs for a Pine study, in the built-in study's dialog.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A built-in's gear opened `NativeStudySettings`; a Pine study's gear swapped
 * the right rail to the Indicator library and unfolded a stack of 10px native
 * `<input>`s and `<select>`s inside its card. Premium opens ONE dialog for
 * every study, and the same gear meaning two different surfaces depending on
 * which engine computed the line is the inconsistency a user notices first.
 * The card's inline form stays, as the panel's own secondary path.
 *
 * ── Which tabs, and why only one ───────────────────────────────────────────
 *
 * `Inputs` is the script's own `input()` declarations, grouped by their
 * `group=` as the reference groups them, with the same row primitives the
 * built-in dialog uses. `Style` and `Visibility` are ABSENT, not greyed: a
 * Pine study's plots are drawn from what the script returns and
 * `useIndicators` has no per-plot override and no timeframe allow-list to
 * write to. A colour well that the next run silently repaints would be a
 * control that moves nothing (contract §6).
 *
 * ── Live, and revertible ───────────────────────────────────────────────────
 *
 * Every change is applied as it is made (`useIndicators` debounces the
 * re-run), and `Cancel` puts back the overrides the study had when the dialog
 * opened — reset to defaults first, then the entry overrides on top, so an
 * input first touched during this visit returns to its default rather than
 * keeping the new value.
 */
export function PineStudySettings(props: PineStudySettingsProps) {
  const { study, onClose } = props;
  const entry = useRef<AppliedIndicator | null>(null);
  /*
   * B-06: the dialog's own draft of the overrides, as in the built-in dialog
   * above — what the field shows, and what Ok submits whole, so a live write
   * that did not stick cannot leave the study at a value the user replaced.
   */
  const [draft, setDraft] = useState<{ key: string; params: PineParams } | null>(null);
  useEffect(() => {
    entry.current = study;
    setDraft(study ? { key: study.key, params: { ...study.params } } : null);
    // Captured once per study, deliberately: this must be the state on ENTRY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study?.key]);
  const params = useMemo(
    () => (draft && study && draft.key === study.key ? draft.params : study?.params ?? {}),
    [draft, study]);

  /** Reset, then every override in `target`: the study ends up exactly there. */
  const submit = useCallback((key: string, target: PineParams): void => {
    props.onReset(key);
    for (const [param, value] of Object.entries(target)) props.onParam(key, param, value);
  }, [props]);

  const cancel = useCallback((): void => {
    const was = entry.current;
    if (was) submit(was.key, was.params);
    onClose();
  }, [onClose, submit]);

  const ok = useCallback((): void => {
    if (study) submit(study.key, params);
    onClose();
  }, [onClose, submit, study, params]);

  if (!study) return null;

  const edit = (param: string, value: PineParams[string]): void => {
    setDraft((d) => (d ? { ...d, params: { ...d.params, [param]: value } } : d));
    props.onParam(study.key, param, value);
  };
  const reset = (): void => {
    props.onReset(study.key);
    setDraft((d) => (d ? { ...d, params: {} } : d));
  };

  const isDefault = Object.keys(params).length === 0;
  /*
   * Grouped in declaration order, the ungrouped first — the order the script
   * declares them is the order its author meant them read in.
   */
  const groups: { name: string; inputs: PineInputDef[] }[] = [];
  for (const input of study.inputs) {
    const name = input.group ?? "";
    const group = groups.find((g) => g.name === name);
    if (group) group.inputs.push(input);
    else groups.push({ name, inputs: [input] });
  }

  return (
    <Modal
      open
      onClose={cancel}
      title={study.name}
      panelClassName={STUDY_DIALOG_PANEL}
      headerClassName="!h-[54px]"
      contentClassName="!px-5 !pt-0 !pb-4"
      footerClassName="!py-4"
      scrollBody={false}
      footer={
        <div className="flex w-full items-center gap-2">
          <DefaultsMenu disabled={isDefault} onReset={reset} />
          <span className="flex-1" />
          <Button variant="default" onClick={cancel} className="w-[74px]">Cancel</Button>
          <Button variant="contrast" onClick={ok} className="w-[44px] px-0">Ok</Button>
        </div>
      }
    >
      <div role="tablist" aria-label="Settings sections"
        className="mb-2 flex h-8 items-stretch gap-4 border-b border-border">
        <button
          role="tab"
          aria-selected
          className="relative -mb-px border-b-2 border-[var(--ts-menu-selected-bg)] px-0.5 text-sm font-medium text-[var(--ts-menu-selected-bg)]"
        >
          Inputs
        </button>
      </div>
      <section
        role="tabpanel"
        aria-label="Inputs"
        className="grid min-h-0 min-w-0 flex-1 auto-rows-min content-start gap-x-5 overflow-y-auto"
        style={{ gridTemplateColumns: "minmax(150px, max-content) 1fr" }}
      >
        {groups.map((group) => (
          <PineGroup key={group.name || "\u0000"} name={group.name}>
            {group.inputs.map((input) => (
              <PineInputRow
                key={input.key}
                input={input}
                value={params[input.key] ?? input.defval}
                onChange={(value) => edit(input.key, value)}
              />
            ))}
          </PineGroup>
        ))}
        {study.inputs.length === 0 && (
          <Note>
            {study.loading
              ? "Reading the script's inputs…"
              : "This script declares no inputs."}
          </Note>
        )}
      </section>
    </Modal>
  );
}

function PineGroup({ name, children }: { name: string; children: ReactNode }) {
  return <>{name && <Section>{name}</Section>}{children}</>;
}

function PineInputRow({ input, value, onChange }: {
  input: PineInputDef;
  value: PineParams[string];
  onChange: (value: PineParams[string]) => void;
}) {
  const label = input.title || input.key;
  if (input.type === "bool") {
    return <CheckRow label={label} checked={value === true} onChange={onChange} />;
  }
  if (input.options && input.options.length > 0) {
    const options = input.options;
    return (
      <Row label={label} hint={input.tooltip}>
        <Dropdown
          value={String(value)}
          label={label}
          width={150}
          /* An option list of numbers hands back a number, as the script declared it. */
          onChange={(next) => {
            const match = options.find((o) => String(o) === next);
            onChange(match ?? next);
          }}
          options={options.map((o) => ({ value: String(o), label: String(o) }))}
        />
      </Row>
    );
  }
  if (input.type === "int" || input.type === "float") {
    return (
      <Row label={label} hint={input.tooltip}>
        <NumberField
          value={Number(value)}
          min={input.minval ?? -PINE_NUMBER_LIMIT}
          max={input.maxval ?? PINE_NUMBER_LIMIT}
          step={input.step ?? (input.type === "int" ? 1 : 0.1)}
          label={label}
          onChange={(next) => onChange(input.type === "int" ? Math.trunc(next) : next)}
        />
      </Row>
    );
  }
  if (input.type === "source") {
    const current = String(value);
    return (
      <Row label={label} hint={input.tooltip}>
        <Dropdown
          value={current}
          label={label}
          width={100}
          onChange={onChange}
          options={[
            // A stored name the engine no longer offers is still SHOWN, as itself.
            ...(PINE_SOURCES.includes(current) ? [] : [{ value: current, label: current }]),
            ...PINE_SOURCES.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) })),
          ]}
        />
      </Row>
    );
  }
  if (input.type === "color") {
    return (
      <Row label={label} hint={input.tooltip}>
        <Swatch label={label} id={`pine-input-color:${input.key}`} value={String(value)}
          allowTheme={false} onChange={onChange} />
      </Row>
    );
  }
  // `string` and `timeframe`: what the script reads is the text itself.
  return (
    <Row label={label} hint={input.tooltip}>
      <TextInput
        aria-label={label}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
        className="w-[180px]"
      />
    </Row>
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

function Section({ children }: { children: ReactNode }) {
  return (
    <h3 style={{ gridColumn: "1 / -1" }}
      className="pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
      {children}
    </h3>
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
   * It was a bordered CARD per plot holding a 16px switch in the accent colour, ten
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
