import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptSecret, encryptSecret, redactPayload } from "../src/security/secrets";

test("secrets are encrypted with randomized authenticated encryption", () => {
  const value = "production-secret-value";
  const first = encryptSecret(value);
  const second = encryptSecret(value);
  assert.match(first, /^enc:/);
  assert.notEqual(first, second);
  assert.equal(decryptSecret(first), value);
  assert.equal(decryptSecret(second), value);
});

test("stored alert payloads redact credentials recursively", () => {
  const payload = redactPayload({ secret: "hidden", bot_uuid: "uuid", nested: { secret: "also-hidden" } });
  assert.deepEqual(payload, {
    secret: "[REDACTED]",
    bot_uuid: "[REDACTED]",
    nested: { secret: "[REDACTED]" },
  });
});
