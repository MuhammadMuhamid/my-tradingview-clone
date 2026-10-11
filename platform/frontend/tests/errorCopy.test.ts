/**
 * Which failure words may be page copy.
 *
 * C-02: the stress page refused a 900-bar window over 540 bars as "Could not
 * find the windows. The request was refused. ·" — the server's actionable
 * sentence only in the hover title of the dot. A 4xx validation sentence our
 * own server wrote is product copy; a provider's string, a status line, the
 * framework's schema text and the fixture's route text are not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAction, describeFailure, ownRefusal } from "../lib/errorCopy";
import { ApiError } from "../lib/api";

const STRESS = "the benchmark has 540 bars, which cannot contain a 900-bar window. Widen the "
  + "benchmark period, shorten the window, or choose a finer benchmark interval.";

test("our own 400 / 409 / 422 sentence is the reason, capitalised, with the cause kept", () => {
  const copy = describeAction(new ApiError(400, STRESS), "find the windows");
  assert.equal(copy.headline, `Could not find the windows. ${STRESS[0]!.toUpperCase()}${STRESS.slice(1)}`);
  assert.equal(copy.detail, STRESS, "the cause is still verbatim for the tooltip");
  assert.equal(ownRefusal(new ApiError(422, "funding history is not offered by this venue")),
    "Funding history is not offered by this venue.", "a sentence gets its full stop");
  assert.equal(ownRefusal(new ApiError(409, "This Platform order intent was already attempted.")),
    "This Platform order intent was already attempted.");
  assert.match(describeFailure(new ApiError(400, "Initial capital must be a number greater than 0."), "The run").headline,
    /^The run could not be loaded\. Initial capital must be a number greater than 0\.$/);
});

test("what is not a sentence of ours stays in the tooltip", () => {
  const generic = (cause: unknown): string => describeAction(cause, "save").headline;
  // A provider's words arrive as 5xx and are never inlined.
  assert.equal(generic(new ApiError(502, "invalid SOLUSDT 15m backfill: invalid_close_time")),
    "Could not save. The service did not answer. Try again shortly.");
  // The status-line fallback when the body had no `error`.
  assert.equal(generic(new ApiError(400, "400 Bad Request")), "Could not save. The request was refused.");
  assert.equal(generic(new ApiError(409, "409 Conflict")), "Could not save. The request was refused.");
  // The framework's own validation and parsing text.
  for (const framework of [
    "body must have required property 'symbol'",
    "querystring/limit must be integer",
    "Body is not valid JSON but content-type is set to 'application/json'",
    "FST_ERR_CTP_EMPTY_JSON_BODY",
  ]) {
    assert.equal(ownRefusal(new ApiError(400, framework)), null, framework);
  }
  // Route and fixture text, and anything that is a dump rather than a sentence.
  assert.equal(ownRefusal(new ApiError(400, "no route for POST /api/stress/windows")), null);
  assert.equal(ownRefusal(new ApiError(400, "fixture server has no route for GET /api/alerts")), null);
  assert.equal(ownRefusal(new ApiError(400, "Error: boom\n    at handler (server.ts:12:3)")), null);
  assert.equal(ownRefusal(new ApiError(400, "x".repeat(400))), null);
  // Statuses with their own reader sentence keep it.
  assert.equal(generic(new ApiError(404, "backtest not found")), "Could not save. This environment does not serve it.");
  assert.equal(generic(new ApiError(401, "session expired")), "Could not save. You may need to sign in again.");
  assert.equal(generic(new ApiError(429, "slow down")), "Could not save. The service is rate-limiting us. Try again shortly.");
  // A cause that is not an ApiError is not judged by status at all.
  assert.equal(ownRefusal(new Error("Initial capital must be greater than 0.")), null);
});
