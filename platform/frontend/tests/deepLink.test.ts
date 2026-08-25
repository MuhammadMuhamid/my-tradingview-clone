/**
 * FE-06: the optimizer "apply to chart" link.
 *
 * Two properties are pinned here. First, that parsing is inert — a link cannot
 * cause a write by being opened, because the parser returns a description and
 * nothing else. Second, that an embedded payload is validated field by field
 * before it can become the capital, commission and position size of a backtest
 * and then be persisted into a saved layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodePayload, describeApply, parseApplyLink, validateOptimizerBest,
} from "../lib/deepLink";

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_");

const validBest = {
  symbol: "BTCUSDT",
  rank: 1,
  score: 1.2,
  foundAt: "2026-08-01T00:00:00.000Z",
  metrics: {},
  params: { maLen: 15 },
  tunedParams: { maLen: 15 },
  properties: {
    initialCapital: 10_000, commissionPct: 0.1, slippageTicks: 1,
    qtyCash: 800, qtyType: "cash", qtyValue: 800,
    rangeStart: "2023-01-01T00:00:00.000Z", rangeEnd: "2026-01-01T00:00:00.000Z",
  },
  timeframe: "15m",
  strategyKey: "ma_rr_v9",
};

// ── Parsing is inert ────────────────────────────────────────────────────────

test("a URL with no apply request parses to nothing", () => {
  assert.equal(parseApplyLink(""), null);
  assert.equal(parseApplyLink("?symbol=BTCUSDT&interval=1h"), null);
});

test("a well-formed link is DESCRIBED, not performed", () => {
  const req = parseApplyLink("?applyStrategy=ma_rr_v9&applySymbol=btcusdt&applyTf=5m&applyRank=3&layoutName=My%20layout");
  assert.ok(req);
  assert.deepEqual(req, {
    strategy: "ma_rr_v9", symbol: "BTCUSDT", timeframe: "5m", rank: 3,
    layoutName: "My layout", payload: null, payloadRejected: false,
  });
  // Everything the link will do is named, including the two that touch the
  // server, so the confirmation cannot understate it.
  const described = describeApply(req);
  assert.match(described, /MA\+R:R 5m BTCUSDT rank #3/);
  assert.match(described, /save it as the layout "My layout"/);
  assert.match(described, /run a backtest/);
});

test("a link with no layout name does not claim it will save one", () => {
  const req = parseApplyLink("?applyStrategy=mtf_lean&applySymbol=ETHUSDT")!;
  assert.equal(req.layoutName, "");
  assert.doesNotMatch(describeApply(req), /layout/);
  assert.match(describeApply(req), /run a backtest/);
});

test("an unknown strategy, a bad symbol or an absurd rank is refused outright", () => {
  for (const search of [
    "?applyStrategy=not_a_strategy&applySymbol=BTCUSDT",
    "?applyStrategy=ma_rr_v9&applySymbol=",
    "?applyStrategy=ma_rr_v9&applySymbol=BTC%2FUSDT",   // a slash injects websocket streams
    "?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&applyRank=0",
    "?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&applyRank=1.5",
    "?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&applyRank=-3",
    "?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&applyRank=99999",
    "?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&applyRank=abc",
  ]) {
    assert.equal(parseApplyLink(search), null, search);
  }
});

test("a layout name is bounded, because it is written to the server", () => {
  const req = parseApplyLink(`?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&layoutName=${"x".repeat(500)}`)!;
  assert.equal(req.layoutName.length, 80);
});

test("an unrecognised timeframe falls back to 15m rather than being passed through", () => {
  assert.equal(parseApplyLink("?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&applyTf=1w")!.timeframe, "15m");
  assert.equal(parseApplyLink("?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&applyTf=5m")!.timeframe, "5m");
});

// ── The embedded payload ────────────────────────────────────────────────────

test("a valid payload survives and is used instead of a server lookup", () => {
  const req = parseApplyLink(`?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&applyPayload=${b64url(validBest)}`)!;
  assert.equal(req.payloadRejected, false);
  assert.equal(req.payload?.properties.initialCapital, 10_000);
});

test("A MALFORMED PAYLOAD IS DROPPED AND THE REJECTION IS REPORTED", () => {
  // Not silently: the banner tells the user their link's embedded result was
  // ignored, so a truncated or tampered link does not look like it worked.
  const req = parseApplyLink("?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&applyPayload=not-base64!!")!;
  assert.equal(req.payload, null);
  assert.equal(req.payloadRejected, true);
});

test("a payload cannot dictate a nonsense capital, commission or position size", () => {
  const bad: [string, unknown][] = [
    ["negative capital", { ...validBest, properties: { ...validBest.properties, initialCapital: -1 } }],
    ["zero capital", { ...validBest, properties: { ...validBest.properties, initialCapital: 0 } }],
    ["infinite capital", { ...validBest, properties: { ...validBest.properties, initialCapital: Infinity } }],
    ["NaN capital", { ...validBest, properties: { ...validBest.properties, initialCapital: Number.NaN } }],
    ["string capital", { ...validBest, properties: { ...validBest.properties, initialCapital: "10000" } }],
    ["commission above 100%", { ...validBest, properties: { ...validBest.properties, commissionPct: 101 } }],
    ["negative commission", { ...validBest, properties: { ...validBest.properties, commissionPct: -1 } }],
    ["negative slippage", { ...validBest, properties: { ...validBest.properties, slippageTicks: -1 } }],
    ["negative size", { ...validBest, properties: { ...validBest.properties, qtyValue: -5 } }],
    ["unknown sizing mode", { ...validBest, properties: { ...validBest.properties, qtyType: "all_in" } }],
    ["unparseable range", { ...validBest, properties: { ...validBest.properties, rangeStart: "whenever" } }],
    ["missing properties", { ...validBest, properties: undefined }],
    ["unknown strategy", { ...validBest, strategyKey: "rm -rf" }],
    ["unknown timeframe", { ...validBest, timeframe: "1w" }],
    ["symbol with a slash", { ...validBest, symbol: "BTC/USDT" }],
    ["params missing", { ...validBest, params: undefined }],
    ["not an object", "just a string"],
    ["null", null],
  ];
  for (const [why, value] of bad) {
    assert.equal(validateOptimizerBest(value), null, `accepted: ${why}`);
    assert.equal(decodePayload(b64url(value)), null, `accepted through base64: ${why}`);
  }
});

test("the validator accepts the shape the server actually returns", () => {
  // A validator that rejects everything would pass every test above and break
  // the feature, so this is the other half of the check.
  assert.notEqual(validateOptimizerBest(validBest), null);
  assert.notEqual(
    validateOptimizerBest({ ...validBest, properties: { ...validBest.properties, qtyType: "percent_of_equity" } }),
    null
  );
});

// ── OPT-11: a percent-of-equity tree states no cash size ─────────────────────

test("a percent-of-equity result is accepted with qtyCash null", () => {
  const best = {
    ...validBest,
    properties: {
      ...validBest.properties,
      qtyCash: null, qtyType: "percent_of_equity", qtyValue: 100,
    },
  };
  assert.ok(validateOptimizerBest(best), "a tree that sizes by percent has no cash size to state");
});

test("a CASH result with no cash size is still refused", () => {
  const best = {
    ...validBest,
    properties: { ...validBest.properties, qtyCash: null, qtyType: "cash", qtyValue: 800 },
  };
  assert.equal(validateOptimizerBest(best), null);
});

test("a non-numeric qtyCash is refused whatever the sizing mode", () => {
  for (const qtyType of ["cash", "percent_of_equity"]) {
    const best = {
      ...validBest,
      properties: { ...validBest.properties, qtyCash: "800", qtyType, qtyValue: 800 },
    };
    assert.equal(validateOptimizerBest(best), null, qtyType);
  }
});
