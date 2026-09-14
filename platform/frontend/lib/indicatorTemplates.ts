/**
 * Named sets of studies, saved locally.
 *
 * ── What a template is, and firmly is not ──────────────────────────────────
 *
 * A template is INDICATOR CONFIGURATION ONLY: which scripts, their sources and
 * their overridden inputs. It is not a workspace. It does not carry the
 * symbol, the timeframe, the pane arrangement, the strategy, the moving
 * averages or the drawings — a saved layout already owns those (`lib/layouts`)
 * and a second thing that half-restored a workspace would be a trap: applying
 * it would quietly move the chart you were about to trade from.
 *
 * ── Why this is safe to build here ─────────────────────────────────────────
 *
 * It is not a new persistence design. `lib/indicators` already serialises
 * exactly this shape to `localStorage` for every pane on every change
 * (`StoredIndicator`), so a template is that same record, named. Nothing about
 * the indicator engine changes, and a template that cannot be applied because
 * its script was deleted from the library still applies: the source travels
 * with it, the way an applied study's source already does.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 *
 * `serializeTemplates` sorts template names and each indicator's parameter
 * keys, so the stored text for a given set of studies is byte-identical
 * whatever order the operator added them in or the browser happened to
 * enumerate them. Indicator ORDER inside a template is preserved, because it is
 * meaningful — it decides which script's bar colouring paints last.
 *
 * ── Failure ────────────────────────────────────────────────────────────────
 *
 * Every read is total. A corrupt entry, a hand-edited file, a record written by
 * a future build: `parseTemplates` returns the templates it can prove are
 * well-formed and silently drops the rest. It never throws, and it never
 * repairs a half-valid template into something that looks applied but is not.
 */
import type { AppliedIndicator, PineParams } from "./indicators";
import type { IndicatorsApi } from "./useIndicators";
import type { NativeStudiesApi } from "./useNativeStudies";

export const TEMPLATE_STORAGE_KEY = "tv.indicatorTemplates.v1";

/** How many templates one browser keeps. A UI convenience, not an archive. */
export const MAX_TEMPLATES = 50;

export interface TemplateIndicator {
  /** Library script id, or null for a study applied straight from the editor. */
  scriptId: string | null;
  name: string;
  source: string;
  params: PineParams;
  visible: boolean;
}

/**
 * A BUILT-IN study in a template.
 *
 * TVP8: templates held Pine studies only, and silently dropped all 57
 * built-ins. Saving a template from a chart carrying RSI, MACD and Bollinger
 * Bands produced an empty template — or, once one Pine study was also applied,
 * a template that promised the lot and restored one. `docs/…PARITY_LEDGER.md`
 * recorded "Indicator templates … MATCH", which is what made it worth finding.
 *
 * `defId` rather than a script: a built-in is identified by which study it is,
 * and an id this build does not know degrades to nothing rather than throwing,
 * which is the same contract `AppliedNativeStudy` already has.
 */
export interface TemplateNativeStudy {
  defId: string;
  params: PineParams;
  visible: boolean;
  /** Per-plot style overrides, so a template restores how it LOOKED too. */
  styles: Record<string, Record<string, Primitive>>;
}

export interface IndicatorTemplate {
  name: string;
  createdAt: string;
  indicators: TemplateIndicator[];
  /** Built-in studies. Optional so a template written before TVP8 still reads. */
  studies: TemplateNativeStudy[];
}

type Primitive = number | string | boolean;

function isPrimitive(value: unknown): value is Primitive {
  return typeof value === "number" || typeof value === "string" || typeof value === "boolean";
}

/** Params, with keys in a fixed order and non-primitive values dropped. */
function normalizeParams(raw: unknown): PineParams {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: PineParams = {};
  for (const key of Object.keys(raw as Record<string, unknown>).sort()) {
    const value = (raw as Record<string, unknown>)[key];
    // A NaN or an Infinity would round-trip through JSON as `null` and then
    // reapply as a broken input, so they are dropped rather than carried.
    if (isPrimitive(value) && (typeof value !== "number" || Number.isFinite(value))) {
      out[key] = value;
    }
  }
  return out;
}

/** One template row, or null when the record cannot be trusted. */
function parseIndicator(raw: unknown): TemplateIndicator | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  // The source is the only field a study cannot be reconstructed without.
  if (typeof row.source !== "string" || row.source.length === 0) return null;
  return {
    scriptId: typeof row.scriptId === "string" ? row.scriptId : null,
    name: typeof row.name === "string" && row.name.length > 0 ? row.name : "Untitled script",
    source: row.source,
    params: normalizeParams(row.params),
    visible: row.visible !== false,
  };
}

function parseTemplate(raw: unknown): IndicatorTemplate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (name.length === 0) return null;
  if (!Array.isArray(row.indicators)) return null;
  const indicators = row.indicators
    .map(parseIndicator)
    .filter((i): i is TemplateIndicator => i !== null);
  const studies = Array.isArray(row.studies)
    ? row.studies.map(parseNativeStudy).filter((x): x is TemplateNativeStudy => x !== null)
    : [];
  /*
   * An empty template is dropped rather than kept. It is not a useful state —
   * applying it does nothing — and keeping it would let a template whose rows
   * were ALL malformed survive as a name that promises studies it cannot
   * deliver, which is exactly the failure this parser exists to prevent.
   */
  if (indicators.length === 0 && studies.length === 0) return null;
  return {
    name,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    indicators,
    studies,
  };
}

/** One built-in study row, or null when it is not well-formed. */
function parseNativeStudy(raw: unknown): TemplateNativeStudy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const defId = typeof row.defId === "string" ? row.defId.trim() : "";
  if (defId.length === 0) return null;
  const styles: Record<string, Record<string, Primitive>> = {};
  if (row.styles && typeof row.styles === "object" && !Array.isArray(row.styles)) {
    for (const [plot, value] of Object.entries(row.styles as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      styles[plot] = normalizeParams(value as Record<string, unknown>);
    }
  }
  return {
    defId,
    params: normalizeParams(row.params),
    visible: row.visible !== false,
    styles,
  };
}

/** Every well-formed template in the payload; never throws. */
export function parseTemplates(raw: string | null | undefined): IndicatorTemplate[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: IndicatorTemplate[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const template = parseTemplate(entry);
    if (!template) continue;
    const key = template.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(template);
  }
  return sortTemplates(out).slice(0, MAX_TEMPLATES);
}

function sortTemplates(list: readonly IndicatorTemplate[]): IndicatorTemplate[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

/** Deterministic text for a set of templates — the same input gives the same bytes. */
export function serializeTemplates(list: readonly IndicatorTemplate[]): string {
  return JSON.stringify(sortTemplates(list).map((t) => ({
    name: t.name,
    createdAt: t.createdAt,
    indicators: t.indicators.map((i) => ({
      scriptId: i.scriptId,
      name: i.name,
      source: i.source,
      params: normalizeParams(i.params),
      visible: i.visible,
    })),
    // TVP8: the built-ins. Written in the same fixed key order as everything
    // else here, because "the same input gives the same bytes" is what this
    // function's name promises and a round-trip test depends on.
    studies: t.studies.map((study) => ({
      defId: study.defId,
      params: normalizeParams(study.params),
      visible: study.visible,
      styles: Object.fromEntries(
        Object.keys(study.styles).sort()
          .map((plot) => [plot, normalizeParams(study.styles[plot] ?? {})])),
    })),
  })));
}

/** A template from what is currently on a pane. Run output is never captured. */
export function templateFromIndicators(
  name: string,
  list: readonly AppliedIndicator[],
  now: Date = new Date(),
  studies: readonly TemplateStudySnapshot[] = [],
): IndicatorTemplate {
  return {
    name: name.trim(),
    createdAt: now.toISOString(),
    indicators: list.map((i) => ({
      scriptId: i.scriptId,
      name: i.name,
      source: i.source,
      params: normalizeParams(i.params),
      visible: i.visible,
    })),
    studies: studies.map((s) => ({
      defId: s.defId,
      params: normalizeParams(s.params),
      visible: s.visible,
      styles: Object.fromEntries(
        Object.entries(s.styles).map(
          ([plot, style]) => [plot, normalizeParams(style as Record<string, unknown>)])),
    })),
  };
}

/**
 * One built-in study as a template captures it.
 *
 * Named rather than written inline at the two call sites that build one,
 * because the toolbar's template menu now builds the same record from a
 * different pane's list and a second spelling of this shape is how the Pine
 * half and the built-in half drifted apart the first time.
 */
export interface TemplateStudySnapshot {
  defId: string;
  params: Record<string, unknown>;
  visible: boolean;
  styles: Readonly<Record<string, object>>;
}

/** What applying a template actually did — see `applyTemplateTo`. */
export interface TemplateApplication {
  applied: number;
  /** Study ids the template names and this build has no definition for. */
  missing: string[];
}

/**
 * Put a template's studies on a pane.
 *
 * ── Why this is here and not in the control that opens the menu ────────────
 *
 * It used to be a method of the Indicators BROWSER, and the browser is no
 * longer where templates live (R3-06). Rather than move it into the toolbar
 * menu — which would put "what applying means" inside a popover — it is a
 * function over the two study APIs, so the browser, the menu, a command
 * palette entry and a test all get the identical behaviour.
 *
 * `replace` is the caller's decision and is NOT taken here: clearing a chart
 * is destructive and must be confirmed against a count the user can see, which
 * is a question only a UI can ask.
 *
 * A `defId` this build has no definition for — a template written by a newer
 * build, or carried from an installation with a study this one has dropped —
 * is REPORTED rather than skipped. The loop used to `continue` and the status
 * line then said "Applied", so the only way to notice a missing indicator was
 * to count the legend.
 */
export function applyTemplateTo(
  template: IndicatorTemplate,
  indicators: IndicatorsApi | null,
  nativeStudies: NativeStudiesApi | null,
): TemplateApplication {
  const missing: string[] = [];
  for (const study of template.studies) {
    const key = nativeStudies?.add(study.defId, study.params);
    if (!key) { missing.push(study.defId); continue; }
    // A template restores how the chart LOOKED, not only what was on it.
    for (const [plot, style] of Object.entries(study.styles)) {
      nativeStudies?.setStyle(key, plot, style as Record<string, never>);
    }
    if (!study.visible) nativeStudies?.toggleVisible(key);
  }
  for (const row of template.indicators) {
    if (!indicators) { missing.push(row.name); continue; }
    const key = indicators.add({
      scriptId: row.scriptId, name: row.name, source: row.source, params: row.params,
    });
    // `add` always starts visible; a template that stored a hidden study
    // restores it hidden.
    if (!row.visible) indicators.toggleVisible(key);
  }
  return {
    applied: template.indicators.length + template.studies.length - missing.length,
    missing,
  };
}

export function findTemplate(
  list: readonly IndicatorTemplate[], name: string
): IndicatorTemplate | null {
  const needle = name.trim().toLowerCase();
  return list.find((t) => t.name.toLowerCase() === needle) ?? null;
}

export type UpsertResult =
  | { ok: true; list: IndicatorTemplate[] }
  | { ok: false; reason: "empty-name" | "no-indicators" | "exists" | "full" };

/**
 * Add or replace a template.
 *
 * Replacing an existing name requires `overwrite`, so a save cannot quietly
 * destroy a template the operator built earlier. The caller asks; this refuses
 * until it has been asked twice.
 */
export function upsertTemplate(
  list: readonly IndicatorTemplate[],
  template: IndicatorTemplate,
  options: { overwrite?: boolean } = {}
): UpsertResult {
  const name = template.name.trim();
  if (name.length === 0) return { ok: false, reason: "empty-name" };
  /*
   * TVP8 round two: built-ins count here too.
   *
   * `templateFromIndicators` learned to carry the 57 built-in studies, and
   * this guard did not — so a chart with three built-ins and no Pine script
   * was still refused with "put at least one study on the chart first", which
   * is the defect the commit that added them claims to have fixed.
   */
  if (template.indicators.length === 0 && template.studies.length === 0) {
    return { ok: false, reason: "no-indicators" };
  }
  const existing = findTemplate(list, name);
  if (existing && !options.overwrite) return { ok: false, reason: "exists" };
  if (!existing && list.length >= MAX_TEMPLATES) return { ok: false, reason: "full" };
  const kept = list.filter((t) => t.name.toLowerCase() !== name.toLowerCase());
  return { ok: true, list: sortTemplates([...kept, { ...template, name }]) };
}

export function deleteTemplate(
  list: readonly IndicatorTemplate[], name: string
): IndicatorTemplate[] {
  const needle = name.trim().toLowerCase();
  return list.filter((t) => t.name.toLowerCase() !== needle);
}

// ── local persistence, following `lib/indicators`' conventions ─────────────

export function loadTemplates(): IndicatorTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    return parseTemplates(window.localStorage.getItem(TEMPLATE_STORAGE_KEY));
  } catch {
    // A blocked or disabled localStorage is not an error worth surfacing:
    // templates are a convenience, and the studies on the chart are unaffected.
    return [];
  }
}

export function saveTemplates(list: readonly IndicatorTemplate[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TEMPLATE_STORAGE_KEY, serializeTemplates(list));
  } catch { /* quota — the templates already on screen still apply this session */ }
}
