/**
 * Phase 2: restoring a layout's arrangement must not reload forever.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * `restoreLayoutWorkspace` answers the page's question "do I have to reload for
 * this to take effect?", because `lib/workspace.ts` reads the pane record ONCE,
 * at mount. It answered "yes" for every layout that carried a pane record at
 * all — including the layout the user left open, which `useSavedLayouts`
 * restores AT MOUNT. So a chart with a current layout restored, reloaded,
 * mounted, restored and reloaded again, about eight times a second, and never
 * finished loading. Measured on the production build at `337ef46`: 131
 * main-frame navigations in 15 seconds, no canvas ever rendered.
 *
 * `tests/savedLayoutUx.test.ts` already asserted the correct rule in prose —
 * "reloads only when the pane record changed" — but it asserted it by matching
 * source text, and the source it matched was the caller, not the answer. A
 * guard is only proven by a test that runs the code that would have looped.
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resetBrowser } from "./harness/env";
import { captureLayoutWorkspace, restoreLayoutWorkspace } from "../../lib/layoutWorkspace";
import { WORKSPACE_STORAGE_KEY } from "../../lib/workspace";

/** Exactly the shape `lib/workspace.ts` writes, in the order it writes it. */
const PANES = {
  version: 2,
  presetId: "1",
  panes: [{
    id: "p1", symbol: "SOLUSDT", interval: "15m", chartType: "candles", bars: 10_000,
    maLines: [{ type: "sma", length: 200, visible: true }],
  }],
  activePaneId: "p1",
  maximizedPaneId: null,
};

/**
 * The same workspace as the backend hands it back.
 *
 * A layout's pane record is stored in a Postgres `jsonb` column, which does not
 * preserve key order — it returns keys shortest-first. So the copy that comes
 * back is never byte-identical to the one the browser wrote, which is what
 * defeated comparing these two as text.
 */
const PANES_VIA_JSONB = {
  panes: PANES.panes.map((p) => ({
    id: p.id, bars: p.bars, symbol: p.symbol, maLines: p.maLines,
    interval: p.interval, chartType: p.chartType,
  })),
  version: PANES.version,
  presetId: PANES.presetId,
  activePaneId: PANES.activePaneId,
  maximizedPaneId: PANES.maximizedPaneId,
};

beforeEach(() => { resetBrowser(); });

test("restoring the arrangement already on screen asks for no reload", () => {
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(PANES));

  // Exactly what the mount-time restore does: capture what is stored, hand it
  // straight back. Nothing about the browser changed, so nothing needs a reload.
  const held = captureLayoutWorkspace();
  assert.equal(restoreLayoutWorkspace(held), false);

  // And it is idempotent — the loop was one restore feeding the next.
  assert.equal(restoreLayoutWorkspace(held), false);
  assert.equal(restoreLayoutWorkspace(captureLayoutWorkspace()), false);
});

test("the same workspace with jsonb's key order is still the same workspace", () => {
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(PANES));

  // Byte-different, workspace-identical. This is the real mount-time restore:
  // the browser wrote one order, the backend returned another, and answering
  // "changed" here is what reloaded the page into its own restore forever.
  assert.notEqual(JSON.stringify(PANES_VIA_JSONB), JSON.stringify(PANES));
  assert.equal(
    restoreLayoutWorkspace({ panes: PANES_VIA_JSONB, studies: {}, drawings: {} }), false);

  // Still settled once the reordered copy is the one in storage.
  assert.equal(
    restoreLayoutWorkspace({ panes: PANES, studies: {}, drawings: {} }), false);
});

test("restoring a different arrangement does ask for a reload", () => {
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(PANES));

  const other = {
    panes: {
      version: 2,
      presetId: "2-cols",
      panes: [
        PANES.panes[0],
        {
          id: "p2", symbol: "BTCUSDT", interval: "1h", chartType: "candles", bars: 10_000,
          maLines: [{ type: "sma", length: 200, visible: true }],
        },
      ],
      activePaneId: "p2",
      maximizedPaneId: null,
    },
    studies: {},
    drawings: {},
  };

  assert.equal(restoreLayoutWorkspace(other), true);
  // The record is now written, so the same layout a second time is settled:
  // one reload, not a stream of them.
  assert.equal(restoreLayoutWorkspace(other), false);
  assert.equal(window.localStorage.getItem(WORKSPACE_STORAGE_KEY),
    JSON.stringify(other.panes));
});

test("a layout that carries no pane record never asks for a reload", () => {
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(PANES));

  assert.equal(restoreLayoutWorkspace(undefined), false);
  assert.equal(restoreLayoutWorkspace({ panes: null, studies: {}, drawings: {} }), false);
  // A pre-TVP8 layout must not disturb the arrangement the browser is showing.
  assert.equal(window.localStorage.getItem(WORKSPACE_STORAGE_KEY), JSON.stringify(PANES));
});


/**
 * The other half of the same defect, at the call seam.
 *
 * Comparing the records is not enough on its own: at mount the two genuinely
 * DIFFER whenever the user changed anything without saving — a comparison
 * added, a study, a second pane. The page persists that live arrangement to
 * the same key as it renders, so the saved record and the live one disagree on
 * every load, the restore asks for a reload every time, and the page reloads
 * into the same disagreement. Reproduced on the production build after adding
 * one comparison: 105 main-frame navigations in 12 seconds.
 *
 * So the arrangement is only applied when the user OPENS a layout. At mount,
 * the browser's own stores already hold what they left open — that is what
 * those stores are for — and re-applying the saved copy over them would
 * discard the unsaved work as well as loop.
 */
const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("only a user-opened layout applies its arrangement, and only it can reload", () => {
  const hook = read("lib/useSavedLayouts.ts");
  // The two callers are told apart at the seam, not guessed at downstream.
  assert.match(hook, /applyLayout: \(state: WorkspaceState, how: "open" \| "restore"\) => void;/);
  // Mount restore.
  assert.match(hook, /applyLayout\(l, "restore"\);/);
  // Menu open.
  assert.match(hook, /applyLayout\(l, "open"\);/);

  const page = read("app/chart/page.tsx");
  // The arrangement write AND the reload are both behind the same gate, so a
  // restore can neither clobber the live stores nor ask for a reload.
  assert.match(page, /const panesRestored = how === "open" && restoreLayoutWorkspace\(s\.workspace\);/);
  assert.match(page, /if \(panesRestored\) window\.location\.reload\(\);/);
});
