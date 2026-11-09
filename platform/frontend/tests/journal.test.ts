import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(ROOT, "app", "journal", "page.tsx"), "utf8");
const api = fs.readFileSync(path.join(ROOT, "lib", "api.ts"), "utf8");
const nav = fs.readFileSync(path.join(ROOT, "lib", "navigation.ts"), "utf8");

test("Journal is navigable and uses the bounded authenticated Platform API", () => {
  assert.match(nav, /href: "\/journal", label: "Journal"/);
  assert.match(api, /req<JournalResponse>\(`\/api\/journal\?\$\{params\.toString\(\)\}`\)/);
  assert.match(page, /api\.journal/);
  assert.match(page, /limit: 50/);
});

test("each environment's known results are visually and numerically separate", () => {
  assert.match(page, /title="Real money evidence" scope=\{data\.summary\.real\} environment="REAL"/);
  // Renamed in the 02A terminology pass: the badge, the filter option and the
  // delivery mode all say PAPER, and this card is the same idea.
  assert.match(page, /title="Paper evidence" scope=\{data\.summary\.paper\} environment="PAPER"/);
  // D3: testnet, dry-run and unproven rows used to sit inside the real card.
  assert.match(page, /title="Testnet evidence" scope=\{data\.summary\.testnet\} environment="TESTNET"/);
  assert.match(page, /title="Dry-run evidence" scope=\{data\.summary\.dryRun\} environment="DRY_RUN"/);
  assert.match(page, /title="Unknown environment" scope=\{data\.summary\.unknownEnvironment\} environment="UNKNOWN"/);
  // The card badge is chosen by the card's environment, not by a boolean.
  assert.match(page, /<EnvironmentBadge environment=\{environment\} \/>/);
  assert.doesNotMatch(page, /paper \? "PAPER" : "REAL"/);
  assert.match(page, /All · separated/);
});

test("every row and every grouped line names its environment", () => {
  // The Manual claimed a per-row REAL/PAPER badge that the page never drew.
  assert.match(page, /<EnvironmentBadge environment=\{row\.environment\} \/>/);
  assert.match(page, /\{item\.bucket\} · \{item\.source\} · \{ENVIRONMENT_LABEL\[item\.environment\]\}/);
  assert.match(page, /\{item\.symbol\} · \{item\.source\} · \{ENVIRONMENT_LABEL\[item\.environment\]\}/);
  // The words are the chart chip's own (tests/executionEnvironment.test.ts).
  assert.match(page, /\.\.\.EXECUTION_ENVIRONMENT_LABEL, PAPER: "PAPER"/);
  assert.match(api, /export type JournalEnvironment = "REAL" \| "TESTNET" \| "DRY_RUN" \| "PAPER" \| "UNKNOWN";/);
  assert.match(api, /environment: JournalEnvironment; symbol: string;/);
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
  /*
   * TVP8: the alert and status roles moved INTO the shared primitives —
   * `ErrorNotice` renders `<Notice role="alert">` and `Loading` renders
   * `role="status"`. Asserting the raw attribute here would now push the page
   * back to hand-rolling both, which is the opposite of what this campaign is
   * for, so the assertion is on the primitives and on the roles they carry.
   */
  assert.match(page, /<ErrorNotice error=\{error\}/);
  assert.match(page, /<Loading>/);
  const ui = fs.readFileSync(path.join(ROOT, "components", "ui.tsx"), "utf8");
  assert.match(ui, /<Notice tone="error" role="alert">/,
    "ErrorNotice is what now carries the alert role for this page");
  assert.match(ui, /export function Loading\([\s\S]*?role="status"/,
    "Loading is what now carries the status role");
});
