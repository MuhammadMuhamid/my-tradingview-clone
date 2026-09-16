/**
 * TVP8 F-03 / F-03-R: the last-price plate is ONE plate.
 *
 * ── F-03, the original defect, stated as an arithmetic property ────────────
 *
 * The countdown was a DOM span whose `top` was computed during React's render
 * from `series.priceToCoordinate(close)` and recomputed only when the
 * component re-rendered — once a second, off the clock that changes the TEXT.
 * The chip is placed by the library when IT paints. Two answers to one
 * question: insert a study pane, the chart's container shrinks, and until a
 * render happens that agrees with the new geometry the span sits at the old
 * coordinate. Measured: the countdown's own 58px plate on top of the chip,
 * hiding all but its first digit, and staying there until reload.
 *
 * The property that makes that impossible is a LIVENESS one, and it is what
 * these tests hold: the plate's coordinate is asked of the series at DRAW
 * time and cached nowhere, so a scale that moved between two draws moves the
 * plate with it, with no render in between.
 *
 * ── F-03-R, the residual, stated as two equalities ─────────────────────────
 *
 * That left the price to the library's own chip and the countdown to a label
 * of ours, and the two never agreed: the chip took `priceLineColor` (slate),
 * the countdown took the bar's direction (red or green), and each sized its
 * plate to its own text, so the countdown overhung the price by 19px. Both
 * rows are now one rect drawn by this primitive. The properties are that the
 * rows report the SAME ground and share the rect's edges — held here rather
 * than by a screenshot.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BarCountdownPrimitive, chipBackColor, chipTextColor, countdownText, platePlan,
} from "../lib/barCountdown";

/* ── a price axis, modelled closely enough to place a plate ──────────────── */

const FONT_SIZE = 12;
/** `12px` sans advances, as the running chart measured them. */
const ADVANCE: Record<string, number> = {
  "0": 7.559, "1": 5.559, ".": 3.563, ":": 3.563, "-": 4.518, ",": 3.563, "%": 12.076, " ": 3.375,
};
function measure(text: string): number {
  let width = 0;
  for (const char of text) width += ADVANCE[char] ?? 6.67;
  return width;
}

/** `PriceAxisViewRenderer.height`: one row of a plate. */
const ROW_HEIGHT = FONT_SIZE + 2 * ((2.5 / 12) * FONT_SIZE);

/* ── the chart the primitive is attached to ──────────────────────────────── */

interface Fake {
  primitive: BarCountdownPrimitive;
  plan: () => ReturnType<typeof platePlan>;
  setCoordinate: (y: number | null) => void;
  setVisibleTo: (index: number) => void;
  updates: number;
}

/** A series whose price scale can be moved between calls, as a resize moves it. */
function attach(bars: { close: number }[] = [{ close: 98.14 }]): Fake {
  const state = { y: 100 as number | null, to: bars.length - 1 };
  const series = {
    priceToCoordinate: (_price: number) => state.y,
    priceFormatter: () => ({ format: (price: number) => price.toFixed(2) }),
    dataByIndex: (index: number) => bars[Math.max(0, Math.min(index, bars.length - 1))] ?? null,
  };
  const chart = {
    options: () => ({ layout: { fontSize: FONT_SIZE, fontFamily: "sans-serif" } }),
    timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 0, to: state.to }) }),
  };
  const primitive = new BarCountdownPrimitive();
  let updates = 0;
  (primitive as unknown as {
    attached(p: { series: unknown; chart: unknown; requestUpdate: () => void }): void;
  }).attached({ series, chart, requestUpdate: () => { updates += 1; } });
  return {
    primitive,
    // What `draw` does, with the canvas's own ruler replaced by a modelled one.
    plan: () => {
      const y = primitive.anchor();
      return y === null ? null : platePlan(primitive.rowTexts(), y, FONT_SIZE, measure);
    },
    setCoordinate: (y) => { state.y = y; },
    setVisibleTo: (index) => { state.to = index; },
    get updates() { return updates; },
  };
}

const PLATE = {
  price: 98.14, text: "00:03:20", backColor: "#758696", textColor: "white", ownsPriceRow: true,
} as const;

/* ── F-03: the liveness the repair bought ────────────────────────────────── */

test("F-03 — the plate's coordinate is read from the series on every draw", () => {
  const fake = attach();
  fake.primitive.update({ ...PLATE });

  const before = fake.plan()!;
  // What a pane insertion does: the container shrinks and the scale re-maps.
  fake.setCoordinate(60);
  const after = fake.plan()!;

  assert.notEqual(before.top, after.top,
    "the coordinate was cached — which is exactly how the span fell behind the chip");
  assert.equal(after.rows[0]!.centreY, 60, "the price row sits on its own price");
  assert.equal(before.rows[0]!.centreY, 100);
});

test("F-03 — the countdown row sits BELOW the price row, never on it", () => {
  const fake = attach();
  fake.primitive.update({ ...PLATE });
  const plan = fake.plan()!;
  assert.equal(plan.rows.length, 2);
  assert.ok(plan.rows[1]!.centreY > plan.rows[0]!.centreY,
    "a countdown at or above the price's own coordinate is the overlap this fixes");
  assert.equal(plan.rows[1]!.centreY - plan.rows[0]!.centreY, ROW_HEIGHT,
    "and exactly one label height below it, which is how the library packs labels");
});

test("F-03 — nothing is drawn when there is nothing to place", () => {
  const fake = attach([]);
  fake.primitive.update({ ...PLATE, price: null, text: null, ownsPriceRow: false });
  assert.equal(fake.plan(), null);

  fake.primitive.update({ ...PLATE, price: 100, text: "00:00:30" });
  fake.setCoordinate(null);
  assert.equal(fake.plan(), null, "a price off the visible scale has no plate either");
});

test("F-03 — the setting turning the countdown off turns the ROW off", () => {
  const fake = attach();
  fake.primitive.update({ ...PLATE });
  assert.equal(fake.plan()!.rows.length, 2);
  /*
   * `Chart settings › Scales and lines › Countdown to bar close`. The chart
   * hands the price back to the series' own chip in the same breath, so the
   * primitive draws nothing at all rather than a second price.
   */
  fake.primitive.update({ ...PLATE, text: null, ownsPriceRow: false });
  assert.equal(fake.plan(), null);
});

test("F-03 — a changed plate asks the chart to repaint; an unchanged one does not", () => {
  /*
   * The text ticks once a second with no data behind it, so something has to
   * ask the library to redraw. Asking on every update — including the ones
   * where nothing changed — is a repaint per second per pane for nothing.
   */
  const fake = attach();
  fake.primitive.update({ ...PLATE });
  const afterFirst = fake.updates;
  assert.ok(afterFirst >= 1);
  fake.primitive.update({ ...PLATE });
  assert.equal(fake.updates, afterFirst, "an identical update repainted anyway");
  fake.primitive.update({ ...PLATE, text: "00:03:19" });
  assert.equal(fake.updates, afterFirst + 1);
});

test("F-03 — the views array is stable, because the library caches on its identity", () => {
  const primitive = new BarCountdownPrimitive();
  assert.equal(primitive.priceAxisPaneViews(), primitive.priceAxisPaneViews(),
    "a fresh array every frame defeats the library's own cache");
  assert.equal(primitive.priceAxisPaneViews().length, 1, "one plate, one view");
});

test("F-03 — the text is unchanged: hh:mm:ss, and never negative", () => {
  assert.equal(countdownText(5 * 60_000 + 45_000), "00:05:45");
  assert.equal(countdownText(3 * 3_600_000 + 61_000), "03:01:01");
  assert.equal(countdownText(-1), "00:00:00", "a bar that has closed counts down to zero");
});

/* ── F-03-R: one ground, one width, one plate ────────────────────────────── */

test("F-03-R — both rows are painted on the same ground, up bar and down bar", () => {
  /*
   * The defect was a slate price over a bar-direction countdown: red under
   * slate on a down bar, green under slate on an up bar, never the same. The
   * chip's colour is `priceLineColor || lastBarColor`, so with the setting at
   * its default both bar directions give ONE value — and whatever the value,
   * one rect can only be painted in one of them.
   */
  const slate = "#758696";
  assert.equal(chipBackColor(slate, "#f6465d"), slate, "a down bar cannot redden the plate");
  assert.equal(chipBackColor(slate, "#2ebd85"), slate, "an up bar cannot green it");
  assert.equal(chipBackColor("", "#f6465d"), "#f6465d",
    "and with no line colour the library's own fallback is the bar's");
});

test("F-03-R — the ink is the one the library would contrast onto that ground", () => {
  // `generateContrastColors`: grayscale > 160 is black, else white.
  assert.equal(chipTextColor("#758696"), "white");
  assert.equal(chipTextColor("#f6465d"), "white");
  assert.equal(chipTextColor("#ffffff"), "black");
  assert.equal(chipTextColor("#e8f0d8"), "black");
  assert.equal(chipTextColor("rgb(117, 134, 150)"), "white");
  assert.equal(chipTextColor("#fff"), "black", "short hex reads the same as long");
});

test("F-03-R — the rows share the plate's left and right edges exactly", () => {
  /*
   * The acceptance, as geometry: left edges and right edges within a pixel of
   * each other. One rect makes that zero for every pair of strings there is —
   * the wider row sets the width and the narrower cannot reach past it.
   */
  const prices = [
    "98.14", "0.00001234", "112450.5", "1.0", "4", "2,401.5", "-0.25", "19.875",
    "10.901", "2399.49", "0.19290", "719.89", "75968", "123456.78",
  ];
  const countdowns = ["00:03:20", "00:00:09", "23:59:59", "01:00:00", "00:14:57"];
  for (const price of prices) {
    for (const countdown of countdowns) {
      const plan = platePlan([price, countdown], 300, FONT_SIZE, measure)!;
      assert.equal(plan.rows.length, 2);
      assert.equal(plan.left, 0, "both rows start at the axis's own edge");
      const widest = Math.max(measure(price), measure(countdown));
      assert.ok(plan.right >= plan.textX + widest,
        `${JSON.stringify(price)} over ${JSON.stringify(countdown)} clips the wider row`);
    }
  }
});

test("F-03-R — the plate is the wider row's width, whichever row that is", () => {
  const short = platePlan(["1.0", "00:03:20"], 300, FONT_SIZE, measure)!;
  const long = platePlan(["123456.78", "00:03:20"], 300, FONT_SIZE, measure)!;
  assert.ok(long.right > short.right, "a long price widens the plate");
  assert.equal(short.right, platePlan(["00:03:20"], 300, FONT_SIZE, measure)!.right,
    "a price narrower than the countdown leaves the countdown setting the width");
});

test("F-03-R — the rows are one column, and the tick is on the price", () => {
  const plan = platePlan(["98.14", "00:03:20"], 300, FONT_SIZE, measure)!;
  assert.equal(plan.textX, 5 + 5, "tick plus the inner padding, as the library lays a label out");
  assert.equal(plan.tickY, 300, "the tick points at the price, not at the countdown");
});

test("F-03-R — the plate keeps the accepted vertical geometry", () => {
  /*
   * ~38px for the pair, the price row's middle still exactly on its price, and
   * no seam: one rect cannot have a line of axis background across it.
   */
  const plan = platePlan(["98.14", "00:03:20"], 300, FONT_SIZE, measure)!;
  assert.equal(plan.rows[0]!.centreY, 300);
  assert.ok(Math.abs((plan.bottom - plan.top) - 38) <= 1,
    `the pair is ${plan.bottom - plan.top}px, and 37-38 is what was accepted`);
  assert.ok(plan.top < 300 && plan.bottom > plan.rows[1]!.centreY,
    "both rows are inside the one rect");
});

test("F-03-R — one row alone is a normal single-line chip", () => {
  // `Price label` off, countdown on: one row, and a plate one row tall.
  const one = platePlan(["00:03:20"], 300, FONT_SIZE, measure)!;
  const two = platePlan(["98.14", "00:03:20"], 300, FONT_SIZE, measure)!;
  assert.equal(one.rows.length, 1);
  assert.ok((one.bottom - one.top) < (two.bottom - two.top) / 1.5);
  assert.equal(one.left, two.left);
});

test("F-03-R — the price row is the last VISIBLE bar's close, as the chip was", () => {
  /*
   * `SeriesPriceAxisView` reads `lastValueData(false)` — the last bar inside
   * the visible range, not the last bar there is. Panning back moved the
   * library's chip; taking the chip over has to move ours the same way.
   */
  const fake = attach([{ close: 90 }, { close: 95 }, { close: 98.14 }]);
  fake.primitive.update({ ...PLATE });
  assert.equal(fake.plan()!.rows[0]!.text, "98.14");
  fake.setVisibleTo(1);
  assert.equal(fake.plan()!.rows[0]!.text, "95.00", "the chip did not follow the pan");
});

test("F-03-R — the price row falls back to the close React handed it", () => {
  // No chart, so no visible range to read: the fallback is the last candle.
  const primitive = new BarCountdownPrimitive();
  (primitive as unknown as {
    attached(p: { series: unknown; requestUpdate: () => void }): void;
  }).attached({
    series: {
      priceToCoordinate: () => 120,
      priceFormatter: () => ({ format: (price: number) => price.toFixed(2) }),
    },
    requestUpdate: () => { /* nothing to repaint in this test */ },
  });
  primitive.update({ ...PLATE, price: 42.5 });
  assert.deepEqual(primitive.rowTexts(), ["42.50", "00:03:20"]);
  assert.equal(primitive.anchor(), 120);
});
