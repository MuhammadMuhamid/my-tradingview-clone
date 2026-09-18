/*
 * The Pine editor's RUN path, driven the way a person drives it.
 *
 * Phase 3D found `Add to chart` dead in ordinary use: the editor posted the
 * pane's canonical `instrument:v1:…` id to `/api/pine/run`, whose contract is
 * `assertSymbol` — `/^[A-Z0-9]{2,24}$/` in `backend/src/data/binanceRest.ts`
 * — so every run on an ordinary chart answered 400 `invalid symbol`. The raw
 * provider string was then printed on the console row BESIDE `no errors`, so
 * the surface said the script compiled cleanly and showed a provider failure
 * as page copy, at the same time, about the same action.
 *
 * This is the same canonical-id leak class Phase 3C closed for the pattern
 * overlays and Positions & Orders, and the same reduction closes it. The
 * existing Pine tests hand the harness a bare `SOLUSDT`, which is why none of
 * them could see it — so this fixture runs the pane on the canonical id the
 * symbol search actually writes.
 *
 * The fixture server has no `/api/pine/run` route, so the run fails at the
 * transport either way. That is deliberate: it lets one mount prove both
 * halves — the symbol the editor SENDS, and what the console says when a run
 * comes back with nothing.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { assertAbsent, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";
import { createWorkspace, WORKSPACE_STORAGE_KEY } from "@/lib/workspace";

/** The run route's own gate, copied from the backend it has to satisfy. */
const RUN_SYMBOL = /^[A-Z0-9]{2,24}$/;

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** Opens the bottom workstation and selects the Pine Editor tab. */
async function openPineEditor(): Promise<void> {
  fireEvent.click(screen.getAllByRole("button", { name: /go to another part of the application/ })[0]!);
  await settle();
  fireEvent.click(screen.getByRole("menuitem", { name: /Positions, tester and Pine editor/ }));
  await settle();
  const tab = screen.getByRole("tab", { name: /Pine Editor/ });
  if (tab.getAttribute("aria-selected") !== "true") {
    fireEvent.click(tab);
    await settle();
  }
}

/** A returning user whose pane holds the canonical id the search writes. */
function paneOnCanonicalId(): void {
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(
    createWorkspace({ symbol: CANONICAL.BTCUSDT!, interval: "1h" }),
  ));
}

test("Add to chart asks the run route for a symbol that route accepts", async () => {
  paneOnCanonicalId();
  await mountChart();
  assert.match(
    JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}").panes?.[0]?.symbol ?? "",
    /^instrument:v1:/,
    "the fixture must run the pane on a canonical id, or it cannot see the defect",
  );

  await openPineEditor();
  fireEvent.click(screen.getByRole("button", { name: /^Add to chart$/ }));
  await settle();

  const runs = server.callsTo("/api/pine/run").filter((call) => call.method === "POST");
  assert.ok(runs.length > 0, "pressing Add to chart asked the engine nothing");
  for (const call of runs) {
    const body = call.body as { symbol?: string };
    assert.match(String(body.symbol), RUN_SYMBOL,
      `the run route would refuse ${JSON.stringify(body.symbol)}`);
  }
});

test("a run that produced nothing is never reported as a clean compile", async () => {
  paneOnCanonicalId();
  await mountChart();
  await openPineEditor();

  // The debounced compile has already filled the console with its own verdict.
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^Add to chart$/ }));
  await settle();

  const console_ = screen.getByRole("button", { name: /Console/ });
  assertAbsent(
    /no errors/.test(console_.textContent ?? "") ? console_ : null,
    "the console called a run that returned nothing a clean compile",
  );
  assert.match(console_.textContent ?? "", /run failed/,
    "a failed run must be named as one");

  // And the reason the user is given is the product's own sentence, never the
  // transport's. `providerFailureCopy.test.tsx` holds the same rule for the
  // chart; the Pine console is not an exception to it.
  const panel = console_.parentElement;
  assert.ok(panel);
  assertAbsent(
    /invalid symbol|fixture server|404|400|HTTP|\bfetch\b/i.test(panel.textContent ?? "") ? panel : null,
    `the console printed a transport string as page copy: ${JSON.stringify(panel.textContent)}`,
  );
});
