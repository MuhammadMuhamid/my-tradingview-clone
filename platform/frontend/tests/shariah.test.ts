/**
 * The browser side of the Shariah workflow.
 *
 * The one property worth pinning here is a negative: the browser must not
 * decide anything. `parseResultsFile` only parses — it does not validate the
 * contract, repair a field, or judge what is publishable. A UI that quietly
 * disagreed with the backend import boundary would be worse than no preview.
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

test("the review console treats importing as the batch approval, and says so", () => {
  const page = read("app/shariah/page.tsx");
  assert.match(page, /Download next 20 for ChatGPT/);
  assert.match(page, /Import &amp; publish/);
  assert.match(page, /This one action is your approval for the whole batch/);
  assert.match(page, /STALE asset always needs a full\s*\n?\s*fresh screening/);
  // Editing the pasted text invalidates a checked preview.
  assert.match(page, /setPreview\(null\);/);
});
