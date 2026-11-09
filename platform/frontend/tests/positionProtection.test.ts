/**
 * F7 / RR1 / RR2: a manual position's protection, read strictly — never
 * imply that unprotected exposure is protected.
 *
 * The bot's TP/SL poller checks only `active` positions that carry a level,
 * only while it is polling at all (it stops while the bot is halted or manual
 * trading is off), and it skips mainnet-account positions while mainnet manual
 * trading is off. A late fill (`late_fill_unprotected`) is never watched.
 * "Protected" therefore needs every one of those to be KNOWN to hold; an older
 * bot that does not report `protection.polling` is unknown, never "polling".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  manualProtectionLines, positionProtection, protectionContextFor, UNKNOWN_PROTECTION_CONTEXT,
  type ProtectionContext,
} from "../components/tv/positionProtection";
import type { ManualPosition, ManualTradingState } from "../lib/api";

const TESTNET_POLLING: ProtectionContext = {
  polling: true, halted: false, manualEnabled: true, accountTestnet: true, mainnetPositionsChecked: false,
};
const p = (protectionState: string | null, manualTpPrice: number | null = null, manualSlPrice: number | null = null,
  context: ProtectionContext = TESTNET_POLLING) =>
  positionProtection({ protectionState, manualTpPrice, manualSlPrice }, context);

test("a late fill is a loud, danger-toned UNPROTECTED badge", () => {
  const late = p("late_fill_unprotected");
  assert.equal(late.kind, "late_fill_unprotected");
  assert.equal(late.label, "UNPROTECTED · late fill");
  assert.match(late.tone, /text-down/);
  assert.match(late.title, /NO take-profit and NO stop-loss/);
  // Even if levels were somehow present, the bot does not watch this position.
  assert.equal(p("late_fill_unprotected", 120, 90).kind, "late_fill_unprotected");
});

test("testnet + polling + an active level is protected — and nothing less is", () => {
  assert.equal(p("active", 120, null).kind, "protected");
  assert.equal(p("active", null, 90).kind, "protected");
  assert.doesNotMatch(p("active", 120, 90).title, /^The bot watches/, "no unconditional claim");
  // `active` without any level is contradictory: not protected.
  assert.equal(p("active").kind, "unknown");
});

test("halted → not protected, conspicuously", () => {
  for (const context of [{ ...TESTNET_POLLING, halted: true }, { ...TESTNET_POLLING, halted: true, polling: true }]) {
    const result = p("active", 120, 90, context);
    assert.equal(result.kind, "not_checked");
    assert.equal(result.label, "TP/SL NOT BEING CHECKED · Bot halted");
    assert.match(result.tone, /text-down/);
    assert.match(result.title, /not enforce|nothing enforces/i);
  }
  assert.equal(p("active", 120, 90, { ...TESTNET_POLLING, polling: false }).label,
    "TP/SL NOT BEING CHECKED · Bot not polling");
  assert.equal(p("active", 120, 90, { ...TESTNET_POLLING, manualEnabled: false, polling: false }).label,
    "TP/SL NOT BEING CHECKED · manual trading off");
});

test("polling absent (an older bot) → unknown, never protected", () => {
  const result = p("active", 120, 90, { ...TESTNET_POLLING, polling: undefined });
  assert.equal(result.kind, "not_checked");
  assert.equal(result.label, "TP/SL NOT BEING CHECKED · status unknown");
  // And with no context at all.
  assert.equal(positionProtection({ protectionState: "active", manualTpPrice: 120, manualSlPrice: 90 }).kind, "not_checked");
});

test("mainnet + mainnetPositionsChecked false → not protected; true → protected", () => {
  const mainnet = { ...TESTNET_POLLING, accountTestnet: false };
  assert.equal(p("active", 120, 90, { ...mainnet, mainnetPositionsChecked: false }).label,
    "TP/SL NOT BEING CHECKED · mainnet manual off");
  assert.equal(p("active", 120, 90, { ...mainnet, mainnetPositionsChecked: undefined }).label,
    "TP/SL NOT BEING CHECKED · status unknown");
  assert.equal(p("active", 120, 90, { ...mainnet, mainnetPositionsChecked: true }).kind, "protected");
  // An account the bot no longer lists proves nothing either.
  assert.equal(p("active", 120, 90, { ...TESTNET_POLLING, accountTestnet: undefined }).kind, "not_checked");
});

test("known unprotected states say so; unknown states are never protected", () => {
  for (const state of [null, "none", "removed"]) assert.equal(p(state).kind, "none", String(state));
  assert.equal(p("triggered", 120, 90).kind, "triggered");
  for (const state of ["pending_entry", "entry_working_after_exit", "ACTIVE", "", "something_new"]) {
    const result = p(state, 120, 90);
    assert.equal(result.kind, "unknown", state);
    assert.equal(result.label, "Protection unknown", state);
    assert.match(result.title, /Treat the position as unprotected/, state);
  }
  assert.equal(p("none", 120, null).kind, "unknown");
});

const position = (id: string, over: Partial<ManualPosition>): ManualPosition => ({
  id, exchangeAccountId: "acct-test", pair: "SOLUSDT", status: "active", entryPrice: 200, currentPrice: 201,
  quantity: 1, quoteSpent: 200, pnlUsdt: 1, pnlPct: 0.5, manualTpPrice: 250, manualSlPrice: 150,
  protectionType: "bot-managed", protectionState: "active", createdAt: "2026-11-09T10:00:00.000Z",
  closedAt: null, closedReason: null, ...over,
});
const state = (over: Partial<ManualTradingState> = {}, protection: Partial<ManualTradingState["protection"]> = {}): ManualTradingState => ({
  enabled: true, mainnetEnabled: false, dryRun: true, mixed: true, tradingHalted: false,
  accounts: [
    { id: "acct-test", name: "T", exchange: "binance", marketType: "spot", testnet: true, mode: "testnet" },
    { id: "acct-main", name: "M", exchange: "binance", marketType: "spot", testnet: false, mode: "mainnet" },
  ],
  orders: [],
  positions: [
    position("watched", {}),
    position("late", { protectionState: "late_fill_unprotected", manualTpPrice: 260, manualSlPrice: 140 }),
    // The F7 DOM fixture's "odd" position: an unrecognised state WITH levels.
    position("odd", { protectionState: "pending_entry", manualTpPrice: 270, manualSlPrice: 130 }),
    position("main", { exchangeAccountId: "acct-main" }),
    position("other", { pair: "BTCUSDT" }),
  ],
  protection: { type: "bot-managed", exchangeResting: false, note: "", polling: true,
    haltedBy: null, mainnetPositionsChecked: false, ...protection },
  ...over,
});

test("protectionContextFor reads the bot's report and the position's own account", () => {
  const s = state();
  assert.deepEqual(protectionContextFor(s, s.positions[0]!), TESTNET_POLLING);
  assert.equal(protectionContextFor(s, s.positions[3]!).accountTestnet, false);
  // An older bot sends neither field: unknown, not "polling" and not "not halted".
  const old = state({ tradingHalted: undefined }, { polling: undefined, mainnetPositionsChecked: undefined });
  delete (old as Partial<ManualTradingState>).tradingHalted;
  const context = protectionContextFor(old, old.positions[0]!);
  assert.equal(context.polling, undefined);
  assert.equal(context.halted, undefined);
  // This Platform's own halt read is enough on its own.
  assert.equal(protectionContextFor(s, s.positions[0]!, true).halted, true);
});

test("RR1: the chart draws BOT TP/SL lines only for a position the bot is checking", () => {
  // The page passes the trading symbol's active positions, as app/chart does.
  const titles = (s: ManualTradingState | null) => manualProtectionLines(s,
    s?.positions.filter((p) => p.pair === "SOLUSDT" && p.status === "active") ?? []).map((line) => line.title);
  // Only the testnet "watched" position: not the late fill, not the unknown
  // ("odd") state, not the unchecked mainnet one, not another symbol's.
  assert.deepEqual(titles(state()), ["MANUAL TP · BOT · watc", "MANUAL SL · BOT · watc"]);
  assert.deepEqual(titles(state({ tradingHalted: true }, { polling: false, haltedBy: "operator" })), []);
  assert.deepEqual(titles(state({}, { polling: undefined })), [], "an older bot draws nothing");
  assert.deepEqual(titles(state({}, { mainnetPositionsChecked: true })),
    ["MANUAL TP · BOT · watc", "MANUAL SL · BOT · watc", "MANUAL TP · BOT · main", "MANUAL SL · BOT · main"]);
  assert.deepEqual(titles(null), []);
});

test("the Trade panel, the chart strip and the chart all use it; the halt notice claims no watching", () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const panel = read("components/tv/ManualTradingPanel.tsx");
  const strip = read("components/tv/TradingStateStrip.tsx");
  const chart = read("app/chart/page.tsx");
  assert.match(panel, /positionProtection\(p, stateReadFailed\s*\? UNKNOWN_PROTECTION_CONTEXT : protectionContextFor\(state, p, halted !== null\)\)/);
  assert.match(panel, /setStateReadFailed\(true\);\s*setError\(describeAction\(e, "read the trading state"\)\)/);
  assert.match(panel, /<ProtectionBadge protection=\{protectionStatus\} \/>/);
  assert.doesNotMatch(panel, /p\.protectionType \?\? "no protection"/);
  assert.doesNotMatch(panel, /adjusting\s+protection are still available/);
  assert.match(panel, /NOT checking take-profit \/ stop-loss while halted/);
  assert.match(strip, /<ProtectionCell position=\{p\} state=\{stale \? null : state\} \/>/);
  assert.match(chart, /manualProtectionLines\(\s*manualUnavailable \? null : manualState,\s*manualState\?\.positions\.filter\(\(p\) => p\.pair === tradingSymbol && p\.status === "active"\)/);
  assert.doesNotMatch(chart, /MANUAL TP · BOT/, "the chart builds no BOT line of its own");
});

test("RR3: after a failed or stale read, protection is unknown and no BOT line is drawn", () => {
  // The retained state still lists the positions, but proves nothing about
  // whether the bot is checking them NOW. Each surface passes no state (or the
  // unknown context) after a failed read — pinned in the test above.
  const retained = state();
  const active = retained.positions.filter((x) => x.pair === "SOLUSDT" && x.status === "active");
  assert.deepEqual(manualProtectionLines(retained, active).length, 2, "setup: a checked position draws lines");
  assert.deepEqual(manualProtectionLines(null, active), [], "the chart after a failed read");
  const watched = retained.positions[0]!;
  for (const context of [UNKNOWN_PROTECTION_CONTEXT, protectionContextFor(null, watched)]) {
    const result = positionProtection(watched, context);
    assert.equal(result.kind, "not_checked");
    assert.equal(result.label, "TP/SL NOT BEING CHECKED · status unknown");
  }
});
