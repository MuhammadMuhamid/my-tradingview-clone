/**
 * The replay strip, on its own.
 *
 * ── Why this is not in `replay.test.tsx` ───────────────────────────────────
 *
 * The two defects here are about what the strip does when the BARS BENEATH IT
 * CHANGE, and the whole-workspace harness reaches that only by advancing a
 * fake clock far enough for real bars to close — which, on a chart that polls,
 * takes longer than a test should run. Rendering the one component and handing
 * it a new array is the same question asked directly, and it is the question:
 * both defects are in how `ReplayControls` responds to its own props.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { assertAbsent } from "./harness/env";
import React from "react";
import { ReplayControls } from "@/components/tv/ReplayControls";
import { startReplay, type ReplaySession } from "@/lib/replay";
import type { Candle } from "@/lib/types";

const MINUTE = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

/** `count` bars of `stepMs`, the last closing at `endCloseTime`. */
function ladder(count: number, stepMs: number, endCloseTime: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const closeTime = endCloseTime - (count - 1 - i) * stepMs;
    return {
      symbol: "SOLUSDT", interval: "1m",
      openTime: closeTime - stepMs + 1, closeTime,
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    } as Candle;
  });
}

const NOOP = {
  onStart: () => {}, onCancel: () => {}, onPrevious: () => {}, onNext: () => {},
  onPlaying: () => {}, onSpeed: () => {}, onDeepen: () => {}, onRepick: () => {},
  onExit: () => {},
};

/** What the calendar trigger currently says the chosen moment is. */
function chosenMoment(): string {
  const trigger = screen.getByRole("button", { name: /Historical replay date and time/i });
  return (trigger.textContent ?? "").trim();
}

test("THE PICKER'S POINT DOES NOT MOVE UNDER THE PERSON CHOOSING IT", () => {
  /*
   * TVP8 round two. The seeding effect was
   *
   *   const suggested = completed[Math.max(0, completed.length - 100)] ?? first;
   *   useEffect(() => { if (pickerOpen && suggested) setRequested(suggested.closeTime); },
   *             [pickerOpen, suggested]);
   *
   * `completed` was `candles.filter(...)`: a new array, of the same objects,
   * on every render — and once a bar CLOSED, `len - 100` resolved to a
   * genuinely different bar. So the field reset itself under the user, every
   * minute on a 1m chart and continuously on a canonical instrument.
   *
   * A suggestion is for the moment the picker OPENS.
   */
  const bars = ladder(500, MINUTE, NOW);
  const view = render(
    <ReplayControls
      candles={bars} interval="1m" bars={500} session={null} pickerOpen {...NOOP} />
  );
  const seeded = chosenMoment();
  assert.ok(seeded && seeded !== "Pick a date",
    "the picker must pre-fill a replay point from the loaded bars");

  // Three more bars close, exactly as they do while somebody reads a calendar.
  view.rerender(
    <ReplayControls
      candles={ladder(503, MINUTE, NOW + 3 * MINUTE)} interval="1m" bars={500}
      session={null} pickerOpen {...NOOP} />
  );
  assert.equal(chosenMoment(), seeded,
    "a new bar must not move the replay point the user is standing on");

  // And closing and reopening the picker DOES re-suggest, from the bars that
  // exist then — the seed is for the opening, not forbidden forever.
  const later = ladder(600, MINUTE, NOW + 100 * MINUTE);
  view.rerender(
    <ReplayControls
      candles={later} interval="1m" bars={500} session={null} pickerOpen={false} {...NOOP} />
  );
  view.rerender(
    <ReplayControls
      candles={later} interval="1m" bars={500} session={null} pickerOpen {...NOOP} />
  );
  assert.notEqual(chosenMoment(), seeded,
    "reopening the picker suggests from the bars that are there now");
  cleanup();
});

test("A WINDOW THAT CANNOT SHOW THE SESSION SAYS SO, AND OFFERS THE WAY OUT", () => {
  /*
   * TVP8 round two: start a replay on 1d sixty days back, then switch the pane
   * to 1m. Every loaded 1m bar closes after the session's point, so
   * `replayCandles` sliced an empty array — a blank pane, Prev / Next / Play
   * all disabled, and not one word about why.
   */
  const daily = ladder(400, DAY, NOW);
  const session = startReplay(daily, NOW - 60 * DAY, NOW) as ReplaySession;
  assert.ok(session);

  // First, the covered case: the ordinary strip, with its transport.
  const view = render(
    <ReplayControls
      candles={daily} interval="1d" bars={400} session={session} pickerOpen={false} {...NOOP} />
  );
  assert.ok(screen.queryByRole("button", { name: "Next replay candle" }),
    "a session its window can show gets the ordinary controls");

  // Now the pane switches to 1m and loads a week of them.
  let deepened: number | null = null;
  view.rerender(
    <ReplayControls
      candles={ladder(10_000, MINUTE, NOW)} interval="1m" bars={10_000}
      session={session} pickerOpen={false} {...NOOP}
      onDeepen={(n) => { deepened = n; }} />
  );

  const said = screen.getByRole("status").textContent ?? "";
  assert.match(said, /No 1m bar has loaded at or before/,
    `a blank pane must say why it is blank — got ${JSON.stringify(said)}`);
  assertAbsent(screen.queryByRole("button", { name: "Next replay candle" }),
    "and must not offer a transport that cannot move");

  /*
   * Sixty days of minutes is 86,700 bars with its context. Past the cap, so
   * the strip explains instead of offering a button that would appear to hang.
   */
  assertAbsent(screen.queryByText("Load more history"), "expected nothing to match");
  assert.ok(screen.getByText("Pick a new point"));
  assert.ok(screen.getByRole("button", { name: "Exit Replay" }),
    "the way out is never taken away");

  // An hourly pane is a reachable fetch, so there the button IS offered.
  view.rerender(
    <ReplayControls
      candles={ladder(500, 3_600_000, NOW)} interval="1h" bars={500}
      session={session} pickerOpen={false} {...NOOP}
      onDeepen={(n) => { deepened = n; }} />
  );
  const deepen = screen.getByText("Load more history");
  fireEvent.click(deepen);
  assert.equal(deepened, 60 * 24 + 300,
    "the depth asked for must reach past the point, with history behind it");
  cleanup();
});
