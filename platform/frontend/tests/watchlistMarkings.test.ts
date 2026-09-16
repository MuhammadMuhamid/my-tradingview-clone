/**
 * TVP8 F-01 and F-05: the row's fitting arithmetic and the reader's markings.
 *
 * Everything here is a pure rule with a real consequence on screen — which
 * decimals survive a narrow column, which flag a symbol carries after a
 * reload, and where a band opens. The rendering that consumes them is covered
 * by `tests/dom/watchlistMarkings.test.tsx`.
 */
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { fitDecimals } from "../lib/fitNumeric";
import {
  FLAG_COLOURS, clearFlags, flagHex, readFlags, setFlag,
} from "../lib/watchlistFlags";
import {
  addSection, bandRows, readNotes, readSections, removeSection, setNote,
} from "../lib/watchlistSections";

/**
 * A minimal in-memory `localStorage`, installed as the global `window`.
 *
 * The same stand-in `tests/drawingStorePersistence.test.ts` uses: these are
 * node tests, and `lib/browserStorage` reads `window.localStorage` through an
 * accessor that returns null without one — which would make every persistence
 * assertion below pass vacuously.
 */
function installStorage(): Map<string, string> {
  const cells = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => cells.get(k) ?? null,
        setItem: (k: string, v: string) => { cells.set(k, v); },
        removeItem: (k: string) => { cells.delete(k); },
      },
    },
  });
  return cells;
}

let cells = new Map<string, string>();
beforeEach(() => { cells = installStorage(); });

// ── F-01: fitting a value to its track ─────────────────────────────────────

/** A stand-in for the real measurer: one pixel per character, exactly. */
const perChar = (text: string): number => text.length;

const price = (digits: number): string => (76024.04).toLocaleString("en-US", {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
});

test("F-01 — a value that fits keeps every decimal it has", () => {
  // `76,024.0` is 8 characters, and the track holds 12.
  assert.equal(fitDecimals(price, 1, 12, perChar), "76,024.0");
});

test("F-01 — a value that does not fit loses decimals one at a time, not all of them", () => {
  /*
   * The whole point of trimming rather than clipping: the reader loses the
   * least precision that makes the number fit, and never a number cut through
   * the middle of a glyph.
   */
  // `76,024.0400` is 11 characters and the track holds 10, so ONE decimal
  // comes off and three survive — not all four.
  assert.equal(fitDecimals(price, 4, 10, perChar), "76,024.040");
  assert.equal(fitDecimals(price, 4, 9, perChar), "76,024.04");
  assert.equal(fitDecimals(price, 4, 7, perChar), "76,024");
});

test("F-01 — a value that cannot fit at zero decimals is still the whole number", () => {
  // Clipping is the grid's job (`overflow: hidden`); this never invents a
  // shorter number by rounding the integer part away.
  assert.equal(fitDecimals(price, 4, 2, perChar), "76,024");
});

test("F-01 — an unmeasured column keeps full precision rather than guessing", () => {
  /*
   * Before the first layout is observed — and in every environment with no
   * canvas to measure with — there is no width. Trimming on a guess would show
   * a reader fewer decimals than their instrument has for no reason at all.
   */
  assert.equal(fitDecimals(price, 4, 0, perChar), "76,024.0400");
  assert.equal(fitDecimals(price, 4, 4, null), "76,024.0400");
});

// ── F-05: flags ────────────────────────────────────────────────────────────

test("F-05 — the palette is the reference's seven, and every one paints", () => {
  assert.deepEqual(FLAG_COLOURS.map((c) => c.id),
    ["red", "blue", "green", "orange", "purple", "cyan", "pink"]);
  for (const colour of FLAG_COLOURS) {
    assert.match(flagHex(colour.id) ?? "", /^#[0-9a-f]{6}$/i, colour.id);
  }
  assert.equal(flagHex(null), null);
});

test("F-05 — a flag survives a reload, which is the whole point of one", () => {
  setFlag({}, "BTCUSDT", "green");
  assert.equal(readFlags().BTCUSDT, "green",
    "a marking that is gone on the next load is a marking nobody makes twice");
});

test("F-05 — picking the colour a symbol already has clears it", () => {
  /*
   * What makes one swatch row a toggle rather than a seven-way radio with no
   * way back, and why the menu's first row reads `Unflag` once a symbol is
   * flagged.
   */
  const flagged = setFlag({}, "ETHUSDT", "blue");
  assert.deepEqual(setFlag(flagged, "ETHUSDT", "blue"), {});
  assert.deepEqual(setFlag(flagged, "ETHUSDT", null), {});
  assert.deepEqual(setFlag(flagged, "ETHUSDT", "red"), { ETHUSDT: "red" });
});

test("F-05 — `Unflag all symbols` clears every list's markings, and persists that", () => {
  setFlag(setFlag({}, "BTCUSDT", "red"), "SOLUSDT", "cyan");
  assert.deepEqual(clearFlags(), {});
  assert.deepEqual(readFlags(), {}, "and the cleared state is what reloads");
});

test("F-05 — a colour this build no longer has is dropped rather than rendered", () => {
  cells.set("tv.watchlist.flags.v1",
    JSON.stringify({ BTCUSDT: "chartreuse", ETHUSDT: "red" }));
  assert.deepEqual(readFlags(), { ETHUSDT: "red" });
});

// ── F-05: notes ────────────────────────────────────────────────────────────

test("F-05 — a note is kept against the SYMBOL, and an empty one is no note", () => {
  const notes = setNote({}, "BTCUSDT", "  waiting on the weekly close  ");
  assert.equal(notes.BTCUSDT, "waiting on the weekly close", "trimmed, not padded");
  assert.deepEqual(readNotes(), notes, "and it reloads");
  assert.deepEqual(setNote(notes, "BTCUSDT", "   "), {},
    "clearing the field is how a note comes off");
});

// ── F-05: sections ─────────────────────────────────────────────────────────

const ROWS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT"];
const band = (sections: Parameters<typeof bandRows>[3]) =>
  bandRows(ROWS, (s) => s, () => "Crypto", sections)
    .map((b) => [b.label, b.rows] as const);

test("F-05 — with no sections the list keeps its asset-class grouping", () => {
  assert.deepEqual(band([]), [["Crypto", ROWS]]);
});

test("F-05 — a section opens ABOVE the row it was added on, and runs to the next", () => {
  assert.deepEqual(band([{ beforeSymbol: "SOLUSDT", name: "Alts" }]), [
    ["Crypto", ["BTCUSDT", "ETHUSDT"]],
    ["Alts", ["SOLUSDT", "ADAUSDT"]],
  ]);
  assert.deepEqual(band([
    { beforeSymbol: "ETHUSDT", name: "Majors" },
    { beforeSymbol: "ADAUSDT", name: "Alts" },
  ]), [
    ["Crypto", ["BTCUSDT"]],
    ["Majors", ["ETHUSDT", "SOLUSDT"]],
    ["Alts", ["ADAUSDT"]],
  ]);
});

test("F-05 — a section on the first row takes the whole list", () => {
  assert.deepEqual(band([{ beforeSymbol: "BTCUSDT", name: "Everything" }]),
    [["Everything", ROWS]]);
});

test("F-05 — a section whose anchor left the list draws no header over nothing", () => {
  assert.deepEqual(band([{ beforeSymbol: "DOGEUSDT", name: "Gone" }]),
    [["Crypto", ROWS]]);
});

test("F-05 — sections belong to the list they were drawn on, and persist", () => {
  let sections = addSection({}, "list-a", "SOLUSDT", "Alts");
  sections = addSection(sections, "list-b", "BTCUSDT", "Core");
  assert.deepEqual(readSections(), sections, "both reload");
  assert.deepEqual(sections["list-b"], [{ beforeSymbol: "BTCUSDT", name: "Core" }],
    "naming a band on one list says nothing about another");

  // Asking again on the same anchor RENAMES rather than stacking a second
  // header on one row.
  sections = addSection(sections, "list-a", "SOLUSDT", "Altcoins");
  assert.deepEqual(sections["list-a"], [{ beforeSymbol: "SOLUSDT", name: "Altcoins" }]);

  sections = removeSection(sections, "list-a", "SOLUSDT");
  assert.equal(sections["list-a"], undefined);
  assert.deepEqual(readSections()["list-b"], [{ beforeSymbol: "BTCUSDT", name: "Core" }],
    "removing one list's band leaves the other's alone");
});
