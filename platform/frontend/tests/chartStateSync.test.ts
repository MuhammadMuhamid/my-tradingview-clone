/**
 * Moving a user's chart state to the server without losing any of it.
 *
 * ── The failure this is guarding against ───────────────────────────────────
 *
 * Not "the sync did not run". A sync that does not run leaves the user exactly
 * as they were, which is fine. The failures worth testing are the ones where
 * work DISAPPEARS: a laptop opening for the first time and flattening the
 * desk's chart, a deletion that comes back after a reload, a failed request
 * that clears local data on its way out.
 *
 * `decideSync` is the whole decision, extracted as a pure function precisely
 * so it can be reasoned about here rather than only by running the app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSync } from "../lib/chartStateSync";

const decide = (
  serverVersion: number, serverCount: number, localCount: number, alreadyImported = false
) => decideSync({ serverVersion, serverCount, localCount, alreadyImported });

test("a populated server wins, whatever this device happens to hold", () => {
  // The second device opening for the first time. Its own localStorage may
  // have anything in it; the server's content may be the first device's work,
  // and this device has no basis for believing its copy is newer.
  assert.deepEqual(decide(3, 5, 2), { action: "adopt", reason: "server-has-state" });
  assert.deepEqual(decide(1, 1, 0), { action: "adopt", reason: "server-has-state" });
  assert.deepEqual(decide(9, 40, 40, true), { action: "adopt", reason: "server-has-state" });
});

test("local state that has never synced goes up, once", () => {
  assert.deepEqual(decide(0, 0, 7), { action: "import", reason: "first-sync" });
  // And not a second time: the log is what stops a reload resurrecting
  // everything from this device's own untouched localStorage.
  assert.deepEqual(decide(0, 0, 7, true), { action: "nothing", reason: "already-imported" });
});

test("an EMPTY server row is a deliberate deletion, not an invitation to re-import", () => {
  // This is the resurrection case, and it is the subtle one. Version 2 with
  // nothing in it means a device deleted everything and saved. Treating that
  // as "the server has nothing, send mine" would undo the deletion on the next
  // reload of whichever device still had the drawings locally.
  assert.deepEqual(decide(2, 0, 7), { action: "nothing", reason: "already-imported" });
  assert.deepEqual(decide(1, 0, 1), { action: "nothing", reason: "already-imported" });
});

test("nothing anywhere is nothing to do", () => {
  assert.deepEqual(decide(0, 0, 0), { action: "nothing", reason: "both-empty" });
  assert.deepEqual(decide(0, 0, 0, true), { action: "nothing", reason: "both-empty" });
});

test("every combination resolves, and only an unsynced device ever imports", () => {
  // Exhaustive over the shape of the inputs rather than a handful of cases:
  // the decision has four arms and a wrong one is silent.
  for (const serverVersion of [0, 1, 5]) {
    for (const serverCount of [0, 3]) {
      for (const localCount of [0, 4]) {
        for (const alreadyImported of [false, true]) {
          const d = decide(serverVersion, serverCount, localCount, alreadyImported);
          assert.ok(["adopt", "import", "push", "nothing"].includes(d.action));
          if (d.action === "import") {
            assert.equal(alreadyImported, false, "an imported device must not import again");
            assert.equal(serverVersion, 0, "an import must never overwrite a stored row");
            assert.ok(localCount > 0, "there must be something to import");
          }
          if (serverCount > 0 && serverVersion > 0) {
            assert.equal(d.action, "adopt", "stored content is never ignored");
          }
        }
      }
    }
  }
});

// ── the properties the code around the decision has to hold ────────────────

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "lib", "chartStateSync.ts"), "utf8");

test("no failure path clears local state", () => {
  // Every `catch` in this file must return the local list. A sync that cannot
  // reach the server has to leave the user exactly as they were — including
  // offline, which is a normal condition and not an error.
  for (const forbidden of [/saveDrawings\([^)]*\[\]\)/, /localStorage\.clear/,
                           /removeItem\("srtrend/, /saveStoredNative\(\[\]/]) {
    assert.doesNotMatch(source, forbidden,
      `${forbidden} would discard a user's work on a failed sync`);
  }
  // And the offline answer is the LOCAL data, marked as such.
  assert.match(source, /return \{\s*drawings: local, version: 0, offline: true,/);
});

test("a conflict is adopted rather than retried", () => {
  // The server's 409 body IS the current state. Writing again against the
  // version that was just refused would loop, and forcing the local list back
  // over it would undo whatever the other device did.
  assert.match(source, /conflicted\)\s*saveDrawings\(symbol, next\)/);
  assert.match(source, /const conflicted = saved\.version !== baseVersion \+ 1/);

  const api = fs.readFileSync(path.join(ROOT, "lib", "api.ts"), "utf8");
  assert.match(api, /if \(res\.ok \|\| res\.status === 409\) return res\.json\(\)/,
    "a 409 must reach the caller as a body, not as an Error");
});

test("the import log is per instrument and per pane, not one global flag", () => {
  // A single "imported" flag would mean opening one chart marks every other
  // instrument as done, and the rest of the user's drawings never go up.
  assert.match(source, /hasImported\("drawings", symbol\)/);
  assert.match(source, /hasImported\("panes", scope\)/);
  assert.match(source, /noteImported\("drawings", symbol\)/);
});

test("an unknown study id degrades to a working chart rather than an empty one", () => {
  // Adoption goes through `saveStoredNative`, which drops rows individually.
  // A layout written by a newer build must not cost the user the studies this
  // build does understand.
  assert.match(source, /saveStoredNative\(native, scope\)/);
});
