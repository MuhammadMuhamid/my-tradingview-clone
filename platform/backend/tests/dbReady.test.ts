/**
 * Waiting for the database at boot — and refusing to wait for the wrong thing.
 *
 * The outage this came from: a deploy snapshots RDS, the backend restarts
 * against a database that is briefly unresponsive, the 5 s pool timeout fires
 * inside `migrate()`, the process crashes, Docker restarts it, and the same
 * five-second gamble runs again. A database slow for one minute produced a
 * deploy down for twenty.
 *
 * The rule that keeps this honest: wait for a database that has NOT ANSWERED,
 * never for one that answered and said no. A migration whose SQL is wrong must
 * still fail on the first attempt — retrying it for two minutes would delay
 * the crash that tells an operator the deploy is bad.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isConnectionError, waitForDatabase } from "../src/db/dbReady";

/** A Postgres error: the server replied, carrying a five-character SQLSTATE. */
const sqlError = (code: string): Error =>
  Object.assign(new Error(`postgres said ${code}`), { code });

/** A socket error: nothing answered. */
const connError = (message: string, code?: string): Error =>
  code ? Object.assign(new Error(message), { code }) : new Error(message);

// ── telling the two apart ──────────────────────────────────────────────────

test("a SQLSTATE means the database answered, so it is not a connection error", () => {
  for (const code of ["23505", "42P10", "23514", "40001", "0A000"]) {
    assert.equal(isConnectionError(sqlError(code)), false, code);
  }
});

test("socket failures and bare timeouts are connection errors", () => {
  const cases = [
    connError("Connection terminated due to connection timeout"),
    connError("Connection terminated unexpectedly"),
    connError("connect ECONNREFUSED 10.0.0.5:5432", "ECONNREFUSED"),
    connError("connect ETIMEDOUT", "ETIMEDOUT"),
    connError("getaddrinfo ENOTFOUND db.internal", "ENOTFOUND"),
  ];
  for (const error of cases) {
    assert.equal(isConnectionError(error), true, error.message);
  }
});

test("a Node error code is never mistaken for a SQLSTATE", () => {
  // Both live in `code`. Only SQLSTATE is exactly five characters, which is
  // why the shape is tested rather than the message — messages change between
  // driver versions, the SQLSTATE format does not.
  assert.equal(isConnectionError(connError("x", "ECONNRESET")), true);
  assert.equal(isConnectionError(connError("x", "EPIPE")), true);
  assert.equal(isConnectionError(sqlError("42883")), false);
});

// ── the waiting itself ─────────────────────────────────────────────────────

const recorder = () => {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => { delays.push(ms); } };
};

test("a database that is ready is not waited for at all", async () => {
  const { delays, sleep } = recorder();
  let pings = 0;
  await waitForDatabase({ ping: async () => { pings++; }, sleep });
  assert.equal(pings, 1);
  assert.deepEqual(delays, [], "no sleep on the happy path");
});

test("it keeps trying while the database is unreachable, then succeeds", async () => {
  const { delays, sleep } = recorder();
  let pings = 0;
  await waitForDatabase({
    sleep,
    ping: async () => {
      pings++;
      if (pings < 4) throw connError("Connection terminated due to connection timeout");
    },
  });
  assert.equal(pings, 4, "three failures, then the database came back");
  assert.deepEqual(delays, [500, 1000, 2000], "the delay doubles");
});

test("the delay is capped, so a long outage does not become an eternal sleep", async () => {
  const { delays, sleep } = recorder();
  await assert.rejects(waitForDatabase({
    sleep, attempts: 8, baseDelayMs: 1000, maxDelayMs: 4000,
    ping: async () => { throw connError("Connection terminated unexpectedly"); },
  }));
  assert.deepEqual(delays, [1000, 2000, 4000, 4000, 4000, 4000, 4000]);
});

test("a SQL error is rethrown on the FIRST attempt, never retried", async () => {
  const { delays, sleep } = recorder();
  let pings = 0;
  await assert.rejects(
    waitForDatabase({
      sleep,
      ping: async () => { pings++; throw sqlError("42P10"); },
    }),
    /42P10/
  );
  assert.equal(pings, 1, "a database that answered is not worth waiting for");
  assert.deepEqual(delays, [], "and it must not delay the crash that reports the real fault");
});

test("exhausting the budget rethrows the LAST error, not a generic one", async () => {
  await assert.rejects(
    waitForDatabase({
      attempts: 3, sleep: async () => {},
      ping: async () => { throw connError("Connection terminated due to connection timeout"); },
    }),
    /Connection terminated due to connection timeout/,
    "the crash must still say what actually went wrong"
  );
});

test("the default budget spans the snapshot window that caused the outage", async () => {
  const { delays, sleep } = recorder();
  await assert.rejects(waitForDatabase({
    sleep, ping: async () => { throw connError("Connection terminated unexpectedly"); },
  }));
  const total = delays.reduce((a, b) => a + b, 0);
  assert.ok(
    total >= 90_000 && total <= 180_000,
    `default total wait was ${total}ms; it should cover a slow RDS snapshot ` +
    "(~2 minutes) without hiding a database that is genuinely gone"
  );
});
