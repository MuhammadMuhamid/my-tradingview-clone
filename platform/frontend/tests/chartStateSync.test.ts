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

test("unsent local work is pushed, not replaced — the edit that missed its window", () => {
  /*
   * The defect this closes. `decideSync` preferred a non-empty server
   * unconditionally and `syncDrawings` writes the adopted list back through
   * `saveDrawings`, so an edit that had not yet reached the server — a symbol
   * switch inside the debounce window, a closed tab, a sleeping laptop — was
   * destroyed on the next sync, INCLUDING its local copy. "Local data must not
   * be discarded if a save fails" was honoured for a thrown failure and not
   * for a save that simply never happened.
   */
  assert.deepEqual(
    decideSync({
      serverVersion: 5, serverCount: 2, localCount: 3,
      alreadyImported: true, localDirty: true, lastSeenVersion: 5,
    }),
    { action: "push", reason: "local-edit" },
    "the server has not moved since this device last looked, so its own edit is the newest");

  // And when the server HAS moved, another device really did write: the
  // conflict rule applies and its version wins, exactly as a stale write does.
  assert.deepEqual(
    decideSync({
      serverVersion: 9, serverCount: 2, localCount: 3,
      alreadyImported: true, localDirty: true, lastSeenVersion: 5,
    }),
    { action: "adopt", reason: "server-has-state" });

  // A clean device never pushes: it has nothing the server does not have.
  assert.deepEqual(
    decideSync({
      serverVersion: 5, serverCount: 2, localCount: 3,
      alreadyImported: true, localDirty: false, lastSeenVersion: 5,
    }),
    { action: "adopt", reason: "server-has-state" });
});

test("a device that has never synced still pushes its unsent edit", () => {
  // `lastSeenVersion: 0` and a server that has nothing: both the import path
  // and the dirty path lead upward, and neither may adopt an empty server.
  const d = decideSync({
    serverVersion: 0, serverCount: 0, localCount: 3,
    alreadyImported: true, localDirty: true, lastSeenVersion: 0,
  });
  assert.equal(d.action, "push", "already-imported must not mean 'discard my edit'");
});

test("one half's studies are never evidence about the other half", () => {
  /*
   * The seam where two waves met, and the worst defect of the programme.
   *
   * A pane's Pine studies and its built-in studies share one row and one
   * version. The built-in half asked "does the server have anything for this
   * pane" and counted BOTH lists, so three Pine scripts were proof that the
   * built-in half had server state — it adopted the server's empty native
   * list over the user's own studies, wrote that over localStorage, and 1.2
   * seconds later pushed the deletion to every other device.
   *
   * And the mirror: once either half created the row, `serverVersion > 0` was
   * true for the other, which read it as "the user deleted my list" — so a
   * user's Pine studies could never leave the browser at all.
   *
   * `serverEverWritten` is the fact a shared concurrency token cannot carry.
   */
  // The Pine half synced first: three scripts stored, no built-in studies.
  assert.deepEqual(
    decideSync({
      serverVersion: 1, serverCount: 0, serverEverWritten: false,
      localCount: 2, alreadyImported: false,
    }),
    { action: "import", reason: "first-sync" },
    "the built-in half must not adopt an empty list because Pine is populated");

  // The built-in half synced first: the Pine half must still be able to import.
  assert.deepEqual(
    decideSync({
      serverVersion: 1, serverCount: 0, serverEverWritten: false,
      localCount: 1, alreadyImported: false,
    }),
    { action: "import", reason: "first-sync" });

  // But a half the server HAS held and that is now empty is a deletion, and
  // re-importing would resurrect it. This is the property that must survive.
  assert.deepEqual(
    decideSync({
      serverVersion: 4, serverCount: 0, serverEverWritten: true,
      localCount: 2, alreadyImported: false,
    }),
    { action: "nothing", reason: "already-imported" },
    "a deletion the server recorded must not be undone by a device that missed it");
});

test("each half reads and writes only its own column", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib", "chartStateSync.ts"), "utf8");
  // The count that decides `adopt` must be this half's own.
  assert.match(source, /serverCount: server\.native\.length,\n\s*serverEverWritten: server\.nativeWritten/);
  assert.match(source, /serverCount: server\.pine\.length,\n\s*serverEverWritten: server\.pineWritten/);
  // And the built-in half's IMPORT must not carry a pine key at all — writing
  // somebody else's empty list is how the Pine half's own import was pre-empted.
  assert.doesNotMatch(source, /pine: localPine, native: localNative/,
    "the native import must not write the Pine column");
  assert.match(source, /native: localNative, baseVersion: server\.version/);
});

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

test("no combination ever discards an edit this device has not sent", () => {
  /*
   * The property, over the whole input space rather than a handful of cases.
   * `adopt` is the only outcome that overwrites local storage, so a dirty
   * device may reach it ONLY when the server has genuinely moved past what
   * that device last saw — which is a real conflict, not a lost edit.
   */
  for (const serverVersion of [0, 1, 5, 9]) {
    for (const serverCount of [0, 3]) {
      for (const localCount of [0, 4]) {
        for (const alreadyImported of [false, true]) {
          for (const lastSeenVersion of [0, 5]) {
            const d = decideSync({
              serverVersion, serverCount, localCount, alreadyImported,
              localDirty: true, lastSeenVersion,
            });
            if (d.action === "adopt") {
              assert.ok(serverVersion > lastSeenVersion,
                `adopted at server v${serverVersion} having last seen v${lastSeenVersion} — ` +
                "that would discard an unsent edit");
            }
          }
        }
      }
    }
  }
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

test("the debounce is per symbol and is flushed rather than cancelled", () => {
  const page = fs.readFileSync(path.join(ROOT, "app", "chart", "page.tsx"), "utf8");
  // One shared timer meant editing BTC and then touching ETH within 1200 ms
  // cancelled the BTC push outright, and nothing rescheduled it.
  assert.match(page, /pushTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>/);
  assert.doesNotMatch(page, /const pushTimer = useRef<ReturnType<typeof setTimeout> \| null>\(null\);\s*\n\s*const schedulePush/,
    "a single shared timer cannot serve more than one symbol");
  // Leaving the instrument, and the page going away, both send what is
  // pending instead of dropping it.
  assert.match(page, /return \(\) => \{ live = false; flushPushes\(\); \};/);
  assert.match(page, /addEventListener\("pagehide", onHide\)/);
  assert.match(page, /visibilitychange/);
  // And a symbol stays dirty until a push actually lands.
  assert.match(page, /if \(!result\.offline\) dirtySymbols\.current\.delete\(forSymbol\)/);
});

test("each engine writes only the half of the pane it owns", () => {
  // A writer that sends `[]` for a list it does not own deletes it. The native
  // hook sent `pine: []` on every save, and the write replaced both columns.
  const sync = fs.readFileSync(path.join(ROOT, "lib", "chartStateSync.ts"), "utf8");
  /*
   * Every call to the pane writer, and what each one carries.
   *
   * The property is that no call names both halves: an omitted half is left
   * alone by the route, and a sent one is replaced. A writer that sends `[]`
   * for a list it does not own deletes it.
   */
  const calls = [...sync.matchAll(/putChartPaneStudies\(scope, \{([^}]*)\}/g)]
    .map((m) => m[1]!);
  assert.ok(calls.length >= 2, "both halves must have a writer");
  for (const call of calls) {
    const mentionsPine = /\bpine\b\s*[,:]/.test(call);
    const mentionsNative = /\bnative\b\s*[,:]/.test(call);
    assert.ok(mentionsPine !== mentionsNative,
      `a pane write carries exactly one half, not both: {${call.trim()}}`);
  }
  assert.ok(calls.some((c) => /\bnative\b\s*[,:]/.test(c)), "the built-in half is written");
  assert.ok(calls.some((c) => /\bpine\b\s*[,:]/.test(c)), "and so is the Pine half");

  const native = fs.readFileSync(path.join(ROOT, "lib", "useNativeStudies.ts"), "utf8");
  assert.doesNotMatch(native, /pushPaneStudies\(scope, \[\]/,
    "an empty list for somebody else's half is a delete");

  const pine = fs.readFileSync(path.join(ROOT, "lib", "useIndicators.ts"), "utf8");
  assert.match(pine, /pushPanePine\(scope, storable\(list\), version\.current\)/,
    "Pine studies must actually reach the server — C1 requires both engines");
  assert.match(pine, /syncPanePine\(scope, local\)/);
});

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

test("a refused write is recognised from the status, not from arithmetic", () => {
  /*
   * This assertion used to read the opposite thing, and the opposite thing was
   * wrong: `saved.version !== baseVersion + 1` cannot see a FIRST write —
   * `baseVersion: 0` — refused because the row already exists at version 1,
   * because 0 + 1 is 1. A pane's two halves are first written a moment apart,
   * so the second one hit that case every time and reported a save that had
   * not happened. `tests/dom/studies.test.tsx` is what found it, by adding a
   * Pine study and a built-in study to one pane and then asking the server
   * what it held.
   *
   * The behaviour now lives in the DOM tests, which exercise it. What is left
   * here is the structural half: a 409 must reach the caller as a body, and
   * the flag it carries must be the one the callers read.
   */
  assert.match(source, /conflicted\)\s*saveDrawings\(symbol, next\)/);
  assert.doesNotMatch(source, /saved\.version !== baseVersion \+ 1/,
    "a version coincidence is not evidence that a write landed");
  assert.equal((source.match(/const \{ conflicted \} = saved;/g) ?? []).length, 3,
    "all three push paths must read the server's own answer");

  const api = fs.readFileSync(path.join(ROOT, "lib", "api.ts"), "utf8");
  assert.match(api, /conflicted: res\.status === 409/,
    "a 409 must reach the caller as a body that says it was a 409");
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
