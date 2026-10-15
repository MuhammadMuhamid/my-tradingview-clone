"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { HEALTH_DOT, useOpsHealth, useStreamSummary } from "@/lib/navStatus";
import {
  isSystemPath, linksFor, PRIMARY_LINKS, primaryFor, PRODUCT_NAME, sectionTabsFor, SYSTEM_LINKS,
} from "@/lib/navigation";
import { shariahApi, type ShariahMode } from "@/lib/shariah";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Avatar } from "@/components/AuthShell";
import { signOut, useIsAdmin, useSession } from "@/lib/session";

/*
 * FE-01: "Alerts" and "Live & Alerts" were two entries for two unrelated
 * things — notifications, and live automated trading. The second is now named
 * for what it does. A user should never have to click a link to find out
 * whether it spends money.
 *
 * V1 repair: five destinations on the row, operator surfaces under System.
 * The lists live in `lib/navigation`, shared with the chart's phone drawer
 * and the not-found page.
 */

/**
 * The in-product manual. Not a workspace: it sits in the account cluster
 * where a reader looks for help, and nothing here opens it on first launch.
 */
const HELP_HREF = "/getting-started";

export function Nav() {
  const path = usePathname();
  // Only render the account control when a session actually exists, so the
  // no-auth local setup does not show a button that does nothing.
  const session = useSession();
  const account = session?.authEnabled ? session.user : null;
  const admin = useIsAdmin();

  // The account pages draw their own frame.
  if (path === "/login" || path === "/signup" || path === "/onboarding" || path === "/profile") return null;

  /*
   * FC2-H3: the chart workspace has no bar above it, at any width.
   *
   * It used to hide this only below `md`, on the reasoning that a phone has no
   * room for it. FC2 measured what it cost on a desktop: 40px of product band
   * plus 33px of first-run band above a workspace whose chart was already 110px
   * shorter than TradingView's at the same viewport, with chart WIDTH at
   * parity — so the entire deficit was this. TradingView has no layer above its
   * toolbar on any screen, and neither does this now: the five destinations,
   * the operator surfaces, the manual, sign-out and both live readouts moved
   * into `components/tv/ProductMenu`, one 38px control at the left of the chart
   * toolbar. That also retired a duplicate — the wordmark and the `Chart` tab
   * both pointed at `/chart`, twenty pixels apart.
   *
   * Every other route keeps the bar. A page of alerts is a page; there is no
   * chart on it to tax, and a horizontal row is the right shape for one.
   */
  if (path === "/chart") return null;

  const primary = primaryFor(path);
  const tabs = sectionTabsFor(path);

  return (
    /*
      TVP8: `ts-app` on the nav too.
      
      `.tvc-control`, `.tvc-menu` and the 40px menu row are all scoped
      `:is(.tv-workstation, .ts-app)`, and the nav sits OUTSIDE `<main>` — above
      every page including the chart. So the theme toggle's `tvc-control` was
      dead on every route in the product, and the nav's own `role="menu"`
      adopted none of the popover grammar it was written against.
    */
    <header className="ts-app sticky top-0 z-20 border-b border-border bg-bg/90 backdrop-blur">
      {/*
        A 40px bar, not 52. This sits above every page including the chart, and
        a trading workspace's vertical budget is spent on data — the extra
        12 pixels bought nothing but air.
      */}
      <div className="mx-auto flex h-10 max-w-[1400px] items-center gap-3 px-3 sm:gap-5 sm:px-4">
        <Link href="/chart" className="flex h-7 shrink-0 items-center gap-2 text-[13px] font-semibold">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" />
          <span>{PRODUCT_NAME}</span>
        </Link>
        <nav className="no-scrollbar -mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1">
          {linksFor(PRIMARY_LINKS, admin).map((l) => {
            const active = primary?.href === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-7 shrink-0 items-center whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors sm:px-3 ${
                  active ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:bg-state-hover hover:text-ink"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
          <LiveDataChip />
          {/* Not a floating button over the page: one more control in the row
              that already holds them. See `ThemeToggle`. */}
          <ThemeToggle className="tvc-control flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted hover:text-ink" />
          <SystemMenu path={path} />
          {/*
            Help lives beside the account controls rather than in the workspace
            row, because the manual is not a place you trade — it is the one
            page that explains the others. It is permanent and never forced:
            nothing here opens it on first launch.
          */}
          <Link
            href={HELP_HREF}
            aria-current={path === HELP_HREF ? "page" : undefined}
            aria-label="Manual — what this application is and how to operate it"
            title="Manual — what this application is and how to operate it"
            className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
              path === HELP_HREF
                ? "bg-surface-2 font-medium text-ink"
                : "text-ink-muted hover:bg-state-hover hover:text-ink"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M9.4 9.2a2.7 2.7 0 015.2.9c0 1.8-2.6 2.2-2.6 3.9" />
              <path d="M12 17.2h.01" />
            </svg>
            <span className="hidden sm:inline">Manual</span>
          </Link>
          {account && (
            <>
              <Link href="/profile" title={`${account.displayName} — profile settings`}
                aria-label="Profile settings"
                className="flex h-7 items-center rounded-full hover:opacity-90">
                <Avatar name={account.displayName} url={account.avatarUrl} size={26} />
              </Link>
              <button onClick={() => void signOut()} title={`Signed in as ${account.email ?? account.displayName}`}
                className="flex h-7 items-center rounded-md px-2 text-xs text-ink-muted hover:bg-state-hover hover:text-ink">
                Sign out
              </button>
            </>
          )}
        </div>
      </div>
      <FirstRunHint path={path} />
      {tabs && (
        /*
          The secondary strip. Trading has Automations and the Journal;
          Research has the quick backtest and optimizer results. The strip is
          part of the header so every page under a destination gets it
          without knowing about the others.
        */
        <div className="border-t border-border/60 bg-surface/60">
          <nav aria-label={`${primary?.label ?? ""} sections`}
            className="no-scrollbar mx-auto flex h-8 max-w-[1400px] items-center gap-1 overflow-x-auto px-3 sm:px-4">
            {tabs.map((t) => {
              const active = path === t.href || path.startsWith(`${t.href}/`);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex h-6 shrink-0 items-center whitespace-nowrap rounded px-2 text-xs transition-colors ${
                    active ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </div>
      )}
    </header>
  );
}

const FIRST_RUN_KEY = "ts.firstRun.v1";

/**
 * One line, once, pointing at the manual's Start here block. Not a redirect
 * and not a tour: it appears under the header until dismissed or until the
 * manual has been opened, and nothing else is forced on a new user.
 */
function FirstRunHint({ path }: { path: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      if (path === HELP_HREF) { window.localStorage.setItem(FIRST_RUN_KEY, "1"); setShow(false); return; }
      setShow(window.localStorage.getItem(FIRST_RUN_KEY) === null);
    } catch { setShow(false); }
  }, [path]);
  if (!show) return null;
  const dismiss = (): void => {
    try { window.localStorage.setItem(FIRST_RUN_KEY, "1"); } catch { /* fine */ }
    setShow(false);
  };
  return (
    <div role="note" className="border-t border-border/60 bg-surface/80">
      <div className="mx-auto flex h-8 max-w-[1400px] items-center gap-3 px-3 text-xs sm:px-4">
        {/* accent-is-meaning: a link. */}
        <span className="text-ink-muted">
          New here? <Link href={`${HELP_HREF}#start`} className="text-accent hover:underline">Start here</Link> — the
          five-minute loop, in the Manual.
        </span>
        <button onClick={dismiss} className="ml-auto rounded px-2 py-0.5 text-ink-faint hover:bg-state-hover hover:text-ink">
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * Whether prices are streaming into this tab. The registry read and the
 * worst-stream rule live in `lib/navStatus`, shared with the chart workspace's
 * product menu so the two cannot disagree about what "live" means.
 */
function LiveDataChip() {
  const stream = useStreamSummary();
  if (!stream) return null;
  return (
    <span
      role="status"
      title={stream.detail}
      className="hidden items-center gap-1.5 text-[11px] text-ink-muted md:flex"
    >
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${stream.dot}`} />
      {stream.label}
    </span>
  );
}

/**
 * The operator surfaces, one menu away, with the one-word health answer a
 * trader needs from any page. The full runbook stays on Operations.
 */
function SystemMenu({ path }: { path: string }) {
  const admin = useIsAdmin();
  const [open, setOpen] = useExclusivePopover("nav-system");
  const health = useOpsHealth();
  const [shariahMode, setShariahMode] = useState<ShariahMode | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const read = async (): Promise<void> => {
      try { const m = await shariahApi.mode(); if (live) setShariahMode(m.mode); }
      catch { if (live) setShariahMode(null); }
    };
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open, setOpen]);

  const active = isSystemPath(path);

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-current={active ? "page" : undefined}
        title={health.summary}
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
          open || active ? "bg-surface-2 text-ink" : "text-ink-muted hover:bg-state-hover hover:text-ink"
        }`}
      >
        <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${HEALTH_DOT[health.tone]}`} />
        <span>System</span>
        <span className="sr-only">— {health.label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open && (
        /*
          ── TVP8 round two: the one popover that was not one ────────────────

          This hand-rolled `rounded-md border border-border bg-surface py-1
          shadow-xl` where every other popover in the product says `.tvc-menu`.
          Three visible consequences, all of them in the opposite direction
          from the contract:

            `bg-surface` is `#0f0f0f` on the dark theme and `--ts-popover` is
            `#1f1f1f`. The grammar is that a popover sits one step LIGHTER than
            the bar it opens from; this sat darker.

            `shadow-xl` is Tailwind's heaviest, against the measured
            `0 2px 4px rgba(0,0,0,0.4)`.

            `py-2` on a 13px row is about 33px, where the contract's dropdown
            row is 40px — and without the 6px gutter the hover painted edge to
            edge instead of as an inset chip, which is the one thing the
            control-state grammar is most recognisable by.
        */
        <div role="menu" aria-label="System"
          className="tvc-menu absolute right-0 top-[34px] z-50 w-72">
          <div className="px-3 pb-2 pt-2">
            <div className="flex items-center gap-2 text-[13px] text-ink">
              <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${HEALTH_DOT[health.tone]}`} />
              <span className="font-medium">{health.label}</span>
            </div>
            <p className="mt-0.5 text-[11px] leading-tight text-ink-faint"
              title={health.detail ?? undefined}>
              {health.summary}
            </p>
          </div>
          {linksFor(SYSTEM_LINKS, admin).map((l) => {
            const current = path === l.href || path.startsWith(`${l.href}/`);
            const note = l.href === "/shariah"
              ? `Platform mode ${shariahMode === null ? "unknown" : shariahMode === "enforce" ? "ON" : "OFF"}`
              : l.href === "/operations" ? "Runbook, halts, evidence" : "First run, quick start, reference";
            return (
              <Link
                key={l.href}
                href={l.href}
                role="menuitem"
                aria-current={current ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={`tvc-menu-row justify-between gap-3 px-3 text-[13px] ${
                  current ? "text-ink" : "text-ink-muted hover:text-ink"
                }`}
              >
                <span>{l.label}</span>
                <span className="text-[11px] text-ink-faint">{note}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
