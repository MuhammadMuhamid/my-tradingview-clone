/**
 * The saved-layout menu: what it says, and what it refuses to do quietly.
 *
 * The persistence authority is `lib/useSavedLayouts` and this wave did not
 * touch it — no new store, no cloud sync, no change to what a layout is. What
 * changed is the surface, and the two things worth pinning are both about
 * silence: the drift indicator was a bare "•" with no label, and opening a
 * different layout while the current one had unsaved changes discarded them
 * without a word.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readCode = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const MENU = "components/tv/LayoutMenu.tsx";

test("the current layout's name is visible without opening the menu", () => {
  const source = read(MENU);
  assert.match(source, /\{current\?\.name \?\? "Unnamed"\}/);
  assert.match(source, /aria-label=\{`Saved layouts — \$\{current\?\.name \?\? "not saved"\}, \$\{status\.label\}`\}/);
});

test("the unsaved state is a word, not an unlabelled dot", () => {
  const source = read(MENU);
  for (const label of ["Not saved", "Unsaved changes", "Saving…", "Saved", "Autosave failing"]) {
    assert.ok(source.includes(`"${label}"`), `the menu never says “${label}”`);
  }
  // The old surface: a bare bullet appended to the name, with no accessible
  // name and no tooltip, carrying the whole difference between "on the server"
  // and "only in this tab".
  assert.doesNotMatch(source, /dirty && !autosave \? " •" : ""/);
});

test("below the width where the words fit, the state keeps a shape as well as a colour", () => {
  const source = read(MENU);
  assert.match(source, /\{\(dirty \|\| autosaveError\) && \(/);
  assert.match(source, /2xl:hidden/);
  assert.match(source, /2xl:inline/);
});

test("save, save as, rename, autosave and open are all reachable", () => {
  const source = read(MENU);
  assert.match(source, /Save layout/);
  assert.match(source, /Save as…/);
  assert.match(source, /Rename…/);
  assert.match(source, /Autosave/);
  assert.match(source, /Open a layout/);
  // Save is disabled with no current layout, because there is nothing to
  // overwrite — Save as… is the path that creates one.
  assert.match(source, /<Item onClick=\{onSaveNow\} disabled=\{!current\}>/);
  assert.match(source, /<Item onClick=\{current \? onCopy : onCreate\}>/);
});

test("one Save as, not two menu items for the same operation", () => {
  // `onCreate` and `onCopy` are the same write with a different default name in
  // the prompt. Offering both is a question the user must answer before acting,
  // not extra capability — and both are still wired, so nothing was removed.
  const source = readCode(MENU);
  assert.doesNotMatch(source, /Make a copy…/);
  assert.doesNotMatch(source, /Create new layout…/);
  assert.match(source, /onCopy/);
  assert.match(source, /onCreate/);
});

test("opening another layout over unsaved changes asks first", () => {
  const source = read(MENU);
  const select = source.slice(source.indexOf("const selectLayout"), source.indexOf("const Item ="));
  assert.match(select, /id !== currentId && dirty && !autosave/,
    "autosave will write the drift, so it only asks when nothing else will");
  assert.match(select, /window\.confirm/);
  assert.match(select, /discards them/);
  assert.match(select, /if \(!ok\) return;/, "cancelling must not open the other layout");
});

test("deleting a layout is named, and the open one is marked", () => {
  const source = read(MENU);
  assert.match(source, /aria-label=\{`Delete the layout “\$\{l\.name\}”`\}/,
    "a bare ✕ in a list is an ambiguous destructive action");
  assert.match(source, /aria-current=\{l\.id === currentId \? "true" : undefined\}/);
  assert.match(source, /\{l\.id === currentId \? " — open" : ""\}/,
    "which layout is open must not be told by an accent colour alone");
});

test("the menu decides nothing about persistence", () => {
  const source = readCode(MENU);
  assert.doesNotMatch(source, /fetch\(|localStorage|from "@\/lib\/layouts"[^;]*\bsaveLayout\b/);
  // Every write is a callback the hook owns.
  for (const handler of ["onSaveNow", "onCopy", "onCreate", "onRename", "onDelete", "onSelect"]) {
    assert.ok(source.includes(handler), `${handler} must stay a prop`);
  }
});

test("this wave changed no saved-layout persistence and added no cloud sync", () => {
  const hook = read("lib/useSavedLayouts.ts");
  assert.match(hook, /await layoutStore\.saveLayout\(currentLayoutId, workspaceState\)/);
  assert.match(hook, /layoutStore\.createLayout\(name, workspaceState\)/);
  // The authority is still the same server-side store, and the pane
  // arrangement is still device-local — see the hook's own header.
  assert.match(hook, /the PANE ARRANGEMENT — how many charts and where — is device-local/);
});

test("Escape closes the menu and gives the keyboard back to its trigger", () => {
  const source = read(MENU);
  assert.match(source, /e\.key !== "Escape"/);
  assert.match(source, /buttonRef\.current\?\.focus\(\)/);
  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /role="menu"/);
});
