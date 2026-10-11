/**
 * What a 390px phone does to two shared surfaces, pinned as classes.
 *
 * The phone's touch rule (`globals.css`, `max-width: 640px`) gives every
 * button a 44px minimum. That is right for a page of ordinary controls, and it
 * quietly broke two dense rows that were laid out for 20px buttons:
 *
 *   - A14: a Studies card's eye + BUILT-IN badge + four 44px actions were
 *     286px in a 241px card, so the study NAME — the only flexible item —
 *     shrank to nothing: "● BUILT-IN ⌃⌄⚙", with Remove off the edge.
 *   - A15: symbol search's seven asset-class chips were clipped at "Forex",
 *     its filter labels wrapped to two lines inside 28px chips, and its 18px
 *     clear glyph became a 44px dark disc in a 40px box.
 *
 * jsdom applies no CSS and has no layout, so the rules are asserted where they
 * live — on the classes — and the live 390×844 check is the primary's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("A14 — a Studies card wraps on a phone, so the name keeps its room", () => {
  const panel = read("components/tv/IndicatorsPanel.tsx");
  const rows = [...panel.matchAll(/<div className="([^"]*)" data-study-card-row>/g)].map((m) => m[1]!);
  assert.equal(rows.length, 2, "both card kinds (built-in and Pine) carry the row marker");
  for (const cls of rows) {
    assert.match(cls, /\bmax-sm:flex-wrap\b/, "the row wraps below sm");
    assert.doesNotMatch(cls, /(^|\s)flex-wrap\b/, "and only below sm — a desktop card is one line");
  }
  // The name: flexible, truncating, and guaranteed 120px on the phone.
  const titles = [...panel.matchAll(/className="(min-w-0 flex-1 truncate text-left text-xs text-ink[^"]*)"/g)]
    .map((m) => m[1]!).filter((c) => /max-sm:basis-\[120px\]/.test(c));
  assert.equal(titles.length, 2, "both card titles keep 120px beside their eye on a phone");
  // The actions are a group that drops to its own line, right-aligned.
  assert.equal((panel.match(/flex shrink-0 items-center gap-[0-9.]+ max-sm:ml-auto/g) ?? []).length, 2);
});

test("A15 — symbol search fits a phone: chips scroll, filters stay one line, clear is 24px", () => {
  const search = read("components/tv/SymbolSearch.tsx");
  const chips = /data-asset-class-chips\s+className="([^"]+)"/.exec(search)?.[1] ?? "";
  assert.match(chips, /max-sm:overflow-x-auto/, "the chip row scrolls sideways on a phone");
  assert.match(chips, /max-sm:overflow-y-hidden/, "and only sideways");
  assert.match(chips, /\bh-7\b/, "it stays the 28px band the contract measures");
  assert.match(search, /h-7 shrink-0 whitespace-nowrap rounded-full px-3 text-sm leading-7 transition-colors max-sm:!min-h-7/,
    "each pill keeps 28px instead of the 44px thumb minimum, and never wraps its label");

  const filters = search.slice(search.indexOf("data-search-filters"));
  assert.match(filters, /<div key=\{model\.id\} className="relative min-w-0">/, "a trigger may shrink");
  assert.match(filters, /inline-flex h-7 max-w-full items-center gap-1\.5 whitespace-nowrap/, "on one line");
  assert.match(filters, /<span className="min-w-0 truncate">\{model\.trigger\}<\/span>/, "and truncates");
  assert.doesNotMatch(filters.slice(0, 600), /overflow-x-auto/,
    "the filter row must not scroll — its menus hang from the triggers and would be clipped");

  const clear = /data-search-clear\s+className="([^"]+)"/.exec(search)?.[1] ?? "";
  assert.match(clear, /max-sm:h-6/);
  assert.match(clear, /max-sm:!min-h-6/, "the 44px thumb minimum must not inflate the clear glyph");
  assert.match(clear, /max-sm:!min-w-6/);
});

test("A17 — the cursor row is the hover tint, never a 2px outline box", () => {
  const search = read("components/tv/SymbolSearch.tsx");
  const row = search.slice(search.indexOf("data-idx={i}"), search.indexOf("<AssetMark"));
  assert.match(row, /\$\{i === cursor\s*\?\s*"bg-state-hover"\s*:\s*"hover:bg-state-hover"\}/);
  assert.doesNotMatch(row, /\boutline-2\b/, "the dialog opened with its first row framed like a focused input");
  assert.match(row, /data-highlighted=\{i === cursor \? "true" : undefined\}/);
});
