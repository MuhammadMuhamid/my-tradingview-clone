"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/*
 * FE-01: "Alerts" and "Live & Alerts" were two entries for two unrelated
 * things — notifications, and live automated trading. The second is now named
 * for what it does. A user should never have to click a link to find out
 * whether it spends money.
 */
const LINKS = [
  { href: "/chart", label: "Chart" },
  { href: "/scanner", label: "Scanner" },
  { href: "/alerts", label: "Alerts" },
  { href: "/optimizers", label: "Optimizers" },
  { href: "/backtests", label: "Backtests" },
  { href: "/deployments", label: "Live trading" },
  { href: "/operations", label: "Operations" },
];

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
          <span>SR+Trend</span>
          <span className="hidden text-ink-faint sm:inline">·</span>
          <span className="hidden font-normal text-ink-muted sm:inline">MA + R:R v9</span>
        </Link>
        <nav className="no-scrollbar -mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1">
          {LINKS.map((l) => {
            const active = path === l.href || path.startsWith(l.href + "/");
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
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <span className="hidden text-xs text-ink-faint sm:block">
            {path.startsWith("/scanner") ? "Binance USD-M Futures" : "Binance Spot"}
          </span>
          {username && (
            <button onClick={signOut} title={`Signed in as ${username}`}
              className="flex h-7 items-center rounded-md px-2 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink">
              Sign out
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
