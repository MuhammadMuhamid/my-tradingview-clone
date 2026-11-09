/**
 * D3 on the page: every Journal row says which money it is about, and the
 * "Real money evidence" card shows REAL rows only.
 *
 * The Journal used to label simulated, dry-run and testnet activity REAL, and
 * the in-product Manual promised a per-row REAL/PAPER badge the page never
 * drew. The backend now decides each row's environment from that row's own
 * evidence; this checks the page renders exactly what it is given — a badge
 * per row, one card per environment, and an environment on every grouped
 * line — and never folds another environment into the real figure.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { screen } from "@testing-library/react";
import { assertPresent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import JournalPage from "@/app/journal/page";
import { resetSessionForTests } from "@/lib/session";
import { EXECUTION_ENVIRONMENT_TONE } from "@/lib/executionEnvironment";
import type {
  JournalEnvironment, JournalResponse, JournalRow, JournalSource, JournalSummarySlice,
} from "@/lib/api";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

function admin(): void {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: true, authEnabled: true,
    user: {
      id: "22222222-2222-4222-8222-222222222222", email: "owner@example.test", displayName: "Owner",
      avatarUrl: null, role: "admin", onboarded: true, hasPassword: true, passwordManagedByServer: false,
      googleLinked: false, createdAt: "2026-10-16T00:00:00.000Z",
    },
    providers: { google: false, signups: true },
  }));
}

const AT = "2026-11-04T12:00:00.000Z";
function row(symbol: string, source: JournalSource, environment: JournalEnvironment,
  realizedPnl: number | null): JournalRow {
  const realized = realizedPnl !== null;
  return {
    id: `${source}-${environment}-${symbol}`, kind: realized ? "REALIZATION" : "ACTIVITY", source, environment,
    symbol, side: realized ? "SELL" : "BUY",
    title: realized ? "Persisted realized outcome" : "Manual executed activity",
    occurredAt: AT, entryAt: null, realizationAt: realized ? AT : null, durationMs: null,
    quantity: 0.1, entryPrice: null, exitPrice: realized ? 100 : null, grossRealizedPnl: null, fees: null,
    realizedPnl, netRealizedPnl: null, economicsState: realized ? "KNOWN" : "UNKNOWN", feeState: "UNKNOWN",
    evidenceState: "INCOMPLETE", evidenceDetail: "fixture evidence", strategy: null, deploymentId: null,
    config: null, reason: null, identifiers: {},
  };
}
function slice(knownRealizedPnl: number, knownRealizedRows: number, unknownEconomicRows: number): JournalSummarySlice {
  return { knownRealizedPnl, knownRealizedRows, realizationRows: knownRealizedRows, knownFees: 0, feeKnownRows: 0,
    wins: knownRealizedPnl > 0 ? 1 : 0, losses: knownRealizedPnl < 0 ? 1 : 0, scratches: 0,
    incompleteRows: knownRealizedRows + unknownEconomicRows, unknownEconomicRows, durationKnownRows: 0,
    averageDurationMs: null };
}

const ROWS: JournalRow[] = [
  row("BTCUSDT", "AUTOMATED", "REAL", 10),
  row("ADAUSDT", "AUTOMATED", "TESTNET", 100),
  row("DOGEUSDT", "AUTOMATED", "DRY_RUN", 1000),
  row("BNBUSDT", "AUTOMATED", "UNKNOWN", 7),
  row("XRPUSDT", "PAPER", "PAPER", -3),
  row("ETHUSDT", "MANUAL", "TESTNET", null),
  row("SOLUSDT", "MANUAL", "DRY_RUN", null),
];
const RESPONSE: JournalResponse = {
  rows: ROWS,
  page: { number: 1, limit: 50, hasNext: false },
  range: { from: "2026-10-06T00:00:00.000Z", toExclusive: "2026-11-05T00:00:00.000Z", period: "day" },
  summary: {
    ...slice(1114, 5, 2),
    real: slice(10, 1, 0),
    paper: slice(-3, 1, 0),
    testnet: slice(100, 1, 1),
    dryRun: slice(1000, 1, 1),
    unknownEnvironment: slice(7, 1, 0),
    bySource: [],
    bySymbol: [
      { symbol: "ADAUSDT", source: "AUTOMATED", environment: "TESTNET", summary: slice(100, 1, 0) },
      { symbol: "BTCUSDT", source: "AUTOMATED", environment: "REAL", summary: slice(10, 1, 0) },
    ],
    byPeriod: [
      { bucket: "2026-11-04", source: "AUTOMATED", environment: "DRY_RUN", summary: slice(1000, 1, 0) },
      { bucket: "2026-11-04", source: "AUTOMATED", environment: "REAL", summary: slice(10, 1, 0) },
      { bucket: "2026-11-04", source: "AUTOMATED", environment: "TESTNET", summary: slice(100, 1, 0) },
      { bucket: "2026-11-04", source: "AUTOMATED", environment: "UNKNOWN", summary: slice(7, 1, 0) },
    ],
    evidenceRowsScanned: 7, truncated: false,
  },
  limitations: ["fixture limitation"],
};

async function openJournal(): Promise<void> {
  admin();
  server.routes.set("GET /api/journal", () => RESPONSE);
  render(<AppRoute path="/journal"><JournalPage /></AppRoute>);
  await settle(6);
}

/** The summary card under a heading, as one block of text. */
function cardText(title: string): string {
  const heading = screen.getByRole("heading", { level: 2, name: title });
  const card = assertPresent(heading.parentElement?.parentElement ?? null, `${title} card`);
  return card.textContent ?? "";
}

test("every row carries its own environment badge", async () => {
  await openJournal();
  const expected: Array<[string, JournalEnvironment, string]> = [
    ["BTCUSDT · Persisted realized outcome", "REAL", "REAL"],
    ["ADAUSDT · Persisted realized outcome", "TESTNET", "TESTNET"],
    ["DOGEUSDT · Persisted realized outcome", "DRY_RUN", "DRY RUN"],
    ["BNBUSDT · Persisted realized outcome", "UNKNOWN", "UNKNOWN"],
    ["XRPUSDT · Persisted realized outcome", "PAPER", "PAPER"],
    ["ETHUSDT · Manual executed activity", "TESTNET", "TESTNET"],
    ["SOLUSDT · Manual executed activity", "DRY_RUN", "DRY RUN"],
  ];
  for (const [name, environment, label] of expected) {
    const article = screen.getByRole("article", { name });
    const badge = assertPresent(article.querySelector("[data-environment]"), `${name} badge`);
    assert.equal(badge.getAttribute("data-environment"), environment, name);
    assert.equal(badge.textContent, `Environment: ${label}`, name);
    assert.ok((badge.getAttribute("title") ?? "").length > 0, `${name} badge explains itself`);
    // The chart chip's colour for the same word.
    if (environment !== "PAPER") {
      assert.ok(badge.className.includes(EXECUTION_ENVIRONMENT_TONE[environment]), `${name} badge colour`);
    }
  }
});

test("Real money evidence shows REAL only; each other environment has its own card", async () => {
  await openJournal();
  const real = cardText("Real money evidence");
  assert.match(real, /\+\$10\.00/);
  for (const other of ["+$100.00", "+$1,000.00", "+$7.00", "+$1,114.00", "−$3.00"]) {
    assert.equal(real.includes(other), false, `the real card shows ${other}`);
  }
  assert.match(real, /Environment: REAL/);
  assert.match(cardText("Paper evidence"), /−\$3\.00/);
  assert.match(cardText("Testnet evidence"), /\+\$100\.00/);
  assert.match(cardText("Testnet evidence"), /Environment: TESTNET/);
  assert.match(cardText("Dry-run evidence"), /\+\$1,000\.00/);
  assert.match(cardText("Dry-run evidence"), /Environment: DRY RUN/);
  assert.match(cardText("Unknown environment"), /\+\$7\.00/);
  assert.match(cardText("Unknown environment"), /Environment: UNKNOWN/);
  assert.ok(screen.getByText(/never counted as real money/i));
});

test("an empty real slice never says 'no results' while unproven results exist", async () => {
  /*
   * Every Bot realization is UNKNOWN until the event carries its environment,
   * so a mainnet installation's real card is empty while "Unknown environment"
   * holds its results. "No realized results in this range" there reads as "the
   * Bot made no real money" — contract §7: could not read is not "you have
   * none". The card says what is true and points at the rows it excludes.
   */
  admin();
  server.routes.set("GET /api/journal", () => ({
    ...RESPONSE,
    rows: ROWS.filter((r) => r.environment !== "REAL"),
    summary: { ...RESPONSE.summary, real: slice(0, 0, 0) },
  }));
  render(<AppRoute path="/journal"><JournalPage /></AppRoute>);
  await settle(6);
  const real = cardText("Real money evidence");
  assert.equal(real.includes("No realized results in this range"), false,
    "unproven results exist; the real card must not say there are none");
  assert.match(real, /No result in this range is proven real money · 1 unknown-environment, 2 testnet and 2 dry-run rows below/);
});

test("a truly empty range still reads as nothing in range", async () => {
  admin();
  const none = slice(0, 0, 0);
  server.routes.set("GET /api/journal", () => ({
    ...RESPONSE, rows: [],
    summary: { ...RESPONSE.summary, ...none, real: none, paper: none, testnet: none, dryRun: none,
      unknownEnvironment: none, byPeriod: [], bySymbol: [], evidenceRowsScanned: 0 },
  }));
  render(<AppRoute path="/journal"><JournalPage /></AppRoute>);
  await settle(6);
  const real = cardText("Real money evidence");
  assert.match(real, /No realized results in this range/);
  assert.equal(real.includes("proven real money"), false);
  assert.equal(real.includes("Not counted here"), false);
});

test("a non-empty real card still names the unproven rows it does not count", async () => {
  await openJournal();
  assert.match(cardText("Real money evidence"),
    /Not counted here: 1 unknown-environment, 2 testnet and 2 dry-run rows below/);
});

test("grouped daily and per-symbol lines name the environment", async () => {
  await openJournal();
  for (const line of ["2026-11-04 · AUTOMATED · REAL", "2026-11-04 · AUTOMATED · TESTNET",
    "2026-11-04 · AUTOMATED · DRY RUN", "2026-11-04 · AUTOMATED · UNKNOWN",
    "ADAUSDT · AUTOMATED · TESTNET", "BTCUSDT · AUTOMATED · REAL"]) {
    assert.ok(screen.getByText(line), line);
  }
});
