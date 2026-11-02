/**
 * Bounded history requests (Pass 1 F1).
 *
 * Ordinary accounts reach `POST /api/data/backfill` and `/ensure` — a chart on
 * an untracked coin starts tracking it — so one request is clamped to the
 * newest `USER_MAX_HISTORY_BARS` SOURCE bars and one account may run only a
 * few at once. The admin is never clamped; their deep backfills stream through
 * `backfillRange` instead of holding the whole span in memory.
 *
 * Nothing here reaches Binance or PostgreSQL: every dependency is injected.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  SERVER_MAX_HISTORY_IN_FLIGHT, USER_HEAVY_HISTORY_BARS,
} from "../src/api/historyAdmission";
import {
  dataRoutes, USER_MAX_HISTORY_BARS, USER_MAX_HISTORY_IN_FLIGHT, type DataRouteDeps,
} from "../src/api/routes/data";
import type { BackfillRangeReport } from "../src/data/binanceRest";
import { UnknownInstrumentError } from "../src/data/instrumentRegistration";
import { config } from "../src/config";
import { ADMIN_USER_ID } from "../src/repositories/users";
import { INTERVAL_MS, type Candle, type Interval } from "../src/types/market";

const USER = "22222222-2222-4222-8222-222222222222";
const START = Date.UTC(2026, 0, 1);

interface Calls {
  fetchKlines: Array<{ symbol: string; interval: Interval; startMs: number; endMs: number }>;
  backfillRange: Array<{ symbol: string; interval: Interval; startMs: number; endMs: number }>;
  ensureCoverage: Array<{ symbol: string; interval: Interval; startMs: number; endMs: number }>;
  upserted: number[];
  registered: string[];
}

function candle(symbol: string, interval: Interval, openTime: number): Candle {
  return {
    symbol, interval, openTime, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
    closeTime: openTime + INTERVAL_MS[interval] - 1,
  };
}

function fakes(overrides: DataRouteDeps = {}): { deps: DataRouteDeps; calls: Calls } {
  const calls: Calls = { fetchKlines: [], backfillRange: [], ensureCoverage: [], upserted: [], registered: [] };
  const deps: DataRouteDeps = {
    fetchKlines: async (symbol, interval, startMs, endMs) => {
      calls.fetchKlines.push({ symbol, interval, startMs, endMs });
      return [candle(symbol, interval, startMs), candle(symbol, interval, startMs + INTERVAL_MS[interval])];
    },
    backfillRange: async (symbol, interval, startMs, endMs, opts) => {
      calls.backfillRange.push({ symbol, interval, startMs, endMs });
      await opts?.sink?.([candle(symbol, interval, startMs)]);
      const report: BackfillRangeReport = {
        symbol, interval, from: startMs, to: endMs, pages: 3, rows: 123_456,
        firstOpenTime: startMs, lastOpenTime: endMs, integrity: "degraded",
        issues: { missing_completed_interval: 7 },
      };
      return report;
    },
    ensureCoverage: async (symbol, interval, startMs, endMs) => {
      calls.ensureCoverage.push({ symbol, interval, startMs, endMs });
    },
    upsertCandles: async (rows) => { calls.upserted.push(rows.length); return rows.length; },
    countCandles: async () => 42,
    registerInstrument: async (symbol) => { calls.registered.push(symbol); },
    ...overrides,
  };
  return { deps, calls };
}

/** An authenticated instance whose request user is named by the `x-as` header. */
async function server(t: TestContext, deps: DataRouteDeps) {
  const previous = config.authEnabled;
  config.authEnabled = true;
  t.after(() => { config.authEnabled = previous; });
  const app = Fastify({ logger: false });
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = req.headers["x-as"] === "admin"
      ? { id: ADMIN_USER_ID, role: "admin", sessionVersion: 1 }
      : { id: String(req.headers["x-user"] ?? USER), role: "user", sessionVersion: 1 };
  });
  await app.register(dataRoutes, deps);
  t.after(() => app.close());
  return app;
}

/** A span of exactly `bars` bars of `interval` starting at START. */
const spanOf = (interval: Interval, bars: number) => ({ start: START, end: START + (bars - 1) * INTERVAL_MS[interval] });

const post = (url: string, as: "admin" | "user", payload: object) =>
  ({ method: "POST" as const, url, headers: { "x-as": as }, payload });

test("an ordinary account over the cap is clamped to the newest bars, and told so", async (t) => {
  const { deps, calls } = fakes();
  const app = await server(t, deps);
  const span = spanOf("1m", USER_MAX_HISTORY_BARS + 1);
  const res = await app.inject(post("/api/data/backfill", "user", { symbol: "BTCUSDT", interval: "1m", ...span }));
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.clamped, true);
  assert.equal(body.coveredFrom, span.end - (USER_MAX_HISTORY_BARS - 1) * INTERVAL_MS["1m"]);
  assert.match(body.note, /200,000 1m bars/, "names the limit and the stored interval");
  assert.match(body.note, /about 200,001 bars/, "says roughly how much was asked for");
  assert.match(body.note, /only the most recent were loaded/);
  assert.deepEqual(calls.fetchKlines, [{ symbol: "BTCUSDT", interval: "1m", startMs: body.coveredFrom, endMs: span.end }],
    "exactly the cap is fetched, ending where the request ended");
  assert.deepEqual(calls.backfillRange, [], "a user never streams");
  assert.deepEqual(calls.registered, ["BTCUSDT"]);
});

test("the chart's own depth presets load for an ordinary account on every resolution it offers", async (t) => {
  const { deps, calls } = fakes();
  const app = await server(t, deps);
  // `ChartToolbar` offers 2K/10K/50K/200K bars and `loadCandleWindow` backfills ×1.1.
  for (const [interval, depth] of [["30s", 10_000], ["23m", 10_000], ["5s", 50_000], ["1m", 200_000], ["1d", 200_000]] as const) {
    const step = interval === "30s" || interval === "5s" ? 1_000 : interval === "23m" ? 60_000 : INTERVAL_MS[interval];
    const factor = interval === "30s" ? 30 : interval === "5s" ? 5 : interval === "23m" ? 23 : 1;
    const end = START + 400 * 86_400_000 * 10;
    const res = await app.inject(post("/api/data/backfill", "user", {
      symbol: "BTCUSDT", interval, start: end - Math.ceil(depth * 1.1) * factor * step, end,
    }));
    assert.equal(res.statusCode, 200, `${interval} at depth ${depth}: ${res.body}`);
    const last = calls.fetchKlines.at(-1)!;
    assert.ok(Math.floor((last.endMs - last.startMs) / step) + 1 <= USER_MAX_HISTORY_BARS, `${interval}: fetched span is within the cap`);
  }
});

test("a request whose end is not a date is refused, not admitted with NaN", async (t) => {
  const { deps, calls } = fakes();
  const app = await server(t, deps);
  for (const end of ["not-a-date", 1e300]) {
    const res = await app.inject(post("/api/data/backfill", "user", { symbol: "BTCUSDT", interval: "1m", start: START, end }));
    assert.equal(res.statusCode, 400, String(end));
    const ensure = await app.inject(post("/api/data/ensure", "user", { symbol: "BTCUSDT", interval: "1m", start: START, end }));
    assert.equal(ensure.statusCode, 400, String(end));
  }
  assert.deepEqual(calls.fetchKlines, []);
  assert.deepEqual(calls.ensureCoverage, []);
});

test("a pair the venue does not list is a 404 from backfill, and nothing is fetched", async (t) => {
  const { deps, calls } = fakes({
    registerInstrument: async (symbol) => { throw new UnknownInstrumentError(symbol); },
  });
  const app = await server(t, deps);
  const res = await app.inject(post("/api/data/backfill", "user", { symbol: "FOOUSDT", interval: "1m", ...spanOf("1m", 100) }));
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, /FOOUSDT is not a Binance spot symbol/);
  assert.deepEqual(calls.fetchKlines, []);
  assert.deepEqual(calls.upserted, []);
});

test("an ordinary account at the cap takes today's fetch path with the exact span", async (t) => {
  const { deps, calls } = fakes();
  const app = await server(t, deps);
  const span = spanOf("1m", USER_MAX_HISTORY_BARS);
  const res = await app.inject(post("/api/data/backfill", "user", { symbol: "BTCUSDT", interval: "1m", ...span }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.fetchKlines, [{ symbol: "BTCUSDT", interval: "1m", startMs: span.start, endMs: span.end }]);
  assert.deepEqual(calls.upserted, [2]);
  assert.deepEqual(calls.registered, ["BTCUSDT"]);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ["fetched", "integrity", "interval", "source", "symbol"]);
  assert.equal(body.fetched, 2);
  assert.equal(body.streamed, undefined);
});

test("a derived resolution is counted in SOURCE bars", async (t) => {
  const { deps, calls } = fakes();
  const app = await server(t, deps);
  // 80,000 45m bars are 240,000 15m bars: over the cap though the chart bar count is not.
  const end = START + 80_000 * 45 * 60_000;
  const over = await app.inject(post("/api/data/backfill", "user", {
    symbol: "ETHUSDT", interval: "45m", start: START, end,
  }));
  assert.equal(over.statusCode, 200);
  assert.equal(over.json().clamped, true);
  assert.match(over.json().note, /45m is built from 15m bars/);
  assert.match(over.json().note, /200,000 15m bars/);
  assert.deepEqual(calls.fetchKlines, [{
    symbol: "ETHUSDT", interval: "15m", startMs: end - (USER_MAX_HISTORY_BARS - 1) * INTERVAL_MS["15m"], endMs: end,
  }], "the SOURCE interval is clamped and fetched");
  calls.fetchKlines.length = 0;

  // 16,000 45m bars are 48,000 15m bars: untouched, and the SOURCE is what is fetched.
  const span = { start: START, end: START + 16_000 * 45 * 60_000 - 15 * 60_000 };
  const ok = await app.inject(post("/api/data/backfill", "user", { symbol: "ETHUSDT", interval: "45m", ...span }));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().clamped, undefined);
  assert.deepEqual(calls.fetchKlines, [{ symbol: "ETHUSDT", interval: "15m", startMs: span.start, endMs: span.end }]);
  assert.equal(ok.json().interval, "45m");
  assert.equal(ok.json().source, "15m");
});

test("the admin over the cap streams through backfillRange, never fetchKlines", async (t) => {
  const { deps, calls } = fakes();
  const app = await server(t, deps);
  const span = spanOf("1m", USER_MAX_HISTORY_BARS * 4);
  const res = await app.inject(post("/api/data/backfill", "admin", { symbol: "BTCUSDT", interval: "1m", ...span }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.fetchKlines, []);
  assert.deepEqual(calls.backfillRange, [{ symbol: "BTCUSDT", interval: "1m", startMs: span.start, endMs: span.end }]);
  assert.deepEqual(calls.upserted, [1], "the injected upsert is the stream's sink");
  const body = res.json();
  assert.equal(body.streamed, true);
  assert.equal(body.fetched, 123_456, "fetched is rows written");
  assert.equal(body.source, "1m");
  assert.equal(body.integrity.state, "degraded");
  assert.deepEqual(body.integrity.issues, [{ code: "missing_completed_interval", count: 7, timestamps: [] }]);
});

test("the admin under the cap keeps the concurrent fetch path and its response shape", async (t) => {
  const { deps, calls } = fakes();
  const app = await server(t, deps);
  const span = spanOf("15m", 11_000);
  const res = await app.inject(post("/api/data/backfill", "admin", { symbol: "SOLUSDT", interval: "15m", ...span }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.backfillRange, []);
  assert.deepEqual(calls.fetchKlines, [{ symbol: "SOLUSDT", interval: "15m", startMs: span.start, endMs: span.end }]);
  assert.deepEqual(Object.keys(res.json()).sort(), ["fetched", "integrity", "interval", "source", "symbol"]);
});

test("ensure is clamped for an ordinary account and unchanged for the admin", async (t) => {
  const { deps, calls } = fakes();
  const app = await server(t, deps);
  const span = spanOf("1m", USER_MAX_HISTORY_BARS + 1);
  const clamped = await app.inject(post("/api/data/ensure", "user", { symbol: "BTCUSDT", interval: "1m", ...span }));
  assert.equal(clamped.statusCode, 200);
  assert.equal(clamped.json().clamped, true);
  assert.match(clamped.json().note, /at most 200,000 1m bars/);
  assert.deepEqual(calls.ensureCoverage, [{
    symbol: "BTCUSDT", interval: "1m", startMs: span.end - (USER_MAX_HISTORY_BARS - 1) * INTERVAL_MS["1m"], endMs: span.end,
  }]);
  calls.ensureCoverage.length = 0;

  const allowed = await app.inject(post("/api/data/ensure", "admin", { symbol: "BTCUSDT", interval: "1m", ...span }));
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.json(), { symbol: "BTCUSDT", interval: "1m", source: "1m", storedTotal: 42 });
  assert.deepEqual(calls.ensureCoverage, [{ symbol: "BTCUSDT", interval: "1m", startMs: span.start, endMs: span.end }]);

  const small = await app.inject(post("/api/data/ensure", "user", { symbol: "BTCUSDT", interval: "1m", ...spanOf("1m", 500) }));
  assert.equal(small.statusCode, 200);
  assert.equal(small.json().clamped, undefined);
});

test("one account may run only a few heavy requests at once, and finished ones free their slot", async (t) => {
  const gates: Array<() => void> = [];
  const { deps, calls } = fakes({
    fetchKlines: async (symbol, interval, startMs) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return [candle(symbol, interval, startMs)];
    },
  });
  const app = await server(t, deps);
  const payload = { symbol: "BTCUSDT", interval: "1m", ...spanOf("1m", USER_HEAVY_HISTORY_BARS + 1) };
  const running = Array.from({ length: USER_MAX_HISTORY_IN_FLIGHT },
    () => app.inject(post("/api/data/backfill", "user", payload)));
  while (gates.length < USER_MAX_HISTORY_IN_FLIGHT) await new Promise((r) => setImmediate(r));

  const refused = await app.inject(post("/api/data/backfill", "user", payload));
  assert.equal(refused.statusCode, 429);
  assert.ok(Number(refused.headers["retry-after"]) > 0, "says when to retry");
  assert.match(refused.json().error, /wait for one to finish/);
  const ensureToo = await app.inject(post("/api/data/ensure", "user", payload));
  assert.equal(ensureToo.statusCode, 429, "backfill and ensure share the account's slots");

  // The admin is not limited by the account's slots.
  const admin = app.inject(post("/api/data/backfill", "admin", payload));
  while (gates.length < USER_MAX_HISTORY_IN_FLIGHT + 1) await new Promise((r) => setImmediate(r));

  for (const open of gates.splice(0)) open();
  for (const res of await Promise.all([...running, admin])) assert.equal(res.statusCode, 200);

  const after = app.inject(post("/api/data/backfill", "user", payload));
  while (gates.length < 1) await new Promise((r) => setImmediate(r));
  gates.splice(0).forEach((open) => open());
  assert.equal((await after).statusCode, 200, "slots were released");
  assert.equal(calls.upserted.length, USER_MAX_HISTORY_IN_FLIGHT + 2);
});

test("a request that fails still frees its slot", async (t) => {
  const { deps } = fakes({ fetchKlines: async () => { throw new Error("upstream down"); } });
  const app = await server(t, deps);
  const payload = { symbol: "BTCUSDT", interval: "1m", ...spanOf("1m", USER_HEAVY_HISTORY_BARS + 1) };
  for (let i = 0; i < USER_MAX_HISTORY_IN_FLIGHT + 2; i += 1) {
    assert.equal((await app.inject(post("/api/data/backfill", "user", payload))).statusCode, 500,
      "every failure is the upstream's, never this account's slots running out");
  }
});

test("a request under the heavy threshold takes no slot, so a many-pane chart always loads", async (t) => {
  const gates: Array<() => void> = [];
  const { deps } = fakes({
    fetchKlines: async (symbol, interval, startMs) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return [candle(symbol, interval, startMs)];
    },
  });
  const app = await server(t, deps);
  // The chart's default depth for sixteen panes, its layout maximum.
  const payload = { symbol: "BTCUSDT", interval: "1m", ...spanOf("1m", 11_000) };
  const panes = Array.from({ length: 16 }, () => app.inject(post("/api/data/backfill", "user", payload)));
  while (gates.length < 16) await new Promise((r) => setImmediate(r));
  gates.splice(0).forEach((open) => open());
  for (const res of await Promise.all(panes)) assert.equal(res.statusCode, 200, res.body);
});

test("heavy requests are capped across all accounts, and the admin is neither capped nor counted", async (t) => {
  const gates: Array<() => void> = [];
  const { deps } = fakes({
    fetchKlines: async (symbol, interval, startMs) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return [candle(symbol, interval, startMs)];
    },
  });
  const app = await server(t, deps);
  const payload = { symbol: "BTCUSDT", interval: "1m", ...spanOf("1m", USER_HEAVY_HISTORY_BARS + 1) };
  const as = (user: string) => app.inject({
    method: "POST", url: "/api/data/backfill", headers: { "x-as": "user", "x-user": user }, payload,
  });
  // Each account under its own cap, until the server's is reached.
  const running = Array.from({ length: SERVER_MAX_HISTORY_IN_FLIGHT }, (_, i) => as(`account-${i}`));
  while (gates.length < SERVER_MAX_HISTORY_IN_FLIGHT) await new Promise((r) => setImmediate(r));

  const another = await as("account-new");
  assert.equal(another.statusCode, 429);
  assert.ok(Number(another.headers["retry-after"]) > 0);
  assert.match(another.json().error, /busy loading history for other accounts/);

  const admin = app.inject(post("/api/data/backfill", "admin", payload));
  while (gates.length < SERVER_MAX_HISTORY_IN_FLIGHT + 1) await new Promise((r) => setImmediate(r));
  gates.splice(0).forEach((open) => open());
  for (const res of await Promise.all([...running, admin])) assert.equal(res.statusCode, 200, res.body);

  const later = as("account-new");
  while (gates.length < 1) await new Promise((r) => setImmediate(r));
  gates.splice(0).forEach((open) => open());
  assert.equal((await later).statusCode, 200, "every slot came back");
});
