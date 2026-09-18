/**
 * A scope this policy does not rule on produces a REFUSAL or SILENCE — never a
 * half decision the far side will validate as a whole one.
 *
 * `assertShariahScopeAllowed` used to return a context on every allowing path:
 * the mode, the policy version when enforcing, and `assetId: null,
 * baseAsset: null`, because a scope check has no asset to name. The routes
 * signed that onto the outbound request.
 *
 * The Bot's contract reads `mode: "enforce"` as a promise that a COMPLETE asset
 * decision follows — `webhookContract.ts` requires `assetId` and `baseAsset` to
 * be valid strings under it. So the block was rejected at the top of the Bot's
 * handler, BEFORE its entry/exit branch, and a `reduceOnly` CLOSE was refused.
 * An operator enforcing Shariah Mode could not get out of a derivative
 * position: the one outcome `gate.ts` and `docs/SHARIAH-UNIVERSE.md` both
 * declare impossible.
 *
 * The existing route tests could not see it because they stub `botRequest` —
 * the whole defect lives on the far side of that stub. These tests assert the
 * shape of what CROSSES, which is the thing both sides have to agree about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { config } from "../src/config";
import {
  assertShariahScopeAllowed, ShariahExposureBlockedError,
} from "../src/shariah/gate";
import { traditionalExecutionRoutes } from "../src/api/routes/traditionalExecution";

const ROUTES = path.join(__dirname, "..", "src", "api", "routes");
const enforcing = { readMode: async () => "enforce" as const };
const off = { readMode: async () => "off" as const };

test("an allowed scope call conveys NOTHING — there is no decision to convey", async () => {
  for (const deps of [enforcing, off]) {
    // SELL, on every scope: never gated, and never handed a decision either,
    // because a decision is what makes the far side validate one.
    for (const scope of ["derivative", "equity", "traditional", "spot"] as const) {
      assert.equal(await assertShariahScopeAllowed({ scope, side: "SELL" }, deps), null,
        `${scope} SELL must convey nothing`);
    }
    // Spot is the asset gate's business, not this one's.
    assert.equal(await assertShariahScopeAllowed({ scope: "spot", side: "BUY" }, deps), null);
  }
  // And with the mode off, opening is allowed and still says nothing.
  for (const scope of ["derivative", "equity", "traditional"] as const) {
    assert.equal(await assertShariahScopeAllowed({ scope, side: "BUY" }, off), null);
  }
});

test("a refusal still carries the policy that refused, for the operator", async () => {
  // The refusal is read by a person, not by the Bot — it never leaves as a
  // signed block — so it may and should name the mode and the policy version.
  await assert.rejects(
    () => assertShariahScopeAllowed({ scope: "derivative", side: "BUY" }, enforcing),
    (error: unknown) => {
      assert.ok(error instanceof ShariahExposureBlockedError);
      assert.equal(error.context.mode, "enforce");
      assert.ok(error.context.policyVersion);
      return true;
    },
  );
});

test("no route signs a scope result onto an outbound request", () => {
  /*
   * The structural half. A route that writes `shariah` into a body from the
   * scope gate is reintroducing the defect, and this catches it by shape
   * rather than by anyone remembering.
   */
  for (const file of ["derivativeExecution.ts", "equityExecution.ts", "traditionalExecution.ts"]) {
    const source = fs.readFileSync(path.join(ROUTES, file), "utf8");
    assert.match(source, /assertShariahScopeAllowed/, `${file} must still gate`);
    // The gate's result is never bound to a name and therefore never attached.
    assert.doesNotMatch(source, /(const|let)\s+\w+\s*=\s*await assertShariahScopeAllowed/,
      `${file} binds the scope gate's result — it has nothing to give, and attaching it `
      + "makes the Bot validate a decision that was never made");
  }
});

test("X5 never gates SELL, because a SELL may be the only way out", async () => {
  /*
   * X5 has no position-effect field, so a SELL here is ambiguous: it may open a
   * short, and it may be the only way to flatten a long. It was briefly gated
   * on both sides on the reasoning that every X5 order opens exposure — wrong
   * at the venue, because the Bot submits to OANDA practice with
   * `positionFill: "DEFAULT"` (`services/traditionalExecution/adapters.ts`),
   * which on a netted account reduces the opposing position first. Gating it
   * trapped the operator, which `gate.ts` says can never happen and whose own
   * refusal text promised it could not.
   *
   * The known cost is an asymmetry — a genuinely new short is not refused —
   * and that is the lesser wrong. Never trapping someone in a position
   * outranks refusing every way into one.
   */
  const source = fs.readFileSync(path.join(ROUTES, "traditionalExecution.ts"), "utf8");
  assert.doesNotMatch(source, /scope: "traditional", side: "BUY"/,
    "X5 must pass the wire side through; hard-coding BUY gates the only exit it has");

  const old = config.traditionalPaperExecutionEnabled;
  config.traditionalPaperExecutionEnabled = true;
  const app = Fastify();
  await app.register(async (child) => traditionalExecutionRoutes(child, {
    shariah: enforcing,
    botRequest: async () => { throw new Error("the Bot must never be contacted for a refused order"); },
    claimIntent: async () => { throw new Error("a refused order must not claim an intent"); },
    resolveIntent: async () => {},
  }));
  try {
    // BUY is refused: the policy makes no finding about FX or futures.
    {
      const side = "BUY" as const;
      const response = await app.inject({
        method: "POST", url: "/api/traditional-execution/v1/orders",
        payload: {
          deploymentId: "00000000-0000-4000-8000-000000000010",
          dedupeKey: `x5:eurusd:${side}:1788678000000`,
          barTime: 1_788_678_000_000,
          canonicalInstrumentId: "instrument:v1:OANDA:fx_pair:EUR:USD:USD:cash",
          side, quantity: "1000", orderType: "MARKET",
        },
      });
      assert.equal(response.statusCode, 403, response.body);
      const body = JSON.parse(response.body) as { error: string };
      assert.match(body.error, /makes\s*no finding about/,
        "a BUY must be refused because the policy is silent about this asset class");
    }
    // SELL reaches the gate and is cleared: it may be the only way out.
    {
      /*
       * The mode is never even READ for a SELL — `assertShariahScopeAllowed`
       * short-circuits on the side before it consults anything. That is
       * stronger than "cleared": there is no state, no failure and no
       * misconfiguration that can make an exit refusable.
       */
      let modeWasRead = false;
      const exitApp = Fastify();
      await exitApp.register(async (child) => traditionalExecutionRoutes(child, {
        shariah: { readMode: async () => { modeWasRead = true; return "enforce" as const; } },
        botRequest: async () => ({ status: "FILLED" }),
        claimIntent: async () => { throw new Error("stop after the gate"); },
        resolveIntent: async () => {},
      }));
      try {
        const response = await exitApp.inject({
          method: "POST", url: "/api/traditional-execution/v1/orders",
          payload: {
            deploymentId: "00000000-0000-4000-8000-000000000010",
            dedupeKey: "x5:eurusd:SELL:1788678000000",
            barTime: 1_788_678_000_000,
            canonicalInstrumentId: "instrument:v1:OANDA:fx_pair:EUR:USD:USD:cash",
            side: "SELL", quantity: "1000", orderType: "MARKET",
          },
        });
        assert.notEqual(response.statusCode, 403,
          `a SELL was refused while enforcing — the operator is trapped: ${response.body}`);
        assert.doesNotMatch(response.body, /makes\s*no finding about/);
      } finally { await exitApp.close(); }
      assert.equal(modeWasRead, false,
        "an exit consulted the mode; it must short-circuit before anything that could fail");
    }
  } finally { config.traditionalPaperExecutionEnabled = old; await app.close(); }
});
