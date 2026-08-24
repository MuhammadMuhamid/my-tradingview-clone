/**
 * Phase 1 boundaries: what must fail, and what must keep working.
 *
 * `config.ts` throws at import time on a misconfiguration, so the fail-closed
 * cases are exercised by importing it in a child process with a specific
 * environment rather than by mutating `process.env` after the fact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isPublishedPlaceholder, parseAuthEnabled } from "../src/config";
import { clientKey, FixedWindowLimiter } from "../src/security/rateLimit";
import { SECURITY_HEADERS } from "../src/api/server";
import { redactResponseBody, MAX_RESPONSE_BODY_CHARS } from "../src/security/secrets";
import { assertSymbol } from "../src/data/binanceRest";

const ROOT = path.join(__dirname, "..");
const VALID_KEY = "x".repeat(40);
const VALID_SECRET = "y".repeat(40);
const VALID_HASH = "scrypt$00112233445566778899aabbccddeeff$" + "0".repeat(64);

/** Import `src/config.ts` in a clean child process; returns its stderr on failure. */
function bootConfig(env: Record<string, string | undefined>): { ok: boolean; message: string } {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? "", NODE_ENV: "test" };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", 'require("./src/config");'],
      { cwd: ROOT, env: clean, stdio: ["ignore", "pipe", "pipe"] }
    );
    return { ok: true, message: "" };
  } catch (err) {
    const e = err as { stderr?: Buffer };
    return { ok: false, message: e.stderr?.toString() ?? "" };
  }
}

const baseEnv = {
  ALERT_ENCRYPTION_KEY: VALID_KEY,
  ALLOWED_WEBHOOK_HOSTS: "bot.example.test",
  SESSION_SECRET: VALID_SECRET,
  ADMIN_PASSWORD_HASH: VALID_HASH,
};

// ── Fail closed ────────────────────────────────────────────────────────────

test("auth enabled with no password hash refuses to start", () => {
  const r = bootConfig({ ...baseEnv, ADMIN_PASSWORD_HASH: undefined });
  assert.equal(r.ok, false);
  assert.match(r.message, /ADMIN_PASSWORD_HASH is required/);
});

test("leaving AUTH_ENABLED unset means enabled — a missing hash is still fatal", () => {
  const r = bootConfig({ ...baseEnv, AUTH_ENABLED: undefined, ADMIN_PASSWORD_HASH: undefined });
  assert.equal(r.ok, false);
  assert.match(r.message, /ADMIN_PASSWORD_HASH is required/);
});

test("a value other than the exact string false does NOT disable auth", () => {
  for (const raw of ["1", "yes", "TRUE", "off", "no"]) {
    const r = bootConfig({ ...baseEnv, AUTH_ENABLED: raw, ADMIN_PASSWORD_HASH: undefined });
    assert.equal(r.ok, false, `AUTH_ENABLED=${raw} must not open the gate`);
  }
});

test("disabling auth deliberately is allowed and needs no hash", () => {
  const r = bootConfig({ ...baseEnv, AUTH_ENABLED: "false", ADMIN_PASSWORD_HASH: undefined });
  assert.equal(r.ok, true, r.message);
});

test("a short or placeholder session secret refuses to start", () => {
  assert.equal(bootConfig({ ...baseEnv, SESSION_SECRET: "short" }).ok, false);
  const placeholder = bootConfig({ ...baseEnv, SESSION_SECRET: "replace-with-openssl-rand-hex-32" });
  assert.equal(placeholder.ok, false);
  assert.match(placeholder.message, /published placeholder/);
});

test("a short encryption key refuses to start", () => {
  assert.equal(bootConfig({ ...baseEnv, ALERT_ENCRYPTION_KEY: "tooshort" }).ok, false);
});

test("an empty webhook host allowlist refuses to start rather than silently rejecting every send", () => {
  const r = bootConfig({ ...baseEnv, ALLOWED_WEBHOOK_HOSTS: undefined });
  assert.equal(r.ok, false);
  assert.match(r.message, /ALLOWED_WEBHOOK_HOSTS must list at least one host/);
});

test("the fully-configured environment starts", () => {
  const r = bootConfig(baseEnv);
  assert.equal(r.ok, true, r.message);
});

// ── AUTH_ENABLED parse rule ────────────────────────────────────────────────

test("the AUTH_ENABLED parse rule is opt-out and matches the frontend's", () => {
  assert.equal(parseAuthEnabled(undefined), true);
  assert.equal(parseAuthEnabled(""), true);
  assert.equal(parseAuthEnabled("false"), false);
  assert.equal(parseAuthEnabled(" FALSE "), false);
  for (const raw of ["1", "0", "yes", "no", "true", "off"]) {
    assert.equal(parseAuthEnabled(raw), true, raw);
  }
});

test("published placeholder detection covers the values this repository ships", () => {
  for (const v of [
    "replace-with-openssl-rand-hex-32", "REPLACE_ME", "change-me",
    "PASTE_YOUR_BOT_SECRET_HERE", "dev-insecure-key",
  ]) {
    assert.equal(isPublishedPlaceholder(v), true, v);
  }
  for (const v of ["", "a-genuinely-random-40-character-secret-xx", "hunter2"]) {
    assert.equal(isPublishedPlaceholder(v), false, v);
  }
});

// ── Login rate limit ───────────────────────────────────────────────────────

test("the limiter allows the configured burst, then refuses with a retry hint", () => {
  const limiter = new FixedWindowLimiter(5, 60_000);
  const now = 1_700_000_000_000;
  for (let i = 1; i <= 5; i++) {
    assert.equal(limiter.hit("1.2.3.4", now).allowed, true, `attempt ${i}`);
  }
  const blocked = limiter.hit("1.2.3.4", now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
});

test("the window resets, so a lockout is not permanent", () => {
  const limiter = new FixedWindowLimiter(2, 60_000);
  limiter.hit("a", 0);
  limiter.hit("a", 0);
  assert.equal(limiter.hit("a", 0).allowed, false);
  assert.equal(limiter.hit("a", 60_001).allowed, true);
});

test("clients are counted separately", () => {
  const limiter = new FixedWindowLimiter(1, 60_000);
  assert.equal(limiter.hit("a", 0).allowed, true);
  assert.equal(limiter.hit("a", 0).allowed, false);
  assert.equal(limiter.hit("b", 0).allowed, true);
});

test("a successful sign-in clears the client's earlier failures", () => {
  const limiter = new FixedWindowLimiter(3, 60_000);
  limiter.hit("a", 0);
  limiter.hit("a", 0);
  limiter.hit("a", 0);
  assert.equal(limiter.hit("a", 0).allowed, false);
  limiter.reset("a");
  assert.equal(limiter.hit("a", 0).allowed, true);
});

test("distinct-key growth is bounded, so forged client addresses cannot exhaust memory", () => {
  const limiter = new FixedWindowLimiter(5, 60_000, 16);
  for (let i = 0; i < 1000; i++) limiter.hit(`ip-${i}`, 0);
  for (let i = 1; i <= 5; i++) assert.equal(limiter.hit("stable", 0).allowed, true);
  assert.equal(limiter.hit("stable", 0).allowed, false);
});

test("a forwarded client address is trusted only when TRUST_PROXY is on, and only the left-most entry", () => {
  assert.equal(clientKey("10.0.0.1", "203.0.113.9, 10.0.0.2", true), "203.0.113.9");
  assert.equal(clientKey("10.0.0.1", "203.0.113.9", false), "10.0.0.1");
  assert.equal(clientKey("10.0.0.1", undefined, true), "10.0.0.1");
  assert.equal(clientKey(undefined, undefined, false), "unknown");
  assert.equal(clientKey("10.0.0.1", ["198.51.100.7", "spoof"], true), "198.51.100.7");
  // A header that is present but empty must not produce an empty bucket key.
  assert.equal(clientKey("10.0.0.1", " , 10.0.0.2", true), "10.0.0.1");
});

// ── Security headers ───────────────────────────────────────────────────────

test("the API sends the frame, sniffing, referrer and CSP headers", () => {
  assert.equal(SECURITY_HEADERS["X-Frame-Options"], "DENY");
  assert.equal(SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
  assert.equal(SECURITY_HEADERS["Referrer-Policy"], "no-referrer");
  assert.equal(SECURITY_HEADERS["Cache-Control"], "no-store");
  const csp = SECURITY_HEADERS["Content-Security-Policy"]!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
});

// ── Response-body redaction ────────────────────────────────────────────────

test("a receiver response that echoes the secret is scrubbed before storage", () => {
  const body = '{"status":"ok","echo":{"secret":"abcdef0123456789abcdef0123456789"}}';
  const out = redactResponseBody(body)!;
  assert.ok(!out.includes("abcdef0123456789"), out);
  assert.match(out, /\[REDACTED\]/);
  assert.match(out, /"status":"ok"/);
});

test("a bare credential-shaped run in free text is scrubbed", () => {
  const out = redactResponseBody("Invalid secret aabbccddeeff00112233445566778899aabbccdd")!;
  assert.ok(!/[0-9a-f]{32,}/.test(out), out);
});

test("bot_uuid and token fields are scrubbed too", () => {
  const out = redactResponseBody('{"bot_uuid":"1234","token":"xyz"}')!;
  assert.ok(!out.includes("1234"), out);
  assert.ok(!out.includes("xyz"), out);
});

test("an ordinary diagnostic body survives, so the alert feed stays useful", () => {
  assert.equal(redactResponseBody('{"status":"ignored_stale_sell"}'), '{"status":"ignored_stale_sell"}');
  assert.equal(
    redactResponseBody('{"error":"Pair XYZUSDT not allowed for this bot"}'),
    '{"error":"Pair XYZUSDT not allowed for this bot"}'
  );
  assert.equal(redactResponseBody(null), null);
  assert.equal(redactResponseBody(undefined), null);
});

test("a huge body is truncated rather than stored whole", () => {
  // A long run of word characters is itself credential-shaped, so it collapses
  // to the marker before truncation ever applies.
  assert.equal(redactResponseBody("x".repeat(50_000)), "[REDACTED]");
  // A body of ordinary prose is truncated at the cap instead.
  const prose = ("the receiver said no. ").repeat(500);
  const out = redactResponseBody(prose)!;
  assert.equal(out.length, MAX_RESPONSE_BODY_CHARS);
  assert.ok(prose.length > MAX_RESPONSE_BODY_CHARS);
});

// ── Symbol validation ──────────────────────────────────────────────────────

test("path- and stream-unsafe symbols are rejected at the choke point", () => {
  assert.equal(assertSymbol("aptusdt"), "APTUSDT");
  for (const bad of [
    "../../etc/passwd",
    "APT/USDT",
    "APT.USDT",
    "APT USDT",
    "A",
    "BTCUSDT@kline_1m/ETHUSDT@kline_1m",
    "APTUSDT ",
    "",
    "A".repeat(25),
  ]) {
    assert.throws(() => assertSymbol(bad), /invalid symbol/, JSON.stringify(bad));
  }
});
