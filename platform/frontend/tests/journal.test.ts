import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(ROOT, "app", "journal", "page.tsx"), "utf8");
const api = fs.readFileSync(path.join(ROOT, "lib", "api.ts"), "utf8");
const nav = fs.readFileSync(path.join(ROOT, "components", "Nav.tsx"), "utf8");

test("Journal is navigable and uses the bounded authenticated Platform API", () => {
  assert.match(nav, /href: "\/journal", label: "Journal"/);
  assert.match(api, /req<JournalResponse>\(`\/api\/journal\?\$\{params\.toString\(\)\}`\)/);
  assert.match(page, /api\.journal/);
  assert.match(page, /limit: 50/);
});

test("real and paper known results are visually and numerically separate", () => {
  assert.match(page, /title="Real money evidence" scope=\{data\.summary\.real\}/);
  // Renamed in the 02A terminology pass: the badge, the filter option and the
  // delivery mode all say PAPER, and this card is the same idea.
  assert.match(page, /title="Paper evidence" scope=\{data\.summary\.paper\} paper/);
  assert.match(page, /paper \? "PAPER" : "REAL"/);
  assert.match(page, /All · separated/);
});

test("unknown economics are explicit and never styled as profit or loss", () => {
  assert.match(page, /if \(value === null\) return "Unknown"/);
  assert.match(page, /pnlKnown \? signClass\(row\.realizedPnl\) : "text-ink-muted"/);
  assert.match(page, /INCOMPLETE/);
  assert.match(page, /Unknown economics stay unknown/);
});

test("Journal provides bounded filters, period summaries, provenance, and Timeline access", () => {
  for (const label of ["From", "Through", "Source", "Symbol", "Summary"]) {
    assert.match(page, new RegExp(`label="${label}"`));
  }
  assert.match(page, /Daily/); assert.match(page, /Weekly/); assert.match(page, /Monthly/);
  assert.match(page, /Per symbol/);
  assert.match(page, /Strategy \$\{row\.strategy/);
  assert.match(page, /Open deployment timeline/);
  assert.match(page, /Open manual trading/);
});

test("Journal layout adapts without making the page a wide desktop table", () => {
  assert.match(page, /grid-cols-1/);
  assert.match(page, /sm:grid-cols-4 lg:grid-cols-8/);
  assert.match(page, /sm:grid-cols-2/);
  assert.doesNotMatch(page, /<table/);
  assert.match(page, /min-h-11/);
  assert.match(page, /role="alert"/);
  assert.match(page, /role="status"/);
});
