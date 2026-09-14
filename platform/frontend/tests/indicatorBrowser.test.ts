/**
 * The indicator browser and study templates.
 *
 * Two properties are worth holding hardest here.
 *
 * The browser must be a browser over what this installation ACTUALLY has —
 * Pine scripts saved locally and the operator's own templates — with no
 * category that implies a marketplace, a community or a bundled library that
 * does not exist. Those are checked against the source, because they are
 * claims made in rendered text.
 *
 * Templates must round-trip exactly and fail safely. That is pure logic, so it
 * is tested as such: a corrupt entry, a hand-edited file and a record from a
 * future build must all leave the operator with the templates that ARE valid
 * and no half-restored one that looks applied and is not.
 */
import { test } from "node:test";
import { NATIVE_STUDIES } from "../lib/native/catalog";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_TEMPLATES, TEMPLATE_STORAGE_KEY, applyTemplateTo, deleteTemplate, findTemplate,
  loadTemplates, parseTemplates, saveTemplates, serializeTemplates, templateFromIndicators,
  upsertTemplate, type IndicatorTemplate,
} from "../lib/indicatorTemplates";
import type { AppliedIndicator } from "../lib/indicators";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readCode = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const BROWSER = "components/tv/IndicatorBrowser.tsx";

/** A minimal applied study, in the shape the pane's list holds. */
const applied = (over: Partial<AppliedIndicator> = {}): AppliedIndicator => ({
  key: "ind_a", scriptId: "s1", name: "RSI", kind: "indicator", shortTitle: "RSI",
  overlay: false, precision: null, source: "//@version=5\nindicator('RSI')",
  inputs: [], params: { length: 14 }, visible: true, loading: false, error: null,
  warnings: [], overlays: [], decorations: [], barColors: [], markers: [],
  drawings: { lines: [], boxes: [], labels: [], tables: [] }, trades: [], ...over,
});

const template = (over: Partial<IndicatorTemplate> = {}): IndicatorTemplate => ({
  name: "Scalping", createdAt: "2026-09-03T00:00:00.000Z",
  indicators: [{ scriptId: "s1", name: "RSI", source: "src", params: { length: 14 }, visible: true }],
  studies: [],
  ...over,
});

// ── the browser is over real things ────────────────────────────────────────

test("the browser invents no marketplace, community or paid library", () => {
  const source = readCode(BROWSER);
  for (const forbidden of [
    /\bcommunity\b/i, /\bmarketplace\b/i, /\bpurchased\b/i, /\btrending\b/i,
    /\bpopular\b/i, /\beditors?['’]? picks?\b/i, /\bfeatured\b/i, /\bsubscribe\b/i,
  ]) {
    assert.doesNotMatch(source, forbidden,
      `${forbidden} promises a source of indicators this product does not have`);
  }
});

/**
 * "Built-in" used to be on the forbidden list above, and correctly so: this
 * installation shipped no bundled scripts, and a Built-in tab would have been
 * an empty promise. It is no longer empty — the native registry is a real
 * library that computes in the browser — so the assertion changes from "the
 * word must not appear" to "the rail entry must be backed by the registry".
 */
test("Technicals is the native registry, not a stub", () => {
  const source = read(BROWSER);
  assert.match(source, /label="Technicals"/);
  assert.match(source, /from "@\/lib\/native\/catalog"/,
    "the library must read the registry rather than a hard-coded list");
  assert.match(source, /searchStudies\(q\)/, "and its search is the registry's own");
  assert.ok(NATIVE_STUDIES.length >= 12,
    "a Technicals library with nothing in it would be exactly the empty promise " +
    "this assertion used to forbid");
});

/**
 * ── TVP8 R3-01/R3-02/R3-08: two libraries, two tabs, and no third navigator ──
 *
 * The dialog carried a sidebar of six COUNTED entries and, beside it, a
 * wrapping row of seven COUNTED chips — every chip repeating a sidebar entry.
 * Two navigation systems for one list, and four of the six "libraries" were
 * filters rather than libraries: On this chart, Favourites, Recents, Indicator
 * templates.
 *
 * The rail is now the two things this installation genuinely HAS, the tab row
 * is the two kinds the Pine compiler genuinely reports, and the filters became
 * what they are in the reference: groups of the list, and a toolbar control.
 */
test("the rail is libraries, the tabs are kinds, and neither is a filter console", () => {
  const source = readCode(BROWSER);

  // The rail: exactly two entries, both real libraries.
  assert.match(source, /label="My scripts"/);
  assert.match(source, /label="Technicals"/);
  assert.equal((source.match(/<LibraryNavButton/g) ?? []).length, 2,
    "a third rail entry is a filter wearing a library's clothes");
  for (const gone of [
    /label="On this chart"/, /label="Favourites"/, /label="Recents"/,
    /label="Indicator templates"/,
  ]) {
    assert.doesNotMatch(source, gone, `${gone} is a filter, not a library`);
  }

  // The tabs: the kinds the compiler and the registry actually report.
  assert.match(source, /id: "indicator", label: "Indicators"/);
  assert.match(source, /id: "strategy", label: "Strategies"/);
  assert.equal((source.match(/\{ id: "[a-z]+", label: "[^"]+" \}/g) ?? []).length, 2,
    "a Profiles or Patterns tab would be a tab onto nothing");
  assert.match(source, /s\.kind === kind/, "the tab filters by the compiler's own kind");

  // Favourites and recents survive as GROUPS of the list, from the same store.
  assert.match(source, /loadFavourites\(\)/);
  assert.match(source, /loadRecents\(\)/);
  assert.match(source, /<GroupHeader>Favorites<\/GroupHeader>/);
  assert.match(source, /<GroupHeader>Recents<\/GroupHeader>/);
  assert.match(source, /<GroupHeader>Script name<\/GroupHeader>/);
});

test("NOTHING IN THE BROWSER IS COUNTED", () => {
  /*
   * A count beside a filter is the filter answering a question nobody asked,
   * and the reference has none anywhere in this dialog — not on a rail entry,
   * not on a tab, not on a row. Ours had one on all six rail entries and all
   * seven chips, and they were the single loudest first-glance tell in the pair
   * review ("My scripts 8 · On this chart 0 · Built-in 57 · Favourites 0 …").
   */
  const source = readCode(BROWSER);
  assert.doesNotMatch(source, /categoryCount/, "the counting apparatus is gone, not hidden");
  assert.doesNotMatch(source, /count=\{/, "no control in this dialog carries a count");
  assert.doesNotMatch(source, /NATIVE_STUDIES\.length/,
    "a total beside a search box is a count of something the user cannot see");
});

test("ON THIS CHART LEFT THE BROWSER, BUT NOT THE PRODUCT", () => {
  /*
   * R3-08. "On this chart" was a rail entry, a chip, a count and a per-row
   * second line. It is not a library and it is not a filter over one: it is
   * the state of the CHART, which the pane legends and the Indicators panel
   * already show. In the reference it is not in this dialog at all.
   *
   * It survives here as the last line of a row's `?` tooltip, which is the one
   * place it answers a question the browser is actually being asked — "have I
   * already added this?" — without becoming row copy.
   */
  const source = readCode(BROWSER);
  assert.match(source, /const nativeInfo = useCallback/);
  assert.match(source, /On this chart · \$\{count\} instance/,
    "the truth must survive somewhere");
  // The same script can be applied twice with different inputs, so a boolean
  // "added" flag would be a lie; the count is the truth.
  assert.match(source, /applied\.filter\(\(i\) => i\.scriptId === script\.id\)\.length/);
  assert.match(source, /instance\$\{count === 1 \? "" : "s"\}/);
  // And it reaches the user through `title`, not as a rendered line.
  assert.match(source, /info=\{nativeInfo\(def\)\}/);
  assert.match(source, /title=\{info\}/);
});

test("A ROW IS ONE LINE THAT IS ITSELF THE CONTROL", () => {
  /*
   * R3-03. Each row was a 36px `div` holding a green `BUILT-IN` badge, a 13px
   * name, an 11px description, a `Star` TEXT button and a bordered `Add`
   * button — and the add action was the button, not the row. The reference's
   * row is 32px, one 14px name, and clicking anywhere on it adds the script.
   */
  const source = readCode(BROWSER);
  assert.match(source, /<button\s+type="button"\s+onClick=\{onAdd\}/, "the row is the control");
  assert.match(source, /h-8 w-full items-center truncate/, "32px pitch, one line");
  assert.match(source, /text-\[14px\] text-ink/, "14px name");
  /*
   * The star and the glyphs are SIBLINGS of the row button, positioned over
   * its two ends, not children of it. A button inside a button is not valid
   * HTML: the inner one is unreachable by keyboard and the outer one's
   * accessible name absorbs it.
   */
  assert.match(source, /absolute left-0 top-0 flex h-8 w-7/);
  assert.match(source, /absolute right-1 top-0 flex h-8/);
  assert.doesNotMatch(source, /role="option"/,
    "a row that is a real button needs no invented role");
  // The badge, the text buttons and the separators are gone.
  for (const gone of [/Built-in\s*<\/span>/, />\s*Star\s*<\/button>/, />\s*Add\s*<\/button>/,
    /border-b border-border/]) {
    assert.doesNotMatch(source, gone, `${gone} is row chrome the reference does not have`);
  }
  // Adding keeps the dialog open, the way the reference's does.
  assert.doesNotMatch(source, /addNative[\s\S]{0,200}onClose\(\)/);
});

test("SEARCH IS GROUPED BY LIBRARY AND LIGHTS WHAT IT MATCHED", () => {
  /*
   * R3-05. Results were a flat list under the chip row: nothing said WHERE a
   * result came from, and nothing said why it matched — an alias hit ("BB" →
   * Bollinger Bands) looked like a mistake. The reference groups by library and
   * renders the matched characters in accent.
   */
  const source = readCode(BROWSER);
  assert.match(source, /<GroupHeader>Technicals<\/GroupHeader>/);
  assert.match(source, /<GroupHeader>My scripts<\/GroupHeader>/);
  assert.match(source, /function Highlight/);
  assert.match(source, /<span className="text-accent">\{text\.slice\(at, at \+ needle\.length\)\}<\/span>/,
    "accent-is-meaning: which characters the query found is DATA about the row");
  // While a query runs, the rail's selection is not applied — search spans both
  // libraries, so a library filter would be describing a list it does not own.
  assert.match(source, /active=\{!searching &&/);
});

test("the search field says `Search`, and draws no ring on opening", () => {
  /*
   * R3-04. The placeholder was 47 characters explaining the dialog from inside
   * its own field, there was no magnifier and no clear glyph, and
   * `focus:border-accent` painted an accent ring the instant the dialog opened
   * — because the field is focused programmatically. Under it sat an 11px
   * sentence, `Press Enter to add the first result.`, spending 15px of vertical
   * before the body to describe a keystroke.
   */
  const source = readCode(BROWSER);
  assert.match(source, /placeholder="Search"/);
  assert.doesNotMatch(source, /Press Enter to add the first result/,
    "a behaviour is not copy");
  assert.doesNotMatch(source, /focus:border-accent/,
    "the product's one :focus-visible rule is the focus indicator here too");
  assert.match(source, /aria-label="Clear the search"/);
  // The behaviour itself stays.
  assert.match(source, /const addFirstResult = useCallback/);
});

test("the browser is a modal with the application's own focus and Escape handling", () => {
  const source = read(BROWSER);
  // `components/Modal` is what carries the focus trap, the Escape handler and
  // the dialog role; a hand-rolled overlay would silently miss all three.
  assert.match(source, /import \{ Modal \} from "@\/components\/Modal"/);
  assert.match(source, /<Modal open=\{open\} onClose=\{onClose\}/);
  assert.match(source, /searchRef\.current\?\.focus\(\)/, "search must be focused on open");
  // Reopened fresh, so a stale filter does not persist.
  assert.match(source, /setQ\(""\);/);
  assert.match(source, /setLibrary\("technicals"\);/);

  /*
   * R3-07: the LIST is the scroller, not the dialog body.
   *
   * `Modal` wraps its children in one `overflow-y-auto`, so the rail and the
   * tab row scrolled away with the rows. The opt-out is a prop rather than a
   * class override, because a `contentClassName` cannot reliably beat a class
   * of the same specificity emitted later in the sheet.
   */
  assert.match(source, /scrollBody=\{false\}/);
  assert.match(source, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(source, /!h-\[638px\]/, "the measured dialog height");

  const dialogs = read("components/tv/ChartDialogs.tsx");
  assert.match(dialogs, /<IndicatorBrowser/);
  assert.match(dialogs, /open=\{props\.indicatorBrowserOpen\}/);
});

test("adds land on the focused pane's study list, not on a pane the dialog picks", () => {
  const source = readCode(BROWSER);
  assert.doesNotMatch(source, /activePaneId|from "@\/lib\/workspace"/);
  assert.match(source, /indicators\.add\(\{ scriptId: full\.id/);
  /*
   * R3-06: and the dialog no longer captions itself with which chart that is.
   * `Adds land on the focused chart — BTCUSDT 1h.` sat in a footer under every
   * library: a sentence explaining the product to itself, in the place the
   * reference's list reaches the dialog's bottom edge.
   */
  assert.doesNotMatch(source, /Adds land on the focused chart/);

  const page = read("app/chart/page.tsx");
  assert.match(page, /indicators=\{activeIndicators\}/);
  // `activeIndicators` is resolved from workspace.activePaneId in the page.
  assert.match(page, /const get = indicatorApis\.current\.get\(active\.id\)/);
  assert.match(page, /onOpenIndicators=\{\(\) => setIndicatorBrowserOpen\(true\)\}/);
});

test("a library that cannot be read says so instead of looking empty", () => {
  const source = read(BROWSER);
  assert.match(source, /setLibraryError/);
  assert.match(source, /The script library could not be read/);
  assert.match(source, /Nothing on the chart changed/);
});

test("destructive actions in the browser are named and confirmed", () => {
  const source = read(BROWSER);
  // TVP8: through the product's own dialog, not the browser's — see AskDialog.
  assert.match(source, /title: `Delete “\$\{s\.name\}” from the library\?`/);
  /*
   * ONE destructive action is left in this dialog, and template deletion is no
   * longer one of them: templates moved to the toolbar control (R3-06), and
   * their confirmations moved with them. `tone: "danger"` is counted rather
   * than spot-checked so a fourth destructive path cannot arrive undressed.
   */
  assert.equal((source.match(/tone: "danger"/g) ?? []).length, 1,
    "every destructive confirmation in the browser carries the danger tone");
  const menu = read("components/tv/IndicatorTemplatesMenu.tsx");
  assert.match(menu, /title: `Delete the template “\$\{template\.name\}”\?`/);
  assert.equal((menu.match(/tone: "danger"/g) ?? []).length, 2,
    "deleting a template and overwriting one are both destructive");
});

test("IMPORT IS A ROW OF THE LIBRARY IT IMPORTS INTO", () => {
  /*
   * R3-06. `Import .pine` was a bordered button in a footer beneath every
   * library — including Technicals, where importing a Pine file means nothing.
   * The reference has no dialog footer at all.
   */
  const source = readCode(BROWSER);
  assert.match(source, /function ImportRow/);
  assert.match(source, /<ImportRow/);
  // Rendered only in the library it belongs to.
  const scriptsBranch = /library === "technicals" \? \([\s\S]*?\) : \([\s\S]*?<ImportRow/;
  assert.match(source, scriptsBranch, "Import must sit in My scripts, not under Technicals");
  assert.doesNotMatch(source, /Import \.pine\s*<\/button>/,
    "a footer button is not a library row");
});

test("THE TEMPLATE EDITOR LEFT THE DIALOG ENTIRELY", () => {
  /*
   * R3-06. An uppercase `SAVE THESE STUDIES AS A TEMPLATE` heading, a sentence
   * of explanation, a name field, a Save button and a status sentence, below a
   * 57-row list, inside the same scroll region — about 2,000px below the fold
   * in the opened state. Two features in one dialog, one unreachable without
   * scrolling past the other.
   */
  const source = readCode(BROWSER);
  for (const gone of [
    /Save these studies as a template/i, /Template name/, /Save template/,
    /templateFromIndicators/, /upsertTemplate/, /loadTemplates/,
  ]) {
    assert.doesNotMatch(source, gone, `${gone} is the template feature, not the library`);
  }
  const menu = read("components/tv/IndicatorTemplatesMenu.tsx");
  assert.match(menu, /Save indicator template…/);
  assert.match(menu, /ask\.promptFor\(/, "the name is asked for, not typed into the menu");
  assert.match(menu, /useExclusivePopover\("indicator-templates"\)/);
  // The 2×2 grid glyph the reference uses, at the toolbar's shared size.
  assert.equal((menu.match(/<rect /g) ?? []).length, 4);
  assert.match(menu, /width=\{TOOL_ICON_SIZE\}/);
});

// ── templates: what they hold ──────────────────────────────────────────────

test("a template holds study configuration and nothing about the workspace", () => {
  const t = templateFromIndicators("Scalping", [applied()], new Date("2026-09-03T00:00:00Z"));
  assert.deepEqual(t.indicators, [
    { scriptId: "s1", name: "RSI", source: "//@version=5\nindicator('RSI')",
      params: { length: 14 }, visible: true },
  ]);
  // Not the symbol, timeframe, pane arrangement, strategy or moving averages —
  // a saved layout owns those, and a second half-restoring thing would be a trap.
  const keys = Object.keys(t.indicators[0]!).sort();
  assert.deepEqual(keys, ["name", "params", "scriptId", "source", "visible"]);
  // TVP8: `studies` joins them — the 57 built-ins, which templates used to
  // drop silently while the ledger recorded "Indicator templates … MATCH".
  assert.deepEqual(Object.keys(t).sort(), ["createdAt", "indicators", "name", "studies"]);
});

test("run output is never captured into a template", () => {
  const t = templateFromIndicators("X", [applied({
    overlays: [{ id: "o" }] as never, markers: [{ time: 1 }] as never, error: "boom",
  })]);
  const serialized = serializeTemplates([t]);
  assert.doesNotMatch(serialized, /overlays|markers|boom|loading/);
});

test("a template round-trips exactly through storage", () => {
  const original = [template(), template({ name: "Trend" })];
  const restored = parseTemplates(serializeTemplates(original));
  assert.deepEqual(restored, [template({ name: "Scalping" }), template({ name: "Trend" })]);
});

test("serialization is deterministic whatever order things were built in", () => {
  const a = serializeTemplates([template({ name: "B" }), template({ name: "A" })]);
  const b = serializeTemplates([template({ name: "A" }), template({ name: "B" })]);
  assert.equal(a, b, "template order must not change the stored bytes");

  // A fixed stamp, because the claim under test is about PARAMETER order.
  // Two `new Date()` calls that straddle a millisecond made this fail at
  // random on the `createdAt` field, which the assertion is not about.
  const at = new Date("2026-01-01T00:00:00.000Z");
  const p1 = templateFromIndicators("T", [applied({ params: { b: 2, a: 1 } })], at);
  const p2 = templateFromIndicators("T", [applied({ params: { a: 1, b: 2 } })], at);
  assert.equal(serializeTemplates([p1]), serializeTemplates([p2]),
    "parameter key order must not change the stored bytes");
});

test("study order inside a template is preserved, because it decides layering", () => {
  const t = templateFromIndicators("Layered", [
    applied({ key: "a", name: "Zebra" }), applied({ key: "b", name: "Alpha" }),
  ]);
  assert.deepEqual(parseTemplates(serializeTemplates([t]))[0]!.indicators.map((i) => i.name),
    ["Zebra", "Alpha"]);
});

// ── templates: failing safely ──────────────────────────────────────────────

test("a malformed persisted store yields the valid templates and never throws", () => {
  assert.deepEqual(parseTemplates(null), []);
  assert.deepEqual(parseTemplates(""), []);
  assert.deepEqual(parseTemplates("{not json"), []);
  assert.deepEqual(parseTemplates('{"name":"x"}'), [], "the payload must be an array");
  assert.deepEqual(parseTemplates("[1,2,3]"), []);

  const mixed = JSON.stringify([
    template(),
    { name: "", indicators: [{ source: "s" }] },        // no name
    { name: "No rows", indicators: [] },                 // nothing to apply
    { name: "Bad rows", indicators: [{ name: "x" }] },   // no source
    { name: "Not an array", indicators: "nope" },
    null,
  ]);
  const parsed = parseTemplates(mixed);
  assert.deepEqual(parsed.map((t) => t.name), ["Scalping"],
    "a template that cannot be applied must be dropped, not kept as a name that promises studies");
});

test("a partially malformed template keeps only the rows it can prove", () => {
  const parsed = parseTemplates(JSON.stringify([{
    name: "Half", createdAt: 12345, indicators: [
      { scriptId: "s1", name: "Good", source: "src", params: { a: 1 }, visible: false },
      { name: "No source" },
      { source: "src2", params: "not an object" },
      { source: "src3", params: { ok: 1, bad: Number.NaN, worse: { nested: true } } },
    ],
  }]));
  assert.equal(parsed.length, 1);
  const rows = parsed[0]!.indicators;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    scriptId: "s1", name: "Good", source: "src", params: { a: 1 }, visible: false,
  });
  assert.deepEqual(rows[1]!.params, {}, "a non-object params must become an empty one");
  assert.equal(rows[1]!.name, "Untitled script");
  assert.equal(rows[1]!.scriptId, null);
  assert.deepEqual(rows[2]!.params, { ok: 1 },
    "NaN would round-trip as null and reapply as a broken input; a nested object is not a param");
  assert.equal(parsed[0]!.createdAt, "", "a non-string createdAt must not be rendered as a date");
});

test("duplicate names in a persisted store collapse rather than shadowing each other", () => {
  const parsed = parseTemplates(JSON.stringify([
    template({ name: "Dup" }), template({ name: "dup", indicators: [
      { scriptId: null, name: "Other", source: "x", params: {}, visible: true }] }),
  ]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.indicators[0]!.name, "RSI", "the first well-formed entry wins");
});

// ── templates: saving, overwriting, deleting ───────────────────────────────

test("saving over an existing template requires being asked twice", () => {
  const list = [template()];
  const replacement = template({ createdAt: "2026-09-04T00:00:00.000Z" });

  const refused = upsertTemplate(list, replacement);
  assert.deepEqual(refused, { ok: false, reason: "exists" },
    "a save must never quietly destroy a template the operator built earlier");

  const forced = upsertTemplate(list, replacement, { overwrite: true });
  assert.ok(forced.ok);
  assert.equal(forced.list.length, 1);
  assert.equal(forced.list[0]!.createdAt, "2026-09-04T00:00:00.000Z");
});

test("the name match is case- and whitespace-insensitive, so a near-duplicate cannot sneak in", () => {
  const list = [template({ name: "Scalping" })];
  assert.deepEqual(upsertTemplate(list, template({ name: "  scalping  " })),
    { ok: false, reason: "exists" });
  assert.equal(findTemplate(list, "SCALPING")?.name, "Scalping");
  assert.equal(findTemplate(list, "missing"), null);
});

test("a template with no name or no studies is refused with a reason", () => {
  assert.deepEqual(upsertTemplate([], template({ name: "   " })),
    { ok: false, reason: "empty-name" });
  assert.deepEqual(upsertTemplate([], template({ indicators: [] })),
    { ok: false, reason: "no-indicators" });
});

test("the local store has a bound, and reaching it is reported rather than silent", () => {
  const full = Array.from({ length: MAX_TEMPLATES }, (_, i) => template({ name: `T${i}` }));
  assert.deepEqual(upsertTemplate(full, template({ name: "one more" })),
    { ok: false, reason: "full" });
  // Replacing one of the existing names still works at the bound.
  assert.ok(upsertTemplate(full, template({ name: "T0" }), { overwrite: true }).ok);
});

test("deleting removes exactly one template and leaves the rest", () => {
  const list = [template({ name: "A" }), template({ name: "B" })];
  assert.deepEqual(deleteTemplate(list, " b ").map((t) => t.name), ["A"]);
  assert.deepEqual(deleteTemplate(list, "missing").map((t) => t.name), ["A", "B"]);
});

test("templates persist locally only, with no server call anywhere in the module", () => {
  const source = readCode("lib/indicatorTemplates.ts");
  assert.match(source, new RegExp(TEMPLATE_STORAGE_KEY.replace(/\./g, "\\.")));
  assert.doesNotMatch(source, /fetch\(|\bapi\./, "templates are local; there is no cloud sync");
  // And a browser without storage must not crash the dialog.
  assert.deepEqual(loadTemplates(), [], "no window in this environment");
  assert.doesNotThrow(() => saveTemplates([template()]));
});

test("applying a template restores a study that was saved hidden", () => {
  /*
   * TVP8 R3-06: applying moved out of the browser dialog, into
   * `applyTemplateTo` — one implementation, reachable from the toolbar menu,
   * the browser and a test alike. The RULE is unchanged: `add` always starts a
   * study visible, so a template that stored a hidden one has to toggle it back.
   */
  const source = readCode("lib/indicatorTemplates.ts");
  assert.match(source, /if \(!row\.visible\) indicators\.toggleVisible\(key\)/);
  assert.match(source, /if \(!study\.visible\) nativeStudies\?\.toggleVisible\(key\)/,
    "a built-in saved hidden restores hidden too");
});

// ── TVP8 ───────────────────────────────────────────────────────────────────

test("A TEMPLATE HOLDS THE BUILT-IN STUDIES TOO, NOT ONLY THE PINE ONES", () => {
  /*
   * Templates held Pine studies only and silently dropped all 57 built-ins.
   * Saving one from a chart carrying RSI, MACD and Bollinger Bands produced
   * NOTHING — `saveTemplate` refused, because the Pine list was empty — and a
   * chart with one Pine study and three built-ins produced a template that
   * promised four studies and restored one.
   *
   * `docs/TRADINGVIEW_CHART_PARITY_LEDGER.md` recorded "Indicator templates …
   * MATCH", which is what made it worth looking at.
   */
  const t = templateFromIndicators("Momentum", [], new Date("2026-09-13T00:00:00Z"), [
    { defId: "rsi", params: { length: 50 }, visible: true, styles: { rsi: { color: "#ff0000", width: 3 } } },
    { defId: "macd", params: { fast: 14, slow: 21, signal: 7 }, visible: false, styles: {} },
  ]);
  assert.equal(t.studies.length, 2);
  assert.deepEqual(t.studies[0], {
    defId: "rsi", params: { length: 50 }, visible: true,
    styles: { rsi: { color: "#ff0000", width: 3 } },
  });
  assert.equal(t.studies[1]!.visible, false, "a hidden study restores hidden");

  // Styles are part of it: a template restores how the chart LOOKED, and a
  // template that put an RSI back in the default colour after the user had
  // recoloured it is a template that lost half its point.
  assert.deepEqual(t.studies[0]!.styles.rsi, { color: "#ff0000", width: 3 });

  // Round trip, through the parser that every read goes through.
  const back = parseTemplates(serializeTemplates([t]));
  assert.deepEqual(back[0]!.studies, t.studies);

  // And a template written before this existed still reads, with no studies.
  const legacy = parseTemplates(JSON.stringify([{
    name: "Old", createdAt: "", indicators: [
      { scriptId: "s1", name: "X", source: "//", params: {}, visible: true },
    ],
  }]));
  assert.equal(legacy.length, 1);
  assert.deepEqual(legacy[0]!.studies, []);

  // A template of ONLY built-ins is valid — that is the common case and the
  // one that used to be refused.
  const nativeOnly = parseTemplates(JSON.stringify([{
    name: "Built-ins", createdAt: "", indicators: [],
    studies: [{ defId: "rsi", params: { length: 14 }, visible: true, styles: {} }],
  }]));
  assert.equal(nativeOnly.length, 1);
  assert.equal(nativeOnly[0]!.studies.length, 1);

  // A malformed study row is dropped, not repaired into something plausible.
  const bad = parseTemplates(JSON.stringify([{
    name: "Bad", createdAt: "", indicators: [],
    studies: [{ params: {} }, { defId: "", params: {} }, { defId: "rsi", params: {} }],
  }]));
  assert.equal(bad[0]!.studies.length, 1);
  assert.equal(bad[0]!.studies[0]!.defId, "rsi");
});

test("THE TEMPLATE CONTROL ACTUALLY SAVES AND RESTORES THE BUILT-INS", () => {
  const menu = readCode("components/tv/IndicatorTemplatesMenu.tsx");
  assert.match(menu,
    /templateFromIndicators\(\s*name, studies\.indicators, new Date\(\), studies\.native\)/,
    "saving must pass the built-ins, or the template is Pine-only again");
  assert.match(menu, /const onChart = studies\.indicators\.length \+ studies\.native\.length;/,
    "a chart of built-ins alone must be saveable");

  const lib = readCode("lib/indicatorTemplates.ts");
  assert.match(lib, /for \(const study of template\.studies\)/, "applying must restore them");
  assert.match(lib, /nativeStudies\?\.setStyle\(key, plot,/, "and restore their styling");
});

test("APPLYING A TEMPLATE CANNOT SILENTLY WIPE A CHART", () => {
  /*
   * ── What this replaces, and why the rule got stronger ───────────────────
   *
   * The browser had an `Add` and a `Replace` button on every template row, and
   * Replace's guard was `replace && applied.length > 0` — `applied` being the
   * PINE list, while `props.nativeStudies?.clear()` ran inside it regardless.
   * A chart carrying nothing but built-ins, which is what most charts carry,
   * had every one of them removed with NO confirmation; when it did ask, the
   * number in the title was the Pine count, so it under-reported what was
   * about to be destroyed.
   *
   * Applying is now additive, always: `applyTemplateTo` has no `replace` mode
   * and calls `clear()` on neither list. That is a stronger guarantee than a
   * correctly-counted confirmation, and it is asserted structurally — the
   * destructive call simply is not in the module.
   */
  const lib = readCode("lib/indicatorTemplates.ts");
  assert.doesNotMatch(lib, /\.clear\(\)/,
    "applying a template must never clear a chart's studies");
  const menu = readCode("components/tv/IndicatorTemplatesMenu.tsx");
  assert.doesNotMatch(menu, /\.clear\(\)/,
    "and the control that applies them must not do it either");
});

test("A TEMPLATE NAMING A STUDY THIS BUILD LACKS SAYS SO", () => {
  /*
   * TVP8 round two. `nativeStudies.add(defId, params)` returns nothing for a
   * `defId` the catalogue does not contain — a template written by a newer
   * build, or exported from an installation with a study this one has since
   * dropped. The loop did `continue`, and the status line then said "Applied"
   * as though everything had arrived. The only way to notice was to count the
   * legend.
   *
   * The reporting is now enforced by a TYPE rather than by a call site
   * remembering: `applyTemplateTo` returns what landed and what did not, and
   * the menu's `onApply` is declared to return that record, so a handler that
   * throws the answer away does not compile.
   */
  const lib = readCode("lib/indicatorTemplates.ts");
  assert.match(lib, /if \(!key\) \{ missing\.push\(study\.defId\); continue; \}/,
    "a skipped study must be remembered, not just skipped");
  assert.match(lib, /applied: template\.indicators\.length \+ template\.studies\.length - missing\.length/);

  const menu = read("components/tv/IndicatorTemplatesMenu.tsx");
  assert.match(menu, /onApply: \(template: IndicatorTemplate\) => TemplateApplication;/,
    "a handler that cannot say what landed has not applied the template");
  assert.match(menu, /Applied \$\{result\.applied\} of \$\{result\.applied \+ result\.missing\.length\}/);
  assert.match(menu, /This build has no study called \$\{result\.missing\.join\(", "\)\}/);
});

test("APPLYING IS ONE IMPLEMENTATION, AND IT RESTORES WHAT IT PROMISED", () => {
  /*
   * The behaviour itself, driven rather than grepped: two study lists standing
   * in for a pane's, and a template naming one study this build does not have.
   */
  const nativeAdded: { defId: string; params: unknown }[] = [];
  const styled: string[] = [];
  const hidden: string[] = [];
  const pineAdded: string[] = [];
  const nativeStudies = {
    add: (defId: string, params?: unknown) => {
      if (defId === "from-the-future") return null;
      nativeAdded.push({ defId, params });
      return `key:${defId}`;
    },
    setStyle: (key: string, plot: string) => { styled.push(`${key}/${plot}`); },
    toggleVisible: (key: string) => { hidden.push(key); },
  };
  const indicators = {
    add: (row: { name: string }) => { pineAdded.push(row.name); return `pine:${row.name}`; },
    toggleVisible: (key: string) => { hidden.push(key); },
  };

  const result = applyTemplateTo(
    {
      name: "Momentum", createdAt: "",
      indicators: [
        { scriptId: "s1", name: "Alpha", source: "//", params: {}, visible: true },
        { scriptId: null, name: "Quiet", source: "//", params: {}, visible: false },
      ],
      studies: [
        { defId: "rsi", params: { length: 50 }, visible: true,
          styles: { rsi: { color: "#ff0000" } } },
        { defId: "from-the-future", params: {}, visible: true, styles: {} },
      ],
    },
    indicators as never,
    nativeStudies as never,
  );

  assert.deepEqual(result.missing, ["from-the-future"],
    "a study this build lacks is reported, not skipped in silence");
  assert.equal(result.applied, 3);
  assert.deepEqual(nativeAdded, [{ defId: "rsi", params: { length: 50 } }]);
  assert.deepEqual(styled, ["key:rsi/rsi"], "a template restores how the chart LOOKED");
  assert.deepEqual(hidden, ["pine:Quiet"], "and only the study that was saved hidden");
  assert.deepEqual(pineAdded, ["Alpha", "Quiet"]);
});
