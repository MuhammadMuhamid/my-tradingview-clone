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

export interface IndicatorTemplate {
  name: string;
  createdAt: string;
  indicators: TemplateIndicator[];
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
  /*
   * An empty template is dropped rather than kept. It is not a useful state —
   * applying it does nothing — and keeping it would let a template whose rows
   * were ALL malformed survive as a name that promises studies it cannot
   * deliver, which is exactly the failure this parser exists to prevent.
   */
  if (indicators.length === 0) return null;
  return {
    name,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    indicators,
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
  })));
}

/** A template from what is currently on a pane. Run output is never captured. */
export function templateFromIndicators(
  name: string,
  list: readonly AppliedIndicator[],
  now: Date = new Date()
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
  if (template.indicators.length === 0) return { ok: false, reason: "no-indicators" };
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
