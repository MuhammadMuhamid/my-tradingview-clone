/**
 * Public Binance Spot history acquisition: the configurable market-data host
 * and the bounded, incrementally persisted backfill.
 *
 * Everything here runs against a local fetch stub. No live Binance call and no
 * database connection is made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  config, resolveBinanceMarketDataBaseUrl, DEFAULT_BINANCE_MARKET_DATA_BASE_URL,
} from "../src/config";
import {
  backfillRange, fetchSymbolMetadata, type CandleSink,
} from "../src/data/binanceRest";
import { INTERVAL_MS, type Candle, type Interval } from "../src/types/market";

const MIRROR = "https://data-api.binance.vision";
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0);

interface Recorded { url: string; init?: RequestInit }

/**
 * A deliberately over-generous fake exchange: it honours `startTime` and
 * `limit` but IGNORES `endTime`, so the upper bound a test asserts can only
 * have been enforced by our own client rather than by the server.
 */
function fakeBinance(recorded: Recorded[], bars: number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = String(input);
    recorded.push({ url: raw, init });
    const url = new URL(raw);
    const step = INTERVAL_MS[url.searchParams.get("interval") as Interval];
    const startTime = Number(url.searchParams.get("startTime"));
    const limit = Number(url.searchParams.get("limit"));
    const rows: unknown[][] = [];
    for (let i = 0; i < bars && rows.length < limit; i += 1) {
      const openTime = T0 + i * step;
      if (openTime < startTime) continue;
      rows.push([
        openTime, "10.0", "11.0", "9.0", "10.5", "100.0",
        openTime + step - 1, "1050.0", 7, "0", "0", "0",
      ]);
    }
    return new Response(JSON.stringify(rows), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function withFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

function withBase(base: string): () => void {
  const original = config.binanceMarketDataBaseUrl;
  config.binanceMarketDataBaseUrl = base;
  return () => { config.binanceMarketDataBaseUrl = original; };
}

/** Collects flushed chunks without touching PostgreSQL. */
function recordingSink(): { sink: CandleSink; chunks: Candle[][] } {
  const chunks: Candle[][] = [];
  const sink: CandleSink = async (candles) => { chunks.push([...candles]); return candles.length; };
  return { sink, chunks };
}

// ── A. Default host ──────────────────────────────────────────────────────────

test("the default public market-data authority is unchanged", () => {
  assert.equal(DEFAULT_BINANCE_MARKET_DATA_BASE_URL, "https://api.binance.com");
  assert.equal(resolveBinanceMarketDataBaseUrl(undefined), "https://api.binance.com");
  assert.equal(resolveBinanceMarketDataBaseUrl(""), "https://api.binance.com");
  // No BINANCE_MARKET_DATA_BASE_URL is set for the suite, so this is the
  // behaviour any existing deployment keeps without changing anything.
  assert.equal(config.binanceMarketDataBaseUrl, "https://api.binance.com");
});

// ── B. Official public mirror, configured rather than edited in ──────────────

test("Binance's official public market-data mirror is configurable", () => {
  assert.equal(resolveBinanceMarketDataBaseUrl(MIRROR), MIRROR);
  assert.equal(resolveBinanceMarketDataBaseUrl(`${MIRROR}/`), MIRROR);
  assert.equal(resolveBinanceMarketDataBaseUrl(" https://api3.binance.com "), "https://api3.binance.com");
});

test("a configured mirror is where klines and exchangeInfo are actually fetched from", async (t) => {
  const recorded: Recorded[] = [];
  t.after(withFetch(fakeBinance(recorded, 3)));
  t.after(withBase(MIRROR));
  const { sink } = recordingSink();

  await backfillRange("NEARUSDT", "1h", T0, T0 + 2 * INTERVAL_MS["1h"], { sink, pageLimit: 10 });
  assert.ok(recorded.length > 0);
  for (const call of recorded) {
    assert.equal(new URL(call.url).origin, MIRROR);
  }
});

// ── C. Unintended configuration fails closed ─────────────────────────────────

test("a market-data base URL that is not an official Binance public host is refused", () => {
  const rejected = [
    "http://api.binance.com",              // plaintext
    "https://evil.example.com",            // not Binance
    "https://api.binance.com.evil.test",   // lookalike suffix
    "https://user:pass@api.binance.com",   // embedded credentials
    "https://api.binance.com:8443",        // non-443 port
    "https://api.binance.com/api/v3",      // path
    "https://api.binance.com/?key=x",      // query
    "https://api.binance.com/#frag",       // fragment
    "not a url",
  ];
  for (const value of rejected) {
    assert.throws(
      () => resolveBinanceMarketDataBaseUrl(value),
      /BINANCE_MARKET_DATA_BASE_URL/,
      `expected ${value} to be refused`
    );
  }
});

// ── D. Bounded paging ────────────────────────────────────────────────────────

test("bounded acquisition stops exactly at the requested range", async (t) => {
  const recorded: Recorded[] = [];
  // 40 bars exist; only bars 5..14 are requested.
  t.after(withFetch(fakeBinance(recorded, 40)));
  const step = INTERVAL_MS["1m"];
  const start = T0 + 5 * step;
  const end = T0 + 14 * step;
  const { sink, chunks } = recordingSink();

  const report = await backfillRange("NEARUSDT", "1m", start, end, { sink, pageLimit: 4 });

  assert.equal(report.rows, 10);
  assert.equal(report.from, start);
  assert.equal(report.to, end);
  assert.equal(report.firstOpenTime, start);
  assert.equal(report.lastOpenTime, end);
  const flat = chunks.flat();
  assert.equal(flat.length, 10);
  for (const candle of flat) {
    assert.ok(candle.openTime >= start && candle.openTime <= end, `${candle.openTime} out of range`);
  }
  // Every request asked for the requested upper bound, never past it.
  for (const call of recorded) {
    const url = new URL(call.url);
    assert.equal(url.searchParams.get("endTime"), String(end));
    assert.ok(Number(url.searchParams.get("startTime")) >= start);
  }
  assert.equal(report.integrity, "healthy");
});

// ── E. Incremental persistence ───────────────────────────────────────────────

test("a multi-page window flushes as it goes instead of accumulating the history", async (t) => {
  const recorded: Recorded[] = [];
  t.after(withFetch(fakeBinance(recorded, 60)));
  const step = INTERVAL_MS["1m"];
  const end = T0 + 11 * step;
  const flushes: { rows: number; requestsSoFar: number }[] = [];
  const sink: CandleSink = async (candles) => {
    flushes.push({ rows: candles.length, requestsSoFar: recorded.length });
    return candles.length;
  };

  const report = await backfillRange("NEARUSDT", "1m", T0, end, { sink, pageLimit: 2, flushSize: 4 });

  assert.equal(report.rows, 12);
  assert.equal(report.pages, 6);
  assert.equal(flushes.length, 3, "12 rows at a flush size of 4 is three flushes");
  for (const flush of flushes) {
    assert.ok(flush.rows <= 4, `flush of ${flush.rows} rows exceeded the flush size`);
  }
  // The first rows reached the sink long before the last page was requested —
  // this is what keeps 1.6M 1m bars out of memory.
  assert.ok(
    flushes[0]!.requestsSoFar < recorded.length,
    "the first flush must happen before the final page is fetched"
  );
});

// ── F. Idempotent rerun ──────────────────────────────────────────────────────

test("the candle repository upsert is what makes an overlapping rerun idempotent", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "src", "repositories", "candles.ts"), "utf8"
  );
  assert.match(sql, /ON CONFLICT \(symbol, interval, open_time\) DO UPDATE/);
  assert.match(sql, /INSERT INTO candles/);
});

test("rerunning an overlapping range writes no duplicate rows", async (t) => {
  const recorded: Recorded[] = [];
  t.after(withFetch(fakeBinance(recorded, 60)));
  const step = INTERVAL_MS["1m"];
  // Stands in for the ON CONFLICT (symbol, interval, open_time) DO UPDATE above.
  const stored = new Map<string, Candle>();
  const sink: CandleSink = async (candles) => {
    for (const c of candles) stored.set(`${c.symbol}|${c.interval}|${c.openTime}`, c);
    return candles.length;
  };

  const first = await backfillRange("NEARUSDT", "1m", T0, T0 + 9 * step, { sink, pageLimit: 4 });
  assert.equal(first.rows, 10);
  assert.equal(stored.size, 10);

  // Overlaps bars 5..9 and adds 10..14.
  const second = await backfillRange("NEARUSDT", "1m", T0 + 5 * step, T0 + 14 * step, { sink, pageLimit: 4 });
  assert.equal(second.rows, 10);
  assert.equal(stored.size, 15, "the overlap must overwrite, not duplicate");

  // A byte-identical rerun changes nothing at all.
  await backfillRange("NEARUSDT", "1m", T0, T0 + 9 * step, { sink, pageLimit: 4 });
  assert.equal(stored.size, 15);
});

// ── G. Independent targets ───────────────────────────────────────────────────

test("each symbol/timeframe target keeps its own bounds", async (t) => {
  const recorded: Recorded[] = [];
  t.after(withFetch(fakeBinance(recorded, 200)));
  const targets: { symbol: string; interval: Interval; bars: number }[] = [
    { symbol: "NEARUSDT", interval: "1m", bars: 6 },
    { symbol: "BTCUSDT", interval: "5m", bars: 3 },
  ];
  const reports = [];
  for (const target of targets) {
    const step = INTERVAL_MS[target.interval];
    const { sink } = recordingSink();
    reports.push(await backfillRange(
      target.symbol, target.interval, T0, T0 + (target.bars - 1) * step, { sink, pageLimit: 4 }
    ));
  }

  assert.equal(reports[0]!.symbol, "NEARUSDT");
  assert.equal(reports[0]!.interval, "1m");
  assert.equal(reports[0]!.rows, 6);
  assert.equal(reports[1]!.symbol, "BTCUSDT");
  assert.equal(reports[1]!.interval, "5m");
  assert.equal(reports[1]!.rows, 3);

  const near = recorded.filter((c) => c.url.includes("NEARUSDT"));
  const btc = recorded.filter((c) => c.url.includes("BTCUSDT"));
  assert.ok(near.length > 0 && btc.length > 0);
  for (const call of near) assert.match(call.url, /interval=1m/);
  for (const call of btc) assert.match(call.url, /interval=5m/);
});

// ── H. Symbol metadata through the existing exchangeInfo authority ───────────

test("symbol filters come from real exchangeInfo, and absent filters are not invented", async (t) => {
  const recorded: Recorded[] = [];
  t.after(withFetch((async (input: string | URL | Request, init?: RequestInit) => {
    recorded.push({ url: String(input), init });
    return new Response(JSON.stringify({
      symbols: [
        {
          symbol: "NEARUSDT", baseAsset: "NEAR", quoteAsset: "USDT", status: "TRADING",
          filters: [
            { filterType: "PRICE_FILTER", tickSize: "0.00100000" },
            { filterType: "LOT_SIZE", stepSize: "0.10000000" },
            { filterType: "NOTIONAL", minNotional: "5.00000000" },
          ],
        },
        { symbol: "OLDUSDT", baseAsset: "OLD", quoteAsset: "USDT", status: "BREAK", filters: [] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch));

  const [near, old] = await fetchSymbolMetadata(["NEARUSDT", "OLDUSDT"]);

  assert.equal(new URL(recorded[0]!.url).pathname, "/api/v3/exchangeInfo");
  assert.deepEqual(near, {
    symbol: "NEARUSDT", baseAsset: "NEAR", quoteAsset: "USDT", status: "TRADING",
    active: true, priceTick: 0.001, qtyStep: 0.1, minNotional: 5,
  });
  assert.equal(old!.active, false, "a non-TRADING pair is not marked active");
  assert.equal(old!.priceTick, 0, "a filter Binance did not send stays zero");
});

// ── I. Rate-limit handling ───────────────────────────────────────────────────

test("a 429 is retried within bounds and a persistent one gives up", async (t) => {
  const step = INTERVAL_MS["1h"];
  let calls = 0;
  const restore = withFetch((async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response(JSON.stringify([[
      T0, "10.0", "11.0", "9.0", "10.5", "100.0", T0 + step - 1, "1050.0", 7, "0", "0", "0",
    ]]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  const { sink } = recordingSink();
  const report = await backfillRange("NEARUSDT", "1h", T0, T0, { sink, pageLimit: 5 });
  restore();
  assert.equal(calls, 2, "the throttled request is retried once and then succeeds");
  assert.equal(report.rows, 1);

  let persistent = 0;
  const restore2 = withFetch((async () => {
    persistent += 1;
    return new Response("{}", { status: 418, headers: { "retry-after": "0" } });
  }) as typeof fetch);
  await assert.rejects(
    backfillRange("NEARUSDT", "1h", T0, T0, { sink: recordingSink().sink }),
    /Binance rate limit persisted: 418/
  );
  restore2();
  assert.equal(persistent, 5, "retries are bounded, not endless");
  t.diagnostic(`rate-limit retries observed: ${persistent}`);
});

// ── J. No authenticated or order surface ─────────────────────────────────────

test("acquisition touches only public market-data endpoints and sends no credential", async (t) => {
  const recorded: Recorded[] = [];
  t.after(withFetch(fakeBinance(recorded, 20)));
  const { sink } = recordingSink();
  await backfillRange("NEARUSDT", "1m", T0, T0 + 5 * INTERVAL_MS["1m"], { sink, pageLimit: 3 });

  assert.ok(recorded.length > 0);
  for (const call of recorded) {
    const url = new URL(call.url);
    assert.ok(
      ["/api/v3/klines", "/api/v3/exchangeInfo"].includes(url.pathname),
      `unexpected endpoint ${url.pathname}`
    );
    assert.equal(url.searchParams.get("signature"), null);
    assert.equal(url.searchParams.get("timestamp"), null);
    assert.equal(call.init?.headers, undefined, "no request header is attached at all");
  }

  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "data", "binanceRest.ts"), "utf8"
  );
  for (const forbidden of [
    "X-MBX-APIKEY", "apiKey", "API_KEY", "secretKey", "signature",
    "/api/v3/order", "/api/v3/account", "/api/v3/myTrades", "/sapi/", "createHmac",
  ]) {
    assert.ok(!source.includes(forbidden), `binanceRest.ts must not reference ${forbidden}`);
  }
});
