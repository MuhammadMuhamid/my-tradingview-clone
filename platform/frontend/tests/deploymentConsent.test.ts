import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { activationAcknowledgement } from "../lib/deploymentConsent";

const base = { symbol: "SOLUSDT", timeframe: "5m", buyQuoteQty: 800 };

test("live activation acknowledgement names immediacy, real orders and size", () => {
  for (const delivery of ["custom", "3commas"] as const) {
    const text = activationAcknowledgement({ ...base, delivery });
    assert.match(text, /SOLUSDT 5m/);
    assert.match(text, /immediately/);
    assert.match(text, /real 800 USDT buy orders/);
  }
});

test("non-live modes state that no order is sent", () => {
  assert.match(activationAcknowledgement({ ...base, delivery: "paper" }), /PAPER mode.*no order is sent/);
  assert.match(activationAcknowledgement({ ...base, delivery: "off" }), /Delivery is off.*no orders are sent/);
});

test("deployments page gates Activate but leaves Pause direct", () => {
  const page = fs.readFileSync(path.join(import.meta.dirname, "../app/deployments/page.tsx"), "utf8");
  assert.match(page, /setActivationTarget\(d\)/, "inactive rows must open the consent dialog");
  assert.match(page, /!activationAcknowledged/, "confirmation must remain disabled until checked");
  assert.match(page, /api\.pauseDeployment\(d\.id\)/, "Pause must remain a direct safety action");
});
