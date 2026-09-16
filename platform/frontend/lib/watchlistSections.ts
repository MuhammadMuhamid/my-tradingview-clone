/**
 * User sections and per-symbol notes — the two markings a reader puts on a
 * watchlist that are its reader's own rather than the market's.
 *
 * ── Why device-local ───────────────────────────────────────────────────────
 *
 * TVP8 F-05. A watchlist on the server is a NAME and an ordered set of
 * symbols; that is the contract `api.updateWatchlist` implements and the one
 * the correlation table, the first-run seeding and the ticker stream all read.
 * Encoding a section as a pseudo-symbol inside that array would have put
 * `section:Majors` into every one of those readers — a string no resolver
 * answers and no feed has a price for.
 *
 * So a section is an ANCHOR: the name of a band, and the symbol it opens
 * above. The list stays exactly what it was, the band is a view of it, and a
 * symbol that is removed takes its anchor with it rather than leaving a header
 * over nothing.
 */
import { recall, remember } from "./browserStorage";

const SECTION_KEY = "tv.watchlist.sections.v1";
const NOTE_KEY = "tv.watchlist.notes.v1";

export interface WatchlistSection {
  /** The row this band opens above. */
  beforeSymbol: string;
  name: string;
}

/** Sections per list id — a band belongs to the list it was drawn on. */
export type SectionMap = Readonly<Record<string, readonly WatchlistSection[]>>;

function readJson(key: string): Record<string, unknown> {
  const raw = recall(key);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export function readSections(): SectionMap {
  const out: Record<string, WatchlistSection[]> = {};
  for (const [listId, value] of Object.entries(readJson(SECTION_KEY))) {
    if (!Array.isArray(value)) continue;
    const rows = value.filter((row): row is WatchlistSection =>
      Boolean(row) && typeof row === "object"
      && typeof (row as WatchlistSection).beforeSymbol === "string"
      && typeof (row as WatchlistSection).name === "string");
    if (rows.length > 0) out[listId] = rows;
  }
  return out;
}

function writeSections(next: SectionMap): SectionMap {
  remember(SECTION_KEY, JSON.stringify(next));
  return next;
}

/**
 * Open a band above `beforeSymbol`.
 *
 * One band per anchor: asking again on a row that already opens a section
 * renames that section rather than stacking a second header on the same row.
 */
export function addSection(
  sections: SectionMap, listId: string, beforeSymbol: string, name: string,
): SectionMap {
  const current = sections[listId] ?? [];
  const without = current.filter((s) => s.beforeSymbol !== beforeSymbol);
  return writeSections({ ...sections, [listId]: [...without, { beforeSymbol, name }] });
}

export function removeSection(
  sections: SectionMap, listId: string, beforeSymbol: string,
): SectionMap {
  const current = sections[listId] ?? [];
  const next = current.filter((s) => s.beforeSymbol !== beforeSymbol);
  const out = { ...sections };
  if (next.length > 0) out[listId] = next; else delete out[listId];
  return writeSections(out);
}

/**
 * The rows, banded.
 *
 * With no user sections this is the asset-class grouping the panel has always
 * drawn (`fallback`). With them, a band runs from its anchor to the next one,
 * and whatever sits above the first anchor keeps the grouping it had — a user
 * who names the middle of their list does not lose the top of it.
 */
export function bandRows<T>(
  rows: readonly T[],
  symbolOf: (row: T) => string,
  fallback: (row: T) => string,
  sections: readonly WatchlistSection[],
): { label: string; rows: T[]; anchor: string | null }[] {
  const anchors = new Map(sections.map((s) => [s.beforeSymbol, s.name]));
  type Band = { label: string; rows: T[]; anchor: string | null };
  const out: Band[] = [];
  for (const row of rows) {
    const named = anchors.get(symbolOf(row));
    const current: Band | undefined = out[out.length - 1];
    if (named !== undefined) out.push({ label: named, rows: [], anchor: symbolOf(row) });
    // Outside a user band, the asset-class label still opens a band of its own
    // whenever it changes — which is the grouping this panel has always drawn.
    else if (current === undefined
      || (current.anchor === null && current.label !== fallback(row))) {
      out.push({ label: fallback(row), rows: [], anchor: null });
    }
    out[out.length - 1]!.rows.push(row);
  }
  return out;
}

// ── notes ──────────────────────────────────────────────────────────────────

export type NoteMap = Readonly<Record<string, string>>;

export function readNotes(): NoteMap {
  const out: Record<string, string> = {};
  for (const [symbol, value] of Object.entries(readJson(NOTE_KEY))) {
    if (typeof value === "string" && value.trim() !== "") out[symbol] = value;
  }
  return out;
}

/** An empty note is no note, so clearing the field removes the marking. */
export function setNote(notes: NoteMap, symbol: string, text: string): NoteMap {
  const next: Record<string, string> = { ...notes };
  if (text.trim() === "") delete next[symbol];
  else next[symbol] = text.trim();
  remember(NOTE_KEY, JSON.stringify(next));
  return next;
}
