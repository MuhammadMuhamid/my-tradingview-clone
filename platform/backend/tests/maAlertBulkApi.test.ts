import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { bulkAlertHandler, MAX_BULK_ALERTS } from "../src/api/routes/maAlerts";
import type { BulkAlertAction } from "../src/types/maAlerts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

async function request(
  body: Record<string, unknown>,
  execute: (ids: string[], action: BulkAlertAction) => Promise<{
    action: BulkAlertAction; requested: number; affected: number; missingIds: string[];
  }>
) {
  const app = Fastify({ logger: false });
  app.post("/api/ma-alerts/bulk", bulkAlertHandler(execute));
  const response = await app.inject({
    method: "POST", url: "/api/ma-alerts/bulk", payload: body,
  });
  await app.close();
  return response;
}

test("bulk API deduplicates explicit IDs and supports pause, resume, and delete", async () => {
  for (const action of ["pause", "resume", "delete"] as const) {
    let received: { ids: string[]; action: BulkAlertAction } | undefined;
    const response = await request({ action, ids: [A, A, B] }, async (ids, gotAction) => {
      received = { ids, action: gotAction };
      return { action: gotAction, requested: ids.length, affected: ids.length, missingIds: [] };
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(received, { ids: [A, B], action });
    assert.deepEqual(response.json(), {
      action, requested: 2, affected: 2, missingIds: [],
    });
  }
});

test("bulk API rejects empty, malformed, unsupported, and oversized requests", async () => {
  const never = async (): Promise<never> => { throw new Error("executor must not run"); };
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ action: "pause", ids: [] }, /must not be empty/],
    [{ action: "pause" }, /non-empty array/],
    [{ action: "launch", ids: [A] }, /action must be one of/],
    [{ action: "delete", ids: ["not-a-uuid"] }, /must be a UUID/],
    [{ action: "resume", ids: Array.from({ length: MAX_BULK_ALERTS + 1 }, () => A) }, /at most 200/],
  ];
  for (const [body, error] of cases) {
    const response = await request(body, never);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.match(response.json().error, error);
  }
});

test("a missing current-scope ID is surfaced as an atomic conflict", async () => {
  const response = await request({ action: "delete", ids: [A, B] }, async (ids, action) => ({
    action, requested: ids.length, affected: 0, missingIds: [B],
  }));
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().affected, 0);
  assert.deepEqual(response.json().missingIds, [B]);
  assert.match(response.json().error, /current admin scope/);
});
