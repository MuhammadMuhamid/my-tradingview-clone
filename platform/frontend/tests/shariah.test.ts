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
  comparePreviewToPack, countLabel, downloadReviewPack, downloadSnapshot, filterUniverse, formatUniverseSync,
  importResultsPath,
  ResultsFileError, evidenceCitedLabel, parseResultsFile, publicationSourceLabel, reviewPackPath,
  type ShariahAssetState, type ShariahReviewPack, type ShariahSnapshot,
  SHARIAH_SIGN_IN_HREF, ShariahRequestError, assetsNeedingAttention, identityRefusal, namedAssetList,
  sessionEnded,
} from "../lib/shariah";
import { safeNextPath } from "../lib/safeRedirect";
import { failureReason } from "../lib/errorCopy";

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

test("the review console separates checking, summary review, and batch approval", () => {
  const page = read("app/shariah/page.tsx");
  // The queue download is sized by a picker now (10/20/50, 20 by default).
  assert.match(page, /Download next \{size\}/);
  assert.match(page, /useState\("20"\)/);
  assert.match(page, /Review publication summary/);
  assert.match(page, /Confirm publication of/);
  assert.match(page, /Review the summary, then confirm publication for the whole batch/);
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

test("a universe sync reads as counts with names, not interpolated arrays", () => {
  /*
   * The backend sends base-asset LISTS; the client typed them as numbers and
   * the notice printed "BTC,ETH,SOL newly discovered, relisted, no longer
   * tracked" — the empty lists vanished and the names stood in for a count.
   */
  const notice = formatUniverseSync({
    policyVersion: "TS_SHARIAH_V1", qualifying: 3,
    created: ["BTC", "ETH", "SOL"], reactivated: [], deactivated: [],
  });
  assert.match(notice, /^Universe synced against 3 qualifying Binance Spot USDT base assets: /);
  assert.match(notice, /: 3 newly discovered \(BTC, ETH, SOL\), 0 relisted, 0 no longer tracked\. /);
  // The explanation that discovery is not approval survives.
  assert.match(notice, /Newly discovered assets are UNSCREENED, which counts as REVIEW/);
  assert.match(notice, /nothing new can be bought until you publish a decision\.$/);

  const one = formatUniverseSync({
    policyVersion: "TS_SHARIAH_V1", qualifying: 1, created: [], reactivated: ["DOT"], deactivated: ["LUNA"],
  });
  assert.match(one, /against 1 qualifying Binance Spot USDT base asset: 0 newly discovered, 1 relisted \(DOT\), 1 no longer tracked \(LUNA\)\./);

  // A first sync of a large install names a few and counts the rest.
  const many = Array.from({ length: 12 }, (_, i) => `A${i}`);
  assert.match(formatUniverseSync({ policyVersion: "TS_SHARIAH_V1", qualifying: 12, created: many, reactivated: [], deactivated: [] }),
    /12 newly discovered \(A0, A1, A2, A3, A4, A5, A6, A7, A8, A9, \+2 more\)/);
});

test("countLabel agrees the noun with the count", () => {
  assert.equal(countLabel(0, "citation", "citations"), "0 citations");
  assert.equal(countLabel(1, "citation", "citations"), "1 citation");
  assert.equal(countLabel(2, "uncertainty", "uncertainties"), "2 uncertainties");
});

// ── V4 first use ────────────────────────────────────────────────────────────

const state = (over: Partial<ShariahAssetState> & { assetId: string; baseAsset: string }): ShariahAssetState => ({
  projectName: null, binanceAvailable: true, classification: "REVIEW", lifecycle: "UNSCREENED",
  effectiveStatus: "REVIEW", policyVersion: "TS_SHARIAH_V1", reason: null, prohibitedCategories: [],
  reviewedAt: null, publishedAt: null, decisionAgeDays: null, dueForReReview: false, ...over,
});

test("assets needing attention: STALE, then UNSCREENED, then active due decisions — nothing settled and current", () => {
  const picked = assetsNeedingAttention([
    state({ assetId: "1", baseAsset: "AAA" }),
    state({ assetId: "2", baseAsset: "BBB", lifecycle: "SCREENED", effectiveStatus: "ELIGIBLE", dueForReReview: true }),
    state({ assetId: "3", baseAsset: "CCC", lifecycle: "STALE" }),
    state({ assetId: "4", baseAsset: "DDD", lifecycle: "SCREENED", effectiveStatus: "EXCLUDED" }),
    // Due but delisted: not counted, exactly as counts.dueForReReview does not count it.
    state({ assetId: "5", baseAsset: "EEE", lifecycle: "SCREENED", effectiveStatus: "ELIGIBLE",
      dueForReReview: true, binanceAvailable: false }),
    state({ assetId: "6", baseAsset: "FFF" }),
  ]);
  assert.deepEqual(picked.map((a) => a.baseAsset), ["CCC", "AAA", "FFF", "BBB"]);
});

test("a downloaded pack is named, not just counted, and a long one stays one line", () => {
  assert.equal(namedAssetList(["BTC", "ETH", "SOL"]), "BTC, ETH, SOL (3)");
  const many = Array.from({ length: 23 }, (_, i) => `T${i}`);
  assert.equal(namedAssetList(many), "T0, T1, T2, T3, T4, T5, T6, T7, T8, T9 and 13 more (23)");
});

test("an ended session is told apart from every other refusal, and the way back lands on this tab", () => {
  const ended = new ShariahRequestError("not authenticated", 401);
  assert.equal(sessionEnded(ended), true);
  assert.match(identityRefusal(ended)!, /^Your session has ended — sign in again \(you will return here\)\./);
  const forbidden = new ShariahRequestError("This part of the platform is available to the administrator only.", 403);
  assert.equal(sessionEnded(forbidden), false);
  assert.match(identityRefusal(forbidden)!, /only the administrator can/);
  // A refusal of the decision itself is the server's own sentence, not an identity problem.
  const refused = new ShariahRequestError("ELIGIBLE requires at least one evidence item", 400);
  assert.equal(identityRefusal(refused), null);
  assert.equal(failureReason(refused), "ELIGIBLE requires at least one evidence item.");
  // The login page accepts the target as-is: it is a same-origin path.
  assert.equal(safeNextPath(new URL(SHARIAH_SIGN_IN_HREF, "http://x").searchParams.get("next")), "/shariah?view=screening");
});
