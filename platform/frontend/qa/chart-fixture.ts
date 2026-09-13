/** Local browser adapter for the existing DOM-test chart-state contract.
 * Run: npx tsx qa/chart-fixture.ts. No exchange or execution connections.
 * State is in memory and lasts only for this process.
 */
import { createServer } from "node:http";
import { FixtureServer, type CompactBar } from "../tests/dom/harness/server";

const fixture = new FixtureServer();
fixture.routes.set("/api/market/v1/candles/", async (_body, url) => {
  const encoded = url.pathname.split("/candles/")[1] ?? "";
  const instrument = decodeURIComponent(encoded);
  // Canonical spot ids include settlement and series segments:
  // `instrument:v1:BINANCE:spot:SOL:USDT:USDT:spot`.  Keep the fixture
  // aligned with the product wire id rather than only accepting the older
  // `BASE:QUOTE:spot` shorthand.
  const match = instrument.match(/:([^:]+):([^:]+):[^:]+:spot$/);
  const symbol = match ? `${match[1]}${match[2]}` : "SOLUSDT";
  const interval = url.searchParams.get("interval") ?? "15m";
  const bars = fixture.candlesFor(symbol, interval);
  return { format: "compact-v1", symbol, interval, stepMs: intervals[interval] ?? 900000, count: bars.length, bars };
});
const intervals: Record<string, number> = {
  "1s": 1000, "1m": 60_000, "3m": 180_000, "5m": 300_000,
  "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000,
  "4h": 14_400_000, "6h": 21_600_000, "8h": 28_800_000,
  "12h": 43_200_000, "1d": 86_400_000, "1w": 604_800_000,
};
for (const [symbol, base] of [["SOLUSDT", 145], ["BTCUSDT", 77_000]] as const) {
  for (const [interval, step] of Object.entries(intervals)) {
    const end = Math.floor(Date.now() / step) * step;
    const bars: CompactBar[] = Array.from({ length: 2000 }, (_, i) => {
      const open = base * (1 + .018 * Math.sin(i / 23) + .004 * Math.sin(i * 1.7));
      const close = base * (1 + .018 * Math.sin((i + 1) / 23) + .004 * Math.sin((i + 1) * 1.7));
      return [end - (1999 - i) * step, open, Math.max(open, close) + base * .002,
        Math.min(open, close) - base * .002, close, 1000 + i % 71 * 37];
    });
    fixture.setCandles(symbol, interval, bars);
  }
}

/*
 * ── TVP7: the fixture's market catalogue ───────────────────────────────────
 *
 * `qa/README.md` said plainly that nothing here had seen a chart with candles
 * on it; the candle routes above fixed that. They did not fix the states that
 * hang off an instrument LIST — symbol search, the watchlist's quotes — so
 * opening the symbol dialog against this fixture produced a red panel reading
 * "fixture server has no route for GET /api/market/v1/search", and the
 * watchlist stayed empty. Neither surface could be compared against anything.
 *
 * This is a QA catalogue, not a market. It is deliberately small, obviously
 * synthetic, and served only by this process — the point is to exercise the
 * populated SHAPE of those two surfaces (row density, venue and type metadata,
 * filters, keyboard navigation) without reaching an exchange or an account.
 */
interface QaInstrument {
  base: string; quote: string; venue: string;
  type: "spot" | "perpetual" | "fx_pair" | "stock" | "index";
  name: string;
  price: number;
}

const CATALOGUE: QaInstrument[] = [
  { base: "BTC", quote: "USDT", venue: "BINANCE", type: "spot", name: "Bitcoin / TetherUS", price: 77_000 },
  { base: "ETH", quote: "USDT", venue: "BINANCE", type: "spot", name: "Ethereum / TetherUS", price: 2_520 },
  { base: "SOL", quote: "USDT", venue: "BINANCE", type: "spot", name: "Solana / TetherUS", price: 145 },
  { base: "BNB", quote: "USDT", venue: "BINANCE", type: "spot", name: "BNB / TetherUS", price: 604 },
  { base: "XRP", quote: "USDT", venue: "BINANCE", type: "spot", name: "XRP / TetherUS", price: 1.94 },
  { base: "ADA", quote: "USDT", venue: "BINANCE", type: "spot", name: "Cardano / TetherUS", price: 0.61 },
  { base: "DOGE", quote: "USDT", venue: "BINANCE", type: "spot", name: "Dogecoin / TetherUS", price: 0.152 },
  { base: "LINK", quote: "USDT", venue: "BINANCE", type: "spot", name: "Chainlink / TetherUS", price: 13.4 },
  { base: "BTC", quote: "USD", venue: "BINANCE", type: "perpetual", name: "Bitcoin Perpetual", price: 77_050 },
  { base: "ETH", quote: "USD", venue: "BINANCE", type: "perpetual", name: "Ethereum Perpetual", price: 2_522 },
  { base: "EUR", quote: "USD", venue: "OANDA", type: "fx_pair", name: "Euro / US Dollar", price: 1.0842 },
  { base: "GBP", quote: "USD", venue: "OANDA", type: "fx_pair", name: "British Pound / US Dollar", price: 1.2671 },
  { base: "USD", quote: "JPY", venue: "OANDA", type: "fx_pair", name: "US Dollar / Japanese Yen", price: 143.21 },
  { base: "AAPL", quote: "USD", venue: "NASDAQ", type: "stock", name: "Apple Inc.", price: 228.4 },
  { base: "MSFT", quote: "USD", venue: "NASDAQ", type: "stock", name: "Microsoft Corporation", price: 421.7 },
  { base: "NVDA", quote: "USD", venue: "NASDAQ", type: "stock", name: "NVIDIA Corporation", price: 138.2 },
  { base: "SPX", quote: "USD", venue: "SP", type: "index", name: "S&P 500 Index", price: 5_812 },
];

const SERIES = { spot: "spot", perpetual: "perpetual", fx_pair: "cash", stock: "cash", index: "cash" } as const;

function canonicalId(i: QaInstrument): string {
  return `instrument:v1:${i.venue}:${i.type}:${i.base}:${i.quote}:${i.quote}:${SERIES[i.type]}`;
}

function searchResult(i: QaInstrument): Record<string, unknown> {
  return {
    symbol: `${i.base}${i.quote}`,
    canonicalId: canonicalId(i),
    providerId: `${i.venue.toLowerCase()}-qa-fixture`,
    providerSymbol: `${i.base}${i.quote}`,
    venueId: i.venue,
    baseAsset: i.base,
    quoteAsset: i.quote,
    settlementAsset: i.quote,
    instrumentType: i.type,
    series: { kind: SERIES[i.type] },
    status: "active",
    description: i.name,
  };
}

/** A stable pseudo-random daily move, so a row's colour does not flicker. */
function dayChange(i: QaInstrument): number {
  let h = 0;
  for (const c of `${i.base}${i.quote}`) h = (h * 31 + c.charCodeAt(0)) % 997;
  return (h % 61 - 30) / 1000;
}

fixture.routes.set("/api/market/v1/search", async (_body, url) => {
  const q = (url.searchParams.get("q") ?? "").trim().toUpperCase();
  const venue = (url.searchParams.get("venue") ?? "").trim().toUpperCase();
  const quote = (url.searchParams.get("quote") ?? "").trim().toUpperCase();
  const type = url.searchParams.get("type") ?? "all";
  const limit = Number(url.searchParams.get("limit") ?? 60);
  const matches = CATALOGUE.filter((i) => {
    const ticker = `${i.base}${i.quote}`;
    if (q && !ticker.includes(q) && !i.name.toUpperCase().includes(q) && !i.base.includes(q)) return false;
    if (venue && i.venue !== venue) return false;
    if (quote && i.quote !== quote) return false;
    if (type !== "all" && i.type !== type) return false;
    return true;
  });
  return {
    total: matches.length,
    quotes: [...new Set(CATALOGUE.map((i) => i.quote))].sort(),
    venues: [...new Set(CATALOGUE.map((i) => i.venue))].sort()
      .map((id) => ({ id, label: id === "SP" ? "S&P" : id[0] + id.slice(1).toLowerCase() })),
    results: matches.slice(0, limit).map(searchResult),
    errors: [],
  };
});

fixture.routes.set("/api/symbols/search", async (_body, url) => {
  const q = (url.searchParams.get("q") ?? "").trim().toUpperCase();
  const matches = CATALOGUE.filter((i) => i.type === "spot" && `${i.base}${i.quote}`.includes(q));
  return {
    total: matches.length,
    quotes: [...new Set(CATALOGUE.map((i) => i.quote))].sort(),
    results: matches.map(searchResult),
  };
});

fixture.routes.set("/api/symbols/tickers", async (_body, url) => {
  const wanted = (url.searchParams.get("symbols") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const now = Date.now();
  return wanted.map((symbol) => {
    const found = CATALOGUE.find((i) => `${i.base}${i.quote}` === symbol.toUpperCase());
    const price = found ? found.price : 100;
    const change = found ? dayChange(found) : 0;
    return { symbol, last: price, open: price / (1 + change), at: now };
  });
});

fixture.routes.set("/api/market/v1/tickers", async (_body, url) => {
  const wanted = (url.searchParams.get("instruments") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const now = Date.now();
  const observations = wanted.map((id) => {
    const found = CATALOGUE.find((i) => canonicalId(i) === id)
      ?? CATALOGUE.find((i) => `${i.base}${i.quote}` === id.toUpperCase());
    const price = found ? found.price : 100;
    return {
      canonicalInstrumentId: id,
      providerSymbol: found ? `${found.base}${found.quote}` : id,
      observedAt: now,
      values: { last: price, bid: price * 0.9999, ask: price * 1.0001, mid: price },
      freshness: { state: "fresh" as const, ageMs: 120 },
    };
  });
  return { providers: [{ providerId: "qa-fixture", observations }], errors: [], missing: [] };
});

/*
 * Watchlists, in memory for the life of this process.
 *
 * `GET /api/watchlists` already answered `[]` through the shared harness, so
 * the panel rendered its empty state and every attempt to leave it — the seed
 * chips, "Add all eight", typing a symbol — posted into a 404 and silently
 * did nothing. The populated watchlist was therefore the one right-rail state
 * that had never been seen at all.
 */
interface QaWatchlist { id: string; name: string; symbols: string[]; position: number; updatedAt: string }
const watchlists = new Map<string, QaWatchlist>();
let watchlistSeq = 0;

function watchlistRequest(url: URL, method: string, body: unknown): unknown | undefined {
  if (!url.pathname.startsWith("/api/watchlists")) return undefined;
  const id = url.pathname.slice("/api/watchlists".length).replace(/^\//, "");
  const patch = (body ?? {}) as Partial<QaWatchlist>;
  if (method === "GET" && !id) {
    return [...watchlists.values()].sort((a, b) => a.position - b.position);
  }
  if (method === "POST" && !id) {
    const existing = [...watchlists.values()].find((w) => w.name === patch.name);
    const row: QaWatchlist = {
      id: existing?.id ?? `qa-wl-${++watchlistSeq}`,
      name: patch.name ?? "Watchlist",
      symbols: patch.symbols ?? [],
      position: patch.position ?? existing?.position ?? watchlists.size,
      updatedAt: new Date().toISOString(),
    };
    watchlists.set(row.id, row);
    return row;
  }
  if (method === "PATCH" && id) {
    const row = watchlists.get(id);
    if (!row) return null;
    const next: QaWatchlist = {
      ...row,
      name: patch.name ?? row.name,
      symbols: patch.symbols ?? row.symbols,
      position: patch.position ?? row.position,
      updatedAt: new Date().toISOString(),
    };
    watchlists.set(id, next);
    return next;
  }
  if (method === "DELETE" && id) { watchlists.delete(id); return {}; }
  return undefined;
}

/*
 * ── TVP8: the routes the fixture did not serve ─────────────────────────────
 *
 * Four endpoints 404'd, and each one cost a whole surface:
 *
 *   /api/scanner                  the Screener was an error page, so the
 *                                 densest table in the product could not be
 *                                 reviewed at all
 *   /api/ma-alerts/events         the chart's fired-alert markers
 *   /api/auth/me                  the sign-in identity
 *   /api/layouts/sync-deployments the layout menu's deployment sync
 *
 * Everything below is obviously synthetic and served only by this process. It
 * exists so a reviewer can see the POPULATED shape of a surface — row density,
 * column behaviour, sorting, empty and error states — without an exchange, an
 * account or a database.
 *
 * `/api/market/v1/stream` is deliberately still absent. Answering it with a
 * real Binance origin would make the evidence depend on the network and on an
 * exchange being reachable, and the degraded notice the chart shows instead is
 * honest product behaviour rather than a defect to paper over.
 */
const SCANNER_SYMBOLS = [
  ["BTCUSDT", 77_000, 1.8], ["ETHUSDT", 2_520, -0.9], ["SOLUSDT", 145, 3.4],
  ["BNBUSDT", 604, 0.6], ["XRPUSDT", 1.94, -2.1], ["ADAUSDT", 0.61, 1.2],
  ["DOGEUSDT", 0.152, -0.4], ["LINKUSDT", 13.4, 2.7], ["AVAXUSDT", 21.8, -1.5],
  ["DOTUSDT", 4.35, 0.9], ["MATICUSDT", 0.38, -3.2], ["ATOMUSDT", 5.12, 1.1],
] as const;

const SCANNER_TIMEFRAMES = ["15m", "1h", "4h", "1d"];

function scannerRow(symbol: string, price: number, change: number, index: number) {
  const score = Math.round(50 + change * 8 + (index % 5) * 3);
  const series = Object.fromEntries(SCANNER_TIMEFRAMES.map((tf) => [tf, {
    timeframe: tf, last_bar_ts: Date.now(), last_close_ts: Date.now(),
    stale: false, bars: 500,
  }]));
  const rsi = 50 + change * 6;
  return {
    symbol,
    market: { exchange: "BINANCE", market_type: "spot", contract_type: null, linear: false, spot: true },
    state: "ok",
    price,
    change_24h_pct: change,
    indicators: {
      ema: { fast: price * 1.001, slow: price * 0.998, trend: change > 0 ? "up" : "down" },
      rsi: { value: rsi, timeframe: "4h" },
      macd: { hist: change / 4, signal: change / 6, macd: change / 3 },
      adx: { value: 18 + Math.abs(change) * 4, di_plus: 22, di_minus: 18 },
      supertrend: { direction: change > 0 ? 1 : -1, value: price * (change > 0 ? 0.98 : 1.02) },
      vfi: { value: change * 1.7 },
      sr: { levels: [] },
      candles: { patterns: [] },
      classical: {},
    },
    series,
    errors: {},
    score: {
      label: "Long bias", disclaimer: "Not a probability.",
      score: Math.max(0, Math.min(100, score)), signed: score - 50,
      coverage: 1, gate: { passed: true, reasons: [] },
      buckets: {}, note: null,
    },
    empirical: null,
    strategy: null,
    mtf: Object.fromEntries(SCANNER_TIMEFRAMES.map((tf) => [tf, {
      rsi: { value: rsi + (tf === "1d" ? 4 : 0) },
      adx: { value: 20 },
    }])),
    note: null,
    shariah: index % 4 === 0 ? "ELIGIBLE" : index % 4 === 1 ? "REVIEW" : index % 4 === 2 ? "EXCLUDED" : "UNKNOWN",
  };
}

function scannerSnapshot(): unknown {
  return {
    exchange: "BINANCE",
    market: { exchange: "BINANCE", market_type: "spot", contract_type: null, linear: false, spot: true },
    generated_at: Date.now(),
    last_refresh_at: Date.now(),
    last_refresh_error: null,
    timeframes: SCANNER_TIMEFRAMES,
    indicators: Object.fromEntries(
      ["ema", "rsi", "macd", "vfi", "adx", "candles", "supertrend", "sr", "classical"]
        .map((k) => [k, { enabled: true, timeframe: "4h", params: {} }])),
    strategy: {
      enabled: false, name: null, timeframes: {}, rules: {},
      note: "No strategy is configured on this QA fixture.",
    },
    scoring: {
      label: "Long bias", mode: "weighted",
      disclaimer: "A synthetic QA score. Not a probability and not advice.",
      weights: { ema: 1, rsi: 1, macd: 1, adx: 1 }, ranging_multiplier: null,
    },
    unverified_symbols: [],
    rows: SCANNER_SYMBOLS.map(([symbol, price, change], i) =>
      scannerRow(symbol, price, change, i)),
    compute_ms: 42,
  };
}

/** The endpoints above, answered from this process. */
function extraRoutes(url: URL, method: string): unknown | undefined {
  const path = url.pathname;
  if (path === "/api/scanner") return scannerSnapshot();
  if (path === "/api/scanner/health") {
    return { ok: true, service: "qa-fixture", checked_at: new Date().toISOString() };
  }
  if (path === "/api/scanner/presets") return [];
  if (path === "/api/auth/me") {
    return { id: "qa-user", email: "qa@example.invalid", name: "QA fixture" };
  }
  if (path === "/api/ma-alerts/events") return [];
  /*
   * The Shariah registry. The Screener joins it in for its status column, so
   * without it that column is empty AND the page carries a warning naming a
   * fixture route — which is the raw-provider-copy defect this campaign spent
   * a commit removing everywhere else.
   */
  if (path === "/api/shariah/universe") {
    const assets = SCANNER_SYMBOLS.map(([symbol], i) => {
      const base = symbol.replace(/USDT$/, "");
      const classification = i % 4 === 0 ? "ELIGIBLE"
        : i % 4 === 1 ? "REVIEW" : i % 4 === 2 ? "EXCLUDED" : "UNKNOWN";
      return {
        assetId: `qa-${base.toLowerCase()}`,
        baseAsset: base,
        projectName: base,
        binanceAvailable: true,
        classification,
        lifecycle: "SCREENED",
        effectiveStatus: classification,
        policyVersion: "qa-1",
        reason: classification === "EXCLUDED" ? "QA fixture: synthetic exclusion." : null,
        prohibitedCategories: classification === "EXCLUDED" ? ["qa-category"] : [],
        reviewedAt: new Date().toISOString(),
        publishedAt: new Date().toISOString(),
      };
    });
    const count = (c: string) => assets.filter((a) => a.classification === c).length;
    return {
      policyVersion: "qa-1",
      prohibitedCategories: ["qa-category"],
      counts: {
        total: assets.length, active: assets.length,
        eligible: count("ELIGIBLE"), review: count("REVIEW"), excluded: count("EXCLUDED"),
      },
      assets,
    };
  }
  if (path === "/api/shariah/mode") {
    return { mode: "OFF", policyVersion: "qa-1", botMode: "OFF", inSync: true };
  }
  if (path === "/api/shariah/snapshots") return { snapshots: [] };
  /*
   * Operations.
   *
   * The shared DOM harness answers `/api/ops/status` with
   * `{ halted: false, feeds: [] }`, which is not the contract in `lib/api.ts`:
   * `feeds` is `{ worst, rows }`, and the page reads `status.feeds.rows.length`.
   * So the whole route CRASHED into its error boundary — "Cannot read
   * properties of undefined (reading 'length')" — and one of the campaign's
   * own review screenshots was a dead page.
   *
   * The product behaved correctly: the boundary caught it, said nothing was
   * sent to the bot and offered a way out. The fixture was lying about a
   * contract. This is the contract.
   */
  if (path === "/api/ops/status") {
    const now = new Date().toISOString();
    return {
      // `OpsMode` is LIVE | STANDBY | HALTED | DISABLED. Nothing else.
      mode: "DISABLED",
      emitter: {
        thisProcess: "qa-fixture", liveRunnerEnabled: false, holdsLease: false, lease: null,
      },
      risk: {
        tradingHalted: false, haltedReason: null, haltedBy: null, haltedAt: null,
        maxTotalExposureQuote: 1000, maxConcurrentPositions: 3, maxDailyLossQuote: 100,
        dailyLossWindowHours: 24,
        snapshot: { currentExposureQuote: 0, openPositions: 0, realisedPnlInWindow: null },
        summary: "QA fixture: no exposure and no open positions.",
        dailyLossControl: {
          state: "DISABLED_UNFED", authority: "BOT",
          note: "The QA fixture does not feed realised PnL.",
        },
      },
      bot: { state: "NOT_CONFIGURED", configuredEndpoints: 0, reason: "no_custom_bot_deployment" },
      database: {
        ready: true, checks: { database: "ok", schema: "current" },
        schema: { expected: 39, applied: 39, missing: [] }, time: now,
      },
      alertRunner: {
        state: "healthy", active: 0, recent: 0, stale: 0, withoutEvidence: 0,
        lastEvaluatedAt: now, reason: "QA fixture",
      },
      deployments: {
        total: 0, active: 0, long: 0, paused: 0, paper: 0, automated: 0, signalOnly: 0,
      },
      delivery: {
        state: "healthy", summary: "Nothing queued.", windowHours: 24,
        counts: { pending: 0, sent: 0, failed: 0, skipped: 0, blocked: 0 },
        total: 0, lastSentAt: null, lastFailureAt: null, stuckPending: 0, retried: 0,
      },
      exchange: { testnetConfigured: false, note: "QA fixture: no exchange is configured." },
      feeds: {
        worst: "live",
        rows: ["BTCUSDT", "ETHUSDT", "SOLUSDT"].map((symbol) => ({
          symbol, interval: "4h", state: "live",
          lastBarTime: now, lastCheckedAt: now,
          barsBehind: 0, missingBars: 0, detail: null,
          integrity: {
            state: "healthy", market: "spot", symbol, interval: "4h",
            latestCompletedBarTime: now, latestCompletedBarAgeMs: 0,
            lastCheckedAt: now, issueCodes: [], issueCounts: {},
          },
        })),
      },
      time: now,
    };
  }
  if (path === "/api/ops/unresolved-intents") return { count: 0, intents: [] };
  if (path === "/api/layouts/sync-deployments") return method === "POST" ? { synced: 0 } : [];
  return undefined;
}

createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    // The standalone fixture is the backend origin for the Next rewrite. The
    // product's canonical market endpoint is dynamic, so it cannot be
    // registered in FixtureServer's exact-path route map. Handle that one
    // endpoint here and leave every other contract on the shared harness.
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1:4000");
    if (requestUrl.pathname.startsWith("/api/market/v1/candles/")) {
      const encoded = requestUrl.pathname.slice("/api/market/v1/candles/".length);
      const instrument = decodeURIComponent(encoded);
      const id = instrument.match(/:([^:]+):([^:]+):[^:]+:spot$/);
      const symbol = id ? `${id[1]}${id[2]}` : "SOLUSDT";
      const interval = requestUrl.searchParams.get("interval") ?? "15m";
      const bars = fixture.candlesFor(symbol, interval);
      const payload = {
        format: "compact-v1", symbol, interval,
        stepMs: intervals[interval] ?? 900000,
        count: bars.length, bars,
      };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(payload));
      return;
    }
    const extra = extraRoutes(requestUrl, (req.method ?? "GET").toUpperCase());
    if (extra !== undefined) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(extra));
      return;
    }
    const watchlistResult = watchlistRequest(
      requestUrl,
      (req.method ?? "GET").toUpperCase(),
      chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "null") : null,
    );
    if (watchlistResult !== undefined) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(watchlistResult));
      return;
    }
    const response = await fixture.handle(req.url ?? "/", {
      method: req.method, body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
    });
    res.writeHead(response.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(await response.text());
  } catch {
    res.writeHead(500); res.end('{"error":"Chart fixture request failed"}');
  }
}).listen(4000, "127.0.0.1", () => console.log("Chart QA fixture: http://127.0.0.1:4000 (synthetic data; execution disabled)"));
