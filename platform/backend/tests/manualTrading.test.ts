import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, signManualCommand } from "../src/manualTrading/client";

test("platform signs the distinct manual command canonical method/path/body", () => {
  const body = { side: "BUY", nested: { z: 2, a: 1 } };
  const input = { method: "POST", path: "/api/manual-trading/orders?z=2&a=1",
    timestamp: "1700000000000", nonce: "nonce_1234567890123456",
    requestId: "request_123456789012", body };
  const secret = "h".repeat(40);
  const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  const expected = `v1=${createHmac("sha256", secret).update([
    "POST", "/api/manual-trading/orders?a=1&z=2", input.timestamp,
    input.nonce, input.requestId, bodyHash,
  ].join("\n")).digest("hex")}`;
  assert.equal(signManualCommand(input, secret), expected);
  assert.notEqual(signManualCommand({ ...input, body: { side: "SELL" } }, secret), expected);
});

test("manual HMAC material has no frontend reference", () => {
  const frontend = path.resolve(__dirname, "../../frontend");
  const files: string[] = [];
  const visit = (dir: string) => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === "node_modules" || item.name === ".next") continue;
    const full = path.join(dir, item.name); if (item.isDirectory()) visit(full); else files.push(full);
  }};
  visit(frontend);
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /MANUAL_TRADING_HMAC_SECRET|x-manual-signature/i, file);
  }
});
