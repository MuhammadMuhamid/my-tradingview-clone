/**
 * What the chart SAYS when the provider refuses it.
 *
 * ── REV-UX-01, and why a source-text test did not catch it ────────────────
 *
 * `docs/TRADING_SCENE_UI_UX_CONTRACT.md` forbids a provider or fixture error
 * string as primary page copy, and `tests/uiContract.test.ts` has had a test
 * named for that rule since TVP7 — "a provider's raw words are never a
 * headline". That test reads `lib/useCandleHistory.ts` as TEXT: it asserts the
 * identifiers `errorDetail` and `errorLevel` appear in the file, and that one
 * particular template literal does not. Both assertions passed while the hard
 * -error path did exactly what the rule forbids:
 *
 *     setError((cause as Error).message)          // the provider's own words
 *     errorDetail: error ? null : …               // and no detail channel
 *
 * so a 502 from the candles route painted
 *
 *     invalid SOLUSDT 15m backfill: invalid_close_time
 *
 * across the top of the plot, as the most prominent sentence on the page.
 *
 * This test does not read the hook. It mounts the real chart workspace against
 * a fixture that answers the candles route the way a failing provider does,
 * and reads the DOM the user would be looking at. That is the standard the
 * owner-found P0 established: a guard is pinned only by a test that executes
 * the behaviour that would have failed.
 *
 * ── The vacuity guard, which this test needed on its first run ─────────────
 *
 * Written first against BTCUSDT, it was GREEN before any repair — because the
 * workspace opens on SOLUSDT, the override never matched, the chart loaded
 * perfectly and "the provider's words are not on the page" was true for the
 * one reason that proves nothing. `assertRefused` now fails the test unless
 * the fixture actually refused a request, so this file cannot go green again
 * by not reaching the code it is about.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { closeBrowser, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";

/** The workspace's own opening symbol — the route the chart actually asks for. */
const SYMBOL = "SOLUSDT";
/** Exactly the shape the reviewer saw, from the endpoint that produced it. */
const PROVIDER_WORDS = `invalid ${SYMBOL} 15m backfill: invalid_close_time`;

let refusals = 0;

/** Answer the chart's own candles route the way a failing provider does. */
function refuseWith(status: number, error: string): void {
  server.routes.set(`/api/symbols/${SYMBOL}/candles`, () => {
    refusals += 1;
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  resetBrowser();
  refusals = 0;
  refuseWith(502, PROVIDER_WORDS);
});
after(closeBrowser);

/** Every word the chart is currently showing, collapsed to one string. */
function visibleCopy(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

/** Fail loudly if the chart never actually asked the route that refuses. */
function assertRefused(): void {
  assert.ok(refusals > 0,
    "the fixture never refused anything — this test did not reach the failure path");
}

/** The band the hard-error branch renders, found by what it says, not by class. */
function failureBand(container: HTMLElement): HTMLElement {
  const bands = [...container.querySelectorAll<HTMLElement>("div")]
    .filter((el) => el.children.length <= 2
      && /could not be loaded|did not answer|unavailable/i.test(el.textContent ?? ""));
  const band = bands.at(-1);
  if (!band) throw new Error(
    `the chart reports no failure at all; copy was: ${visibleCopy(container).slice(0, 400)}`);
  return band;
}

test("REV-UX-01 — a refusing provider is not quoted as page copy", async () => {
  const chart = await mountChart();
  await settle();
  assertRefused();

  const copy = visibleCopy(chart.container);
  assert.ok(!copy.includes(PROVIDER_WORDS),
    `the provider's raw words are on the page as prose: ${copy.slice(0, 400)}`);
  assert.ok(!/invalid_close_time|backfill:/i.test(copy),
    `an internal failure token reached the reader: ${copy.slice(0, 400)}`);
});

test("REV-UX-01 — the failure is still TOLD, in the reader's vocabulary", async () => {
  const chart = await mountChart();
  await settle();
  assertRefused();

  const band = failureBand(chart.container);
  const said = (band.textContent ?? "").replace(/\s+/g, " ").trim();

  assert.ok(said.length > 0 && said.length <= 120,
    `primary copy should be one short sentence; got ${said.length} chars: ${said}`);
  assert.match(said, /could not be loaded/i,
    `the reader must be told the chart has no data; got: ${said}`);
});

test("REV-UX-01 — the provider's own words survive, in the diagnostic channel", async () => {
  const chart = await mountChart();
  await settle();
  assertRefused();

  const band = failureBand(chart.container);
  assert.equal(band.getAttribute("title"), PROVIDER_WORDS,
    "the raw cause is what a bug report needs — it moves to the tooltip, it is not discarded");
});

/**
 * ── Why the status has to travel, and not be read back out of the prose ────
 *
 * The two tests below are the ones that make `ApiError.status` load-bearing.
 * Without them the repair above passes while the reason is still guessed by
 * regular expression over the message, which is wrong in both directions:
 *
 *   a 502 whose body is `invalid SOLUSDT 15m backfill: invalid_close_time`
 *   carries no code to find, so the reader gets "Hover for the reason
 *   reported" when the truthful, actionable sentence was available; and
 *
 *   a 404 whose body names a price — `no stored candles near 503.25` — matches
 *   `5\d\d` and tells the reader the service did not answer, when it answered
 *   promptly and said the thing does not exist here.
 *
 * Both are the same defect as REV-UX-01 one layer in: the page saying
 * something other than what happened.
 */
test("REV-UX-01 — a 5xx with no code in its words still gets the useful sentence", async () => {
  const chart = await mountChart();
  await settle();
  assertRefused();

  const said = (failureBand(chart.container).textContent ?? "").replace(/\s+/g, " ").trim();
  assert.match(said, /did not answer|try again/i,
    `a 502 is a service that did not answer, and the reader can act on that; got: ${said}`);
});

test("REV-UX-01 — a price in the message is not mistaken for a status code", async () => {
  refuseWith(404, "no stored candles near 503.25");
  const chart = await mountChart();
  await settle();
  assertRefused();

  const said = (failureBand(chart.container).textContent ?? "").replace(/\s+/g, " ").trim();
  assert.ok(!/did not answer/i.test(said),
    `the service answered — it said the thing is not here; got: ${said}`);
  assert.match(said, /does not serve it/i,
    `a 404 is "not here", which is a different thing for the reader to do; got: ${said}`);
});
