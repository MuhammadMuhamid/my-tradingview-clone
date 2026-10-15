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
  AUTH_FIELD, AuthShell, GoogleMark, PRIMARY_BUTTON, SECONDARY_BUTTON,
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
  signups_closed: "New accounts are not being accepted right now.",
  signin_required: "Sign in first.",
};

function LoginForm() {
  const params = useSearchParams();
  const next = safeNextPath(params.get("next"));
  const session = useSession();
  const [mode, setMode] = useState<"signin" | "signup">(
    params.get("mode") === "signup" ? "signup" : "signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(ERRORS[params.get("error") ?? ""] ?? null);

  const google = session?.providers.google ?? false;
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
        error?: string; user?: { onboarded?: boolean };
      };
      if (!res.ok) throw new Error(body.error ?? (signup ? "Could not create the account" : "Sign-in failed"));
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

      {google && (
        <>
          <a href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}
            className={`mt-6 ${SECONDARY_BUTTON}`}>
            <GoogleMark />
            <span>{signup ? "Sign up with Google" : "Continue with Google"}</span>
          </a>
          <div className="my-5 flex items-center gap-3 text-[12px] uppercase tracking-wide text-ink-faint">
            <span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" />
          </div>
        </>
      )}

      <form onSubmit={submit} className={google ? "" : "mt-6"} noValidate>
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
          autoFocus={!google} value={email} onChange={(e) => setEmail(e.target.value)}
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
