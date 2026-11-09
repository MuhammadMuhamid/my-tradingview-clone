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
 * The credential lives in this component's state while it is open and is
 * cleared when it closes. It is sent once, with the command, and never kept.
 */
import Link from "next/link";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Modal } from "@/components/Modal";
import { Button, Field, Notice, TextInput } from "@/components/ui";
import { useSession } from "@/lib/session";
import type { BotCredential } from "@/lib/api";
import type { DialogResult } from "./commandRunner";

export function StepUpDialog({ open, title, intro, children, confirmLabel, danger = false, allowsPassword = false,
  canConfirm = true, onCancel, onConfirm }: {
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
}) {
  const session = useSession();
  const user = session?.user ?? null;
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverMethod, setServerMethod] = useState<"totp" | "password" | null>(null);
  const formId = useId();

  useEffect(() => {
    if (open) return;
    setCode(""); setPassword(""); setError(""); setBusy(false); setServerMethod(null);
  }, [open]);

  const authOff = session !== null && !session.authEnabled;
  const method: "totp" | "password" | null = serverMethod
    ?? (user?.twoFactorEnabled ? "totp" : allowsPassword && user?.hasPassword ? "password" : null);
  const supplied = method === "totp" ? code.trim().length > 0 : method === "password" ? password.length > 0 : false;
  const ready = !authOff && method !== null && supplied && canConfirm && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const result = await onConfirm(method === "totp" ? { code: code.replace(/\s/g, "") } : { password });
      // Sent (or refused for good): the outcome is reported on the page, not here.
      if (result.close) { onCancel(); return; }
      setError(result.error);
      if (result.method) setServerMethod(result.method);
      // A code works once: a refused one is cleared so the next attempt is a fresh one.
      setCode("");
    } finally {
      // Whatever happened, the dialog never stays stuck on "Sending…".
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onCancel} title={title}
      footer={<>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        {method !== null && !authOff && (
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
        ) : method === "totp" ? (
          <Field label="Code from your authenticator app" help="Each code works once.">
            <TextInput value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric"
              autoComplete="one-time-code" maxLength={10} className="w-40 tabular" />
          </Field>
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
