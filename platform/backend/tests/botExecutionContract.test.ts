/**
 * P-81 cross-repository contract: the Platform validator accepts the shared
 * v1 fixture exactly (the Bot's own test proves it records that shape). With
 * TRADING_SCENE_BOT_ROOT set, the two fixture copies must be byte-identical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalizeExecutionEvent } from "../src/botExecutions/notifier";

const fixturePath = path.join(import.meta.dirname, "fixtures", "executionEvent.v1.json");

test("the shared v1 execution event fixture validates with every field kept", () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  const normalized = normalizeExecutionEvent(fixture) as unknown as Record<string, unknown>;
  const { contractVersion: _v, type: _t, ...rest } = fixture;
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(rest).sort());
  for (const [key, value] of Object.entries(rest)) assert.deepEqual(normalized[key], value, key);
});

test("the fixture is byte-identical in the Bot repository", (t) => {
  const botRoot = process.env.TRADING_SCENE_BOT_ROOT;
  if (!botRoot) { t.skip("TRADING_SCENE_BOT_ROOT not set"); return; }
  assert.equal(fs.readFileSync(path.join(botRoot, "backend", "tests", "fixtures", "executionEvent.v1.json"), "utf8"),
    fs.readFileSync(fixturePath, "utf8"));
});
