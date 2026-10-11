/**
 * The drawing rail's taxonomy, as an assertion.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * TVP7 regrouped the rail from eleven ad-hoc groups into the reference's seven
 * families plus one Trading Scene group, and generalised the DOM harness's
 * `selectTool` so it opens whichever flyout holds a tool instead of assuming
 * every tool is the head of some group. That generalisation was necessary —
 * the old helper encoded the old taxonomy — but it also removed the only thing
 * in the suite that could notice a tool going missing from the rail, because
 * a tool that is in NO group simply makes `selectTool` throw in whichever test
 * happens to use it, and most of the 87 are used by none.
 *
 * So the taxonomy is pinned here directly, against the tool union itself:
 * every declared tool is reachable, exactly once, from a named group. A tool
 * added to `drawings.ts` without a rail entry fails this file rather than
 * shipping as dead code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  EMOJI_CATEGORIES, FILLABLE_TOOLS, ICON_GLYPHS, OUTLINE_CATEGORIES, TOOL_POINTS,
  type DrawingTool,
} from "../lib/drawings";
import { BINDINGS } from "../lib/shortcuts";

const RAIL = path.join(__dirname, "..", "components", "tv", "DrawingToolbar.tsx");
const source = fs.readFileSync(RAIL, "utf8");
const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/**
 * `{ tool: "trend", icon: "trend", label: "Trendline" }`, per group.
 *
 * Matched on `tool:` rather than on `{ tool:` because a long label wraps the
 * entry onto three lines — `vprange` does — and a parser that only saw the
 * one-line form would report a perfectly reachable tool as missing.
 *
 * TVP8 round three: a group's tools moved one level deeper, into the
 * reference's own `sections` ("Lines", "Channels", "Pitchforks"). The chunking
 * is therefore anchored on a TOP-LEVEL entry — a newline, exactly two spaces
 * and an opening brace — which the nested section objects, indented four
 * further, cannot produce. Both registries are read: `SINGLES` is where the
 * Measure and Zoom-in cells live, and `ruler` is only reachable through it.
 */
function entriesOf(name: string): { id: string; tools: string[]; icons: string[] }[] {
  const start = source.indexOf(`const ${name}`);
  const end = source.indexOf("\n];", start);
  assert.ok(start > 0 && end > start, `the rail no longer declares ${name}`);
  const block = source.slice(start, end);
  const entries: { id: string; tools: string[]; icons: string[] }[] = [];
  for (const chunk of block.split(/\n {2}\{/).slice(1)) {
    const id = /id: "([^"]+)"/.exec(chunk)?.[1];
    if (!id) continue;
    entries.push({
      id,
      tools: [...chunk.matchAll(/\btool: "([^"]+)"/g)].map((m) => m[1]!),
      icons: [...chunk.matchAll(/icon: "([^"]+)"/g)].map((m) => m[1]!),
    });
  }
  return entries;
}

const railGroups = (): { id: string; tools: string[]; icons: string[] }[] =>
  entriesOf("GROUPS");

/** Every cell that arms a tool: the eight groups plus the two singles. */
const railCells = (): { id: string; tools: string[]; icons: string[] }[] =>
  [...entriesOf("GROUPS"), ...entriesOf("SINGLES")];

test("every declared drawing tool is reachable from exactly one rail group", () => {
  const groups = railCells();
  const railed = groups.flatMap((g) => g.tools);
  const declared = Object.keys(TOOL_POINTS) as DrawingTool[];

  const missing = declared.filter((t) => !railed.includes(t));
  assert.deepEqual(missing, [],
    `declared but unreachable from the rail: ${missing.join(", ")}`);

  const unknown = railed.filter((t) => !declared.includes(t as DrawingTool));
  assert.deepEqual(unknown, [],
    `on the rail but not a declared tool: ${unknown.join(", ")}`);

  const seen = new Map<string, number>();
  for (const t of railed) seen.set(t, (seen.get(t) ?? 0) + 1);
  const duplicated = [...seen].filter(([, n]) => n > 1).map(([t]) => t);
  assert.deepEqual(duplicated, [],
    `a tool in two groups has two homes and one of them is wrong: ${duplicated.join(", ")}`);
});

test("the rail's groups are the reference's families", () => {
  /*
   * These ids are TradingView's own, read off its live rail. They are asserted
   * because rail muscle memory is entirely group-POSITION based: a user
   * reaching for XABCD expects the patterns group to be fourth, and a rename
   * or a reorder here is a user-visible change that should be deliberate.
   *
   * `anchored` is gone. It was Trading Scene's own eighth group, holding
   * Anchored VWAP and the two volume profiles — and it sat in the cell where
   * the reference has Icons, so the eighth silhouette in the column was a
   * curve-from-a-dot where a user arriving from the reference expects a
   * smiley. The three tools moved into the forecasting group's "Volume-based"
   * section, which is where the reference files them.
   */
  assert.deepEqual(railGroups().map((g) => g.id), [
    "cursors",
    "trend-line",
    "gann-and-fibonacci",
    "patterns",
    "prediction-and-measurement",
    "geometric-shapes",
    "annotation",
    "icons",
  ]);

  /*
   * And the two cells between the groups and the magnet, which are ONE tool
   * each rather than a group. `ruler` used to be the first entry of the
   * forecasting group, so the fifth rail cell showed a ruler where the
   * reference shows a position box — the most visible of the three wrong
   * defaults this round fixed.
   */
  assert.deepEqual(entriesOf("SINGLES").map((g) => g.id), ["measure", "zoom-in"]);
});

test("each group's FIRST tool is the silhouette the reference rests on", () => {
  /*
   * The rail shows the group's current tool, and its current tool starts as
   * the first entry. Three of the eight were wrong: a ruler in the forecasting
   * cell, a rectangle in the shapes cell, an Anchored-VWAP curve in the eighth.
   * Read off the live reference at 1440x900 dark.
   */
  assert.deepEqual(
    railGroups().map((g) => g.tools[0]),
    ["cursor", "trend", "fib", "xabcd", "long", "brush", "text", "icon"],
  );
});

test("no group is deeper than a flyout can show without scrolling to reach", () => {
  /*
   * The `advanced` group this replaced held 38 tools. At the measured 40px row
   * height that is 1520px of flyout in a 900px window, and the flyout had no
   * height cap — so roughly its bottom sixteen tools rendered below the fold
   * with nothing to scroll. They were not hard to find; they could not be
   * clicked.
   *
   * The flyout now caps its height and scrolls, so depth is survivable. This
   * still holds the groups to a size a human can scan, which is the actual
   * point of having groups.
   */
  for (const group of railGroups()) {
    assert.ok(group.tools.length <= 20,
      `${group.id} holds ${group.tools.length} tools — split it the way the reference does`);
  }
});

test("every rail icon key exists, so no tool silently wears another tool's glyph", () => {
  /*
   * `barsPattern` asked for `icon: "bars"`, which `ICONS` never had. `Icon`
   * falls back to the trend-line glyph, so Bars Pattern shipped wearing
   * another tool's picture with nothing anywhere reporting the mismatch.
   */
  const icons = new Set(
    [...source.slice(source.indexOf("const ICONS"), source.indexOf("const GROUPS"))
      .matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]!)
  );
  assert.ok(icons.size > 40, `parsed only ${icons.size} icons — the ICONS shape changed`);
  for (const group of railCells()) {
    for (const key of group.icons) {
      assert.ok(icons.has(key), `${group.id} references a missing icon key: ${key}`);
    }
  }

  /*
   * And no two tools wear the SAME glyph.
   *
   * Thirty-five did: every Gann tool was the rectangle, every harmonic pattern
   * was the polyline, three Fibonacci variants were the retracement, all four
   * pitchforks were one fork. A rail is aimed at from shape memory, so two
   * tools with one shape are two tools whose label you have to read — which is
   * the whole cost the rail exists to remove.
   */
  const used = railCells().flatMap((g) => g.icons);
  const seen = new Map<string, number>();
  for (const key of used) seen.set(key, (seen.get(key) ?? 0) + 1);
  const shared = [...seen].filter(([, n]) => n > 1).map(([key]) => key);
  assert.deepEqual(shared, [],
    `these glyphs are worn by more than one tool: ${shared.join(", ")}`);
});

test("RAIL — the flyout affordance keeps the name the DOM harness addresses it by", () => {
  /*
   * The reference draws nothing on a group cell at rest and reveals an 11x34
   * strip with a chevron on hover or while the flyout is open; this rail wore
   * a permanent 24x24 corner triangle on all eight. The strip replaced it —
   * and `tests/dom/harness/chart.tsx#selectTool` finds every flyout by
   * `aria-label="More <id> tools"`, so the name is load-bearing for the whole
   * DOM suite and is pinned here rather than discovered by a failing test
   * three files away.
   */
  assert.match(source, /aria-label=\{`More \$\{id\} tools`\}/);
  assert.match(source, /h-\[34px\] w-\[11px\]/);
  assert.match(source, /opacity-0 transition-none group-hover:opacity-100/);

  // And the four option cells have one too, so Magnet, Lock, Hide and Remove
  // are reachable the same way.
  for (const id of ["magnet", "lock", "hide", "remove"]) {
    assert.ok(source.includes(`strip("${id}"`), `the ${id} cell has no flyout strip`);
  }
});

test("RAIL — Remove is never disabled and carries no count label", () => {
  /*
   * It was `disabled={count === 0}` with `disabled:opacity-30` and a `<span>`
   * printing the count underneath — so on an empty chart the cell was the only
   * dimmed control in the column, and on a busy one it was the only one with a
   * number under it. The reference does neither; its Remove cell is full ink
   * always and its flyout carries the counts, one per scope.
   */
  assert.match(source, /aria-label="Remove objects"/);
  assert.doesNotMatch(source, /disabled=\{count/,
    "the cell must stay pressable on an empty chart");
  assert.doesNotMatch(source, /disabled:opacity/,
    "and it must stay at full ink");
  assert.doesNotMatch(source, /\{count > 0 && <span/,
    "the count belongs in the flyout's rows, not under the cell");
  assert.match(source, /Remove \$\{count\} drawing/);
});

test("RAIL — every icon-only control has a NAME, not only a tooltip", () => {
  /*
   * These buttons hold a 28px SVG and no text, so their accessible name fell
   * through to `title` — the last resort in the name algorithm, and the only
   * control family in this product that relied on it. `aria-pressed` was
   * already here (an earlier wave added it, with a comment about exactly this
   * class of invisibility) which made the gap easy to miss: the rail ANNOUNCED
   * ITS STATE while having no name to attach that state to.
   *
   * Found by driving the production build and failing to address a tool by its
   * accessible name.
   */
  const src = source;
  /*
   * Split on `<button`, not matched with a lazy `[\s\S]*?>`.
   *
   * That version stopped at the first `>` in the tag — which for
   * `onClick={() => …}` is the ARROW. Seven of the nine buttons truncated to
   * `"<button onClick={() =>"`, contained no `title=`, fell out of the filter,
   * and the assertion ran against an empty array: the rule passed whether or
   * not those buttons had a name. Caught by an adversarial pass, and it is
   * verbatim the failure this campaign's own contract test condemns — a rule
   * that only catches the formatting it was written against.
   */
  const buttons = src.split("<button").slice(1).map((chunk) => {
    // The tag ends at the first `>` that is not inside braces or quotes.
    let depth = 0, quote = "";
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (quote) { if (c === quote) quote = ""; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) return chunk.slice(0, i);
    }
    return chunk;
  });
  assert.equal(buttons.length, (src.match(/<button/g) ?? []).length);
  assert.ok(buttons.length >= 8, `only ${buttons.length} buttons parsed`);

  /*
   * Icon-only means it has no TEXT to be named by — not that it has no
   * `aria-label`. The flyout rows carry `<span>{t.label}</span>` and are named
   * by their content, correctly and without an attribute; the rail's own
   * buttons hold nothing but an `<Icon>` and must say who they are.
   */
  const bodies = src.split("<button").slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("</button>")));
  const iconOnly = buttons.filter((tag, i) => {
    // `tag` is the attribute text, already parsed past the arrow functions —
    // slicing on the first `>` here would land on one of them again, which is
    // the same mistake one level down.
    const inner = bodies[i]!.slice(tag.length + 1);
    /*
     * An `aria-hidden` span is NOT text for this purpose.
     *
     * TVP8 gave every rail control the product's own tooltip pill instead of
     * the OS `title` — and the pill is a `<span aria-hidden="true">` inside
     * the button. Matching a bare `<span` therefore quietly excused every rail
     * button from the rule at the moment they all grew one: the assertion
     * would have kept passing over a button with no name at all.
     */
    const hasText = /<span(?![^>]*aria-hidden)|\{[a-zA-Z].*\.label\}|>[A-Za-z0-9]/.test(inner);
    return !hasText && !/aria-label/.test(tag);
  });
  assert.deepEqual(iconOnly, [],
    "an icon-only rail button must carry aria-label, not only title:\n"
    + iconOnly.map((b) => b.replace(/\s+/g, " ").slice(0, 90)).join("\n"));

  // And the icon itself is decoration, so it never competes for the name.
  assert.match(src, /const Icon = [\s\S]{0,320}aria-hidden="true"/);
});

test("THE SELECTED-DRAWING TOOLBAR OFFERS SETTINGS AND CLONE", () => {
  /*
   * TVP8. The reference's floating toolbar over a selected drawing carries
   * colour, width, style, Settings, Clone, lock, delete and a "more" menu.
   * This one had the style half and the lock/delete half — so the Coordinates
   * tab, the text tab and every per-tool option lived behind a right-click
   * nobody had been told about, and Clone had no route at all outside ⌘D.
   */
  const canvas = read("components/tv/DrawingCanvas.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  assert.match(canvas, /aria-label="Settings for this drawing"/);
  assert.match(canvas, /aria-label="Clone this drawing"/);

  // Settings opens the SAME menu the right-click opens, rather than a second
  // route into the dialog that could drift from it.
  assert.match(canvas, /handler\(\{\s*x: Math\.round\(box\.left\), y: Math\.round\(box\.bottom \+ 4\),/);
  assert.match(canvas, /drawingId: sel\.id, price: null, region: "plot",/);

  // Clone goes through `cloneDrawing`, which is what ⌘D uses — a second copy
  // of "offset it so it does not land exactly on the original" would be one
  // more thing to keep in step.
  assert.match(canvas, /cloneDrawing\(sel, newId, resolutionMs\(interval\) \/ 1000\)/);
});

test("FILL IS OFFERED ONLY WHERE THERE IS AN INTERIOR TO FILL", () => {
  /*
   * TVP8: the Fill button was on all 87 tools and read by five. Toggling it on
   * a trend line or a Fibonacci retracement did nothing, silently — and a
   * control that does nothing is worse than a missing one, because it costs
   * the user the time to find out.
   */
  const canvas = read("components/tv/DrawingCanvas.tsx");
  assert.match(canvas, /\{FILLABLE_TOOLS\.has\(sel\.tool\) && \(/);
  assert.deepEqual([...FILLABLE_TOOLS].sort(),
    ["circle", "ellipse", "rect", "rotatedRectangle", "sector", "triangle"]);

  // Every one of them is a tool that exists.
  for (const tool of FILLABLE_TOOLS) {
    assert.ok(tool in TOOL_POINTS, `${tool} is not a drawing tool`);
  }
});

/*
 * ── TVP8 / R2b: the rail's PIXELS ──────────────────────────────────────────
 *
 * The round-2 review judged the rail on sampled pixels: stroke luminance,
 * glyph bounding boxes, the lit state of the 11px strip, where a flyout's
 * icon column starts. None of that can be measured in jsdom — it has no
 * layout and no rasteriser — so what is pinned below is the INPUT to each of
 * those measurements: the grid the glyphs are drawn on, the weight they are
 * stroked at, the silhouette features the review named one by one, and the
 * geometry classes that place a row. A regression in any of them is what the
 * next pixel capture would report, one capture later.
 */

test("RAIL — the glyph set is drawn on the reference's 28px grid, crisply", () => {
  /*
   * R2b-02. The set was a 24-unit viewBox rendered at 28px with a 0.9 stroke:
   * a 1.05px line on a fractional grid, so every horizontal and vertical
   * straddled two device pixels and the rail sampled at a peak luminance of
   * 140 against the reference's 219. The armed Cross was the DIMMEST glyph in
   * the column.
   */
  assert.match(source, /viewBox="0 0 28 28"/,
    "one unit must be one pixel, or half-pixel coordinates mean nothing");
  const weight = /strokeWidth="(1|1\.25)"[\s\S]{0,120}ICONS\[name\]/.exec(source);
  assert.ok(weight, "the icon stroke is no longer the 1 / 1.25 R2b-02 allows");
  assert.match(source, /const Icon = \(\{ name, size = 28 \}/);

  /*
   * And the axis-aligned strokes sit on half-units, which is the whole reason
   * the grid was changed. Sampled across the set rather than asserted on one
   * glyph: a single example would be satisfied by a single edit.
   */
  const block = source.slice(source.indexOf("const ICONS"), source.indexOf("const Icon ="));
  const horizontals = [...block.matchAll(/[Mm][\d.]+ ([\d.]+)h/g)].map((m) => m[1]!);
  assert.ok(horizontals.length > 20, `only ${horizontals.length} horizontal strokes found`);
  const offGrid = horizontals.filter((y) => !y.endsWith(".5"));
  assert.deepEqual(offGrid, [],
    `these horizontals land between pixels and will render as two greys: ${offGrid.join(", ")}`);
});

test("RAIL — the silhouettes the review named are the ones the set draws", () => {
  /*
   * R2b-01 and the blind review's rail list, feature by feature. Each of these
   * is the thing that made the cell identifiable as NOT the reference at a
   * glance, so each is pinned as the shape it now is rather than as a
   * screenshot nobody will diff.
   */
  const block = source.slice(source.indexOf("const ICONS"), source.indexOf("const Icon ="));
  /*
   * A glyph's whole entry, including the multi-line ones.
   *
   * Anchored on the NEXT top-level key (a newline, exactly two spaces, a
   * letter) rather than on the next `\n  `: half this set is written over
   * several lines indented four, and `\n  ` is a prefix of `\n    `, so the
   * naive version returned the first line of every composite glyph — and
   * "XABCD has five nodes" would have been asserted against one of them.
   */
  const glyph = (key: string): string => {
    const start = block.indexOf(`\n  ${key}: `);
    assert.ok(start > 0, `no ${key} glyph`);
    const rest = block.slice(start + 3 + key.length);
    const end = /\n {2}(?:[A-Za-z]|\}|\/\/)/.exec(rest);
    return rest.slice(0, end ? end.index : rest.length);
  };

  /*
   * Fib: the dot on an UPPER level is at its right end, the lower one's at its
   * left. They were mirrored (R2b-01) and they have since MOVED, because
   * R2c-09 redrew the glyph to the reference's ink box — four levels at
   * y = 4.5 / 10.5 / 16.5 / 22.5 across a 26-unit span instead of the old
   * 22-unit one. The assertion is the RULE (which end each dot is at),
   * re-anchored on the coordinates that rule now produces, rather than a
   * screenshot of the old geometry.
   */
  const fib = glyph("fib");
  assert.match(fib, /cx="23\.5" cy="10\.5"/, "the upper fib dot is not at the right end");
  assert.match(fib, /cx="3\.5" cy="22\.5"/, "the lower fib dot is not at the left end");

  // XABCD: five nodes and the crossing strokes, not an open zigzag.
  const xabcd = glyph("xabcd");
  assert.equal((xabcd.match(/<circle/g) ?? []).length, 5, "XABCD is not five-node");
  assert.ok((xabcd.match(/M[\d.]/g) ?? []).length >= 6,
    "XABCD has no crossing X–B / A–C strokes");

  // Long/short: two rails with end dots and an L bracket, not a 2x2 table.
  for (const key of ["long", "short"]) {
    const g = glyph(key);
    assert.equal((g.match(/<rect/g) ?? []).length, 0, `${key} is still drawn as boxes`);
    assert.equal((g.match(/<circle/g) ?? []).length, 2, `${key} has no rail end dots`);
  }

  // Magnet: a horseshoe with two rectangular pole caps — four legs, two arcs.
  const magnet = glyph("magnet");
  assert.equal((magnet.match(/v11/g) ?? []).length, 4, "the magnet has no four legs");
  assert.equal((magnet.match(/a[\d.]+ [\d.]+ 0 0 1/g) ?? []).length, 2,
    "the magnet is not a horseshoe (outer and inner arc)");

  // Keep drawing: a pencil with a PADLOCK badge, not a pencil on a baseline.
  const keep = glyph("stayInDrawingMode");
  assert.match(keep, /<rect/, "the keep-drawing pencil carries no padlock body");
  assert.match(keep, /a2 2 0 0 1 4 0/, "and no padlock shackle");

  // Hide: an eye with a badge at its lower right, not a plain eye.
  assert.ok(glyph("eye").includes("M14.5 24.5l1.5-6"), "the eye carries no badge");

  // Channels and pitchforks: the reference's nodal silhouettes.
  assert.equal((glyph("parallel").match(/<circle/g) ?? []).length, 3);
  assert.equal((glyph("flatTopBottom").match(/<circle/g) ?? []).length, 4);
  assert.equal((glyph("disjointChannel").match(/<circle/g) ?? []).length, 4);
  assert.match(glyph("regression").replace(/\s+/g, " "), /M5\.5 10\.5L21\.5 2\.5M5\.5 24\.5L21\.5 16\.5/,
    "the regression band has lost one of its two parallel edges");
  for (const fork of [
    "pitchfork", "schiffPitchfork", "modifiedSchiffPitchfork", "insidePitchfork",
  ]) {
    const tines = glyph(fork).match(/l[69]-[69]/g) ?? [];
    assert.equal(tines.length, 3, `${fork} does not draw three tines`);
  }
});

test("RAIL — the first flyout prints all five of the reference's hotkeys", () => {
  /*
   * R2b-05. `BINDINGS` has declared ⌥J, ⌥C and ⌥⇧R since TVP7; `TOOL_ACTION`
   * knew six tools, so the first flyout a user opens printed three caps of
   * five and Rectangle printed none.
   */
  const map = source.slice(source.indexOf("const TOOL_ACTION"), source.indexOf("function altBinding"));
  for (const [tool, action] of [
    ["hray", "tool:horizontal-ray"], ["crossline", "tool:crossline"], ["rect", "tool:rectangle"],
  ] as const) {
    assert.ok(map.includes(`${tool}: "${action}"`), `${tool} prints no key cap`);
    assert.ok(
      BINDINGS.some((b) => b.action === action && b.alt === true),
      `${action} has no ⌥ binding to print`
    );
  }

  // And the cap is printed modifier-then-key with a thin space (R2b-12): at
  // 12px `⌥T` reads as one unfamiliar glyph, `⌥ T` as an instruction.
  assert.match(source, /return `\$\{mods\.join\(""\)\}\\u2009\$\{key\}`/);
  assert.match(source, /text-\[12px\][\s\S]{0,40}text-ink-faint/);
});

test("RAIL — the edge strip is a control with its own lit chip", () => {
  /*
   * R2b-08. The strip was an invisible hit-zone that revealed a chevron: with
   * a flyout open, the cell showed a bare glyph on black and nothing said
   * which control held the menu. `.tvc-control` cannot be borrowed here — the
   * rail scopes its chip to `inset: 2px 9px`, a negative width on an 11px
   * strip — so the state grammar is spelled out at the strip's own size.
   */
  const strip = source.slice(source.indexOf("const strip = ("), source.indexOf("/**\n   * One 40px tool row"));
  assert.match(strip, /rounded-\[4px\]/);
  assert.match(strip, /hover:bg-state-hover/);
  assert.match(strip, /data-\[open=true\]:bg-state-hover/);
  assert.doesNotMatch(strip, /title=/,
    "the strip names itself with the product's pill, not the OS tooltip");
});

test("RAIL — every cell names itself in the product's chrome, not the OS tooltip", () => {
  /*
   * R2b-14. `title` is drawn by the operating system, half a second late, in
   * a font and on a ground the theme cannot reach — the one piece of chrome in
   * this workstation that does not obey it. The pill replaces it on the rail's
   * own cells; the FLYOUT rows keep `title`, because there it carries a hint
   * ("Click points, double-click to finish") rather than the row's name, which
   * the row already prints.
   */
  const rail = source.slice(source.indexOf("  return (\n    <div\n      ref={railRef}"));
  assert.doesNotMatch(rail, /\btitle=\{?"?(Remove objects|Measure)/);
  assert.match(source, /const tip = \(label: string, trigger: "peer" \| "group"/);
  assert.match(source, /data-rail-tip/);
  // The pill is decoration: the control it belongs to already has a NAME, and
  // a tooltip that also announced itself would say it twice.
  assert.match(source, /<span aria-hidden="true" data-rail-tip/);

  /*
   * R2c-07 replaces the round-2 assertion that used to stand here
   * (`bg-state-active px-[8px]`). It was not wrong about the code; it was
   * wrong about the reference, and it went green on a pill that was never
   * painted — see `tests/dom/drawingRail.test.tsx` for the structural half.
   *
   * Measured on `rail-remove-hover-1440-dark` and `tv-rail-trend-flyout-light`:
   * the pill's left edge is 1px past the 52px rail (x=53), its top is cell+7,
   * it is 24 tall with 7px of side padding ("Remove objects" = 117px, "Trend
   * tools" = 89 at the same 14px), and its ink is WHITE in BOTH themes on a
   * ground the theme owns — `bg-state-active`/`text-ink` gave a light-theme
   * pill of #ebebeb with near-black ink, which is not a tooltip, it is a chip.
   */
  const tip = source.slice(source.indexOf("  const tip = ("), source.indexOf("  const strip = ("));
  for (const geometry of [/ml-\[1px\]/, /top-\[7px\]/, /h-\[24px\]/, /px-\[7px\]/]) {
    assert.match(tip, geometry, `the pill has lost ${geometry.source}`);
  }
  assert.match(tip, /bg-\[var\(--ts-tooltip-bg\)\]/);
  /*
   * The ink is `text-white`, not a token: it is pure white in BOTH themes (the
   * pill's ground is dark in both), and a token whose two themes carry the
   * same value is exactly what `tests/lightTheme.test.ts` exists to catch.
   */
  assert.match(tip, /text-white/);
  assert.doesNotMatch(tip.replace(/\/\*[\s\S]*?\*\//g, ""), /bg-state-active/,
    "the pill is not a chip and must not borrow the chip's token");

  // A cell's pill answers the CELL's hover and the strip's answers the strip's,
  // which is what keeps one hover from lighting two pills (R2c-01).
  assert.match(tip, /peer-hover\/cell:flex/);
  assert.match(tip, /group-hover\/tip:flex/);
  assert.match(source, /"tvc-control peer\/cell flex/);

  // And both tokens exist in both theme blocks.
  const css = read("app/globals.css");
  const dark = css.slice(css.indexOf(":root {"), css.indexOf(':root[data-theme="light"]'));
  const light = css.slice(css.indexOf(':root[data-theme="light"]'));
  assert.match(dark, /--ts-tooltip-bg: #3d3d3d;/);
  assert.match(light, /--ts-tooltip-bg: #2e2e2e;/);

  /*
   * R2c-08: the LIGHT rail's hairline is #ebebeb (sampled 235 on
   * `tv-rail-trend-flyout-light` at y=358), not the #d1d1d1 (209) a mirror of
   * the dark value's contrast produced.
   */
  assert.match(light, /--ts-rail-separator: #ebebeb;/);
  assert.doesNotMatch(light, /--ts-rail-separator: #d1d1d1;/);
});

test("RAIL — a flyout is clamped to the viewport and scrolls only when it cannot fit", () => {
  /*
   * R2b-04. Geometric shapes is 750px tall opening from a cell at y=238, so
   * its last two rows rendered below a 900px viewport; and every menu that DID
   * fit still carried `max-h-[calc(100vh-120px)] overflow-y-auto`, so a list
   * with nothing hidden behaved as though it had.
   */
  const flyout = source.slice(source.indexOf("function Flyout("), source.indexOf("/**\n * The Icons picker"));
  /*
   * R2c-04: no margin under a clamped menu. `- 8` left an 8px band of page
   * below a menu the reference rests flush on the viewport's bottom edge —
   * Shapes opened at y=148 against its 150, Icons at 213 against its 221.
   */
  assert.match(flyout, /Math\.min\(cell - 6, viewport - height\)/);
  // Comments describe what the rule USED to be, so the prohibition is on code.
  assert.doesNotMatch(flyout.replace(/\/\*[\s\S]*?\*\//g, ""), /viewport - height - 8/);
  assert.match(flyout, /maxHeight === undefined \? "" : "overflow-y-auto "/);
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ""), /max-h-\[calc\(100vh-120px\)\]/,
    "the blanket scroll fallback is what hid the clamp being absent");

  // And the reference's 30px of blank surface above a tool flyout's first row
  // (6px of menu padding plus 24), and its 37px section block (6 + 1 + 30,
  // which needs the separator's bottom margin dropped under a heading).
  /*
   * R2c-03: 30, not 24. `!pt-` REPLACES `.tvc-menu`'s own 6px rather than
   * adding to it — the `!` is there because the menu's rule outscores a
   * utility — so "24 on top of 6" was arithmetic the cascade never performed
   * and every tool flyout opened 6px high and stood 6px short.
   */
  assert.match(source, /<Flyout menuLabel=\{group\.title\} className="!pt-\[30px\]">/);
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ""), /!pt-\[24px\]/);
  assert.match(source, /tvc-menu-sep\$\{section\.heading \? " !mb-0" : ""\}/);
});

test("RAIL — a flyout row places its icon and label where the reference does", () => {
  /*
   * R2b-09. The row's own gutter is 6px, so `px-3` put the 28px icon box 16px
   * from the menu's edge instead of 10, `gap-2` pushed the label to 107
   * instead of 96, and with no reserved right column the menu came out 18px
   * narrower than the reference's with the hotkey and the hover star hard
   * against the longest label.
   */
  const row = source.slice(source.indexOf("const toolRow = ("), source.indexOf("const optionRow = ("));
  assert.match(row, /gap-\[5px\] pl-\[4px\]/, "the icon column is not at x=63");
  assert.match(row, /<Icon name=\{t\.icon\} size=\{28\} \/>/);
  /*
   * R2c-02 re-measures what round 2 got half right. The reserved column is
   * 43px, not 18: the menu is sized by its widest row, so this reservation IS
   * the menu's width, and at 18 the Trend flyout came out 260 against the
   * reference's 285 — the whole 25px shortfall was here. The cap's own margin
   * drops to 5 so its right edge lands 39px from the row's edge (45 from the
   * panel's), which is where the reference prints it.
   */
  assert.match(row, /ml-\[43px\]/, "the reserved hotkey/star column is not the reference's 43");
  assert.match(row, /mr-\[5px\]/, "the cap no longer ends 45px from the panel's edge");
  assert.match(row, /mr-\[6px\] flex h-7 w-7/);
});

test("RAIL — the Icons picker is the reference's picker, minus the tab it cannot honour", () => {
  /*
   * R2b-07. It was a flat 56-glyph grid 292px tall where the reference has a
   * 354×679 categorised picker that scrolls inside itself: eight 38×38
   * category cells, an 8-column grid of 37×38 cells with 24px glyphs, and a
   * bottom tab bar.
   *
   * The reference's bar reads `Emojis · Stickers · Icons`. Stickers are its
   * own licensed artwork; there is no counterpart here and an empty third tab
   * would be a promise the product cannot keep, so the bar carries two — and
   * `Icons` is a monochrome Unicode outline set, which paints through the same
   * text path and takes the drawing's own colour.
   */
  const picker = source.slice(source.indexOf("function IconPicker("), source.indexOf("/**\n * The left icon rail."));
  assert.match(picker, /h-\[679px\] w-\[354px\]/);
  assert.match(picker, /h-\[38px\] w-\[38px\]/, "no 38×38 category cells");
  /*
   * R2c-11: eight FIXED 37px columns, not `grid-cols-8`. Eighths of whatever
   * width is available put 37px cells inside 42.75px columns, so the glyph
   * centres drifted up to 40px across the row from the reference's and nothing
   * lined up with the category cells above.
   */
  assert.match(picker, /gridTemplateColumns: "repeat\(8, 37px\)"/);
  assert.doesNotMatch(picker.replace(/\/\*[\s\S]*?\*\//g, ""), /grid-cols-8/);
  assert.match(picker, /h-\[38px\] w-\[37px\][\s\S]{0,60}text-\[24px\]/, "no 37×38 cells with 24px glyphs");
  assert.match(picker, /overflow-y-auto/, "the grid does not scroll inside the popover");
  assert.match(picker, /h-\[47px\]/, "the bottom tab bar is not the reference's 47px");
  assert.doesNotMatch(picker.replace(/\/\*[\s\S]*?\*\//g, ""), /flex-1 items-center justify-center text-\[16px\]/,
    "the tabs are a centred group with 26px between them, not two halves of the bar");
  assert.match(picker, /gap-\[26px\]/);
  /*
   * The accent exception, owner decision (endgame addendum §1, contract §7c):
   * where TradingView uses its accent for an INDICATOR — the category bar and
   * the open tab's underline — this shared surface follows TradingView. The
   * contract's "selection is a neutral chip" rule is about CHIPS and still
   * holds everywhere else, including on this picker's own cells.
   */
  assert.match(picker, /h-\[4px\] w-full bg-accent/);
  assert.match(picker, /data-\[active=true\]:text-accent/);
  assert.doesNotMatch(picker.replace(/\/\*[\s\S]*?\*\//g, ""), /data-\[active=true\]:bg-state-active/,
    "the open category is marked by the bar, not by a chip");
  // The category row's marks are the product's own outline glyphs, not the
  // operating system's colour emoji.
  assert.match(picker, /<Icon name=\{c\.icon\} size=\{20\} \/>/);
  for (const c of [...EMOJI_CATEGORIES, ...OUTLINE_CATEGORIES]) {
    assert.match(c.icon, /^[A-Za-z][A-Za-z0-9]*$/,
      `${c.id} still carries a code point (${c.icon}) where an ICONS key belongs`);
  }
  assert.match(picker, /"Emojis" : "Icons"/);
  assert.doesNotMatch(picker, /Stickers/);

  // Eight categories on the Emojis tab, as the reference shows, and every
  // glyph reachable from exactly one of them.
  assert.equal(EMOJI_CATEGORIES.length, 8);
  assert.ok(OUTLINE_CATEGORIES.length >= 4);
  const all = [...EMOJI_CATEGORIES, ...OUTLINE_CATEGORIES].flatMap((c) => c.glyphs);
  assert.equal(new Set(all).size, all.length, "a glyph is filed in two categories");
  assert.deepEqual([...ICON_GLYPHS], all);
  // Enough to scroll: the grid is ~14 rows of 8 before the tab bar.
  assert.ok(all.length > 150, `only ${all.length} glyphs — the picker still fits in one screen`);
});

test("RAIL — the column is bounded by the shell's gutter, not by a hairline", () => {
  /*
   * R2b-13. The reference frames the rail with a 4px `--ts-bg` gutter on its
   * right and under the toolbar; this column drew a 1px `border-r` into that
   * space, making the effective rail 51px. The gutter is the shell's to draw
   * (it is in `app/chart/page.tsx`); what belongs here is NOT drawing a second
   * boundary inside it — and taking 6px of top padding rather than 10, because
   * the toolbar row above now ends in that same 4px gutter rather than in a
   * 1px hairline, which is what still puts the first cell at y=48.
   */
  const rail = source
    .slice(source.indexOf("  return (\n    <div\n      ref={railRef}"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(rail, /border-r/);
  assert.match(rail, /w-\[52px\] shrink-0 flex-col items-center bg-surface pt-\[6px\]/);
});

/*
 * ── TVP8 / R2c: the rail's glyphs, measured rather than described ───────────
 *
 * Round three measured every cell's ink box against the reference's and found
 * eight of the fifteen 2px too large (Zoom in 4–5px), and found the STROKE
 * profile wrong in two opposite directions at once: axis-aligned strokes
 * carried a 12–24% halo into both neighbouring pixels, and diagonals had a dim
 * asymmetric core.
 *
 * Neither is describable as a class string, and neither can be measured in
 * jsdom, which has no rasteriser. What CAN be done here is the thing the pixel
 * sample is a consequence of: parse the path data itself, walk it, and assert
 * the geometry. A glyph redrawn "about the same size" fails this file rather
 * than the next capture.
 */

/** One parsed path segment, with its command and its numbers. */
interface Seg { cmd: string; args: number[] }

function tokenizePath(d: string): Seg[] {
  const out: Seg[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/g;
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let m: RegExpExecArray | null;
  let cmd: string | null = null;
  let nums: number[] = [];
  const flush = (): void => {
    if (!cmd) return;
    const n = arity[cmd.toUpperCase()]!;
    if (n === 0) { out.push({ cmd, args: [] }); nums = []; return; }
    while (nums.length >= n) {
      out.push({ cmd, args: nums.splice(0, n) });
      // A repeated pair after `M` is an implicit `L`, per the SVG grammar.
      if (cmd === "M") cmd = "L"; else if (cmd === "m") cmd = "l";
    }
    nums = [];
  };
  while ((m = re.exec(d)) !== null) {
    if (m[1]) { flush(); cmd = m[1]; if (cmd === "Z" || cmd === "z") flush(); }
    else nums.push(parseFloat(m[2]!));
  }
  flush();
  return out;
}

/** An elliptical arc, sampled — its extremes are not at its endpoints. */
function arcPoints(
  x0: number, y0: number, rx: number, ry: number, rot: number,
  laf: number, sf: number, x: number, y: number,
): [number, number][] {
  if (rx === 0 || ry === 0) return [[x, y]];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (rot * Math.PI) / 180;
  const dx2 = (x0 - x) / 2, dy2 = (y0 - y) / 2;
  const x1 = Math.cos(phi) * dx2 + Math.sin(phi) * dy2;
  const y1 = -Math.sin(phi) * dx2 + Math.cos(phi) * dy2;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const sign = laf === sf ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
  const cx = Math.cos(phi) * cx1 - Math.sin(phi) * cy1 + (x0 + x) / 2;
  const cy = Math.sin(phi) * cx1 + Math.cos(phi) * cy1 + (y0 + y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
    const a = Math.acos(Math.min(1, Math.max(-1, dot)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sf && dt > 0) dt -= 2 * Math.PI;
  if (sf && dt < 0) dt += 2 * Math.PI;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 48; i += 1) {
    const t = t1 + (dt * i) / 48;
    pts.push([
      Math.cos(phi) * rx * Math.cos(t) - Math.sin(phi) * ry * Math.sin(t) + cx,
      Math.sin(phi) * rx * Math.cos(t) + Math.cos(phi) * ry * Math.sin(t) + cy,
    ]);
  }
  return pts;
}

const bezier = (p: [number, number][], t: number): [number, number] => {
  const n = p.length - 1;
  const choose = (a: number, b: number): number => {
    let r = 1;
    for (let i = 0; i < b; i += 1) r = (r * (a - i)) / (i + 1);
    return r;
  };
  let x = 0, y = 0;
  for (let i = 0; i <= n; i += 1) {
    const w = choose(n, i) * (1 - t) ** (n - i) * t ** i;
    x += w * p[i]![0]; y += w * p[i]![1];
  }
  return [x, y];
};

interface Walked {
  points: [number, number][];
  /** Every purely horizontal or vertical segment, with the coordinate it is fixed at. */
  axis: { kind: "h" | "v"; fixed: number }[];
  /** True when any segment moves in both axes at once, or curves. */
  diagonal: boolean;
}

function walkPath(d: string): Walked {
  const segs = tokenizePath(d);
  const points: [number, number][] = [];
  const axis: { kind: "h" | "v"; fixed: number }[] = [];
  let diagonal = false;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let prevC: [number, number] | null = null, prevQ: [number, number] | null = null;
  for (const { cmd, args: a } of segs) {
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    const X = (v: number): number => (rel ? cx + v : v);
    const Y = (v: number): number => (rel ? cy + v : v);
    if (up === "M") {
      cx = X(a[0]!); cy = Y(a[1]!); sx = cx; sy = cy; points.push([cx, cy]); prevC = prevQ = null;
    } else if (up === "L") {
      const nx = X(a[0]!), ny = Y(a[1]!);
      const dx = Math.abs(nx - cx), dy = Math.abs(ny - cy);
      if (dy < 1e-9 && dx > 1e-9) axis.push({ kind: "h", fixed: cy });
      else if (dx < 1e-9 && dy > 1e-9) axis.push({ kind: "v", fixed: cx });
      else if (dx > 1e-9 && dy > 1e-9) diagonal = true;
      cx = nx; cy = ny; points.push([cx, cy]); prevC = prevQ = null;
    } else if (up === "H") {
      axis.push({ kind: "h", fixed: cy });
      cx = rel ? cx + a[0]! : a[0]!; points.push([cx, cy]); prevC = prevQ = null;
    } else if (up === "V") {
      axis.push({ kind: "v", fixed: cx });
      cy = rel ? cy + a[0]! : a[0]!; points.push([cx, cy]); prevC = prevQ = null;
    } else if (up === "C" || up === "S") {
      diagonal = true;
      const c1: [number, number] = up === "C"
        ? [X(a[0]!), Y(a[1]!)]
        : (prevC ? [2 * cx - prevC[0], 2 * cy - prevC[1]] : [cx, cy]);
      const c2: [number, number] = up === "C" ? [X(a[2]!), Y(a[3]!)] : [X(a[0]!), Y(a[1]!)];
      const e: [number, number] = up === "C" ? [X(a[4]!), Y(a[5]!)] : [X(a[2]!), Y(a[3]!)];
      for (let i = 0; i <= 24; i += 1) points.push(bezier([[cx, cy], c1, c2, e], i / 24));
      prevC = c2; prevQ = null; cx = e[0]; cy = e[1];
    } else if (up === "Q" || up === "T") {
      diagonal = true;
      const c1: [number, number] = up === "Q"
        ? [X(a[0]!), Y(a[1]!)]
        : (prevQ ? [2 * cx - prevQ[0], 2 * cy - prevQ[1]] : [cx, cy]);
      const e: [number, number] = up === "Q" ? [X(a[2]!), Y(a[3]!)] : [X(a[0]!), Y(a[1]!)];
      for (let i = 0; i <= 24; i += 1) points.push(bezier([[cx, cy], c1, e], i / 24));
      prevQ = c1; prevC = null; cx = e[0]; cy = e[1];
    } else if (up === "A") {
      diagonal = true;
      const e: [number, number] = [X(a[5]!), Y(a[6]!)];
      for (const p of arcPoints(cx, cy, a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, e[0], e[1])) points.push(p);
      cx = e[0]; cy = e[1]; prevC = prevQ = null;
    } else if (up === "Z") {
      cx = sx; cy = sy; points.push([cx, cy]);
    }
  }
  return { points, axis, diagonal };
}

/** The ICONS block, split into one entry per glyph key. */
function glyphEntries(): { key: string; body: string }[] {
  const block = source.slice(source.indexOf("const ICONS"), source.indexOf("const Icon ="));
  const keys = [...block.matchAll(/\n {2}([A-Za-z][A-Za-z0-9]*): /g)];
  assert.ok(keys.length > 80, `parsed only ${keys.length} glyphs — the ICONS shape changed`);
  return keys.map((m, i) => ({
    key: m[1]!,
    body: block.slice(m.index! + 3 + m[1]!.length, i + 1 < keys.length ? keys[i + 1]!.index! : block.length),
  }));
}

/** Every drawn element's sampled extent, in the 28-unit box. */
function glyphBox(body: string): { x0: number; x1: number; y0: number; y1: number } {
  const xs: number[] = [], ys: number[] = [];
  for (const m of body.matchAll(/<path d="([^"]+)"/g)) {
    for (const [x, y] of walkPath(m[1]!).points) { xs.push(x); ys.push(y); }
  }
  for (const m of body.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([-\d.]+)"/g)) {
    const [cx, cy, r] = [parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!)];
    xs.push(cx - r, cx + r); ys.push(cy - r, cy + r);
  }
  for (const m of body.matchAll(/<ellipse cx="([-\d.]+)" cy="([-\d.]+)" rx="([-\d.]+)" ry="([-\d.]+)"/g)) {
    const [cx, cy, rx, ry] = [parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!), parseFloat(m[4]!)];
    xs.push(cx - rx, cx + rx); ys.push(cy - ry, cy + ry);
  }
  for (const m of body.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g)) {
    const [x, y, w, h] = [parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!), parseFloat(m[4]!)];
    xs.push(x, x + w); ys.push(y, y + h);
  }
  assert.ok(xs.length > 0, "a glyph drew nothing measurable");
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

test("RAIL — the eight over-sized glyphs are redrawn to the reference's ink box", () => {
  /*
   * R2c-09. Eight of the fifteen cells drew 2px larger than the reference's
   * (Zoom in 4–5px): a rail whose silhouettes are right and whose optical
   * weight is not, which is what makes a column read as "nearly it".
   *
   * The targets below are the reference's ink boxes measured on the 52×38
   * CELL, converted to the 28-unit box the glyph is drawn in — a 28px glyph is
   * centred in a 52×38 cell, so the origin is (12, 5). The tolerance is 1 unit
   * per edge, which is the stroke's own half-width plus the sampling error of
   * a threshold measurement.
   */
  const target: Record<string, [number, number, number, number]> = {
    // key: [cell x0, cell x1, cell y0, cell y1] — the review's own table.
    zoomIn: [16, 34, 9, 26],
    fib: [13, 38, 9, 29],
    xabcd: [15, 37, 8, 29],
    long: [15, 36, 9, 29],
    short: [15, 36, 9, 29],
    text: [19, 33, 10, 27],
    iconSmiley: [15, 36, 8, 29],
    lock: [18, 33, 8, 27],
    unlock: [18, 33, 8, 27],
    trash: [17, 34, 9, 28],
  };
  const entries = new Map(glyphEntries().map((e) => [e.key, e.body]));
  for (const [key, [cx0, cx1, cy0, cy1]] of Object.entries(target)) {
    const body = entries.get(key);
    assert.ok(body, `no ${key} glyph`);
    const box = glyphBox(body);
    const want = { x0: cx0 - 12, x1: cx1 - 12, y0: cy0 - 5, y1: cy1 - 5 };
    for (const edge of ["x0", "x1", "y0", "y1"] as const) {
      const delta = Math.abs(box[edge] - want[edge]);
      assert.ok(delta <= 1,
        `${key}.${edge} is ${box[edge].toFixed(2)}, the reference's is ${want[edge]} `
        + `(cell ${cx0}..${cx1} × ${cy0}..${cy1}) — off by ${delta.toFixed(2)}`);
    }
  }
});

test("RAIL — every axis-aligned stroke is on a half-unit and every diagonal opts into 1.4", () => {
  /*
   * R2c-10, both halves.
   *
   * A 1.25 stroke on a half-unit-aligned vertical fills its own pixel column
   * and bleeds 0.125 into each neighbour: the rail sampled `66,219,15` where
   * the reference shows `15,219,15`, and Lock's keyhole — the one stroke in
   * the set still on an INTEGER x — smeared across four rows at half ink. The
   * same 1.25 on a 45° diagonal is not enough: it peaks 189 asymmetric where
   * the reference reaches 219 with a symmetric halo.
   *
   * So the rule has two halves and this asserts both: the `<svg>` default is 1
   * and every axis-aligned coordinate is `n + 0.5`; every path that moves in
   * both axes at once, every ring and the one ellipse carry 1.4.
   */
  assert.match(source, /strokeWidth="1" strokeLinecap/,
    "the icon svg's default weight is no longer the axis-aligned 1");

  const half = (v: number): boolean => Math.abs(Math.abs(v % 1) - 0.5) < 1e-6;
  const offGrid: string[] = [];
  const unweighted: string[] = [];
  const overweight: string[] = [];
  let diagonals = 0;
  for (const { key, body } of glyphEntries()) {
    for (const m of body.matchAll(/<path d="([^"]+)"([^/]*)\/>/g)) {
      const { axis, diagonal } = walkPath(m[1]!);
      for (const a of axis) {
        if (!half(a.fixed)) offGrid.push(`${key}: ${a.kind} at ${a.fixed}`);
      }
      const weighted = /strokeWidth=\{1\.4\}/.test(m[2]!);
      if (diagonal) { diagonals += 1; if (!weighted) unweighted.push(`${key}: ${m[1]!.slice(0, 40)}`); }
      else if (weighted) overweight.push(`${key}: ${m[1]!.slice(0, 40)}`);
    }
    for (const m of body.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)"/g)) {
      if (!half(parseFloat(m[1]!))) offGrid.push(`${key}: rect x=${m[1]}`);
      if (!half(parseFloat(m[2]!))) offGrid.push(`${key}: rect y=${m[2]}`);
    }
    for (const m of body.matchAll(/<(circle|ellipse)\b([^/]*)\/>/g)) {
      if (/stroke="none"/.test(m[2]!)) continue; // a filled dot carries no stroke
      if (!/strokeWidth=\{1\.4\}/.test(m[2]!)) unweighted.push(`${key}: <${m[1]}>`);
    }
  }
  assert.deepEqual(offGrid, [],
    `these land between pixels and render as two greys:\n  ${offGrid.join("\n  ")}`);
  assert.ok(diagonals > 80, `only ${diagonals} diagonal paths found — the parser is not seeing the set`);
  assert.deepEqual(unweighted, [],
    `these curve or run diagonally and are stroked at 1, which peaks ~160:\n  ${unweighted.join("\n  ")}`);
  assert.deepEqual(overweight, [],
    `these are purely axis-aligned and 1.4 gives them a halo:\n  ${overweight.join("\n  ")}`);
});

test("RAIL — the desktop column yields to the phone drawing sheet", () => {
  /*
   * Wave A A-02: the desktop drawing rail is not part of the phone layout.
   * The Draw bottom tab owns the phone sheet, while the desktop column stays
   * available from the md breakpoint upward.
   */
  const page = read("app/chart/page.tsx");
  assert.match(page, /!isMobile\s*&&\s*\(\s*\n\s*<div className="hidden md:flex">\s*\n\s*<DrawingToolbar/,
    "the desktop rail must not mount at phone width");
  assert.match(page, /role="dialog"\s*\n\s*aria-label="Drawing tools"/,
    "the Draw tab needs a real phone drawing surface");
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ""), /floating\?: boolean/,
    "the rail still carries the drawer mode it no longer has a caller for");

  /*
   * And the 44px touch minimum is scoped out of the rail, which is what lets
   * the cells stay 38 on a phone. Scoped to the rail's own root, so no other
   * control on the page loses its thumb target.
   */
  const css = read("app/globals.css");
  const coarse = css.slice(css.indexOf("@media (max-width: 640px)"));
  assert.match(coarse, /\[data-drawing-rail="true"\] button \{\s*min-width: 0;\s*min-height: 0 !important;/);
  assert.match(coarse, /\[data-drawing-rail="true"\] \.tvc-menu-row \{/,
    "a flyout row inside the rail must keep the menu grammar's own height");
});

test("RAIL — a flyout is a menu, and it answers the keyboard", () => {
  /*
   * R2c-05. An open flyout was a mouse-only object: Escape reached the global
   * `tool:cursor` binding untouched (so the key everybody presses to dismiss a
   * menu dismissed the armed TOOL and left the menu standing), the arrows
   * moved nothing, and opening one from the keyboard left focus behind it.
   */
  const rail = source.slice(source.indexOf("  const onRailKeyDown ="));
  assert.match(rail, /e\.key === "Escape"/);
  assert.match(rail, /e\.stopPropagation\(\)/,
    "Escape must be stopped, or `useShortcuts` drops the tool as well");
  assert.match(rail, /ArrowDown|ArrowUp/);
  assert.match(source, /onKeyDown=\{onRailKeyDown\}/);
  assert.match(source, /role="menuitem"/);
  assert.match(source, /role="menuitemradio"/);
});

test("RAIL — an option row is the reference's width, not 8px wider", () => {
  /*
   * R2c-12 (the part that is this component's own): the reference's Hide
   * flyout is 193px wide for "Hide positions and orders"; this one was 201.4
   * for the same string at the same size, and the whole 8px was `px-3`.
   */
  const row = source.slice(source.indexOf("  const optionRow = ("), source.indexOf("  /**\n   * A footer switch"));
  assert.match(row, /px-\[8px\]/);
  assert.doesNotMatch(row.replace(/\/\*[\s\S]*?\*\//g, ""), /px-3/);
});

test("RAIL — a starred tool reaches a floating favourites bar", () => {
  /*
   * R2c-06, measured live on `tradingview/tv-favourites-bar-1440-dark.png`
   * (`measurements/tv-favourites-bar-20260914.md`): a 62×38 bar for one
   * favourite — a 24×38 drag grip plus one 38×38 cell per tool — on the
   * popover ground with its radius and shadow, draggable, its position
   * persisted, absent when nothing is starred; and a star cell at the FOOT of
   * the rail that shows and hides it.
   *
   * The star used to write the list to storage and paint nothing anywhere.
   */
  assert.match(source, /const FAVOURITES_GRIP_WIDTH = 24;/);
  assert.match(source, /const FAVOURITES_CELL = 38;/);
  assert.match(source, /const FAVOURITES_BAR_HOME = \{ x: 960, y: 99 \};/);
  assert.match(source, /data-drawing-favourites="true"/);
  assert.match(source, /aria-label="Move the favourite tools bar"/);
  assert.match(source, /const DRAWING_FAVOURITES_BAR_KEY = "tv\.drawing-tools\.favourites\.bar\.v1"/);
  assert.match(source, /barOpen \? "Hide the favourite tools bar" : "Show the favourite tools bar"/);
  // A starred row's star sits on the 28px active chip, as the reference's does.
  assert.match(source, /data-\[starred=true\]:bg-state-active/);
});

test("A4 — the rail's four switches wear the inverted ON chip, not the selected-tool chip", () => {
  const rail = fs.readFileSync(RAIL, "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
  for (const pressed of ["magnetOn", "stayInDrawingMode", 'lockScope ? lockScope !== "none" : locked',
    'hideScope ? hideScope !== "none" : hidden']) {
    assert.ok(rail.includes(`className={btn()} data-switch="" aria-pressed={${pressed}}`),
      `switch ${pressed} is not marked as a switch`);
  }
  assert.match(css,
    /\[data-drawing-rail="true"\] \.tvc-control\[data-switch\]\[aria-pressed="true"\]::before,[\s\S]{0,200}background-color: var\(--ts-menu-selected-bg\)/);
  assert.match(css,
    /\[data-drawing-rail="true"\] \.tvc-control\[data-switch\]\[aria-pressed="true"\]:hover \{\s*color: var\(--ts-menu-selected-ink\)/);
});
