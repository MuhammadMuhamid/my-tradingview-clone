/**
 * The browser side of the Shariah workflow.
 *
 * The one property worth pinning here is a negative: the browser must not
 * decide anything. `parseResultsFile` only parses, the status a component
 * renders is the backend gate's own answer, and the exposure rule is not
 * reimplemented client-side. A UI that quietly disagreed with the backend
 * would be worse than one that showed nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseResultsFile, downloadReviewPack, type ShariahReviewPack } from "../lib/shariah";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("parseResultsFile parses JSON and nothing else", () => {
  const parsed = parseResultsFile('  {"format":"TS_SHARIAH_REVIEW_RESULTS_V1","results":[]}  ');
  assert.deepEqual(parsed, { format: "TS_SHARIAH_REVIEW_RESULTS_V1", results: [] });

  // It does NOT validate, repair or reshape — that is the backend's job, and a
  // browser that pre-judged would either reject valid files or promise a
  // publication the backend then refuses.
  assert.deepEqual(parseResultsFile('{"anything":1}'), { anything: 1 });
});

test("an unparseable results file gets an instruction, not a stack trace", () => {
  assert.throws(() => parseResultsFile(""), /paste or choose a results file first/);
  assert.throws(() => parseResultsFile("   "), /paste or choose a results file first/);
  assert.throws(
    () => parseResultsFile('```json\n{"a":1}\n```'),
    /no markdown fence, no commentary/
  );
});

test("downloading a pack is a no-op without a DOM rather than a crash", () => {
  const pack = { generatedAt: "2026-09-02T00:00:00.000Z", assets: [] } as unknown as ShariahReviewPack;
  assert.equal(downloadReviewPack(pack), false);
});

test("the browser never re-derives the exposure rule", () => {
  const panel = read("components/tv/ManualTradingPanel.tsx");
  // It asks the backend and renders the answer.
  assert.match(panel, /shariahApi\.status\(symbol\)/);
  assert.match(panel, /!shariah\.buyAllowed/);
  // It must not decide eligibility from a raw classification of its own.
  assert.doesNotMatch(panel, /effectiveStatus\s*===\s*"ELIGIBLE"/);
  // And SELL is never gated: the block is scoped to BUY only.
  assert.match(panel, /side === "BUY" && shariah !== null && !shariah\.buyAllowed/);
});

test("the review console treats importing as the batch approval, and says so", () => {
  const page = read("app/shariah/page.tsx");
  assert.match(page, /Download next 20 for ChatGPT/);
  assert.match(page, /Import &amp; publish/);
  assert.match(page, /This one action is your approval for the whole batch/);
  assert.match(page, /STALE asset always needs a full\s*\n?\s*fresh screening/);
  // Editing the pasted text invalidates a checked preview.
  assert.match(page, /setPreview\(null\);/);
});

test("the Shariah Mode toggle renders the server's value, never a local one", () => {
  const page = read("app/shariah/page.tsx");
  // `normalizeShariahMode` widens the response into a total record — it fills
  // an absent field with "not stated" and never with a value. The page still
  // renders exactly what the server sent and holds no authoritative copy.
  assert.match(page, /const saved = normalizeShariahMode\(await shariahApi\.setMode\(next\)\);/);
  assert.match(page, /setModeState\(saved\)/);
  assert.match(page, /const mode: ShariahMode \| null = modeState\?\.mode \?\? null;/);
  // No localStorage anywhere in the Shariah surface: the mode is backend state,
  // because the gate that enforces it is backend code.
  assert.doesNotMatch(page, /localStorage/);
  assert.doesNotMatch(read("lib/shariah.ts"), /localStorage/);
});
