/** Money, the cohort calendar and the cohort rules, without a database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, formatMoney, parseMoney, percentOf, sum } from "../src/packages/money";
import { cohortWindow, firstWindowFrom, karachiMidnight, nextWindow, TERMS } from "../src/packages/calendar";
import { buyQuote, decideBuy, decideSell, memberValues, nextStatus, withdrawable } from "../src/packages/cohortRules";

const m = parseMoney;
const iso = (d: Date) => d.toISOString();

test("money parses and prints exactly, and refuses anything else", () => {
  assert.equal(formatMoney(m("1234.5")), "1234.50000000");
  assert.equal(formatMoney(m("-0.00000001")), "-0.00000001");
  assert.equal(formatMoney(m("0.1") + m("0.2")), "0.30000000");
  for (const bad of ["", "1e3", "1.123456789", "abc", "1,000", "NaN", "Infinity"]) {
    assert.throws(() => parseMoney(bad), RangeError, bad);
  }
});

test("allocation always adds up to the whole, losses included", () => {
  for (const [total, weights] of [
    ["100", ["1", "1", "1"]], ["-100", ["1", "1", "1"]], ["0.00000001", ["5", "5"]],
    ["999.99999999", ["123.45", "0.01", "876.54", "3"]], ["-37.5", ["2", "3", "5"]],
  ] as const) {
    const parts = allocate(m(total), weights.map(m));
    assert.equal(sum(parts), m(total), `${total} over ${weights}`);
  }
  assert.deepEqual(allocate(m("100"), [m("1"), m("1"), m("1")]).map(formatMoney),
    ["33.33333334", "33.33333333", "33.33333333"]);
  assert.deepEqual(allocate(0n, [0n, 0n]), [0n, 0n]);
  assert.throws(() => allocate(1n, [0n]), RangeError);
});

test("a random spread of members always sums to the cohort's value", () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed; };
  for (let run = 0; run < 500; run++) {
    const capital = Array.from({ length: 1 + (rand() % 12) }, () => BigInt(rand() % 10_000_000_000) + 1n);
    const closing = BigInt(rand() % 50_000_000_000) - 10_000_000_000n;
    assert.equal(sum(memberValues(closing, capital)), closing);
  }
});

test("percentages round down to a cent", () => {
  assert.equal(formatMoney(percentOf(m("1000"), m("12.5"))), "125.00000000");
  assert.equal(formatMoney(percentOf(m("333.33"), m("10"))), "33.33000000");
  assert.equal(percentOf(m("-5"), m("10")), 0n);
});

test("cohort windows are Karachi calendar boundaries", () => {
  const first = cohortWindow("half_month", 2026, 12, 1);
  assert.equal(iso(first.startsAt), "2026-11-30T19:00:00.000Z", "Karachi midnight is 19:00 UTC the day before");
  assert.equal(iso(first.endsAt), "2026-12-15T19:00:00.000Z");
  assert.equal(iso(first.depositCutoffAt), iso(first.startsAt));
  const second = nextWindow("half_month", first.endsAt);
  assert.equal(iso(second.startsAt), "2026-12-15T19:00:00.000Z");
  assert.equal(iso(second.endsAt), "2026-12-31T19:00:00.000Z", "the 16th runs to month end, across the year");
  assert.equal(iso(nextWindow("half_month", second.endsAt).startsAt), "2026-12-31T19:00:00.000Z");
});

test("February, leap years and multi-month terms land on the right days", () => {
  assert.equal(iso(cohortWindow("half_month", 2028, 2, 16).endsAt), iso(karachiMidnight(2028, 3, 1)));
  assert.equal(iso(cohortWindow("month", 2027, 2, 1).endsAt), iso(karachiMidnight(2027, 3, 1)));
  assert.equal(iso(cohortWindow("quarter", 2026, 11, 1).endsAt), iso(karachiMidnight(2027, 2, 1)));
  assert.equal(iso(cohortWindow("half_year", 2026, 9, 1).endsAt), iso(karachiMidnight(2027, 3, 1)));
  assert.throws(() => cohortWindow("month", 2026, 1, 16), RangeError);
  assert.throws(() => cohortWindow("half_month", 2026, 1, 15), RangeError);
});

test("one cohort at a time: each term chains back to back without gaps", () => {
  for (const term of TERMS) {
    let window = firstWindowFrom(term, new Date("2026-11-07T10:00:00Z"));
    for (let i = 0; i < 30; i++) {
      const next = nextWindow(term, window.endsAt);
      assert.equal(iso(next.startsAt), iso(window.endsAt), term);
      window = next;
    }
  }
});

test("the first cohort is the next start on or after now", () => {
  assert.equal(iso(firstWindowFrom("half_month", new Date("2026-11-07T10:00:00Z")).startsAt), iso(karachiMidnight(2026, 11, 16)));
  assert.equal(iso(firstWindowFrom("month", new Date("2026-11-07T10:00:00Z")).startsAt), iso(karachiMidnight(2026, 12, 1)));
  // One second before Karachi midnight on the 15th is still the 15th.
  assert.equal(iso(firstWindowFrom("half_month", new Date("2026-11-15T18:59:59Z")).startsAt), iso(karachiMidnight(2026, 11, 16)));
  // Exactly Karachi midnight on the 1st starts that cohort.
  assert.equal(iso(firstWindowFrom("month", karachiMidnight(2027, 1, 1)).startsAt), iso(karachiMidnight(2027, 1, 1)));
});

test("lifecycle: open, running, settling while a trade is held, settled", () => {
  const w = cohortWindow("month", 2026, 12, 1);
  const at = (d: Date, s: Parameters<typeof nextStatus>[0]["status"], open = 0) =>
    nextStatus({ status: s, now: d, startsAt: w.startsAt, endsAt: w.endsAt, openTrades: open });
  assert.equal(at(new Date(w.startsAt.getTime() - 1), "open"), "open");
  assert.equal(at(w.startsAt, "open"), "running");
  assert.equal(at(new Date(w.endsAt.getTime() - 1), "running"), "running");
  assert.equal(at(w.endsAt, "running", 2), "settling");
  assert.equal(at(w.endsAt, "running", 0), "settled");
  assert.equal(at(w.endsAt, "settling", 1), "settling");
  assert.equal(at(w.endsAt, "settling", 0), "settled");
});

test("withdrawals wait for settlement and never exceed what's left", () => {
  assert.ok("refused" in withdrawable("running", m("10"), 0n));
  assert.match((withdrawable("settling", m("10"), 0n) as { refused: string }).refused, /open trades/);
  assert.deepEqual(withdrawable("settled", m("10"), m("4")), { amount: m("6") });
  assert.ok("refused" in withdrawable("settled", m("10"), m("10")));
});

test("carry: a settling cohort's symbol is skipped, and a SELL closes the one holder", () => {
  const held = [{ cohortId: "old", cohortStatus: "settling" as const, symbol: "BTCUSDT" }];
  assert.deepEqual(decideBuy({ symbol: "BTCUSDT", runningCohortId: "new", held }), { open: false, reason: "held by settling cohort" });
  assert.deepEqual(decideBuy({ symbol: "ETHUSDT", runningCohortId: "new", held }), { open: true, cohortId: "new" });
  assert.deepEqual(decideBuy({ symbol: "ETHUSDT", runningCohortId: null, held: [] }), { open: false, reason: "no cohort is running" });
  assert.equal(decideSell("BTCUSDT", held), "old");
  assert.equal(decideSell("SOLUSDT", held), null);
  const running = [{ cohortId: "new", cohortStatus: "running" as const, symbol: "ETHUSDT" }];
  assert.deepEqual(decideBuy({ symbol: "ETHUSDT", runningCohortId: "new", held: running }), { open: false, reason: "already holds this symbol" });
});

test("a BUY spends a share of the equity not already in trades", () => {
  assert.equal(formatMoney(buyQuote({ equity: m("1000"), openExposure: m("400"), tradePercent: m("25") })), "150.00000000");
  assert.equal(buyQuote({ equity: m("1000"), openExposure: m("1200"), tradePercent: m("25") }), 0n);
});
