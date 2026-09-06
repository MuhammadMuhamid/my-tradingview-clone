/**
 * The rules a timeframe menu holds itself to.
 *
 * `lib/resolution` decides what is arithmetically honest. This decides what a
 * person sees, and the two questions it has to keep answering are:
 *
 *   can the catalogue ever offer something the chart cannot truthfully draw?
 *   can a stored preference put something invalid on the toolbar?
 *
 * Both are "no", and both are asserted from the data rather than from a list
 * typed out a second time here — a catalogue checked against a hand-copy of
 * itself is a test that passes for the wrong reason.
 *
 * The third question is the one the alert dialogs turn on: when a chart is on a
 * resolution a stored-series subsystem cannot run, is that SAID, or substituted?
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CATALOGUE_RESOLUTIONS, DEFAULT_FAVOURITES, MAX_CUSTOM, MAX_FAVOURITES, MAX_RECENTS,
  RESOLUTION_CATALOGUE, addCustom, alertIntervalFor, isFavourite, nativeOnlyNotice,
  parseCustomEntry, parseStoredResolutions, recordRecent, removeCustom,
  storedFallbackFor, storedIntervalFor, timeframeStrip, toggleFavourite,
} from "../lib/timeframes";
import { parseResolution } from "../lib/resolution";
import { ALERT_INTERVAL_VALUES, INTERVAL_VALUES } from "../lib/types";

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// ── the catalogue ───────────────────────────────────────────────────────────

test("NOTHING IN THE CATALOGUE IS A RESOLUTION THE CHART CANNOT TRUTHFULLY DRAW", () => {
  for (const resolution of CATALOGUE_RESOLUTIONS) {
    const plan = parseResolution(resolution);
    assert.ok(plan, `${resolution} is offered but is not a resolution`);
    assert.equal(plan.id, resolution, `${resolution} is not its own canonical spelling`);
    if (!plan.native) {
      assert.ok(plan.factor > 1);
      assert.equal(plan.ms % plan.factor, 0);
    }
  }
  assert.equal(new Set(CATALOGUE_RESOLUTIONS).size, CATALOGUE_RESOLUTIONS.length,
    "a resolution appears in two groups");
});

test("every second offered is folded from one-second bars, never from a minute", () => {
  const seconds = RESOLUTION_CATALOGUE.find((g) => g.label === "Seconds");
  assert.ok(seconds);
  assert.ok(seconds.items.length > 0);
  for (const s of seconds.items) {
    assert.equal(parseResolution(s)!.source, "1s");
  }
});

test("every interval the store holds is still reachable", () => {
  // The point of the original `timeframes` module was that five supported
  // intervals had fallen off the toolbar. Adding thirty more must not do it
  // again to a different five.
  for (const stored of INTERVAL_VALUES) {
    assert.ok(CATALOGUE_RESOLUTIONS.includes(stored),
      `${stored} is served by the backend but is not in the picker`);
  }
});

test("the groups are ordered coarse-within-unit and unit-ascending", () => {
  const order = RESOLUTION_CATALOGUE.map((g) => g.label);
  assert.deepEqual(order, ["Seconds", "Minutes", "Hours", "Days"]);
  for (const group of RESOLUTION_CATALOGUE) {
    const durations = group.items.map((i) => parseResolution(i)!.ms);
    assert.deepEqual([...durations].sort((a, b) => a - b), durations,
      `${group.label} is not in ascending order`);
  }
});

// ── favourites ──────────────────────────────────────────────────────────────

test("the default strip is the six the toolbar has always shown", () => {
  assert.deepEqual([...DEFAULT_FAVOURITES], ["1m", "5m", "15m", "1h", "4h", "1d"]);
});

test("starring and unstarring, capped, in catalogue order", () => {
  let favourites: string[] = ["1m", "1h"];
  favourites = toggleFavourite(favourites, "15m");
  assert.deepEqual(favourites, ["1m", "15m", "1h"],
    "a starred resolution takes its catalogue position, so the strip never reshuffles");
  assert.ok(isFavourite(favourites, "15m"));

  favourites = toggleFavourite(favourites, "15m");
  assert.deepEqual(favourites, ["1m", "1h"], "starring twice unstars");

  // A custom resolution has no catalogue position and goes to the end, which
  // is stable for the same reason.
  favourites = toggleFavourite(favourites, "7m");
  assert.deepEqual(favourites, ["1m", "1h", "7m"]);
});

test("the strip is capped, so a toolbar cannot be starred back into three ragged rows", () => {
  let favourites: string[] = [];
  for (const r of CATALOGUE_RESOLUTIONS) favourites = toggleFavourite(favourites, r);
  assert.equal(favourites.length, MAX_FAVOURITES);
  const before = [...favourites];
  assert.deepEqual(toggleFavourite(favourites, "12h"), before, "a full strip refuses");
  // Unstarring always works, even at the cap and even down to nothing.
  for (const r of [...favourites]) favourites = toggleFavourite(favourites, r);
  assert.deepEqual(favourites, []);
  assert.deepEqual([...timeframeStrip("15m", []).quick], []);
});

test("an invalid resolution can never be starred", () => {
  assert.deepEqual(toggleFavourite(["1m"], "1w"), ["1m"]);
  assert.deepEqual(toggleFavourite(["1m"], "60m"), ["1m"]);
});

// ── recents ─────────────────────────────────────────────────────────────────

test("recents are newest-first, unique, capped, and never repeat a favourite", () => {
  let recents = recordRecent([], "45m");
  recents = recordRecent(recents, "7m");
  recents = recordRecent(recents, "45m");
  assert.deepEqual(recents, ["45m", "7m"], "using one again moves it to the front");

  // A favourite is already one click away on the strip; listing it under Recent
  // as well is a menu repeating itself.
  assert.deepEqual(recordRecent(recents, "1h", ["1h"]), ["45m", "7m"]);

  let many: string[] = [];
  for (const r of CATALOGUE_RESOLUTIONS) many = recordRecent(many, r);
  assert.equal(many.length, MAX_RECENTS);
});

// ── custom entries ──────────────────────────────────────────────────────────

test("a custom entry is accepted, or refused with a reason a person can act on", () => {
  assert.deepEqual(parseCustomEntry("45", "m"), { resolution: "45m" });
  assert.deepEqual(parseCustomEntry(" 7 ", "m"), { resolution: "7m" });
  assert.deepEqual(parseCustomEntry("30", "s"), { resolution: "30s" });
  assert.deepEqual(parseCustomEntry("3", "h"), { resolution: "3h" });

  // The refusals name the actual problem rather than saying "invalid".
  assert.match((parseCustomEntry("", "m") as { error: string }).error, /whole number/);
  assert.match((parseCustomEntry("4.5", "m") as { error: string }).error, /whole number/);
  assert.match((parseCustomEntry("0", "m") as { error: string }).error, /greater than zero/);
  assert.match((parseCustomEntry("60", "m") as { error: string }).error, /That is 1h/);
  assert.match((parseCustomEntry("60", "s") as { error: string }).error, /That is 1m/);
  assert.match((parseCustomEntry("9999", "h") as { error: string }).error, /longest resolution/);
});

test("custom entries are newest-first, capped, and never duplicate the catalogue", () => {
  let custom = addCustom([], "45m");
  assert.deepEqual(custom, [], "45m is already offered; it is not a custom entry");

  custom = addCustom(custom, "7m");
  custom = addCustom(custom, "23h");
  assert.deepEqual(custom, ["23h", "7m"]);
  custom = addCustom(custom, "7m");
  assert.deepEqual(custom, ["7m", "23h"], "re-adding moves it to the front, once");

  assert.deepEqual(removeCustom(custom, "7m"), ["23h"]);
  assert.deepEqual(addCustom(custom, "1w"), custom, "an invalid entry changes nothing");

  let many: string[] = [];
  for (let n = 1; n <= 40; n++) many = addCustom(many, `${n * 7}m`);
  assert.ok(many.length <= MAX_CUSTOM);
});

// ── stored preferences ──────────────────────────────────────────────────────

test("A STORED LIST CANNOT PUT AN INVALID RESOLUTION ON THE TOOLBAR", () => {
  /*
   * `localStorage` holds whatever any version of this app last wrote, plus
   * whatever a person typed into a console. A `1w` from a build that once
   * offered weeks, or a `7q` from nowhere, must be dropped rather than handed
   * to the chart.
   */
  assert.deepEqual(
    parseStoredResolutions(["1m", "1w", "45m", "7q", "1m", 42, null], 8),
    ["1m", "45m"]);
  assert.deepEqual(parseStoredResolutions("not an array", 8, DEFAULT_FAVOURITES),
    [...DEFAULT_FAVOURITES]);
  assert.deepEqual(parseStoredResolutions(["1w", "2w"], 8, DEFAULT_FAVOURITES),
    [...DEFAULT_FAVOURITES], "a list that cleans to nothing falls back, never to blank");
  assert.deepEqual(parseStoredResolutions(["1w"], 8), [], "unless there is no fallback");
});

// ── where a chart resolution stops and a stored interval starts ─────────────

test("a derived resolution is not an alert, backtest or deployment timeframe", () => {
  assert.equal(storedIntervalFor("15m"), "15m");
  assert.equal(storedIntervalFor("45m"), null);
  assert.equal(storedIntervalFor("30s"), null);
  assert.equal(storedIntervalFor("1s"), "1s", "1s IS stored — the store holds it");

  assert.equal(alertIntervalFor("15m"), "15m");
  assert.equal(alertIntervalFor("45m"), null);
  assert.equal(alertIntervalFor("1s"), null,
    "the runner cannot honour once-per-bar-close on a one-second bar");
  assert.deepEqual([...ALERT_INTERVAL_VALUES], INTERVAL_VALUES.filter((i) => i !== "1s"));
});

test("A SUBSYSTEM THAT CANNOT RUN ON THIS CHART SAYS SO, AND NAMES WHAT IT WILL USE", () => {
  assert.equal(nativeOnlyNotice("15m", "alerts"), null, "nothing to say when it can");

  const derived = nativeOnlyNotice("45m", "alerts");
  assert.ok(derived);
  assert.match(derived, /45m/, "the notice names the chart's resolution");
  assert.match(derived, /3 15m bars/, "and what it is made of");
  assert.match(derived, /alerts runs on stored bars/);
  assert.equal(storedFallbackFor("45m"), "15m",
    "the dialog opens on the interval the notice named, not a nearby one");

  const seconds = nativeOnlyNotice("1s", "alerts");
  assert.ok(seconds);
  assert.match(seconds, /cannot run on 1s bars/,
    "a different reason from a derived one, because it IS a different reason");

  assert.match(nativeOnlyNotice("1w", "alerts")!, /not a resolution/);
});

test("the notice is rendered by every dialog that has one, in one component", () => {
  // Four dialogs saying it four ways is four chances for one of them to stop
  // saying it. `ResolutionNotice` is the one place it is worded.
  const notice = read("components/tv/ResolutionNotice.tsx");
  assert.match(notice, /data-resolution-notice="true"/);
  for (const modal of [
    "components/tv/PriceAlertModal.tsx",
    "components/tv/MaAlertModal.tsx",
    "components/tv/LevelAlertModal.tsx",
    "components/tv/IndicatorAlertModal.tsx",
  ]) {
    assert.match(read(modal), /<ResolutionNotice/, `${modal} can open on a substituted timeframe silently`);
  }
  // And the dialogs are handed a stated fallback rather than the raw chart
  // resolution, which the alert API would refuse.
  const dialogs = read("components/tv/ChartDialogs.tsx");
  assert.match(dialogs, /alertIntervalFor\(interval\) \?\? storedFallbackFor\(interval\)/);
  assert.match(dialogs, /nativeOnlyNotice\(interval, "alerts"\)/);
});

test("the backtester and a deployment refuse a derived resolution rather than run a nearby one", () => {
  const tester = read("components/tv/StrategyTester.tsx");
  assert.match(tester, /storedIntervalFor\(timeframe\)/);
  assert.match(tester, /backtestTimeframe === null/, "the run must be blocked, not redirected");
  assert.match(tester, /nativeOnlyNotice\(timeframe, "the backtester"\)/);

  const deploy = read("components/tv/AlertModal.tsx");
  assert.match(deploy, /storedIntervalFor\(timeframe\)/);
  assert.match(deploy, /deploymentTimeframe === null/);
});
