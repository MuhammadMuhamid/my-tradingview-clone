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
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_TEMPLATES, TEMPLATE_STORAGE_KEY, deleteTemplate, findTemplate, loadTemplates,
  parseTemplates, saveTemplates, serializeTemplates, templateFromIndicators, upsertTemplate,
  type IndicatorTemplate,
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
  ...over,
});

// ── the browser is over real things ────────────────────────────────────────

test("the browser invents no marketplace, community or bundled library", () => {
  const source = readCode(BROWSER);
  for (const forbidden of [
    /\bcommunity\b/i, /\bmarketplace\b/i, /\bpurchased\b/i, /\btrending\b/i,
    /\bpopular\b/i, /\beditors?['’]? picks?\b/i, /\bfeatured\b/i, /\bsubscribe\b/i,
    /\bbuilt[- ]?in\b/i,
  ]) {
    assert.doesNotMatch(source, forbidden,
      `${forbidden} promises a source of indicators this product does not have`);
  }
});

test("every category is derived from data the installation really holds", () => {
  const source = read(BROWSER);
  // Script kinds come from the Pine compiler's own `kind`; "on this chart"
  // comes from the focused pane's applied list; templates from local storage.
  assert.match(source, /s\.kind === "indicator"/);
  assert.match(source, /s\.kind === "strategy"/);
  assert.match(source, /applied\.map\(\(i\) => i\.scriptId\)/);
  assert.match(source, /loadTemplates\(\)/);
  assert.match(source, /id: "all", label: "All scripts"/);
  assert.match(source, /id: "onChart", label: "On this chart"/);
});

test("the browser is a modal with the application's own focus and Escape handling", () => {
  const source = read(BROWSER);
  // `components/Modal` is what carries the focus trap, the Escape handler and
  // the dialog role; a hand-rolled overlay would silently miss all three.
  assert.match(source, /import \{ Modal \} from "@\/components\/Modal"/);
  assert.match(source, /<Modal open=\{open\} onClose=\{onClose\}/);
  assert.match(source, /searchRef\.current\?\.focus\(\)/, "search must be focused on open");
  // Reopened fresh, so a stale status line or filter does not persist.
  assert.match(source, /setStatus\(null\);\s*\n\s*setQ\(""\);/);

  const dialogs = read("components/tv/ChartDialogs.tsx");
  assert.match(dialogs, /<IndicatorBrowser/);
  assert.match(dialogs, /open=\{props\.indicatorBrowserOpen\}/);
});

test("adds land on the focused pane's study list, not on a pane the dialog picks", () => {
  const source = readCode(BROWSER);
  assert.doesNotMatch(source, /activePaneId|from "@\/lib\/workspace"/);
  assert.match(source, /indicators\.add\(\{ scriptId: full\.id/);

  const page = read("app/chart/page.tsx");
  assert.match(page, /indicators=\{activeIndicators\}/);
  // `activeIndicators` is resolved from workspace.activePaneId in the page.
  assert.match(page, /const get = indicatorApis\.current\.get\(active\.id\)/);
  assert.match(page, /onOpenIndicators=\{\(\) => setIndicatorBrowserOpen\(true\)\}/);
});

test("the current pane's state is reported truthfully, per script", () => {
  const source = read(BROWSER);
  // The same script can be applied twice with different inputs, so a boolean
  // "added" flag would be a lie; the count is the truth.
  assert.match(source, /applied\.filter\(\(i\) => i\.scriptId === script\.id\)\.length/);
  assert.match(source, /instance\$\{count === 1 \? "" : "s"\}/);
  assert.match(source, /Adds land on the focused chart/);
});

test("a library that cannot be read says so instead of looking empty", () => {
  const source = read(BROWSER);
  assert.match(source, /setLibraryError/);
  assert.match(source, /The script library could not be read/);
  assert.match(source, /Nothing on the chart changed/);
});

test("destructive actions in the browser are named and confirmed", () => {
  const source = read(BROWSER);
  assert.match(source, /window\.confirm\(`Delete “\$\{s\.name\}” from the library\?/);
  assert.match(source, /window\.confirm\(`Delete the template “\$\{template\.name\}”\?/);
  assert.match(source, /Replace the \$\{applied\.length\} stud/,
    "clearing a chart's studies must say how many it is replacing");
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
  assert.deepEqual(Object.keys(t).sort(), ["createdAt", "indicators", "name"]);
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

  const p1 = templateFromIndicators("T", [applied({ params: { b: 2, a: 1 } })]);
  const p2 = templateFromIndicators("T", [applied({ params: { a: 1, b: 2 } })]);
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
  const source = read(BROWSER);
  // `add` always starts a study visible, so a hidden one has to be toggled back.
  assert.match(source, /if \(!row\.visible\) indicators\.toggleVisible\(key\)/);
});
