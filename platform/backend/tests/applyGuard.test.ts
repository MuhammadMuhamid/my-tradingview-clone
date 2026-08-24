/**
 * OPT-26 / OPT-27 — the deployment helpers must preview by default, and must
 * never apply an order size that only exists because it was typed into a file.
 *
 * Six `scripts/apply_*.ts` wrote deployment rows — several of them
 * `status='active'`, which is live order flow — with no dry-run flag of any
 * kind, and between them four different hardcoded sizes: 70.01, 320.01, 340.01
 * and 800. None of them matched the 340.01 the handoff document named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApplyGuardError, parseApplyIntent, requireApplyFlag,
} from "../scripts/lib/applyGuard";

const OPTS = { script: "apply_thing.ts", historicalBuy: 320.01 };

test("nothing is applied without --apply", () => {
  const intent = parseApplyIntent(["SOLUSDT", "12"], OPTS);
  assert.equal(intent.apply, false);
  assert.match(intent.banner(), /PREVIEW ONLY/);
  assert.deepEqual(intent.rest, ["SOLUSDT", "12"]);
});

test("applying without an explicit order size is REFUSED, and says what it used to use", () => {
  assert.throws(
    () => parseApplyIntent(["SOLUSDT", "12", "--apply"], OPTS),
    (err: unknown) => err instanceof ApplyGuardError && /320\.01/.test((err as Error).message)
  );
});

test("an explicit size applies, and the flags never reach the positional arguments", () => {
  const intent = parseApplyIntent(["SOLUSDT", "12", "--apply", "--buy", "150"], OPTS);
  assert.equal(intent.apply, true);
  assert.equal(intent.buyQuoteQty, 150);
  assert.deepEqual(intent.rest, ["SOLUSDT", "12"]);
  assert.match(intent.banner(), /APPLYING with buy 150/);
});

test("the preview shows the historical size without committing to it", () => {
  const intent = parseApplyIntent(["SOLUSDT", "12"], OPTS);
  assert.equal(intent.buyQuoteQty, 320.01);
  assert.equal(intent.apply, false);
});

test("a size that is not a positive number is refused", () => {
  for (const bad of ["0", "-5", "abc", "NaN"]) {
    assert.throws(
      () => parseApplyIntent(["S", "1", "--apply", "--buy", bad], OPTS),
      ApplyGuardError, `--buy ${bad}`
    );
  }
  assert.throws(() => parseApplyIntent(["S", "1", "--buy"], OPTS), ApplyGuardError);
  assert.throws(() => parseApplyIntent(["S", "1", "--buy", "--apply"], OPTS), ApplyGuardError);
});

test("scripts whose size is already an argument still preview by default", () => {
  const preview = requireApplyFlag(["SOLUSDT", "12", "150"], "apply_rank_deployment.ts");
  assert.equal(preview.apply, false);
  assert.deepEqual(preview.rest, ["SOLUSDT", "12", "150"]);
  const applying = requireApplyFlag(["SOLUSDT", "12", "150", "--apply"], "apply_rank_deployment.ts");
  assert.equal(applying.apply, true);
  assert.deepEqual(applying.rest, ["SOLUSDT", "12", "150"]);
});
