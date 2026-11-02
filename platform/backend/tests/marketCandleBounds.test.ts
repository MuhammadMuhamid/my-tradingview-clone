/**
 * Bounded market candle reads.
 *
 * Ordinary accounts reach `GET /api/market/v1/candles/:canonicalId`. `limit`
 * only slices the response after the provider fetch, and most adapters declare
 * no `maximumBars`, so `from=0&limit=10` used to make the server page years of
 * 1m bars into memory. The SOURCE span is now clamped to the same
 * `USER_MAX_HISTORY_BARS` as backfill/ensure, and reads too wide for the candle
 * cache hold one of the account's few in-flight slots. The admin is exempt.
 *
 * Nothing here reaches a network: the provider is a fixture adapter whose
 * fetch records the exact [startMs, endMs] it was asked for.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { marketCatalogRoutesFor } from "../src/api/routes/marketCatalog";
import { USER_MAX_HISTORY_BARS, USER_MAX_HISTORY_IN_FLIGHT } from "../src/api/routes/data";
import { createOfficialSpotAdapter, OFFICIAL_SPOT_DEFINITIONS,
  type OfficialSpotDefinition, type OfficialSpotDependencies } from "../src/market/officialSpotAdapters";
import { ProviderRegistry } from "../src/market/registry";
import { createAlpacaUsEquityAdapter } from "../src/market/alpacaEquitiesAdapter";
import { config } from "../src/config";
import { ADMIN_USER_ID } from "../src/repositories/users";
import { INTERVAL_MS, type Candle, type Interval } from "../src/types/market";

const USER = "33333333-3333-4333-8333-333333333333";
const T = Date.UTC(2026, 8, 9, 12, 0, 0);
const MIN = INTERVAL_MS["1m"];
const coinbase = OFFICIAL_SPOT_DEFINITIONS.find((item) => item.id === "coinbase-spot")!;
const listing = { symbol: "BTC-USD", base: "BTC", quote: "USD", active: true, priceTick: 0.01, quantityLot: 0.00000001 };
const idFor = (venue: string) => `instrument:v1:${venue}:spot:BTC:USD:USD:spot`;
const COINBASE = idFor("COINBASE");

type Fetch = { interval: Interval; startMs: number; endMs: number };

function bar(interval: Interval, openTime: number): Candle {
  return { symbol: listing.symbol, interval, openTime, closeTime: openTime + INTERVAL_MS[interval] - 1,
    open: 100, high: 102, low: 99, close: 101, volume: 5 };
}

/** Records every provider fetch and answers with the last three bars of it, however wide. */
function recordingDeps(fetches: Fetch[], wait?: (fetch: Fetch) => Promise<void>): OfficialSpotDependencies {
  return {
    list: async () => [listing],
    candles: async (_symbol, interval, startMs, endMs) => {
      const fetch = { interval, startMs, endMs };
      fetches.push(fetch);
      await wait?.(fetch);
      const step = INTERVAL_MS[interval];
      const last = Math.floor(endMs / step) * step;
      return [2, 1, 0].map((k) => bar(interval, last - k * step)).filter((row) => row.openTime >= startMs);
    },
    tickers: async () => [],
  };
}

/** An authenticated instance whose request user is named by the `x-as` header. */
async function server(t: TestContext, definitions: OfficialSpotDefinition[], deps: OfficialSpotDependencies) {
  const registry = new ProviderRegistry();
  for (const definition of definitions) registry.register(createOfficialSpotAdapter(definition, deps));
  return serverFor(t, registry);
}

async function serverFor(t: TestContext, registry: ProviderRegistry) {
  const previous = config.authEnabled;
  config.authEnabled = true;
  t.after(() => { config.authEnabled = previous; });
  const app = Fastify({ logger: false });
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = req.headers["x-as"] === "admin"
      ? { id: ADMIN_USER_ID, role: "admin", sessionVersion: 1 }
      : { id: USER, role: "user", sessionVersion: 1 };
  });
  await app.register(marketCatalogRoutesFor(registry, { now: () => T }));
  t.after(() => app.close());
  return app;
}

const get = (as: "admin" | "user", query: string, id = COINBASE) =>
  ({ method: "GET" as const, url: `/api/market/v1/candles/${encodeURIComponent(id)}?${query}&format=compact`,
    headers: { "x-as": as } });

/** Source bars whose open time falls in [startMs, endMs] — `sourceBarsIn` in `routes/data.ts`. */
const barsIn = (interval: Interval, fetch: Fetch) => Math.floor((fetch.endMs - fetch.startMs) / INTERVAL_MS[interval]) + 1;

test("an ordinary account asking from the epoch gets exactly the newest 200,000 source bars, marked truncated", async (t) => {
  const fetches: Fetch[] = [];
  const app = await server(t, [coinbase], recordingDeps(fetches));
  const res = await app.inject(get("user", `interval=1m&from=0&to=${T}&limit=10`));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(fetches, [{ interval: "1m", startMs: T - (USER_MAX_HISTORY_BARS - 1) * MIN, endMs: T }],
    "the provider is asked for the bound, not 56 years of 1m bars");
  assert.equal(barsIn("1m", fetches[0]!), USER_MAX_HISTORY_BARS);
  const body = res.json();
  assert.equal(body.completeness.truncated, true);
  assert.match(body.completeness.note, /at most 200,000 1m bars/);
  assert.match(body.completeness.note, /only the most recent were returned/);
  assert.ok(body.count <= 10, "limit still slices the response");
});

test("a derived resolution with no `from` is bounded in SOURCE bars, however large its factor", async (t) => {
  const fetches: Fetch[] = [];
  const app = await server(t, [coinbase], recordingDeps(fetches));
  // 1439m folds from 1m: 200,000 bars of it would be 287,800,000 one-minute bars.
  const prime = await app.inject(get("user", `interval=1439m&to=${T}&limit=200000`));
  assert.equal(prime.statusCode, 200, prime.body);
  assert.deepEqual(fetches, [{ interval: "1m", startMs: T - (USER_MAX_HISTORY_BARS - 1) * MIN, endMs: T }]);
  assert.equal(prime.json().completeness.truncated, true);
  assert.match(prime.json().completeness.note, /1439m is built from 1m bars/);
  fetches.length = 0;

  // 80,000 45m bars span 79,999 * 3 + 1 = 239,998 15m bars: over the bound though the chart bar count is not.
  const derived = await app.inject(get("user", `interval=45m&to=${T}&limit=80000`));
  assert.equal(derived.statusCode, 200, derived.body);
  assert.deepEqual(fetches, [{ interval: "15m", startMs: T - (USER_MAX_HISTORY_BARS - 1) * INTERVAL_MS["15m"], endMs: T }]);
  assert.equal(barsIn("15m", fetches[0]!), USER_MAX_HISTORY_BARS);
  assert.equal(derived.json().completeness.truncated, true);
  assert.match(derived.json().completeness.note, /about 239,998 15m bars/);
});

test("the admin's oversized request is not clamped by the account bound", async (t) => {
  const fetches: Fetch[] = [];
  const app = await server(t, [coinbase], recordingDeps(fetches));
  const res = await app.inject(get("admin", `interval=1m&from=0&to=${T}&limit=10`));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(fetches, [{ interval: "1m", startMs: 0, endMs: T }]);
  assert.equal(res.json().completeness.truncated, false);
  assert.equal(res.json().completeness.note, undefined);
});

test("ordinary chart loads are untouched: the requested window is fetched and nothing is truncated", async (t) => {
  // `api.candles()` sends interval&limit with no from/to; the default depth is 10,000 (backfilled x1.1).
  for (const [interval, limit, source] of [["1m", 1_000, "1m"], ["15m", 11_000, "15m"], ["45m", 11_000, "15m"]] as const) {
    // A fresh registry each, so a cache entry from the last case cannot answer part of this one.
    const fetches: Fetch[] = [];
    const app = await server(t, [coinbase], recordingDeps(fetches));
    const res = await app.inject(get("user", `interval=${interval}&to=${T}&limit=${limit}`));
    assert.equal(res.statusCode, 200, `${interval}: ${res.body}`);
    const step = INTERVAL_MS[interval === "45m" ? "15m" : interval] * (interval === "45m" ? 3 : 1);
    assert.deepEqual(fetches, [{ interval: source, startMs: T - (limit - 1) * step, endMs: T }], interval);
    assert.equal(res.json().completeness.truncated, false, interval);
    assert.equal(res.json().completeness.note, undefined, interval);
  }
  const fetches: Fetch[] = [];
  const app = await server(t, [coinbase], recordingDeps(fetches));
  // Without `to` the window ends now and is still exactly `limit` bars wide.
  const live = await app.inject(get("user", "interval=1h&limit=1000"));
  assert.equal(live.statusCode, 200, live.body);
  assert.equal(fetches[0]!.endMs - fetches[0]!.startMs, 999 * INTERVAL_MS["1h"]);
  // An explicit 200,000-bar native range (`candlesRange`) is exactly at the bound.
  fetches.length = 0;
  const range = await app.inject(get("user", `interval=1m&from=${T - (USER_MAX_HISTORY_BARS - 1) * MIN}&to=${T}&limit=200000&purpose=backtest`));
  assert.equal(range.statusCode, 200, range.body);
  assert.deepEqual(fetches, [{ interval: "1m", startMs: T - (USER_MAX_HISTORY_BARS - 1) * MIN, endMs: T }]);
  assert.equal(range.json().completeness.truncated, false);
});

test("a provider's own maximumBars still applies, and the tighter bound wins", async (t) => {
  const fetches: Fetch[] = [];
  const deep: OfficialSpotDefinition = { ...coinbase, id: "fixture-deep", venueId: "DEEP",
    pagination: { maxPageSize: 300, direction: "forward", maximumBars: 300_000, limitation: "fixture keeps 300,000 bars" } };
  const shallow: OfficialSpotDefinition = { ...coinbase, id: "fixture-shallow", venueId: "SHALLOW",
    pagination: { maxPageSize: 300, direction: "forward", maximumBars: 5_000, limitation: "fixture keeps 5,000 bars" } };
  const app = await server(t, [deep, shallow], recordingDeps(fetches));
  const query = `interval=1m&from=0&to=${T}&limit=10`;

  const user = await app.inject(get("user", query, idFor("DEEP")));
  assert.equal(user.statusCode, 200, user.body);
  assert.deepEqual(fetches, [{ interval: "1m", startMs: T - (USER_MAX_HISTORY_BARS - 1) * MIN, endMs: T }],
    "the account bound is tighter than the provider's 300,000");
  assert.equal(user.json().completeness.truncated, true);
  assert.equal(user.json().completeness.limitation, "fixture keeps 300,000 bars");
  assert.match(user.json().completeness.note, /200,000 1m bars/);
  fetches.length = 0;

  const admin = await app.inject(get("admin", query, idFor("DEEP")));
  assert.deepEqual(fetches, [{ interval: "1m", startMs: T - (300_000 - 1) * MIN, endMs: T }],
    "the admin is still held to the provider's own limit");
  assert.equal(admin.json().completeness.truncated, true);
  assert.equal(admin.json().completeness.note, undefined);
  fetches.length = 0;

  const tight = await app.inject(get("user", query, idFor("SHALLOW")));
  assert.deepEqual(fetches, [{ interval: "1m", startMs: T - (5_000 - 1) * MIN, endMs: T }],
    "the provider's 5,000 is tighter than the account bound");
  assert.equal(tight.json().completeness.truncated, true);
  assert.equal(tight.json().completeness.note, undefined, "the account bound did not bind");
});

test("one account may run only a few cache-bypassing reads at once; chart-sized reads are never gated", async (t) => {
  const fetches: Fetch[] = [];
  const gates: Array<() => void> = [];
  const wide = (fetch: Fetch) => barsIn(fetch.interval, fetch) > 50_000;
  const app = await server(t, [coinbase], recordingDeps(fetches, (fetch) =>
    wide(fetch) ? new Promise<void>((resolve) => gates.push(resolve)) : Promise.resolve()));
  // Distinct intervals, so the cache's per-series lock does not serialise them.
  const running = (["1m", "5m", "15m", "1h"] as const).slice(0, USER_MAX_HISTORY_IN_FLIGHT)
    .map((interval) => app.inject(get("user", `interval=${interval}&from=0&to=${T}&limit=10`)));
  while (gates.length < USER_MAX_HISTORY_IN_FLIGHT) await new Promise((r) => setImmediate(r));

  const fifth = await app.inject(get("user", `interval=6h&from=0&to=${T}&limit=10`));
  assert.equal(fifth.statusCode, 429);
  assert.ok(Number(fifth.headers["retry-after"]) > 0, "says when to retry");
  assert.match(fifth.json().error, /wait for one to finish/);

  // A chart load (cache-sized) is not gated while every slot is held.
  const chart = await app.inject(get("user", `interval=1d&to=${T}&limit=1000`));
  assert.equal(chart.statusCode, 200, chart.body);

  // The admin is not limited by the account's slots.
  const admin = app.inject(get("admin", `interval=6h&from=0&to=${T}&limit=10`));
  while (gates.length < USER_MAX_HISTORY_IN_FLIGHT + 1) await new Promise((r) => setImmediate(r));

  for (const open of gates.splice(0)) open();
  for (const res of await Promise.all([...running, admin])) assert.equal(res.statusCode, 200, res.body);

  const after = app.inject(get("user", `interval=6h&from=0&to=${T}&limit=10`));
  while (gates.length < 1) await new Promise((r) => setImmediate(r));
  gates.splice(0).forEach((open) => open());
  assert.equal((await after).statusCode, 200, "slots were released");
});

test("a wide read that fails still frees its slot", async (t) => {
  const deps = recordingDeps([]);
  const app = await server(t, [coinbase], { ...deps, candles: async () => { throw new Error("upstream down"); } });
  for (let i = 0; i < USER_MAX_HISTORY_IN_FLIGHT + 2; i += 1) {
    const res = await app.inject(get("user", `interval=1m&from=0&to=${T}&limit=10`));
    assert.equal(res.statusCode, 502, "every failure is the upstream's, never this account's slots running out");
  }
});

test("a from/to outside the Date range is refused before any slot or provider fetch", async (t) => {
  // At 1e24 a float's ulp is ~1.3e8, so a provider page loop's `from += 60_000`
  // never advances; the account bar bound alone would not stop that.
  const fetches: Fetch[] = [];
  const app = await server(t, [coinbase], recordingDeps(fetches));
  for (const [as, query] of [["user", "to=1e24"], ["admin", "to=1e24"], ["admin", `from=-1e24&to=${T}`],
    ["user", `from=-1e24&to=${T}`]] as const) {
    const res = await app.inject(get(as, `interval=1m&${query}&limit=1000`));
    assert.equal(res.statusCode, 400, `${as} ${query}`);
    assert.match(res.json().error, /valid ascending epoch-millisecond range/);
  }
  assert.deepEqual(fetches, [], "the provider is never called");
});

test("the equity path is bounded the same way and says so in marketData", async (t) => {
  const AAPL = "instrument:v1:NASDAQ:stock:AAPL:USD:USD:cash";
  const asset = { symbol: "AAPL", name: "Apple", exchange: "NASDAQ", status: "active", tradable: true,
    fractionable: true, shortable: true, securityType: "stock", classificationSource: "fixture" };
  const adapter = createAlpacaUsEquityAdapter({
    list: async () => [asset] as never, bars: async () => [], tickers: async () => [],
    calendar: async () => [], corporateActions: async () => [],
  }, { id: "alpaca-fixture", access: { mode: "public", proof: "official_contract" } });
  const fetches: Fetch[] = [];
  const registry = new ProviderRegistry();
  registry.register({ ...adapter, equities: { ...adapter.equities!, fetchCandles: async (input) => {
    fetches.push({ interval: input.interval, startMs: input.startMs, endMs: input.endMs });
    return { bars: [], adjustmentMode: input.adjustment, sessionMode: input.session, phasesIncluded: ["regular"],
      feed: { id: "iex", entitlement: "alpaca_trading_api_basic", coverage: "single_venue",
        delaySeconds: 0, historicalEmbargoSeconds: 900 },
      executionCompatible: true, studies: { regularSessionOnly: true, extendedHoursIncluded: false },
      completeness: { complete: true, expectedBars: 0, presentBars: 0, missingBars: 0, closedSessionGapsIgnored: true },
      corporateActionIds: [] };
  } } });
  const app = await serverFor(t, registry);
  const query = `interval=1m&from=0&to=${T}&limit=1000&session=regular&adjustment=raw`;

  const user = await app.inject(get("user", query, AAPL));
  assert.equal(user.statusCode, 200, user.body);
  assert.deepEqual(fetches, [{ interval: "1m", startMs: T - (USER_MAX_HISTORY_BARS - 1) * MIN, endMs: T }]);
  assert.equal(barsIn("1m", fetches[0]!), USER_MAX_HISTORY_BARS);
  assert.equal(user.json().marketData.historyLimit.truncated, true);
  assert.match(user.json().marketData.historyLimit.note, /at most 200,000 1m bars/);
  fetches.length = 0;

  const admin = await app.inject(get("admin", query, AAPL));
  assert.equal(admin.statusCode, 200, admin.body);
  assert.deepEqual(fetches, [{ interval: "1m", startMs: 0, endMs: T }]);
  assert.equal(admin.json().marketData.historyLimit, undefined);
});

test("completeness is judged over the `limit` window, not the whole clamped span", async (t) => {
  // from=0&limit=5 asks for five bars; the 199,995 older bars the clamp still
  // covered were never requested and must not be reported as missing.
  const fetches: Fetch[] = [];
  const app = await server(t, [coinbase], recordingDeps(fetches));
  const res = await app.inject(get("user", `interval=1m&from=0&to=${T}&limit=5`));
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.completeness.truncated, true);
  assert.equal(barsIn("1m", fetches[0]!), USER_MAX_HISTORY_BARS);
  // The fixture answers with the last three bars; two of them had closed by T.
  assert.equal(body.bars.length, 3);
  assert.ok(body.completeness.missingBars < 5,
    `missing bars are counted inside the five-bar window, got ${body.completeness.missingBars}`);
});
