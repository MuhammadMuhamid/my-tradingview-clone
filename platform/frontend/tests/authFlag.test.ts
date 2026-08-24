/**
 * X-10 / FE-03: the frontend read AUTH_ENABLED as opt-in while the backend read
 * it as opt-out, so `AUTH_ENABLED=1` produced a gated API behind an ungated UI.
 * One rule now, and it is the fail-closed direction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAuthEnabled } from "../lib/authFlag";

test("unset means enabled — the gate is opt-out, not opt-in", () => {
  assert.equal(parseAuthEnabled(undefined), true);
  assert.equal(parseAuthEnabled(null), true);
  assert.equal(parseAuthEnabled(""), true);
});

test("only the exact string false disables the gate", () => {
  assert.equal(parseAuthEnabled("false"), false);
  assert.equal(parseAuthEnabled("FALSE"), false);
  assert.equal(parseAuthEnabled(" false "), false);
});

test("every other value leaves the gate on, including the ones that used to disable it", () => {
  for (const raw of ["true", "1", "0", "yes", "no", "off", "disabled", "nope"]) {
    assert.equal(parseAuthEnabled(raw), true, raw);
  }
});
