import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  canonicalDisplayParts, displaySymbol, isCanonicalInstrumentId, storedSymbol,
} from "../lib/instrument";

const ROOT = path.resolve(__dirname, "..");
const id = "instrument:v1:COINBASE:spot:BTC:USD:USD:spot";

test("canonical spot ids persist intact and render venue-qualified collision labels", () => {
  assert.equal(isCanonicalInstrumentId(id), true);
  assert.equal(storedSymbol(id), id);
  assert.deepEqual(canonicalDisplayParts(id), { venue: "COINBASE", type: "spot", base: "BTC", quote: "USD",
    settlement: "USD", series: "spot", expiry: null });
  assert.equal(displaySymbol(id), "COINBASE:BTC/USD · SPOT");
  assert.notEqual(displaySymbol(id), displaySymbol("instrument:v1:KRAKEN:spot:BTC:USD:USD:spot"));
});

test("canonical chart reads use market.v1 while legacy Binance reads retain their route", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib/api.ts"), "utf8");
  assert.match(source, /symbol\.toLowerCase\(\)\.startsWith\("instrument:v1:"\)/);
  assert.match(source, /api\/market\/v1\/candles/);
  assert.match(source, /api\/symbols\/\$\{symbol\}\/candles/);
});

test("non-Binance tail refresh never calls the Binance backfill mutation", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib/useCandleHistory.ts"), "utf8");
  assert.match(source, /if \(!isCanonicalInstrumentId\(symbol\)\) \{\s*await api\.backfill/);
  assert.match(source, /api\.candlesRange\(symbol, interval/);
});

test("canonical charts do not open the legacy Binance-only chart feed", () => {
  const source = fs.readFileSync(path.join(ROOT, "components/CandleChart.tsx"), "utf8");
  const guard = source.indexOf("if (isCanonicalInstrumentId(symbol))");
  const legacySubscription = source.indexOf("marketFeed.subscribe(symbol, interval");
  assert.ok(guard >= 0, "canonical instrument guard is present");
  assert.ok(legacySubscription > guard, "canonical guard runs before the legacy subscription");
});
