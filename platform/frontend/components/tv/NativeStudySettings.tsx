"use client";
/**
 * Inputs and Style for a built-in study.
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
 * ── Values are normalised on the way in, not on the way out ────────────────
 *
 * A number field is a text box until it is not empty, so a half-typed `1` on
 * the way to `14` must not be clamped to the minimum and leave the user
 * fighting the field. The draft text is local; the normalised value is
 * committed on change of a parsable number and on blur. `useNativeStudies`
 * normalises again regardless — an out-of-range value must never reach a
 * study's arithmetic, whatever the UI did.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "@/components/Modal";
import { studyById } from "@/lib/native/catalog";
import {
  PRICE_SOURCES, PRICE_SOURCE_LABELS, defaultParams, normalizeParams,
  type NativeInput, type NativeInputValue, type PlotDef,
} from "@/lib/native/registry";
import type { AppliedNativeStudy, PlotStyleOverride } from "@/lib/native/compute";
import { PALETTE } from "@/lib/drawings";

const FIELD =
  "w-full rounded border border-border bg-surface-2 px-2 py-1 text-sm text-ink " +
  "outline-none focus:border-accent";

const PLOT_STYLES: { value: PlotDef["style"]; label: string }[] = [
  { value: "line", label: "Line" },
  { value: "stepline", label: "Step line" },
  { value: "histogram", label: "Histogram" },
  { value: "columns", label: "Columns" },
  { value: "area", label: "Area" },
  { value: "circles", label: "Circles" },
];

export interface NativeStudySettingsProps {
  /** The instance being edited, or null when the dialog is closed. */
  study: AppliedNativeStudy | null;
  onClose: () => void;
  onParam: (key: string, param: string, value: NativeInputValue) => void;
  onStyle: (key: string, plotId: string, style: PlotStyleOverride) => void;
  onReset: (key: string) => void;
  /** Current value per plot id, so the dialog shows what it is changing. */
  values?: Record<string, number | null>;
}

export function NativeStudySettings(props: NativeStudySettingsProps) {
  const { study, onClose } = props;
  const [tab, setTab] = useState<"inputs" | "style">("inputs");
  useEffect(() => { if (study) setTab("inputs"); }, [study?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const def = study ? studyById(study.defId) : null;
  const params = useMemo(
    () => (def && study ? normalizeParams(def, study.params) : {}), [def, study]);

  if (!study || !def) return null;

  const isDefault = JSON.stringify(params) === JSON.stringify(defaultParams(def))
    && Object.keys(study.styles).length === 0;

  return (
    <Modal open onClose={onClose} title={def.name}>
      <p className="mb-3 text-xs text-ink-muted">{def.description}</p>

      <div role="tablist" aria-label="Settings sections" className="mb-3 flex gap-1">
        {(["inputs", "style"] as const).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded px-3 py-1 text-sm transition-colors ${
              tab === id ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:text-ink"
            }`}
          >
            {id === "inputs" ? "Inputs" : "Style"}
          </button>
        ))}
      </div>

      {tab === "inputs" ? (
        <div className="space-y-2">
          {def.inputs.map((input) => (
            <InputRow
              key={input.key}
              input={input}
              value={params[input.key]!}
              onChange={(value) => props.onParam(study.key, input.key, value)}
            />
          ))}
          {def.inputs.length === 0 && (
            <p className="text-sm text-ink-faint">This study has no inputs.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {def.plots.map((plot) => (
            <StyleRow
              key={plot.id}
              plot={plot}
              override={study.styles[plot.id] ?? {}}
              value={props.values?.[plot.id] ?? null}
              onChange={(style) => props.onStyle(study.key, plot.id, style)}
            />
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <button
          onClick={() => props.onReset(study.key)}
          disabled={isDefault}
          className="rounded border border-border px-3 py-1 text-sm text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset to defaults
        </button>
        <button
          onClick={onClose}
          className="rounded bg-accent px-4 py-1 text-sm font-medium text-bg"
        >
          Done
        </button>
      </div>
    </Modal>
  );
}

function Row({ label, hint, children }: {
  label: string; hint?: string; children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-[150px] shrink-0 text-sm text-ink-muted" title={hint}>{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

function InputRow({ input, value, onChange }: {
  input: NativeInput;
  value: NativeInputValue;
  onChange: (value: NativeInputValue) => void;
}) {
  /*
   * A number field holds TEXT while it is being typed.
   *
   * Two things follow, and the first version had both wrong.
   *
   * It used to commit on every parsable keystroke, and the committed value
   * comes back through `coerceInput`, which CLAMPS. Typing `6000` into a field
   * whose maximum is 5000 became `5000` after the third digit and then
   * `50004`, rewritten under the cursor. And for a decimal field the
   * intermediate `2.` is not a valid `<input type="number">` value, so the
   * browser reports `""`, the commit was skipped and the draft was still
   * blanked — the decimal point vanished as it was typed.
   *
   * So: the draft resyncs from the value only while the field is NOT focused,
   * and the commit happens on blur or Enter, when the user has said what they
   * mean. A field that is not focused still follows a reset-to-defaults.
   */
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    if (typeof document !== "undefined" && document.activeElement === ref.current) return;
    setDraft(String(value));
  }, [value]);

  /** Commit what is in the box, or put back what was there if it is nonsense. */
  const commit = (): void => {
    const parsed = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
    else setDraft(String(value));
  };

  switch (input.kind) {
    case "number":
      return (
        <Row
          label={input.title}
          hint={input.min !== undefined || input.max !== undefined
            ? `${input.min ?? "—"} to ${input.max ?? "—"}` : undefined}
        >
          <input
            ref={ref}
            type="number"
            className={FIELD}
            value={draft}
            min={input.min}
            max={input.max}
            step={input.step ?? (input.integer === false ? 0.1 : 1)}
            aria-label={input.title}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
            onBlur={commit}
          />
        </Row>
      );
    case "select":
      return (
        <Row label={input.title}>
          <select
            className={FIELD}
            value={String(value)}
            aria-label={input.title}
            onChange={(e) => onChange(e.target.value)}
          >
            {input.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </Row>
      );
    case "source":
      return (
        <Row label={input.title}>
          <select
            className={FIELD}
            value={String(value)}
            aria-label={input.title}
            onChange={(e) => onChange(e.target.value)}
          >
            {PRICE_SOURCES.map((source) => (
              <option key={source} value={source}>{PRICE_SOURCE_LABELS[source]}</option>
            ))}
          </select>
        </Row>
      );
    case "boolean":
      return (
        <Row label={input.title}>
          <button
            type="button"
            role="switch"
            aria-checked={value === true}
            aria-label={input.title}
            onClick={() => onChange(!(value === true))}
            className={`rounded px-3 py-1 text-sm transition-colors ${
              value === true
                ? "bg-accent/15 font-medium text-accent"
                : "bg-surface-2 text-ink-muted"
            }`}
          >
            {value === true ? "On" : "Off"}
          </button>
        </Row>
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

  return (
    <div className="rounded border border-border p-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={visible}
          aria-label={`Show ${plot.title}`}
          onClick={() => onChange({ visible: !visible })}
          className={`h-4 w-4 shrink-0 rounded-sm border transition-colors ${
            visible ? "border-accent bg-accent" : "border-border bg-surface-2"
          }`}
        />
        <span className="flex-1 truncate text-sm text-ink">{plot.title}</span>
        {value !== null && (
          <span className="tabular shrink-0 text-xs text-ink-muted">{value.toFixed(4)}</span>
        )}
      </div>

      <div className={`mt-2 flex flex-wrap items-center gap-2 ${visible ? "" : "opacity-40"}`}>
        <div role="group" aria-label={`${plot.title} colour`} className="flex gap-1">
          {PALETTE.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={swatch}
              aria-pressed={color.toLowerCase() === swatch.toLowerCase()}
              onClick={() => onChange({ color: swatch })}
              style={{ backgroundColor: swatch }}
              className={`h-5 w-5 rounded-sm border transition-transform ${
                color.toLowerCase() === swatch.toLowerCase()
                  ? "border-ink scale-110" : "border-transparent"
              }`}
            />
          ))}
        </div>
        <label className="flex items-center gap-1 text-xs text-ink-muted">
          Width
          <select
            className="rounded border border-border bg-surface-2 px-1 py-0.5 text-xs text-ink"
            value={width}
            aria-label={`${plot.title} width`}
            onChange={(e) => onChange({ width: Number(e.target.value) })}
          >
            {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-ink-muted">
          Style
          <select
            className="rounded border border-border bg-surface-2 px-1 py-0.5 text-xs text-ink"
            value={style}
            aria-label={`${plot.title} plot style`}
            onChange={(e) => onChange({ style: e.target.value as PlotDef["style"] })}
          >
            {PLOT_STYLES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
