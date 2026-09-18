/**
 * The parameter form draws the strategy it was given.
 *
 * `tests/paramSchema.test.ts` pins the schema layer — that each strategy's
 * defaults come from its own fields. This pins the half that actually broke:
 * the FORM ignored the strategy entirely and rendered `PARAM_GROUPS`, so a user
 * editing `mtf_lean` was shown, and sent, `ma_rr_v9`'s inputs.
 *
 * A source assertion ("does not import PARAM_GROUPS") would pass the day
 * someone reintroduces the same bug through a different import, so this renders
 * the component and reads what a person would see.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { ParamForm } from "@/components/ParamForm";
import { SCHEMAS, defaultParamsFor, groupsFor } from "@/lib/paramSchema";

beforeEach(resetBrowser);
after(closeBrowser);

const titles = (key: string): string[] => groupsFor(key)!.map((g) => g.title);

test("each registered strategy's own group titles are the ones rendered", async () => {
  for (const key of Object.keys(SCHEMAS)) {
    const view = render(
      <ParamForm strategyKey={key} value={defaultParamsFor(key)} onChange={() => undefined} />,
    );
    await settle();

    for (const title of titles(key)) {
      assert.ok(screen.queryByText(title), `${key} did not render its own group "${title}"`);
    }

    // And none of another strategy's groups leaked in. This is the assertion
    // that was false: every strategy rendered ma_rr_v9's six groups.
    for (const other of Object.keys(SCHEMAS)) {
      if (other === key) continue;
      for (const foreign of titles(other)) {
        if (titles(key).includes(foreign)) continue;
        assert.equal(
          screen.queryByText(foreign), null,
          `${key} rendered "${foreign}", which belongs to ${other}`,
        );
      }
    }
    view.unmount();
  }
});

test("a strategy with no registered schema renders nothing rather than another strategy's form", async () => {
  render(
    <ParamForm strategyKey="not_a_strategy" value={{}} onChange={() => undefined} />,
  );
  await settle();

  // The caller is expected to offer a raw-params editor instead — what must not
  // happen is silently drawing ma_rr_v9's form for an unknown key.
  for (const title of titles("ma_rr_v9")) {
    assert.equal(screen.queryByText(title), null,
      `an unknown strategy fell back to ma_rr_v9's "${title}"`);
  }
});
