"use client";
/**
 * The frame every `/bot` route shares: the Classic-appearance wrapper (the
 * opt-in token override in `app/globals.css`, dark theme only), the page shell
 * and the section's own navigation.
 *
 * One component so the classic preference reaches every Bot route — the
 * overview, a bot's form and the exchange accounts — and nothing outside them.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader, PageShell } from "@/components/ui";
import { LOCAL_TIME_NOTE } from "@/lib/format";
import { useClassicBotAppearance } from "./classicAppearance";

export type BotSection = "overview" | "new" | "bot" | "accounts";

const LINKS: { href: string; label: string; section?: BotSection }[] = [
  { href: "/bot", label: "Overview", section: "overview" },
  { href: "/bot/bots/new", label: "New bot", section: "new" },
  { href: "/bot/accounts", label: "Exchange accounts", section: "accounts" },
  { href: "/journal", label: "Journal" },
  { href: "/operations", label: "Operations" },
];

export function BotShell({ section, title, description, actions, leading, children, classic: controlled }: {
  section: BotSection;
  /** The overview owns the toggle and passes its state, so a change shows at once. */
  classic?: boolean;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  children: ReactNode;
}) {
  const [stored] = useClassicBotAppearance();
  const classic = controlled ?? stored;
  return (
    <div data-bot-appearance={classic ? "classic" : undefined} className="min-h-full bg-bg">
      <PageShell width="narrow">
        <header>
          <PageHeader title={title} description={description} actions={actions} leading={leading} />
          <nav aria-label="Bot pages" className="mt-1 flex flex-wrap items-center gap-x-4 text-sm">
            {LINKS.map((link) => {
              const current = link.section === section;
              return (
                <Link key={link.href} href={link.href} aria-current={current ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center underline-offset-2 sm:min-h-0 ${current
                    ? "font-medium text-ink" : "text-ink-muted underline hover:text-ink"}`}>
                  {link.label}
                </Link>
              );
            })}
            <span className="text-xs text-ink-faint">{LOCAL_TIME_NOTE}</span>
          </nav>
        </header>
        {children}
      </PageShell>
    </div>
  );
}
