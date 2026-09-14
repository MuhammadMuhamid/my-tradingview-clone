import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalizeLegacySpotSymbol, legacyBinanceSpotTicker } from "../lib/instrument";
import { alertCapability, categoryForInstrument, researchAssumptions } from "../lib/workstation";
import { directWatchlistStreamSupported, MAX_CANONICAL_WATCHLIST_STREAMS } from "../lib/useWatchlistTickers";
import { canonicalCandleStreamSupported } from "../lib/useCandleHistory";
import { parseWorkspace } from "../lib/workspace";

const ROOT = path.resolve(__dirname, "..");
const BTC = "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot";
const PERP = "instrument:v1:BYBIT:perpetual:BTC:USDT:USDT:perpetual";
const FX = "instrument:v1:OANDA:fx_pair:EUR:USD:USD:cash";
const CONTINUOUS = "instrument:v1:NYMEX:continuous_future:CL:USD:USD:continuous-cl-front-calendar-unadjusted";

test("legacy browser identity and stored workspace panes migrate canonically", () => {
  assert.equal(canonicalizeLegacySpotSymbol("BINANCE:btcusdt"), BTC);
  assert.equal(canonicalizeLegacySpotSymbol("INSTRUMENT:V1:NYMEX:CONTINUOUS_FUTURE:CL:USD:USD:CONTINUOUS-CL-FRONT-CALENDAR-UNADJUSTED"), CONTINUOUS);
  assert.equal(legacyBinanceSpotTicker(BTC), "BTCUSDT");
  assert.equal(legacyBinanceSpotTicker("BINANCE:btcusdt"), "BTCUSDT");
  assert.equal(legacyBinanceSpotTicker(PERP), null);
  assert.equal(legacyBinanceSpotTicker(FX), null);
  const restored = parseWorkspace({ version: 2, presetId: "1", activePaneId: "p1", maximizedPaneId: null,
    panes: [{ id: "p1", symbol: "BTCUSDT", interval: "15m", chartType: "candles", bars: 1000,
      maLines: [], compare: { symbol: "ETHUSDT", mode: "percent", length: 60 } }] });
  assert.equal(restored?.panes[0]?.symbol, BTC);
  assert.equal(restored?.panes[0]?.compare?.symbol, "instrument:v1:BINANCE:spot:ETH:USDT:USDT:spot");
});

test("alert and research semantics are capability-driven", () => {
  assert.equal(alertCapability(BTC).supported, true);
  assert.equal(alertCapability(PERP).supported, false);
  assert.match(alertCapability(FX).reason ?? "", /Binance Spot last-price/);
  assert.equal(categoryForInstrument(PERP), "crypto_derivatives");
  assert.equal(categoryForInstrument(FX), "fx");
  assert.ok(researchAssumptions(PERP).some((item) => /historical funding required/.test(item)));
  assert.ok(researchAssumptions(CONTINUOUS).some((item) => /roll cl-front-calendar-unadjusted/.test(item)));
});

test("large mixed watchlists cap live canonical subscriptions and retain shared polling", () => {
  assert.equal(MAX_CANONICAL_WATCHLIST_STREAMS, 12);
  assert.equal(directWatchlistStreamSupported("instrument:v1:COINBASE:spot:BTC:USD:USD:spot"), true);
  assert.equal(directWatchlistStreamSupported(PERP), true);
  assert.equal(directWatchlistStreamSupported(FX), false);
  assert.equal(directWatchlistStreamSupported(CONTINUOUS), false);
  assert.equal(canonicalCandleStreamSupported(FX, "15m"), false);
  assert.equal(canonicalCandleStreamSupported(CONTINUOUS, "15m"), false);
  assert.equal(canonicalCandleStreamSupported("instrument:v1:COINBASE:spot:BTC:USD:USD:spot", "15m"), false);
  assert.equal(canonicalCandleStreamSupported("instrument:v1:COINBASE:spot:BTC:USD:USD:spot", "5m"), true);
  assert.equal(canonicalCandleStreamSupported(PERP, "15m"), true);
  const source = fs.readFileSync(path.join(ROOT, "lib", "useWatchlistTickers.ts"), "utf8");
  assert.match(source, /directCanonical\.slice\(0, MAX_CANONICAL_WATCHLIST_STREAMS\)/);
  assert.match(source, /setCanonicalStreamEligible\(market\?\.providers\.flatMap/,
    "only catalog-resolved instruments may open a direct provider stream");
  assert.match(source, /Canonical persistence must not turn one legacy socket into one/);
  assert.match(source, /combinedStreamPath\(combined\.map/);
  assert.match(source, /api\.marketTickers\(canonical/);
  assert.match(source, /const contentKey = symbols\.map/,
    "effect dependencies must be stable when a parent recreates an equal symbol array");
  assert.match(source, /15-second provider snapshot/);
});

test("all alert entry points and order-ticket chrome use cross-market boundaries", () => {
  const page = fs.readFileSync(path.join(ROOT, "app", "chart", "page.tsx"), "utf8");
  assert.ok((page.match(/alertCapability\(/g) ?? []).length >= 6);
  assert.doesNotMatch(page, /setPriceAlertOpen\(true\)[\s\S]{0,80}isEquityInstrumentId/);
  const side = fs.readFileSync(path.join(ROOT, "components", "tv", "ChartSidePanel.tsx"), "utf8");
  assert.match(side, /Paper \/ demo \/ testnet order ticket/);
});

// ── IO-A7: an abort is this effect superseding itself ──────────────────────

/**
 * No catch in the watchlist ticker effect may write an abort into the header.
 *
 * ── What this is, and the test I deleted instead of keeping ────────────────
 *
 * A SOURCE check. The honest version mounts the watchlist, adds a symbol,
 * stalls the ticker route, edits the list underneath the in-flight request and
 * reads the header. I wrote it. It passed — and a vacuity guard I added
 * afterwards showed it had never made a ticker request at all: a watchlist with
 * nothing on it does not poll, and the fixture's watchlist route does not
 * persist a symbol far enough for the poll to start. Reaching it needs the same
 * fixture work IO-A2-COV needs, so the test was deleted rather than counted.
 *
 * What is left is narrow and it is real. The defect was a `.catch` that wrote
 * the rejection into `issues` without asking whether the request had been
 * ABORTED — which the effect does itself, on every list change. So editing the
 * watchlist painted
 *
 *     some quotes unavailable — Ticker refresh failed: signal is aborted…
 *
 * and because `issues` is tested before `stream.status === "live"` in the
 * header's ternary, that also overrode a genuinely live indicator. If the edit
 * emptied the canonical set, nothing was left running to clear it.
 *
 * The rule is narrower than "every catch checks for an abort", which was the
 * first draft and which failed on a handler that is perfectly correct: the two
 * reads at the top return `{ error }` into a `Promise.all` whose own first line
 * is the abort check, so they are guarded one level up. What must never happen
 * is a catch that writes component state without looking.
 */
test("IO-A7 — no catch in the ticker effect writes an abort into the header", () => {
  /*
   * Comments are stripped FIRST, and that is not tidiness.
   *
   * The first version of this test sliced 500 characters off each `.catch` and
   * looked in there. The explanatory comment inside the repaired handler is
   * longer than that, so the `setIssues` call fell outside the window, the
   * handler was not selected as a state-writer at all, and deleting the abort
   * guard left this test GREEN. A scanner that reads prose is a scanner whose
   * answer depends on how much prose there is.
   */
  const source = fs.readFileSync(
    path.join(ROOT, "lib", "useWatchlistTickers.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const writers = source.split(".catch(").slice(1)
    .map((body) => body.slice(0, 400))
    .filter((body) => /set(Issues|Tickers|CanonicalStates|CanonicalStreamEligible)\(/.test(body));

  assert.ok(writers.length >= 2,
    `only ${writers.length} state-writing catch handlers found — has this moved?`);
  for (const body of writers) {
    assert.ok(/aborted|isAbortError/.test(body),
      "a catch writes state without checking for an abort, so superseding this "
      + `effect reports itself as a broken feed:\n${body.slice(0, 220)}`);
  }
});

test("IO-A7 — and the raw cause is not the header's copy", () => {
  /* REV-UX-01's rule, at a surface the tree-wide scanner cannot see: these are
   * strings pushed into an array, not a JSX child. */
  const source = fs.readFileSync(
    path.join(ROOT, "lib", "useWatchlistTickers.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.doesNotMatch(source, /refresh failed: \$\{\(cause as Error\)\.message\}/,
    "a provider's own words are being made into the watchlist header's sentence");
});
