/**
 * The browser's half of venue-qualified identity.
 *
 * Two jobs: the rules behave the same as the backend's, and the two copies
 * cannot drift apart in silence — this repository has no shared package, so
 * the mirror is checked rather than assumed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  CRYPTO_SPOT, DEFAULT_ASSET_CLASS, DEFAULT_VENUE, displaySymbol, formatInstrumentId,
  InstrumentIdError, isRegisteredVenue, resolveInstrument, sameInstrument,
  splitInstrumentId, storedSymbol, tryResolveInstrument, tryStoredSymbol, VENUES,
} from "../lib/instrument";
import { parseApplyLink } from "../lib/deepLink";

test("a bare ticker resolves to the only venue and asset class this build has", () => {
  const id = resolveInstrument("BTCUSDT");
  assert.deepEqual(id, { venue: DEFAULT_VENUE, ticker: "BTCUSDT", assetClass: CRYPTO_SPOT });
  assert.equal(DEFAULT_ASSET_CLASS, CRYPTO_SPOT);
});

test("bare and qualified name the same instrument and reduce to the same stored symbol", () => {
  assert.deepEqual(resolveInstrument("btcusdt"), resolveInstrument("binance:BTCUSDT"));
  assert.equal(storedSymbol("BINANCE:BTCUSDT"), "BTCUSDT");
  assert.equal(formatInstrumentId(resolveInstrument("BTCUSDT")), "BINANCE:BTCUSDT");
  assert.equal(sameInstrument("BTCUSDT", "BINANCE:BTCUSDT"), true);
});

test("BINANCE_US is refused rather than silently charted from Binance", () => {
  assert.equal(isRegisteredVenue("BINANCE_US"), false);
  assert.deepEqual(splitInstrumentId("BINANCE_US:BTCUSDT"),
    { venue: "BINANCE_US", ticker: "BTCUSDT" });
  assert.throws(() => resolveInstrument("BINANCE_US:BTCUSDT"), InstrumentIdError);
  assert.equal(tryStoredSymbol("BINANCE_US:BTCUSDT"), null);
  assert.equal(sameInstrument("BINANCE_US:BTCUSDT", "BTCUSDT"), false);
});

test("labels stay bare while there is one venue, and the rule lives in one place", () => {
  assert.equal(Object.keys(VENUES).length, 1);
  assert.equal(displaySymbol("BINANCE:BTCUSDT"), "BTCUSDT",
    "a BINANCE: prefix on every label says nothing the header does not");
  assert.equal(displaySymbol("BTCUSDT"), "BTCUSDT");
  // Unresolvable input is shown as typed rather than swallowed.
  assert.equal(displaySymbol("BINANCE_US:BTCUSDT"), "BINANCE_US:BTCUSDT");
});

test("a deep link accepts both forms, and refuses an unimplemented venue", () => {
  const bare = parseApplyLink("?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&applyTf=15m&applyRank=1");
  const qualified = parseApplyLink(
    "?applyStrategy=ma_rr_v9&applySymbol=BINANCE%3ABTCUSDT&applyTf=15m&applyRank=1");
  assert.ok(bare && qualified);
  assert.equal(qualified.symbol, "BTCUSDT", "the qualified form is reduced before it is used");
  assert.equal(qualified.symbol, bare.symbol);

  assert.equal(
    parseApplyLink("?applyStrategy=ma_rr_v9&applySymbol=BINANCE_US%3ABTCUSDT&applyTf=15m&applyRank=1"),
    null, "a link naming an unimplemented venue is not silently charted");
});

test("malformed identities are refused rather than coerced", () => {
  for (const bad of ["", ":BTCUSDT", "BINANCE:", "BINANCE:BTC-USDT", "BTC USDT"]) {
    assert.equal(tryResolveInstrument(bad), null, `${JSON.stringify(bad)} must not resolve`);
  }
});

// ── the two copies must agree ───────────────────────────────────────────────

test("the browser and the backend agree on the venue registry and the parse rules", () => {
  const backend = fs.readFileSync(path.join(
    __dirname, "..", "..", "backend", "src", "types", "instrument.ts"), "utf8");

  assert.match(backend, /export const DEFAULT_VENUE = "BINANCE";/);
  assert.match(backend, /export const CRYPTO_SPOT = "crypto_spot";/);
  assert.equal(DEFAULT_VENUE, "BINANCE");
  assert.equal(CRYPTO_SPOT, "crypto_spot");

  // The regexes decide what resolves; a divergence would let one side accept
  // an identity the other refuses.
  const frontendSource = fs.readFileSync(path.join(__dirname, "..", "lib", "instrument.ts"), "utf8");
  for (const name of ["VENUE_RE", "TICKER_RE"]) {
    const grab = (src: string): string => {
      const m = src.match(new RegExp(`const ${name} = (/[^;]+/);`));
      assert.ok(m, `${name} is declared`);
      return m![1]!;
    };
    assert.equal(grab(frontendSource), grab(backend), `${name} must be identical on both sides`);
  }

  // And exactly one venue is registered on both sides.
  const venueCount = (src: string): number =>
    (src.match(/\[DEFAULT_VENUE\]: \{ id: DEFAULT_VENUE/g) ?? []).length;
  assert.equal(venueCount(backend), 1);
  assert.equal(venueCount(frontendSource), 1);
  assert.doesNotMatch(backend.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
    /VENUES[\s\S]{0,200}BINANCE_US/, "BINANCE_US is not in the registry");
});
