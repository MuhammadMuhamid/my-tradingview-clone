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
  const symbol = instrument.match(/:([A-Z0-9]+):([A-Z0-9]+):spot$/)?.[1]
    ? `${instrument.match(/:([A-Z0-9]+):([A-Z0-9]+):spot$/)![1]}${instrument.match(/:([A-Z0-9]+):([A-Z0-9]+):spot$/)![2]}`
    : "SOLUSDT";
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

createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = await fixture.handle(req.url ?? "/", {
      method: req.method, body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
    });
    res.writeHead(response.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(await response.text());
  } catch {
    res.writeHead(500); res.end('{"error":"Chart fixture request failed"}');
  }
}).listen(4000, "127.0.0.1", () => console.log("Chart QA fixture: http://127.0.0.1:4000 (synthetic data; execution disabled)"));
