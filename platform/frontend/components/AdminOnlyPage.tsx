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
 * Three states, from `useSessionRole`: only an account KNOWN to be ordinary is
 * turned away; an unreadable session or an instance without authentication
 * renders the page as before (the backend is what enforces reach). While the
 * one shared session read is still in flight ("unknown") the page is neither
 * mounted nor refused — it says it is checking. Its admin-only reads would
 * wait on that same read anyway (`lib/api.ts` `refusedForThisAccount`), so
 * holding the mount costs no time.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Button, Loading, Notice, PageHeader, PageShell } from "@/components/ui";
import { useSessionRole } from "@/lib/session";

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
