/**
 * Paper (simulation) mode.
 *
 * The platform had two delivery modes that touch money and one that does
 * nothing at all. There was no way to run a deployment forward on live bars and
 * see what it WOULD have done — which is what the selection pipeline's own
 * emitted metadata demands before a configuration is armed: *"forward/paper
 * validation is mandatory"* (`OPT-01`).
 *
 * The simulator is a pure function, so everything about its arithmetic is
 * testable without a database. What it must NOT be able to do is covered in
 * `tests/paperIsolation.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPaperSignal, FLAT, PAPER_COMMISSION_PCT, summarisePaper,
  type PaperFill, type PaperPosition,
} from "../src/engine/paperBroker";
import { deliversLiveOrders, type DeliveryMode } from "../src/types/deployments";

const BAR = Date.UTC(2026, 7, 24, 12, 0, 0);
const buy = (over = {}) => ({ action: "buy" as const, price: 100, barTime: BAR, buyQuoteQty: 1000, ...over });
const sell = (over = {}) => ({ action: "sell" as const, price: 110, barTime: BAR + 900_000, buyQuoteQty: 0, ...over });

function fillOrThrow(position: PaperPosition, signal: Parameters<typeof applyPaperSignal>[1]): PaperFill {
  const out = applyPaperSignal(position, signal);
  assert.ok(out.filled, out.filled ? "" : out.reason);
  return out.fill;
}

// ── What paper mode IS ──────────────────────────────────────────────────────

test("`paper` is a delivery mode, and it is not a live one", () => {
  const modes: DeliveryMode[] = ["3commas", "custom", "off", "paper"];
  assert.deepEqual(modes.filter(deliversLiveOrders), ["3commas", "custom"]);
  assert.equal(deliversLiveOrders("paper"), false);
  assert.equal(deliversLiveOrders("off"), false);
});

// ── Fills ───────────────────────────────────────────────────────────────────

test("a buy spends the configured quote and carries the fee in the cost basis", () => {
  const fill = fillOrThrow(FLAT, buy());
  assert.equal(fill.quote, 1000);
  assert.equal(fill.commission, 1);                 // 0.1 % of 1000
  assert.equal(fill.qty, 10);                       // 1000 / 100
  assert.equal(fill.positionAfter.costBasis, 1001); // so the sell's P&L is net of BOTH sides
  assert.equal(fill.positionAfter.entryPrice, 100);
  assert.equal(fill.realisedPnl, null, "a buy realises nothing");
});

test("A FULL SELL'S P&L IS NET OF BOTH SIDES' COMMISSION", () => {
  const entry = fillOrThrow(FLAT, buy());
  const exit = fillOrThrow(entry.positionAfter, sell());
  assert.equal(exit.quote, 1100);
  assert.equal(exit.commission, 1.1);
  // 1100 gross − 1.1 sell fee − 1001 basis (1000 + 1 buy fee) = 97.9
  assert.ok(Math.abs(exit.realisedPnl! - 97.9) < 1e-9, `${exit.realisedPnl}`);
  assert.deepEqual(exit.positionAfter, FLAT);
});

test("the cost model is the LIVE one, not a friendlier one", () => {
  // X-09: a paper run at zero fees flatters a configuration exactly where it
  // matters least. 0.1 % per side is what every research tree runs.
  assert.equal(PAPER_COMMISSION_PCT, 0.1);
  // The exact case from BE-15: a +0.03 % gross exit is a LOSS after costs.
  const entry = fillOrThrow(FLAT, buy({ price: 100 }));
  const exit = fillOrThrow(entry.positionAfter, sell({ price: 100.03 }));
  assert.ok(exit.realisedPnl! < 0, `expected a net loss, got ${exit.realisedPnl}`);
});

test("a partial sell releases a proportional basis and leaves the rest open", () => {
  const entry = fillOrThrow(FLAT, buy());
  const partial = fillOrThrow(entry.positionAfter, sell({ sellPercent: 40 }));
  assert.ok(Math.abs(partial.qty - 4) < 1e-12);
  assert.ok(Math.abs(partial.positionAfter.qty - 6) < 1e-12);
  assert.ok(Math.abs(partial.positionAfter.costBasis - 1001 * 0.6) < 1e-9);
  assert.equal(partial.positionAfter.entryPrice, 100, "the entry price survives a partial");
  // 440 gross − 0.44 fee − 400.4 basis
  assert.ok(Math.abs(partial.realisedPnl! - 39.16) < 1e-9, `${partial.realisedPnl}`);
});

test("selling the remainder in two partials equals selling it once", () => {
  const entry = fillOrThrow(FLAT, buy()).positionAfter;
  const oneShot = fillOrThrow(entry, sell()).realisedPnl!;
  const first = fillOrThrow(entry, sell({ sellPercent: 50 }));
  const second = fillOrThrow(first.positionAfter, sell({ sellPercent: 100 }));
  assert.ok(Math.abs(first.realisedPnl! + second.realisedPnl! - oneShot) < 1e-9);
  assert.deepEqual(second.positionAfter, FLAT);
});

test("float residue does not leave a position that can never be closed", () => {
  let position = fillOrThrow(FLAT, buy({ buyQuoteQty: 333.33, price: 7.77 })).positionAfter;
  for (const pct of [33, 33, 34, 100]) {
    const out = applyPaperSignal(position, sell({ sellPercent: pct }));
    if (out.filled) position = out.fill.positionAfter;
  }
  assert.deepEqual(position, FLAT);
});

// ── Refusals are explicit ───────────────────────────────────────────────────

test("a sell with nothing held is REFUSED, not silently ignored", () => {
  const out = applyPaperSignal(FLAT, sell());
  assert.equal(out.filled, false);
  assert.match(out.filled ? "" : out.reason, /nothing held/);
});

test("a second buy while long is refused, because the live path does not average in", () => {
  const position = fillOrThrow(FLAT, buy()).positionAfter;
  const out = applyPaperSignal(position, buy());
  assert.equal(out.filled, false);
  assert.match(out.filled ? "" : out.reason, /already long/);
  assert.deepEqual(out.filled ? null : out.positionAfter, position, "the position is untouched");
});

test("a nonsensical price or size is refused rather than booked", () => {
  for (const price of [0, -1, NaN, Infinity]) {
    assert.equal(applyPaperSignal(FLAT, buy({ price })).filled, false, `price ${price}`);
  }
  for (const buyQuoteQty of [0, -5, NaN]) {
    assert.equal(applyPaperSignal(FLAT, buy({ buyQuoteQty })).filled, false, `size ${buyQuoteQty}`);
  }
  const long = fillOrThrow(FLAT, buy()).positionAfter;
  for (const sellPercent of [0, -1, 101, NaN]) {
    assert.equal(applyPaperSignal(long, sell({ sellPercent })).filled, false, `pct ${sellPercent}`);
  }
});

// ── The summary an operator reads ───────────────────────────────────────────

test("the summary totals realised P&L, commission and the open position", () => {
  const a = fillOrThrow(FLAT, buy());
  const b = fillOrThrow(a.positionAfter, sell());
  const c = fillOrThrow(FLAT, buy({ price: 50, barTime: BAR + 1_800_000 }));
  const summary = summarisePaper([a, b, c], { markPrice: 55 });
  assert.equal(summary.fills, 3);
  assert.equal(summary.buys, 2);
  assert.equal(summary.sells, 1);
  assert.ok(Math.abs(summary.realisedPnl - 97.9) < 1e-9);
  assert.ok(Math.abs(summary.commissionPaid - (1 + 1.1 + 1)) < 1e-9);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 0);
  assert.equal(summary.winRatePct, 100);
  assert.ok(Math.abs(summary.openPosition.qty - 20) < 1e-12);
  // 20 × 55 = 1100 gross, −1.1 fee, −1001 basis
  assert.ok(Math.abs(summary.unrealisedPnl! - 97.9) < 1e-9, `${summary.unrealisedPnl}`);
});

test("with nothing realised the win rate is null, not zero", () => {
  const summary = summarisePaper([fillOrThrow(FLAT, buy())]);
  assert.equal(summary.winRatePct, null);
  assert.equal(summary.unrealisedPnl, null, "no mark price, no unrealised figure");
});

test("a scratch is neither a win nor a loss", () => {
  // BE-10: the backtest counts an exact-zero trade as a LOSS, and that
  // difference lives behind the `zeroPnlIsScratch` correction rather than being
  // silently resolved one way here and another way there.
  const scratch: PaperFill = {
    action: "sell", barTime: BAR, price: 100, qty: 1, quote: 100, commission: 0.1,
    realisedPnl: 0, positionAfter: { ...FLAT },
  };
  const summary = summarisePaper([scratch]);
  assert.equal(summary.wins, 0);
  assert.equal(summary.losses, 0);
  assert.equal(summary.winRatePct, null);
});

test("an empty run summarises to zeroes and a flat position", () => {
  const summary = summarisePaper([]);
  assert.equal(summary.fills, 0);
  assert.equal(summary.realisedPnl, 0);
  assert.deepEqual(summary.openPosition, FLAT);
});
