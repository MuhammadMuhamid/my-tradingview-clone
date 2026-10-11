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
import {
  comparePreviewToPack, downloadReviewPack, downloadSnapshot, filterUniverse, importResultsPath,
  ResultsFileError, evidenceCitedLabel, parseResultsFile, publicationSourceLabel, reviewPackPath,
  type ShariahAssetState, type ShariahReviewPack, type ShariahSnapshot,
} from "../lib/shariah";

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
  assert.throws(() => parseResultsFile(""), /Paste or choose a results file first/);
  assert.throws(() => parseResultsFile("   "), /Paste or choose a results file first/);
  assert.throws(
    () => parseResultsFile('```json\n{"a":1}\n```'),
    /no markdown fence, no commentary/
  );
  // C-03: it is the paste's problem, said as one — with where the parser stopped.
  assert.throws(() => parseResultsFile("this is { not json"), (e: unknown) =>
    e instanceof ResultsFileError && /^The pasted text is not a JSON document: .+\. Paste only/.test(e.message));
});

test("downloading a pack is a no-op without a DOM rather than a crash", () => {
  const pack = { generatedAt: "2026-09-02T00:00:00.000Z", assets: [] } as unknown as ShariahReviewPack;
  assert.equal(downloadReviewPack(pack), false);
});

test("a snapshot download is a no-op without a DOM rather than a crash", () => {
  const snapshot = { snapshotId: "7", contentHash: "abc", entries: [] } as unknown as ShariahSnapshot;
  assert.equal(downloadSnapshot(snapshot), false);
});

test("'Needs review' is the backend's definition, and agrees with counts.review", () => {
  const a = (over: Partial<ShariahAssetState>): ShariahAssetState => ({
    assetId: "1", baseAsset: "A", projectName: null, binanceAvailable: true, classification: "REVIEW",
    lifecycle: "UNSCREENED", effectiveStatus: "REVIEW", policyVersion: "TS_SHARIAH_V1", reason: null,
    prohibitedCategories: [], reviewedAt: null, publishedAt: null, ...over,
  });
  const assets = [
    a({ assetId: "1" }),
    a({ assetId: "2", lifecycle: "SCREENED" }), // a deliberately published REVIEW
    a({ assetId: "3", lifecycle: "STALE" }),
    a({ assetId: "4", lifecycle: "SCREENED", classification: "ELIGIBLE", effectiveStatus: "ELIGIBLE", dueForReReview: true }),
    a({ assetId: "5", binanceAvailable: false }), // delisted: not counted as active work
    a({ assetId: "6", lifecycle: "SCREENED", classification: "ELIGIBLE", effectiveStatus: "ELIGIBLE",
      dueForReReview: true, binanceAvailable: false }),
  ];
  const ids = (f: Parameters<typeof filterUniverse>[1]) => filterUniverse(assets, f).map((x) => x.assetId);
  assert.deepEqual(ids("needs-review"), ["1", "2", "3"]);
  // `counts.review` on the backend is: active and effectively REVIEW.
  assert.equal(ids("needs-review").length,
    assets.filter((x) => x.binanceAvailable && x.effectiveStatus === "REVIEW").length);
  assert.deepEqual(ids("stale"), ["3"]);
  assert.deepEqual(ids("due"), ["4"]);
  assert.deepEqual(ids("all"), ["1", "2", "3", "4", "5", "6"]);
});

test("an explicit selection sends only assetIds; the queue sends only size/includeSettled", () => {
  assert.equal(reviewPackPath(), "/api/shariah/review-pack");
  assert.equal(reviewPackPath({ size: 50, includeSettled: true }),
    "/api/shariah/review-pack?size=50&includeSettled=true");
  assert.equal(reviewPackPath({ assetIds: ["3", "1"] }), "/api/shariah/review-pack?assetIds=3%2C1");
  assert.equal(importResultsPath(), "/api/shariah/review-results/import");
  assert.equal(importResultsPath(["1", "4"]), "/api/shariah/review-results/import?acknowledgedAssetIds=1,4");
});

test("a preview is compared with the last pack, and says when it cannot be", () => {
  const preview = {
    packGeneratedAt: "2026-09-01T08:00:00Z",
    results: [{ assetId: "1" }, { assetId: "9" }],
  } as unknown as Parameters<typeof comparePreviewToPack>[0];
  assert.deepEqual(comparePreviewToPack(preview, null), { known: false, notInPack: [], differentPack: false });
  assert.deepEqual(comparePreviewToPack(preview, { generatedAt: "2026-09-01T08:00:00.000Z", assetIds: ["1", "2"] }),
    { known: true, notInPack: ["9"], differentPack: false });
  assert.equal(comparePreviewToPack(preview, { generatedAt: "2026-09-02T08:00:00.000Z", assetIds: ["1", "9"] })
    .differentPack, true);
  // No echo in the file: no claim either way about which pack it answers.
  assert.equal(comparePreviewToPack({ ...preview, packGeneratedAt: null },
    { generatedAt: "2026-09-02T08:00:00.000Z", assetIds: ["1", "9"] }).differentPack, false);
});

test("a decision's source reads as what is known, and unknown is never 'manual'", () => {
  assert.equal(publicationSourceLabel("review_import"), "Imported from review pack");
  assert.equal(publicationSourceLabel("manual"), "Entered by hand");
  assert.equal(publicationSourceLabel(null), "Source not recorded");
  assert.equal(publicationSourceLabel(undefined), "Source not recorded");
});

test("C-10 a decision's evidence is counted, and the ids are labelled as ids", () => {
  // "Evidence: 3" for ONE entry whose id is 3 read as three pieces of evidence.
  assert.equal(evidenceCitedLabel(["3"]), "1 evidence (#3)");
  assert.equal(evidenceCitedLabel(["3", "12"]), "2 evidence (#3, #12)");
  assert.equal(evidenceCitedLabel([]), "No evidence cited");
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
  // The queue download is sized by a picker now (10/20/50, 20 by default).
  assert.match(page, /Download next \{size\} for ChatGPT/);
  assert.match(page, /useState\("20"\)/);
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
