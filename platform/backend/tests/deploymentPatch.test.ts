import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDeploymentPatch } from "../src/api/deploymentPatch";

const SECRET = "s".repeat(32);

const existing = {
  delivery: "custom" as const,
  webhookUrl: "https://bot.alphawebstudioz.com/webhook",
  secret: SECRET,
  botUuid: null,
  buyQuoteQty: 340.01,
};

test("editing only the buy amount keeps everything else and passes", () => {
  const r = validateDeploymentPatch(existing, { buyQuoteQty: 500 });
  assert.deepEqual(r, { ok: true, patch: { buyQuoteQty: 500 } });
});

test("buy amount bounds are enforced", () => {
  for (const bad of [0, -5, 10_001, NaN, Infinity]) {
    const r = validateDeploymentPatch(existing, { buyQuoteQty: bad });
    assert.equal(r.ok, false, `buyQuoteQty ${bad} should be rejected`);
  }
});

test("short secrets are rejected; long ones accepted", () => {
  assert.equal(validateDeploymentPatch(existing, { secret: "short" }).ok, false);
  const r = validateDeploymentPatch(existing, { secret: "x".repeat(40) });
  assert.deepEqual(r, { ok: true, patch: { secret: "x".repeat(40) } });
});

test("webhook URL is validated (https + allowlisted host)", () => {
  assert.equal(validateDeploymentPatch(existing, { webhookUrl: "http://bot.alphawebstudioz.com/webhook" }).ok, false);
  assert.equal(validateDeploymentPatch(existing, { webhookUrl: "https://evil.example.com/webhook" }).ok, false);
  const r = validateDeploymentPatch(existing, { webhookUrl: "https://bot.alphawebstudioz.com/hook2" });
  assert.equal(r.ok, true);
});

test("switching to 3commas requires a bot uuid (merged view)", () => {
  assert.equal(validateDeploymentPatch(existing, { delivery: "3commas" }).ok, false);
  const r = validateDeploymentPatch(existing, { delivery: "3commas", botUuid: "uuid-1" });
  assert.equal(r.ok, true);
});

test("switching to custom without any webhook URL is rejected", () => {
  const offDep = { ...existing, delivery: "off" as const, webhookUrl: null };
  assert.equal(validateDeploymentPatch(offDep, { delivery: "custom" }).ok, false);
  const r = validateDeploymentPatch(offDep, {
    delivery: "custom",
    webhookUrl: "https://bot.alphawebstudioz.com/webhook",
  });
  assert.equal(r.ok, true);
});

test("empty patch is a no-op success", () => {
  assert.deepEqual(validateDeploymentPatch(existing, {}), { ok: true, patch: {} });
});
