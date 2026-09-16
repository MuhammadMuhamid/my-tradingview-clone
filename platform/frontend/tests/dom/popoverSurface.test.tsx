/**
 * TVP8 F-02: a PORTALED popover carries its own scope.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * Replay's date picker is rendered through `createPortal` into
 * `document.body`, and it set `className="tvc-popover ts-app …"` — putting the
 * workstation's scope class on ITSELF. The rule in `app/globals.css` was a
 * descendant selector, `:is(.tv-workstation, .ts-app) .tvc-popover`, which
 * never matches the element it is written on. Measured live at 1440 before the
 * repair: `background-color: rgba(0, 0, 0, 0)`, `box-shadow: none`,
 * `border-radius: 0px` — so the calendar's numbers and its time field were
 * drawn straight onto the RSI and MACD panes beneath them.
 *
 * jsdom applies no stylesheet, so a computed-background assertion here would
 * prove nothing. What it CAN do is ask the browser's own selector engine the
 * exact question the bug turned on: does this rule match a popover that is its
 * own scope? That is the defect, stated precisely, and it fails on the old
 * selector.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "..", "app", "globals.css"), "utf8");
/** The same sheet with its comments gone, so a selector is only a selector. */
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** The selector list of the rule that gives `.tvc-popover` its surface. */
function popoverSelector(): string {
  const rule = /([^{}]*\.tvc-popover[^{}]*)\{([^}]*)\}/g;
  for (const [, selector, body] of CSS_CODE.matchAll(rule)) {
    if (/background-color:\s*var\(--ts-popover\)/.test(body!)) {
      return selector!.trim().replace(/\s+/g, " ");
    }
  }
  throw new Error("no rule in globals.css gives .tvc-popover the popover ground");
}

test("F-02 — the popover rule matches a popover that is its OWN scope", () => {
  const selector = popoverSelector();

  // The portaled shape: scope and popover on one element, no ancestor.
  const portaled = document.createElement("div");
  portaled.className = "tvc-popover ts-app fixed z-[60] border border-border p-2";
  document.body.appendChild(portaled);
  assert.equal(portaled.matches(selector), true,
    `a portaled popover is not matched by ${selector} — it draws with no ground at all`);

  // And the shape that always worked keeps working.
  const host = document.createElement("div");
  host.className = "ts-app";
  const nested = document.createElement("div");
  nested.className = "tvc-popover";
  host.appendChild(nested);
  document.body.appendChild(host);
  assert.equal(nested.matches(selector), true);

  // A popover with neither scope is still out of scope — the fix widens the
  // rule by exactly one case, it does not remove the scoping.
  const orphan = document.createElement("div");
  orphan.className = "tvc-popover";
  document.body.appendChild(orphan);
  assert.equal(orphan.matches(selector), false,
    "the scope still means something");

  for (const el of [portaled, host, orphan]) el.remove();
});

test("F-02 — and both themes give that ground a value", () => {
  /*
   * The rule paints `var(--ts-popover)`. A token declared in the dark block
   * and not the light one is a transparent popover in light theme, which is
   * the same defect wearing a different hat.
   */
  const blocks = CSS_CODE.split(/:root|\[data-theme="light"\]/);
  const dark = blocks.some((b) => /--ts-popover:\s*#[0-9a-f]{6}/i.test(b));
  assert.ok(dark, "--ts-popover is never given a colour");
  assert.equal((CSS_CODE.match(/--ts-popover:\s*#[0-9a-f]{6}/gi) ?? []).length >= 2, true,
    "--ts-popover must be declared for both themes");
  assert.equal((CSS_CODE.match(/--ts-popover-shadow:/g) ?? []).length >= 2, true,
    "--ts-popover-shadow must be declared for both themes");
});

test("F-02 — the replay picker is the portaled shape this rule now covers", async () => {
  const chart = await mountChart();
  await settle();

  const replay = chart.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Bar replay"]');
  assert.ok(replay, "the toolbar has no Bar replay control");
  fireEvent.click(replay);
  await settle(4);

  const trigger = screen.queryAllByRole("button")
    .find((b) => /replay date and time/i.test(b.getAttribute("aria-label") ?? ""));
  assert.ok(trigger, "the replay strip offers no date picker");
  fireEvent.click(trigger);
  await settle(2);

  const picker = document.querySelector<HTMLElement>('[role="dialog"].tvc-popover');
  assert.ok(picker, "the date picker did not open");
  assert.equal(picker.matches(popoverSelector()), true,
    "the open picker is not matched by the rule that gives it a ground");
  // The shape that made this necessary, pinned so a future refactor that
  // un-portals it does not silently rely on the widened selector.
  assert.ok(picker.className.includes("ts-app"),
    "the picker carries its own scope because it has no scoped ancestor");
});
