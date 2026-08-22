"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const LINKS = [
  { href: "/chart", label: "Chart" },
  { href: "/optimizers", label: "Optimizers" },
  { href: "/backtests", label: "Backtests" },
  { href: "/deployments", label: "Live & Alerts" },
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

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-3 py-2.5 sm:gap-6 sm:px-4 sm:py-3">
        <Link href="/chart" className="flex shrink-0 items-center gap-2 font-semibold">
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
                className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors sm:px-3 ${
                  active ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink hover:bg-surface"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <span className="hidden text-xs text-ink-faint sm:block">Binance Spot</span>
          {username && (
            <button onClick={signOut} title={`Signed in as ${username}`}
              className="rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-surface hover:text-ink">
              Sign out
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
