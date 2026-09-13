/**
 * The table of contents, as arithmetic.
 *
 * TVP8 round two: the TOC groups its entries by LAYER — Orientation,
 * Reference, Safety & operations, Troubleshooting — and numbered each one by
 * its index in the FLAT section list. Orientation therefore read
 *
 *   1. What Trading Scene is
 *   2. The four pieces, and which one spends money
 *   3. The normal flow
 *  16. Common workflows
 *
 * because "Common workflows" is the sixteenth section of the document and the
 * fourth of its group. A contents list whose numbers do not count is worse
 * than one with no numbers.
 *
 * The rule below is on the RENDERED ordinals rather than on the source line
 * that produces them: this file's whole point is that a plausible-looking
 * expression produced an implausible list, and only counting catches that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PAGE = path.join(__dirname, "..", "app", "getting-started", "page.tsx");
const source = fs.readFileSync(PAGE, "utf8");

/** `SECTIONS` as `{ id, layer }`, parsed from the declaration. */
function sections(): { id: string; layer: string }[] {
  const start = source.indexOf("const SECTIONS");
  const end = source.indexOf("\n];", start);
  assert.ok(start > 0 && end > start, "the page no longer declares SECTIONS");
  return [...source.slice(start, end).matchAll(
    /\{ id: "([^"]+)", title: "[^"]*", layer: "([^"]+)" \}/g)]
    .map((m) => ({ id: m[1]!, layer: m[2]! }));
}

/** The layer headings, in the order the TOC emits them. */
function layers(): string[] {
  const start = source.indexOf("const LAYER_TITLES");
  const end = source.indexOf("\n};", start);
  return [...source.slice(start, end).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!);
}

test("EVERY GROUP IN THE CONTENTS COUNTS FROM ONE, WITHOUT GAPS", () => {
  const all = sections();
  assert.ok(all.length > 10, `parsed only ${all.length} sections`);

  /*
   * The ordinal the page actually renders, reproduced from the same
   * expression. `filter` then `map` — the repair — makes this 1..n per group;
   * the old `map` with a layer test inside made it the flat index.
   */
  for (const layer of layers()) {
    const inLayer = all.filter((s) => s.layer === layer);
    assert.ok(inLayer.length > 0, `the TOC would print an empty ${layer} group`);
    const rendered = inLayer.map((_, i) => i + 1);
    assert.deepEqual(rendered, Array.from({ length: inLayer.length }, (_, i) => i + 1),
      `${layer} does not count from one`);
  }

  // And the page produces the ordinal from the FILTERED list, which is the
  // only shape that can. Pinned because the two expressions look alike.
  assert.match(source,
    /SECTIONS\.filter\(\(section\) => section\.layer === layer\)\.map\(\(section, i\) => \(/,
    "number the list the reader is looking at, not the document behind it");
  assert.doesNotMatch(source, /SECTIONS\.map\(\(section, i\) => section\.layer === layer &&/,
    "this is the expression that printed 1, 2, 3, 16");
});

test("every section in the list is also a heading in the document", () => {
  /*
   * The other half of "the contents and the body are generated from one list":
   * an entry linking to an anchor that does not exist is a contents line that
   * scrolls nowhere.
   */
  for (const { id } of sections()) {
    assert.ok(source.includes(`<Section id="${id}"`),
      `the contents lists "${id}" and the document has no such section`);
  }
});

test("every layer the sections use has a heading", () => {
  const known = new Set(layers());
  for (const { id, layer } of sections()) {
    assert.ok(known.has(layer),
      `"${id}" is filed under "${layer}", which the TOC has no heading for — `
      + "it would render nowhere at all");
  }
});
