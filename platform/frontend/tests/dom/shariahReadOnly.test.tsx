/*
 * The Shariah screen, as an ordinary account sees it.
 *
 * The backend lets a user READ `/api/shariah/*` and refuses every write with a
 * 403. The page used to render the whole operator surface to that user anyway
 * — Turn on, Sync universe, the batch review, Record evidence, Publish — every
 * one of them a control that appears to work and ends in a refusal, under a
 * header that said "every classification is published deliberately by you".
 * A known user now gets the read-only screen and a header that says who
 * decides; the administrator keeps everything. While the session is still
 * being read, or when it could not be read at all, nobody is offered a write
 * control: the read-only view is the neutral one (`sessionUnreadable` tests
 * the failed read).
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
  for (const name of [/^Turn on$/, /^Turn off$/, /Sync universe/, /Create universe snapshot/, /needing review/]) {
    assertAbsent(button(name), `the write control ${name}`);
  }
  assertAbsent(screen.queryByLabelText(/Days after which a settled decision is surfaced as due for re-review/),
    "the re-review horizon selector");
  assert.ok(screen.getByText("365 days"), "the horizon is stated");
  assert.ok(screen.getByText(/Platform mode: ON/));
  assert.ok(screen.getByText(/^Bot floor:/), "the Bot floor panel");
  assert.ok(screen.getByText(/Enforcement history — 1 change/));
  assert.ok(screen.getByText("Universe at a glance"));
  // A reader's controls say what they do for a reader: they show, they do not review.
  assert.ok(button("Show unresolved"));
  assert.ok(button(/^Show due today/));
  assertAbsent(button(/^Review unresolved assets$/), "the operator's review wording");
  assertAbsent(screen.queryByRole("tab", { name: /Screening & publication/ }), "the operator's tab name");

  // Universe view: the universe, its filter and search, and the snapshots.
  fireEvent.click(screen.getByRole("tab", { name: "Universe & decisions" }));
  await settle();
  assertAbsent(screen.queryByText("Batch review by an external reviewer (ChatGPT or a person)"), "the batch review panel");
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
  assert.ok(screen.getByText("Batch review by an external reviewer (ChatGPT or a person)"));
  assert.ok(button(/Create universe snapshot/));
  await showAllAssets();
  assert.ok(screen.getByRole("checkbox", { name: "Choose AAA for the next review pack" }));

  fireEvent.click(screen.getByRole("button", { name: /^AAA/ }));
  await settle();
  assert.ok(screen.getByText("Publish a decision"));
  assert.ok(button(/Record evidence/));
});

/*
 * While the session is still being read the role is unknown. The operator's
 * controls must not flash in that window — an ordinary account would watch
 * Turn on and Sync appear and vanish — and nothing may say the screen is
 * refused either. The read-only view is the neutral one.
 */
function assertNeutral(): void {
  for (const name of [/^Turn on$/, /^Turn off$/, /Sync universe/, /Create universe snapshot/, /needing review/]) {
    assertAbsent(button(name), `the write control ${name} before the role is known`);
  }
  assertAbsent(screen.queryByLabelText(/Days after which a settled decision is surfaced as due for re-review/),
    "the re-review horizon selector before the role is known");
  assertAbsent(screen.queryByText(/published deliberately by you/), "the operator's header before the role is known");
  assertAbsent(screen.queryByText(/managed by the administrator/), "the user's header before the role is known");
  assertAbsent(screen.queryByText(/^You publish evidence-backed/), "the operator's first-person line before the role is known");
  assertAbsent(screen.queryByText(/^The administrator publishes/), "the user's line before the role is known");
  assert.ok(screen.getByText(/Screening decisions are published deliberately; nothing here is decided automatically\./),
    "the role-free header while the role is unknown");
  assertAbsent(screen.queryByText(/administrator only/), "a refusal for a question still being answered");
  assert.ok(screen.getByText(/Platform mode: ON/), "the screen itself is read meanwhile");
}

test("an unknown session shows the neutral read-only screen, then the administrator's controls appear", async () => {
  me("admin");
  const release = server.hold("/api/auth/me");
  await mount();
  assertNeutral();

  release();
  await settle();
  assert.ok(screen.getByText(/every classification is published deliberately by you/));
  assert.ok(screen.getByText(/^You publish evidence-backed/));
  assertAbsent(screen.queryByText(/Screening decisions are published deliberately;/), "the role-free header after the answer");
  assert.ok(button(/^Turn off$/), "the administrator's mode control");
  assert.ok(button(/Sync universe/));
  assert.ok(screen.getByLabelText(/Days after which a settled decision is surfaced as due for re-review/));
});

test("an unknown session shows the neutral read-only screen, then an ordinary account stays read-only", async () => {
  me("user");
  const release = server.hold("/api/auth/me");
  await mount();
  assertNeutral();

  release();
  await settle();
  assert.ok(screen.getByText(/Screening decisions and enforcement are managed by the administrator\./),
    "the user's header once the role is known");
  assert.ok(screen.getByText(/^The administrator publishes evidence-backed/), "the user's line once the role is known");
  assertAbsent(screen.queryByText(/Screening decisions are published deliberately;/), "the role-free header after the answer");
  assertAbsent(button(/^Turn off$/), "the mode control for a known user");
  assertAbsent(button(/Sync universe/), "Sync for a known user");
  assert.ok(screen.getByText("365 days"), "the horizon is stated, not offered");
});
