/**
 * OD-2 on screen: the shared six-digit code field, the step-up dialog's grant
 * awareness and "Lock now", the Apple-Passwords-first enrollment card with its
 * recovery-code Copy/Download, the sign-in second step, and Operations halt,
 * resume and limits confirmed through the dialog.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { assertPresent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import { StepUpDialog } from "@/components/bot/StepUpDialog";
import { groupSetupKey, recoveryCodesFile } from "@/components/AccountSecurity";
import { normaliseOneTimeCode } from "@/components/OneTimeCodeInput";
import LoginPage from "@/app/login/page";
import ProfilePage from "@/app/profile/page";
import OperationsPage from "@/app/operations/page";
import { loadSession, resetSessionForTests } from "@/lib/session";
import type { BotCredential, OpsStatus } from "@/lib/api";
import { account } from "./botFixtures";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const IN_FIVE = () => new Date(Date.now() + 4 * 60_000).toISOString();

function dialog(props: { tier?: "grant" | "fresh"; onConfirm: (credential: BotCredential) => Promise<{ close: true } | { close: false; error: string; method?: "totp" | "password" }> }) {
  let closed = 0;
  render(<StepUpDialog open title="Halt the Bot" intro={<p>Halts.</p>} confirmLabel="Halt" danger autoSubmit
    tier={props.tier} onCancel={() => { closed += 1; }} onConfirm={props.onConfirm} />);
  return { closed: () => closed };
}

test("the code field: numeric pad, one-time-code autofill, six digits, labelled, and pasted spaces or dashes normalised", () => {
  assert.equal(normaliseOneTimeCode("123 456"), "123456");
  assert.equal(normaliseOneTimeCode("123-456"), "123456");
  assert.equal(normaliseOneTimeCode(" 1234567 "), "123456");
  assert.equal(normaliseOneTimeCode("abc"), "");
  assert.equal(groupSetupKey("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), "ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567");
  const file = recoveryCodesFile(["AAAAA-BBBBB", "CCCCC-DDDDD"], new Date("2026-11-09T00:00:00Z"));
  assert.match(file, /^Trading Scene recovery codes\nSaved 2026-11-09\. Each code works once\.\n\nAAAAA-BBBBB\nCCCCC-DDDDD\n$/);
});

test("grant tier, valid grant: no code asked, 'no code needed until HH:MM', confirm sends no credential", async () => {
  account("admin", { twoFactorEnabled: true });
  await loadSession();
  server.routes.set("GET /api/auth/step-up/status", () => ({ twoFactorEnabled: true, method: "totp",
    grant: { valid: true, expiresAt: IN_FIVE() } }));
  const sent: BotCredential[] = [];
  const view = dialog({ tier: "grant", onConfirm: async (credential) => { sent.push(credential); return { close: true }; } });
  await settle(4);
  const box = screen.getByRole("dialog", { name: "Halt the Bot" });
  assert.match(box.textContent ?? "", /Confirmed — no code needed until \d{1,2}:\d{2}/);
  assert.equal(within(box).queryByLabelText("Code from your authenticator app"), null);
  fireEvent.click(within(box).getByRole("button", { name: "Halt" }));
  await settle(3);
  assert.deepEqual(sent, [{}], "the grant cookie confirms; nothing typed is sent");
  assert.equal(view.closed(), 1);
});

test("Lock now ends the grant and the code is asked again", async () => {
  account("admin", { twoFactorEnabled: true });
  await loadSession();
  server.routes.set("GET /api/auth/step-up/status", () => ({ twoFactorEnabled: true, method: "totp",
    grant: { valid: true, expiresAt: IN_FIVE() } }));
  let revoked = 0;
  server.routes.set("POST /api/auth/step-up/revoke", () => { revoked += 1; return { ok: true }; });
  dialog({ tier: "grant", onConfirm: async () => ({ close: true }) });
  await settle(4);
  fireEvent.click(screen.getByRole("button", { name: "Lock now" }));
  await settle(4);
  assert.equal(revoked, 1);
  assert.ok(screen.getByLabelText("Code from your authenticator app"));
  assert.equal(document.querySelector('[data-step-up-grant="valid"]'), null);
});

test("fresh tier never asks about a grant; the sixth digit confirms, once", async () => {
  account("admin", { twoFactorEnabled: true });
  await loadSession();
  const sent: BotCredential[] = [];
  dialog({ tier: "fresh", onConfirm: async (credential) => { sent.push(credential); return { close: true }; } });
  await settle(3);
  assert.equal(server.callsTo("/api/auth/step-up/status").length, 0);
  const code = screen.getByLabelText("Code from your authenticator app") as HTMLInputElement;
  assert.deepEqual([code.inputMode, code.autocomplete, code.getAttribute("pattern"), code.maxLength, code.getAttribute("enterkeyhint")],
    ["numeric", "one-time-code", "[0-9]*", 6, "done"]);
  fireEvent.paste(code, { clipboardData: { getData: () => "123 456" } });
  fireEvent.click(screen.getByRole("button", { name: /Halt|Sending/ }));
  await settle(4);
  assert.deepEqual(sent, [{ code: "123456" }], "sixth digit and a click together are one confirmation");
});

test("a grant the server no longer honours: the server's method appears and the code is asked", async () => {
  account("admin", { twoFactorEnabled: true });
  await loadSession();
  server.routes.set("GET /api/auth/step-up/status", () => ({ twoFactorEnabled: true, method: "totp",
    grant: { valid: true, expiresAt: IN_FIVE() } }));
  const sent: BotCredential[] = [];
  dialog({ tier: "grant", onConfirm: async (credential) => {
    sent.push(credential);
    return sent.length === 1 ? { close: false, error: "Enter the code from your authenticator app to confirm.", method: "totp" }
      : { close: true };
  } });
  await settle(4);
  fireEvent.click(screen.getByRole("button", { name: "Halt" }));
  await settle(4);
  assert.match(screen.getByRole("alert").textContent ?? "", /Enter the code/);
  const code = screen.getByLabelText("Code from your authenticator app");
  fireEvent.change(code, { target: { value: "654321" } });
  await settle(4);
  assert.deepEqual(sent, [{}, { code: "654321" }]);
});

test("sign-in's second step uses the shared field and submits on the sixth digit", async () => {
  server.routes.set("GET /api/auth/me", () => ({ authenticated: false, authEnabled: true, user: null,
    providers: { google: false, github: false, signups: true, email: false } }));
  const attempts: unknown[] = [];
  server.routes.set("POST /api/auth/2fa/login", (body) => { attempts.push(body); return json(401, { error: "That code isn't correct." }); });
  render(<AppRoute path="/login" query="step=2fa"><LoginPage /></AppRoute>);
  await settle(4);
  const code = screen.getByLabelText("Code") as HTMLInputElement;
  assert.deepEqual([code.inputMode, code.autocomplete, code.maxLength, code.getAttribute("pattern")],
    ["numeric", "one-time-code", 6, "[0-9]*"]);
  fireEvent.paste(code, { clipboardData: { getData: () => "123-456" } });
  await settle(4);
  assert.deepEqual(attempts, [{ code: "123456" }]);
  assert.match(screen.getByRole("alert").textContent ?? "", /isn't correct/);
});

test("enrollment: Apple Passwords copy, one-tap otpauth link, grouped key with Copy, the honest trade-off, sixth digit turns it on", async () => {
  const USER = { id: "22222222-2222-4222-8222-222222222222", email: "trader@example.test", displayName: "Trader",
    avatarUrl: null, role: "user", onboarded: true, hasPassword: true, passwordManagedByServer: false,
    googleLinked: false, githubLinked: false, emailVerified: true, twoFactorEnabled: false,
    moneyFeaturesUnlocked: false, createdAt: "2026-10-16T00:00:00.000Z" };
  server.routes.set("GET /api/auth/me", () => ({ authenticated: true, authEnabled: true, user: USER,
    providers: { google: false, github: false, signups: true, email: true } }));
  server.routes.set("GET /api/auth/login-history", () => ({ logins: [] }));
  const SECRET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const seen: unknown[] = [];
  server.routes.set("POST /api/auth/2fa/setup", (body) => { seen.push(body);
    return { secret: SECRET, otpauthUrl: `otpauth://totp/Trading%20Scene:trader?secret=${SECRET}`, qrDataUrl: "data:image/png;base64,AAAA" }; });
  server.routes.set("POST /api/auth/2fa/enable", (body) => { seen.push(body); return { ok: true, recoveryCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"] }; });
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const downloads: string[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (() => "blob:recovery") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { downloads.push(`${this.download} ${this.href}`); };
  try {
    render(<AppRoute path="/profile"><ProfilePage /></AppRoute>);
    await settle(6);
    fireEvent.click(screen.getByRole("button", { name: "Password & sign-in" }));
    await settle(4);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up two-factor sign-in" }));
    await settle(4);
    const body = document.body.textContent ?? "";
    assert.ok(body.includes("Use Apple Passwords (iCloud Keychain): scan this QR code with your iPhone camera or Passwords app, "
      + "or paste the setup key into Passwords on your Mac. Codes can then autofill in supported browsers. Google "
      + "Authenticator, Microsoft Authenticator, 1Password and any RFC 6238 app also work."), "the Apple Passwords copy, exactly");
    assert.ok(body.includes("If your password and codes are both in Apple Passwords, sign-in is more convenient but the two "
      + "factors are less separated than an authenticator on a different device."), "the trade-off, exactly");
    assert.equal(/autofill (works|will work) everywhere/i.test(body), false);
    const link = screen.getByRole("link", { name: "Open in Passwords / authenticator app" });
    assert.match(link.getAttribute("href") ?? "", /^otpauth:\/\/totp\//);
    assert.equal(screen.getByTestId("tf-setup-key").textContent, "ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567");
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
    await settle(2);
    assert.deepEqual(copied, [SECRET]);
    fireEvent.change(screen.getByLabelText("6-digit code from your app"), { target: { value: "123456" } });
    await settle(4);
    assert.deepEqual(seen, [{ password: "correct horse battery" }, { code: "123456" }], "the sixth digit turned it on");
    fireEvent.click(screen.getByRole("button", { name: "Copy codes" }));
    await settle(2);
    assert.equal(copied[1], "AAAAA-BBBBB\nCCCCC-DDDDD");
    fireEvent.click(screen.getByRole("button", { name: "Download .txt" }));
    assert.deepEqual(downloads, ["trading-scene-recovery-codes.txt blob:recovery"]);
    assert.equal(server.callsTo("recovery").length, 0, "the codes file is made in the browser, never sent");
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    HTMLAnchorElement.prototype.click = realClick;
  }
});

function opsStatus(halted: boolean): OpsStatus {
  return {
    mode: halted ? "HALTED" : "DISABLED",
    emitter: { thisProcess: "p1", liveRunnerEnabled: false, holdsLease: false, lease: null },
    risk: {
      tradingHalted: halted, haltedReason: halted ? "test" : null, haltedBy: halted ? "operator" : null, haltedAt: null,
      maxTotalExposureQuote: null, maxConcurrentPositions: null, maxDailyLossQuote: null, dailyLossWindowHours: 24,
      snapshot: { currentExposureQuote: 0, openPositions: 0, realisedPnlInWindow: null },
      summary: "ACTIVE", dailyLossControl: { state: "DISABLED_UNFED", authority: "BOT", note: "" },
    },
    bot: { state: "UNAVAILABLE", configuredEndpoints: 1, reason: "request_failed" },
    database: { ready: true, checks: { database: "ok", schema: "current" }, schema: { expected: 1, applied: 1, missing: [] }, time: "2026-11-09T12:00:00.000Z" },
    alertRunner: { state: "disabled", active: 0, recent: 0, stale: 0, withoutEvidence: 0, lastEvaluatedAt: null, reason: "" },
    deployments: { total: 0, active: 0, long: 0, paused: 0, paper: 0, automated: 0, signalOnly: 0 },
    delivery: { state: "idle", summary: "", windowHours: 24, counts: { pending: 0, sent: 0, failed: 0, skipped: 0, blocked: 0 },
      total: 0, lastSentAt: null, lastFailureAt: null, stuckPending: 0, retried: 0 },
    exchange: { testnetConfigured: true, note: "" },
    feeds: { worst: "live", rows: [] },
    time: "2026-11-09T12:00:00.000Z",
  } as OpsStatus;
}

test("Operations: Halt asks for step-up; a wrong code keeps the dialog; the right one halts with the reason", async () => {
  account("admin", { twoFactorEnabled: true });
  server.routes.set("GET /api/ops/status", () => opsStatus(false));
  const sent: Record<string, unknown>[] = [];
  server.routes.set("POST /api/ops/halt", (body) => {
    sent.push(body as Record<string, unknown>);
    const code = ((body as { credential?: { code?: string } }).credential?.code);
    return code === "111111" ? { halted: true, reason: "exchange outage" }
      : json(400, { code: "step_up_failed", method: "totp", tier: "grant", error: "That code isn't correct, or it was already used." });
  });
  render(<AppRoute path="/operations"><OperationsPage /></AppRoute>);
  await settle(8);
  fireEvent.change(screen.getByPlaceholderText(/exchange outage/), { target: { value: "exchange outage" } });
  fireEvent.click(screen.getByRole("button", { name: "Halt all trading" }));
  await settle(3);
  const box = assertPresent(screen.queryByRole("dialog", { name: "Halt all trading" }), "halt step-up dialog") as HTMLElement;
  assert.equal(sent.length, 0, "nothing is sent before the confirmation");
  fireEvent.change(within(box).getByLabelText("Code from your authenticator app"), { target: { value: "000000" } });
  await settle(4);
  assert.match(within(box).getByRole("alert").textContent ?? "", /isn't correct/);
  fireEvent.change(within(box).getByLabelText("Code from your authenticator app"), { target: { value: "111111" } });
  await settle(6);
  assert.deepEqual(sent.map((b) => [b.confirmation, b.reason, b.credential]), [
    ["HALT_TRADING", "exchange outage", { code: "000000" }], ["HALT_TRADING", "exchange outage", { code: "111111" }],
  ]);
  assert.equal(screen.queryByRole("dialog", { name: "Halt all trading" }), null);
  assert.match(document.body.textContent ?? "", /Trading halted\./);
});

test("Operations: Resume and risk limits are confirmed too; limits always ask (fresh tier)", async () => {
  account("admin", { twoFactorEnabled: true });
  server.routes.set("GET /api/ops/status", () => opsStatus(true));
  server.routes.set("GET /api/auth/step-up/status", () => ({ twoFactorEnabled: true, method: "totp",
    grant: { valid: true, expiresAt: IN_FIVE() } }));
  const resumed: unknown[] = [];
  server.routes.set("POST /api/ops/resume", (body) => { resumed.push(body); return { halted: false }; });
  const limits: unknown[] = [];
  server.routes.set("PATCH /api/ops/risk-limits", (body) => { limits.push(body); return opsStatus(true).risk; });
  render(<AppRoute path="/operations"><OperationsPage /></AppRoute>);
  await settle(8);
  fireEvent.click(screen.getByRole("button", { name: "Resume trading…" }));
  await settle(4);
  const box = screen.getByRole("dialog", { name: "Resume trading" });
  assert.match(box.textContent ?? "", /no code needed until/);
  fireEvent.click(within(box).getByRole("button", { name: "Yes, resume trading" }));
  await settle(6);
  assert.deepEqual(resumed, [{ confirmation: "RESUME_TRADING", credential: {} }]);

  fireEvent.click(screen.getByRole("button", { name: "Edit limits" }));
  await settle(2);
  fireEvent.change(screen.getByLabelText("Maximum concurrent positions"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
  await settle(4);
  const limitBox = screen.getByRole("dialog", { name: "Change the Platform's risk limits" });
  assert.equal(/no code needed/.test(limitBox.textContent ?? ""), false, "a grant never stands in for a limit change");
  assert.equal(limits.length, 0);
  fireEvent.change(within(limitBox).getByLabelText("Code from your authenticator app"), { target: { value: "222222" } });
  await settle(6);
  assert.deepEqual(limits, [{ maxTotalExposureQuote: null, maxConcurrentPositions: 3, credential: { code: "222222" } }]);
});
