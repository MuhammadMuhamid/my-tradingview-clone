/**
 * TVP8 F-07: switching between saved layouts.
 *
 * The menu already listed layouts under `RECENTLY USED`, but it listed ALL of
 * them, in whatever order the server returned — which for a user with a dozen
 * is not a recents list, it is the whole library unsorted inside a dropdown —
 * and there was no `Open layout…` at all, so the rest was unreachable.
 *
 * The ordering rule is pure and lives here; that the menu draws four of it and
 * that the dialog searches all of it is covered in
 * `tests/dom/layoutRecents.test.tsx`.
 */
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  LAYOUT_RECENTS_SHOWN, forgetLayoutRecent, getLayoutRecents, noteLayoutOpened, orderByRecents,
  type Layout,
} from "../lib/layouts";

function installStorage(): Map<string, string> {
  const cells = new Map<string, string>();
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

beforeEach(() => { installStorage(); });

/** Only the fields the ordering reads; the rest of a `Layout` is not its business. */
const layout = (id: string, updatedAt: number): Layout =>
  ({ id, name: id, updatedAt } as Layout);

test("F-07 — the menu shows four, which is what the reference shows", () => {
  assert.equal(LAYOUT_RECENTS_SHOWN, 4);
});

test("F-07 — opening a layout moves it to the front", () => {
  noteLayoutOpened("a");
  noteLayoutOpened("b");
  assert.deepEqual(getLayoutRecents(), ["b", "a"]);
  noteLayoutOpened("a");
  assert.deepEqual(getLayoutRecents(), ["a", "b"],
    "re-opening moves it rather than listing it twice");
});

test("F-07 — the order survives a reload, so switching back is still one click", () => {
  noteLayoutOpened("a");
  noteLayoutOpened("b");
  // A fresh read, as the next load makes.
  assert.deepEqual(getLayoutRecents(), ["b", "a"]);
});

test("F-07 — a deleted layout leaves the order", () => {
  // Otherwise its id ranks a row that no longer exists, ahead of ones that do.
  noteLayoutOpened("a");
  noteLayoutOpened("b");
  assert.deepEqual(forgetLayoutRecent("b"), ["a"]);
  assert.deepEqual(getLayoutRecents(), ["a"]);
});

test("F-07 — recents first, then the rest by how recently they were WRITTEN", () => {
  const all = [layout("a", 100), layout("b", 300), layout("c", 200), layout("d", 400)];
  assert.deepEqual(orderByRecents(all, ["c", "a"]).map((l) => l.id), ["c", "a", "d", "b"],
    "c and a were opened, in that order; d and b fall back to updatedAt");
});

test("F-07 — a device that has switched nothing still gets a useful order", () => {
  /*
   * A second browser's list is not empty; it is simply not ordered by THIS
   * machine's history. Most-recently-saved first is the honest fallback.
   */
  const all = [layout("a", 100), layout("b", 300), layout("c", 200)];
  assert.deepEqual(orderByRecents(all, []).map((l) => l.id), ["b", "c", "a"]);
});

test("F-07 — ordering never drops or duplicates a layout", () => {
  const all = [layout("a", 1), layout("b", 2), layout("c", 3)];
  // Including an id for a layout that is no longer saved, which is what a
  // stale recents list on a shared account looks like.
  const ordered = orderByRecents(all, ["gone", "c"]);
  assert.deepEqual([...ordered.map((l) => l.id)].sort(), ["a", "b", "c"]);
  assert.equal(ordered[0]?.id, "c");
});

test("F-07 — a malformed stored order is no order, not a crash", () => {
  const cells = installStorage();
  for (const junk of ["null", "5", '"a string"', "{}", "[1,2]", "not json"]) {
    cells.set("srtrend.layoutRecents.v1", junk);
    assert.deepEqual(getLayoutRecents().filter((x) => typeof x !== "string"), []);
  }
});
