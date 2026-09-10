import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  canonicalDisplayParts, displaySymbol, instrumentTypeLabel, isCanonicalInstrumentId,
  isDerivativeInstrumentId, storedSymbol,
} from "../lib/instrument";

const ROOT = path.resolve(__dirname, "..");
const perp = "instrument:v1:BINANCE:perpetual:BTC:USDT:USDT:perpetual";
const future = "instrument:v1:GATEIO:future:BTC:USDT:USDT:dated-20260925";

test("browser identity makes spot, PERP and FUTURE collisions unmistakable", () => {
  assert.equal(isCanonicalInstrumentId(perp), true);
  assert.equal(isDerivativeInstrumentId(perp), true);
  assert.equal(storedSymbol(perp), perp);
  assert.deepEqual(canonicalDisplayParts(future), {
    venue: "GATEIO", type: "future", base: "BTC", quote: "USDT", settlement: "USDT",
    series: "dated-20260925", expiry: "2026-09-25",
  });
  assert.equal(displaySymbol(perp), "BINANCE:BTC/USDT · PERP");
  assert.equal(displaySymbol(future), "GATEIO:BTC/USDT · FUTURE 2026-09-25");
  assert.equal(instrumentTypeLabel("spot"), "SPOT");
  assert.notEqual(displaySymbol(perp), displaySymbol("instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot"));
  assert.equal(isCanonicalInstrumentId("instrument:v1:GATEIO:future:BTC:USDT:USDT:dated-20260231"), false);
});

test("search carries type and expiry filters and has no options capability", () => {
  const api = fs.readFileSync(path.join(ROOT, "lib", "api.ts"), "utf8");
  const dialog = fs.readFileSync(path.join(ROOT, "components", "tv", "SymbolSearch.tsx"), "utf8");
  assert.match(api, /type: "all" \| "spot" \| "perpetual" \| "future"/);
  assert.match(api, /expiry: "all" \| "live" \| "30d" \| "90d" \| "expired"/);
  assert.match(dialog, /\["spot", "SPOT"\]/); assert.match(dialog, /\["perpetual", "PERP"\]/);
  assert.match(dialog, /\["future", "FUTURE"\]/);
  assert.doesNotMatch(api, /instrumentType[^\n]+option/i);
});

test("pane and watchlist expose derivative identity and compact mark/index/funding/OI/basis metrics", () => {
  const panel = fs.readFileSync(path.join(ROOT, "components", "tv", "DerivativeIdentity.tsx"), "utf8");
  const legend = fs.readFileSync(path.join(ROOT, "components", "tv", "PaneLegend.tsx"), "utf8");
  const watchlist = fs.readFileSync(path.join(ROOT, "components", "tv", "Watchlist.tsx"), "utf8");
  for (const field of ["Mark price", "Index price", "Funding rate", "Open interest", "Mark minus index"])
    assert.match(panel, new RegExp(field));
  assert.match(panel, /Same underlying across venues/);
  assert.match(panel, /contractSize\.value/);
  assert.match(panel, /quantityUnit/);
  assert.match(panel, /max-sm:fixed max-sm:left-3 max-sm:right-3/, "mobile details stay inside the viewport");
  assert.match(legend, /<DerivativeIdentity/);
  assert.match(watchlist, /instrumentTypeLabel\(identity\.type\)/);
  assert.match(watchlist, /shrink-0 text-\[9px\]/, "watchlist preserves type/venue while the pair label yields width");
});

test("canonical instruments cannot reach the legacy spot order ticket or polling loop", () => {
  const page = fs.readFileSync(path.join(ROOT, "app", "chart", "page.tsx"), "utf8");
  const side = fs.readFileSync(path.join(ROOT, "components", "tv", "ChartSidePanel.tsx"), "utf8");
  assert.match(page, /replayActive \|\| isCanonicalInstrumentId\(tradingSymbol\)/);
  assert.match(side, /isCanonicalInstrumentId\(props\.tradingSymbol\)[\s\S]+Read-only market instrument/);
  assert.match(side, /analytics only/);
});
