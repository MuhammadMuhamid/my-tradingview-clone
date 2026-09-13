/**
 * One instrument, one precision — on the axis as well as on the series.
 *
 * The price axis formatter was `fmtPrice`, which derives its decimals from the
 * magnitude of each NUMBER it is handed. On a scale spanning 60 to 170 that
 * printed `170.00` four rows above `90.0000`: two precisions on one axis, on
 * one instrument, against a real feed.
 *
 * These assert the property that was missing — that every label on one scale
 * is formatted to the same number of decimals — rather than the spelling of
 * any particular label.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { autoPriceDigits, fmtPrice, fmtPriceAt } from "../lib/format";

test("autoPriceDigits reads the instrument's tick, not a number's magnitude", () => {
  assert.equal(autoPriceDigits(0.01), 2);
  assert.equal(autoPriceDigits(0.001), 3);
  assert.equal(autoPriceDigits(0.0001), 4);
  assert.equal(autoPriceDigits(1), 0);
  // An absent or nonsense tick falls back to the two decimals a price has.
  assert.equal(autoPriceDigits(null), 2);
  assert.equal(autoPriceDigits(0), 2);
  assert.equal(autoPriceDigits(-1), 2);
});

test("one scale labels every value at the same precision, either side of 100", () => {
  // The SOL/USDT scale that exposed this: real bars from 60 to 170.
  const scale = [170, 160, 130, 110, 101.24, 90, 80, 70, 60];
  const digits = autoPriceDigits(0.01);
  const decimals = scale.map((v) => {
    const parts = fmtPriceAt(v, digits).split(".");
    return parts.length === 2 ? parts[1].length : 0;
  });
  assert.deepEqual(
    [...new Set(decimals)], [2],
    `one instrument must label its whole scale at one precision, got ${decimals.join(",")}`
  );
});

test("fmtPrice — the per-number formatter — is exactly what must not reach an axis", () => {
  // Not a wish: this is the behaviour that produced the defect, pinned so the
  // test above cannot be satisfied by quietly changing fmtPrice instead.
  const above = fmtPrice(170).split(".")[1].length;
  const below = fmtPrice(90).split(".")[1].length;
  assert.notEqual(above, below,
    "fmtPrice is magnitude-adaptive by design; if that changed, the axis fix needs rereading");
});

test("the chart axis formatter is told its digits rather than deriving them", () => {
  const src = readFileSync(new URL("../components/CandleChart.tsx", import.meta.url), "utf8");
  const formatter = /priceFormatter:\s*\(price: number\)\s*=>\s*([A-Za-z]+)\(/.exec(src);
  assert.ok(formatter, "the price axis must set a priceFormatter");
  assert.equal(formatter[1], "fmtPriceAt",
    "the axis must use the explicit-precision formatter, not the magnitude-adaptive fmtPrice");
  assert.match(src, /axisDigitsRef\.current = digits/,
    "the effect that applies priceFormat to the series must also write the axis's digits");
});
