import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const file = path.join(
  process.cwd(), "src", "db", "migrations", "019_alert_delivery_observability.sql"
);
const sql = fs.readFileSync(file, "utf8");
const flat = sql.replace(/\s+/g, " ");

test("019 adds bounded delivery counts and a closed status vocabulary", () => {
  assert.match(flat, /ADD COLUMN IF NOT EXISTS push_failed integer NOT NULL DEFAULT 0/);
  assert.match(flat, /ADD COLUMN IF NOT EXISTS push_pruned integer NOT NULL DEFAULT 0/);
  assert.match(flat, /ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'no_devices'/);
  assert.match(flat, /CHECK \(push_failed >= 0 AND push_pruned >= 0\)/);
  for (const status of ["delivered", "partial_failure", "failed", "no_devices"]) {
    assert.match(sql, new RegExp(`'${status}'`));
  }
});

test("019 persists no endpoint, payload, raw error, or credential field", () => {
  assert.doesNotMatch(flat, /ADD COLUMN[^;]*(endpoint|payload|error_message|secret|credential)/i);
  assert.doesNotMatch(flat, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
});
