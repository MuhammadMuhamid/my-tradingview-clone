/**
 * The study stack comes back the way it was arranged (B-09, B-15).
 *
 * A comparison pane added LAST reloaded into the FIRST slot, because order was
 * whatever order the panes' data happened to be assembled in, and dragged pane
 * heights were forgotten because they lived only in component state. The
 * arrangement is now persisted with the pane; these are the two pure halves —
 * applying a saved arrangement as panes arrive, and writing one back without
 * forgetting a pane that has not arrived yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_PANE_LAYOUT, reconcilePaneLayout, savedPaneLayout, setPaneHeight,
  type PaneLayoutState,
} from "../lib/indicatorPaneLayout";

const SAVED = { order: ["atr", "rsi", "compare"], heights: { rsi: 180 } };

test("B-09 — panes arriving in any order take their saved places", () => {
  // The comparison's data lands first on a reload: it is assembled first.
  let state: PaneLayoutState = reconcilePaneLayout(EMPTY_PANE_LAYOUT, ["compare"], SAVED);
  assert.deepEqual(state.order, ["compare"]);
  state = reconcilePaneLayout(state, ["compare", "atr", "rsi"], SAVED);
  assert.deepEqual(state.order, ["atr", "rsi", "compare"],
    "the comparison added last came back first");
});

test("B-09 — a pane the saved arrangement never saw keeps its arrival place", () => {
  const state = reconcilePaneLayout(EMPTY_PANE_LAYOUT, ["macd", "compare", "atr"], SAVED);
  // atr and compare are ranked; macd is not and stays where it arrived.
  assert.deepEqual(state.order, ["macd", "atr", "compare"]);
});

test("B-15 — a saved height is applied to the pane when it arrives", () => {
  const state = reconcilePaneLayout(EMPTY_PANE_LAYOUT, ["atr", "rsi"], SAVED);
  assert.deepEqual(state.heights, { rsi: 180 });
});

test("without a saved arrangement nothing changes", () => {
  const state = reconcilePaneLayout(EMPTY_PANE_LAYOUT, ["compare", "atr"]);
  assert.deepEqual(state.order, ["compare", "atr"]);
  assert.equal(reconcilePaneLayout(state, ["compare", "atr"], null), state,
    "an unchanged layout must be the same object, or the effect loops");
});

test("writing back never forgets a pane that has not arrived yet", () => {
  // Mid-reload: only the comparison is on screen.
  const partial = reconcilePaneLayout(EMPTY_PANE_LAYOUT, ["compare"], SAVED);
  assert.deepEqual(savedPaneLayout(partial, SAVED), SAVED,
    "a partial stack overwrote the saved order and lost the studies' places");
});

test("writing back records a move, a new pane and a dragged height", () => {
  let state = reconcilePaneLayout(EMPTY_PANE_LAYOUT, ["atr", "rsi"], null);
  state = reconcilePaneLayout(state, ["atr", "rsi", "compare"], null);
  state = setPaneHeight(state, "atr", 150);
  assert.deepEqual(savedPaneLayout(state, null), {
    order: ["atr", "rsi", "compare"], heights: { atr: 150 },
  });
  // A pane the user removed keeps a harmless rank, after its old neighbour.
  const removed = reconcilePaneLayout(state, ["atr", "compare"], null);
  assert.deepEqual(savedPaneLayout(removed, { order: ["atr", "rsi", "compare"], heights: {} }).order,
    ["atr", "rsi", "compare"]);
});
