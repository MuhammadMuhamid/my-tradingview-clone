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
    const response = await fixture.handle(req.url ?? "/", {
      method: req.method, body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
    });
    res.writeHead(response.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(await response.text());
  } catch {
    res.writeHead(500); res.end('{"error":"Chart fixture request failed"}');
  }
}).listen(4000, "127.0.0.1", () => console.log("Chart QA fixture: http://127.0.0.1:4000 (synthetic data; execution disabled)"));
