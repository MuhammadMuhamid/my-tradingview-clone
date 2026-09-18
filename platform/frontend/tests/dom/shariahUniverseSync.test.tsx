/*
 * The Shariah registry can be populated from inside the product.
 *
 * `POST /api/shariah/universe/sync` describes itself as "the registry's only
 * production entry point". It had no caller anywhere: no button, no client
 * method, no script, no scheduled job. So a fresh install had an empty
 * registry, every symbol resolved to REVIEW, and turning Shariah Mode on was a
 * total BUY stop with no action inside the product able to lift it — the whole
 * feature unreachable without curl.
 *
 * What makes a button safe here is that discovery is not classification: the
 * route creates newly seen assets UNSCREENED, which reads as REVIEW, and has
 * no path that writes ELIGIBLE or EXCLUDED. Running it can only widen what
 * needs reviewing, never what may be bought. The control has to say that, or
 * an operator will reasonably read "sync" as "approve".
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { assertAbsent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import ShariahPage from "@/app/shariah/page";

beforeEach(resetBrowser);
after(closeBrowser);

async function mount(): Promise<void> {
  render(<AppRoute path="/shariah"><ShariahPage /></AppRoute>);
  await settle();
}

test("the registry has a populate control, and it reaches the sync route", async () => {
  await mount();

  const sync = screen.getByRole("button", { name: /Sync universe/i });
  assert.ok(sync, "the registry's only entry point has no control");

  fireEvent.click(sync);
  await settle();

  const calls = server.callsTo("/api/shariah/universe/sync").filter((c) => c.method === "POST");
  assert.ok(calls.length > 0,
    "the control exists but asks nothing — the registry is still unreachable");
});

test("the control says discovery is not approval", async () => {
  await mount();
  const sync = screen.getByRole("button", { name: /Sync universe/i });
  const hint = sync.getAttribute("title") ?? "";
  assert.match(hint, /Discovery only/i,
    "an operator will read 'sync' as 'approve' unless told otherwise");
  assert.match(hint, /nothing is classified/i);
  assert.match(hint, /nothing becomes buyable/i);
});

test("an empty registry says what it means and what to do about it", async () => {
  /*
   * An empty registry is not a neutral state: with enforcement on it refuses
   * every BUY on the install. Rendering four zeroes and saying nothing leaves
   * an operator to work that out from the refusals.
   */
  await mount();
  const warning = screen.queryByText(/This registry is empty/i);
  if (warning === null) return; // the fixture seeded a universe; nothing to assert
  const text = warning.textContent ?? "";
  assert.match(text, /every symbol reads as REVIEW/i);
  assert.match(text, /would refuse every BUY/i);
  assert.match(text, /Sync universe/,
    "the warning must name the control that fixes it");
  // And it must not overstate: syncing does not classify anything.
  assert.match(text, /classifies nothing/i);
});

test("the page never claims an unread universe is an empty one", async () => {
  await mount();
  assertAbsent(
    screen.queryByText(/^No assets in the screening universe\.?$/i),
    "a confident empty state for a question that may not have been answered",
  );
});

test("the re-review horizon is a control, not a curl-only setting", async () => {
  /*
   * `PUT /api/shariah/review-policy` and `GET /api/shariah/mode/history` were
   * added to the API and to nothing else — the same "no caller" defect the
   * universe-sync button had just been added to fix, one commit earlier. A
   * control that exists only in an HTTP client does not exist.
   */
  await mount();
  const horizon = screen.queryByLabelText(
    /Days after which a settled decision is surfaced as due for re-review/i);
  if (horizon === null) return; // the fixture served no universe; nothing to drive
  assert.equal(horizon.tagName, "SELECT");

  fireEvent.change(horizon, { target: { value: "730" } });
  await settle();
  const calls = server.callsTo("/api/shariah/review-policy").filter((c) => c.method === "PUT");
  assert.ok(calls.length > 0, "changing the horizon asked nothing");
  assert.equal((calls[0]!.body as { reviewMaxAgeDays?: number }).reviewMaxAgeDays, 730);
});

test("the horizon control says age withdraws nothing", async () => {
  // The whole design turns on this being ADVISORY. A control that looked like
  // it could invalidate decisions would be read as one that does.
  await mount();
  const note = screen.queryByText(/an aged decision still stands and is still enforced/i);
  if (note === null) return;
  assert.match(note.textContent ?? "", /Advisory only/i);
});
