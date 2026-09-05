/**
 * "Last" must be the market, or say that it is not.
 *
 * The workspace read its Last price — the toolbar readout and the value the
 * price-alert dialog prefills — from a page-level history copy that no live
 * kline ever reaches. These pin the precedence that replaces it, including the
 * two rules that are safety rather than polish: Replay never shows a live
 * price, and a stored close is never presented as a live one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  lastPriceLabel, lastPriceNotice, resolveLastPrice,
} from "../lib/lastPrice";
import { searchKey } from "../lib/symbolSearch";

test("a live frame outranks the stored close, however fresh that close looks", () => {
  const resolved = resolveLastPrice({ liveClose: 101.5, historyClose: 99 });
  assert.equal(resolved.price, 101.5);
  assert.equal(resolved.source, "live");
  assert.equal(resolved.live, true);
  assert.equal(lastPriceLabel(resolved), "Last");
  assert.equal(lastPriceNotice(resolved), null, "a live price owes no qualification");
});

test("before any live frame the stored close is used, and says what it is", () => {
  const fresh = resolveLastPrice({ historyClose: 99 });
  assert.equal(fresh.price, 99);
  assert.equal(fresh.source, "history");
  assert.equal(fresh.live, false);
  assert.equal(lastPriceLabel(fresh), "Last close");
  assert.match(lastPriceNotice(fresh) ?? "", /No live frame yet/);

  const behind = resolveLastPrice({ historyClose: 99, historyStale: true });
  assert.equal(behind.stale, true);
  assert.equal(lastPriceLabel(behind), "Last stored");
  assert.match(lastPriceNotice(behind) ?? "", /behind the market/);
});

test("Replay outranks everything: a live frame cannot leak into a replayed session", () => {
  const resolved = resolveLastPrice({
    replayActive: true, replayClose: 42, liveClose: 101.5, historyClose: 99,
  });
  assert.equal(resolved.price, 42);
  assert.equal(resolved.source, "replay");
  assert.equal(resolved.live, false);
  assert.equal(lastPriceLabel(resolved), "Replay");
});

test("an active Replay with no bar yet shows nothing rather than falling through to live", () => {
  const resolved = resolveLastPrice({
    replayActive: true, replayClose: null, liveClose: 101.5, historyClose: 99,
  });
  assert.equal(resolved.price, null);
  assert.equal(resolved.source, "none");
});

test("a price that is not a usable number is not a price", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    const resolved = resolveLastPrice({ liveClose: bad as number, historyClose: 99 });
    assert.equal(resolved.source, "history", `${String(bad)} must not be taken as a live price`);
  }
  assert.equal(resolveLastPrice({}).price, null);
  assert.equal(resolveLastPrice({}).source, "none");
});

// ── the symbol dialog's query identity ──────────────────────────────────────

test("a search key ignores only what the server itself ignores", () => {
  assert.equal(searchKey(" sol ", "all"), searchKey("SOL", "ALL"));
  assert.notEqual(searchKey("SOL", "ALL"), searchKey("SOLU", "ALL"));
  assert.notEqual(searchKey("SOL", "ALL"), searchKey("SOL", "USDT"),
    "the quote chip is part of what a result set answers");
});

test("history from another dataset is not a price for this one", () => {
  // The page passes null rather than the previous instrument's close while a
  // new window loads. The resolver must then say it has nothing, not fall
  // through to a number it was never given.
  const resolved = resolveLastPrice({ historyClose: null, liveClose: null });
  assert.equal(resolved.price, null);
  assert.equal(resolved.source, "none");
  assert.equal(lastPriceNotice(resolved), null, "and owes no explanation for a number it is not showing");
});

test("the page gates its history fallback on the dataset it is actually holding", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "app", "chart", "page.tsx"), "utf8");
  assert.match(source, /datasetKey\(activeHistory\.dataset\) === datasetKey\(\{ symbol, interval \}\)/,
    "the page must compare what it holds against what it asked for");
  assert.match(source, /historyClose: holdingRequested \? candles\[candles\.length - 1\]\?\.close \?\? null : null/,
    "and pass nothing rather than the previous instrument's close");
  assert.match(source, /historyStale: holdingRequested && activeHistory\.stale/);
});
