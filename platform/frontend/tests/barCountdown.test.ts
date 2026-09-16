/**
 * TVP8 F-03: the bar-close countdown cannot fall behind the price chip.
 *
 * ── The defect, stated as an arithmetic property ───────────────────────────
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
 * The repair moves the label into `priceAxisViews()`, which the library calls
 * during its own update. The property that makes the defect impossible is
 * therefore a LIVENESS one, and it is what these tests hold: `coordinate()`
 * asks the series at CALL time and caches nothing, so a scale that moved
 * between two calls moves the label with it — with no render in between.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BarCountdownPrimitive, countdownText } from "../lib/barCountdown";

/** A series whose price scale can be moved between calls, as a resize moves it. */
function fakeSeries(): { series: unknown; setCoordinate: (y: number | null) => void; calls: number } {
  const state = { y: 100 as number | null, calls: 0 };
  return {
    series: {
      priceToCoordinate: (_price: number) => { state.calls += 1; return state.y; },
    },
    setCoordinate: (y: number | null) => { state.y = y; },
    get calls() { return state.calls; },
  };
}

function attached(): {
  primitive: BarCountdownPrimitive;
  view: { coordinate(): number; text(): string; visible?(): boolean; backColor(): string };
  setCoordinate: (y: number | null) => void;
  updates: number;
} {
  const primitive = new BarCountdownPrimitive();
  const fake = fakeSeries();
  let updates = 0;
  (primitive as unknown as {
    attached(p: { series: unknown; requestUpdate: () => void }): void;
  }).attached({ series: fake.series, requestUpdate: () => { updates += 1; } });
  const view = primitive.priceAxisViews()[0]!;
  return {
    primitive, view: view as never, setCoordinate: fake.setCoordinate,
    get updates() { return updates; },
  };
}

test("F-03 — the label's coordinate is read from the series on every call", () => {
  const { primitive, view, setCoordinate } = attached();
  primitive.update({ price: 100, text: "00:05:00", backColor: "#22ab94", textColor: "#fff" });

  const before = view.coordinate();
  // What a pane insertion does: the container shrinks and the scale re-maps.
  setCoordinate(60);
  const after = view.coordinate();

  assert.notEqual(before, after,
    "the coordinate was cached — which is exactly how the span fell behind the chip");
  assert.equal(after - 60, before - 100,
    "and it tracks the chip's own price by a fixed offset, not by arithmetic of its own");
});

test("F-03 — the label sits BELOW the chip, never on it", () => {
  const { primitive, view, setCoordinate } = attached();
  primitive.update({ price: 100, text: "00:05:00", backColor: "#22ab94", textColor: "#fff" });
  setCoordinate(200);
  assert.ok(view.coordinate() > 200,
    "a countdown at or above the chip's own coordinate is the overlap this fixes");
});

test("F-03 — the label is drawn off-screen rather than at 0 when there is nothing to place", () => {
  /*
   * A large negative coordinate is the library's own convention for "I have no
   * label here". Zero would be the TOP of the price axis, which is a countdown
   * pinned to the highest price on the chart.
   */
  const { primitive, view, setCoordinate } = attached();
  primitive.update({ price: null, text: null, backColor: "#000", textColor: "#fff" });
  assert.ok(view.coordinate() < 0);
  assert.equal(view.visible?.(), false, "and it says it is not visible");

  primitive.update({ price: 100, text: "00:00:30", backColor: "#000", textColor: "#fff" });
  setCoordinate(null);
  assert.ok(view.coordinate() < 0, "a price off the visible scale has no label either");
});

test("F-03 — the setting turning the countdown off turns the LABEL off", () => {
  const { primitive, view } = attached();
  primitive.update({ price: 100, text: "00:05:00", backColor: "#000", textColor: "#fff" });
  assert.equal(view.visible?.(), true);
  // `Chart settings › Scales and lines › Countdown to bar close`.
  primitive.update({ price: 100, text: null, backColor: "#000", textColor: "#fff" });
  assert.equal(view.visible?.(), false);
});

test("F-03 — a changed label asks the chart to repaint; an unchanged one does not", () => {
  /*
   * The text ticks once a second with no data behind it, so something has to
   * ask the library to redraw. Asking on every update — including the ones
   * where nothing changed — is a repaint per second per pane for nothing.
   */
  const state = attached();
  state.primitive.update({ price: 100, text: "00:05:00", backColor: "#000", textColor: "#fff" });
  const afterFirst = state.updates;
  assert.ok(afterFirst >= 1);
  state.primitive.update({ price: 100, text: "00:05:00", backColor: "#000", textColor: "#fff" });
  assert.equal(state.updates, afterFirst, "an identical update repainted anyway");
  state.primitive.update({ price: 100, text: "00:04:59", backColor: "#000", textColor: "#fff" });
  assert.equal(state.updates, afterFirst + 1);
});

test("F-03 — the views array is stable, because the library caches on its identity", () => {
  const primitive = new BarCountdownPrimitive();
  assert.equal(primitive.priceAxisViews(), primitive.priceAxisViews(),
    "a fresh array every frame defeats the library's own cache");
});

test("F-03 — the text is unchanged: hh:mm:ss, and never negative", () => {
  assert.equal(countdownText(5 * 60_000 + 45_000), "00:05:45");
  assert.equal(countdownText(3 * 3_600_000 + 61_000), "03:01:01");
  assert.equal(countdownText(-1), "00:00:00", "a bar that has closed counts down to zero");
});
