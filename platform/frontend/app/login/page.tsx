"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { safeNextPath } from "@/lib/safeRedirect";
import { Suspense } from "react";

function LoginForm() {
  const params = useSearchParams();
  // Never assign an unvalidated `next` to window.location: it is an open
  // redirect and a `javascript:` sink on the origin holding the session cookie.
  const next = safeNextPath(params.get("next"));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The response's Set-Cookie is the whole point of this request.
        credentials: "same-origin",
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Sign-in failed");
      }
      // Full navigation, so the middleware re-runs with the new cookie.
      window.location.href = next;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const box = "w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent";

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-2xl">
        <h1 className="text-lg font-semibold text-ink">Sign in</h1>
        <p className="mt-1 text-xs text-ink-faint">
          You stay signed in on this device for 90 days.
        </p>

        <label className="mt-5 block text-xs text-ink-muted" htmlFor="username">Username</label>
        <input id="username" name="username" autoComplete="username" autoFocus
          value={username} onChange={(e) => setUsername(e.target.value)}
          className={`mt-1 ${box}`} />

        <label className="mt-3 block text-xs text-ink-muted" htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)}
          className={`mt-1 ${box}`} />

        {err && <p role="alert" className="mt-3 text-sm text-down">{err}</p>}

        <button type="submit" disabled={busy || !username || !password}
          className="mt-5 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-40">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
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
