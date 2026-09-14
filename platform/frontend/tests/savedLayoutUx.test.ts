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

/**
 * Everything the component renders ON THE BAR: the split control, not the menu.
 *
 * Comments stripped, because several of these assertions are about what the
 * markup no longer does and the comments explain what it used to.
 */
const triggerOf = (source: string): string =>
  source.slice(source.indexOf("\n  return ("), source.indexOf("{open && ("))
    .replace(/\/\*[\s\S]*?\*\//g, "");

test("the current layout's name is visible without opening the menu", () => {
  const source = read(MENU);
  assert.match(source, /\{current\?\.name \?\? "Unnamed"\}/);
  assert.match(source, /aria-label=\{`Saved layout — \$\{current\?\.name \?\? "Unnamed"\}, \$\{status\.label\}`\}/);

  /*
   * TVP8 R1-07. "Visible" used to mean `hidden … 2xl:inline`: below 1536 the
   * control was a grid icon and a caret with no name on it, and 1440 is the
   * width this product is actually used at. The name is the only thing on this
   * control a user can recognise their workspace by, so it is the part that
   * survives a narrow row — the status word is what left instead.
   */
  const name = /<span className="([^"]*)">\s*\n\s*\{current\?\.name \?\? "Unnamed"\}/.exec(source);
  assert.ok(name, "the name is no longer rendered on the trigger");
  assert.match(name[1]!, /\bsm:inline\b/);
  assert.doesNotMatch(name[1]!, /2xl:/, "the name must not wait for a 1536px viewport");
  assert.match(name[1]!, /max-w-\[160px\] truncate/, "and it must still give the row its width back");
});

test("the unsaved state is a sentence somewhere, and never a bare dot", () => {
  const source = read(MENU);
  for (const label of ["Not saved", "Unsaved changes", "Saving…", "Saved", "Autosave failing"]) {
    assert.ok(source.includes(`"${label}"`), `the menu never says “${label}”`);
  }
  // The old surface: a bare bullet appended to the name, with no accessible
  // name and no tooltip, carrying the whole difference between "on the server"
  // and "only in this tab".
  assert.doesNotMatch(source, /dirty && !autosave \? " •" : ""/);

  /*
   * TVP8 R1-07/R1-10: the sentence is said in the tooltip, in the accessible
   * name and in the menu's header — not as a second line of copy on the
   * primary row. "UNSAVED CHANGES" in 10px caps beside the layout's name is a
   * second sentence competing with the one thing that identifies the
   * workspace, and the bar is the most expensive place to spend a word.
   */
  const trigger = triggerOf(source);
  assert.match(trigger, /aria-label=\{`Saved layout — [^`]*\$\{status\.label\}`\}/);
  assert.match(trigger, /title=\{`[^`]*\$\{status\.label\}\. \$\{status\.help\}`\}/,
    "the word AND the sentence behind it are the tooltip");
  // ...and nowhere in the markup is it a child, i.e. visible text.
  assert.doesNotMatch(trigger, />\s*\{status\.label\}|\{status\.label\}\s*</,
    "the status word must not be rendered on the bar");
  assert.doesNotMatch(trigger, /status\.tone/,
    "the tint that painted that word belonged to the word");
});

test("the state keeps a shape as well as a colour, at every width", () => {
  const source = read(MENU);
  const trigger = triggerOf(source);

  /*
   * The save cloud, which is TradingView's affordance here and the reason the
   * word is no longer needed on the bar: it is on screen at every width, it
   * grows a filled badge when the workspace is ahead of what is stored, and it
   * takes the warn tint when autosave has stopped working. The old shape-only
   * fallback was `2xl:hidden`, i.e. the state had a shape at the widths where
   * it also had words and only a colour everywhere else.
   */
  assert.match(trigger, /\{dirty && \(/, "drift must be a shape, not only a tooltip");
  assert.match(trigger, /rounded-full bg-current/);
  assert.match(trigger, /autosaveError \? "text-warn" : ""/);
  assert.doesNotMatch(trigger, /2xl:(hidden|inline)/,
    "nothing about the save state is gated on a 1536px viewport any more");

  // Clicking the name writes the drift; the menu is no longer the only way to
  // save. With nothing to write the click does nothing but take focus.
  assert.match(trigger, /onClick=\{\(\) => \{ if \(dirty && current\) onSaveNow\(\); \}\}/);
});

test("the caret is a control of its own, with its own name", () => {
  /*
   * TVP8 R1-07: one button answered three questions — which layout am I in,
   * is it safe, and what else can I do — so the only way to save was to open a
   * menu and find "Save layout" in it. TradingView splits the same control:
   * a name button that saves, a 24px caret that opens the list.
   */
  const source = read(MENU);
  const trigger = triggerOf(source);
  assert.match(trigger, /aria-label="Manage layouts"/);
  assert.match(trigger, /className=\{TOOL_CARET_BUTTON\}/, "24px, the measured width");
  // The caret is what opens the menu, so it is what `aria-expanded` and the
  // Escape handler's focus return belong to.
  const caret = trigger.slice(trigger.indexOf("aria-label=\"Manage layouts\"") - 400);
  assert.match(caret, /ref=\{buttonRef\}/);
  assert.match(caret, /aria-expanded=\{open\}/);
  assert.match(caret, /aria-haspopup="menu"/);
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
  // TVP8: the product's own dialog, not the browser's.
  assert.match(select, /await ask\.confirm\(/);
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

// ── TVP8: what a layout actually carries ──────────────────────────────────

test("A SAVED LAYOUT CARRIES THE ARRANGEMENT, NOT ONLY THE SYMBOL", () => {
  /*
   * `lib/layouts.ts` said in its own docstring that a layout "snapshots the
   * whole workspace" and listed DRAWINGS among what it carries. It carried
   * neither: the applied studies, the drawings, the chart type, the per-pane
   * settings, the price scale and the pane grid were all localStorage-only, so
   * opening a saved layout restored a symbol and a timeframe onto whatever the
   * browser happened to be showing. Two reviews flagged the sentence as false
   * before anyone noticed the feature was.
   */
  const layouts = read("lib/layouts.ts");
  assert.match(layouts, /workspace\?: LayoutWorkspace;/,
    "the state a layout saves has to include the arrangement");
  assert.doesNotMatch(layouts, /A\s*\n?\s*\* layout snapshots the whole workspace: symbol, timeframe, history depth,/,
    "the false docstring must be gone, not just outvoted by a new one");

  // It reaches the wire, both on create and on save.
  assert.match(layouts, /\.\.\.\(s\.workspace \? \{ workspace: s\.workspace \} : \{\}\)/);
  assert.match(layouts, /\.\.\.\(state\.workspace \? \{ workspace: state\.workspace \} : \{\}\)/);

  // And the column exists to receive it.
  const migration = fs.readFileSync(
    path.join(ROOT, "..", "backend", "src", "db", "migrations", "040_layout_workspace.sql"), "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS workspace jsonb/);
});

test("restoring an arrangement degrades rather than throwing", () => {
  /*
   * A layout written by a newer build, or a record damaged in storage, must
   * restore what it can and drop the rest. A saved arrangement that can break
   * the page it restores into is worse than one that restores partially — and
   * every store this touches already has that contract.
   */
  const helper = read("lib/layoutWorkspace.ts");

  // Nothing at all is not an error.
  assert.match(helper, /if \(typeof window === "undefined" \|\| !held\) return false;/);
  // A non-array where a list is expected is skipped, not coerced.
  assert.equal((helper.match(/if \(!Array\.isArray\(list\)\) continue;/g) ?? []).length, 2);
  // One unreadable scope does not lose the others.
  assert.match(helper, /one unreadable scope must not lose the others/);
  // And the writes go through each store's OWN writer, so the stored shape
  // stays that store's business.
  assert.match(helper, /saveStoredNative\(list as never, scope\)/);
  assert.match(helper, /drawingStore\.set\(symbol, list as Drawing\[\], "layout"\)/);

  // The page restores before it applies, and reloads only when the pane record
  // changed — that record is read once, at mount.
  const page = read("app/chart/page.tsx");
  assert.match(page, /const panesRestored = restoreLayoutWorkspace\(s\.workspace\);/);
  assert.match(page, /if \(panesRestored\) window\.location\.reload\(\);/);

  // Capture happens at SAVE time, not in a memo keyed on React state: the
  // stores change without this component re-rendering.
  assert.match(page, /get workspace\(\) \{ return captureLayoutWorkspace\(\); \}/);
});
