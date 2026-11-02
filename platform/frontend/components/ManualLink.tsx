"use client";
/**
 * A link in the Manual, as this account can follow it.
 *
 * The Manual is a static server component and describes the whole product,
 * the administrator's pages included. For a Standard account eighteen of its
 * links led straight to "This page is for the administrator", while the menu
 * beside it correctly hid those routes — the Manual contradicted the nav. A
 * link to an administrator-only destination is therefore plain text for anyone
 * not known to be the administrator (an ordinary account, a session still
 * being read, or one that could not be read), marked so the reader knows why,
 * and the sentence around it is unchanged.
 *
 * The only client code the Manual has. It reads the one shared session and
 * nothing else; the page stays static.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { isAdminOnlyPath } from "@/lib/navigation";
import { useIsAdmin } from "@/lib/session";

export const ADMINISTRATOR_MARK = "(administrator)";

export function ManualLink({ href, children }: { href: string; children: ReactNode }) {
  const admin = useIsAdmin();
  if (!admin && isAdminOnlyPath(href)) {
    return (
      <span data-admin-only-link={href}>
        {children} <span className="text-ink-faint">{ADMINISTRATOR_MARK}</span>
      </span>
    );
  }
  return (
    <Link href={href} className="text-accent underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}
