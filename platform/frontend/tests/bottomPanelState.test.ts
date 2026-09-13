/**
 * What the bottom panel remembers.
 *
 * The panel has three tabs — Positions & Orders, Strategy Tester, Pine Editor
 * — and it remembered whether it was collapsed and how tall it was, and not
 * which tab the user was working in. Somebody halfway through a script reloads
 * and lands on Positions & Orders.
 *
 * The restore ORDER is the part worth pinning, because it is the part that is
 * easy to get subtly wrong: a stored "trading" must still fall through to the
 * tester when there is no trading state to show, and a stored "pine" must not.
 * That is the difference between restoring a preference and overriding a rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(__dirname, "..", "components", "tv", "ChartBottomPanel.tsx");
const source = fs.readFileSync(FILE, "utf8");
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("THE PANEL REMEMBERS WHICH TAB, NOT ONLY HOW TALL", () => {
  assert.match(code, /const TAB_KEY = "tv\.bottomTab";/);

  // Read through a guard that refuses anything that is not one of the three:
  // a hand-edited or stale value must not become a tab that does not exist.
  assert.match(code,
    /raw === "trading" \|\| raw === "tester" \|\| raw === "pine" \? raw : null/);

  // Written on every change, including the programmatic move that opens a
  // script in the editor — that is where the user now is.
  assert.match(code, /remember\(TAB_KEY, tab\);/);
  assert.match(code, /\}, \[tab\]\);/);
});

test("THE RESTORE DOES NOT CLAIM THE USER JUST CHOSE THE TAB", () => {
  /*
   * `userChoseTab` exists to stop the availability rule moving a tab under
   * somebody who picked it. Setting it during the RESTORE would look right and
   * be wrong: a stored "trading" on a chart with no trading state would then
   * sit on a tab that is a notice and nothing else — which is the exact
   * situation the rule was written for.
   */
  const restore = /const stored = storedTab\(\);\s*if \(stored\) setTab\(stored\);/;
  assert.match(code, restore, "the stored tab is restored");
  const block = /useEffect\(\(\) => \{\s*const stored = storedTab\(\);[\s\S]*?\}, \[\]\);/.exec(code);
  assert.ok(block, "the restore effect is no longer where this rule can read it");
  assert.doesNotMatch(block[0], /userChoseTab/,
    "restoring a preference must not suppress the availability rule");

  // And the rule itself still only ever moves `trading`, so a stored `pine`
  // survives it.
  assert.match(code, /setTab\(\(current\) => \(current === "trading" \? "tester" : current\)\);/);
});

test("the panel's three persisted preferences have three distinct keys", () => {
  // A shared key would make collapsing the panel change the tab, which is the
  // sort of thing that only shows up on somebody else's machine.
  const keys = [...code.matchAll(/"(tv\.bottom[A-Za-z.]*)"/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(keys)].sort(),
    ["tv.bottomCollapsed", "tv.bottomCollapsed.mobile", "tv.bottomHeight", "tv.bottomTab"]);
});

test("every storage touch in the panel goes through the guarded module", () => {
  /*
   * The panel is where four of the eight unguarded calls were found: its
   * height and its collapsed state, read AND written. `localStorage` is
   * unreachable in Safari Private Browsing before any method is called, so a
   * bare read here took the whole chart page down.
   */
  assert.doesNotMatch(code, /localStorage/,
    "use recall/remember from lib/browserStorage");
  assert.match(source, /import \{ recall, remember \} from "@\/lib\/browserStorage";/);
});
