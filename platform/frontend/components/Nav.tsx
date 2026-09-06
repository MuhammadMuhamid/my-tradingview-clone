"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { api, type OpsStatus } from "@/lib/api";
import { compactHealth, type HealthTone } from "@/lib/operationsHealth";
import { describeStreamState, marketStreams, type StreamState } from "@/lib/marketStream";
import {
  isSystemPath, PRIMARY_LINKS, primaryFor, PRODUCT_NAME, sectionTabsFor, SYSTEM_LINKS,
} from "@/lib/navigation";
import { shariahApi, type ShariahMode } from "@/lib/shariah";

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

const DOT_TONE: Record<HealthTone, string> = {
  positive: "bg-up",
  neutral: "bg-ink-faint",
  warning: "bg-warn",
  critical: "bg-down",
  halted: "bg-down",
};

export function Nav() {
  const path = usePathname();
  const [username, setUsername] = useState<string | null>(null);

  // Only render a sign-out control when a session actually exists, so the
  // no-auth local setup does not show a button that does nothing.
  useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { authEnabled?: boolean; username?: string | null } | null) => {
        if (d?.authEnabled && d.username) setUsername(d.username);
      })
      .catch(() => { /* offline — hide the control */ });
  }, [path]);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.href = "/login";
  };

  if (path === "/login") return null;

  // The chart carries its own compact header and ☰ drawer on phones; showing
  // this bar too would spend a whole row of a 390px screen on navigation.
  const hideOnMobile = path === "/chart";
  const primary = primaryFor(path);
  const tabs = sectionTabsFor(path);

  return (
    <header className={`sticky top-0 z-20 border-b border-border bg-bg/90 backdrop-blur ${
      hideOnMobile ? "hidden md:block" : ""
    }`}>
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
          {PRIMARY_LINKS.map((l) => {
            const active = primary?.href === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-7 shrink-0 items-center whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors sm:px-3 ${
                  active ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
          <LiveDataChip />
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
                : "text-ink-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M9.4 9.2a2.7 2.7 0 015.2.9c0 1.8-2.6 2.2-2.6 3.9" />
              <path d="M12 17.2h.01" />
            </svg>
            <span className="hidden sm:inline">Manual</span>
          </Link>
          {username && (
            <button onClick={signOut} title={`Signed in as ${username}`}
              className="flex h-7 items-center rounded-md px-2 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink">
              Sign out
            </button>
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
        <span className="text-ink-muted">
          New here? <Link href={`${HELP_HREF}#start`} className="text-accent hover:underline">Start here</Link> — the
          five-minute loop, in the Manual.
        </span>
        <button onClick={dismiss} className="ml-auto rounded px-2 py-0.5 text-ink-faint hover:bg-surface-2 hover:text-ink">
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * Whether prices are streaming into this tab, from the one registry every
 * market socket goes through. Shown only while a stream is held (the chart,
 * the watchlist, the ticket), so pages without a market view carry nothing.
 */
function LiveDataChip() {
  const [state, setState] = useState<StreamState | null>(null);
  useEffect(() => {
    const summarise = (): void => {
      const states = [...marketStreams.states().values()];
      if (states.length === 0) { setState(null); return; }
      // The worst stream is the tab's answer: one refused socket is a problem
      // even while another is live.
      const rank = (s: StreamState): number => ({
        live: 0, open: 1, connecting: 1, idle: 2, reconnecting: 3, stale: 4,
      })[s.status];
      setState(states.reduce((worst, s) => (rank(s) > rank(worst) ? s : worst)));
    };
    summarise();
    return marketStreams.observe(summarise);
  }, []);
  if (!state) return null;
  const words = describeStreamState(state);
  const tone = state.status === "live" ? "bg-up"
    : state.status === "stale" ? "bg-down"
    : state.status === "reconnecting" ? "bg-warn" : "bg-ink-faint";
  return (
    <span
      role="status"
      title={words.detail}
      className="hidden items-center gap-1.5 text-[11px] text-ink-muted md:flex"
    >
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${tone}`} />
      {state.status === "live" ? "Live data" : words.label}
    </span>
  );
}

/**
 * The operator surfaces, one menu away, with the one-word health answer a
 * trader needs from any page. The full runbook stays on Operations.
 */
function SystemMenu({ path }: { path: string }) {
  const [open, setOpen] = useExclusivePopover("nav-system");
  const [ops, setOps] = useState<OpsStatus | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [shariahMode, setShariahMode] = useState<ShariahMode | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const read = async (): Promise<void> => {
      try { const next = await api.opsStatus(); if (live) { setOps(next); setOpsError(null); } }
      catch (e) { if (live) setOpsError((e as Error).message); }
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

  const health = ops ? compactHealth(ops) : null;
  const tone: HealthTone = health ? health.tone : "neutral";
  const healthLabel = health ? health.status : opsError ? "Unknown" : "…";
  const active = isSystemPath(path);

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-current={active ? "page" : undefined}
        title={health ? health.summary : opsError ? `Operations status could not be read: ${opsError}` : "Reading system status…"}
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
          open || active ? "bg-surface-2 text-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
        }`}
      >
        <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_TONE[tone]}`} />
        <span>System</span>
        <span className="sr-only">— {healthLabel}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label="System"
          className="absolute right-0 top-[34px] z-50 w-72 rounded-md border border-border bg-surface py-1 shadow-xl">
          <div className="px-3 pb-2 pt-2">
            <div className="flex items-center gap-2 text-[13px] text-ink">
              <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${DOT_TONE[tone]}`} />
              <span className="font-medium">{healthLabel}</span>
            </div>
            <p className="mt-0.5 text-[11px] leading-tight text-ink-faint">
              {health ? health.summary : opsError ? `Operations status could not be read: ${opsError}` : "Reading system status…"}
            </p>
          </div>
          {SYSTEM_LINKS.map((l) => {
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
                className={`flex items-baseline justify-between gap-3 px-3 py-2 text-[13px] hover:bg-surface-2 ${
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
