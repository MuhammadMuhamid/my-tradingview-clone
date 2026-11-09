"use client";
/**
 * The profile's security cards: email verification, two-factor sign-in and
 * recent sign-ins.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button, Card, CardHeader, Empty, Loading, TextInput } from "@/components/ui";
import { OneTimeCodeInput } from "@/components/OneTimeCodeInput";
import { ApiError } from "@/lib/api";
import { failureReason } from "@/lib/errorCopy";
import { fmtDateTime } from "@/lib/format";
import { refreshSession, type SessionUser } from "@/lib/session";

export async function sendAccountRequest<T = { error?: string }>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status})`);
  return json;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="p-4">{children}</div>
    </Card>
  );
}

function Message({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <p role={ok ? "status" : "alert"} className={`mt-3 text-[13px] ${ok ? "text-up" : "text-down"}`}>{children}</p>;
}

const errorText = (e: unknown) => failureReason(e);

export function EmailVerificationCard({ user, emailConfigured }: { user: SessionUser; emailConfigured: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (user.emailVerified) {
    return <Section title="Email"><p className="text-[13px] text-ink-muted">{user.email} is verified.</p></Section>;
  }
  const resend = async (): Promise<void> => {
    setBusy(true); setMsg(null);
    try {
      await sendAccountRequest("/api/auth/email/resend", "POST");
      setMsg({ ok: true, text: `We sent a link to ${user.email}. It expires in 24 hours.` });
    } catch (e) { setMsg({ ok: false, text: errorText(e) }); }
    setBusy(false);
  };
  return (
    <Section title="Email">
      <p className="text-[13px] text-ink-muted">
        {user.email} isn&apos;t verified yet. You&apos;ll need this, and two-factor sign-in, to join a package.
      </p>
      {emailConfigured
        ? <div className="mt-4"><Button disabled={busy} onClick={() => void resend()}>{busy ? "Sending…" : "Send verification email"}</Button></div>
        : <p className="mt-2 text-[12px] text-ink-faint">Email isn&apos;t set up on this server yet.</p>}
      {msg && <Message ok={msg.ok}>{msg.text}</Message>}
    </Section>
  );
}

/** "ABCD EFGH IJKL …": the setup key in groups of four, as authenticator apps print it. */
export function groupSetupKey(secret: string): string {
  return (secret.replace(/\s/g, "").match(/.{1,4}/g) ?? []).join(" ");
}

/** Copies to the clipboard and says so; says so too when the browser refuses. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <Button onClick={() => void copy()}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select it instead" : label}
    </Button>
  );
}

/**
 * The recovery codes as a text file, made in this browser and handed straight
 * to the download (OD-2). Nothing is sent anywhere; the object URL is revoked
 * as soon as the download has started.
 */
export function recoveryCodesFile(codes: string[], now = new Date()): string {
  return ["Trading Scene recovery codes", `Saved ${now.toISOString().slice(0, 10)}. Each code works once.`, "",
    ...codes, ""].join("\n");
}

function downloadRecoveryCodes(codes: string[]): void {
  const url = URL.createObjectURL(new Blob([recoveryCodesFile(codes)], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "trading-scene-recovery-codes.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <>
      <p className="text-[13px] text-ink">
        Save these recovery codes somewhere safe. Each one works once if you lose your phone, and they won&apos;t be shown again.
      </p>
      <ul aria-label="Recovery codes" className="mt-3 grid max-w-sm grid-cols-2 gap-x-6 gap-y-1 font-mono text-[13px] text-ink">
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <CopyButton text={codes.join("\n")} label="Copy codes" />
        <Button onClick={() => downloadRecoveryCodes(codes)}>Download .txt</Button>
        <Button variant="primary" onClick={onDone}>I&apos;ve saved them</Button>
      </div>
    </>
  );
}

export function TwoFactorCard({ user }: { user: SessionUser }) {
  const needsPassword = user.hasPassword;
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"idle" | "disable" | "regenerate">("idle");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const readStatus = async (): Promise<void> => {
    const status = await sendAccountRequest<{ recoveryCodesLeft: number }>("/api/auth/2fa/status", "GET");
    setLeft(status.recoveryCodesLeft);
  };
  useEffect(() => { if (user.twoFactorEnabled) void readStatus().catch(() => setLeft(null)); }, [user.twoFactorEnabled]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setErr(null);
    try {
      await action();
      setPassword(""); setCode("");
    } catch (e) { setErr(errorText(e)); }
    setBusy(false);
  };

  const start = () => run(async () => {
    const result = await sendAccountRequest<{ secret: string; qrDataUrl: string; otpauthUrl: string }>(
      "/api/auth/2fa/setup", "POST", { password });
    setSetup(result);
  });
  // `typed`: the code as the sixth digit completed it, before React has re-rendered.
  const enable = (typed = code) => run(async () => {
    const result = await sendAccountRequest<{ recoveryCodes: string[] }>("/api/auth/2fa/enable", "POST", { code: typed });
    setCodes(result.recoveryCodes);
    setSetup(null);
  });
  const disable = (typed = code) => run(async () => {
    await sendAccountRequest("/api/auth/2fa/disable", "POST", { password, code: typed.trim() });
    setMode("idle");
    await refreshSession();
  });
  const regenerate = (typed = code) => run(async () => {
    const result = await sendAccountRequest<{ recoveryCodes: string[] }>("/api/auth/2fa/recovery-codes", "POST", { code: typed });
    setCodes(result.recoveryCodes);
    setMode("idle");
  });
  const finishCodes = (): void => {
    setCodes(null);
    void refreshSession();
    void readStatus().catch(() => setLeft(null));
  };

  const passwordField = needsPassword && (
    <>
      <label className="block text-[13px] text-ink-muted" htmlFor="tf-password">Password</label>
      <TextInput id="tf-password" type="password" autoComplete="current-password" value={password}
        onChange={(e) => setPassword(e.target.value)} className="mb-3 mt-1.5 block w-full max-w-sm" />
    </>
  );
  /** The shared six-digit field; the sixth digit does what the button beside it would. */
  const codeField = (onComplete: (typed: string) => void) => (
    <OneTimeCodeInput id="tf-code" label="6-digit code from your app" value={code} onChange={setCode}
      disabled={busy} onComplete={(typed) => { if (!busy) onComplete(typed); }} />
  );

  let body: ReactNode;
  if (codes) {
    body = <RecoveryCodes codes={codes} onDone={finishCodes} />;
  } else if (setup) {
    body = (
      <>
        <p className="text-[13px] text-ink-muted">
          Use Apple Passwords (iCloud Keychain): scan this QR code with your iPhone camera or Passwords app, or paste
          the setup key into Passwords on your Mac. Codes can then autofill in supported browsers. Google
          Authenticator, Microsoft Authenticator, 1Password and any RFC 6238 app also work.
        </p>
        <img src={setup.qrDataUrl} alt="QR code for your authenticator app" width={180} height={180} className="my-3 rounded bg-white" />
        <div className="mb-3 space-y-2">
          {/* On the phone itself, one tap hands the account to Passwords or the authenticator app. */}
          <a href={setup.otpauthUrl} className="inline-flex min-h-9 items-center rounded-md border border-control-border px-3 text-[13px] text-ink hover:bg-state-hover">
            Open in Passwords / authenticator app
          </a>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-faint">
            <span>Setup key:</span>
            <span data-testid="tf-setup-key" className="break-all font-mono text-[13px] text-ink">{groupSetupKey(setup.secret)}</span>
            <CopyButton text={setup.secret} label="Copy key" />
          </div>
          <p className="text-[12px] text-ink-faint">
            If your password and codes are both in Apple Passwords, sign-in is more convenient but the two factors are
            less separated than an authenticator on a different device.
          </p>
        </div>
        {codeField((typed) => void enable(typed))}
        <div className="mt-4 flex gap-2">
          <Button variant="primary" disabled={busy || code.length !== 6} onClick={() => void enable()}>Turn on</Button>
          <Button variant="ghost" onClick={() => { setSetup(null); setCode(""); setErr(null); }}>Cancel</Button>
        </div>
      </>
    );
  } else if (user.twoFactorEnabled) {
    body = (
      <>
        <p className="text-[13px] text-ink-muted">
          On. You&apos;ll enter a code from your app each time you sign in.
          {left !== null && ` ${left} recovery code${left === 1 ? "" : "s"} left.`}
        </p>
        {mode === "idle" && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => { setMode("regenerate"); setErr(null); }}>New recovery codes</Button>
            <Button variant="danger" onClick={() => { setMode("disable"); setErr(null); }}>Turn off</Button>
          </div>
        )}
        {mode !== "idle" && (
          <div className="mt-4">
            {mode === "disable" && passwordField}
            {codeField((typed) => {
              if (mode === "regenerate") void regenerate(typed);
              else if (!needsPassword || password) void disable(typed);
            })}
            <div className="mt-4 flex gap-2">
              {mode === "disable"
                ? <Button variant="danger" disabled={busy || code.length !== 6 || (needsPassword && !password)} onClick={() => void disable()}>Turn off two-factor</Button>
                : <Button variant="primary" disabled={busy || code.length !== 6} onClick={() => void regenerate()}>Replace my recovery codes</Button>}
              <Button variant="ghost" onClick={() => { setMode("idle"); setCode(""); setPassword(""); setErr(null); }}>Cancel</Button>
            </div>
          </div>
        )}
      </>
    );
  } else if (!user.emailVerified) {
    body = <p className="text-[13px] text-ink-muted">Verify your email address first, then you can turn this on.</p>;
  } else {
    body = (
      <>
        <p className="mb-3 text-[13px] text-ink-muted">
          Adds a code from an authenticator app to every sign-in. You&apos;ll need this to join a package.
        </p>
        {passwordField}
        <Button variant="primary" disabled={busy || (needsPassword && !password)} onClick={() => void start()}>
          {busy ? "Starting…" : "Set up two-factor sign-in"}
        </Button>
      </>
    );
  }
  return <Section title="Two-factor sign-in">{body}{err && <Message ok={false}>{err}</Message>}</Section>;
}

interface LoginEvent { method: string; twoFactor: boolean; ip: string | null; userAgent: string | null; at: string }

const METHOD_LABEL: Record<string, string> = { password: "Password", google: "Google", github: "GitHub" };

export function LoginHistoryCard() {
  const [logins, setLogins] = useState<LoginEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    sendAccountRequest<{ logins: LoginEvent[] }>("/api/auth/login-history", "GET")
      .then((result) => setLogins(result.logins))
      .catch((e: unknown) => setErr(errorText(e)));
  }, []);
  return (
    <Section title="Recent sign-ins">
      {err && <Message ok={false}>The sign-in history couldn&apos;t be read. {err}</Message>}
      {!err && !logins && <Loading>Reading sign-ins…</Loading>}
      {logins?.length === 0 && <Empty>No sign-ins recorded yet.</Empty>}
      {logins && logins.length > 0 && (
        <>
          <p className="mb-2 text-[12px] text-ink-faint">Don&apos;t recognise one? Change your password and sign out everywhere.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px] tabular">
              <thead>
                <tr className="border-b border-border text-left text-xs text-ink-muted">
                  <th className="py-1.5 pr-3">When</th><th className="py-1.5 pr-3">How</th>
                  <th className="py-1.5 pr-3">Address</th><th className="py-1.5">Device</th>
                </tr>
              </thead>
              <tbody>
                {logins.map((login) => (
                  <tr key={`${login.at}-${login.method}`} className="border-b border-border last:border-b-0">
                    <td className="py-1.5 pr-3 text-ink">{fmtDateTime(login.at)}</td>
                    <td className="py-1.5 pr-3 text-ink-muted">
                      {METHOD_LABEL[login.method] ?? login.method}{login.twoFactor ? " + code" : ""}
                    </td>
                    <td className="py-1.5 pr-3 text-ink-muted">{login.ip ?? "—"}</td>
                    <td className="max-w-[280px] truncate py-1.5 text-ink-muted" title={login.userAgent ?? undefined}>{login.userAgent ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}
