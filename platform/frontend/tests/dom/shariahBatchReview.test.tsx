/*
 * The Shariah batch review, as an operator actually drives it.
 *
 * Each test here is one finding from the review that preceded it:
 *
 * - D-1: the import preview was a rubber stamp. One click published up to a
 *   hundred immutable decisions while the preview showed a name, an evidence
 *   count and a status — and an ELIGIBLE that listed its own open questions
 *   went through unseen, although TS_SHARIAH_V1 resolves unclear materiality
 *   to REVIEW.
 * - D-2: the operator could not choose what got researched; only "the next 20".
 * - D-3: a snapshot — the file Research cites — could not be exported.
 * - D-4: a decision's source (typed vs imported) was written and never read.
 * - D-5: "Needs review" hid assets published as REVIEW and disagreed with the
 *   Review count beside it.
 * - D-7: an import was never checked against the pack it came from.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import ShariahPage from "@/app/shariah/page";
import type { ShariahAssetState } from "@/lib/shariah";

function asset(over: Partial<ShariahAssetState> & { assetId: string; baseAsset: string }): ShariahAssetState {
  return {
    projectName: null, binanceAvailable: true, classification: "REVIEW", lifecycle: "UNSCREENED",
    effectiveStatus: "REVIEW", policyVersion: "TS_SHARIAH_V1", reason: null, prohibitedCategories: [],
    reviewedAt: null, publishedAt: null, decisionAgeDays: null, dueForReReview: false, ...over,
  };
}

/** One asset in every state the filters distinguish. */
const ASSETS: ShariahAssetState[] = [
  asset({ assetId: "1", baseAsset: "AAA" }),
  asset({ assetId: "2", baseAsset: "BBB", lifecycle: "SCREENED", classification: "REVIEW", effectiveStatus: "REVIEW" }),
  asset({ assetId: "3", baseAsset: "CCC", lifecycle: "STALE", classification: "ELIGIBLE", effectiveStatus: "REVIEW" }),
  asset({ assetId: "4", baseAsset: "DDD", lifecycle: "SCREENED", classification: "ELIGIBLE", effectiveStatus: "ELIGIBLE",
    dueForReReview: true, decisionAgeDays: 400 }),
  asset({ assetId: "5", baseAsset: "EEE", lifecycle: "SCREENED", classification: "EXCLUDED", effectiveStatus: "EXCLUDED" }),
];

function pack(assetIds: string[]) {
  return {
    format: "TS_SHARIAH_REVIEW_PACK_V1", policyVersion: "TS_SHARIAH_V1",
    generatedAt: "2026-09-01T08:00:00.000Z", batchSize: assetIds.length, assetCount: assetIds.length,
    needsReviewTotal: 3,
    assets: assetIds.map((id) => ({ assetId: id, baseAsset: ASSETS.find((a) => a.assetId === id)?.baseAsset ?? "?" })),
  };
}

const ANSWERS = {
  project: "A synthetic ledger.", tokenFunction: "Pays network fees.", rightsExposure: "No equity claim.",
  coreActivities: "Operating a general ledger.", prohibitedEvidence: "None found.",
  evidenceSufficiency: "Mostly consistent.",
};

function previewResult(over: Record<string, unknown>) {
  return {
    assetId: "1", baseAsset: "AAA", classification: "ELIGIBLE",
    reason: "The ledger is the project's whole material activity.",
    answers: ANSWERS, prohibitedCategories: [], evidenceCount: 1,
    evidence: [{ url: "https://example.com/docs", title: "Protocol docs", publisher: "Example Foundation",
      retrievedAt: "2026-09-01T10:00:00.000Z", note: "Describes the ledger." }],
    unresolvedUncertainties: [], requiresAcknowledgement: false, ...over,
  };
}

const PREVIEW = {
  policyVersion: "TS_SHARIAH_V1", researchCompletedAt: "2026-09-01T12:00:00.000Z",
  packGeneratedAt: "2026-09-01T08:00:00.000Z", assetCount: 2,
  counts: { ELIGIBLE: 1, EXCLUDED: 0, REVIEW: 1 },
  acknowledgementRequired: ["1"],
  results: [
    previewResult({ unresolvedUncertainties: ["Treasury use of funds is undisclosed."], requiresAcknowledgement: true }),
    previewResult({ assetId: "5", baseAsset: "EEE", classification: "REVIEW", evidence: [], evidenceCount: 0,
      reason: "Lending may be material; the sources conflict." }),
  ],
};

const downloads: string[] = [];

function seed(): void {
  server.routes.set("GET /api/shariah/universe", () => ({
    policyVersion: "TS_SHARIAH_V1", prohibitedCategories: [], reviewPolicy: { reviewMaxAgeDays: 365 },
    counts: { total: 5, active: 5, eligible: 1, review: 3, excluded: 1, dueForReReview: 1 },
    assets: ASSETS,
  }));
  server.routes.set("GET /api/shariah/snapshots", () => ({ snapshots: [{
    snapshotId: "7", policyVersion: "TS_SHARIAH_V1", contentHash: "abcdef0123456789abcdef",
    entryCount: 5, createdAt: "2026-09-01T00:00:00.000Z", createdBy: "owner",
  }] }));
  server.routes.set("GET /api/shariah/snapshots/7", () => ({
    snapshotId: "7", policyVersion: "TS_SHARIAH_V1", contentHash: "abcdef0123456789abcdef",
    entryCount: 1, createdAt: "2026-09-01T00:00:00.000Z", createdBy: "owner",
    entries: [{ assetId: "1", baseAsset: "AAA", effectiveStatus: "REVIEW", classification: "REVIEW",
      lifecycle: "UNSCREENED", binanceAvailable: true, policyVersion: "TS_SHARIAH_V1", publicationId: null }],
  }));
  server.routes.set("GET /api/shariah/mode", () => ({ mode: "off", policyVersion: "TS_SHARIAH_V1" }));
  server.routes.set("GET /api/shariah/mode/history", () => ({ changes: [] }));
  server.routes.set("GET /api/shariah/review-pack", (_body, url) => {
    const ids = url.searchParams.get("assetIds");
    return pack(ids ? ids.split(",") : ["3", "1"]);
  });
  server.routes.set("POST /api/shariah/review-results/preview", () => PREVIEW);
  server.routes.set("POST /api/shariah/review-results/import", () => ({
    policyVersion: "TS_SHARIAH_V1", researchCompletedAt: PREVIEW.researchCompletedAt, importedCount: 2,
    counts: PREVIEW.counts, publishedBy: "owner", outcomes: [],
  }));
  server.routes.set("GET /api/shariah/assets/2", () => ({
    asset: ASSETS[1],
    evidence: [],
    publications: [
      { publicationId: "12", assetId: "2", policyVersion: "TS_SHARIAH_V1", classification: "REVIEW",
        lifecycle: "SCREENED", reason: "Imported.", prohibitedCategories: [], baseAssetAtPublication: "BBB",
        reviewedAt: "2026-09-01T00:00:00.000Z", publishedAt: "2026-09-02T00:00:00.000Z",
        publishedBy: "owner", evidenceIds: [], source: "review_import" },
      { publicationId: "11", assetId: "2", policyVersion: "TS_SHARIAH_V1", classification: "REVIEW",
        lifecycle: "SCREENED", reason: "Typed.", prohibitedCategories: [], baseAssetAtPublication: "BBB",
        reviewedAt: "2026-08-01T00:00:00.000Z", publishedAt: "2026-08-02T00:00:00.000Z",
        publishedBy: "owner", evidenceIds: [], source: "manual" },
      { publicationId: "10", assetId: "2", policyVersion: "TS_SHARIAH_V1", classification: "REVIEW",
        lifecycle: "SCREENED", reason: "Old.", prohibitedCategories: [], baseAssetAtPublication: "BBB",
        reviewedAt: "2026-07-01T00:00:00.000Z", publishedAt: "2026-07-02T00:00:00.000Z",
        publishedBy: "owner", evidenceIds: [], source: null },
    ],
  }));
}

beforeEach(() => {
  resetBrowser();
  seed();
  downloads.length = 0;
  // jsdom has no object URLs and no file downloads; record what would be saved.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:fixture";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { downloads.push(this.download); };
});
after(closeBrowser);

async function openScreening(): Promise<void> {
  render(<AppRoute path="/shariah"><ShariahPage /></AppRoute>);
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: /Screening & publication/ }));
  await settle();
}

const universeRows = (): string[] =>
  screen.queryAllByRole("checkbox", { name: /^Choose .* for the next review pack$/ })
    .map((box) => /^Choose (.*) for the next review pack$/.exec(box.getAttribute("aria-label") ?? "")![1]!);

async function chooseFilter(label: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Filter the screening universe" }));
  await settle();
  fireEvent.click(screen.getByRole("option", { name: label }));
  await settle();
}

async function checkPastedResults(): Promise<void> {
  fireEvent.change(screen.getByLabelText(/ChatGPT results/), { target: { value: '{"format":"x"}' } });
  fireEvent.click(screen.getByRole("button", { name: "Check results" }));
  await settle();
}

// ── D-5 ─────────────────────────────────────────────────────────────────────

test("'Needs review' matches the Review count: a published REVIEW and a STALE asset are in it", async () => {
  await openScreening();
  // The backend's definition — effective status REVIEW — and the count beside it says 3.
  assert.deepEqual(universeRows(), ["AAA", "BBB", "CCC"]);

  await chooseFilter("Stale");
  assert.deepEqual(universeRows(), ["CCC"]);
  await chooseFilter("Due for re-review");
  assert.deepEqual(universeRows(), ["DDD"]);
  await chooseFilter("All assets");
  assert.deepEqual(universeRows(), ["AAA", "BBB", "CCC", "DDD", "EEE"]);
});

// ── D-2 ─────────────────────────────────────────────────────────────────────

test("the operator chooses what is researched: tick, select all, clear, download the selection", async () => {
  await openScreening();
  const forSelected = () => screen.getByRole("button", { name: /Download pack for selected/ });
  assert.equal((forSelected() as HTMLButtonElement).disabled, true, "nothing is chosen yet");

  fireEvent.click(screen.getByRole("checkbox", { name: "Choose CCC for the next review pack" }));
  await settle();
  assert.match(forSelected().textContent ?? "", /\(1\)/);

  // "Select all shown" adds the visible list; switching filter keeps the earlier choice.
  await chooseFilter("All assets");
  fireEvent.click(screen.getByRole("checkbox", { name: "Choose EEE for the next review pack" }));
  await settle();
  assert.match(forSelected().textContent ?? "", /\(2\)/);

  fireEvent.click(forSelected());
  await settle();
  const call = server.callsTo("/api/shariah/review-pack").at(-1)!;
  assert.equal(new URL(call.path, "http://x").searchParams.get("assetIds"), "3,5");
  assert.equal(new URL(call.path, "http://x").searchParams.get("size"), null,
    "a selection must not carry a size the backend would refuse");
  assert.equal(downloads.length, 1);
  assert.match(downloads[0]!, /^shariah-review-pack-.*\.json$/);
  // A downloaded selection is spent.
  assert.match(forSelected().textContent ?? "", /\(0\)/);

  fireEvent.click(screen.getByRole("button", { name: "Select all shown" }));
  await settle();
  assert.match(forSelected().textContent ?? "", /\(5\)/);
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await settle();
  assert.match(forSelected().textContent ?? "", /\(0\)/);
});

test("the queue download carries the chosen size and the include-settled toggle", async () => {
  await openScreening();
  fireEvent.click(screen.getByRole("button", { name: "Assets per pack" }));
  await settle();
  fireEvent.click(screen.getByRole("option", { name: "50 assets" }));
  await settle();
  fireEvent.click(screen.getByRole("checkbox", { name: "Include settled decisions" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Download next 50 for ChatGPT" }));
  await settle();
  const params = new URL(server.callsTo("/api/shariah/review-pack").at(-1)!.path, "http://x").searchParams;
  assert.equal(params.get("size"), "50");
  assert.equal(params.get("includeSettled"), "true");
  assert.equal(params.get("assetIds"), null);
});

// ── D-1 ─────────────────────────────────────────────────────────────────────

test("the preview shows each decision's grounds, not just its verdict", async () => {
  await openScreening();
  await checkPastedResults();
  const list = screen.getByRole("list", { name: "Researched decisions" });
  const text = list.textContent ?? "";
  assert.match(text, /The ledger is the project's whole material activity\./, "the reason is not shown");
  assert.match(text, /Core \/ material activities/);
  assert.match(text, /Operating a general ledger\./, "the researched answers are not shown");
  assert.match(text, /Treasury use of funds is undisclosed\./, "the open questions are not shown");
  const link = within(list).getAllByRole("link", { name: "Protocol docs" })[0]!;
  assert.equal(link.getAttribute("href"), "https://example.com/docs");
  assert.match(link.getAttribute("rel") ?? "", /noopener/);
  assert.match(text, /Lending may be material; the sources conflict\./);
});

test("an ELIGIBLE with open questions blocks the batch until that row is acknowledged, and the import says so", async () => {
  await openScreening();
  await checkPastedResults();
  const publish = () => screen.getByRole("button", { name: /Import & publish/ }) as HTMLButtonElement;
  assert.equal(publish().disabled, true, "an unacknowledged ELIGIBLE-with-uncertainties could publish");
  assert.ok(screen.getByText(/ELIGIBLE with 1 open question/), "the row is not flagged");

  const ack = screen.getByRole("checkbox", {
    name: "Acknowledge AAA's unresolved uncertainties and publish it as ELIGIBLE" });
  fireEvent.click(ack);
  await settle();
  assert.equal(publish().disabled, false);

  fireEvent.click(publish());
  await settle();
  const call = server.callsTo("/api/shariah/review-results/import").at(-1)!;
  assert.equal(new URL(call.path, "http://x").searchParams.get("acknowledgedAssetIds"), "1",
    "the backend enforces the acknowledgement, so it must be sent");
});

test("editing the pasted file discards every acknowledgement", async () => {
  await openScreening();
  await checkPastedResults();
  fireEvent.click(screen.getByRole("checkbox", {
    name: "Acknowledge AAA's unresolved uncertainties and publish it as ELIGIBLE" }));
  await settle();
  // Re-check: a new preview starts unacknowledged.
  await checkPastedResults();
  assert.equal((screen.getByRole("checkbox", {
    name: "Acknowledge AAA's unresolved uncertainties and publish it as ELIGIBLE" }) as HTMLInputElement).checked, false);
  assert.equal((screen.getByRole("button", { name: /Import & publish/ }) as HTMLButtonElement).disabled, true);
});

// ── D-7 ─────────────────────────────────────────────────────────────────────

test("a result for an asset outside the last downloaded pack is flagged", async () => {
  await openScreening();
  await checkPastedResults();
  assert.ok(screen.getByText(/No pack was downloaded on this page since it loaded/),
    "with nothing to compare against, the preview must say so rather than imply a match");

  // The pack held CCC and AAA; the file also answers EEE.
  fireEvent.click(screen.getByRole("button", { name: /Download next 20 for ChatGPT/ }));
  await settle();
  await checkPastedResults();
  assert.ok(screen.getByText(/1 result is for\s+an asset that was not in the pack you last downloaded/));
  const rows = within(screen.getByRole("list", { name: "Researched decisions" })).getAllByRole("listitem")
    .filter((li) => li.parentElement?.getAttribute("aria-label") === "Researched decisions");
  assert.match(rows[1]!.textContent ?? "", /not in the last pack/);
  assert.doesNotMatch(rows[0]!.textContent ?? "", /not in the last pack/);
});

// ── D-3 ─────────────────────────────────────────────────────────────────────

test("a snapshot can be downloaded as the JSON Research cites", async () => {
  await openScreening();
  fireEvent.click(screen.getByRole("button", { name: "Download snapshot 7 as JSON" }));
  await settle();
  assert.equal(server.callsTo("/api/shariah/snapshots/7").filter((c) => c.method === "GET").length, 1);
  assert.deepEqual(downloads, ["shariah-snapshot-7-abcdef012345.json"]);
});

// ── D-4 ─────────────────────────────────────────────────────────────────────

test("the decision history says how each decision arrived", async () => {
  await openScreening();
  fireEvent.click(screen.getByRole("button", { name: /^BBB/ }));
  await settle();
  const history = screen.getByText("Published decision history").closest("div")!.parentElement!;
  const text = history.textContent ?? "";
  assert.match(text, /Imported from review pack/);
  assert.match(text, /Entered by hand/);
  // A row from before the column existed is unknown, never presented as manual.
  assert.match(text, /Source not recorded/);
});

test("a published decision keeps its answers on their own lines, stamped in UTC", async () => {
  /*
   * C-07 / C-08. An imported reason is the researcher's reason followed by one
   * line per answer; as a plain paragraph the six answers ran together. And
   * every stamp was the browser's zone and 12-hour clock with no zone named.
   */
  const reason = "Ledger only.\n\nTS_SHARIAH_V1 review answers:\n- Project: A ledger.\n- Token function: Gas.";
  server.routes.set("GET /api/shariah/assets/2", () => ({
    asset: { ...ASSETS[1], reason },
    evidence: [],
    publications: [
      { publicationId: "12", assetId: "2", policyVersion: "TS_SHARIAH_V1", classification: "REVIEW",
        lifecycle: "SCREENED", reason, prohibitedCategories: [], baseAssetAtPublication: "BBB",
        reviewedAt: "2026-09-01T00:00:00.000Z", publishedAt: "2026-09-02T15:04:00.000Z",
        publishedBy: "owner", evidenceIds: [], source: "review_import" },
    ],
  }));
  await openScreening();
  fireEvent.click(screen.getByRole("button", { name: /^BBB/ }));
  await settle();
  const shown = document.querySelector("[data-publication-reason]") as HTMLElement;
  assert.equal(shown.textContent, reason, "the text is the published text, line breaks included");
  assert.match(shown.className, /whitespace-pre-line/, "and its line breaks are rendered, not collapsed");
  const history = screen.getByText("Published decision history").closest("div")!.parentElement!;
  assert.match(history.textContent ?? "", /2026-09-02 15:04 UTC · owner/,
    "a publication is stamped in UTC, 24-hour, and says so");
  assert.doesNotMatch(history.textContent ?? "", /\b(AM|PM)\b/);
});
