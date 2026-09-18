/**
 * The platform's own dedupe key, offered to the platform's own order routes.
 *
 * ── The contradiction ─────────────────────────────────────────────────────
 *
 * `contract/webhookContract.ts` defines the canonical key as
 * `<L|X>-<barOpenTimeMs>[-<exitLeg>]`. A bar open time is 13 digits for every
 * date this product can trade, so a key with no exit leg is exactly 15
 * characters:
 *
 *     dedupeKey("buy",  1758211200000)  ->  "L-1758211200000"   (15)
 *     dedupeKey("sell", 1758211200000)  ->  "X-1758211200000"   (15)
 *
 * All four X3-X5 order routes validated `{16,160}`. So every key the platform
 * can emit for an ENTRY, and every plain signal EXIT, was rejected by the route
 * built to receive it — 400, "dedupeKey must be a durable bounded identity".
 * Only the exit-leg forms (`-tp1`, `-stop`, ...) were long enough to pass.
 *
 * ── Why the route was the wrong side to keep ──────────────────────────────
 *
 * The key format is not this repository's to choose. Its entire purpose is that
 * Pine and the platform derive byte-identical keys for the same bar, which is
 * why it was moved onto bar open time in the first place (X-02). Lengthening
 * the key to satisfy a route would break the agreement the key exists to
 * express. 16 was an arbitrary floor; the canonical form is the requirement.
 *
 * ── Why it never showed up ────────────────────────────────────────────────
 *
 * Nothing in production calls these four routes — they have no frontend client
 * at all, which is the same evidence that reclassified the order-ticket finding
 * to a dead surface. A contradiction between two halves of a contract stays
 * invisible while one half has no callers, and becomes a launch-day 400 the
 * moment someone wires it. This test asks the question that was never asked:
 * does the receiver accept what the sender emits?
 *
 * The bound is derived from the emitter here rather than restated, so the two
 * cannot drift apart again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeKey, type ExitLeg } from "../src/contract/webhookContract";

/** The pattern every X3-X5 order route applies to `dedupeKey`. */
const ROUTE_DEDUPE_PATTERN = /^[A-Za-z0-9:_-]{15,160}$/;

const ROUTE_FILES = [
  "spotExecution.ts",
  "derivativeExecution.ts",
  "equityExecution.ts",
  "traditionalExecution.ts",
] as const;

/** A real bar open time: 13 digits, as every epoch-ms instant is until 2286. */
const BAR_OPEN_MS = 1758211200000;
const EXIT_LEGS: readonly ExitLeg[] = ["tp1", "tp2", "runner", "stop", "signal"];

function everyCanonicalKey(): string[] {
  const keys = [dedupeKey("buy", BAR_OPEN_MS), dedupeKey("sell", BAR_OPEN_MS)];
  for (const leg of EXIT_LEGS) {
    keys.push(dedupeKey("buy", BAR_OPEN_MS, leg), dedupeKey("sell", BAR_OPEN_MS, leg));
  }
  return keys;
}

test("every key the platform can emit is accepted by the routes that receive it", () => {
  const rejected = everyCanonicalKey().filter((key) => !ROUTE_DEDUPE_PATTERN.test(key));
  assert.deepEqual(rejected, [],
    "a route that refuses its own sender's canonical key is a launch-day 400");
});

test("an entry key is 15 characters, which is the floor the routes must admit", () => {
  // Stated explicitly because this exact number is why the bound moved. If the
  // canonical form ever grows a character, this fails and the routes get looked
  // at deliberately rather than by accident.
  assert.equal(dedupeKey("buy", BAR_OPEN_MS), "L-1758211200000");
  assert.equal(dedupeKey("buy", BAR_OPEN_MS).length, 15);
  assert.equal(dedupeKey("sell", BAR_OPEN_MS).length, 15);
});

test("the bound still refuses an identity too short to be durable", () => {
  // Relaxing 16 to 15 must not turn the check into a formality.
  for (const weak of ["L-1", "x", "", "L-175821120000"]) {
    assert.equal(ROUTE_DEDUPE_PATTERN.test(weak), false, `${weak} should be refused`);
  }
});

test("all four order routes carry the same dedupe bound", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL("../src/api/routes/", import.meta.url));

  for (const file of ROUTE_FILES) {
    const source = await readFile(dir + file, "utf8");
    assert.match(source, /\{15,160\}/,
      `${file} must admit the canonical 15-character entry key`);
    assert.doesNotMatch(source, /\[A-Za-z0-9:_-\]\{16,160\}/,
      `${file} still carries the bound that rejected its own sender's key`);
  }
});
