/**
 * The workstation draws its own tooltips.
 *
 * Measured across the chrome before this: 38 of 65 buttons carried a native
 * `title` and 27 carried nothing at all, so hovering a control produced either
 * the operating system's bubble — its font, its delay, its corner — or silence.
 * The reference draws its own chip on every control and sets `title=null`.
 * Several of the `title` strings here were word-for-word the reference's
 * tooltip copy, so only the mechanism was ever wrong.
 *
 * This asserts the RULE rather than a count, because the failure mode is a new
 * control being added with a `title` out of habit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), "utf8");

/** Every component that draws part of the workstation chrome. */
const CHROME = [
  "components/tv/ChartToolbar.tsx",
  "components/tv/ChartSidePanel.tsx",
  "components/tv/TimeframePicker.tsx",
  "components/tv/ChartTypeMenu.tsx",
  "components/tv/IndicatorTemplatesMenu.tsx",
  "components/tv/LayoutMenu.tsx",
  "components/tv/LayoutSelector.tsx",
];

test("no chrome control asks the operating system to draw its tooltip", () => {
  for (const file of CHROME) {
    const source = read(file);
    /*
     * `title=` as a JSX attribute. `Modal`'s own `title` PROP is a heading and
     * is deliberately not this — it is matched the same way, so the exception
     * is stated rather than silently allowed by a looser pattern.
     */
    const offenders = source
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /(?<![\w-])title=/.test(line))
      // F-06: the `Open template…` library is a Modal too.
      .filter(({ line }) => !/^title="(Open layout|Indicator templates)"$/.test(line));

    assert.deepEqual(offenders, [],
      `${file} uses a native title; name the control with data-tooltip instead`);
  }
});

test("the chrome names its controls, so the tooltip has something to draw", () => {
  const toolbar = read("components/tv/ChartToolbar.tsx");
  assert.ok((toolbar.match(/data-tooltip=/g) ?? []).length >= 15,
    "the toolbar's controls stopped naming themselves");
  const rail = read("components/tv/ChartSidePanel.tsx");
  assert.ok((rail.match(/data-tooltip=/g) ?? []).length >= 8,
    "the right rail's cells stopped naming themselves");
});

test("the tooltip is the reference's chip, not a re-typed one", () => {
  // 24px tall, 13px text, radius 2, the shared tooltip token, 4px below the
  // control — measured on live Premium 2026-09-18.
  const ui = read("components/ui.tsx");
  const body = ui.slice(ui.indexOf("export function ChromeTooltip"));
  assert.match(body, /h-\[24px\]/, "24px tall");
  assert.match(body, /text-\[13px\]/, "13px");
  assert.match(body, /rounded-\[2px\]/, "radius 2");
  assert.match(body, /--ts-tooltip-bg/, "the shared token, not a re-typed hex");
  assert.match(body, /box\.bottom \+ 4/, "4px below the control");
});
