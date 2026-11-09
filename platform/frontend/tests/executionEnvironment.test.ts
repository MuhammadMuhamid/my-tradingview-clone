/**
 * One word, one colour. The Journal's environment badges and the chart's
 * trading-state chip used opposite colours for the same words (review A4);
 * both now read lib/executionEnvironment. And the Trade panel no longer calls
 * the bot's dry run "PAPER", which is the Platform's own paper engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  EXECUTION_ENVIRONMENT_LABEL, EXECUTION_ENVIRONMENT_TONE, NOT_REAL_TONE, WARN_TONE,
} from "../lib/executionEnvironment";

const read = (file: string) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("warn where it could be real money, neutral where it cannot", () => {
  assert.deepEqual(EXECUTION_ENVIRONMENT_LABEL, { REAL: "REAL", TESTNET: "TESTNET", DRY_RUN: "DRY RUN", UNKNOWN: "UNKNOWN" });
  assert.equal(EXECUTION_ENVIRONMENT_TONE.REAL, WARN_TONE);
  assert.equal(EXECUTION_ENVIRONMENT_TONE.UNKNOWN, WARN_TONE);
  assert.equal(EXECUTION_ENVIRONMENT_TONE.TESTNET, NOT_REAL_TONE);
  assert.equal(EXECUTION_ENVIRONMENT_TONE.DRY_RUN, NOT_REAL_TONE);
  assert.match(WARN_TONE, /text-warn/);
  assert.doesNotMatch(NOT_REAL_TONE, /warn|accent|text-up|text-down/);
});

test("the Journal and the chart strip take words and colours from that one map", () => {
  const page = read("app/journal/page.tsx");
  const strip = read("components/tv/TradingStateStrip.tsx");
  for (const [name, source] of [["journal", page], ["strip", strip]] as const) {
    assert.match(source, /from "@\/lib\/executionEnvironment"/, name);
  }
  assert.match(strip, /EXECUTION_ENVIRONMENT_TONE\[executionEnvironment\]/);
  assert.match(page, /\.\.\.EXECUTION_ENVIRONMENT_TONE, PAPER: sourceStyle\.PAPER/);
  assert.match(page, /\.\.\.EXECUTION_ENVIRONMENT_LABEL, PAPER: "PAPER"/);
  // No surface keeps a private copy of an environment colour.
  assert.doesNotMatch(page, /TESTNET: "border-|DRY_RUN: "border-|UNKNOWN: "border-|REAL: "border-/);
  assert.doesNotMatch(strip, /"border border-border-strong bg-surface-2 text-ink"/);
});

test("the Trade panel calls the bot's dry run DRY RUN (simulated), never PAPER SIMULATION", () => {
  const panel = read("components/tv/ManualTradingPanel.tsx");
  assert.match(panel, /"DRY RUN \(simulated\)"/);
  assert.doesNotMatch(panel, /PAPER SIMULATION/);
});
