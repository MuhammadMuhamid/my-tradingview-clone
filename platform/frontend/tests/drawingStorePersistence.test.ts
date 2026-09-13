/**
 * The drawing store, against a disk that has lied to it.
 *
 * ── What `readStore` used to be ────────────────────────────────────────────
 *
 *   return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store;
 *
 * An unchecked cast on a value that comes from the user's own disk. Nothing
 * downstream re-checks the SHAPE, and `saveDrawings` reads that value, assigns
 * one symbol's list into it, and writes the whole thing back — so anything
 * that is not a plain object destroys every OTHER symbol's drawings:
 *
 *   stored `null`  →  `delete store[key]` throws, taking the save with it
 *   stored `5`     →  `store[key] = …` is swallowed, and `5` is written back
 *   stored `[]`    →  the symbol becomes an array INDEX, and `JSON.stringify`
 *                     writes an array with a named property, which parses back
 *                     as `[]` — every drawing on every symbol, gone
 *
 * None of this needs a malicious actor. A truncated write during a crash
 * produces the first, and a future build that stores an array under this key
 * produces the third.
 *
 * ── And the thing the fix must NOT do ──────────────────────────────────────
 *
 * The obvious repair is to validate everything on the way through. That would
 * be worse than the bug. `isValidDrawing` rejects any tool THIS build does not
 * know, so filtering inside `saveDrawings` means an older build permanently
 * deletes a drawing made by a newer one — silently, as a side effect of the
 * user saving something else on a different symbol. Validation belongs where
 * drawings are RENDERED, where rejecting one costs a frame rather than the
 * drawing.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadDrawings, saveDrawings, type Drawing } from "../lib/drawings";

const KEY = "srtrend.drawings.v2";

/** A minimal in-memory `localStorage`, installed as the global `window`. */
function installStorage(seed: string | null): Map<string, string> {
  const cells = new Map<string, string>();
  if (seed !== null) cells.set(KEY, seed);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => cells.get(k) ?? null,
        setItem: (k: string, v: string) => { cells.set(k, v); },
        removeItem: (k: string) => { cells.delete(k); },
      },
    },
  });
  return cells;
}

const drawing = (id: string): Drawing => ({
  id, tool: "trend",
  points: [{ time: 1_700_000_000, price: 100 }, { time: 1_700_003_600, price: 110 }],
  style: { color: "#2962ff", width: 2 },
});

beforeEach(() => { Reflect.deleteProperty(globalThis, "window"); });

test("A MALFORMED STORE COSTS ONE SYMBOL, NEVER ALL OF THEM", () => {
  for (const corrupt of ["null", "5", '"a string"', "[]", '[{"id":"x"}]', "true"]) {
    const cells = installStorage(corrupt);

    // The read is empty rather than a throw or the raw value.
    assert.deepEqual(loadDrawings("BTCUSDT"), [],
      `a stored ${corrupt} must read as no drawings`);

    // And a save lands, rather than throwing or writing the corruption back.
    saveDrawings("BTCUSDT", [drawing("a")]);
    const written: unknown = JSON.parse(cells.get(KEY)!);
    assert.equal(Object.prototype.toString.call(written), "[object Object]",
      `saving over a stored ${corrupt} wrote a ${typeof written}`);
    assert.equal(loadDrawings("BTCUSDT").length, 1);
  }
  Reflect.deleteProperty(globalThis, "window");
});

test("ONE SYMBOL'S RUBBISH DOES NOT REACH ANOTHER SYMBOL'S SAVE", () => {
  const cells = installStorage(JSON.stringify({
    BTCUSDT: [drawing("keep")],
    SOLUSDT: "not a list at all",
  }));

  saveDrawings("ETHUSDT", [drawing("new")]);

  const written = JSON.parse(cells.get(KEY)!) as Record<string, unknown>;
  assert.equal(Array.isArray(written.BTCUSDT), true, "an untouched symbol keeps its drawings");
  assert.equal((written.BTCUSDT as unknown[]).length, 1);
  assert.equal("SOLUSDT" in written, false,
    "a value nothing can read is dropped rather than written back");
  assert.equal(Array.isArray(written.ETHUSDT), true);
  Reflect.deleteProperty(globalThis, "window");
});

test("AN OLDER BUILD DOES NOT DELETE A NEWER BUILD'S DRAWING", () => {
  /*
   * The whole reason `saveDrawings` does not validate. `futureTool` is what a
   * drawing made by a later build looks like from here: a perfectly well-formed
   * record whose `tool` this build's union does not contain.
   *
   * It must not RENDER — `loadDrawings` refuses it, because the canvas would
   * throw on every frame — and it must still be THERE afterwards.
   */
  const fromTheFuture = { ...drawing("future"), tool: "quantumChannel" };
  const cells = installStorage(JSON.stringify({
    BTCUSDT: [fromTheFuture],
    SOLUSDT: [drawing("mine")],
  }));

  assert.deepEqual(loadDrawings("BTCUSDT"), [],
    "a tool this build does not know must not reach the renderer");

  // A save on a DIFFERENT symbol, which is the path that used to eat it.
  saveDrawings("SOLUSDT", [drawing("mine"), drawing("second")]);

  const written = JSON.parse(cells.get(KEY)!) as Record<string, Drawing[]>;
  assert.equal(written.BTCUSDT?.length, 1,
    "saving another symbol must not delete a drawing this build cannot draw");
  assert.equal((written.BTCUSDT![0] as { tool: string }).tool, "quantumChannel",
    "and must not rewrite it either");
  assert.equal(written.SOLUSDT?.length, 2);
  Reflect.deleteProperty(globalThis, "window");
});

test("AN INVALID DRAWING IS REFUSED AT THE RENDERER, NOT AT THE DISK", () => {
  // The same distinction, from the other side: a record that is structurally
  // broken — no points at all — is unreadable in any build, and is still not
  // deleted by a save on another symbol.
  const cells = installStorage(JSON.stringify({
    BTCUSDT: [{ id: "broken", tool: "trend", points: [], style: { color: "#fff", width: 1 } }],
  }));
  assert.deepEqual(loadDrawings("BTCUSDT"), []);
  saveDrawings("ETHUSDT", [drawing("a")]);
  const written = JSON.parse(cells.get(KEY)!) as Record<string, unknown[]>;
  assert.equal(written.BTCUSDT?.length, 1);
  Reflect.deleteProperty(globalThis, "window");
});

test("saving an empty list removes the symbol rather than storing an empty array", () => {
  const cells = installStorage(JSON.stringify({ BTCUSDT: [drawing("a")] }));
  saveDrawings("BTCUSDT", []);
  const written = JSON.parse(cells.get(KEY)!) as Record<string, unknown>;
  assert.equal("BTCUSDT" in written, false);
  Reflect.deleteProperty(globalThis, "window");
});

test("with no window at all, reading is empty and saving is a no-op", () => {
  // Server-side rendering reaches this module.
  assert.deepEqual(loadDrawings("BTCUSDT"), []);
  saveDrawings("BTCUSDT", [drawing("a")]);   // must not throw
});
