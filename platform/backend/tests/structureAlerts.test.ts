/**
 * MSB-OB and Liquidity Swings: the computations both the chart and the alert
 * runner use, and the requests that arm alerts on them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describeCondition, validateCondition, type AlertCondition } from "../src/alerts/alertConditions";
import { readCondition, toColumns } from "../src/alerts/alertRequest";
import { enteredZone, liquiditySwings, marketStructure } from "../src/ta/core";

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "nearusdt-1h.json"), "utf8")) as { bars: number[][] };
const o = fx.bars.map((b) => b[1]!), h = fx.bars.map((b) => b[2]!), l = fx.bars.map((b) => b[3]!);
const c = fx.bars.map((b) => b[4]!), v = fx.bars.map((b) => b[5]!);

test("market structure alternates, and never flips back over the same two pivots", () => {
  const ms = marketStructure(o, h, l, c, 9, 0.33);
  assert.ok(ms.breaks.length >= 4, "the fixture has structure");
  for (let k = 1; k < ms.breaks.length; k++) {
    assert.notEqual(ms.breaks[k]!.direction, ms.breaks[k - 1]!.direction, "breaks alternate");
    assert.ok(ms.breaks[k]!.index - ms.breaks[k - 1]!.index > 1,
      "a break the bar after the last one is the flip-flop the script's guard prevents");
  }
  // Each break leaves an order block and a breaker block of its own side.
  assert.equal(ms.zones.length, ms.breaks.length * 2);
  for (const b of ms.breaks) {
    const made = ms.zones.filter((z) => z.created === b.index).map((z) => z.kind).sort();
    assert.deepEqual(made, b.direction === 1 ? ["bu_bb", "bu_ob"] : ["be_bb", "be_ob"]);
  }
  // The state series agrees with the breaks.
  for (const b of ms.breaks) assert.equal(ms.market[b.index], b.direction);
});

test("a zone is entered once: the next bar inside it is not another entry", () => {
  const ms = marketStructure(o, h, l, c, 9, 0.33);
  for (let i = 1; i < c.length; i++) {
    const e = enteredZone(ms, i, "any");
    if (!e) continue;
    assert.ok(ms.hits.some((x) => x.index === i && x.zoneId === e.zoneId));
    assert.ok(!ms.hits.some((x) => x.index === i - 1 && x.zoneId === e.zoneId));
  }
  assert.equal(enteredZone(ms, 0, "any"), null);
});

test("the live liquidity level is the latest swing no close has crossed", () => {
  const ls = liquiditySwings(o, h, l, c, v, 20, "full");
  const highs = ls.swings.filter((s) => s.side === "high");
  assert.ok(highs.length > 2);
  for (let i = 0; i < c.length; i++) {
    const current = [...highs].reverse().find((s) => s.confirmed < i);
    const want = current && (current.crossed === null || current.crossed >= i) ? current.level : NaN;
    assert.ok(Object.is(ls.liveHigh[i], want) || ls.liveHigh[i] === want, `bar ${i}`);
  }
  for (const s of ls.swings) {
    if (s.crossed === null) continue;
    assert.ok(s.side === "high" ? c[s.crossed]! > s.level : c[s.crossed]! < s.level, "crossed on a close beyond");
  }
  // Wick extremity: a swing high's area ends at the pivot bar's body top.
  const wick = liquiditySwings(o, h, l, c, v, 20, "wick").swings.find((s) => s.side === "high")!;
  assert.equal(wick.edge, Math.max(o[wick.x]!, c[wick.x]!));
});

test("arming each family: defaults, columns, and refusals", () => {
  const msb = readCondition("msb", { mode: "cross_up" });
  assert.ok("condition" in msb);
  const mc = (msb as { condition: AlertCondition }).condition;
  assert.deepEqual({ ...mc }, { kind: "msb", zigzagLength: 9, fibFactor: 0.33, mode: "cross_up" });
  assert.equal(describeCondition(mc), "bullish market structure break");
  const cols = toColumns(mc);
  assert.equal(cols.conditionKind, "msb");
  assert.equal(cols.msbZigzagLength, 9);
  assert.equal(cols.obZone, null);

  const ob = readCondition("order_block", { obZone: "bu_ob", msbZigzagLength: 12 });
  const oc = (ob as { condition: AlertCondition }).condition;
  assert.equal(describeCondition(oc), "price enters a bullish order block (Bu-OB) (zigzag 12, fib 0.33)");
  assert.equal(toColumns(oc).mode, "touch");
  assert.equal(validateCondition(oc), null);

  const ls = readCondition("liquidity_swing", { lsSide: "high", mode: "cross_up" });
  const lc = (ls as { condition: AlertCondition }).condition;
  assert.equal(describeCondition(lc), "crosses above the swing high liquidity level");
  assert.equal(toColumns(lc).lsArea, "full");
  assert.equal(toColumns(lc).lsLength, 20);

  for (const [kind, body] of [
    ["msb", { mode: "near_above" }], ["msb", { msbZigzagLength: 0 }], ["msb", { msbFibFactor: 2 }],
    ["order_block", { obZone: "somewhere" }],
    ["liquidity_swing", { lsSide: "middle" }], ["liquidity_swing", { lsArea: "body" }],
    ["liquidity_swing", { lsLength: 1.5 }],
  ] as const) {
    assert.ok("error" in readCondition(kind, body), `${kind} ${JSON.stringify(body)} must be refused`);
  }
});
