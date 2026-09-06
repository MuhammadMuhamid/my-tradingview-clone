/**
 * Comparing one instrument against another, and the anchored VWAP.
 *
 * ── What is actually hard here ─────────────────────────────────────────────
 *
 * Not the statistics — those are `ta/core`'s and are checked there. What is
 * hard is ALIGNMENT, and the failure mode is silent: two instruments have
 * different histories, and lining them up by position rather than by open time
 * compares Tuesday's BTC with Monday's SOL and returns a correlation that
 * looks exactly like a real one.
 *
 * The second hard thing is what to do with a bar the other instrument does not
 * have. Forward-filling produces a fabricated observation, and a correlation
 * computed partly from fabrications is meaningless in a way nothing about the
 * number reveals. It is `na`, and the count is reported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comparePercent, compareCorrelation, compareBeta, isSelfCompare,
  DEFAULT_BENCHMARK, type CompareSeries,
} from "../lib/compare";
import { alignByOpenTime, normalizedCompare } from "../lib/ta/core";
import { anchorBarIndex, anchoredVwapOverlays, avwapBands, AVWAP_TOOL } from "../lib/anchoredVwap";
import type { Candle } from "../lib/types";
import type { Drawing } from "../lib/drawings";

const MINUTE = 60_000;
const bar = (i: number, close: number, volume = 100): Candle => ({
  symbol: "BTCUSDT", interval: "1m",
  openTime: i * MINUTE, closeTime: i * MINUTE + MINUTE - 1,
  open: close, high: close + 1, low: close - 1, close, volume,
});
const bars = (n: number, f: (i: number) => number = (i) => 100 + i): Candle[] =>
  Array.from({ length: n }, (_, i) => bar(i, f(i)));

const compareSeries = (closes: number[], over: Partial<CompareSeries> = {}): CompareSeries => ({
  symbol: "SOLUSDT", closes, missing: closes.filter(Number.isNaN).length,
  loading: false, error: null, ...over,
});

// ── alignment ──────────────────────────────────────────────────────────────

test("bars are matched by open time, so a gap does not shift the whole series", () => {
  const baseTimes = [0, 1, 2, 3, 4].map((i) => i * MINUTE);
  // The other instrument did not trade minute 2 — an outage, or a thin pair.
  const otherTimes = [0, 1, 3, 4].map((i) => i * MINUTE);
  const otherValues = [10, 11, 13, 14];
  const aligned = alignByOpenTime(baseTimes, otherTimes, otherValues);

  assert.equal(aligned.length, 5, "the result is the BASE's length");
  assert.deepEqual(aligned.slice(0, 2), [10, 11]);
  assert.ok(Number.isNaN(aligned[2]!), "the missing bar is na, not the next bar's price");
  // The one that matters: 13 belongs to minute 3, and an index-based alignment
  // would have put it at minute 2 and shifted everything after it.
  assert.equal(aligned[3], 13);
  assert.equal(aligned[4], 14);
});

test("a bar the other instrument does not have is never filled in", () => {
  const aligned = alignByOpenTime([0, MINUTE], [0], [10]);
  assert.equal(aligned[0], 10);
  assert.ok(Number.isNaN(aligned[1]!),
    "a forward-filled price is a fabricated observation");
});

test("a second series with no overlap at all produces nothing rather than nonsense", () => {
  const aligned = alignByOpenTime([0, MINUTE], [50 * MINUTE], [10]);
  assert.ok(aligned.every(Number.isNaN));
  const result = comparePercent(bars(2), compareSeries(aligned));
  assert.match(String(result.notice), /no bar in common/);
});

// ── the normalized overlay ─────────────────────────────────────────────────

test("both series are rebased at the first bar where BOTH have a price", () => {
  // The other instrument starts later — a newer listing. Rebasing each at its
  // own first value would start them at different moments and turn "which
  // outperformed" into an artefact of when each began.
  const base = [100, 110, 120, 130];
  const other = [NaN, NaN, 50, 60];
  const { base: b, other: o, referenceIndex } = normalizedCompare(base, other);
  assert.equal(referenceIndex, 2);
  assert.ok(Number.isNaN(b[0]!) && Number.isNaN(b[1]!), "before the common bar there is nothing");
  assert.equal(b[2], 0, "both start at 0 % on the same bar");
  assert.equal(o[2], 0);
  // 130/120 is +8.33 %, 60/50 is +20 %: the second outperformed from the
  // moment they could first be compared.
  assert.ok(Math.abs(b[3]! - 8.3333) < 0.001);
  assert.ok(Math.abs(o[3]! - 20) < 1e-9);
});

test("the percentage overlay reports how many bars were left out", () => {
  const result = comparePercent(bars(5), compareSeries([10, 11, NaN, 13, 14]));
  assert.match(String(result.notice), /1 of these/);
  assert.match(String(result.notice), /invented/);
  const clean = comparePercent(bars(5), compareSeries([10, 11, 12, 13, 14]));
  assert.equal(clean.notice, null, "a complete series has nothing to disclose");
});

// ── correlation and beta ───────────────────────────────────────────────────

test("correlation and beta are computed from RETURNS, not from prices", () => {
  // Two series that both rise steadily but move differently bar to bar. On
  // PRICES they would correlate at nearly 1 — a fact about drift, not about
  // the instruments — and the number would sit near 1 permanently.
  const base = bars(200, (i) => 100 + i + Math.sin(i) * 8);
  const other = compareSeries(
    Array.from({ length: 200 }, (_, i) => 50 + i * 0.5 - Math.sin(i) * 6));
  const { plots } = compareCorrelation(base, other, 30);
  const last = plots.correlation![199]!;
  assert.ok(Number.isFinite(last));
  assert.ok(last < 0, `returns that move oppositely must correlate negatively, got ${last}`);
  assert.ok(last >= -1 && last <= 1);
});

test("an instrument compared with itself correlates at 1 and has beta 1", () => {
  const base = bars(200, (i) => 100 + Math.sin(i / 5) * 10);
  const same = compareSeries(base.map((c) => c.close));
  const corr = compareCorrelation(base, same, 30).plots.correlation![199]!;
  const b = compareBeta(base, same, 30).plots.beta![199]!;
  assert.ok(Math.abs(corr - 1) < 1e-9, `got ${corr}`);
  assert.ok(Math.abs(b - 1) < 1e-9, `got ${b}`);
  // And it is legal rather than refused: seeing that it IS 1 is useful.
  assert.equal(isSelfCompare("BTCUSDT", "binance:btcusdt"), true);
  assert.equal(isSelfCompare("BTCUSDT", "SOLUSDT"), false);
});

test("a benchmark that does not move gives no beta rather than a division by zero", () => {
  const base = bars(200, (i) => 100 + Math.sin(i / 5) * 10);
  const flat = compareSeries(new Array(200).fill(100));
  const b = compareBeta(base, flat, 30).plots.beta!;
  for (const v of b.slice(40)) {
    assert.ok(Number.isNaN(v) || Number.isFinite(v), `beta emitted ${v}`);
    assert.ok(!Number.isFinite(v) || Math.abs(v) < 1e9);
  }
});

test("the default benchmark is an instrument, not a suffix rule", () => {
  // A rule that turned "SOLUSDT" into "BTCUSDT" by string surgery would
  // silently produce a symbol that does not trade the day a second quote asset
  // or a second venue exists. A named instrument fails clearly instead.
  assert.equal(DEFAULT_BENCHMARK, "BTCUSDT");
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "lib", "compare.ts"), "utf8") as string;
  assert.doesNotMatch(source, /replace\(\s*\/USDT/,
    "a benchmark derived by string surgery is not an instrument");
});

// ── anchored VWAP ──────────────────────────────────────────────────────────

const avwap = (id: string, timeSeconds: number, bands = 0): Drawing => ({
  id, tool: AVWAP_TOOL,
  points: [{ time: timeSeconds, price: 0 }],
  style: { color: "#fff", width: 2, ...(bands ? { bands } : {}) } as Drawing["style"],
});

test("an anchor resolves to the last bar at or before it", () => {
  const series = bars(10);
  // Exactly on a bar.
  assert.equal(anchorBarIndex(series, (3 * MINUTE) / 1000), 3);
  // Between two bars: the one that had already opened, never the next one.
  assert.equal(anchorBarIndex(series, (3 * MINUTE + 30_000) / 1000), 3);
  // Before the loaded window: the first bar the chart has, which is the honest
  // answer — the series starts where the data does.
  assert.equal(anchorBarIndex(series, -5), 0);
  // After the last bar.
  assert.equal(anchorBarIndex(series, (99 * MINUTE) / 1000), 9);
  assert.equal(anchorBarIndex([], 0), -1);
});

test("the accumulation starts at the anchor and is na before it", () => {
  const series = bars(20, (i) => 100 + i);
  const [line] = anchoredVwapOverlays([avwap("a", (10 * MINUTE) / 1000)], series, 2);
  assert.ok(line);
  const values = line!.data.map((p) => p.value);
  for (let i = 0; i < 10; i++) {
    assert.equal(values[i], null, `bar ${i} is before the anchor and must be blank`);
  }
  assert.ok(values[10] !== null, "the anchor bar itself has a value");
  // On the anchor bar the VWAP is just that bar's typical price.
  const b = series[10]!;
  assert.ok(Math.abs((values[10] as number) - (b.high + b.low + b.close) / 3) < 1e-9);
});

test("an anchored VWAP cannot see a bar it was not given, which is what makes Replay honest", () => {
  const full = bars(30, (i) => 100 + i);
  const clipped = full.slice(0, 20);
  const drawing = avwap("a", (5 * MINUTE) / 1000);
  const [onFull] = anchoredVwapOverlays([drawing], full, 2);
  const [onClipped] = anchoredVwapOverlays([drawing], clipped, 2);
  // The value at bar 19 is the same either way: the accumulation runs over the
  // bars it is handed, so a replay horizon gives the value that WAS true then.
  assert.equal(onFull!.data[19]!.value, onClipped!.data[19]!.value);
  assert.equal(onClipped!.data.length, 20);
});

test("two anchored VWAPs never collide, and bands belong to their own line", () => {
  const series = bars(30);
  const overlays = anchoredVwapOverlays(
    [avwap("a", (5 * MINUTE) / 1000), avwap("b", (10 * MINUTE) / 1000, 2)], series, 2);
  const ids = overlays.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length, "two anchors share a series id");
  // One line for "a"; one line plus four band lines for "b".
  assert.equal(ids.filter((id) => id.startsWith("avwap:a")).length, 1);
  assert.equal(ids.filter((id) => id.startsWith("avwap:b")).length, 5);
  assert.equal(avwapBands(avwap("c", 0, 2)), 2);
  assert.equal(avwapBands(avwap("c", 0)), 0);
});

test("the bands are volume-weighted, so they agree with the line they surround", () => {
  // A series whose volume is concentrated on a few bars. An unweighted stdev
  // of price would produce bands that ignore the weighting the centre line is
  // built from, and disagree with it most exactly where volume was heaviest.
  const series = Array.from({ length: 40 }, (_, i) =>
    bar(i, 100 + Math.sin(i / 3) * 10, i % 10 === 0 ? 10_000 : 10));
  const overlays = anchoredVwapOverlays([avwap("a", 0, 1)], series, 2);
  const centre = overlays.find((o) => o.id === "avwap:a")!;
  const upper = overlays.find((o) => o.id === "avwap:a:u1")!;
  const lower = overlays.find((o) => o.id === "avwap:a:l1")!;
  const i = 39;
  const c = centre.data[i]!.value as number;
  const u = upper.data[i]!.value as number;
  const l = lower.data[i]!.value as number;
  assert.ok(Number.isFinite(c) && Number.isFinite(u) && Number.isFinite(l));
  assert.ok(u > c && c > l, "the bands must straddle the line");
  // Symmetric about the centre by construction.
  assert.ok(Math.abs((u - c) - (c - l)) < 1e-9);
});

// ── where a comparison lives ───────────────────────────────────────────────

import {
  setPaneCompare, parseWorkspace, createWorkspace, DEFAULT_COMPARE_LENGTH,
} from "../lib/workspace";

const workspace = () => createWorkspace({ symbol: "BTCUSDT", interval: "1h" });

test("a comparison belongs to one pane and is never synced to the others", () => {
  // "Compare SOL to BTC" is a statement about THIS chart. Pushing it across a
  // synced layout would put the same second instrument on four charts a user
  // was using to look at four different things.
  const ws = setPaneCompare(workspace(), "p1", {
    symbol: "solusdt", mode: "correlation", length: 90,
  });
  const pane = ws.panes.find((p) => p.id === "p1")!;
  assert.deepEqual(pane.compare, { symbol: "SOLUSDT", mode: "correlation", length: 90 });
  for (const other of ws.panes.filter((p) => p.id !== "p1")) {
    assert.equal(other.compare, undefined, "no other pane may acquire a comparison");
  }
});

test("removing a comparison removes the field, rather than storing 'there isn't one'", () => {
  const withOne = setPaneCompare(workspace(), "p1", {
    symbol: "SOLUSDT", mode: "percent", length: 60,
  });
  const cleared = setPaneCompare(withOne, "p1", null);
  assert.equal("compare" in cleared.panes.find((p) => p.id === "p1")!, false);
});

test("the window is bounded on the way in, not trusted from a stored record", () => {
  const ws = setPaneCompare(workspace(), "p1", {
    symbol: "SOLUSDT", mode: "beta", length: 99_999,
  });
  assert.equal(ws.panes[0]!.compare!.length, 1000);
  const tiny = setPaneCompare(workspace(), "p1", {
    symbol: "SOLUSDT", mode: "beta", length: 0,
  });
  assert.equal(tiny.panes[0]!.compare!.length, 2);
});

test("a corrupt comparison costs the comparison, never the workspace", () => {
  // Deliberately different from every other pane field, which are
  // all-or-nothing: those describe WHAT chart this is, and a pane with a
  // corrupt symbol is not recoverable. A comparison is a decoration on a chart
  // that is otherwise fine.
  const ws = setPaneCompare(workspace(), "p1", {
    symbol: "SOLUSDT", mode: "percent", length: 60,
  });
  const record = JSON.parse(JSON.stringify(ws)) as Record<string, unknown>;
  const panes = record.panes as Record<string, unknown>[];
  panes[0]!.compare = { symbol: "SOLUSDT", mode: "nonsense", length: 60 };
  const restored = parseWorkspace(record);
  assert.ok(restored, "the workspace must still load");
  assert.equal(restored!.panes[0]!.compare, undefined, "and the bad comparison is dropped");
  assert.equal(restored!.panes[0]!.symbol, "BTCUSDT", "while the chart itself survives");

  // A comparison with no length at all takes the default rather than failing.
  panes[0]!.compare = { symbol: "SOLUSDT", mode: "beta" };
  const defaulted = parseWorkspace(record);
  assert.equal(defaulted!.panes[0]!.compare!.length, DEFAULT_COMPARE_LENGTH);
});

test("a comparison survives a round trip through storage", () => {
  const ws = setPaneCompare(workspace(), "p1", {
    symbol: "ETHUSDT", mode: "beta", length: 120,
  });
  const restored = parseWorkspace(JSON.parse(JSON.stringify(ws)));
  assert.deepEqual(restored!.panes[0]!.compare,
    { symbol: "ETHUSDT", mode: "beta", length: 120 });
});
