/**
 * A session that could not be read is not the administrator's.
 *
 * `/api/auth/me` answering 500, or not answering at all, used to resolve to
 * "admin" (`lib/session` `roleOf`), so an ordinary account whose read failed
 * was drawn the operator's surface: on Shariah the "published deliberately by
 * you" header with Turn on, Sync universe and Select due assets enabled; in the
 * product menu every administrator destination. The backend still refused the
 * writes — this was a UI that claimed an authority the reader did not have.
 *
 * Now an unreadable session is offered what an unknown one is: nothing
 * admin-only. (The Shariah header's role-free wording for this state belongs
 * to that page; here only the absence of the operator's controls and of its
 * first-person copy is asserted.)
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { assertAbsent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import ShariahPage from "@/app/shariah/page";
import { Nav } from "@/components/Nav";
import { ADMIN_ONLY_HREFS } from "@/lib/navigation";
import { resetSessionForTests, roleOf } from "@/lib/session";

beforeEach(() => {
  resetBrowser();
  resetSessionForTests();
  server.routes.set("GET /api/shariah/universe", () => ({
    policyVersion: "TS_SHARIAH_V1", prohibitedCategories: ["LENDING"], reviewPolicy: { reviewMaxAgeDays: 365 },
    counts: { total: 0, active: 0, eligible: 0, review: 0, excluded: 0, dueForReReview: 0 },
    assets: [],
  }));
  server.routes.set("GET /api/shariah/snapshots", () => ({ snapshots: [] }));
  server.routes.set("GET /api/shariah/mode", () => ({ mode: "off", policyVersion: "TS_SHARIAH_V1" }));
  server.routes.set("GET /api/shariah/mode/history", () => ({ changes: [] }));
});
after(closeBrowser);

const failures: { name: string; arrange: () => void }[] = [
  { name: "answers 500", arrange: () => {
    server.routes.set("GET /api/auth/me", () => new Response("upstream down", { status: 500 }));
  } },
  { name: "never answers (network failure)", arrange: () => {
    server.routes.set("GET /api/auth/me", () => { throw new TypeError("fetch failed"); });
  } },
];

for (const { name, arrange } of failures) {
  test(`Shariah, when the session read ${name}: no operator controls and no "by you"`, async () => {
    arrange();
    render(<AppRoute path="/shariah"><ShariahPage /></AppRoute>);
    await settle(6);

    for (const control of [/^Turn on$/, /^Turn off$/, /Sync universe/, /Create universe snapshot/,
      /needing review/]) {
      assertAbsent(screen.queryByRole("button", { name: control }), `the write control ${control}`);
    }
    assertAbsent(screen.queryByText(/by you/), "the operator's first-person header");
    assertAbsent(screen.queryByText(/^You publish evidence-backed/), "the operator's first-person explanation");
  });

  test(`the header's product menu, when the session read ${name}: no administrator destination`, async () => {
    arrange();
    render(<AppRoute path="/shariah"><Nav /></AppRoute>);
    await settle(6);
    fireEvent.click(screen.getByRole("button", { name: /go to another part of the application/ }));
    await settle();

    const hrefs = screen.getAllByRole("menuitem")
      .map((item) => item.getAttribute("href"))
      .filter((href): href is string => href !== null);
    assert.ok(hrefs.includes("/chart"), "setup: the menu did not open");
    const offered = hrefs.filter((href) => ADMIN_ONLY_HREFS.has(href));
    assert.deepEqual(offered, [], "administrator destinations offered to an account nobody could check");
  });
}

test("roleOf: a failed read and a signed-out answer are unreadable; no accounts is the administrator", () => {
  const base = { providers: { google: false, signups: true } };
  assert.equal(roleOf(null), "unknown");
  assert.equal(roleOf({ ...base, authenticated: false, authEnabled: true, user: null, readFailed: true }), "unreadable");
  assert.equal(roleOf({ ...base, authenticated: false, authEnabled: true, user: null }), "unreadable");
  assert.equal(roleOf({ ...base, authenticated: false, authEnabled: false, user: null }), "admin");
});
