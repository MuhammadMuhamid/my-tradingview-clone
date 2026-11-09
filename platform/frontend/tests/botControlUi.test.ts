/**
 * The Bot controls' pure parts, and the source rules that keep them honest.
 *
 * - The C8 polling budget (F9): at most once every 2 s, for at most 60 s.
 * - Unknown is never reported as success, and "Nothing was changed" only
 *   follows C8's "no such command" (F8).
 * - Request ids: one per intent, reused only while the outcome is unknown (F6e).
 * - "Classic Bot appearance" is opt-in, /bot-only and dark-only, and does not
 *   disturb the light-theme parse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OpenIntents, newRequestId, settleUncertain } from "../components/bot/commandRunner";
import { riskPatch } from "../components/bot/RiskLimitsCard";
import { explainRefusal } from "../components/bot/botCopy";
import type { BotCommandLookup } from "../lib/api";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** Source without comments: a rule about what the page SAYS is about code, not prose about it. */
const code = (rel: string): string => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return { now: () => now, sleeps, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
}

const processing: BotCommandLookup = { kind: "found", record: { requestId: "r", kind: "trade_close", status: "processing" } };

test("polling C8 keeps to one ask per 2 s and gives up after 60 s, saying the outcome is still unknown", async () => {
  const clock = fakeClock();
  let asked = 0;
  const verdict = await settleUncertain("req_0123456789abcdef", {
    lookup: async () => { asked += 1; return processing; },
    sleep: clock.sleep, now: clock.now, intervalMs: 2_000, windowMs: 60_000,
  });
  assert.deepEqual(verdict, { state: "still_unknown" });
  assert.ok(clock.sleeps.every((ms) => ms === 2_000), "never faster than every 2 s");
  assert.ok(asked <= 30, `asked ${asked} times in 60 s`);
  assert.ok(asked >= 29);
});

test("C8 decides: succeeded, failed, no record, and a pending order's live state", async () => {
  const run = (answers: BotCommandLookup[]) => {
    const clock = fakeClock();
    return settleUncertain("req_0123456789abcdef", {
      lookup: async () => answers.shift() ?? processing, sleep: clock.sleep, now: clock.now, intervalMs: 2_000, windowMs: 60_000,
    });
  };
  const ok = await run([processing, { kind: "unavailable", message: "502" },
    { kind: "found", record: { requestId: "r", kind: "halt", status: "succeeded", result: { halted: true } } }]);
  assert.equal(ok.state, "succeeded", "an unreachable C8 in between is not an answer");
  assert.deepEqual(await run([{ kind: "found", record: { requestId: "r", kind: "halt", status: "failed", code: "still_breached", error: "x" } }]),
    { state: "failed", code: "still_breached", message: "x" });
  assert.deepEqual(await run([{ kind: "not_found" }]), { state: "not_found" });
  const pending = (outcome: "pending" | "executed" | "not_executed"): BotCommandLookup =>
    ({ kind: "found", record: { requestId: "r", kind: "trade_close", status: "pending", live: { outcome } } });
  assert.equal((await run([pending("pending"), pending("executed")])).state, "succeeded");
  assert.equal((await run([pending("not_executed")])).state, "failed");
});

test("request ids are well-formed and fresh, and an intent keeps its id only while unknown", () => {
  const a = newRequestId();
  const b = newRequestId();
  assert.match(a, /^[A-Za-z0-9_-]{16,128}$/);
  assert.notEqual(a, b);
  const intents = new OpenIntents();
  const first = intents.idFor("trade_close:t1");
  assert.notEqual(intents.idFor("trade_close:t1"), first, "nothing open: a new intent, a new id");
  intents.keepOpen("trade_close:t1", first);
  assert.equal(intents.idFor("trade_close:t1"), first, "while unknown: the same id");
  assert.notEqual(intents.idFor("trade_close:t2"), first, "a different intent never shares it");
  intents.close("trade_close:t1");
  assert.notEqual(intents.idFor("trade_close:t1"), first, "after a definitive answer: a new id");
});

test("'Nothing was changed' is said in exactly one place: C8's no-record branch", () => {
  const sources = ["components/bot/commandRunner.ts", "components/bot/botCopy.ts", "components/bot/StepUpDialog.tsx",
    "components/bot/RiskLimitsCard.tsx", "components/bot/BotTrades.tsx", "components/bot/BotStatusStrip.tsx", "app/bot/page.tsx"];
  const hits = sources.flatMap((file) => (code(file).match(/Nothing was changed/g) ?? []).map(() => file));
  assert.deepEqual(hits, ["components/bot/commandRunner.ts"]);
  assert.match(code("components/bot/commandRunner.ts"), /verdict\.state === "not_found"[\s\S]{0,200}Nothing was changed/);
  for (const refusal of ["trade_manual", "bot_deleted", "bot_paused", "ambiguous_trade", "exit_unresolved", "bot_channel_rejected",
    "bot_rate_limited", "still_breached", "anything_else"]) {
    assert.doesNotMatch(explainRefusal(refusal, "m").text, /Nothing was changed/, refusal);
  }
});

test("a risk-limit change sends only what changed; empty is no limit; bounds are the Bot's", () => {
  const limits = { maxTotalExposureQuote: 1000, maxConcurrentTrades: 3, maxDailyLossQuote: 50, dailyLossWindowHours: 24 };
  const draft = { maxTotalExposureQuote: "1000", maxConcurrentTrades: "3", maxDailyLossQuote: "", dailyLossWindowHours: "48" };
  assert.deepEqual(riskPatch(limits, draft), { patch: { maxDailyLossQuote: null, dailyLossWindowHours: 48 } });
  assert.deepEqual(riskPatch(limits, { ...draft, maxDailyLossQuote: "50", dailyLossWindowHours: "24" }), { patch: {} });
  for (const bad of [{ maxConcurrentTrades: "1.5" }, { maxTotalExposureQuote: "-1" }, { dailyLossWindowHours: "0" },
    { dailyLossWindowHours: "721" }, { maxDailyLossQuote: "abc" }]) {
    assert.ok("error" in riskPatch(limits, { ...draft, ...bad }), JSON.stringify(bad));
  }
});

test("classic appearance: one scoped, dark-only token block after the light block, set only by /bot", () => {
  const css = read("app/globals.css");
  const light = css.indexOf(':root[data-theme="light"]');
  const lightEnd = css.indexOf("\n}", light);
  const selector = ':root:not([data-theme="light"]) [data-bot-appearance="classic"] {';
  const classic = css.indexOf(selector);
  assert.ok(classic > lightEnd, "after the light block, so the theme parse is untouched");
  assert.equal(css.split("data-bot-appearance").length - 1, 1, "one block, one selector");
  const block = css.slice(classic, css.indexOf("\n}", classic));
  // Each colour comes with the -rgb triple Tailwind reads.
  for (const name of ["bg", "surface", "surface-2", "line", "ink", "ink-muted", "ink-faint", "accent", "positive", "negative", "caution"]) {
    assert.match(block, new RegExp(`--ts-${name}: #`), name);
    assert.match(block, new RegExp(`--ts-${name}-rgb: \\d+ \\d+ \\d+;`), `${name}-rgb`);
  }
  // The dark block (everything before the light one) keeps the neutral palette.
  assert.ok(!css.slice(0, light).includes("#0b0f14"));

  const setters: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && /data-bot-appearance=\{/.test(read(rel))) setters.push(rel);
    }
  };
  ["app", "components", "lib"].forEach(walk);
  // 2026-11-09 parity: the one setter is the Bot section's shared frame, so the
  // preference reaches every /bot route (overview, bot form, accounts) and nothing else.
  assert.deepEqual(setters, ["components/bot/BotShell.tsx"], "no other page can turn it on");
  assert.match(read("components/bot/BotShell.tsx"), /data-bot-appearance=\{classic \? "classic" : undefined\}/, "absent unless opted in");
  const botRoutes: string[] = [];
  const pages = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) pages(rel);
      else if (entry.name === "page.tsx") botRoutes.push(rel);
    }
  };
  pages("app/bot");
  for (const route of botRoutes) assert.match(read(route), /<BotShell\b/, `${route} renders inside the Bot frame`);
});

test("OD-7: 'Close from the Trade panel' names the position, and the link only prefills", async () => {
  const { tradePanelHref } = await import("../components/bot/botCopy");
  assert.equal(tradePanelHref("SOL/USDT"), "/chart?source=scanner&symbol=SOLUSDT&panel=manual");
  assert.equal(tradePanelHref("SOLUSDT", { accountId: "acct-1", positionId: "pos-9" }),
    "/chart?source=scanner&symbol=SOLUSDT&panel=manual&side=sell&account=acct-1&position=pos-9");
  assert.equal(tradePanelHref("SOLUSDT", { accountId: null, positionId: "pos-9" }),
    "/chart?source=scanner&symbol=SOLUSDT&panel=manual&side=sell&position=pos-9");
  const trades = fs.readFileSync(path.join(__dirname, "..", "components", "bot", "BotTrades.tsx"), "utf8");
  assert.match(trades, /tradePanelHref\(trade\.pair, \{ accountId: trade\.account\?\.id \?\? null, positionId: trade\.id \}\)/);
});
