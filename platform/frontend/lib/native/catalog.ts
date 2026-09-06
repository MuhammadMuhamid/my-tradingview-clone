"use client";
/**
 * The built-in catalog: every native study, and how the browser finds one.
 *
 * ── Why "Built-in" is now a truthful heading ───────────────────────────────
 *
 * The Indicators dialog deliberately had no Built-in tab, because this
 * installation shipped no bundled scripts and an empty tab is a promise rather
 * than a category. That is no longer true: the studies here are built in, they
 * compute in the browser from the bars a pane already holds, and they use the
 * same canonical maths the server alerts on.
 *
 * ── What the browser needs from a catalog ──────────────────────────────────
 *
 * Search that matches what a trader types — "BB" for Bollinger Bands, "DMI"
 * for ADX, "stoch rsi" for Stochastic RSI — plus categories, favourites and
 * recents. All four are ordinary functions over a list; none of them needs a
 * component, a context or a store, so none of them has one.
 *
 * ── Favourites and recents are per browser, deliberately ───────────────────
 *
 * They are a convenience about how one person works, not part of a chart. A
 * layout carries the studies APPLIED to it; a favourite is "I reach for this
 * often", which is the same shape of fact as which panel was last open. Both
 * are total on read: a corrupt or hand-edited entry yields an empty list
 * rather than a thrown error inside a dialog.
 */
import type { NativeCategory, NativeStudyDef } from "./registry";
import { TIER1_STUDIES } from "./tier1";
import { TREND_STUDIES } from "./trend";
import { MOMENTUM_STUDIES } from "./momentum";
import { VOLATILITY_STUDIES, VOLUME_STUDIES, STATISTICS_STUDIES } from "./volatility";
import { LEVEL_STUDIES } from "./levels";
import { PROFILE_STUDIES } from "./profile";

/** Every native study this build ships. */
/**
 * Every built-in, in the order a browser lists them.
 *
 * Tier 1 first because those are what a chart is opened to look at, then the
 * catalog by mathematical family. The order here is the only ordering the
 * product has: `populatedCategories` groups them, and search ranks within a
 * group, so nothing downstream depends on the position of a particular entry.
 */
export const NATIVE_STUDIES: readonly NativeStudyDef[] = [
  ...TIER1_STUDIES,
  ...TREND_STUDIES,
  ...MOMENTUM_STUDIES,
  ...VOLATILITY_STUDIES,
  ...VOLUME_STUDIES,
  ...STATISTICS_STUDIES,
  ...LEVEL_STUDIES,
  ...PROFILE_STUDIES,
];

const BY_ID = new Map(NATIVE_STUDIES.map((def) => [def.id, def]));

/**
 * A definition by its persisted id, or null.
 *
 * Null rather than a throw, and null rather than a substitute: a layout saved
 * by a later build may name a study this one does not have, and the right
 * behaviour is to say so and leave the rest of the layout intact. Silently
 * swapping in a different study would put a line on a chart the user did not
 * ask for and would not question.
 */
export function studyById(id: string): NativeStudyDef | null {
  return BY_ID.get(id) ?? null;
}

export const CATEGORY_LABELS: Record<NativeCategory, string> = {
  "moving-average": "Moving averages",
  trend: "Trend",
  momentum: "Momentum",
  volatility: "Volatility & channels",
  volume: "Volume & flow",
  levels: "Levels & structure",
  statistics: "Statistics",
};

/** Categories that actually contain something, in display order. */
export function populatedCategories(
  studies: readonly NativeStudyDef[] = NATIVE_STUDIES
): NativeCategory[] {
  const order: NativeCategory[] = [
    "moving-average", "trend", "momentum", "volatility", "volume", "levels", "statistics",
  ];
  return order.filter((category) => studies.some((s) => s.category === category));
}

/**
 * Search, ranked so the obvious match wins.
 *
 * exact id or name → alias → prefix → word start → substring → description.
 * Ranking rather than filtering is what makes a two-letter query useful: "BB"
 * matches Bollinger Bands by alias AND matches "Bollinger Band Width" by
 * substring, and the first must come first.
 */
export function searchStudies(
  query: string, studies: readonly NativeStudyDef[] = NATIVE_STUDIES
): NativeStudyDef[] {
  const term = query.trim().toLowerCase();
  if (term.length === 0) return [...studies];
  const scored: { def: NativeStudyDef; rank: number }[] = [];
  for (const def of studies) {
    const name = def.name.toLowerCase();
    const aliases = (def.aliases ?? []).map((a) => a.toLowerCase());
    let rank: number;
    if (def.id === term || name === term) rank = 0;
    else if (aliases.includes(term)) rank = 1;
    else if (name.startsWith(term) || aliases.some((a) => a.startsWith(term))) rank = 2;
    else if (name.split(/[\s/]+/).some((w) => w.startsWith(term))) rank = 3;
    else if (name.includes(term) || aliases.some((a) => a.includes(term))) rank = 4;
    else if (def.description.toLowerCase().includes(term)) rank = 5;
    else continue;
    scored.push({ def, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.def.name.localeCompare(b.def.name));
  return scored.map((s) => s.def);
}

// ── favourites and recents ──────────────────────────────────────────────────

export const FAVOURITES_KEY = "tv.nativeFavourites.v1";
export const RECENTS_KEY = "tv.nativeRecents.v1";
/** How many recents are worth remembering. A shortcut, not a history. */
export const MAX_RECENTS = 12;

function readIds(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    // Drop anything that is not a study this build has: a stale id would show
    // as a blank row in the browser rather than simply not showing.
    return parsed.filter((id): id is string => typeof id === "string" && BY_ID.has(id));
  } catch {
    return [];
  }
}

function writeIds(key: string, ids: readonly string[]): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, JSON.stringify(ids)); }
  catch { /* quota — these are a convenience, never a source of truth */ }
}

export function loadFavourites(): string[] { return readIds(FAVOURITES_KEY); }

export function toggleFavourite(id: string): string[] {
  if (!BY_ID.has(id)) return loadFavourites();
  const current = loadFavourites();
  const next = current.includes(id)
    ? current.filter((x) => x !== id)
    : [...current, id];
  writeIds(FAVOURITES_KEY, next);
  return next;
}

export function loadRecents(): string[] { return readIds(RECENTS_KEY); }

/** Most recent first, deduped, bounded. */
export function noteRecent(id: string): string[] {
  if (!BY_ID.has(id)) return loadRecents();
  const next = [id, ...loadRecents().filter((x) => x !== id)].slice(0, MAX_RECENTS);
  writeIds(RECENTS_KEY, next);
  return next;
}

/** Pure form of the recents rule, so the ordering can be tested without storage. */
export function withRecent(
  current: readonly string[], id: string, max = MAX_RECENTS
): string[] {
  return [id, ...current.filter((x) => x !== id)].slice(0, max);
}
