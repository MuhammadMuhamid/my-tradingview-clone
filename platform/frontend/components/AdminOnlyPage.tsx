"use client";
/**
 * A page that acts on the platform owner's exchange account, bots or research
 * jobs, opened by an account that is not the owner's.
 *
 * The navigation hides these pages from an ordinary account, but a typed or
 * bookmarked URL still reached them, and each one then drew its whole form and
 * reported "Could not load …" with the real reason only on hover. That is the
 * contract's §1.3 failure exactly: an entitlement limit hidden behind controls
 * that appear to work. This says the limit in the page copy instead, and does
 * not mount the page, so none of its reads or effects run.
 *
 * Four states, from `useSessionRole`: the administrator (or an instance
 * without authentication) gets the page; an account KNOWN to be ordinary is
 * turned away. While the one shared session read is still in flight
 * ("unknown") the page is neither mounted nor refused — it says it is
 * checking. Its admin-only reads would wait on that same read anyway
 * (`lib/api.ts` `refusedForThisAccount`), so holding the mount costs no time.
 *
 * A read that could not be checked ("unreadable") is neither of the first two.
 * It used to mount the page as the administrator's, so an ordinary account
 * whose `/api/auth/me` failed was shown the owner's whole form. It says what
 * happened instead and offers the two ways forward: Retry (the read again) or,
 * when the server answered that nobody is signed in, Sign in.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Button, Loading, Notice, PageHeader, PageShell } from "@/components/ui";
import { refreshSession, useSession, useSessionRole } from "@/lib/session";

export const SESSION_UNREADABLE_NOTICE =
  "Your account could not be checked — the server did not answer. Nothing on this page is "
  + "offered until it can be.";

export const SESSION_SIGNED_OUT_NOTICE =
  "You are not signed in, or your session has ended. Sign in again to use this page.";

export const ADMIN_ONLY_PAGE_NOTICE =
  "This page is for the administrator. It acts on the platform owner's exchange account, bots or "
  + "research jobs. Your account can use the chart, Screener, alerts, watchlists, layouts, Pine "
  + "scripts and the Shariah screen.";

export function AdminOnlyPage({ title, width, children }: {
  /** The page's own title, so the reader still knows where the URL led. */
  title: string;
  width?: "wide" | "narrow";
  children: ReactNode;
}) {
  const session = useSession();
  const role = useSessionRole();

  if (role === "unknown") {
    return (
      <PageShell width={width}>
        <PageHeader title={title} />
        <Loading>Checking your account…</Loading>
      </PageShell>
    );
  }
  if (role === "admin") return <>{children}</>;

  if (role === "unreadable") {
    // The server answered "nobody is signed in": the way forward is sign-in,
    // not a retry of a read that will say the same thing.
    const signedOut = session !== null && !session.readFailed;
    return (
      <PageShell width={width}>
        <PageHeader title={title} />
        <Notice tone="warn" role="alert">
          {signedOut ? SESSION_SIGNED_OUT_NOTICE : SESSION_UNREADABLE_NOTICE}
        </Notice>
        <div className="flex flex-wrap gap-2">
          {signedOut ? (
            <Link href={`/login?next=${encodeURIComponent(typeof window === "undefined" ? "/" : window.location.pathname)}`}><Button variant="primary">Sign in</Button></Link>
          ) : (
            <Button variant="primary" onClick={() => void refreshSession()}>Retry</Button>
          )}
          <Link href="/chart"><Button>Open the chart</Button></Link>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell width={width}>
      <PageHeader title={title} />
      <Notice tone="info" role="status">{ADMIN_ONLY_PAGE_NOTICE}</Notice>
      <div>
        <Link href="/chart"><Button variant="primary">Open the chart</Button></Link>
      </div>
    </PageShell>
  );
}
