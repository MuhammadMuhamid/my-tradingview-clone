/**
 * Venue-qualified identity, and the compatibility it must not break.
 *
 * The two claims that matter most here are negative ones: a bare ticker keeps
 * meaning exactly what it always meant, and `BINANCE_US` is never quietly
 * served from Binance.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  assetsBySuffixFallback, assetsFromMetadata, CRYPTO_SPOT, DEFAULT_ASSET_CLASS,
  DEFAULT_VENUE, formatInstrumentId, InstrumentIdError, isRegisteredVenue,
  resolveInstrument, sameInstrument, splitInstrumentId, storedSymbol,
  tryResolveInstrument, VENUES,
} from "../src/types/instrument";
import { BINANCE_SPOT_PROFILE, providerProfileFor, PROVIDER_PROFILES } from "../src/data/providerProfile";
import { marketData, marketDataFor } from "../src/data/marketData";
import { BINANCE_MARKET_DATA_HOSTS } from "../src/config";
import { requiredMigrationFiles } from "../src/db/migrate";

// ── bare stays canonical ────────────────────────────────────────────────────

test("a bare ticker resolves to the only venue and asset class this build has", () => {
  const id = resolveInstrument("BTCUSDT");
  assert.equal(id.venue, DEFAULT_VENUE);
  assert.equal(id.ticker, "BTCUSDT");
  assert.equal(id.assetClass, CRYPTO_SPOT);
  assert.equal(DEFAULT_ASSET_CLASS, CRYPTO_SPOT);
});

test("bare and qualified forms are the same instrument, and reduce to the same stored symbol", () => {
  assert.deepEqual(resolveInstrument("btcusdt"), resolveInstrument("binance:BTCUSDT"));
  assert.equal(storedSymbol("BINANCE:BTCUSDT"), "BTCUSDT");
  assert.equal(storedSymbol("  btcusdt  "), "BTCUSDT");
  assert.equal(formatInstrumentId(resolveInstrument("BTCUSDT")), "BINANCE:BTCUSDT");
  assert.equal(sameInstrument("BTCUSDT", "BINANCE:BTCUSDT"), true);
  assert.equal(sameInstrument("BTCUSDT", "ETHUSDT"), false);
});

// ── the ambiguity that must not be resolved by guessing ────────────────────

test("BINANCE_US is a different venue, not a host variant, and is refused", () => {
  assert.equal(isRegisteredVenue("BINANCE_US"), false);
  assert.equal(isRegisteredVenue("BINANCE"), true);
  assert.equal(Object.keys(VENUES).length, 1, "exactly one venue is implemented");

  // Parseable as a NAME, so a refusal can say what it refused …
  assert.deepEqual(splitInstrumentId("BINANCE_US:BTCUSDT"),
    { venue: "BINANCE_US", ticker: "BTCUSDT" });
  // … and refused as a TARGET, rather than falling back to the default venue.
  assert.throws(() => resolveInstrument("BINANCE_US:BTCUSDT"), InstrumentIdError);
  assert.equal(tryResolveInstrument("BINANCE_US:BTCUSDT"), null);
  assert.equal(sameInstrument("BINANCE_US:BTCUSDT", "BTCUSDT"), false,
    "one exchange's instrument must never compare equal to another's");
  assert.equal(marketDataFor("BINANCE_US"), null, "and there is no provider for it");
});

test("malformed identities are refused rather than coerced", () => {
  for (const bad of ["", ":BTCUSDT", "BINANCE:", "BINANCE:BTC-USDT", "1BINANCE:BTCUSDT",
                     "BINANCE:B", "BTC USDT", "BINANCE:BTCUSDT:EXTRA"]) {
    assert.equal(tryResolveInstrument(bad), null, `${JSON.stringify(bad)} must not resolve`);
  }
});

// ── base / quote comes from metadata ───────────────────────────────────────

test("assets come from metadata when it exists, and the suffix split is only a fallback", () => {
  assert.deepEqual(assetsFromMetadata({ baseAsset: "eth", quoteAsset: "btc" }),
    { baseAsset: "ETH", quoteAsset: "BTC" });
  assert.equal(assetsFromMetadata({ baseAsset: "ETH" }), null, "half an answer is no answer");
  assert.equal(assetsFromMetadata(null), null);

  // The old rule registered ETHBTC as base ETHBTC / quote USDT. The fallback
  // at least knows the venue's real quote assets.
  assert.deepEqual(assetsBySuffixFallback("ETHBTC"), { baseAsset: "ETH", quoteAsset: "BTC" });
  assert.deepEqual(assetsBySuffixFallback("BTCFDUSD"), { baseAsset: "BTC", quoteAsset: "FDUSD" });
  assert.deepEqual(assetsBySuffixFallback("BTCUSDT"), { baseAsset: "BTC", quoteAsset: "USDT" });
  // And says nothing rather than inventing a quote it cannot see.
  assert.deepEqual(assetsBySuffixFallback("XYZ"), { baseAsset: "XYZ", quoteAsset: "" });
});

// ── the provider profile describes the policy that already existed ─────────

test("the provider profile adds no endpoint the allowlist did not already permit", () => {
  assert.deepEqual([...BINANCE_SPOT_PROFILE.restAllowedHosts], [...BINANCE_MARKET_DATA_HOSTS]);
  assert.equal(new URL(BINANCE_SPOT_PROFILE.restPrimary).hostname, "api.binance.com");
  for (const alternate of BINANCE_SPOT_PROFILE.restAlternates) {
    assert.ok(
      (BINANCE_MARKET_DATA_HOSTS as readonly string[]).includes(new URL(alternate).hostname),
      `${alternate} must already be on the allowlist`);
  }
  for (const origin of BINANCE_SPOT_PROFILE.streamOrigins) {
    assert.match(origin, /^wss:\/\//, "stream origins are wss, always");
  }
  assert.equal(PROVIDER_PROFILES.length, 1, "one provider is implemented");
  assert.equal(providerProfileFor("BINANCE"), BINANCE_SPOT_PROFILE);
  assert.equal(providerProfileFor("BINANCE_US"), null);
});

test("the browser's stream origins and the profile's are the same list", () => {
  const browser = fs.readFileSync(
    path.join(__dirname, "..", "..", "frontend", "lib", "marketStream.ts"), "utf8");
  const block = browser.slice(browser.indexOf("MARKET_STREAM_ORIGINS"));
  for (const origin of BINANCE_SPOT_PROFILE.streamOrigins) {
    assert.ok(block.includes(origin),
      `${origin} is in the profile but not in the browser's origin list`);
  }
  const declared = [...block.slice(0, block.indexOf("];")).matchAll(/"(wss:\/\/[^"]+)"/g)]
    .map((m) => m[1]);
  assert.deepEqual(declared, [...BINANCE_SPOT_PROFILE.streamOrigins],
    "the two lists must not drift; the profile mirrors the browser's, in order");
});

// ── the facade is a seam, not a second implementation ──────────────────────

test("the market-data facade resolves to the one Binance spot provider", () => {
  assert.equal(marketData.venue, DEFAULT_VENUE);
  assert.equal(marketData.profile, BINANCE_SPOT_PROFILE);
  assert.equal(marketDataFor("binance"), marketData, "venue lookup is case-insensitive");
  assert.deepEqual([...marketData.streamOrigins()], [...BINANCE_SPOT_PROFILE.streamOrigins]);
  for (const method of [
    "listInstruments", "instrumentMetadata", "registerInstruments", "syncInstrumentFilters",
    "historicalCandles", "ensureCoverage", "tickers",
  ] as const) {
    assert.equal(typeof marketData[method], "function", `${method} is part of the boundary`);
  }
});

// ── the migration is additive, and true of every row that already exists ───

test("the instrument-identity migration only adds columns with the current defaults", () => {
  const files = requiredMigrationFiles();
  const file = files.find((f) => f.includes("instrument_identity"));
  assert.ok(file, "the migration is present in the shipped set");
  assert.equal(file, files[files.length - 1], "and is the newest, numbered from current source");

  const sql = fs.readFileSync(
    path.join(__dirname, "..", "src", "db", "migrations", file!), "utf8");

  assert.match(sql, /ADD COLUMN IF NOT EXISTS\s+venue\s+text NOT NULL DEFAULT 'BINANCE'/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS\s+asset_class\s+text NOT NULL DEFAULT 'crypto_spot'/);
  assert.match(sql, /CHECK \(asset_class IN \('crypto_spot'\)\)/,
    "spot only: futures, margin and forex are not values this column may hold");

  // Nothing destructive, and no historical rewrite.
  for (const forbidden of [/DROP TABLE/i, /DROP COLUMN/i, /DELETE FROM/i, /TRUNCATE/i,
                           /UPDATE symbols SET symbol/i, /ALTER TABLE symbols RENAME/i]) {
    assert.doesNotMatch(sql, forbidden, `${forbidden} would not be additive`);
  }
  // Comments may discuss other venues; the STATEMENTS must not name one.
  const statements = sql.replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(statements, /BINANCE_US/,
    "no second venue is registered by this migration");
  assert.doesNotMatch(statements, /INSERT INTO/i,
    "no rows are seeded, so nothing historical is rewritten");
});

test("the defaults the migration writes are exactly the resolver's defaults", () => {
  const sql = fs.readFileSync(path.join(
    __dirname, "..", "src", "db", "migrations", "026_instrument_identity.sql"), "utf8");
  assert.ok(sql.includes(`DEFAULT '${DEFAULT_VENUE}'`),
    "a pre-existing row must resolve to the same venue the code assumes");
  assert.ok(sql.includes(`DEFAULT '${DEFAULT_ASSET_CLASS}'`));
});

// ── the documented surface is the actual surface ────────────────────────────

/**
 * The module header names exactly which routes accept a qualified identity.
 *
 * A comment that says "accepted anywhere a symbol is accepted" when four
 * routes resolve and a dozen do not is worse than no comment: the next reader
 * assumes a reduction is enforced and posts `BINANCE:BTCUSDT` to a route that
 * stores it verbatim or trips a foreign key. This pins the two lists together.
 */
test("exactly the documented routes resolve a venue-qualified symbol", () => {
  const routesDir = path.join(__dirname, "..", "src", "api", "routes");
  const resolving = fs.readdirSync(routesDir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => fs.readFileSync(path.join(routesDir, f), "utf8").includes("storedSymbol("))
    .sort();
  assert.deepEqual(resolving, ["data.ts", "symbols.ts"],
    "widening this set is a deliberate act; update the module header with it");

  const header = fs.readFileSync(
    path.join(__dirname, "..", "src", "types", "instrument.ts"), "utf8");
  assert.match(header, /GET \/api\/symbols\/:symbol\/candles/);
  assert.match(header, /\/api\/data\/\*/);
  assert.match(header, /Every OTHER symbol-bearing route accepts bare tickers/);

  // And the count the header claims — four surfaces — is the count that
  // exists. `storedSymbol` is used both as a call and as a `.map` argument, so
  // uses are counted rather than call syntax, minus the one import per file.
  const uses = (file: string): number => {
    const src = fs.readFileSync(path.join(routesDir, file), "utf8");
    const total = (src.match(/\bstoredSymbol\b/g) ?? []).length;
    const imported = /import[^;]*\bstoredSymbol\b[^;]*;/.test(src) ? 1 : 0;
    return total - imported;
  };
  assert.equal(uses("data.ts") + uses("symbols.ts"), 4,
    "the header says four surfaces resolve; that must be four resolving sites");
});

test("the four legacy suffix-parsing sites each carry the call-out the header promises", () => {
  const root = path.join(__dirname, "..", "..");
  const sites = [
    "backend/src/scripts/seedMaWatchlist.ts",
    "backend/src/shariah/gate.ts",
    "frontend/lib/manualTicket.ts",
    "frontend/components/tv/Watchlist.tsx",
  ];
  for (const site of sites) {
    const source = fs.readFileSync(path.join(root, site), "utf8");
    assert.match(source, /Legacy suffix split, kept deliberately/,
      `${site} is named in the header as carrying a call-out; it does not`);
  }
  // And the header names exactly these files, so the two cannot drift.
  const header = fs.readFileSync(
    path.join(__dirname, "..", "src", "types", "instrument.ts"), "utf8");
  for (const site of sites) assert.ok(header.includes(site), `${site} must be listed`);
});
