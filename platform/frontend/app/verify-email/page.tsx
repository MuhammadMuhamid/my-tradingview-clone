"use client";
/**
 * Where an emailed verification link lands. It works without being signed in.
 *
 * Opening the page uses nothing: the token is sent only when the person presses
 * the button. Mail scanners and link previewers open links, and some run the
 * page's script, so a page that verified on load would let one of them verify
 * an account for someone else — whoever signed up with this address. The copy
 * says so: only confirm an account you created.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthShell, PRIMARY_BUTTON } from "@/components/AuthShell";
import { refreshSession, useSession } from "@/lib/session";

function VerifyEmail() {
  const params = useSearchParams();
  // Read once: the address bar loses it below, and the button needs it after.
  const [token] = useState(() => params.get("token"));
  const session = useSession();
  const [state, setState] = useState<"confirm" | "working" | "done" | "failed">(token ? "confirm" : "failed");
  const [message, setMessage] = useState(token ? "" : "This link isn't valid. Ask for a new one from your profile.");
  // The token works once.
  const sent = useRef(false);

  useEffect(() => {
    // Out of the address bar and browser history before anything else loads.
    if (token) window.history.replaceState(null, "", "/verify-email");
  }, [token]);

  const confirmEmail = async (): Promise<void> => {
    if (!token || sent.current) return;
    sent.current = true;
    setState("working");
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
  };

  const signedIn = !!session?.user;
  return (
    <AuthShell>
      <h1 className="text-center text-[22px] font-semibold text-ink">
        {state === "confirm" ? "Confirm your email address"
          : state === "working" ? "Verifying your email…"
            : state === "done" ? "Email verified" : "That link didn't work"}
      </h1>
      {state === "confirm" && (
        <>
          <p className="mt-1.5 text-center text-[13px] text-ink-muted">
            Only confirm if you created this Trading Scene account yourself. If you didn&apos;t sign up, close this
            page: the account stays unverified.
          </p>
          <button type="button" onClick={() => void confirmEmail()} className={`mt-6 ${PRIMARY_BUTTON}`}>
            Confirm my email address
          </button>
        </>
      )}
      {state === "done" && <p role="status" className="mt-1.5 text-center text-[13px] text-ink-muted">Thanks. Your email address is confirmed.</p>}
      {state === "failed" && <p role="alert" className="mt-3 rounded-md bg-down/10 px-3 py-2 text-[13px] text-down">{message}</p>}
      {(state === "done" || state === "failed") && (
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
