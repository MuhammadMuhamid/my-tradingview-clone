"use client";
/**
 * The chart's row 2, for every other page: a rail of destinations on the left
 * and the page in one black panel, on the grey ground, 4px apart — the same
 * geometry as the chart's left rail and chart column (see `Nav` for row 1).
 *
 * The chart, and the account screens, draw their own frame and get a plain
 * `main`.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { linksFor, primaryFor, PRIMARY_LINKS, SYSTEM_LINKS } from "@/lib/navigation";
import { useIsAdmin } from "@/lib/session";
import { GLYPHS } from "@/components/tv/ProductMenu";
import { BARE_ROUTES } from "@/components/Nav";

/** The rail's destinations: the five, then the operator and reference pages. */
const RAIL = [...PRIMARY_LINKS, ...SYSTEM_LINKS.filter((l) => l.href !== "/getting-started")];

export function PageFrame({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "";
  const admin = useIsAdmin();
  const main = (className: string) => (
    <main id="main" tabIndex={-1} className={className}>{children}</main>
  );
  if (BARE_ROUTES.has(path)) {
    return main("flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden outline-none");
  }

  const current = primaryFor(path)?.href ?? path;
  return (
    <div className="ts-app flex min-h-0 flex-1 gap-1 bg-bg pt-1">
      <nav aria-label="Destinations"
        className="hidden w-[52px] shrink-0 flex-col items-center gap-0.5 bg-surface py-1 md:flex">
        {linksFor(RAIL, admin).map((l) => {
          const active = current === l.href || path === l.href || path.startsWith(`${l.href}/`);
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-label={l.label}
              title={l.label}
              aria-current={active ? "page" : undefined}
              aria-pressed={active}
              className="tvc-control flex h-[46px] w-[45px] items-center justify-center text-ink"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {GLYPHS[l.href] ?? GLYPHS.fallback}
              </svg>
            </Link>
          );
        })}
      </nav>
      {main("min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-surface outline-none")}
    </div>
  );
}
