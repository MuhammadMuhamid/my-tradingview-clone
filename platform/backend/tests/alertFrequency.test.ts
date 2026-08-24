/**
 * The four alert frequency modes.
 *
 * The most important assertion in this file is the FIRST one: every existing
 * alert migrates to `once_per_bar_close`, and that mode behaves exactly as the
 * runner did before frequencies existed. Everything else is new capability;
 * that one is a promise not to break what already works.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_FREQUENCIES, acceptsIntrabarSample, cooldownElapsed, decideFire,
  DEFAULT_ALERT_FREQUENCY, describeFrequency, explainFrequency, initialFireState,
  INTRABAR_WARNING, isAlertFrequency, isBarCloseOnly, isIntrabar, MINUTE_MS,
  stateAfterFire, type AlertFrequency, type FireState,
} from "../src/alerts/alertFrequency";

const BAR = 900_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % BAR);
const NOW = T0 + BAR;

const state = (over: Partial<FireState> = {}): FireState => ({
  ...initialFireState(60),
  ...over,
});

/** One evaluation: condition true, ask whether it may notify. */
const ask = (
  frequency: AlertFrequency,
  s: FireState,
  ctx: { barTime?: number; sampleIsClosedBar?: boolean; now?: number } = {}
) =>
  decideFire(frequency, s, {
    barTime: ctx.barTime ?? T0,
    sampleIsClosedBar: ctx.sampleIsClosedBar ?? true,
    now: ctx.now ?? NOW,
  });

// ── The default, and the migration promise ──────────────────────────────────

test("the default is once_per_bar_close — the migration value for every existing alert", () => {
  assert.equal(DEFAULT_ALERT_FREQUENCY, "once_per_bar_close");
  assert.deepEqual([...ALERT_FREQUENCIES], [
    "once_only", "once_per_bar", "once_per_bar_close", "once_per_minute",
  ]);
});

test("once_per_bar_close reproduces the pre-frequency behaviour exactly", () => {
  // Before frequencies existed the rule was: evaluate the closed bar, fire when
  // `cooldownElapsed(lastFiredAt, cooldownMin)`. Nothing else.
  const fresh = state({ lastFiredAt: null });
  assert.deepEqual(ask("once_per_bar_close", fresh), { fire: true });

  const justFired = state({ lastFiredAt: NOW - 30 * MINUTE_MS, cooldownMin: 60 });
  assert.deepEqual(ask("once_per_bar_close", justFired, { barTime: T0 + BAR }), {
    fire: false, reason: "within_cooldown",
  });

  const cooledDown = state({ lastFiredAt: NOW - 61 * MINUTE_MS, cooldownMin: 60 });
  assert.deepEqual(ask("once_per_bar_close", cooledDown, { barTime: T0 + BAR }), { fire: true });

  // A zero cooldown fires on every closed bar, as it always did.
  const noCooldown = state({ lastFiredAt: NOW - 1000, cooldownMin: 0 });
  assert.deepEqual(ask("once_per_bar_close", noCooldown, { barTime: T0 + BAR }), { fire: true });
});

test("once_per_bar_close NEVER acts on a forming candle", () => {
  // Letting it would silently turn every existing alert into an intrabar one.
  assert.deepEqual(
    ask("once_per_bar_close", state(), { sampleIsClosedBar: false }),
    { fire: false, reason: "wrong_sample_kind" }
  );
  assert.equal(isBarCloseOnly("once_per_bar_close"), true);
  assert.equal(acceptsIntrabarSample("once_per_bar_close"), false);
});

test("A TRANSIENT INTRABAR CROSSING THAT IS FALSE AT CLOSE PRODUCES NO once_per_bar_close ALERT", () => {
  // The required scenario, stated as the runner sees it: the condition is true
  // on a forming candle and false when it closes. The forming sample is
  // refused, and the closed sample is never presented as true.
  const s = state();
  assert.equal(ask("once_per_bar_close", s, { sampleIsClosedBar: false }).fire, false);
  // At the close the condition is false, so the runner does not ask at all —
  // and the alert's state is untouched.
  assert.equal(s.lastFiredAt, null);
  assert.equal(s.lastFiredBarTime, null);
});

// ── once_per_bar ────────────────────────────────────────────────────────────

test("REPEATED TRUE UPDATES IN ONE CANDLE PRODUCE EXACTLY ONE once_per_bar ALERT", () => {
  let s = state({ cooldownMin: 0 });
  let fires = 0;
  // Forty intrabar ticks, all true, inside the same candle.
  for (let tick = 0; tick < 40; tick++) {
    const now = T0 + tick * 1000;
    const decision = decideFire("once_per_bar", s, {
      barTime: T0, sampleIsClosedBar: false, now,
    });
    if (decision.fire) {
      fires++;
      s = stateAfterFire("once_per_bar", s, { barTime: T0, now, delivered: true });
    }
  }
  assert.equal(fires, 1);
  assert.equal(s.lastFiredBarTime, T0);
});

test("once_per_bar fires again on the NEXT candle", () => {
  let s = state({ cooldownMin: 0 });
  const fired: number[] = [];
  for (const barTime of [T0, T0 + BAR, T0 + 2 * BAR]) {
    for (let tick = 0; tick < 5; tick++) {
      const now = barTime + tick * 1000;
      if (decideFire("once_per_bar", s, { barTime, sampleIsClosedBar: false, now }).fire) {
        fired.push(barTime);
        s = stateAfterFire("once_per_bar", s, { barTime, now, delivered: true });
      }
    }
  }
  assert.deepEqual(fired, [T0, T0 + BAR, T0 + 2 * BAR]);
});

test("the legacy cooldown does NOT apply to once_per_bar", () => {
  // A 60-minute cooldown on a 15m chart would defeat the mode entirely.
  const s = state({ lastFiredAt: NOW - 1000, lastFiredBarTime: T0, cooldownMin: 60 });
  assert.deepEqual(ask("once_per_bar", s, { barTime: T0 + BAR, sampleIsClosedBar: false }), {
    fire: true,
  });
});

test("A RECONNECT DOES NOT DUPLICATE: the replayed bar has the same open time", () => {
  let s = state({ cooldownMin: 0 });
  const now = T0 + 5_000;
  const first = decideFire("once_per_bar", s, { barTime: T0, sampleIsClosedBar: false, now });
  assert.equal(first.fire, true);
  s = stateAfterFire("once_per_bar", s, { barTime: T0, now, delivered: true });

  // The websocket drops, reconnects, and the same candle is delivered again.
  const replay = decideFire("once_per_bar", s, {
    barTime: T0, sampleIsClosedBar: false, now: now + 30_000,
  });
  assert.deepEqual(replay, { fire: false, reason: "already_fired_this_bar" });

  // The same protection covers bar-close mode, where a reconnect can re-deliver
  // the just-closed bar.
  const closeState = state({ lastFiredBarTime: T0, lastFiredAt: now, cooldownMin: 0 });
  assert.deepEqual(ask("once_per_bar_close", closeState, { barTime: T0 }), {
    fire: false, reason: "already_fired_this_bar",
  });
});

// ── once_only ───────────────────────────────────────────────────────────────

test("once_only fires once and then reports itself completed", () => {
  let s = state();
  assert.deepEqual(ask("once_only", s), { fire: true });
  s = stateAfterFire("once_only", s, { barTime: T0, now: NOW, delivered: true });
  assert.equal(s.completed, true);
  assert.deepEqual(ask("once_only", s), { fire: false, reason: "completed" });
});

test("ONCE_ONLY STAYS INACTIVE AFTER RESTART", () => {
  // `completed` is the persisted field, so a restart is a round trip through
  // the database and back into `decideFire` with the same value.
  let s = state();
  s = stateAfterFire("once_only", s, { barTime: T0, now: NOW, delivered: true });

  const persisted = JSON.parse(JSON.stringify(s)) as FireState;
  const afterRestart: FireState = {
    lastFiredAt: persisted.lastFiredAt,
    lastFiredBarTime: persisted.lastFiredBarTime,
    completed: persisted.completed,
    cooldownMin: persisted.cooldownMin,
  };
  assert.equal(afterRestart.completed, true);

  // Days later, on a different bar, on any cadence.
  for (const closed of [true, false]) {
    assert.deepEqual(
      decideFire("once_only", afterRestart, {
        barTime: T0 + 1000 * BAR, sampleIsClosedBar: closed, now: NOW + 30 * 86_400_000,
      }),
      { fire: false, reason: "completed" }
    );
  }
});

test("a FAILED delivery leaves a once_only alert armed", () => {
  // Deactivating an alert whose notification never reached a device would lose
  // the one alert the user asked for.
  let s = state();
  s = stateAfterFire("once_only", s, { barTime: T0, now: NOW, delivered: false });
  assert.equal(s.completed, false);
  assert.deepEqual(ask("once_only", s), { fire: true });
});

test("once_only accepts an intrabar sample — 'once' means the first moment", () => {
  assert.equal(acceptsIntrabarSample("once_only"), true);
  assert.deepEqual(ask("once_only", state(), { sampleIsClosedBar: false }), { fire: true });
});

// ── once_per_minute ─────────────────────────────────────────────────────────

test("once_per_minute fires at most once a minute while the condition stays true", () => {
  let s = state({ cooldownMin: 0 });
  const fires: number[] = [];
  // A tick every ten seconds for five minutes, condition true throughout.
  for (let t = 0; t <= 300; t += 10) {
    const now = T0 + t * 1000;
    if (decideFire("once_per_minute", s, { barTime: T0, sampleIsClosedBar: false, now }).fire) {
      fires.push(t);
      s = stateAfterFire("once_per_minute", s, { barTime: T0, now, delivered: true });
    }
  }
  assert.deepEqual(fires, [0, 60, 120, 180, 240, 300]);
});

test("ONCE_PER_MINUTE REMAINS CAPPED ACROSS RESTART", () => {
  let s = state({ cooldownMin: 0 });
  const firedAt = T0 + 10_000;
  s = stateAfterFire("once_per_minute", s, { barTime: T0, now: firedAt, delivered: true });

  // Persist, restart, reload.
  const afterRestart = JSON.parse(JSON.stringify(s)) as FireState;
  assert.equal(afterRestart.lastFiredAt, firedAt);

  // Thirty seconds after the fire — still inside the minute.
  assert.deepEqual(
    decideFire("once_per_minute", afterRestart, {
      barTime: T0, sampleIsClosedBar: false, now: firedAt + 30_000,
    }),
    { fire: false, reason: "within_minute" }
  );
  // One second short of the minute.
  assert.equal(
    decideFire("once_per_minute", afterRestart, {
      barTime: T0, sampleIsClosedBar: false, now: firedAt + MINUTE_MS - 1,
    }).fire,
    false
  );
  // Exactly a minute later.
  assert.equal(
    decideFire("once_per_minute", afterRestart, {
      barTime: T0, sampleIsClosedBar: false, now: firedAt + MINUTE_MS,
    }).fire,
    true
  );
});

test("once_per_minute is not bounded by the candle — it spans bars", () => {
  const s = state({ lastFiredAt: T0, lastFiredBarTime: T0, cooldownMin: 0 });
  // A new bar, but only ten seconds later: still capped.
  assert.deepEqual(
    decideFire("once_per_minute", s, {
      barTime: T0 + BAR, sampleIsClosedBar: false, now: T0 + 10_000,
    }),
    { fire: false, reason: "within_minute" }
  );
});

// ── Classification and copy ─────────────────────────────────────────────────

test("the intrabar modes are exactly once_per_bar and once_per_minute", () => {
  assert.equal(isIntrabar("once_per_bar"), true);
  assert.equal(isIntrabar("once_per_minute"), true);
  assert.equal(isIntrabar("once_per_bar_close"), false);
  assert.equal(isIntrabar("once_only"), false);
});

test("the intrabar warning is exactly the required sentence", () => {
  assert.equal(
    INTRABAR_WARNING,
    "May trigger before the candle closes. The condition can become false again before bar close."
  );
  // And it appears in the explanation of both intrabar modes, and neither other.
  assert.ok(explainFrequency("once_per_bar").includes(INTRABAR_WARNING));
  assert.ok(explainFrequency("once_per_minute").includes(INTRABAR_WARNING));
  assert.ok(!explainFrequency("once_per_bar_close").includes(INTRABAR_WARNING));
  assert.ok(!explainFrequency("once_only").includes(INTRABAR_WARNING));
});

test("every frequency has a label and an explanation", () => {
  for (const f of ALERT_FREQUENCIES) {
    assert.ok(describeFrequency(f).length > 0, f);
    assert.ok(explainFrequency(f).length > 20, f);
    assert.equal(isAlertFrequency(f), true, f);
  }
  assert.equal(isAlertFrequency("hourly"), false);
  assert.equal(isAlertFrequency(undefined), false);
});

test("the legacy cooldown helper is unchanged", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  const fired = now - 30 * MINUTE_MS;
  assert.equal(cooldownElapsed(fired, 60, now), false);
  assert.equal(cooldownElapsed(fired, 15, now), true);
  assert.equal(cooldownElapsed(null, 60, now), true);
  assert.equal(cooldownElapsed(fired, 0, now), true);
});
