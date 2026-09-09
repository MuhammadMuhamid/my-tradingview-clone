/**
 * FE-02: the post-sign-in redirect target is attacker-supplied and was assigned
 * straight to `window.location.href`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AFTER_LOGIN, safeNextPath } from "../lib/safeRedirect";

test("a normal in-app path is preserved, query and fragment included", () => {
  assert.equal(safeNextPath("/chart"), "/chart");
  assert.equal(safeNextPath("/chart?symbol=APTUSDT&interval=15m"), "/chart?symbol=APTUSDT&interval=15m");
  assert.equal(safeNextPath("/research/42#trades"), "/research/42#trades");
});

test("an absent or empty target falls back to the default", () => {
  for (const raw of [null, undefined, "", "   "]) {
    assert.equal(safeNextPath(raw), DEFAULT_AFTER_LOGIN, JSON.stringify(raw));
  }
});

test("script-scheme targets are refused", () => {
  for (const raw of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "%6a%61%76%61%73%63%72%69%70%74%3aalert(1)",
  ]) {
    assert.equal(safeNextPath(raw), DEFAULT_AFTER_LOGIN, JSON.stringify(raw));
  }
});

test("off-origin targets are refused, including protocol-relative and backslash forms", () => {
  for (const raw of [
    "https://evil.test/phish",
    "http://evil.test",
    "//evil.test",
    "/\\evil.test",
    "\\\\evil.test",
    "/path\\..\\..\\evil",
    "%2f%2fevil.test",
    "https:/evil.test",
  ]) {
    assert.equal(safeNextPath(raw), DEFAULT_AFTER_LOGIN, JSON.stringify(raw));
  }
});

test("a target that would loop back to the login page is refused", () => {
  assert.equal(safeNextPath("/login"), DEFAULT_AFTER_LOGIN);
  assert.equal(safeNextPath("/login?next=%2Flogin"), DEFAULT_AFTER_LOGIN);
  assert.equal(safeNextPath("/login/extra"), DEFAULT_AFTER_LOGIN);
  // A path that merely starts with the same letters is fine.
  assert.equal(safeNextPath("/logins-report"), "/logins-report");
});

test("a malformed percent-encoding is refused rather than passed through", () => {
  assert.equal(safeNextPath("/%E0%A4%A"), DEFAULT_AFTER_LOGIN);
});

test("the returned value is always a same-origin absolute path", () => {
  const probes = [
    "/chart", "/trading", "https://evil.test", "//evil.test", "javascript:1",
    "", null, "/login", "/a?b=c#d",
  ];
  for (const raw of probes) {
    const out = safeNextPath(raw);
    assert.ok(out.startsWith("/"), out);
    assert.ok(!out.startsWith("//"), out);
    assert.ok(!out.includes(":") || out.indexOf(":") > out.indexOf("?"), out);
  }
});
