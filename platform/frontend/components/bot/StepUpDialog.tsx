"use client";
/**
 * The confirm-and-re-authenticate dialog every Bot command goes through.
 *
 * Which credential it asks for mirrors the server's rule (contract §3), so a
 * person is never asked for something that cannot work:
 *   - two-factor on: the code from the authenticator app, only;
 *   - two-factor off: the password, for Halt only;
 *   - otherwise: nothing to ask for. The dialog says to turn on two-factor
 *     and offers no confirm button.
 * The server decides in the end; if it says otherwise (`step_up_required`
 * naming a method) the dialog follows it.
 *
 * Step-up grants (OD-2): for a `grant`-tier command the dialog asks the server
 * (`/api/auth/step-up/status`) whether this browser holds a valid grant from a
 * recent code. If it does, no code is asked: it says "Confirmed — no code
 * needed until HH:MM", offers "Lock now", and confirms with an empty
 * credential (the server checks the grant). If the server then answers that a
 * code is needed after all, the code field appears. `fresh`-tier commands (the
 * default, the safe one) always ask.
 *
 * The code field is the shared six-digit input: numeric keypad, one-time-code
 * autofill, paste of "123 456" normalised, and the sixth digit confirms.
 *
 * The credential lives in this component's state while it is open and is
 * cleared when it closes. It is sent once, with the command, and never kept.
 */
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Modal } from "@/components/Modal";
import { Button, Field, Notice, TextInput } from "@/components/ui";
import { OneTimeCodeInput } from "@/components/OneTimeCodeInput";
import { useSession } from "@/lib/session";
import { stepUpApi, type BotCredential } from "@/lib/api";
import type { DialogResult } from "./commandRunner";

/** "14:05": when a grant ends, in the reader's own clock. */
const untilTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function StepUpDialog({ open, title, intro, children, confirmLabel, danger = false, allowsPassword = false,
  canConfirm = true, onCancel, onConfirm, initialMethod = null, tier = "fresh", autoSubmit = false }: {
  open: boolean;
  title: string;
  intro: ReactNode;
  /** The command's own fields (a reason, a percentage). */
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Halt alone may be confirmed with the password when two-factor is off. */
  allowsPassword?: boolean;
  canConfirm?: boolean;
  /** Closes the dialog: Cancel, Escape, or once a command has been sent. */
  onCancel: () => void;
  onConfirm: (credential: BotCredential) => Promise<DialogResult>;
  /** The credential a refusal that opened this dialog already named (`step_up_required` with `method`). */
  initialMethod?: "totp" | "password" | null;
  /**
   * OD-2: `grant` lets a valid step-up grant stand in for the code (halt,
   * resume, start/stop, close, partial, pause entries, Platform halt/resume,
   * manual BUY). Default `fresh`: always ask (risk limits, and anything that
   * does not say).
   */
  tier?: "grant" | "fresh";
  /**
   * OD-2: confirm on the sixth digit. Opt-in so existing callers keep their
   * type-then-click behaviour until they choose it (Operations, the manual
   * BUY and the profile pass it).
   */
  autoSubmit?: boolean;
}) {
  const session = useSession();
  const user = session?.user ?? null;
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverMethod, setServerMethod] = useState<"totp" | "password" | null>(initialMethod);
  /** OD-2: a valid grant this browser holds (grant tier only), until when; null = none or unknown. */
  const [grantUntil, setGrantUntil] = useState<string | null>(null);
  /** Set once the server has asked for a credential anyway: the grant view is then not offered again. */
  const [grantRefused, setGrantRefused] = useState(false);
  const [locking, setLocking] = useState(false);
  const formId = useId();
  // One confirmation at a time, even when the sixth digit and a click arrive together.
  const sending = useRef(false);

  useEffect(() => {
    if (open) { setServerMethod(initialMethod); return; }
    setCode(""); setPassword(""); setError(""); setBusy(false); setServerMethod(null);
    setGrantUntil(null); setGrantRefused(false); setLocking(false);
  }, [open, initialMethod]);

  // Ask once per opening, grant tier only. A failed read is "no grant": the code is asked.
  useEffect(() => {
    if (!open || tier !== "grant") return;
    let cancelled = false;
    stepUpApi.status()
      .then((status) => {
        if (cancelled) return;
        setGrantUntil(status.grant.valid && status.grant.expiresAt ? status.grant.expiresAt : null);
      })
      .catch(() => { if (!cancelled) setGrantUntil(null); });
    return () => { cancelled = true; };
  }, [open, tier]);

  const authOff = session !== null && !session.authEnabled;
  const usingGrant = tier === "grant" && grantUntil !== null && !grantRefused
    && Date.parse(grantUntil) > Date.now();
  const method: "totp" | "password" | null = serverMethod
    ?? (user?.twoFactorEnabled ? "totp" : allowsPassword && user?.hasPassword ? "password" : null);
  const supplied = usingGrant ? true
    : method === "totp" ? code.trim().length > 0 : method === "password" ? password.length > 0 : false;
  const ready = !authOff && (usingGrant || method !== null) && supplied && canConfirm && !busy;

  const submit = async (typed?: string) => {
    if (sending.current) return;
    const totp = typed ?? code;
    const credential: BotCredential = usingGrant ? {}
      : method === "totp" ? { code: totp.replace(/\s/g, "") } : { password };
    const have = usingGrant || (method === "totp" ? totp.trim().length > 0 : method === "password" && password.length > 0);
    if (authOff || !have || !canConfirm || busy) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await onConfirm(credential);
      // Sent (or refused for good): the outcome is reported on the page, not here.
      if (result.close) { onCancel(); return; }
      setError(result.error);
      if (result.method) { setServerMethod(result.method); setGrantRefused(true); }
      // A code works once: a refused one is cleared so the next attempt is a fresh one.
      setCode("");
    } finally {
      // Whatever happened, the dialog never stays stuck on "Sending…".
      sending.current = false;
      setBusy(false);
    }
  };

  /** "Lock now": this browser's grant ends; the next confirmation asks for a code. */
  const lockNow = async () => {
    setLocking(true);
    try { await stepUpApi.revoke(); } catch { /* the server ends it on expiry anyway */ }
    setGrantUntil(null);
    setLocking(false);
  };

  return (
    <Modal open={open} onClose={onCancel} title={title}
      footer={<>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        {(method !== null || usingGrant) && !authOff && (
          <Button variant={danger ? "danger" : "contrast"} disabled={!ready} onClick={() => void submit()}>
            {busy ? "Sending…" : confirmLabel}
          </Button>
        )}
      </>}>
      <form id={formId} className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}
        onKeyDown={(event) => {
          // Enter in a field confirms; the confirm button itself lives in the dialog's footer.
          if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") {
            event.preventDefault();
            void submit();
          }
        }}>
        <div className="space-y-2 text-sm text-ink">{intro}</div>
        {children}
        {authOff ? (
          <Notice tone="warn">Bot commands need sign-in to be turned on for this installation. Reads still work.</Notice>
        ) : usingGrant ? (
          <div className="flex flex-wrap items-center justify-between gap-2" data-step-up-grant="valid">
            <Notice tone="success" role="status">
              Confirmed — no code needed until {untilTime(grantUntil!)}.
            </Notice>
            <Button variant="ghost" disabled={locking || busy} onClick={() => void lockNow()}>Lock now</Button>
          </div>
        ) : method === "totp" ? (
          <div>
            <OneTimeCodeInput id={`${formId}-code`} label="Code from your authenticator app" value={code}
              onChange={setCode} disabled={busy} autoFocus
              onComplete={autoSubmit ? (typed) => { if (canConfirm) void submit(typed); } : undefined}
              hint={tier === "grant"
                ? "Each code works once. A correct code also confirms your next commands for five minutes."
                : "Each code works once."} />
          </div>
        ) : method === "password" ? (
          <Field label="Your password" help="Two-factor is off, so Halt accepts your password. Every other Bot command needs two-factor.">
            <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password" className="w-64" />
          </Field>
        ) : (
          <Notice tone="warn">
            Turn on two-factor sign-in in your <Link href="/profile" className="underline">profile</Link> to
            operate the Bot from Trading Scene.
          </Notice>
        )}
        {error && <Notice tone="error" role="alert">{error}</Notice>}
      </form>
    </Modal>
  );
}
