/** Local browser adapter for the existing DOM-test chart-state contract.
 * Run: npx tsx qa/chart-fixture.ts. No exchange or execution connections.
 * State is in memory and lasts only for this process.
 */
import { createServer } from "node:http";
import { FixtureServer, type CompactBar } from "../tests/dom/harness/server";

const fixture = new FixtureServer();
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
 * ── The market catalogue, symbol search, quotes and watchlists ─────────────
 *
 * TVP7 gave this process its own catalogue, search, ticker and watchlist
 * routes because the shared harness had none. TVP8 (IO-A2-COV) moved all of
 * them INTO the shared harness — `tests/dom/harness/market.ts` and
 * `FixtureServer` — typed against `lib/api`, so the DOM tests and this
 * process answer from one implementation and cannot drift apart. What this
 * process still does differently is deliberate and is set right here:
 *
 * `/api/market/v1/stream` is not served. Answering it with a real exchange
 * origin would make the evidence depend on the network and on an exchange
 * being reachable; the degraded notice the chart shows instead is honest
 * product behaviour rather than a defect to paper over.
 */
fixture.streamConfigs = false;

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
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1:4000");
    const extra = extraRoutes(requestUrl, (req.method ?? "GET").toUpperCase());
    if (extra !== undefined) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(extra));
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
