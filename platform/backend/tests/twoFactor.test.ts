/** TOTP against the published RFC 6238 vectors, and the sign-in proof between factors. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, matchTotpStep, openPendingSignIn,
  sealPendingSignIn, totpCode, totpStepAt, totpUrl,
} from "../src/security/twoFactor";
import { GithubSignInError, exchangeGithubCode, githubAuthorizeUrl } from "../src/security/github";
import { newOAuthState } from "../src/security/google";

// "12345678901234567890" in base32, the RFC's SHA-1 key.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("codes match RFC 6238's SHA-1 vectors, truncated to 6 digits", () => {
  for (const [time, code] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"],
    [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]] as const) {
    assert.equal(totpCode(RFC_SECRET, totpStepAt(time * 1000)), code, String(time));
  }
});

test("a code is accepted one step either side and no further", () => {
  const now = 1234567890_000;
  const step = totpStepAt(now);
  for (const offset of [-1, 0, 1]) {
    assert.equal(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, step + offset), 0, now), step + offset);
  }
  for (const offset of [-2, 2]) {
    assert.equal(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, step + offset), 0, now), null);
  }
});

test("a used step can't be used again, nor an earlier one", () => {
  const now = 1234567890_000;
  const step = totpStepAt(now);
  assert.equal(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, step), step, now), null);
  assert.equal(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, step - 1), step, now), null);
  assert.equal(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, step + 1), step, now), step + 1);
});

test("anything but six digits is refused", () => {
  for (const bad of ["", "12345", "1234567", "abcdef", "12 456"]) {
    assert.equal(matchTotpStep(RFC_SECRET, bad, 0), null, bad);
  }
});

test("secrets decode, and the app link carries them", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.match(totpCode(secret, 1), /^\d{6}$/);
  const url = new URL(totpUrl(secret, "a+b@example.com", "Trading Scene"));
  assert.equal(url.protocol, "otpauth:");
  assert.equal(url.searchParams.get("secret"), secret);
  assert.equal(url.searchParams.get("issuer"), "Trading Scene");
});

test("recovery codes are distinct, and matching ignores case and dashes", () => {
  const codes = generateRecoveryCodes();
  assert.equal(new Set(codes).size, 10);
  assert.equal(hashRecoveryCode(codes[0]!), hashRecoveryCode(codes[0]!.toLowerCase().replace("-", "")));
  assert.notEqual(hashRecoveryCode(codes[0]!), hashRecoveryCode(codes[1]!));
});

test("the proof between factors can't be forged or kept", () => {
  const secret = "s".repeat(40);
  const input = { userId: "u", version: 1, method: "password" as const };
  const sealed = sealPendingSignIn(input, secret, 1000);
  assert.equal(openPendingSignIn(sealed, secret, 1000)?.userId, "u");
  assert.equal(openPendingSignIn(sealed, "x".repeat(40), 1000), null);
  assert.equal(openPendingSignIn(sealed, secret, 1000 + 5 * 60_000 + 1), null);
  const [body, mac] = sealed.split(".");
  assert.equal(openPendingSignIn(`${body}x.${mac}`, secret, 1000), null);
  assert.equal(openPendingSignIn(null, secret), null);
});

function githubFetch(emails: unknown, profile: unknown = { id: 42, login: "octo", name: "Octo", avatar_url: "https://a.example/x.png" }) {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("login/oauth/access_token")) return Response.json({ access_token: "t" });
    if (u.endsWith("/user")) return Response.json(profile);
    if (u.endsWith("/user/emails")) return Response.json(emails);
    throw new Error(`unexpected ${u}`);
  }) as typeof fetch;
}
const exchange = (fetchImpl: typeof fetch) => exchangeGithubCode({
  code: "c", verifier: "v", clientId: "id", clientSecret: "secret", redirectUri: "https://x/cb", fetchImpl,
});

test("GitHub gives the stable id and the primary, verified address", async () => {
  const identity = await exchange(githubFetch([
    { email: "other@example.com", primary: false, verified: true },
    { email: "Me@Example.com", primary: true, verified: true },
  ]));
  assert.deepEqual(identity, { id: "42", email: "me@example.com", name: "Octo", picture: "https://a.example/x.png" });
});

test("GitHub without a verified primary address is refused", async () => {
  for (const emails of [[], [{ email: "a@example.com", primary: true, verified: false }],
    [{ email: "a@example.com", primary: false, verified: true }], { message: "nope" }]) {
    await assert.rejects(exchange(githubFetch(emails)), GithubSignInError);
  }
});

test("GitHub's authorize link uses PKCE and asks only for identity", () => {
  const state = newOAuthState("/chart", null);
  const url = new URL(githubAuthorizeUrl({ clientId: "id", redirectUri: "https://x/cb", state }));
  assert.equal(url.searchParams.get("state"), state.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "read:user user:email");
  assert.equal(url.searchParams.get("client_secret"), null);
});
