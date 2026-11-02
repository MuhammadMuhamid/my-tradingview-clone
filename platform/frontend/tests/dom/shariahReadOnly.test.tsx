/*
 * The Shariah screen, as an ordinary account sees it.
 *
 * The backend lets a user READ `/api/shariah/*` and refuses every write with a
 * 403. The page used to render the whole operator surface to that user anyway
 * — Turn on, Sync universe, the batch review, Record evidence, Publish — every
 * one of them a control that appears to work and ends in a refusal, under a
 * header that said "every classification is published deliberately by you".
 * A known user now gets the read-only screen and a header that says who
 * decides; the administrator (and an unknown session) keeps everything.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { assertAbsent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import ShariahPage from "@/app/shariah/page";
import { resetSessionForTests } from "@/lib/session";
import type { ShariahAssetState } from "@/lib/shariah";

const ACCOUNT = {
  id: "22222222-2222-4222-8222-222222222222", email: "trader@example.test", displayName: "Trader",
  avatarUrl: null, onboarded: true, hasPassword: true, passwordManagedByServer: false,
  googleLinked: false, createdAt: "2026-10-16T00:00:00.000Z",
};

function me(role: "admin" | "user"): void {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: true, authEnabled: true, user: { ...ACCOUNT, role },
    providers: { google: false, signups: true },
  }));
}

const AAA: ShariahAssetState = {
  assetId: "1", baseAsset: "AAA", projectName: null, binanceAvailable: true, classification: "ELIGIBLE",
  lifecycle: "SCREENED", effectiveStatus: "ELIGIBLE", policyVersion: "TS_SHARIAH_V1",
  reason: "The ledger is the project's whole material activity.", prohibitedCategories: [],
  reviewedAt: "2026-09-01T00:00:00.000Z", publishedAt: "2026-09-02T00:00:00.000Z",
  decisionAgeDays: 30, dueForReReview: false,
};

function seed(): void {
  server.routes.set("GET /api/shariah/universe", () => ({
    policyVersion: "TS_SHARIAH_V1", prohibitedCategories: ["LENDING"], reviewPolicy: { reviewMaxAgeDays: 365 },
    counts: { total: 1, active: 1, eligible: 1, review: 0, excluded: 0, dueForReReview: 0 },
    assets: [AAA],
  }));
  server.routes.set("GET /api/shariah/snapshots", () => ({ snapshots: [{
    snapshotId: "7", policyVersion: "TS_SHARIAH_V1", contentHash: "abcdef0123456789abcdef",
    entryCount: 1, createdAt: "2026-09-01T00:00:00.000Z", createdBy: "owner",
  }] }));
  server.routes.set("GET /api/shariah/mode", () => ({ mode: "enforce", policyVersion: "TS_SHARIAH_V1" }));
  server.routes.set("GET /api/shariah/mode/history", () => ({ changes: [{
    id: "1", fromMode: "off", toMode: "enforce", changedAt: "2026-09-03T00:00:00.000Z",
    changedBy: "owner", botFloorPushed: true,
  }] }));
  server.routes.set("GET /api/shariah/assets/1", () => ({
    asset: AAA,
    evidence: [{ id: "e1", url: "https://example.com/docs", title: "Protocol docs", publisher: "Example Foundation",
      retrievedAt: "2026-09-01T10:00:00.000Z", excerpt: "Describes the ledger." }],
    publications: [{ publicationId: "12", assetId: "1", policyVersion: "TS_SHARIAH_V1", classification: "ELIGIBLE",
      lifecycle: "SCREENED", reason: "Published after review.", prohibitedCategories: [], baseAssetAtPublication: "AAA",
      reviewedAt: "2026-09-01T00:00:00.000Z", publishedAt: "2026-09-02T00:00:00.000Z",
      publishedBy: "owner", evidenceIds: ["e1"], source: "manual" }],
  }));
}

beforeEach(() => { resetBrowser(); resetSessionForTests(); seed(); });
after(closeBrowser);

async function mount(): Promise<void> {
  render(<AppRoute path="/shariah"><ShariahPage /></AppRoute>);
  await settle();
}

const button = (name: string | RegExp) => screen.queryByRole("button", { name });

/** The universe opens on "Needs review"; the fixture's one asset is ELIGIBLE. */
async function showAllAssets(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Filter the screening universe" }));
  await settle();
  fireEvent.click(screen.getByRole("option", { name: "All assets" }));
  await settle();
}

test("a user reads the screen and is offered no control the server refuses", async () => {
  me("user");
  await mount();

  // The header says who decides, not "published deliberately by you".
  assert.ok(screen.getByText(/Screening decisions and enforcement are managed by the administrator\. This screen shows the current universe and, for each asset, the published decision, its evidence and whether a BUY is allowed under the current mode\./));
  assertAbsent(screen.queryByText(/published deliberately by you/), "the operator's first-person header");
  assertAbsent(screen.queryByText(/^You publish evidence-backed/), "the operator's first-person explanation");

  // Status view: what is enforced is read; nothing that changes it is offered.
  for (const name of [/^Turn on$/, /^Turn off$/, /Sync universe/, /Create universe snapshot/, /Select due assets for a pack/]) {
    assertAbsent(button(name), `the write control ${name}`);
  }
  assertAbsent(screen.queryByLabelText(/Days after which a settled decision is surfaced as due for re-review/),
    "the re-review horizon selector");
  assert.ok(screen.getByText("365 days"), "the horizon is stated");
  assert.ok(screen.getByText(/Platform mode: ON/));
  assert.ok(screen.getByText(/^Bot floor:/), "the Bot floor panel");
  assert.ok(screen.getByText(/Enforcement history — 1 change/));
  assert.ok(screen.getByText("Universe at a glance"));

  // Screening view: the universe, its filter and search, and the snapshots.
  fireEvent.click(screen.getByRole("tab", { name: /Screening & publication/ }));
  await settle();
  assertAbsent(screen.queryByText("Batch review with ChatGPT"), "the batch review panel");
  assertAbsent(button(/Download pack/), "the review-pack download");
  assertAbsent(button(/Check results/), "the results check");
  assertAbsent(button(/Select all shown/), "pack selection");
  assert.equal(screen.queryAllByRole("checkbox", { name: /for the next review pack$/ }).length, 0);
  assertAbsent(button(/Create universe snapshot/), "the snapshot control");
  assert.ok(button("Filter the screening universe"), "the universe filter");
  assert.ok(screen.getByPlaceholderText("Ticker or project name"), "the universe search");
  assert.ok(screen.getByText("#7"), "the snapshots list");
  assert.ok(button("Download snapshot 7 as JSON"), "a snapshot is a read");

  // The asset panel: decision, BUY permission, evidence and history — no forms.
  await showAllAssets();
  fireEvent.click(screen.getByRole("button", { name: /^AAA/ }));
  await settle();
  assert.ok(screen.getByText(/^Current reason:/));
  assert.match(document.querySelector("[data-buy-permission]")?.textContent ?? "",
    /Mode ON: a new BUY of AAAUSDT is allowed \(status ELIGIBLE\)\./);
  assert.ok(screen.getByText("Protocol docs"), "cited evidence is shown");
  assert.ok(screen.getByText("Published decision history"));
  assert.ok(screen.getByText("Published after review."));
  for (const name of [/Record evidence/, /Publish under/, /Correct draft decision/, /Confirm publication/]) {
    assertAbsent(button(name), `the write control ${name}`);
  }
  assertAbsent(screen.queryByText("Publish a decision"), "the publish form");
  assertAbsent(screen.queryByLabelText("URL"), "the evidence form");
  assert.equal(screen.queryAllByRole("checkbox").length, 0, "nothing to select for a decision the user cannot publish");

  const writes = server.calls.filter((c) => c.path.startsWith("/api/shariah") && c.method !== "GET");
  assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), [], "a user's screen attempted a write");
});

test("the administrator keeps the whole operator surface", async () => {
  me("admin");
  await mount();
  assert.ok(screen.getByText(/every classification is published deliberately by you/));
  assert.ok(button(/^Turn off$/));
  assert.ok(button(/Sync universe/));
  assert.ok(screen.getByLabelText(/Days after which a settled decision is surfaced as due for re-review/));

  fireEvent.click(screen.getByRole("tab", { name: /Screening & publication/ }));
  await settle();
  assert.ok(screen.getByText("Batch review with ChatGPT"));
  assert.ok(button(/Create universe snapshot/));
  await showAllAssets();
  assert.ok(screen.getByRole("checkbox", { name: "Choose AAA for the next review pack" }));

  fireEvent.click(screen.getByRole("button", { name: /^AAA/ }));
  await settle();
  assert.ok(screen.getByText("Publish a decision"));
  assert.ok(button(/Record evidence/));
});
