"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStreamSummary } from "@/lib/navStatus";
import { allNavLinks, primaryFor, sectionTabsFor } from "@/lib/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProductMenu } from "@/components/tv/ProductMenu";

/**
 * The top bar of every page that is not the chart: the chart's own row 1.
 *
 * ── Why the pages wear the chart's frame ───────────────────────────────────
 *
 * The chart is a workstation — a 38px toolbar spanning the window with the
 * account cell at its left, rails below it, and black panels separated by the
 * grey ground. Every other page used to be a WEBSITE: a separate header with
 * a wordmark and a row of text links, a "New here?" banner, and the content on
 * the grey ground itself. Moving from the chart to Alerts felt like leaving
 * the product. TradingView keeps one frame across its workspace, so this does
 * too: the same account cell and avatar menu (`ProductMenu`, rail variant),
 * the same 38px band, the same control grammar, and the page's own sections
 * as toolbar buttons where the chart has its symbol and interval.
 *
 * The left rail of destinations and the page panel are `PageFrame`'s.
 */

/** The in-product manual, reachable from the bar on every page. */
const HELP_HREF = "/getting-started";

/** Routes that draw their own full frame, or none. */
export const BARE_ROUTES = new Set(["/chart", "/login", "/signup", "/onboarding", "/profile"]);

export function Nav() {
  const path = usePathname() ?? "";
  if (BARE_ROUTES.has(path)) return null;

  const primary = primaryFor(path);
  const tabs = sectionTabsFor(path);
  const title = primary?.label
    ?? allNavLinks().find((l) => path === l.href || path.startsWith(`${l.href}/`))?.label
    ?? "";

  return (
    <header className="ts-app relative flex min-h-[38px] shrink-0 items-stretch bg-surface">
      {/* The account cell: 52×38, the avatar and the whole product menu. */}
      <ProductMenu variant="rail" />
      <span aria-hidden="true" className="my-2 w-px shrink-0 bg-[var(--ts-rail-separator)]" />
      <nav aria-label="This page" className="no-scrollbar flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1.5">
        {title && (
          <span className="flex shrink-0 items-center px-2 text-[15px] font-semibold text-ink">{title}</span>
        )}
        {tabs && tabs.length > 1 && (
          <>
            <span aria-hidden="true" className="my-2 w-px shrink-0 bg-[var(--ts-rail-separator)]" />
            {tabs.map((t) => {
              const active = path === t.href || path.startsWith(`${t.href}/`);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  aria-pressed={active}
                  className="tvc-control my-1 flex shrink-0 items-center whitespace-nowrap px-3 text-[14px] text-ink"
                >
                  {t.label}
                </Link>
              );
            })}
          </>
        )}
      </nav>
      <div className="flex shrink-0 items-center gap-1 pr-2">
        <LiveDataChip />
        <ThemeToggle className="tvc-control flex h-[30px] w-[30px] shrink-0 items-center justify-center text-ink" />
        <Link
          href={HELP_HREF}
          aria-label="Manual"
          data-tooltip="Manual"
          aria-current={path === HELP_HREF ? "page" : undefined}
          className="tvc-control flex h-[30px] w-[30px] shrink-0 items-center justify-center text-ink"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M9.4 9.2a2.7 2.7 0 015.2.9c0 1.8-2.6 2.2-2.6 3.9" />
            <path d="M12 17.2h.01" />
          </svg>
        </Link>
      </div>
    </header>
  );
}

function LiveDataChip() {
  const stream = useStreamSummary();
  if (!stream) return null;
  return (
    <span
      role="status"
      title={stream.detail}
      className="mr-1 hidden items-center gap-1.5 text-[12px] text-ink-muted md:flex"
    >
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${stream.dot}`} />
      {stream.label}
    </span>
  );
}
