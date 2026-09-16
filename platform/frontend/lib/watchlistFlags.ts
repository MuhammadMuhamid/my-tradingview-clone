/**
 * Watchlist flags — the coloured stub a user puts against a symbol.
 *
 * ── What a flag is for ─────────────────────────────────────────────────────
 *
 * TVP8 F-05. The reference's watchlist row menu opens on `Flag SYMBOL` and a
 * row of seven colours, and the flag is the only piece of state in that panel
 * that is the READER's rather than the market's: "these four are the ones I am
 * watching this morning", said in a colour, surviving a reload and a re-sort.
 * Everything else on the row is a price.
 *
 * Device-local rather than server-side, deliberately and for now: it is a
 * marking on a view, the same class of fact as which columns are shown and how
 * wide the panel is, all of which already live in `browserStorage`. A flag is
 * keyed by the SYMBOL, so it follows the instrument across every list it
 * appears on — which is what the reference does, and what `Unflag all symbols`
 * has to mean to be true.
 */
import { recall, remember } from "./browserStorage";

const KEY = "tv.watchlist.flags.v1";

/**
 * The seven, in the reference's own order.
 *
 * Named rather than hex-at-the-call-site so a flag can be READ back — the
 * stored value is the name, and a build that changes the palette does not
 * orphan everybody's markings.
 */
export const FLAG_COLOURS = [
  { id: "red", label: "Red", hex: "#f7525f" },
  { id: "blue", label: "Blue", hex: "#2962ff" },
  { id: "green", label: "Green", hex: "#22ab94" },
  { id: "orange", label: "Orange", hex: "#ff9800" },
  { id: "purple", label: "Purple", hex: "#9c27b0" },
  { id: "cyan", label: "Cyan", hex: "#00bcd4" },
  { id: "pink", label: "Pink", hex: "#e91e63" },
] as const;

export type FlagColour = (typeof FLAG_COLOURS)[number]["id"];

const VALID = new Set<string>(FLAG_COLOURS.map((c) => c.id));

/** The hex a flag paints with, or null for a colour this build no longer has. */
export function flagHex(colour: FlagColour | null): string | null {
  return FLAG_COLOURS.find((c) => c.id === colour)?.hex ?? null;
}

export type FlagMap = Readonly<Record<string, FlagColour>>;

export function readFlags(): FlagMap {
  const raw = recall(KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, FlagColour> = {};
    for (const [symbol, colour] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof colour === "string" && VALID.has(colour)) out[symbol] = colour as FlagColour;
    }
    return out;
  } catch { return {}; }
}

function write(next: FlagMap): FlagMap {
  remember(KEY, JSON.stringify(next));
  return next;
}

/**
 * Set, change or clear one symbol's flag.
 *
 * Passing the colour it already has clears it, which is what makes one swatch
 * row a toggle rather than a seven-way radio with no way back — and it is why
 * the menu's first row reads `Unflag` once a symbol is flagged.
 */
export function setFlag(flags: FlagMap, symbol: string, colour: FlagColour | null): FlagMap {
  const next: Record<string, FlagColour> = { ...flags };
  if (colour === null || next[symbol] === colour) delete next[symbol];
  else next[symbol] = colour;
  return write(next);
}

/** `Unflag all symbols` — every marking on every list, as the reference's does. */
export function clearFlags(): FlagMap {
  return write({});
}
