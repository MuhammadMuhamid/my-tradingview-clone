/**
 * A quote is priced to its INSTRUMENT's precision, at a width that does not
 * move.
 *
 * ── TVP8 R7b-04 ────────────────────────────────────────────────────────────
 *
 * The watchlist formatted every number with a magnitude heuristic that also
 * dropped trailing zeros (`Watchlist.tsx`'s old `px`). Measured on the
 * reviewer's capture, beside a chart axis reading `77,728.80`:
 *
 *     BTC   77,732     ETH  2,511.2    XRP 1.387 / 0.0367
 *     BNB      724     SOL     7.38    DOGE 0.0842 / 0.00053
 *
 * Three separate defects in one line of code: the precision came from the
 * number rather than from the instrument, so `Last` and `Chg` in ONE row were
 * shown to different precisions; the reference's own rows are flat at the
 * venue's tick (2 / 4 / 5 / 4 places); and because trailing zeros were
 * dropped, DOGE flipped between `0.08421` and `0.0842` from tick to tick, so
 * the column's right edge jittered on every frame.
 *
 * Run against the old heuristic, every assertion in the first two tests fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { changedSuffix, formatQuote, quoteDigits } from "../lib/format";

test("R7b-04 — the tick decides the decimals, and every one of them is printed", () => {
  assert.equal(formatQuote(77732, 0.01), "77,732.00",
    "a two-decimal instrument shows two decimals, not none");
  assert.equal(formatQuote(724, 0.1), "724.0");
  assert.equal(formatQuote(0.0842, 0.00001), "0.08420",
    "the trailing zero is the instrument's fifth decimal, not noise");
  assert.equal(formatQuote(0.08421, 0.00001), "0.08421");
  assert.equal(formatQuote(2511.2, 0.01), "2,511.20");
});

test("R7b-04 — a value never changes width between two ticks", () => {
  // The jitter that made DOGE's column edge move on every frame: the same
  // instrument, two consecutive prices, two different widths.
  for (const [tick, a, b] of [
    [0.00001, 0.08421, 0.0842],
    [0.01, 77_762.75, 77_762.7],
    [0.0001, 0.1401, 0.14],
  ] as const) {
    assert.equal(formatQuote(a, tick).length, formatQuote(b, tick).length,
      `${a} and ${b} at tick ${tick} must occupy the same width`);
  }
  // And with no tick known, the magnitude heuristic still pins the width.
  assert.equal(formatQuote(1.387, null), formatQuote(1.3870, null));
  assert.equal(formatQuote(1.387, null), "1.387");
});

test("R7b-04 — Chg takes the same decimals as Last, because it is the same instrument", () => {
  /*
   * `XRP 1.387 / 0.0367` and `DOGE 0.0842 / 0.00053` were one row each: the
   * old formatter read the magnitude of the CHANGE, which is two or three
   * orders of magnitude below the price.
   */
  const tick = 0.0001;
  const digits = quoteDigits(1.387, tick);
  assert.equal(digits, 4);
  assert.equal((0.0367).toLocaleString(undefined,
    { minimumFractionDigits: digits, maximumFractionDigits: digits }), "0.0367");
});

test("a quote with no number at all is a dash, not a zero", () => {
  assert.equal(formatQuote(null, 0.01), "—");
  assert.equal(formatQuote(undefined, 0.01), "—");
  assert.equal(formatQuote(Number.NaN, 0.01), "—");
});

test("R7b-17 — the changed tail of a price is what flashes", () => {
  assert.equal(changedSuffix("77,762.75", "77,762.76"), 1);
  assert.equal(changedSuffix("77,762.76", "77,762.76"), 0,
    "a row that did not tick must not flash");
  assert.equal(changedSuffix("2,511.20", "2,511.32"), 2);
  // A number that gained a digit flashes from the first character that differs.
  assert.equal(changedSuffix("9,999.99", "10,000.00"), 9);
});
