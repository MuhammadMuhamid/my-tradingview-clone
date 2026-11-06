"use client";
/**
 * Where an emailed verification link lands. It works without being signed in,
 * and only a POST from here uses the token, so a mail scanner opening the link
 * can't use it up.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthShell, PRIMARY_BUTTON } from "@/components/AuthShell";
import { refreshSession, useSession } from "@/lib/session";

function VerifyEmail() {
  const token = useSearchParams().get("token");
  const session = useSession();
  const [state, setState] = useState<"working" | "done" | "failed">(token ? "working" : "failed");
  const [message, setMessage] = useState(token ? "" : "This link isn't valid. Ask for a new one from your profile.");
  // The token works once, and React may run an effect twice in development.
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    // Out of the address bar and browser history before anything else loads.
    window.history.replaceState(null, "", "/verify-email");
    void (async () => {
      try {
        const res = await fetch("/api/auth/email/verify", {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? "This link couldn't be used.");
        setState("done");
        await refreshSession();
      } catch (error) {
        setState("failed");
        setMessage((error as Error).message);
      }
    })();
  }, [token]);

  const signedIn = !!session?.user;
  return (
    <AuthShell>
      <h1 className="text-center text-[22px] font-semibold text-ink">
        {state === "working" ? "Verifying your email…" : state === "done" ? "Email verified" : "That link didn't work"}
      </h1>
      {state === "done" && <p role="status" className="mt-1.5 text-center text-[13px] text-ink-muted">Thanks. Your email address is confirmed.</p>}
      {state === "failed" && <p role="alert" className="mt-3 rounded-md bg-down/10 px-3 py-2 text-[13px] text-down">{message}</p>}
      {state !== "working" && (
        <Link href={signedIn ? "/profile" : "/login"} className={`mt-6 ${PRIMARY_BUTTON}`}>
          {signedIn ? "Go to your profile" : "Sign in"}
        </Link>
      )}
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return <Suspense fallback={null}><VerifyEmail /></Suspense>;
}
