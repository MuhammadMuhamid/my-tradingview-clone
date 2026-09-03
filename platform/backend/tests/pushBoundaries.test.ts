/**
 * Characterization of the Web Push boundaries: which delivery failures prune a
 * subscription, and the shape/size of the notification an MA alert produces.
 *
 * Delivery itself needs a push service, so what is pinned here is the pure
 * decision surface — the classification `sendPush` applies, and the message
 * `maAlertRunner.fire` hands it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isAllowedPushHost, isDiscardedSubscription, MAX_PUSH_PAYLOAD_BYTES, validatePushEndpoint,
} from "../src/alerts/webPush";
import { formatAlertPrice, formatMaAlertPush } from "../src/alerts/maEvaluator";

const alert = {
  id: "11111111-2222-3333-4444-555555555555",
  symbol: "APTUSDT", timeframe: "15m",
  maType: "ema" as const, maLength: 200,
  mode: "cross_up" as const, nearMinPct: 0.2, nearMaxPct: 0.5,
};

test("only 404 and 410 discard a subscription; everything else is a transient failure", () => {
  assert.equal(isDiscardedSubscription(404), true);
  assert.equal(isDiscardedSubscription(410), true);
  for (const s of [200, 201, 400, 401, 403, 413, 429, 500, 502, 503, undefined]) {
    assert.equal(isDiscardedSubscription(s), false, String(s));
  }
});

test("the MA alert notification carries title, body, a per-alert tag and a deep link", () => {
  const msg = formatMaAlertPush(alert, { close: 12.3456 }, 12.0, 2.88);
  assert.equal(msg.title, "APTUSDT 15m — EMA 200");
  assert.match(msg.body, /^Price crosses above the EMA 200 \(close 12\.3456, EMA 200 12, \+2\.88%\)$/);
  assert.equal(msg.tag, `ma-${alert.id}`, "one notification per alert collapses on the device");
  assert.equal(msg.url, "/chart?symbol=APTUSDT&interval=15m");
});

test("a negative distance keeps its sign", () => {
  const msg = formatMaAlertPush({ ...alert, mode: "cross_down" }, { close: 11 }, 12, -8.3333);
  assert.match(msg.body, /-8\.33%/);
  assert.match(msg.body, /crosses below/);
});

test("the near_* modes describe their configured band", () => {
  const msg = formatMaAlertPush(
    { ...alert, mode: "near_above", nearMinPct: 0.2, nearMaxPct: 0.5 },
    { close: 12.3 }, 12.27, 0.24
  );
  assert.match(msg.body, /is 0\.2–0\.5% above/);
});

test("price formatting adapts precision to magnitude and trims trailing zeros", () => {
  assert.equal(formatAlertPrice(64231.5), "64231.5");
  assert.equal(formatAlertPrice(12.3456789), "12.3457");
  assert.equal(formatAlertPrice(0.12345678), "0.123457");
  assert.equal(formatAlertPrice(0.0012345678), "0.00123457");
  assert.equal(formatAlertPrice(100), "100");
});

test("a realistic notification stays far inside the 4 KB Web Push payload limit", () => {
  const msg = formatMaAlertPush(
    { ...alert, symbol: "1000000BABYDOGEUSDT", timeframe: "1d", mode: "near_below" },
    { close: 0.000001234 }, 0.000001311, -5.87
  );
  const bytes = Buffer.byteLength(JSON.stringify(msg), "utf8");
  assert.ok(bytes < MAX_PUSH_PAYLOAD_BYTES, `payload was ${bytes} bytes`);
  assert.ok(bytes < 400, "an MA alert should be a few hundred bytes, not kilobytes");
});

test("the notification is JSON round-trippable — it is serialized before encryption", () => {
  const msg = formatMaAlertPush(alert, { close: 12.3456 }, 12.0, 2.88);
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg);
});

// ── push endpoint host allowlist (SSRF) ────────────────────────────────────

/**
 * A subscription endpoint becomes an outbound POST from this server, so the
 * host rule is a server-side request forgery control, not input tidiness.
 */
test("push endpoints on the real push services are accepted", () => {
  for (const url of [
    "https://web.push.apple.com/QDoAc0nJ...",
    "https://fcm.googleapis.com/fcm/send/abc123",
    "https://android.googleapis.com/gcm/send/abc123",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://sg2p.notify.windows.com/w/?token=abc",
  ]) {
    assert.equal(validatePushEndpoint(url), new URL(url).toString(), url);
  }
});

test("endpoints pointing inside the network are refused", () => {
  for (const url of [
    "https://169.254.169.254/latest/meta-data/",
    "https://localhost/push",
    "https://10.0.0.5/push",
    "https://internal.srtrend.local/push",
    // Suffix matching must not be fooled by a lookalike registrable domain.
    "https://evil-push.apple.com.attacker.test/x",
    "https://notfcm.googleapis.com.evil.test/x",
  ]) {
    assert.throws(() => validatePushEndpoint(url), /host is not allowed/, url);
  }
});

test("push endpoints must be HTTPS on 443, with no embedded credentials", () => {
  assert.throws(() => validatePushEndpoint("http://fcm.googleapis.com/x"), /HTTPS/);
  assert.throws(() => validatePushEndpoint("https://fcm.googleapis.com:8443/x"), /port 443/);
  assert.throws(
    () => validatePushEndpoint("https://u:p@fcm.googleapis.com/x"),
    /credentials are forbidden/
  );
  assert.throws(() => validatePushEndpoint("not-a-url"), /must be a URL/);
});

test("a bare push-service domain is not itself an endpoint host match", () => {
  // ".push.apple.com" is a suffix rule; the apex must not slip through a
  // careless endsWith on a string without the leading dot.
  assert.equal(isAllowedPushHost("web.push.apple.com"), true);
  assert.equal(isAllowedPushHost("xpush.apple.com"), false);
});

// ── liveness, and why last_ok_at cannot provide it ─────────────────────────

/**
 * The distinction this whole mechanism rests on, pinned as a fact about the
 * code rather than a comment.
 *
 * `markDelivered` runs when `webpush.sendNotification` RESOLVES — that is the
 * push service accepting the message, not a device displaying it. Apple keeps
 * accepting endpoints for apps uninstalled weeks earlier, so a ghost's
 * `last_ok_at` stays permanently fresh. Ageing rows out on `last_ok_at` would
 * therefore prune nothing, which is exactly the rule that was proposed and
 * rejected: four dead subscriptions once reported `last_ok_at` of minutes ago
 * while the phone received nothing at all.
 */
test("liveness is pruned on re-registration, never on delivery acceptance", () => {
  const repo = fs.readFileSync(
    path.join(__dirname, "..", "src", "repositories", "pushSubscriptions.ts"), "utf8"
  );

  const prune = repo.slice(repo.indexOf("export async function pruneUnseen"));
  const body = prune.slice(0, prune.indexOf("export async function markDelivered"));
  assert.match(body, /last_seen_at/, "prune must age out on last_seen_at");
  assert.doesNotMatch(
    body.replace(/\/\*[\s\S]*?\*\//g, ""),
    /last_ok_at/,
    "prune must NOT use last_ok_at: the push service accepts dead endpoints"
  );

  // And the upsert must refresh liveness, or a live device ages out.
  const save = repo.slice(repo.indexOf("export async function saveSubscription"));
  assert.match(
    save.slice(0, save.indexOf("export async function listSubscriptions")),
    /last_seen_at = now\(\)/,
    "re-registering must refresh last_seen_at"
  );
});

test("the prune window is a whole number of days and cannot be inverted", () => {
  // `make_interval(days => $1)` with a negative value would delete everything
  // newer than now, i.e. the live device. The caller guards on > 0.
  const index = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8");
  assert.match(index, /staleDays > 0/, "a non-positive window must disable pruning");
  assert.match(index, /PUSH_STALE_DAYS/);
});
