import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const timeline = fs.readFileSync(path.join(ROOT, "components", "TradeOrderTimeline.tsx"), "utf8");
const manual = fs.readFileSync(path.join(ROOT, "components", "tv", "ManualTradingPanel.tsx"), "utf8");
const deployments = fs.readFileSync(path.join(ROOT, "app", "deployments", "page.tsx"), "utf8");
const api = fs.readFileSync(path.join(ROOT, "lib", "api.ts"), "utf8");

test("timeline distinguishes persisted events from current snapshot state in text", () => {
  assert.match(timeline, /Persisted event/);
  assert.match(timeline, /Current known state/);
  assert.match(timeline, /missing transitions remain missing/i);
  assert.match(timeline, /without invented precision/i);
});
test("timeline exposes technical evidence progressively and announces loading/failure", () => {
  assert.match(timeline, /<details/);
  assert.match(timeline, /Evidence &amp; identifiers/);
  assert.match(timeline, /role="status"/);
  assert.match(timeline, /role="alert"/);
  assert.match(timeline, /aria-label="Trade and order timeline"/);
});

test("natural order and deployment rows own the bounded timeline controls", () => {
  assert.match(manual, /<TradeOrderTimeline kind="manual-order" id=\{o\.id\}/);
  assert.match(deployments, /<TradeOrderTimeline kind="deployment" id=\{d\.id\}/);
  assert.match(manual, /aria-expanded=\{timelineOrderId === o\.id\}/);
  assert.match(deployments, /aria-expanded=\{timelineDeploymentId === d\.id\}/);
  assert.match(api, /manualOrderTimeline/);
  assert.match(api, /deploymentTimeline: \(id: string, limit = 50\)/);
});
