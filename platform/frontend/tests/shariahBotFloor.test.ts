/**
 * Whether the browser tells the truth about Bot enforcement.
 *
 * ── The failure this exists to prevent ─────────────────────────────────────
 *
 * "Shariah Mode: ON" describes one Platform's stored setting. The execution
 * Bot also accepts signals this Platform never sees, on its own webhook, and
 * only the Bot's own floor gates those. The backend reports four things —
 * `mode`, `botMode`, `inSync`, and `botFloorPushed` on a mutation — precisely
 * so an operator is never shown a green ON over an executing side that is not
 * armed. The browser was typed for one of them and discarded the rest.
 *
 * So the property under test is a negative, and it is the important one:
 * nothing except a positive, agreeing answer from BOTH sides may render as
 * confirmed enforcement. Unreachable is unknown. Not-pushed is unknown.
 * Disagreement is a warning. None of them is "off", and none is "fine".
 *
 * All of this is `describeShariahSync`, which is pure, so it is tested as
 * pure logic. The page is checked separately for two things a state test
 * cannot see: that it renders the panel at all, and that it introduces no poll.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  describeShariahSync, normalizeShariahMode,
  type ShariahModeResponse, type ShariahModeState,
} from "../lib/shariah";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readCode = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PAGE = "app/shariah/page.tsx";

const state = (over: Partial<ShariahModeState> = {}): ShariahModeState => ({
  mode: "enforce", policyVersion: "TS_SHARIAH_V1",
  botMode: "enforce", inSync: true, botFloorPushed: true, ...over,
});

// ── the four states ────────────────────────────────────────────────────────

test("Platform ON and Bot confirmed in sync shows a confirmed state", () => {
  const view = describeShariahSync(state());
  assert.equal(view.level, "confirmed");
  assert.equal(view.botEnforcing, true);
  assert.match(view.label, /enforcing/i);
  assert.match(view.detail, /the execution Bot confirms the same floor/i);
});

test("Platform OFF claims no Bot floor rather than a healthy one", () => {
  const view = describeShariahSync(state({ mode: "off", botMode: "off", inSync: true }));
  assert.equal(view.level, "off");
  assert.equal(view.botEnforcing, false, "OFF is not an enforcement confirmation");
  assert.match(view.detail, /Trading behaviour is unchanged/);
});

test("an unreachable Bot is UNKNOWN — not off, and never confirmed", () => {
  // `botMode: null` is what the backend sends when the control channel exists
  // but the Bot did not answer. Claiming `off` would invent agreement; claiming
  // `enforce` would invent protection.
  for (const over of [
    { botMode: null, inSync: null },
    { botMode: null, inSync: false },
    { botMode: "enforce" as const, inSync: null },
  ]) {
    const view = describeShariahSync(state({ ...over, botFloorPushed: null }));
    assert.equal(view.level, "unknown", JSON.stringify(over));
    assert.equal(view.botEnforcing, false);
    assert.match(view.detail, /not the same as off, and not a confirmation/);
  }
});

test("botFloorPushed:false is never rendered as confirmed Bot enforcement", () => {
  // A 200 with nothing armed: this installation has no Bot control channel, so
  // no floor was pushed. It is a real deployment and a truthful answer — and it
  // is checked BEFORE anything else, so no later field can promote it.
  const view = describeShariahSync(state({ botFloorPushed: false }));
  assert.equal(view.level, "unknown");
  assert.equal(view.botEnforcing, false);
  assert.match(view.label, /not armed/i);
  assert.match(view.detail, /no execution Bot control channel is configured/);
  assert.match(view.detail, /is not gated by this Platform/);

  // Even alongside fields that would otherwise read as agreement.
  const withAgreement = describeShariahSync(
    state({ botFloorPushed: false, botMode: "enforce", inSync: true }));
  assert.equal(withAgreement.botEnforcing, false);
  assert.notEqual(withAgreement.level, "confirmed");
});

test("Platform/Bot drift is visible and names both sides", () => {
  const view = describeShariahSync(state({ botMode: "off", inSync: false }));
  assert.equal(view.level, "drift");
  assert.equal(view.botEnforcing, false);
  assert.match(view.detail, /this Platform enforces but the execution Bot reports its floor as "off"/i);
  assert.match(view.detail, /must agree before either can be trusted/);
});

test("contradictory fields resolve to the unsafe reading, never the safe one", () => {
  // `inSync: true` with a disagreeing `botMode` is a contradiction. Trusting the
  // boolean would confirm enforcement on the strength of a field that is wrong.
  const view = describeShariahSync(state({ botMode: "off", inSync: true }));
  assert.notEqual(view.level, "confirmed");
  assert.equal(view.botEnforcing, false);
});

test("a state that has not been read yet is not confirmed", () => {
  const view = describeShariahSync(null);
  assert.equal(view.botEnforcing, false);
  assert.notEqual(view.level, "confirmed");
});

test("exactly one of the four levels ever sets botEnforcing", () => {
  const cases: ShariahModeState[] = [
    state(), state({ mode: "off" }), state({ botMode: null, inSync: null }),
    state({ botFloorPushed: false }), state({ botMode: "off", inSync: false }),
  ];
  const enforcing = cases.filter((c) => describeShariahSync(c).botEnforcing);
  assert.equal(enforcing.length, 1);
  assert.equal(describeShariahSync(enforcing[0]!).level, "confirmed");
});

// ── widening the response ──────────────────────────────────────────────────

test("an absent field becomes 'not stated', never 'false' and never 'off'", () => {
  // The GET reports botMode/inSync; the PUT reports botFloorPushed. Defaulting
  // a missing field to `false` would turn silence into a claim.
  const fromPut = normalizeShariahMode({ mode: "enforce", botFloorPushed: true });
  assert.equal(fromPut.botMode, null);
  assert.equal(fromPut.inSync, null);
  assert.equal(fromPut.botFloorPushed, true);

  const fromGet = normalizeShariahMode({ mode: "enforce", botMode: "enforce", inSync: true });
  assert.equal(fromGet.botFloorPushed, null);
  // A PUT-only field left unstated must not read as "no channel configured".
  assert.equal(describeShariahSync(fromGet).level, "confirmed");
});

test("a malformed or unknown mode is not read as enforcing", () => {
  const bad = normalizeShariahMode({ mode: "ENFORCE" } as unknown as ShariahModeResponse);
  assert.equal(bad.mode, "off");
  assert.equal(describeShariahSync(bad).botEnforcing, false);

  const badBot = normalizeShariahMode({ mode: "enforce", botMode: "yes" } as unknown as ShariahModeResponse);
  assert.equal(badBot.botMode, null, "an unrecognised bot floor is unknown, not off");
  assert.equal(describeShariahSync(badBot).level, "unknown");
});

test("normalising nothing is total and safe", () => {
  assert.deepEqual(normalizeShariahMode(null), {
    mode: "off", policyVersion: null, botMode: null, inSync: null, botFloorPushed: null,
  });
  const previous = state();
  assert.deepEqual(normalizeShariahMode(undefined, previous), previous);
});

// ── the page ───────────────────────────────────────────────────────────────

test("the console renders the Bot floor, and the mode badge no longer claims to be the whole answer", () => {
  const source = read(PAGE);
  assert.match(source, /<BotFloorPanel state=\{modeState\} \/>/);
  assert.match(source, /describeShariahSync\(state\)/);
  assert.match(source, /Platform mode: \{mode === null/,
    "the badge is about this Platform's stored setting and must say so");
  assert.doesNotMatch(source, /Shariah Mode: \{mode === null/);
});

test("the state carries every field the backend reports", () => {
  const source = read(PAGE);
  assert.match(source, /useState<ShariahModeState \| null>\(null\)/);
  assert.match(source, /setModeState\(normalizeShariahMode\(m\)\)/);
  assert.doesNotMatch(source, /useState<ShariahMode \| null>/,
    "typing the page for `mode` alone is exactly what hid the Bot's answer");
});

test("drift is announced, not merely coloured", () => {
  const source = read(PAGE);
  assert.match(source, /role=\{view\.level === "drift" \? "alert" : "status"\}/);
  // A shape as well as a colour: two greens are not a state an operator can be
  // asked to tell apart when the answer is "is the executing side armed". Each
  // level draws a distinct mark, and none of the four shares one.
  const marks = [...source.matchAll(/mark: (<[\s\S]*?\/>|<>[\s\S]*?<\/>)/g)].map((m) => m[1]);
  assert.equal(marks.length, 4, "every enforcement level needs its own mark");
  assert.equal(new Set(marks).size, 4, "two levels are drawn identically");
  // Drawn, not typed — the project renders control glyphs as inline SVG.
  assert.doesNotMatch(source, /glyph: "[✓✕✔✖]"/);
});

test("a refused or half-applied mode change re-reads instead of showing the stale value", () => {
  const source = read(PAGE);
  const toggle = source.slice(source.indexOf("const toggleMode"), source.indexOf("const createSnapshot"));
  assert.match(toggle, /await rereadMode\(saved\)/, "the PUT does not report the Bot's own floor");
  assert.match(toggle, /catch \(e\)[\s\S]*await rereadMode\(modeState\)/,
    "a 502 or a drift 500 is exactly when the two sides can disagree");
});

test("no polling, no scheduler and no reconciliation service was introduced", () => {
  const source = readCode(PAGE);
  assert.doesNotMatch(source, /setInterval|setTimeout|requestAnimationFrame/,
    "the mode only moves when someone changes it; a loop would be a cost with no reader");
  const lib = readCode("lib/shariah.ts");
  assert.doesNotMatch(lib, /setInterval|setTimeout/);
});

test("the browser still decides no Shariah policy", () => {
  const lib = readCode("lib/shariah.ts");
  // describeShariahSync reports agreement between two reported values. It must
  // not evaluate eligibility, exposure or anything a gate decides.
  assert.doesNotMatch(lib, /ELIGIBLE\s*[?:=]==|buyAllowed\s*=/);
  assert.doesNotMatch(lib, /prohibitedCategories\.(includes|some)/);
});
