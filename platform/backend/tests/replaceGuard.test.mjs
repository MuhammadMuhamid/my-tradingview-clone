/**
 * OPT-27 — the AWS scripts that rewrite the deployment table.
 *
 * They ran `DELETE FROM deployments` and re-created every row flat, with
 * `--dry` as the opt-in rather than the default; one of the four refused to run
 * while a locally tracked position was open and the other three did not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoOpenPositions, parseWriteIntent,
} from "../../deployment/aws/lib/replaceGuard.mjs";

test("writing requires --apply; no flag at all is a preview", () => {
  assert.equal(parseWriteIntent([], "s").apply, false);
  assert.match(parseWriteIntent([], "s").explain(), /Nothing was written/);
  assert.equal(parseWriteIntent(["--dry"], "s").apply, false);
  assert.equal(parseWriteIntent(["--apply"], "s").apply, true);
  assert.match(parseWriteIntent(["--apply"], "s").explain(), /APPLYING/);
});

test("--apply and --dry together are a contradiction, not a silent winner", () => {
  assert.throws(() => parseWriteIntent(["--apply", "--dry"], "s"), /contradict/);
});

test("an open position stops the replacement, and the message names the symbols", async () => {
  const pool = { query: async () => ({ rows: [{ symbol: "SOLUSDT" }, { symbol: "TIAUSDT" }] }) };
  await assert.rejects(
    () => assertNoOpenPositions(pool, "replace_x.mjs"),
    (err) => /SOLUSDT, TIAUSDT/.test(err.message) && /loses the entry, stop and target/.test(err.message)
  );
});

test("a flat table proceeds", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  await assertNoOpenPositions(pool, "replace_x.mjs");
});
