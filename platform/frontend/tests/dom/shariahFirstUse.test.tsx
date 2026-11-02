/*
 * The Shariah screen on first use, as a new administrator meets it.
 *
 * Each test here is one friction a fresh-context administrator hit in a real
 * browser (V4 SHARIAH_BEFORE_FRICTION_LEDGER): a per-asset publish that failed
 * with nothing on screen, an expired session whose "sign in again" landed on
 * the chart, enforcement switched on by one click with nothing ELIGIBLE, a
 * "select due assets" control that stayed disabled while four assets needed
 * review, and a snapshot button that was the loudest thing on the page.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { assertAbsent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import ShariahPage from "@/app/shariah/page";
import { resetSessionForTests } from "@/lib/session";
import { SHARIAH_SIGN_IN_HREF, type ShariahAssetState } from "@/lib/shariah";

function asset(over: Partial<ShariahAssetState> & { assetId: string; baseAsset: string }): ShariahAssetState {
  return {
    projectName: null, binanceAvailable: true, classification: "REVIEW", lifecycle: "UNSCREENED",
    effectiveStatus: "REVIEW", policyVersion: "TS_SHARIAH_V1", reason: null, prohibitedCategories: [],
    reviewedAt: null, publishedAt: null, decisionAgeDays: null, dueForReReview: false, ...over,
  };
}

/* A freshly synced install: four UNSCREENED assets, nothing due, nothing ELIGIBLE. */
const FRESH: ShariahAssetState[] = [
  asset({ assetId: "1", baseAsset: "BTC" }),
  asset({ assetId: "2", baseAsset: "ETH" }),
  asset({ assetId: "3", baseAsset: "SOL" }),
  asset({ assetId: "4", baseAsset: "ZEC" }),
];

let mode: "off" | "enforce" = "off";

function seed(assets: ShariahAssetState[] = FRESH): void {
  mode = "off";
  const eligible = assets.filter((a) => a.effectiveStatus === "ELIGIBLE").length;
  server.routes.set("GET /api/shariah/universe", () => ({
    policyVersion: "TS_SHARIAH_V1", prohibitedCategories: ["GAMBLING_BETTING_CASINO"],
    reviewPolicy: { reviewMaxAgeDays: 365 },
    counts: { total: assets.length, active: assets.length, eligible, review: assets.length - eligible,
      excluded: 0, dueForReReview: assets.filter((a) => a.dueForReReview).length },
    assets,
  }));
  server.routes.set("GET /api/shariah/snapshots", () => ({ snapshots: [] }));
  server.routes.set("GET /api/shariah/mode", () => ({ mode, policyVersion: "TS_SHARIAH_V1" }));
  server.routes.set("GET /api/shariah/mode/history", () => ({ changes: [] }));
  server.routes.set("PUT /api/shariah/mode", (body) => {
    mode = (body as { mode: "off" | "enforce" }).mode;
    return { mode, policyVersion: "TS_SHARIAH_V1", botFloorPushed: false };
  });
  server.routes.set("GET /api/shariah/assets/1", () => ({
    asset: assets[0], publications: [],
    evidence: [{ id: "9", url: "https://example.test/btc", title: "Fixture page", publisher: "Test",
      retrievedAt: "2026-11-01T00:00:00.000Z", excerpt: null }],
  }));
}

function me(role: "admin" | "user"): void {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: true, authEnabled: true,
    user: { id: role === "admin" ? "00000000-0000-4000-8000-000000000001" : "22222222-2222-4222-8222-222222222222",
      email: null, displayName: role, avatarUrl: null, onboarded: true, hasPassword: true,
      passwordManagedByServer: false, googleLinked: false, createdAt: "2026-10-16T00:00:00.000Z", role },
    providers: { google: false, signups: true },
  }));
}

beforeEach(() => { resetBrowser(); resetSessionForTests(); seed(); me("admin"); });
after(closeBrowser);

async function mount(): Promise<void> {
  render(<AppRoute path="/shariah"><ShariahPage /></AppRoute>);
  await settle(4);
}

const button = (name: string | RegExp) => screen.queryByRole("button", { name });

async function openBtcPublishForm(): Promise<void> {
  fireEvent.click(screen.getByRole("tab", { name: /Screening & publication/ }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^BTC/ }));
  await settle();
  fireEvent.change(screen.getByLabelText(/^Classification/), { target: { value: "REVIEW" } });
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: "Evidence is thin; kept in REVIEW." } });
  await settle();
}

/** The Notice nearest the publish button — the one the reader is looking at. */
function besidePublish(): HTMLElement {
  const form = screen.getByText("Publish a decision").closest("div")!.parentElement!;
  return form;
}

// ── A2: a refused per-asset publication is said under the button ───────────

test("a server refusal of the per-asset publish is shown inline: Nothing was published, and why", async () => {
  server.routes.set("POST /api/shariah/assets/1/publications", () => new Response(
    JSON.stringify({ error: "ELIGIBLE requires at least one evidence item" }), { status: 400 }));
  await mount();
  await openBtcPublishForm();

  fireEvent.click(screen.getByRole("button", { name: "Publish under TS_SHARIAH_V1" }));
  await settle();

  const alert = within(besidePublish()).getByRole("alert");
  assert.match(alert.textContent ?? "", /^Nothing was published\. ELIGIBLE requires at least one evidence item\./);
  assert.equal(server.callsTo("/api/shariah/assets/1/publications").length, 1);
});

test("a 500 on the per-asset publish is still visible beside the button, never silent", async () => {
  server.routes.set("POST /api/shariah/assets/1/publications", () => new Response("upstream down", { status: 500 }));
  await mount();
  await openBtcPublishForm();
  fireEvent.click(screen.getByRole("button", { name: "Publish under TS_SHARIAH_V1" }));
  await settle();
  const alert = within(besidePublish()).getByRole("alert");
  assert.match(alert.textContent ?? "", /^Nothing was published\. The service did not answer/);
});

test("a successful per-asset publish says so beside the button", async () => {
  server.routes.set("POST /api/shariah/assets/1/publications", () => new Response(JSON.stringify({
    publicationId: "41", assetId: "1", policyVersion: "TS_SHARIAH_V1", classification: "REVIEW",
    lifecycle: "SCREENED", reason: "Evidence is thin; kept in REVIEW.", prohibitedCategories: [], evidenceIds: [],
    baseAssetAtPublication: "BTC", reviewedAt: "2026-11-02T00:00:00.000Z",
    publishedAt: "2026-11-02T00:00:01.000Z", publishedBy: "admin",
  }), { status: 201 }));
  await mount();
  await openBtcPublishForm();
  fireEvent.click(screen.getByRole("button", { name: "Publish under TS_SHARIAH_V1" }));
  await settle();
  assert.match(within(besidePublish()).getByRole("status").textContent ?? "", /Published REVIEW for BTC \(decision #41\)\./);
});

// ── A3: an ended session is told apart, with a way back to this tab ────────

test("a 401 says the session has ended and offers sign-in that returns to the Screening tab", async () => {
  server.routes.set("POST /api/shariah/assets/1/publications", () => new Response(
    JSON.stringify({ error: "not authenticated" }), { status: 401 }));
  await mount();
  await openBtcPublishForm();
  fireEvent.click(screen.getByRole("button", { name: "Publish under TS_SHARIAH_V1" }));
  await settle();

  const alert = within(besidePublish()).getByRole("alert");
  assert.match(alert.textContent ?? "", /Nothing was published\. Your session has ended — sign in again \(you will return here\)\./);
  assert.match(alert.textContent ?? "", /not kept/, "the copy must not promise the pasted text survives");
  const link = within(alert).getByRole("link", { name: "Sign in again" });
  assert.equal(link.getAttribute("href"), SHARIAH_SIGN_IN_HREF);
  assert.equal(decodeURIComponent(SHARIAH_SIGN_IN_HREF), "/login?next=/shariah?view=screening");
  assertAbsent(screen.queryByText(/You may need to sign in again/), "the old guess");
});

test("a 403 is a different refusal: no sign-in offered, it says who may do this", async () => {
  server.routes.set("POST /api/shariah/assets/1/publications", () => new Response(
    JSON.stringify({ error: "This part of the platform is available to the administrator only." }), { status: 403 }));
  await mount();
  await openBtcPublishForm();
  fireEvent.click(screen.getByRole("button", { name: "Publish under TS_SHARIAH_V1" }));
  await settle();
  const alert = within(besidePublish()).getByRole("alert");
  assert.match(alert.textContent ?? "", /only the administrator can/);
  assertAbsent(within(alert).queryByRole("link", { name: "Sign in again" }), "a sign-in link for a valid session");
});

test("the batch import's 401 is the same honest sentence, with the same way back", async () => {
  server.routes.set("POST /api/shariah/review-results/preview", () => ({
    policyVersion: "TS_SHARIAH_V1", researchCompletedAt: "2026-11-02T00:00:00.000Z", packGeneratedAt: null,
    assetCount: 1, counts: { ELIGIBLE: 0, EXCLUDED: 0, REVIEW: 1 }, acknowledgementRequired: [],
    results: [{ assetId: "1", baseAsset: "BTC", classification: "REVIEW", reason: "Thin.", answers: {},
      prohibitedCategories: [], evidenceCount: 0, evidence: [], unresolvedUncertainties: [],
      requiresAcknowledgement: false }],
  }));
  server.routes.set("POST /api/shariah/review-results/import", () => new Response(
    JSON.stringify({ error: "not authenticated" }), { status: 401 }));
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: /Screening & publication/ }));
  await settle();
  fireEvent.change(screen.getByLabelText(/Review results \(TS_SHARIAH_REVIEW_RESULTS_V1\)/),
    { target: { value: JSON.stringify({ format: "TS_SHARIAH_REVIEW_RESULTS_V1", results: [] }) } });
  fireEvent.click(screen.getByRole("button", { name: "Check results" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /Review publication summary/ }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /Confirm publication of 1 decisions/ }));
  await settle();

  const problems = screen.getByRole("list", { name: "Problems with the pasted results" });
  assert.match(problems.textContent ?? "", /Your session has ended — sign in again \(you will return here\)/);
  assert.equal(within(problems).getByRole("link", { name: "Sign in again" }).getAttribute("href"), SHARIAH_SIGN_IN_HREF);
});

// ── A4: turning enforcement ON asks first; OFF stays one click ──────────────

test("Turn on asks first, naming how many assets are ELIGIBLE, and Cancel changes nothing", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  await settle();

  assert.equal(server.calls.filter((c) => c.method === "PUT" && c.path === "/api/shariah/mode").length, 0,
    "one click switched enforcement on");
  const ask = screen.getByRole("alert");
  assert.match(ask.textContent ?? "",
    /0 ELIGIBLE assets right now; every other BUY on this\s+Platform will be refused until you publish ELIGIBLE decisions\. SELL is never blocked\.\s+Nothing you hold is sold\./);

  fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  await settle();
  assertAbsent(screen.queryByText(/every other BUY on this/), "the confirmation after Cancel");
  assert.equal(server.calls.filter((c) => c.method === "PUT").length, 0);
  assert.match(screen.getByText(/^Platform mode:/).textContent ?? "", /OFF/);
});

test("confirming turns enforcement on, the Bot floor sentence still follows, and Turn off is one click", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Turn on enforcement" }));
  await settle(3);

  const puts = server.calls.filter((c) => c.method === "PUT" && c.path === "/api/shariah/mode");
  assert.equal(puts.length, 1);
  assert.match(screen.getByText(/^Platform mode:/).textContent ?? "", /ON/);
  assert.ok(screen.getByText(/Bot floor: not armed/), "the not-armed sentence after the switch");

  fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
  await settle(3);
  assert.equal(server.calls.filter((c) => c.method === "PUT" && c.path === "/api/shariah/mode").length, 2,
    "turning enforcement off must stay one click");
  assert.match(screen.getByText(/^Platform mode:/).textContent ?? "", /OFF/);
});

// ── A5: the legend and the empty state use the same words ──────────────────

test("the legend reconciles UNSCREENED/STALE with REVIEW", async () => {
  await mount();
  assert.ok(screen.getByText(/UNSCREENED and STALE are lifecycle states, not classifications; both count as REVIEW for enforcement\./));
});

// ── A6: one control selects everything needing review ─────────────────────

test("'Select the N assets needing review' ticks every UNSCREENED, STALE and due asset for a pack", async () => {
  seed([
    ...FRESH,
    asset({ assetId: "5", baseAsset: "ADA", lifecycle: "STALE", classification: "ELIGIBLE" }),
    asset({ assetId: "6", baseAsset: "DOT", lifecycle: "SCREENED", classification: "ELIGIBLE",
      effectiveStatus: "ELIGIBLE", dueForReReview: true, decisionAgeDays: 400 }),
    asset({ assetId: "7", baseAsset: "XRP", lifecycle: "SCREENED", classification: "EXCLUDED",
      effectiveStatus: "EXCLUDED" }),
  ]);
  await mount();
  const select = screen.getByRole("button", { name: "Select the 6 assets needing review" });
  assert.equal((select as HTMLButtonElement).disabled, false);
  fireEvent.click(select);
  await settle();

  // It opens the Screening tab with the ticks in the universe list, and the
  // pack download carries exactly those, in queue order.
  const forSelected = screen.getByRole("button", { name: /Download pack for selected/ });
  assert.match(forSelected.textContent ?? "", /\(6\)/);
  const ticked = (ticker: string) =>
    (screen.getByRole("checkbox", { name: `Choose ${ticker} for the next review pack` }) as HTMLInputElement).checked;
  for (const ticker of ["BTC", "ETH", "SOL", "ZEC", "ADA", "DOT"]) assert.equal(ticked(ticker), true, ticker);
  assert.equal(ticked("XRP"), false, "a settled, not-due decision is not 'needing review'");

  fireEvent.click(forSelected);
  await settle();
  const call = server.callsTo("/api/shariah/review-pack").at(-1)!;
  assert.equal(new URL(call.path, "http://x").searchParams.get("assetIds"), "5,1,2,3,4,6",
    "STALE, then UNSCREENED, then due — the queue's own order");
});

test("on a freshly synced install the control is enabled with 4 unscreened assets", async () => {
  await mount();
  assert.match(screen.getByText(/^Needs attention:/).textContent ?? "", /4 unscreened · 0 stale · 0 due for re-review/);
  assert.equal((screen.getByRole("button", { name: "Select the 4 assets needing review" }) as HTMLButtonElement).disabled, false);
});

// ── A10/A12: header is stable; snapshot is optional and explained ───────────

test("the header holds the same controls on both tabs; the snapshot lives in the Snapshots card", async () => {
  await mount();
  const headerButtons = () => ["Turn on", "Sync universe", "Create universe snapshot"]
    .filter((name) => button(name) !== null);
  assert.deepEqual(headerButtons(), ["Turn on", "Sync universe"]);

  fireEvent.click(screen.getByRole("tab", { name: /Screening & publication/ }));
  await settle();
  const snapshot = screen.getByRole("button", { name: "Create universe snapshot" });
  assert.doesNotMatch(snapshot.className, /bg-accent/, "the snapshot action is not the page's primary call to action");
  const card = screen.getByText("Snapshots").closest("div")!.parentElement!;
  assert.ok(card.contains(snapshot), "the snapshot action belongs in the Snapshots card");
  assert.ok(within(card).getByText(/Optional: freezes the current universe list with a content hash for Research runs\.\s+Not required to publish\./));
});

test("the results file control is a product Button over a named file input, and the paste box is the shared field", async () => {
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: /Screening & publication/ }));
  await settle();
  assert.ok(button("Load a results JSON file"));
  const input = screen.getByLabelText("Load a results JSON file", { selector: "input" }) as HTMLInputElement;
  assert.equal(input.type, "file");
  assert.match(input.className, /sr-only/);
  const box = screen.getByLabelText(/Review results \(TS_SHARIAH_REVIEW_RESULTS_V1\)/);
  assert.equal(box.tagName, "TEXTAREA");
  assert.match(box.className, /min-h-\[34px\]/, "the JSON box uses the shared FIELD primitive");
  assert.ok(screen.getByText("Batch review by an external reviewer (ChatGPT or a person)"));
  assert.ok(screen.getByText(/any reviewer may fill the results file — this app only validates its shape and never issues a ruling/));
  assertAbsent(button(/for ChatGPT/), "a ChatGPT-only download label");
});

test("the re-review horizon is the shared 34px Select", async () => {
  await mount();
  const horizon = screen.getByLabelText(/Days after which a settled decision is surfaced as due for re-review/);
  assert.equal(horizon.tagName, "SELECT");
  assert.match(horizon.className, /min-h-\[34px\]/);
});

// ── A11: a reader without a decision is told so ─────────────────────────────

test("an ordinary account sees 'No decision yet' for an unpublished asset, not 'recorded but not enforced'", async () => {
  me("user");
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "Universe & decisions" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^BTC/ }));
  await settle();
  assert.ok(screen.getByText("No decision yet — evidence recorded by the administrator is shown for transparency."));
  assertAbsent(screen.queryByText(/recorded but not enforced/), "a claim that a decision exists");
});

// ── A reload must tell the same Bot-floor story the toggle told ─────────────

test("on load with Mode ON and no Bot control channel, the Bot floor reads NOT ARMED, not unknown", async () => {
  // Right after Turn on the PUT's `botFloorPushed:false` produced "not armed";
  // a reload lost that and the same installation read "unknown — the Bot could
  // not be reached", as though a Bot existed. The read now states the channel.
  server.routes.set("GET /api/shariah/mode", () => ({
    mode: "enforce", policyVersion: "TS_SHARIAH_V1", botControlChannel: false, botMode: null, inSync: null,
  }));
  await mount();
  assert.match(screen.getByText(/^Platform mode:/).textContent ?? "", /ON/);
  assert.ok(screen.getByText(/Bot floor: not armed/), "no channel configured is 'not armed' on a fresh load");
  assertAbsent(screen.queryByText(/could not be reached/), "'unreachable' for an installation with no Bot");
});

test("on load with Mode ON and a configured channel whose Bot did not answer, the Bot floor is UNKNOWN", async () => {
  server.routes.set("GET /api/shariah/mode", () => ({
    mode: "enforce", policyVersion: "TS_SHARIAH_V1", botControlChannel: true, botMode: null, inSync: null,
  }));
  await mount();
  assert.ok(screen.getByText(/Bot floor: unknown/), "a Bot that exists but did not answer is unknown");
  assertAbsent(screen.queryByText(/Bot floor: not armed/), "'not armed' when a channel is configured");
});
