"use client";
/**
 * Sign in, and create an account — one screen, as TradingView has it.
 *
 * Google first when the instance offers it, then email. `?mode=signup` (and
 * `/signup`) opens on account creation. The admin's original username still
 * works in the email field.
 */
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { safeNextPath } from "@/lib/safeRedirect";
import { useSession } from "@/lib/session";
import {
  AUTH_FIELD, AuthShell, GithubMark, GoogleMark, PRIMARY_BUTTON, SECONDARY_BUTTON,
} from "@/components/AuthShell";

/** What a failed Google round trip says, by the code the backend sends back. */
const ERRORS: Record<string, string> = {
  google_cancelled: "Google sign-in was cancelled.",
  google_expired: "That sign-in took too long or was opened in another browser. Try again.",
  google_failed: "Google could not confirm who you are. Try again.",
  google_unavailable: "Google is not reachable right now. Try again in a moment.",
  google_disabled: "Google sign-in is not available here.",
  google_in_use: "That Google account is already linked to another account.",
  google_link_admin: "Sign in with the administrator's username and password, then link Google from your profile.",
  google_link_unverified: "Your email isn't verified, and that Google account uses a different address. Verify your email first, or link a Google account that uses the same address as your account.",
  github_cancelled: "GitHub sign-in was cancelled.",
  github_expired: "That sign-in took too long or was opened in another browser. Try again.",
  github_failed: "GitHub could not confirm who you are. Your GitHub account needs a verified primary email.",
  github_unavailable: "GitHub is not reachable right now. Try again in a moment.",
  github_disabled: "GitHub sign-in is not available here.",
  github_in_use: "That GitHub account is already linked to another account.",
  github_link_admin: "Sign in with the administrator's username and password, then link GitHub from your profile.",
  github_link_unverified: "Your email isn't verified, and that GitHub account uses a different address. Verify your email first, or link a GitHub account that uses the same address as your account.",
  signups_closed: "New accounts are not being accepted right now.",
  signin_required: "Sign in first.",
};

/** The second step of a sign-in, after the password or a provider has passed. */
function TwoFactorStep({ next }: { next: string }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/2fa/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(useRecovery ? { recoveryCode: value } : { code: value }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; user?: { onboarded?: boolean } };
      if (!res.ok) throw new Error(body.error ?? "Sign-in failed");
      window.location.href = body.user?.onboarded === false ? `/onboarding?next=${encodeURIComponent(next)}` : next;
    } catch (error) {
      setErr((error as Error).message);
      setValue("");
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="text-center text-[22px] font-semibold text-ink">Two-factor sign-in</h1>
      <p className="mt-1.5 text-center text-[13px] text-ink-muted">
        {useRecovery ? "Enter one of your recovery codes. Each works once." : "Enter the 6-digit code from your authenticator app."}
      </p>
      <form onSubmit={submit} className="mt-6" noValidate>
        <label className="block text-[13px] text-ink-muted" htmlFor="second-factor">
          {useRecovery ? "Recovery code" : "Code"}
        </label>
        <input id="second-factor" autoFocus autoComplete="one-time-code" value={value}
          inputMode={useRecovery ? "text" : "numeric"} onChange={(e) => setValue(e.target.value)}
          className={`mt-1.5 ${AUTH_FIELD}`} />
        {err && <p role="alert" className="mt-4 rounded-md bg-down/10 px-3 py-2 text-[13px] text-down">{err}</p>}
        <button type="submit" disabled={busy || !value.trim()} className={`mt-5 ${PRIMARY_BUTTON}`}>
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>
      <p className="mt-6 text-center text-[13px] text-ink-muted">
        <button type="button" onClick={() => { setUseRecovery(!useRecovery); setValue(""); setErr(null); }}
          className="font-medium text-accent hover:underline">
          {useRecovery ? "Use a code from my app" : "Use a recovery code"}
        </button>
      </p>
    </AuthShell>
  );
}

function LoginForm() {
  const params = useSearchParams();
  const next = safeNextPath(params.get("next"));
  const session = useSession();
  const [twoFactor, setTwoFactor] = useState(params.get("step") === "2fa");
  const [mode, setMode] = useState<"signin" | "signup">(
    params.get("mode") === "signup" ? "signup" : "signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(ERRORS[params.get("error") ?? ""] ?? null);

  const google = session?.providers.google ?? false;
  const github = session?.providers.github ?? false;
  const signupsOpen = session?.providers.signups ?? true;
  const signup = mode === "signup";

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(signup ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The response's Set-Cookie is the whole point of this request.
        credentials: "same-origin",
        body: JSON.stringify(signup
          ? { email, password, displayName: name }
          : { email, password }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string; user?: { onboarded?: boolean }; twoFactorRequired?: boolean;
      };
      if (!res.ok) throw new Error(body.error ?? (signup ? "Could not create the account" : "Sign-in failed"));
      if (body.twoFactorRequired) {
        setPassword("");
        setBusy(false);
        setTwoFactor(true);
        return;
      }
      // Full navigation, so the proxy re-runs with the new cookie.
      window.location.href = body.user && body.user.onboarded === false
        ? `/onboarding?next=${encodeURIComponent(next)}` : next;
    } catch (error) {
      setErr((error as Error).message);
      setBusy(false);
    }
  };

  const switchMode = (to: "signin" | "signup"): void => {
    setMode(to);
    setErr(null);
  };

  if (twoFactor) return <TwoFactorStep next={next} />;

  return (
    <AuthShell>
      <h1 className="text-center text-[22px] font-semibold text-ink">
        {signup ? "Create your account" : "Sign in"}
      </h1>
      <p className="mt-1.5 text-center text-[13px] text-ink-muted">
        {signup
          ? "Your charts, watchlists and alerts — on every device."
          : "Welcome back. You stay signed in on this device for 90 days."}
      </p>

      {(google || github) && (
        <>
          {google && (
            <a href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}
              className={`mt-6 ${SECONDARY_BUTTON}`}>
              <GoogleMark />
              <span>{signup ? "Sign up with Google" : "Continue with Google"}</span>
            </a>
          )}
          {github && (
            <a href={`/api/auth/github/start?next=${encodeURIComponent(next)}`}
              className={`${google ? "mt-2.5" : "mt-6"} ${SECONDARY_BUTTON}`}>
              <GithubMark />
              <span>{signup ? "Sign up with GitHub" : "Continue with GitHub"}</span>
            </a>
          )}
          <div className="my-5 flex items-center gap-3 text-[12px] uppercase tracking-wide text-ink-faint">
            <span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" />
          </div>
        </>
      )}

      <form onSubmit={submit} className={google || github ? "" : "mt-6"} noValidate>
        {signup && (
          <>
            <label className="block text-[13px] text-ink-muted" htmlFor="name">Name</label>
            <input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="How you appear on your profile" className={`mt-1.5 ${AUTH_FIELD}`} maxLength={80} />
            <div className="h-4" />
          </>
        )}
        <label className="block text-[13px] text-ink-muted" htmlFor="email">
          {signup ? "Email" : "Email or username"}
        </label>
        <input id="email" name="email" type={signup ? "email" : "text"} autoComplete={signup ? "email" : "username"}
          autoFocus={!google && !github} value={email} onChange={(e) => setEmail(e.target.value)}
          className={`mt-1.5 ${AUTH_FIELD}`} />

        <label className="mt-4 block text-[13px] text-ink-muted" htmlFor="password">Password</label>
        <input id="password" name="password" type="password"
          autoComplete={signup ? "new-password" : "current-password"}
          value={password} onChange={(e) => setPassword(e.target.value)}
          className={`mt-1.5 ${AUTH_FIELD}`} />
        {signup && <p className="mt-1.5 text-[12px] text-ink-faint">At least 8 characters.</p>}

        {err && <p role="alert" className="mt-4 rounded-md bg-down/10 px-3 py-2 text-[13px] text-down">{err}</p>}

        <button type="submit"
          disabled={busy || !email || !password || (signup && password.length < 8)}
          className={`mt-5 ${PRIMARY_BUTTON}`}>
          {busy ? (signup ? "Creating account…" : "Signing in…") : (signup ? "Create account" : "Sign in")}
        </button>
      </form>

      {(signupsOpen || signup) && (
        <p className="mt-6 text-center text-[13px] text-ink-muted">
          {signup ? "Already have an account? " : "New here? "}
          {/* accent-is-meaning: a link to the other form, not a selection. */}
          <button type="button" onClick={() => switchMode(signup ? "signin" : "signup")}
            className="font-medium text-accent hover:underline">
            {signup ? "Sign in" : "Create an account"}
          </button>
        </p>
      )}
    </AuthShell>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary during static prerendering.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
